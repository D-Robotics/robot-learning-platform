"""Locked-policy denser hold-out sweep; no retraining or checkpoint selection."""

import argparse
import json
from pathlib import Path

import experiment as exp
import numpy as np
import torch
from kick_env import KickEnv

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    a = p.parse_args()
    out = a.root / "extended-evaluation"
    out.mkdir()
    targets = [
        round(float(v), 2)
        for v in np.arange(0.06, 0.20, 0.01)
        if round(float(v), 2) not in exp.TRAIN_TARGETS
    ]
    exp.save(
        out / "plan.json",
        {
            "targetsM": targets,
            "reason": "denser target coverage with frozen final policies; still deterministic scenario coverage, not independent stochastic trials",
            "retraining": False,
            "checkpointSelection": False,
        },
    )
    exp.TEST_TARGETS = targets
    anchors = json.loads((a.root / "calibration.json").read_text())["anchors"]
    policies = {}
    for seed in exp.SEEDS:
        policy = exp.ActorCritic(1, 2)
        policy.load_state_dict(
            torch.load(
                a.root / f"seed-{seed}/policy.pt", map_location="cpu", weights_only=True
            )["state_dict"]
        )
        policy.eval()
        policies[seed] = policy
    env = KickEnv(a.root / "model/source-scene.xml", a.root / "model/scene.xml")
    exp.evaluate(env, out, anchors, policies)
