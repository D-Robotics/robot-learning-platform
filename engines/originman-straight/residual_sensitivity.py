"""Frozen continuous policies across numerical and unmeasured actuator hypotheses."""

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
from standing_env import episode


def run(root, plan_path, out):
    seeds = [7, 17, 27]
    for s in seeds:
        if not verify(root / f"standing-residual-seed{s}")["verified"]:
            raise ValueError("training integrity failed")
        if (
            json.loads(
                (root / f"standing-residual-seed{s}/controller.json").read_text()
            )
            != CONTROLLER
        ):
            raise ValueError("controller mismatch")
    scene = root / "standing-residual-seed7/model/scene.xml"
    if (
        len(
            {digest(root / f"standing-residual-seed{s}/model/scene.xml") for s in seeds}
        )
        != 1
    ):
        raise ValueError("models differ")
    cfg = json.loads(
        (root / "standing-residual-seed7/training-summary.json").read_text()
    )["config"]
    plan = json.loads(plan_path.read_text())
    indices = {i for i, c in enumerate(plan["cases"]) if i % 3 == 0 or c["force"] == 0}
    for s in seeds:
        indices.update(
            json.loads(
                (root / f"standing-final-residual-seed{s}/summary.json").read_text()
            )["regressionIndices"]
        )
    indices = sorted(indices)
    cases = [plan["cases"][i] for i in indices]
    variants = [
        {"name": "nominal", "dt": 0.001},
        {"name": "dt-0.5ms", "dt": 0.0005},
        {"name": "dt-0.25ms", "dt": 0.00025},
        {"name": "servo-kp-minus20", "dt": 0.001, "kp": 6.4},
        {"name": "servo-kp-plus20", "dt": 0.001, "kp": 9.6},
        {"name": "effort-minus20", "dt": 0.001, "effort": 1.2},
        {"name": "effort-plus20", "dt": 0.001, "effort": 1.8},
    ]
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    write_json(
        out / "plan.json",
        {
            "indices": indices,
            "cases": cases,
            "selection": "first phase per force, no-force and every observed regression; no retuning",
            "variants": variants,
            "controller": CONTROLLER,
            "finalPlanSha256": digest(plan_path),
            "scope": "hypothetical one-factor checks; not measured hardware parameter ranges or full 31-condition coverage",
        },
    )
    policies = {
        f"rl-{s}": ArtifactPolicy(root / f"standing-residual-seed{s}") for s in seeds
    }
    all_rows = []
    summary = {}
    for variant in variants:
        bridge = ResidualStandingGym(
            scene,
            Config(
                **{
                    **cfg,
                    **{k: v for k, v in variant.items() if k not in ["name", "dt"]},
                }
            ),
        )
        bridge.physical.model.opt.timestep = variant["dt"]
        rows = []
        for case in cases:
            for mode in ["baseline", *policies]:
                actor = policies.get(mode)
                if actor:
                    actor.reset()
                row = {
                    "variant": variant["name"],
                    "controller": mode,
                    **episode(
                        bridge, case, actor if actor else lambda obs: np.zeros(2)
                    ),
                }
                rows.append(row)
                all_rows.append(row)
                with (out / "episodes.jsonl").open("a") as f:
                    f.write(json.dumps(row) + "\n")
        summary[variant["name"]] = {
            mode: {
                "recoverySuccesses": sum(
                    r["recoverySuccess"] for r in rows if r["controller"] == mode
                ),
                "falls": sum(r["fallen"] for r in rows if r["controller"] == mode),
                "cases": len(cases),
            }
            for mode in ["baseline", *policies]
        }
        print(json.dumps({variant["name"]: summary[variant["name"]]}), flush=True)
    write_json(out / "summary.json", summary)
    for s in seeds:
        if not verify(root / f"standing-residual-seed{s}")["verified"]:
            raise ValueError("training artifacts changed")
    finish(out, scene)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    run(a.root, a.plan, a.out)
