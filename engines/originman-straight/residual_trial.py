"""SAC learns per-step corrections; the frozen PD controller is never trained."""

import argparse
import json
from pathlib import Path

import torch
from residual_env import CONTROLLER, ResidualStandingGym
from standing_sac import train

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--experiment", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--steps", type=int, default=500000)
    p.add_argument("--seed", type=int, default=7)
    a = p.parse_args()
    torch.set_num_threads(1)
    train(
        a.scene,
        json.loads(a.experiment.read_text()),
        a.out,
        a.steps,
        a.seed,
        env_class_override=ResidualStandingGym,
        entropy_coef=0.001,
        initial_mean_zero=True,
        task_parameters=CONTROLLER,
        actor_inputs=CONTROLLER["observation"]
        + "; fixed scaling, no force, simulator XY or push clock",
        action_scope="50Hz learned hip/ankle corrections added to frozen stable PD, not gain selection",
    )
