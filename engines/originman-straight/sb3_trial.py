"""Independent PPO and two-dimensional foot-correction fallback trials.

Four observation frames, independent actor/critic MLPs and VecNormalize are
explicit changes from the hand-written PPO. Neither force nor simulator XY
enters the actor. Normalization and the foot basis are exported separately.
"""

import argparse
import json
import time
from dataclasses import asdict
from pathlib import Path

import gymnasium
import numpy as np
import stable_baselines3 as sb3
import torch
from env import Config
from gym_bridge import OriginManGym
from monitor import RunRecorder, digest, seal_run, write_json
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.env_checker import check_env
from stable_baselines3.common.monitor import Monitor
from stable_baselines3.common.vec_env import DummyVecEnv, VecFrameStack, VecNormalize


class Predictor:
    def __init__(self, model, normalizer, frames=4):
        self.model, self.normalizer = model, normalizer
        self.history = np.zeros(
            (frames, model.observation_space.shape[0] // frames), dtype=np.float32
        )

    def __call__(self, observation):
        self.history[:-1] = self.history[1:].copy()
        self.history[-1] = self.normalizer.normalize_obs(observation)
        action, _ = self.model.predict(self.history.reshape(-1), deterministic=True)
        return np.clip(action, -1, 1)


class Recorder(BaseCallback):
    def __init__(self, rec, normalizer, physical, total):
        super().__init__()
        self.rec, self.normalizer, self.physical, self.total = (
            rec,
            normalizer,
            physical,
            total,
        )
        self.start = time.monotonic()
        self.iteration = 0
        self.raw_rewards = []
        self.completed = []
        self.next_checkpoint = 100_000
        self.log = (rec.out / "telemetry.jsonl").open("w")
        self.episodes = (rec.out / "episodes.jsonl").open("w")

    def _on_step(self):
        infos = self.locals["infos"]
        for i, info in enumerate(infos):
            self.raw_rewards.append(info["reward"])
            if self.locals["dones"][i]:
                row = {
                    k: info[k]
                    for k in ["x", "y", "yaw", "fallen", "time", "footContacts"]
                }
                row.update(
                    steps=self.num_timesteps, environment=i, episode=info.get("episode")
                )
                for key in ["recoverySuccess", "settledFraction", "tiltDegrees"]:
                    if key in info:
                        row[key] = info[key]
                if "recoverySuccess" in info:
                    self.completed.append(bool(info["recoverySuccess"]))
                    self.completed = self.completed[-100:]
                self.episodes.write(json.dumps(row, allow_nan=False) + "\n")
                self.episodes.flush()
        if self.n_calls % 1000 == 0 and not self.locals["dones"][0]:
            self.rec.trace(
                self.num_timesteps,
                [{**infos[0], **self.physical[0].physical.diagnostic_frame()}],
            )
        if self.num_timesteps >= self.next_checkpoint:
            stem = self.rec.out / "checkpoints" / f"policy-{self.num_timesteps:08d}"
            self.model.save(stem)
            self.normalizer.save(str(stem) + "-normalization.pkl")
            self.rec.emit(
                "checkpoint",
                {"timesteps": self.num_timesteps, "file": stem.name + ".zip"},
            )
            self.next_checkpoint += 100_000
        return True

    def _on_rollout_end(self):
        self.iteration += 1
        point = {
            "iteration": self.iteration,
            "timesteps": self.num_timesteps,
            "meanReward": float(np.mean(self.raw_rewards)),
            "elapsedSeconds": time.monotonic() - self.start,
            "losses": {
                k: float(v)
                for k, v in self.model.logger.name_to_value.items()
                if k.startswith("train/")
                and isinstance(v, (int, float, np.number))
                and np.isfinite(v)
            },
        }
        self.raw_rewards.clear()
        if self.completed:
            point["recentRecoveryFraction"] = float(np.mean(self.completed))
        self.log.write(json.dumps(point, allow_nan=False) + "\n")
        self.log.flush()
        self.rec.status(
            "training",
            iteration=self.iteration,
            timesteps=self.num_timesteps,
            latest=point,
        )
        if self.iteration == 1 or self.iteration % 10 == 0:
            print(
                f"[originman-sb3] iter {self.iteration} steps={self.num_timesteps}/{self.total} reward={point['meanReward']:.4f} elapsed={point['elapsedSeconds']:.1f}s",
                flush=True,
            )

    def close(self):
        self.log.close()
        self.episodes.close()


def export_policy(model, normalizer, out, action_size):
    class Actor(torch.nn.Module):
        def __init__(self, policy):
            super().__init__()
            self.policy = policy

        def forward(self, observations):
            features = self.policy.pi_features_extractor(observations)
            latent = self.policy.mlp_extractor.forward_actor(features)
            return self.policy.action_net(latent).clamp(-1, 1)

    actor = Actor(model.policy).eval()
    sample = np.random.default_rng(728).normal(0, 0.5, (32, 164)).astype(np.float32)
    with torch.no_grad():
        expected = actor(torch.from_numpy(sample)).numpy()
    actual = model.predict(sample, deterministic=True)[0]
    if np.max(abs(expected - actual)) > 1e-6:
        raise RuntimeError("actor export does not match SB3 predict")
    torch.onnx.export(
        actor,
        torch.zeros(1, 164),
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
        raise RuntimeError("ONNX parity failed")
    write_json(
        out / "normalization.json",
        {
            "mean": normalizer.obs_rms.mean.tolist(),
            "variance": normalizer.obs_rms.var.tolist(),
            "epsilon": normalizer.epsilon,
            "clipObservation": normalizer.clip_obs,
            "frames": 4,
            "initialHistory": "three normalized zero frames followed by current normalized observation",
            "rawObservationSize": 41,
            "normalizedHistorySize": 164,
            "actionSize": action_size,
            "hardwareEligible": False,
        },
    )
    return error


def train(
    scene,
    out,
    experiment,
    mode,
    total,
    seed,
    env_class=OriginManGym,
    callback_class=Recorder,
    task="disturbed-walking",
    action_scope=None,
):
    cfg = Config(**experiment["environment"])
    identity = {
        "environment": asdict(cfg),
        "training": {
            "implementation": "stable-baselines3",
            "task": task,
            "algorithm": "PPO",
            "mode": mode,
            "totalTimesteps": total,
            "seed": seed,
            "frames": 4,
            "numEnvs": 8,
            "rolloutSteps": 128,
            "batchSize": 256,
            "epochs": 5,
            "learningRate": 0.0003,
            "gamma": 0.995,
            "gaeLambda": 0.97,
            "targetKl": 0.02,
            "observationNormalization": True,
            "rewardNormalization": True,
            "actorHidden": [128, 128],
            "criticHidden": [128, 128],
            "initialLogStd": -2.0 if mode == "joints" else -1.0,
            "versions": {
                "sb3": sb3.__version__,
                "gymnasium": gymnasium.__version__,
                "torch": torch.__version__,
            },
        },
    }
    rec = RunRecorder(out, scene, identity)
    recorder = None
    stacked = None
    try:
        first = env_class(rec.scene, cfg, mode=mode, seed=seed)
        check_env(first, warn=True)
        physical = [first] + [
            env_class(
                rec.scene,
                cfg,
                mode=mode,
                seed=seed + i,
                reference=first.physical.reference,
            )
            for i in range(1, 8)
        ]
        (out / "checkpoints").mkdir(exist_ok=True)
        np.save(out / "reference.npy", first.physical.reference)
        if first.modes:
            np.save(out / "foot-basis.npy", first.modes.basis)
        vector = DummyVecEnv([lambda e=e: Monitor(e) for e in physical])
        normalizer = VecNormalize(
            vector,
            norm_obs=True,
            norm_reward=True,
            gamma=0.995,
            clip_obs=10,
            clip_reward=10,
        )
        stacked = VecFrameStack(normalizer, n_stack=4)
        model = sb3.PPO(
            "MlpPolicy",
            stacked,
            seed=seed,
            device="cpu",
            n_steps=128,
            batch_size=256,
            n_epochs=5,
            learning_rate=0.0003,
            gamma=0.995,
            gae_lambda=0.97,
            clip_range=0.2,
            ent_coef=0.001,
            vf_coef=0.5,
            max_grad_norm=0.5,
            target_kl=0.02,
            policy_kwargs={
                "net_arch": {"pi": [128, 128], "vf": [128, 128]},
                "activation_fn": torch.nn.Tanh,
                "log_std_init": -2.0 if mode == "joints" else -1.0,
            },
            verbose=0,
        )
        initial = out / "initial"
        initial.mkdir()
        model.save(initial / "policy.zip")
        normalizer.save(initial / "normalization.pkl")
        export_policy(model, normalizer, initial, first.action_space.shape[0])
        recorder = callback_class(rec, normalizer, physical, total)
        rec.status("training", timesteps=0)
        model.learn(total_timesteps=total, callback=recorder)
        model.save(out / "policy.zip")
        normalizer.save(out / "normalization.pkl")
        error = export_policy(model, normalizer, out, first.action_space.shape[0])
        summary = {
            "mode": mode,
            "seed": seed,
            "config": asdict(cfg),
            "actualTimesteps": model.num_timesteps,
            "onnxParityMaxAbsError": error,
            "hardwareEligible": False,
            "sourceChangedDuringRun": any(
                digest(Path(__file__).parent / f) != h
                for f, h in rec.identity["sourceSha256"].items()
                if f != "reused-actor.py"
            ),
            "actorInputs": "four normalized frames of original proprioceptive observation; no force or simulator XY",
            "task": task,
            "actionScope": action_scope
            or (
                "10 joint residuals"
                if mode == "joints"
                else "2 foot correction modes mapped to 10 joint residuals using source-model Jacobians"
            ),
        }
        write_json(out / "training-summary.json", summary)
        rec.status("completed", timesteps=model.num_timesteps)
        rec.emit("completed", summary)
        print(json.dumps(summary), flush=True)
    except BaseException:
        rec.fail()
        raise
    finally:
        if recorder:
            recorder.close()
        if stacked:
            stacked.close()
        rec.close()
        seal_run(out)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--experiment", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--mode", choices=["joints", "feet"], required=True)
    p.add_argument("--steps", type=int, default=1_000_000)
    p.add_argument("--seed", type=int, default=7)
    a = p.parse_args()
    torch.set_num_threads(1)
    train(a.scene, a.out, json.loads(a.experiment.read_text()), a.mode, a.steps, a.seed)
