"""Tune the corrected physical-axis PD baseline without final-case access."""

import argparse
import itertools
import json
from pathlib import Path

import numpy as np
from env import Config, OriginManEnv
from evaluation_evidence import capture, finish
from gym_bridge import axis_correct_feedback
from monitor import digest, write_json
from push_eval import TUNE_CASES, episode


def tune(scene, experiment, out):
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    cfg = Config(**json.loads(experiment.read_text())["environment"])
    rng = np.random.default_rng(452)
    gains = [
        list(g)
        for g in itertools.product(
            [0, 0.5, 1], [0, 0.05, 0.1], [0, 0.5, 1], [0, 0.05, 0.1]
        )
    ]
    gains += rng.uniform([-3, -0.5, -3, -0.5], [3, 0.5, 3, 0.5], (63, 4)).tolist()
    write_json(
        out / "plan.json",
        {
            "cases": TUNE_CASES,
            "coefficients": gains,
            "selection": "max complete walking, then least falls, then summed reward; no final cases",
            "feedback": "axis-correct physical hip and ankle rotations",
            "sceneSha256": digest(scene),
            "config": cfg.__dict__,
        },
    )
    env = OriginManEnv(scene, cfg)
    rows = []
    for i, gain in enumerate(gains):
        cases = [
            episode(env, c, lambda obs, g=gain: axis_correct_feedback(env, g))
            for c in TUNE_CASES
        ]
        score = [
            sum(c["walkingSuccess"] for c in cases),
            -sum(c["fallen"] for c in cases),
            sum(c["return"] for c in cases),
        ]
        row = {"index": i, "coefficients": gain, "score": score, "cases": cases}
        rows.append(row)
        with (out / "trials.jsonl").open("a") as f:
            f.write(json.dumps(row, allow_nan=False) + "\n")
        if i % 16 == 0:
            print(
                f"axis feedback {i + 1}/{len(gains)} best success={max(r['score'][0] for r in rows)}/8",
                flush=True,
            )
    selected = max(rows, key=lambda r: r["score"])
    write_json(out / "feedback.json", selected)
    finish(out, scene)
    print(
        json.dumps({"selected": selected["coefficients"], "score": selected["score"]}),
        flush=True,
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--experiment", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    tune(a.scene, a.experiment, a.out)
