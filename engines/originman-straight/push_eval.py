"""Paired disturbance recovery, including a tuned IMU feedback baseline."""

import argparse
import itertools
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from env import Config, OriginManEnv
from evaluation_evidence import capture, finish
from monitor import digest, write_json

TUNE_CASES = [
    {"force": f, "start": t} for f, t in itertools.product([-6, -4, 4, 6], [1.6, 2.2])
]
TEST_CASES = [
    {"force": f, "start": t}
    for f, t in itertools.product([-7, -5, 5, 7], [3.1, 3.7, 4.3])
] + [{"force": 0, "start": 3.1}]


def feedback(env, coefficients):
    rotation, _ = env.orientation()
    roll = np.arctan2(rotation[2, 1], rotation[2, 2])
    rate = env.data.sensordata[0]
    a = np.zeros(10)
    a[[4, 9]] = coefficients[0] * roll + coefficients[1] * rate
    a[[0, 5]] = coefficients[2] * roll + coefficients[3] * rate
    return np.clip(a / env.config.residual_scale, -1, 1)


def episode(env, case, act, trace=False):
    obs = env.reset(seed=100, asymmetry=0, initial_yaw=0)
    env.push_start = case["start"]
    env.push_force[:] = [0, case["force"], 0]
    support = np.zeros(2, int)
    frames = []
    total = 0.0
    max_tilt = 0.0
    for step in range(round(env.config.episode_seconds / env.config.control_dt)):
        obs, reward, done, info = env.step(act(obs))
        total += reward
        support += [
            not info["footContacts"][0] and info["footContacts"][1],
            info["footContacts"][0] and not info["footContacts"][1],
        ]
        max_tilt = max(
            max_tilt,
            float(
                np.degrees(
                    np.arccos(np.clip(env.data.xmat[1].reshape(3, 3)[2, 2], -1, 1))
                )
            ),
        )
        if trace and step % 2 == 0:
            frames.append(
                {**info, **env.diagnostic_frame(), "qpos": env.data.qpos.tolist()}
            )
        if done:
            break
    row = {
        **case,
        "fallen": info["fallen"],
        "forwardM": info["x"],
        "lateralM": info["y"],
        "seconds": info["time"],
        "return": total,
        "singleSupportFrames": support.tolist(),
        "peakTiltDegrees": max_tilt,
        "walkingSuccess": bool(
            not info["fallen"] and info["x"] >= 0.15 and min(support) >= 5
        ),
    }
    if trace:
        row["frames"] = frames
    return row


def tune(scene, config, out):
    rng = np.random.default_rng(452)
    # Both signs and independent hip/ankle position/rate gains; identical
    # residual amplitude and slew limits apply to RL and feedback baseline.
    gains = [[0, 0, 0, 0]] + rng.uniform(
        [-3, -0.5, -3, -0.5], [3, 0.5, 3, 0.5], (63, 4)
    ).tolist()
    write_json(
        out / "tuning-plan.json",
        {
            "cases": TUNE_CASES,
            "coefficients": gains,
            "selection": "most walking successes; then least falls; then highest summed environment reward; deterministic training-only cases",
        },
    )
    env = OriginManEnv(scene, config)
    trials = []
    for i, coefficients in enumerate(gains):
        rows = [
            episode(env, c, lambda obs, gains=coefficients: feedback(env, gains))
            for c in TUNE_CASES
        ]
        score = [
            sum(r["walkingSuccess"] for r in rows),
            -sum(r["fallen"] for r in rows),
            sum(r["return"] for r in rows),
        ]
        trial = {
            "index": i,
            "coefficients": coefficients,
            "score": score,
            "cases": rows,
        }
        trials.append(trial)
        with (out / "tuning.jsonl").open("a") as f:
            f.write(json.dumps(trial, allow_nan=False) + "\n")
        if i % 8 == 0:
            print(f"feedback tuning {i + 1}/{len(gains)}", flush=True)
    best = max(trials, key=lambda r: r["score"])
    write_json(out / "feedback.json", best)
    return best["coefficients"]


def evaluate(scene, policy, out, feedback_path=None):
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    cfg = Config(
        **json.loads((policy.parent / "training-summary.json").read_text())["config"]
    )
    write_json(
        out / "plan.json",
        {
            "testCases": TEST_CASES,
            "policySha256": digest(policy),
            "sceneSha256": digest(scene),
            "testSelection": "predeclared forces and phases; no checkpoint selection",
            "scope": "deterministic scenario coverage, ideal IMU and joint states, no measured hardware validity",
            "passing": "no fall, forward >=15cm, >=5 frames single support on each side; compare tuned feedback too",
        },
    )
    if feedback_path:
        identity = json.loads((feedback_path.parent / "identity.json").read_text())
        if (
            identity["sceneSha256"] != digest(scene)
            or identity["config"] != cfg.__dict__
        ):
            raise ValueError("feedback tuning scene/config does not match evaluation")
        chosen = json.loads(feedback_path.read_text())
        gains = chosen["coefficients"]
        write_json(
            out / "feedback.json", {**chosen, "reusedSha256": digest(feedback_path)}
        )
    else:
        gains = tune(scene, cfg, out)
    env = OriginManEnv(scene, cfg)
    session = ort.InferenceSession(str(policy), providers=["CPUExecutionProvider"])
    modes = {
        "reference": lambda obs: np.zeros(10),
        "imu-feedback": lambda obs: feedback(env, gains),
        "rl": lambda obs: session.run(None, {"obs": obs[None]})[0][0],
    }
    results = []
    for case in TEST_CASES:
        for name, act in modes.items():
            row = {"controller": name, **episode(env, case, act, trace=True)}
            results.append(row)
            with (out / "episodes.jsonl").open("a") as f:
                f.write(json.dumps(row, allow_nan=False) + "\n")
        print(f"tested force {case['force']} start {case['start']}", flush=True)
    summary = {
        name: {
            "walkingSuccesses": sum(
                r["walkingSuccess"] for r in results if r["controller"] == name
            ),
            "falls": sum(r["fallen"] for r in results if r["controller"] == name),
            "meanForwardM": float(
                np.mean([r["forwardM"] for r in results if r["controller"] == name])
            ),
            "cases": len(TEST_CASES),
        }
        for name in modes
    }
    write_json(out / "summary.json", summary)
    finish(out, scene)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--policy", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--feedback", type=Path)
    a = p.parse_args()
    evaluate(a.scene, a.policy, a.out, a.feedback)
