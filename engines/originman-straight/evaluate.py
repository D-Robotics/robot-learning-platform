"""Paired zero-residual vs trained residual evaluation on identical starts."""

import argparse
import hashlib
import json
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np
import onnxruntime as ort
from env import Config, OriginManEnv
from monitor import seal_run

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "microduck-eval"))
from microduck_eval.wilson import wilson_bounds


def evaluate(scene, policy, out, episodes=30, seed=1000, seconds=8.0):
    if episodes < 2:
        raise ValueError("paired evaluation requires at least two episodes")
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    summary = json.loads((Path(policy).parent / "training-summary.json").read_text())
    cfg = Config(**summary["config"])
    cfg.episode_seconds = seconds
    env = OriginManEnv(scene, cfg)
    session = ort.InferenceSession(str(policy), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(seed)
    cases = [
        {
            "seed": seed + i,
            "asymmetry": float(a),
            "initial_yaw": float(rng.uniform(-0.06, 0.06)),
        }
        for i, a in enumerate(
            np.resize(np.array([-0.18, -0.09, 0, 0.09, 0.18]), episodes)
        )
    ]
    rows = []
    traces = []
    for case in cases:
        for mode in ["reference", "rl"]:
            obs = env.reset(**case)
            reward = 0.0
            trace = []
            for step in range(round(seconds / cfg.control_dt)):
                action = (
                    np.zeros(10)
                    if mode == "reference"
                    else session.run(None, {"obs": obs[None]})[0][0]
                )
                obs, r, done, info = env.step(action)
                reward += r
                trace.append(
                    {
                        **info,
                        "action": action.tolist(),
                        "jointPosition": env.data.qpos[env.qa].tolist(),
                    }
                )
                if done:
                    break
            row = {
                **case,
                "mode": mode,
                "survivalSeconds": info["time"],
                "forwardMeters": info["x"],
                "lateralAbsMeters": abs(info["y"]),
                "maxLateralAbsMeters": max(abs(t["y"]) for t in trace),
                "headingAbsRadians": abs(info["yaw"]),
                "fallen": info["fallen"],
                "return": reward,
                "leftSwingSteps": sum(
                    not t["footContacts"][0] and t["footContacts"][1] for t in trace
                ),
                "rightSwingSteps": sum(
                    t["footContacts"][0] and not t["footContacts"][1] for t in trace
                ),
            }
            row["walkingSuccess"] = bool(
                not row["fallen"]
                and row["forwardMeters"] >= 0.15
                and row["leftSwingSteps"] >= 5
                and row["rightSwingSteps"] >= 5
            )
            rows.append(row)
            traces.append({"case": case, "mode": mode, "frames": trace})
    aggregate = {}
    for mode in ["reference", "rl"]:
        rs = [r for r in rows if r["mode"] == mode]
        aggregate[mode] = {
            k: float(np.mean([r[k] for r in rs]))
            for k in [
                "survivalSeconds",
                "forwardMeters",
                "lateralAbsMeters",
                "maxLateralAbsMeters",
                "headingAbsRadians",
                "fallen",
                "walkingSuccess",
            ]
        }
    for mode, mode_metrics in aggregate.items():
        rs = [r for r in rows if r["mode"] == mode]
        mode_metrics["walkingSuccessCi95"] = wilson_bounds(
            sum(r["walkingSuccess"] for r in rs), len(rs)
        )
    qualifies = all(aggregate[m]["walkingSuccess"] >= 0.8 for m in aggregate)
    delta = (
        aggregate["reference"]["lateralAbsMeters"] - aggregate["rl"]["lateralAbsMeters"]
    )
    improvements = np.array(
        [
            rows[i]["lateralAbsMeters"] - rows[i + 1]["lateralAbsMeters"]
            for i in range(0, len(rows), 2)
        ]
    )
    boot = (
        np.random.default_rng(seed + 991)
        .choice(improvements, (3000, episodes), replace=True)
        .mean(1)
    )
    ci = np.quantile(boot, [0.025, 0.975]).tolist()
    retained = aggregate["rl"]["forwardMeters"] / max(
        aggregate["reference"]["forwardMeters"], 1e-9
    )
    demonstrates = bool(qualifies and ci[0] > 0 and retained >= 0.95)
    report = {
        "schemaVersion": 1,
        "task": "originman-straight-residual",
        "physicsBackend": "cpu-mujoco-originman-fullbody",
        "episodesPerMode": episodes,
        "paired": True,
        "evaluationSeed": seed,
        "policySha256": hashlib.sha256(Path(policy).read_bytes()).hexdigest(),
        "modelSha256": hashlib.sha256(Path(scene).read_bytes()).hexdigest(),
        "config": asdict(cfg),
        "cases": rows,
        "aggregate": aggregate,
        "walkingQualification": qualifies,
        "lateralImprovementMeters": delta,
        "pairedLateralImprovementCi95Meters": ci,
        "forwardProgressRetention": retained,
        "demonstratesCorrectionWithoutSlowing": demonstrates,
        "comparisonRule": {
            "minimumProgressRetention": 0.95,
            "positivePairedCiRequired": True,
            "scope": "exploratory simulation check, not deployment authorization",
        },
        "conclusion": (
            "correction improvement without material slowing"
            if demonstrates
            else "walking comparison valid, but correction benefit without slowing NOT established"
        )
        if qualifies
        else "exploratory only: walking qualification failed; cannot claim RL improves walking",
        "hardwareEligible": False,
    }
    (out / "eval-report.json").write_text(json.dumps(report, indent=2))
    (out / "trajectories.json").write_text(json.dumps(traces))
    if (out / "experiment.json").exists():
        seal_run(out, "evaluation")
    print(
        json.dumps(
            {
                k: report[k]
                for k in [
                    "aggregate",
                    "walkingQualification",
                    "lateralImprovementMeters",
                    "conclusion",
                ]
            },
            indent=2,
        )
    )
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", required=True)
    p.add_argument("--policy", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--episodes", type=int, default=30)
    p.add_argument("--seed", type=int, default=1000)
    a = p.parse_args()
    evaluate(a.scene, a.policy, a.out, a.episodes, a.seed)
