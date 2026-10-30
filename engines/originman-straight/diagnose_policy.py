"""Expose critic-to-actor drift and verify nominal reference preservation."""

import argparse
import json
from pathlib import Path

import numpy as np
import torch
from env import OriginManEnv
from monitor import digest, parse_experiment, write_json
from policy import ResidualActorCritic


def diagnose(scene, experiment, policy_path, out):
    out.mkdir(parents=True, exist_ok=False)
    cfg, _, _ = parse_experiment(json.loads(experiment.read_text()))
    reference = OriginManEnv(scene, cfg)
    guarded = OriginManEnv(scene, cfg, reference=reference.reference)
    reference.reset(seed=781)
    guarded.reset(seed=781)
    reference.push_force[:] = 0
    guarded.push_force[:] = 0
    rng = np.random.default_rng(194)
    gates = []
    max_position_difference = 0.0
    for _ in range(400):
        reference.step(np.zeros(10))
        _, _, done, info = guarded.step(rng.uniform(-1, 1, 10))
        gates.append(info["recoveryGate"])
        max_position_difference = max(
            max_position_difference,
            float(np.max(abs(reference.data.qpos - guarded.data.qpos))),
        )
        if done:
            break
    checkpoint = torch.load(policy_path, map_location="cpu", weights_only=True)[
        "state_dict"
    ]
    torch.manual_seed(528)
    observations = torch.randn(32, 41) * 0.2
    drift = []
    for architecture in ["shared", "separate"]:
        policy = ResidualActorCritic(41, 10, architecture)
        own = policy.state_dict()
        own.update(
            {
                k: v
                for k, v in checkpoint.items()
                if not k.startswith("value.") or architecture == "shared"
            }
        )
        policy.load_state_dict(own)
        before, values = policy(observations)
        expected = before.detach().clone()
        loss = (values - (values.detach() + 1)).square().mean()
        optimizer = torch.optim.Adam(policy.parameters(), lr=0.001)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        delta = policy(observations)[0].detach() - expected
        drift.append(
            {
                "valueNetwork": architecture,
                "maxMeanOutputChange": float(delta.abs().max()),
                "meanOutputChange": float(delta.abs().mean()),
            }
        )
    write_json(
        out / "diagnosis.json",
        {
            "sceneSha256": digest(scene),
            "experimentSha256": digest(experiment),
            "testedPolicySha256": digest(policy_path),
            "sourceSha256": {
                p.name: digest(p)
                for p in [
                    Path(__file__),
                    Path(__file__).with_name("env.py"),
                    Path(__file__).with_name("policy.py"),
                ]
            },
            "gateNormalGait": {
                "frames": len(gates),
                "activeFrames": sum(g > 0 for g in gates),
                "maxQposDifference": max_position_difference,
                "forwardM": info["x"],
                "fallen": info["fallen"],
            },
            "criticOnlyUpdate": drift,
            "scope": "nominal simulation only; value-only update identifies a mechanism, not sole cause; random policy outputs are deliberately blocked by IMU gate during normal gait; no recovery or hardware claim",
        },
    )
    if max(gates) != 0 or max_position_difference > 1e-12:
        raise RuntimeError("nominal recovery gate did not preserve reference gait")
    if drift[1]["maxMeanOutputChange"] != 0:
        raise RuntimeError("separate critic changed actor")
    print((out / "diagnosis.json").read_text(), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--experiment", type=Path, required=True)
    p.add_argument("--policy", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    torch.set_num_threads(1)
    diagnose(a.scene, a.experiment, a.policy, a.out)
