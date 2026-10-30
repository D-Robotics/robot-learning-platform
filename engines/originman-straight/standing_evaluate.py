"""Frozen stationary-recovery policy against reference, PD and untrained policy."""

import argparse
import itertools
import json
from pathlib import Path

import numpy as np
from env import Config
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from sb3_evaluate import ArtifactPolicy
from sb3_receipt import verify
from standing_env import CRITERIA, StandingGym, episode, feedback
from standing_linear_env import RollRateGym
from standing_trial import DEV_CASES


def tune(scene, experiment, out):
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    cfg = Config(**json.loads(experiment.read_text())["environment"])
    bridge = StandingGym(scene, cfg)
    gains = list(itertools.product([0, 1, 2], [0, 0.1, 0.3], [0, 1, 2], [0, 0.1, 0.3]))
    gains += (
        np.random.default_rng(452)
        .uniform([-3, -0.5, -3, -0.5], [3, 0.5, 3, 0.5], (63, 4))
        .tolist()
    )
    write_json(
        out / "plan.json",
        {
            "cases": DEV_CASES,
            "coefficients": gains,
            "config": cfg.__dict__,
            "sceneSha256": digest(scene),
            "criteria": CRITERIA,
        },
    )
    trials = []
    for i, gain in enumerate(gains):
        cases = [
            episode(bridge, c, lambda obs, g=gain: feedback(bridge, g))
            for c in DEV_CASES
        ]
        score = [
            sum(c["recoverySuccess"] for c in cases),
            -sum(c["fallen"] for c in cases),
            sum(c["return"] for c in cases),
        ]
        row = {"index": i, "coefficients": list(gain), "score": score, "cases": cases}
        trials.append(row)
        with (out / "trials.jsonl").open("a") as f:
            f.write(json.dumps(row, allow_nan=False) + "\n")
        if i % 16 == 0:
            print(
                f"standing PD {i + 1}/{len(gains)} best={max(r['score'][0] for r in trials)}/9",
                flush=True,
            )
    selected = max(trials, key=lambda r: r["score"])
    write_json(out / "feedback.json", selected)
    finish(out, scene)
    print(
        json.dumps({"selected": selected["coefficients"], "score": selected["score"]}),
        flush=True,
    )


def evaluate(run, feedback_path, plan_path, out):
    if not verify(run)["verified"]:
        raise ValueError("run integrity check failed")
    plan = json.loads(plan_path.read_text())
    if run.name not in plan["plannedRuns"]:
        raise ValueError("unplanned run")
    scene = run / "model/scene.xml"
    summary = json.loads((run / "training-summary.json").read_text())
    cfg = Config(**summary["config"])
    tuning = json.loads((feedback_path.parent / "plan.json").read_text())
    if tuning["config"] != cfg.__dict__ or tuning["sceneSha256"] != digest(scene):
        raise ValueError("feedback configuration/model mismatch")
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    bridge = (RollRateGym if summary.get("linearRollRatePolicy") else StandingGym)(
        scene, cfg
    )
    basis = np.load(run / "foot-basis.npy", allow_pickle=False)
    np.testing.assert_array_equal(basis, bridge.modes.basis)
    gains = json.loads(feedback_path.read_text())["coefficients"]
    write_json(
        out / "plan.json",
        {
            **plan,
            "criteria": CRITERIA,
            "runReceiptSha256": digest(run / "sb3-evidence.json"),
            "feedbackSha256": digest(feedback_path),
            "finalPlanSha256": digest(plan_path),
        },
    )
    rows = []
    for i, case in enumerate(plan["cases"]):
        for controller in ["reference", "imu-feedback", "untrained", "rl"]:
            if controller == "reference":
                actor = lambda obs: np.zeros(2)
            elif controller == "imu-feedback":
                actor = lambda obs: feedback(bridge, gains)
            else:
                actor = ArtifactPolicy(
                    run / "initial" if controller == "untrained" else run
                )
            row = {"controller": controller, **episode(bridge, case, actor, trace=True)}
            rows.append(row)
            with (out / "episodes.jsonl").open("a") as f:
                f.write(json.dumps(row, allow_nan=False) + "\n")
        print(f"standing final {i + 1}/{len(plan['cases'])}", flush=True)
    aggregate = {}
    for controller in ["reference", "imu-feedback", "untrained", "rl"]:
        cases = [r for r in rows if r["controller"] == controller]
        aggregate[controller] = {
            "recoverySuccesses": sum(r["recoverySuccess"] for r in cases),
            "falls": sum(r["fallen"] for r in cases),
            "cases": len(cases),
        }
    write_json(out / "summary.json", aggregate)
    if not verify(run)["verified"]:
        raise ValueError("run changed during evaluation")
    finish(out, scene)
    print(json.dumps(aggregate), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="command", required=True)
    t = sub.add_parser("tune")
    t.add_argument("--scene", type=Path, required=True)
    t.add_argument("--experiment", type=Path, required=True)
    t.add_argument("--out", type=Path, required=True)
    e = sub.add_parser("evaluate")
    e.add_argument("--run", type=Path, required=True)
    e.add_argument("--feedback", type=Path, required=True)
    e.add_argument("--plan", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    if a.command == "tune":
        tune(a.scene, a.experiment, a.out)
    else:
        evaluate(a.run, a.feedback, a.plan, a.out)
