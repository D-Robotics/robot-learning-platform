"""Frozen policy control-period probe with physics-timed disturbances."""

import argparse
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import onnxruntime as ort
from env import Config, OriginManEnv
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from push_eval import TEST_CASES, episode, feedback


def run(scene, policy, feedback_path, out):
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    cfg = Config(
        **json.loads((policy.parent / "training-summary.json").read_text())["config"]
    )
    identity = json.loads((feedback_path.parent / "identity.json").read_text())
    if identity["sceneSha256"] != digest(scene) or Config(**identity["config"]) != cfg:
        raise ValueError("feedback tuning identity mismatch")
    gains = json.loads(feedback_path.read_text())["coefficients"]
    periods = [0.02, 0.04, 0.05]
    write_json(
        out / "plan.json",
        {
            "periods": periods,
            "cases": TEST_CASES,
            "policySha256": digest(policy),
            "feedbackSha256": digest(feedback_path),
            "scope": "development timing probe, same physical disturbance windows; ideal observations, no network or sensor latency simulation; frozen controllers",
        },
    )
    session = ort.InferenceSession(str(policy), providers=["CPUExecutionProvider"])
    summary = []
    for period in periods:
        env = OriginManEnv(scene, replace(cfg, control_dt=period))
        modes = {
            "reference": lambda obs: np.zeros(10),
            "imu-feedback": lambda obs, e=env: feedback(e, gains),
            "rl": lambda obs: session.run(None, {"obs": obs[None]})[0][0],
        }
        rows = []
        for case in TEST_CASES:
            for name, act in modes.items():
                row = {
                    "periodSeconds": period,
                    "controller": name,
                    **episode(env, case, act),
                }
                row["singleSupportSeconds"] = [
                    n * period for n in row["singleSupportFrames"]
                ]
                row["successWithCommonSupportDuration"] = bool(
                    not row["fallen"]
                    and row["forwardM"] >= 0.15
                    and min(row["singleSupportSeconds"]) >= 0.1 - 1e-9
                )
                rows.append(row)
                with (out / "episodes.jsonl").open("a") as f:
                    f.write(json.dumps(row, allow_nan=False) + "\n")
        for name in modes:
            rs = [r for r in rows if r["controller"] == name]
            summary.append(
                {
                    "periodSeconds": period,
                    "controller": name,
                    "canonicalSuccesses": sum(r["walkingSuccess"] for r in rs),
                    "commonDurationSuccesses": sum(
                        r["successWithCommonSupportDuration"] for r in rs
                    ),
                    "falls": sum(r["fallen"] for r in rs),
                    "cases": len(rs),
                }
            )
        write_json(out / "summary.json", summary)
        print(summary[-3:], flush=True)
    finish(out, scene)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--policy", type=Path, required=True)
    p.add_argument("--feedback", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    run(a.scene, a.policy, a.feedback, a.out)
