"""Frozen learned gain controllers across numerical and unmeasured actuator hypotheses."""

import argparse
import json
from pathlib import Path

from env import Config
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from standing_env import StandingGym, episode, feedback


def run(root, plan_path, out):
    out.mkdir(parents=True, exist_ok=False)
    scene = root / "standing-gain-seed7/model/scene.xml"
    capture(out, scene)
    base = json.loads((root / "standing-gain-seed7/training-summary.json").read_text())[
        "config"
    ]
    all_cases = json.loads(plan_path.read_text())["cases"]
    cases = [c for i, c in enumerate(all_cases) if i % 3 == 0 or c["force"] == 0]
    variants = [
        {"name": "nominal", "dt": 0.001},
        {"name": "dt-0.5ms", "dt": 0.0005},
        {"name": "dt-0.25ms", "dt": 0.00025},
        {"name": "kp-minus20", "dt": 0.001, "kp": 6.4},
        {"name": "kp-plus20", "dt": 0.001, "kp": 9.6},
        {"name": "effort-minus20", "dt": 0.001, "effort": 1.2},
        {"name": "effort-plus20", "dt": 0.001, "effort": 1.8},
    ]
    controllers = {"reference": [0, 0, 0, 0]}
    controllers.update(
        {
            f"rl-{seed}": json.loads(
                (root / f"standing-gain-seed{seed}/gains.json").read_text()
            )["coefficients"]
            for seed in [7, 17, 27]
        }
    )
    write_json(
        out / "plan.json",
        {
            "cases": cases,
            "caseSelection": "first phase of every force plus no-force; no retuning",
            "variants": variants,
            "controllers": controllers,
            "finalPlanSha256": digest(plan_path),
            "scope": "hypothetical one-factor checks, not measured hardware ranges; only 11 of 31 conditions",
        },
    )
    rows = []
    summary = {}
    for v in variants:
        cfg = Config(
            **{
                **base,
                **{k: value for k, value in v.items() if k not in ["name", "dt"]},
            }
        )
        bridge = StandingGym(scene, cfg)
        bridge.physical.model.opt.timestep = v["dt"]
        for c in cases:
            for mode, g in controllers.items():
                row = {
                    "variant": v["name"],
                    "controller": mode,
                    **episode(bridge, c, lambda obs, g=g, b=bridge: feedback(b, g)),
                }
                rows.append(row)
                with (out / "episodes.jsonl").open("a") as f:
                    f.write(json.dumps(row) + "\n")
        summary[v["name"]] = {
            mode: {
                "recoverySuccesses": sum(
                    r["recoverySuccess"]
                    for r in rows
                    if r["variant"] == v["name"] and r["controller"] == mode
                ),
                "falls": sum(
                    r["fallen"]
                    for r in rows
                    if r["variant"] == v["name"] and r["controller"] == mode
                ),
                "cases": len(cases),
            }
            for mode in controllers
        }
        print(json.dumps({v["name"]: summary[v["name"]]}), flush=True)
    write_json(out / "summary.json", summary)
    finish(out, scene)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    run(a.root, a.plan, a.out)
