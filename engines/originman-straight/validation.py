"""Fixed development probes. These are validation, not final test episodes."""

from dataclasses import replace

import numpy as np
from env import OriginManEnv

CASES = [
    {"seed": 8100, "asymmetry": -0.12, "initial_yaw": -0.04},
    {"seed": 8101, "asymmetry": -0.06, "initial_yaw": 0.04},
    {"seed": 8102, "asymmetry": 0.06, "initial_yaw": -0.04},
    {"seed": 8103, "asymmetry": 0.12, "initial_yaw": 0.04},
]


class ValidationProbe:
    def __init__(self, scene, config, reference, seconds):
        self.env = OriginManEnv(
            scene, replace(config, episode_seconds=seconds), reference=reference
        )
        self.baseline = self.run(lambda obs: np.zeros(10), "reference")

    def run(self, act, mode):
        rows = []
        for case in CASES:
            obs = self.env.reset(**case)
            frames = []
            for step in range(
                round(self.env.config.episode_seconds / self.env.config.control_dt)
            ):
                obs, _, done, info = self.env.step(act(obs))
                if step % 5 == 0 or done:
                    frames.append({**info, **self.env.diagnostic_frame()})
                if done:
                    break
            rows.append(
                {
                    **case,
                    "x": info["x"],
                    "lateralAbsMeters": abs(info["y"]),
                    "headingAbsRadians": abs(info["yaw"]),
                    "fallen": info["fallen"],
                    "seconds": info["time"],
                    "frames": frames,
                }
            )
        return {
            "mode": mode,
            "cases": rows,
            "meanForwardMeters": float(np.mean([r["x"] for r in rows])),
            "meanLateralAbsMeters": float(
                np.mean([r["lateralAbsMeters"] for r in rows])
            ),
            "fallRate": float(np.mean([r["fallen"] for r in rows])),
        }
