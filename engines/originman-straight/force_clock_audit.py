"""Measure actual applied disturbance windows, independently of reward or policy."""

import argparse
import math
from pathlib import Path

import numpy as np
from env import Config, OriginManEnv
from monitor import digest, write_json


def audit(scene, out):
    out.mkdir(parents=True, exist_ok=False)
    starts = [1.2, 1.4, 2.6, 3.4, 4.6]
    periods = [0.02, 0.04]
    write_json(
        out / "plan.json",
        {
            "starts": starts,
            "controlPeriods": periods,
            "duration": 0.2,
            "forceY": 1.0,
            "sceneSha256": digest(scene),
            "sourceSha256": digest(Path(__file__).with_name("env.py")),
            "purpose": "aligned timestamps must not acquire a full control-period shift from floating point accumulation",
        },
    )
    reference = None
    rows = []
    for period in periods:
        env = OriginManEnv(scene, Config(control_dt=period), reference=reference)
        if reference is None:
            reference = env.reference
        for start in starts:
            env.reset()
            env.push_start = start
            env.push_force[:] = [0, 1.0, 0]
            active = []
            for step in range(round(6 / period)):
                _, _, _, info = env.step(np.zeros(10))
                if info["externalForceWorldN"][1]:
                    active.append(step)
            expected_step = math.ceil(start / period - 1e-8)
            expected_count = round(0.2 / period)
            rows.append(
                {
                    "period": period,
                    "start": start,
                    "firstActiveStep": active[0] if active else None,
                    "expectedFirstStep": expected_step,
                    "activeFrames": len(active),
                    "expectedFrames": expected_count,
                    "onsetErrorSeconds": (active[0] - expected_step) * period
                    if active
                    else None,
                    "appliedImpulseNs": len(active) * period,
                    "passed": bool(
                        active
                        and active[0] == expected_step
                        and len(active) == expected_count
                    ),
                }
            )
    write_json(out / "results.json", rows)
    print(rows, flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    audit(a.scene, a.out)
