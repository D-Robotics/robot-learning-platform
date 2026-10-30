"""Independent off-policy SAC recovery trial with one normalized proprioceptive frame."""

import argparse
import json
from dataclasses import asdict
from pathlib import Path

import numpy as np
import stable_baselines3 as sb3
import torch
from env import Config
from monitor import RunRecorder, digest, seal_run, write_json
from sb3_evaluate import ArtifactPolicy
from sb3_trial import Predictor, Recorder
from stable_baselines3.common.env_checker import check_env
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize
from standing_env import CRITERIA, StandingGym, episode
from standing_linear_env import RollRateGym
from standing_trial import DEV_CASES


def export(model, normalizer, out):
    class Actor(torch.nn.Module):
        def __init__(self, actor):
            super().__init__()
            self.actor = actor

        def forward(self, observations):
            features = self.actor.extract_features(
                observations, self.actor.features_extractor
            )
            return torch.tanh(self.actor.mu(self.actor.latent_pi(features)))

    actor = Actor(model.actor).eval()
    size = model.observation_space.shape[0]
    sample = np.random.default_rng(729).normal(0, 0.5, (32, size)).astype(np.float32)
    expected = model.predict(sample, deterministic=True)[0]
    with torch.no_grad():
        error = float(np.max(abs(actor(torch.from_numpy(sample)).numpy() - expected)))
    if error > 1e-6:
        raise RuntimeError("SAC deterministic actor mismatch")
    torch.onnx.export(
        actor,
        torch.zeros(1, size),
        str(out / "policy.onnx"),
        input_names=["normalized_history"],
        output_names=["actions"],
        dynamic_axes={"normalized_history": {0: "batch"}, "actions": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    import onnxruntime as ort

    session = ort.InferenceSession(
        str(out / "policy.onnx"), providers=["CPUExecutionProvider"]
    )
    error = float(
        np.max(abs(expected - session.run(None, {"normalized_history": sample})[0]))
    )
    if error > 1e-5:
        raise RuntimeError("SAC ONNX parity failure")
    write_json(
        out / "normalization.json",
        {
            "mean": normalizer.obs_rms.mean.tolist()
            if normalizer.norm_obs
            else [0.0] * size,
            "variance": normalizer.obs_rms.var.tolist()
            if normalizer.norm_obs
            else [1.0] * size,
            "epsilon": normalizer.epsilon if normalizer.norm_obs else 0.0,
            "clipObservation": normalizer.clip_obs if normalizer.norm_obs else 1e6,
            "frames": 1,
            "initialHistory": "current normalized observation only",
            "rawObservationSize": size,
            "normalizedHistorySize": size,
            "actionSize": 2,
            "hardwareEligible": False,
        },
    )
    return error


class SacRecorder(Recorder):
    def __init__(self, rec, normalizer, physical, total):
        super().__init__(rec, normalizer, physical, total)
        self.bridge = type(physical[0])(rec.scene, physical[0].physical.config)
        self.next_validation = 50_000
        (rec.out / "validation").mkdir()
        write_json(rec.out / "standing-criteria.json", CRITERIA)
        self.reference = [
            episode(self.bridge, c, lambda obs: np.zeros(2), trace=True)
            for c in DEV_CASES
        ]

    def validation(self, steps, initial=False):
        rows = []
        for case in DEV_CASES:
            actor = (
                ArtifactPolicy(self.rec.out / "initial")
                if initial
                else Predictor(self.model, self.normalizer, frames=1)
            )
            rows.append(episode(self.bridge, case, actor, trace=True))
        payload = {
            "timesteps": steps,
            "scope": "development only; final weights are not selected by these cases",
            "reference": self.reference,
            "rl": rows,
            "referenceSuccesses": sum(r["recoverySuccess"] for r in self.reference),
            "rlSuccesses": sum(r["recoverySuccess"] for r in rows),
        }
        if self.model.observation_space.shape[0] == 2:
            weight = self.model.actor.mu.weight.detach().cpu().numpy()
            payload["learnedFeedback"] = {
                "weights": weight.tolist(),
                "smallSignalGains": (
                    self.bridge.physical.config.residual_scale
                    * weight
                    / RollRateGym.scales
                ).tolist(),
            }
        write_json(self.rec.out / "validation" / f"standing-{steps:08d}.json", payload)
        self.rec.emit(
            "standing-validation",
            {k: v for k, v in payload.items() if k not in ["reference", "rl"]},
        )
        print(
            f"[standing-sac-validation] {steps} steps reference={payload['referenceSuccesses']}/9 RL={payload['rlSuccesses']}/9",
            flush=True,
        )

    def _on_training_start(self):
        self.validation(0, initial=True)

    def _on_rollout_end(self):
        super()._on_rollout_end()
        if self.num_timesteps >= self.next_validation:
            self.validation(self.num_timesteps)
            self.next_validation += 50_000


def train(
    scene,
    experiment,
    out,
    total,
    seed,
    linear=False,
    env_class_override=None,
    entropy_coef=None,
    initial_mean_zero=False,
    task_parameters=None,
    actor_inputs=None,
    action_scope=None,
):
    cfg = Config(**experiment["environment"])
    if cfg.recovery_roll_threshold:
        raise ValueError("SAC ablation requires continuous feedback")
    env_class = env_class_override or (RollRateGym if linear else StandingGym)
    architecture = {"pi": [], "qf": [64, 64]} if linear else [64, 64]
    entropy = (
        entropy_coef if entropy_coef is not None else (0.001 if linear else "auto_0.1")
    )
    identity = {
        "environment": asdict(cfg),
        "training": {
            "implementation": "stable-baselines3",
            "algorithm": "SAC",
            "sb3Version": sb3.__version__,
            "task": "stationary-disturbance-recovery",
            "mode": "roll",
            "seed": seed,
            "totalTimesteps": total,
            "frames": 1,
            "numEnvs": 4,
            "learningStarts": 5000,
            "bufferSize": 200000,
            "batchSize": 256,
            "trainFreqVectorSteps": 64,
            "gradientSteps": 64,
            "learningRate": 0.0003,
            "gamma": 0.99,
            "entropyCoefficient": entropy,
            "network": architecture,
            "linearRollRatePolicy": linear,
            "observationNormalization": not (linear or initial_mean_zero),
            "actorBiasFrozen": linear,
            "initialLogStd": -3 if initial_mean_zero else -2,
            "taskParameters": task_parameters,
            "initialMeanZero": initial_mean_zero,
        },
    }
    rec = RunRecorder(out, scene, identity)
    callback, vector = None, None
    try:
        if task_parameters:
            write_json(out / "controller.json", task_parameters)
        first = env_class(rec.scene, cfg, seed=seed)
        check_env(first, warn=True)
        physical = [first] + [
            env_class(rec.scene, cfg, seed=seed + i, reference=first.physical.reference)
            for i in range(1, 4)
        ]
        np.save(out / "reference.npy", first.physical.reference)
        np.save(out / "foot-basis.npy", first.modes.basis)
        (out / "checkpoints").mkdir(exist_ok=True)
        vector = VecNormalize(
            DummyVecEnv([lambda e=e: Monitor(e) for e in physical]),
            norm_obs=not (linear or initial_mean_zero),
            norm_reward=True,
            gamma=0.99,
            clip_obs=10,
        )
        model = sb3.SAC(
            "MlpPolicy",
            vector,
            seed=seed,
            device="cpu",
            buffer_size=200000,
            learning_starts=5000,
            batch_size=256,
            train_freq=64,
            gradient_steps=64,
            learning_rate=0.0003,
            gamma=0.99,
            ent_coef=entropy,
            policy_kwargs={"net_arch": architecture, "log_std_init": -2},
            verbose=0,
        )
        # Non-SDE SAC uses a learned log-std layer; set its actual initial values.
        torch.nn.init.zeros_(model.actor.log_std.weight)
        torch.nn.init.constant_(model.actor.log_std.bias, -2.0)
        if linear:
            torch.nn.init.zeros_(model.actor.mu.weight)
            torch.nn.init.zeros_(model.actor.mu.bias)
            model.actor.mu.bias.requires_grad_(False)
        elif initial_mean_zero:
            torch.nn.init.zeros_(model.actor.mu.weight)
            torch.nn.init.zeros_(model.actor.mu.bias)
            torch.nn.init.constant_(model.actor.log_std.bias, -3.0)
        initial = out / "initial"
        initial.mkdir()
        model.save(initial / "policy.zip")
        vector.save(initial / "normalization.pkl")
        export(model, vector, initial)
        callback = SacRecorder(rec, vector, physical, total)
        rec.status("training", timesteps=0)
        model.learn(total_timesteps=total, callback=callback)
        model.save(out / "policy.zip")
        model.save_replay_buffer(out / "replay-buffer.pkl")
        vector.save(out / "normalization.pkl")
        parity = export(model, vector, out)
        summary = {
            "mode": "roll",
            "algorithm": "SAC",
            "seed": seed,
            "config": asdict(cfg),
            "actualTimesteps": model.num_timesteps,
            "gradientUpdates": model._n_updates,
            "onnxParityMaxAbsError": parity,
            "hardwareEligible": False,
            "task": "stationary-disturbance-recovery",
            "linearRollRatePolicy": linear,
            "actorInputs": actor_inputs
            or (
                "roll/0.2 and gyroX/2; fixed scaling, no force, position, phase or reference trajectory"
                if linear
                else "one normalized original proprioceptive frame; no force or simulator XY"
            ),
            "actionScope": action_scope or "50Hz ankle/hip physical roll residuals",
            "taskParameters": task_parameters,
            "sourceChangedDuringRun": any(
                digest(Path(__file__).parent / f) != h
                for f, h in rec.identity["sourceSha256"].items()
                if f != "reused-actor.py"
            ),
        }
        if linear:
            weight = model.actor.mu.weight.detach().cpu().numpy()
            summary["learnedFeedback"] = {
                "weights": weight.tolist(),
                "bias": model.actor.mu.bias.detach().cpu().tolist(),
                "equation": "physical ankle/hip target residual = 0.3 * tanh(W @ [roll/0.2, gyroX/2]); identical actuator and slew limits",
                "smallSignalGains": (
                    cfg.residual_scale * weight / RollRateGym.scales
                ).tolist(),
                "initialWeights": "all zero; no teacher parameters or labels",
            }
        write_json(out / "training-summary.json", summary)
        rec.status("completed", timesteps=model.num_timesteps)
        rec.emit("completed", summary)
        print(json.dumps(summary), flush=True)
    except BaseException:
        rec.fail()
        raise
    finally:
        if callback:
            callback.close()
        if vector:
            vector.close()
        rec.close()
        seal_run(out)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--experiment", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--steps", type=int, default=250000)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--linear", action="store_true")
    a = p.parse_args()
    torch.set_num_threads(1)
    train(
        a.scene,
        json.loads(a.experiment.read_text()),
        a.out,
        a.steps,
        a.seed,
        linear=a.linear,
    )
