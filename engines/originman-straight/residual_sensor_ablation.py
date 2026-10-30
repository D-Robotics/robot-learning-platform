"""Freeze body/joint observations while preserving the policy's own previous-action input."""

import argparse
import json
from pathlib import Path

from env import Config
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from residual_env import CONTROLLER, ResidualStandingGym
from sb3_evaluate import ArtifactPolicy
from sb3_receipt import verify
from standing_env import episode


def run(root, plan_path, out):
    seeds = [7, 17, 27]
    plan = json.loads(plan_path.read_text())
    scene = root / "standing-residual-seed7/model/scene.xml"
    cfg = Config(
        **json.loads(
            (root / "standing-residual-seed7/training-summary.json").read_text()
        )["config"]
    )
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    write_json(
        out / "plan.json",
        {
            "cases": plan["cases"],
            "finalPlanSha256": digest(plan_path),
            "frozenChannels": list(range(12)),
            "liveChannels": [12, 13],
            "scope": "supplementary frozen-policy diagnosis; freeze IMU/joint observations at initial values, retain actual previous correction input; baseline PD remains closed loop; no policy selection or retuning",
        },
    )
    summary = {}
    for seed in seeds:
        run = root / f"standing-residual-seed{seed}"
        if not verify(run)["verified"]:
            raise ValueError("training integrity failed")
        if json.loads((run / "controller.json").read_text()) != CONTROLLER:
            raise ValueError("controller mismatch")
        bridge = ResidualStandingGym(scene, cfg)
        rows = []
        for case in plan["cases"]:
            policy = ArtifactPolicy(run)
            initial = [None]
            decisions = []

            def act(obs, policy=policy, initial=initial, decisions=decisions):
                if initial[0] is None:
                    initial[0] = obs[:12].copy()
                frozen = obs.copy()
                frozen[:12] = initial[0]
                command = policy(frozen)
                decisions.append(
                    {
                        "policyInput": frozen.tolist(),
                        "liveObservation": obs.tolist(),
                        "actorOutput": command.tolist(),
                    }
                )
                return command

            row = {
                "seed": seed,
                **episode(bridge, case, act, trace=False),
                "decisions": decisions,
            }
            rows.append(row)
            with (out / "episodes.jsonl").open("a") as f:
                f.write(json.dumps(row) + "\n")
        summary[str(seed)] = {
            "recoverySuccesses": sum(r["recoverySuccess"] for r in rows),
            "falls": sum(r["fallen"] for r in rows),
            "cases": len(rows),
            "normalStanding": rows[-1]["recoverySuccess"],
        }
        if not verify(run)["verified"]:
            raise ValueError("training artifacts changed")
        print(json.dumps({seed: summary[str(seed)]}), flush=True)
    write_json(out / "summary.json", summary)
    finish(out, scene)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    run(a.root, a.plan, a.out)
