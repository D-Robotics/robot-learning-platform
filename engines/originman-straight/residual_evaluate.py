"""Frozen PD vs zero-initialized and learned 50Hz correction, with a frozen-output ablation."""

import argparse
import json
from pathlib import Path

import numpy as np
from env import Config
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from residual_env import CONTROLLER, ResidualStandingGym
from sb3_evaluate import ArtifactPolicy
from sb3_receipt import verify
from standing_env import CRITERIA, StandingGym, episode


def evaluate(run, plan_path, out):
    if not verify(run)["verified"]:
        raise ValueError("training integrity failed")
    plan = json.loads(plan_path.read_text())
    if run.name not in plan["plannedRuns"]:
        raise ValueError("unplanned final policy")
    if json.loads((run / "controller.json").read_text()) != CONTROLLER:
        raise ValueError(
            "controller implementation/configuration changed; use matching source snapshot"
        )
    summary = json.loads((run / "training-summary.json").read_text())
    cfg = Config(**summary["config"])
    scene = run / "model/scene.xml"
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    passive = StandingGym(scene, cfg)
    residual = ResidualStandingGym(scene, cfg)
    write_json(
        out / "plan.json",
        {
            **plan,
            "criteria": CRITERIA,
            "controller": CONTROLLER,
            "controllerSha256": digest(run / "controller.json"),
            "policySha256": digest(run / "policy.onnx"),
            "initialPolicySha256": digest(run / "initial/policy.onnx"),
            "finalPlanSha256": digest(plan_path),
            "scope": "finite deterministic simulation conditions; actor produces continuous corrections; no hardware eligibility",
        },
    )
    rows = []
    for index, case in enumerate(plan["cases"]):
        for controller in [
            "reference",
            "imu-feedback",
            "untrained",
            "rl",
            "rl-frozen-correction",
        ]:
            bridge = passive if controller == "reference" else residual
            policy = ArtifactPolicy(
                run / "initial" if controller == "untrained" else run
            )
            fixed = [None]
            decisions = []

            def action(
                obs,
                mode=controller,
                policy=policy,
                fixed=fixed,
                bridge=bridge,
                decisions=decisions,
            ):
                evaluated = mode in ["untrained", "rl"] or (
                    mode == "rl-frozen-correction" and fixed[0] is None
                )
                if mode in ["reference", "imu-feedback"]:
                    output = np.zeros(2)
                elif mode == "rl-frozen-correction":
                    if fixed[0] is None:
                        fixed[0] = policy(obs).copy()
                    output = fixed[0]
                else:
                    output = policy(obs)
                decisions.append(
                    {
                        "timeBefore": bridge.physical.time,
                        "policyEvaluated": evaluated,
                        "policyInput": obs.tolist() if evaluated else None,
                        "actorOutput": output.tolist(),
                    }
                )
                return output

            row = {
                "controller": controller,
                **episode(bridge, case, action, trace=True),
            }
            row["decisions"] = decisions
            for frame in row["frames"]:
                decision = decisions[round(frame["time"] / cfg.control_dt) - 1]
                frame["policyInputBeforeAction"] = decision["policyInput"]
                frame["actorOutputNormalized"] = decision["actorOutput"]
            requests = np.array(
                [f.get("learningCorrectionRadians", [0, 0]) for f in row["frames"]]
            )
            applied = np.array(
                [f.get("executedExtraTargetRadians", [0, 0]) for f in row["frames"]]
            )
            row["correctionRequestRmsRad"] = np.sqrt(
                np.mean(requests**2, axis=0)
            ).tolist()
            row["executedExtraTargetRmsRad"] = np.sqrt(
                np.mean(applied**2, axis=0)
            ).tolist()
            rows.append(row)
            with (out / "episodes.jsonl").open("a") as f:
                f.write(json.dumps(row, allow_nan=False) + "\n")
        print(f"residual final {index + 1}/{len(plan['cases'])}", flush=True)
    grouped = {
        mode: [r for r in rows if r["controller"] == mode]
        for mode in [
            "reference",
            "imu-feedback",
            "untrained",
            "rl",
            "rl-frozen-correction",
        ]
    }
    aggregate = {
        mode: {
            "recoverySuccesses": sum(r["recoverySuccess"] for r in g),
            "falls": sum(r["fallen"] for r in g),
            "cases": len(g),
            "normalStanding": g[-1]["recoverySuccess"],
        }
        for mode, g in grouped.items()
    }
    base = grouped["imu-feedback"]
    rl = grouped["rl"]
    constant = grouped["rl-frozen-correction"]
    improvement = [
        i
        for i, (a, b) in enumerate(zip(base, rl, strict=True))
        if not a["recoverySuccess"] and b["recoverySuccess"]
    ]
    regressions = [
        i
        for i, (a, b) in enumerate(zip(base, rl, strict=True))
        if a["recoverySuccess"] and not b["recoverySuccess"]
    ]
    dynamic = [
        i
        for i, (a, b) in enumerate(zip(constant, rl, strict=True))
        if not a["recoverySuccess"] and b["recoverySuccess"]
    ]
    for a, b in zip(base, grouped["untrained"], strict=True):
        for key in [
            "recoverySuccess",
            "fallen",
            "forwardM",
            "lateralM",
            "seconds",
            "settledFraction",
        ]:
            if a[key] != b[key]:
                raise ValueError("initial policy changed baseline behavior")
        np.testing.assert_array_equal(
            [f["qpos"] for f in a["frames"]], [f["qpos"] for f in b["frames"]]
        )
        np.testing.assert_array_equal(
            [f["jointTarget"] for f in a["frames"]],
            [f["jointTarget"] for f in b["frames"]],
        )
    clear = bool(
        aggregate["rl"]["recoverySuccesses"]
        - aggregate["imu-feedback"]["recoverySuccesses"]
        >= plan["minimumClearGainConditions"]
        and rl[-1]["recoverySuccess"]
        and len(dynamic) >= 3
    )
    write_json(
        out / "summary.json",
        {
            "controllers": aggregate,
            "improvementIndices": improvement,
            "regressionIndices": regressions,
            "dynamicFeedbackImprovementIndices": dynamic,
            "clearGain": clear,
            "initialPolicyMatchesBaselineExactly": True,
            "hardwareEligible": False,
        },
    )
    if not verify(run)["verified"]:
        raise ValueError("training artifacts changed during evaluation")
    finish(out, scene)
    print(
        json.dumps(
            {
                "controllers": aggregate,
                "improvements": improvement,
                "regressions": regressions,
                "clearGain": clear,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    evaluate(a.run, a.plan, a.out)
