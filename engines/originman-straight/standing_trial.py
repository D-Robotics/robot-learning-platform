"""Train and visualize recovery development cases; final cases stay separate."""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from env import Config
from monitor import write_json
from sb3_evaluate import ArtifactPolicy
from sb3_trial import Predictor, Recorder, train
from standing_env import CRITERIA, StandingGym, episode

DEV_CASES = [
    {"force": force, "start": start}
    for force in [-8.25, -7.25, 7.25, 8.25]
    for start in [1.9, 2.9]
] + [{"force": 0, "start": 2.0}]


class StandingRecorder(Recorder):
    def __init__(self, rec, normalizer, physical, total):
        super().__init__(rec, normalizer, physical, total)
        self.bridge = StandingGym(rec.scene, physical[0].physical.config)
        self.next_validation = 200_000
        (rec.out / "validation").mkdir()
        write_json(rec.out / "standing-criteria.json", CRITERIA)
        self.reference = [
            episode(self.bridge, case, lambda obs: np.zeros(2), trace=True)
            for case in DEV_CASES
        ]

    def validation(self, steps, initial=False):
        rows = []
        for case in DEV_CASES:
            actor = (
                ArtifactPolicy(self.rec.out / "initial")
                if initial
                else Predictor(self.model, self.normalizer)
            )
            rows.append(episode(self.bridge, case, actor, trace=True))
        payload = {
            "timesteps": steps,
            "scope": "development only, not final evaluation or checkpoint selection",
            "reference": self.reference,
            "rl": rows,
            "referenceSuccesses": sum(r["recoverySuccess"] for r in self.reference),
            "rlSuccesses": sum(r["recoverySuccess"] for r in rows),
        }
        write_json(self.rec.out / "validation" / f"standing-{steps:08d}.json", payload)
        self.rec.emit(
            "standing-validation",
            {k: v for k, v in payload.items() if k not in ["reference", "rl"]},
        )
        print(
            f"[standing-validation] steps={steps} reference={payload['referenceSuccesses']}/9 RL={payload['rlSuccesses']}/9",
            flush=True,
        )

    def _on_training_start(self):
        self.validation(0, initial=True)

    def _on_rollout_end(self):
        super()._on_rollout_end()
        if self.num_timesteps >= self.next_validation:
            self.validation(self.num_timesteps)
            self.next_validation += 200_000


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--experiment", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--steps", type=int, default=1_000_000)
    p.add_argument("--seed", type=int, default=7)
    a = p.parse_args()
    experiment = json.loads(a.experiment.read_text())
    Config(**experiment["environment"])
    torch.set_num_threads(1)
    train(
        a.scene,
        a.out,
        experiment,
        "roll",
        a.steps,
        a.seed,
        env_class=StandingGym,
        callback_class=StandingRecorder,
        task="stationary-disturbance-recovery",
        action_scope="50Hz feedback of physical ankle/hip roll residuals; 2 actions mapped to 10 leg residual slots",
    )
