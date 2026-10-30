"""One-factor sensitivity of frozen controllers; no claim of measured hardware fidelity."""

import argparse
import json
import platform
import shutil
from pathlib import Path

import experiment as exp
import mujoco
import numpy as np
import torch
from kick_env import KickEnv

PROFILES = [
    {"name": "nominal"},
    {"name": "dt_1ms", "timestep": 0.001},
    {"name": "dt_0.5ms", "timestep": 0.0005},
    {"name": "kp_4", "kp": 4},
    {"name": "kp_12", "kp": 12},
    {"name": "kv_0.09", "kv": 0.09},
    {"name": "kv_0.36", "kv": 0.36},
    {"name": "torque_0.75Nm", "torque": 0.75},
    {"name": "torque_2Nm", "torque": 2},
    {"name": "delay_20ms", "delay": 1},
    {"name": "delay_40ms", "delay": 2},
    {"name": "ball_10g", "mass": 0.01},
    {"name": "ball_40g", "mass": 0.04},
    {"name": "rolling_0.0005m", "friction": 0.0005},
    {"name": "rolling_0.002m", "friction": 0.002},
    {"name": "sole_xy_80percent", "soleScale": 0.8},
    {"name": "self_collision_on_boxes", "selfCollision": True},
]
TARGETS = [0.07, 0.11, 0.19]
CONVERGENCE_PROFILES = [
    {"name": f"dt_{dt * 1000:g}ms", "timestep": dt}
    for dt in [0.002, 0.001, 0.0005, 0.00025, 0.000125, 0.0000625]
]


def configure(env, profile):
    m = env.model
    a = env.leg_a
    if "timestep" in profile:
        m.opt.timestep = profile["timestep"]
    if "kp" in profile:
        m.actuator_gainprm[a, 0] = profile["kp"]
        m.actuator_biasprm[a, 1] = -profile["kp"]
    if "kv" in profile:
        m.actuator_biasprm[a, 2] = -profile["kv"]
    if "torque" in profile:
        m.actuator_forcerange[:] = [-profile["torque"], profile["torque"]]
    if "mass" in profile:
        m.body_mass[env.ball_body] = profile["mass"]
        m.body_inertia[env.ball_body] = 0.4 * profile["mass"] * 0.025**2
    if "soleScale" in profile:
        for side in ["l", "r"]:
            g = mujoco.mj_name2id(
                m, mujoco.mjtObj.mjOBJ_GEOM, side + "_ank_roll_link_collision"
            )
            m.geom_size[g, :2] *= profile["soleScale"]
    if profile.get("selfCollision"):
        m.geom_conaffinity[m.geom_group == 3] |= 1
    mujoco.mj_setConst(m, env.data)


def run(root, out, profiles):
    out.mkdir(parents=True, exist_ok=False)
    source_dir = out / "sources"
    source_dir.mkdir()
    for path in Path(__file__).parent.glob("*.py"):
        shutil.copyfile(path, source_dir / path.name)
    anchors = json.loads((root / "calibration.json").read_text())["anchors"]
    actions = {"interpolation": {t: exp.lookup(t, anchors) for t in TARGETS}}
    policy_hashes = {}
    for seed in exp.SEEDS:
        path = root / f"seed-{seed}/policy.pt"
        policy_hashes[str(seed)] = exp.sha(path)
        policy = exp.ActorCritic(1, 2)
        policy.load_state_dict(
            torch.load(path, map_location="cpu", weights_only=True)["state_dict"]
        )
        policy.eval()
        with torch.no_grad():
            actions[f"ppo-{seed}"] = {
                t: np.tanh(
                    policy(torch.from_numpy(exp.observation(t))[None])[0].numpy()[0]
                )
                for t in TARGETS
            }
    exp.save(
        out / "plan.json",
        {
            "profiles": profiles,
            "targetsM": TARGETS,
            "frozenPolicies": policy_hashes,
            "sourceSha256": {p.name: exp.sha(p) for p in source_dir.glob("*.py")},
            "sceneSha256": exp.sha(root / "model/scene.xml"),
            "sourceSceneSha256": exp.sha(root / "model/source-scene.xml"),
            "calibrationSha256": exp.sha(root / "calibration.json"),
            "retraining": False,
            "recalibration": False,
            "scope": "one-factor deterministic probes; ranges are hypotheses, not manufacturer bounds; no robustness guarantee or hardware validation",
            "python": platform.python_version(),
            "mujoco": mujoco.__version__,
        },
    )
    rows = []
    for profile in profiles:
        env = KickEnv(root / "model/source-scene.xml", root / "model/scene.xml")
        configure(env, profile)
        for name, targets in actions.items():
            for target, action in targets.items():
                result = env.rollout(
                    action,
                    friction=profile.get("friction", 0.001),
                    command_delay_steps=profile.get("delay", 0),
                )
                rows.append(
                    {
                        "profile": profile["name"],
                        "controller": name,
                        "targetM": target,
                        "action": action.tolist(),
                        "errorM": abs(result["ballForwardM"] - target),
                        "valid": exp.valid(result),
                        "result": result,
                    }
                )
                with (out / "episodes.jsonl").open("a") as f:
                    f.write(json.dumps(rows[-1], allow_nan=False) + "\n")
        print(f"{profile['name']}: {len(rows)} episodes complete", flush=True)
    summary = []
    for profile in profiles:
        for name in actions:
            cases = [
                r
                for r in rows
                if r["profile"] == profile["name"] and r["controller"] == name
            ]
            summary.append(
                {
                    "profile": profile["name"],
                    "controller": name,
                    "maeCm": float(np.mean([r["errorM"] for r in cases]) * 100),
                    "valid": sum(r["valid"] for r in cases),
                    "success": sum(r["valid"] and r["errorM"] <= 0.025 for r in cases),
                    "falls": sum(r["result"]["fallen"] for r in cases),
                    "cases": len(cases),
                }
            )
    exp.save(out / "summary.json", summary)
    lines = [
        "# OriginMan 仿真敏感性检查",
        "",
        "冻结原有权重和标定表；不重新训练、标定或选择种子。每项只改变一个参数，三个固定目标距离。参数范围不是实测真机范围。",
        "",
        "|条件|控制器|距离 MAE / cm|有效动作|成功（±2.5cm）|跌倒|",
        "|---|---|---:|---:|---:|---:|",
    ]
    lines += [
        f"|{r['profile']}|{r['controller']}|{r['maeCm']:.2f}|{r['valid']}/3|{r['success']}/3|{r['falls']}/3|"
        for r in summary
    ]
    lines += [
        "",
        "自碰撞检查沿用包围盒，只能诊断模型简化风险；碰撞导致失败也可能来自包围盒重叠，不能直接认定真机会干涉。",
        "",
        "此检查不包含实物测量，不能证明可部署性。减小物理步长时控制周期保持 20ms；命令延迟通过目标队列施加。",
    ]
    (out / "RESULTS.md").write_text("\n".join(lines) + "\n")
    exp.save(
        out / "receipt.json",
        {
            "episodes": len(rows),
            "complete": True,
            "sourceChangedDuringRun": any(
                exp.sha(p) != exp.sha(Path(__file__).parent / p.name)
                for p in source_dir.glob("*.py")
            ),
            "files": {p.name: exp.sha(p) for p in out.iterdir() if p.is_file()},
        },
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument(
        "--suite", choices=["sensitivity", "convergence"], default="sensitivity"
    )
    args = p.parse_args()
    torch.set_num_threads(1)
    run(
        args.root,
        args.out,
        CONVERGENCE_PROFILES if args.suite == "convergence" else PROFILES,
    )
