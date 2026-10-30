"""Compare source-derived convex feet and boxes with frozen controllers."""

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

import mujoco
import numpy as np
import torch
from env import OriginManEnv
from model import prepare

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "originman-kick"))
import experiment as exp
from kick_env import KickEnv, prepare_scene

DTS = [0.002, 0.001, 0.0005, 0.00025]
TARGETS = [0.07, 0.11, 0.19]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(source, frozen, out):
    out.mkdir(parents=True, exist_ok=False)
    (out / "sources").mkdir()
    paths = [
        Path(__file__),
        Path(__file__).with_name("model.py"),
        Path(__file__).with_name("env.py"),
        Path(exp.__file__),
        Path(exp.__file__).with_name("kick_env.py"),
        Path(__file__).resolve().parents[1] / "microduck-football/train_football.py",
    ]
    for path in paths:
        shutil.copyfile(path, out / "sources" / path.name)
    anchors = json.loads((frozen / "calibration.json").read_text())["anchors"]
    actions = {"interpolation": {t: exp.lookup(t, anchors) for t in TARGETS}}
    policies = {}
    for seed in exp.SEEDS:
        policy_path = frozen / f"seed-{seed}/policy.pt"
        policies[str(seed)] = sha(policy_path)
        policy = exp.ActorCritic(1, 2)
        policy.load_state_dict(
            torch.load(policy_path, map_location="cpu", weights_only=True)["state_dict"]
        )
        policy.eval()
        with torch.no_grad():
            actions[f"ppo-{seed}"] = {
                t: policy(torch.tensor(exp.observation(t)[None]))[0].tanh().numpy()[0]
                for t in TARGETS
            }
    exp.save(
        out / "plan.json",
        {
            "footCollision": ["box", "convex-mesh"],
            "physicsTimesteps": DTS,
            "targetsM": TARGETS,
            "policySha256": policies,
            "calibrationSha256": sha(frozen / "calibration.json"),
            "sourceSha256": {p.name: sha(p) for p in paths},
            "mujoco": mujoco.__version__,
            "retraining": False,
            "recalibration": False,
            "scope": "new source-derived collision variants; old controllers frozen; no measured hardware claims; self collision remains disabled",
        },
    )
    rows = []
    gait_rows = []
    for geometry in ["box", "convex-mesh"]:
        scene = prepare(source, out / geometry / "robot", foot_collision=geometry)
        kick_scene = prepare_scene(scene, out / geometry / "kick")
        gait = OriginManEnv(scene)
        kick = KickEnv(scene, kick_scene)
        for dt in DTS:
            gait.model.opt.timestep = dt
            gait.reset()
            supports = np.zeros(2, int)
            tilt = 0.0
            for step in range(400):
                _, _, done, info = gait.step(np.zeros(10))
                supports[0] += not info["footContacts"][0] and info["footContacts"][1]
                supports[1] += info["footContacts"][0] and not info["footContacts"][1]
                tilt = max(
                    tilt,
                    float(
                        np.degrees(
                            np.arccos(
                                np.clip(gait.data.xmat[1].reshape(3, 3)[2, 2], -1, 1)
                            )
                        )
                    ),
                )
                if done:
                    break
            gait_rows.append(
                {
                    "geometry": geometry,
                    "dt": dt,
                    "x": info["x"],
                    "y": info["y"],
                    "yaw": info["yaw"],
                    "fallen": info["fallen"],
                    "peakTiltDegrees": tilt,
                    "singleSupportFrames": supports.tolist(),
                    "elapsedSeconds": info["time"],
                }
            )
            kick.model.opt.timestep = dt
            for controller, targets in actions.items():
                for target, action in targets.items():
                    r = kick.rollout(action)
                    rows.append(
                        {
                            "geometry": geometry,
                            "dt": dt,
                            "controller": controller,
                            "targetM": target,
                            "action": action.tolist(),
                            "valid": exp.valid(r),
                            "result": r,
                        }
                    )
                    with (out / "kick-episodes.jsonl").open("a") as f:
                        f.write(json.dumps(rows[-1], allow_nan=False) + "\n")
            exp.save(out / "gait.json", gait_rows)
            print(
                f"{geometry} dt={dt}: gait x={info['x']:.3f} fallen={info['fallen']}; {len(rows)} kick cases complete",
                flush=True,
            )
    exp.save(
        out / "receipt.json",
        {
            "complete": True,
            "kickEpisodes": len(rows),
            "gaitEpisodes": len(gait_rows),
            "sourceChangedDuringRun": any(
                sha(p) != sha(out / "sources" / p.name) for p in paths
            ),
        },
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--frozen", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    torch.set_num_threads(1)
    run(a.source, a.frozen, a.out)
