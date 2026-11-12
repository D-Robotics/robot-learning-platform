#!/usr/bin/env python3
"""Rehearse the mixed choreography on an isolated, simulation-only contract."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnxruntime
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import DummyVecEnv

from adapter import validate_bundle, write_onnx
from dance_env import squat_rise_phase, validate_dance_config
from dance_env_v2 import ExplicitAlternationChoreography, section_phase_features
from train import evaluate

MOTIFS = ("alternating-arms", "weight-shift", "squat-rise", "open-pose")
BPM = 112.0
PPO_STEPS = 8192
PHASE_SAMPLES = 4096
SEED = 7


class DeepSquatRehearsal(ExplicitAlternationChoreography):
    """Allow the knee flexion the squat gate requires, only in this simulator."""

    action_adapter_id = "originman-rehearsal-deep-squat-18d-v1"

    def __init__(self, bundle, config, training=False):
        super().__init__(bundle, config, training=training)
        for index, name in enumerate(self.names):
            if name.endswith(("hip_pitch", "ank_pitch")):
                self.scale[index] = 0.58
            elif name.endswith("_knee"):
                self.scale[index] = 0.80


def demonstration(joints, motif, progress):
    """Bounded trajectory fit against MuJoCo, including the shift exit to neutral."""
    local = progress * 8
    if motif == "alternating-arms":
        swing = 0.5 * np.tanh(2 * np.cos(np.pi * local + 0.36))
        commands = {"l_sho_pitch": swing, "r_sho_pitch": -swing}
    elif motif == "weight-shift":
        fade = min(1, progress / 0.07, (1 - progress) / 0.10621114940690335)
        roll = 0.9599839830529642 * np.cos(
            np.pi * np.clip(progress + 0.06581659904010513, 0, 1)
        ) * fade
        ankle = 0.3723941817480349 * roll - 0.012849011381986642
        commands = {
            "l_hip_roll": roll, "r_hip_roll": -1.4837978979027846 * roll,
            "l_ank_roll": ankle, "r_ank_roll": ankle,
        }
    elif motif == "squat-rise":
        phase = squat_rise_phase(np.clip(progress + 0.023160408725347664, 0, 1))
        depth = ((1 - phase) / 2) ** 1.1855056486652933
        knee = -0.3499884211743747 + 1.4375298862827115 * depth
        roll = 0.5142792101627054 * depth
        commands = {}
        for side, direction in (("l", 1), ("r", -1)):
            commands.update({
                f"{side}_knee": knee,
                f"{side}_hip_pitch": -0.685841528660738 * knee,
                f"{side}_ank_pitch": -0.2665199889631962 * knee,
                f"{side}_hip_roll": roll,
                f"{side}_ank_roll": -direction * 0.5279552683757015 * roll,
                f"{side}_sho_pitch": -0.17291669073594534 + 1.1926691269885183 * depth,
            })
    else:
        commands = {"l_sho_roll": -0.85, "r_sho_roll": 0.85}
    return np.clip([commands.get(name, 0) for name in joints], -1, 1)


def initialize_policy(env, checkpoint):
    model = PPO("MlpPolicy", env, device="cpu", seed=SEED, n_steps=256,
                policy_kwargs={"net_arch": [160, 160], "log_std_init": -1.1})
    width = env.observation_space.shape[0]
    inputs, labels = [], []
    for index, motif in enumerate(MOTIFS):
        for progress in np.linspace(0, 1, PHASE_SAMPLES, endpoint=False):
            row = np.zeros(width, dtype=np.float32)
            row[-13 + index] = 1
            row[-5:-1] = section_phase_features(8 * progress, progress, False)[:4]
            inputs.append(row)
            labels.append(demonstration(env.names, motif, progress))

    inputs = torch.tensor(np.asarray(inputs))
    labels = torch.tensor(np.asarray(labels), dtype=torch.float32)
    policy = model.policy
    first_layer = policy.mlp_extractor.policy_net[0].weight
    with torch.no_grad():
        first_layer[:, :-13] = 0
        first_layer[:, -1] = 0
    optimizer = torch.optim.Adam(policy.parameters(), lr=0.002)
    ordering = torch.Generator().manual_seed(SEED)
    for _ in range(101):
        for batch in torch.randperm(len(inputs), generator=ordering).split(512):
            action = policy._predict(inputs[batch], deterministic=True)
            loss = (labels[batch] - action).square().mean()
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
    model.save(checkpoint)
    return len(inputs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    bundle = args.bundle.absolute()
    bundle_info = validate_bundle(bundle)
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(1)
    config = validate_dance_config({
        "schemaVersion": 1, "title": "Mixed choreography acceptance", "bpm": BPM,
        "seed": SEED, "trainingSteps": PPO_STEPS,
        "sections": [{"type": motif, "beats": 8, "intensity": 0.65} for motif in MOTIFS],
    })
    env = DeepSquatRehearsal(bundle, config)
    sample_count = initialize_policy(env, output / "initialized.zip")
    vector = DummyVecEnv([
        lambda: DeepSquatRehearsal(bundle, config, training=True) for _ in range(4)
    ])
    try:
        model = PPO.load(output / "initialized.zip", env=vector, device="cpu",
                         n_steps=256, batch_size=128, n_epochs=4,
                         learning_rate=1e-5, clip_range=0.1, seed=SEED)
        with torch.no_grad():
            model.policy.log_std.fill_(-2.5)
        model.learn(total_timesteps=PPO_STEPS)
        model.save(output / "final.zip")
        policy_path = output / "policy.onnx"
        policy_sha = write_onnx(output / "final.zip", policy_path, env.observation_space.shape[0])
        session = onnxruntime.InferenceSession(policy_path, providers=["CPUExecutionProvider"])

        def infer(observation):
            return session.run(["action"], {"observation": observation[None]})[0][0]

        tempos = (round(0.95 * BPM, 6), BPM, round(1.05 * BPM, 6))
        evaluations = [evaluate(env, infer, tempo, trace=(tempo == BPM)) for tempo in tempos]
        nominal = evaluations[1]
        replay = output / "dance-replay.npz"
        np.savez_compressed(replay, qpos=nominal.pop("qpos"), bpm=BPM)
        nominal.pop("frameMetrics")
        passed = all(row["allSectionsPassed"] for row in evaluations)
        report = {
            "method": "MuJoCo trajectory optimization, supervised distillation, and PPO fine-tuning",
            "physicsBackend": "cpu-mujoco", "trainingDevice": str(model.device),
            "trainedSteps": model.num_timesteps, "demonstrationSamples": sample_count,
            "hardwareEligible": False, "deployable": False, "danceConfig": config,
            "contract": {
                "observationSize": env.observation_space.shape[0],
                "observationAdapterId": env.observation_adapter_id,
                "actionAdapterId": env.action_adapter_id, "actionSize": len(env.names),
                "actionJoints": env.names, "actionScaleRadians": env.scale.tolist(),
            },
            "sceneSha256": bundle_info["sceneSha256"], "policySha256": policy_sha,
            "replaySha256": hashlib.sha256(replay.read_bytes()).hexdigest(),
            "qualityGatePassed": passed, "evaluations": evaluations,
        }
        (output / "evaluation.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        print(f"Mixed choreography gate {'PASS' if passed else 'FAIL'}: {output / 'evaluation.json'}")
        return 0 if passed else 1
    finally:
        vector.close()
        env.close()


if __name__ == "__main__":
    raise SystemExit(main())
