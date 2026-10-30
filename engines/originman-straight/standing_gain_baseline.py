"""Matched-budget non-RL gain calibration; no final-condition access in selection."""

import argparse
import itertools
import json
from pathlib import Path

import numpy as np
from env import Config
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from standing_env import CRITERIA, StandingGym, episode, feedback
from standing_gain_rl import score


def run(scene, experiment, plan, out):
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    cfg = Config(**json.loads(experiment.read_text())["environment"])
    bridge = StandingGym(scene, cfg)
    cases = [{"force": f, "start": t} for f in [-6.75, 6.75] for t in [1.9, 2.9]] + [
        {"force": 0, "start": 2.0}
    ]
    candidates = [[0, 0]] + [
        list(x)
        for x in itertools.product(np.linspace(0, 3, 13), np.linspace(0, 0.6, 9))
    ]
    candidates += (
        np.random.default_rng(452).uniform([-3, -0.6], [3, 0.6], (282, 2)).tolist()
    )
    write_json(
        out / "tuning-plan.json",
        {
            "cases": cases,
            "candidates": candidates,
            "physicalEpisodes": 2000,
            "selection": "require no-force recovery; then most recoveries, least falls, highest same episode reward",
            "scope": "same two gain ranges and +/-6.75N training force as episode-level PPO; no final-case access during selection",
            "criteria": CRITERIA,
            "config": cfg.__dict__,
            "sceneSha256": digest(scene),
        },
    )
    trials = []
    for i, g in enumerate(candidates):
        coefficients = [*g, 0, 0]
        rows = [
            episode(bridge, c, lambda obs, g=coefficients: feedback(bridge, g))
            for c in cases
        ]
        rank = [
            bool(rows[-1]["recoverySuccess"]),
            sum(r["recoverySuccess"] for r in rows),
            -sum(r["fallen"] for r in rows),
            sum(score(r) for r in rows),
        ]
        row = {"index": i, "coefficients": coefficients, "score": rank, "cases": rows}
        trials.append(row)
        with (out / "trials.jsonl").open("a") as f:
            f.write(json.dumps(row) + "\n")
        if i % 50 == 0:
            print(
                f"matched calibration {i + 1}/400 best={max(t['score'][:2] for t in trials)}",
                flush=True,
            )
    selected = max(trials, key=lambda t: t["score"])
    write_json(out / "feedback.json", selected)
    frozen = json.loads(plan.read_text())
    write_json(
        out / "final-plan.json",
        {
            "cases": frozen["cases"],
            "planSha256": digest(plan),
            "selectionUsesFinalCases": False,
        },
    )
    final = []
    for c in frozen["cases"]:
        final.append(
            episode(
                bridge,
                c,
                lambda obs: feedback(bridge, selected["coefficients"]),
                trace=True,
            )
        )
    with (out / "final-episodes.jsonl").open("w") as f:
        for r in final:
            f.write(json.dumps(r) + "\n")
    result = {
        "coefficients": selected["coefficients"],
        "recoverySuccesses": sum(r["recoverySuccess"] for r in final),
        "falls": sum(r["fallen"] for r in final),
        "cases": len(final),
        "normalStanding": final[-1]["recoverySuccess"],
    }
    write_json(out / "summary.json", result)
    finish(out, scene)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--experiment", type=Path, required=True)
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    run(a.scene, a.experiment, a.plan, a.out)
