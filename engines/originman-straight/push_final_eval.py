"""Load a predeclared final case plan; do not reuse inspected pilot cases as holdout."""

import argparse
import json
from pathlib import Path

import push_eval
from monitor import digest, write_json

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--policy", type=Path, required=True)
    p.add_argument("--feedback", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    plan = json.loads(a.plan.read_text())
    if a.policy.parent.name not in plan["plannedRuns"]:
        raise ValueError("policy run not predeclared in final plan")
    push_eval.TEST_CASES = plan["cases"]
    push_eval.evaluate(a.scene, a.policy, a.out, a.feedback)
    write_json(
        a.out / "final-plan-receipt.json",
        {
            "finalPlanSha256": digest(a.plan),
            "policySha256": digest(a.policy),
            "sourceSha256": digest(Path(__file__)),
            "pilotCasesReusedAsFinalHoldout": False,
            "scope": "deterministic simulation coverage, not independent hardware trials",
        },
    )
