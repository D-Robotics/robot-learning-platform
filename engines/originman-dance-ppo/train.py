#!/usr/bin/env python3
"""Train and evaluate one bounded OriginMan dance specification."""

from __future__ import annotations

import json
import hashlib
import math
import importlib.metadata
import platform
import time
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import SubprocVecEnv

from body import DT
from dance_env import ConfigurableChoreography


class WorkerProgress(BaseCallback):
    def __init__(self, total_timesteps, rollout_size):
        super().__init__()
        self.total_iterations = max(1, math.ceil(total_timesteps / rollout_size))
        self.rollout_size = rollout_size
        self.started = time.monotonic()
        self.episode_successes = []

    def _on_step(self):
        for info in self.locals.get("infos", []):
            if info.get("episodeDone"):
                self.episode_successes.append(float(info.get("taskSuccess", False)))
        return True

    def _on_rollout_end(self):
        rewards = self.locals.get("rollout_buffer").rewards
        mean_reward = float(np.mean(rewards)) if rewards is not None else 0.0
        recent_success = float(np.mean(self.episode_successes[-50:])) if self.episode_successes else 0.0
        iteration = min(self.total_iterations, max(1, math.ceil(self.model.num_timesteps / self.rollout_size)))
        print(
            f"[{ENGINE_ID}] iter {iteration}/{self.total_iterations} meanReward={mean_reward:.5f} "
            f"recentSuccess={recent_success:.4f} elapsed={time.monotonic() - self.started:.1f}s",
            flush=True,
        )


ENGINE_ID = "originman-dance-ppo"


def _json_default(value):
    # 评测字典会混进 numpy 标量/数组（如 np.int64、float32 帧）；标准 json
    # 只认内置类型，没有这个兜底时一次类型不匹配就会把整轮训练判成失败。
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _corr(left, right):
    if len(left) < 3 or np.std(left) < 1e-8 or np.std(right) < 1e-8:
        return 0.0
    return float(np.corrcoef(left, right)[0, 1])


def evaluate(env, actor, bpm, *, trace=False):
    obs, _ = env.reset(options={"bpm": bpm})
    rows = []
    frames = [env.data.qpos.copy()]
    total_reward = 0.0
    while True:
        action = actor(obs)
        obs, reward, failed, complete, info = env.step(action)
        total_reward += reward
        rows.append(info)
        if trace:
            frames.append(env.data.qpos.copy())
        if failed or complete:
            break

    sections = []
    for index, spec in enumerate(env.sections):
        batch = [row for row in rows if row["section"] == index]
        expected_steps = spec["beats"] * 60.0 / bpm / DT
        clean = len(batch) >= 0.95 * expected_steps and not any(row["fallContacts"] for row in batch)
        value = lambda key: np.asarray([row[key] for row in batch], dtype=float)
        if not batch:
            metrics, passes = {}, False
        elif spec["type"] == "alternating-arms":
            asymmetry = value("handAsymmetryM")
            speed = value("armSpeed")
            direction = np.cos(np.pi * value("sectionBeat"))
            metrics = {
                "armAsymmetryRangeM": float(np.ptp(asymmetry)),
                "alternatingArmFraction": float(np.mean(direction * asymmetry > 0.015)),
                "armBeatCorrelation": _corr(speed, value("pulse")),
            }
            passes = (
                metrics["armAsymmetryRangeM"] >= 0.09
                and metrics["alternatingArmFraction"] >= 0.65
                and metrics["armBeatCorrelation"] >= 0.20
            )
        elif spec["type"] == "weight-shift":
            lateral = value("lateralM")
            slow = value("slow")
            metrics = {
                "lateralRangeM": float(np.ptp(lateral)),
                "lateralTrackingFraction": float(np.mean(slow * lateral > 0.006)),
            }
            passes = metrics["lateralRangeM"] >= 0.035 and metrics["lateralTrackingFraction"] >= 0.62
        elif spec["type"] == "squat-rise":
            height, slow = value("heightM"), value("slow")
            arm_forward = value("armForwardM")
            metrics = {
                "heightRangeM": float(np.ptp(height)),
                "riseAndDipCorrelation": _corr(height, slow),
                "armSweepM": float(np.ptp(arm_forward)),
            }
            passes = (
                metrics["heightRangeM"] >= 0.024
                and metrics["riseAndDipCorrelation"] >= 0.55
                and metrics["armSweepM"] >= 0.06
            )
        else:
            hold = [row for row in batch if row["sectionProgress"] >= 0.75]
            still = float(np.mean([row["armSpeed"] + row["legSpeed"] < 0.26 for row in hold])) if hold else 0.0
            span = float(np.mean([row["handSpanM"] for row in hold])) if hold else 0.0
            peak_tilt = max((row["tiltDeg"] for row in hold), default=999.0)
            metrics = {"holdStillFraction": still, "meanHoldHandSpanM": span, "holdPeakTiltDeg": peak_tilt}
            passes = still >= 0.83 and span >= 0.32 and peak_tilt < 9.0
        sections.append(
            {
                "index": index,
                "type": spec["type"],
                "beats": spec["beats"],
                "clean": bool(clean),
                "stylePassed": bool(passes),
                "passed": bool(clean and passes),
                **metrics,
            }
        )
    report = {
        "bpm": float(bpm),
        "completed": bool(complete),
        "failed": bool(failed),
        "reward": float(total_reward),
        "sectionResults": sections,
        "allSectionsPassed": bool(complete and sections and all(row["passed"] for row in sections)),
        "maxTiltDeg": float(max((row["tiltDeg"] for row in rows), default=0.0)),
        "fallContacts": rows[-1]["fallContacts"] if rows else [],
        "steps": len(rows),
    }
    if trace:
        report["qpos"] = np.asarray(frames, dtype=np.float32)
        report["frameMetrics"] = rows
    return report


def train(*, bundle: Path, output: Path, dance_config: dict, num_envs: int):
    dance = ConfigurableChoreography(bundle, dance_config, training=False)
    contract = {
        "observationSize": int(dance.observation_space.shape[0]),
        "actionSize": int(dance.action_space.shape[0]),
        "observationAdapterId": "originman-dance-phase-v1",
        "actionAdapterId": "originman-20d-joint-offset-v1",
        "controlHz": 50,
        "physicsTimestepSeconds": 0.001,
        "decimation": 20,
        "actionJoints": list(dance.names),
    }
    torch.set_num_threads(1)
    env_fns = [
        (lambda rank=rank: ConfigurableChoreography(bundle, dance_config, training=True))
        for rank in range(num_envs)
    ]
    vector = SubprocVecEnv(env_fns, start_method="fork") if num_envs > 1 else None
    train_env = vector or env_fns[0]()
    started = time.monotonic()
    total_timesteps = dance_config["trainingSteps"]
    rollout_size = num_envs * 256
    callback = WorkerProgress(total_timesteps, rollout_size)
    model = PPO(
        "MlpPolicy",
        train_env,
        device="auto",
        seed=dance_config["seed"],
        n_steps=256,
        batch_size=128,
        n_epochs=4,
        learning_rate=3e-4,
        gamma=0.99,
        gae_lambda=0.95,
        ent_coef=0.001,
        policy_kwargs={"net_arch": [160, 160], "log_std_init": -1.1},
        verbose=0,
    )
    try:
        model.learn(total_timesteps=total_timesteps, callback=callback, progress_bar=False)
        model.save(output / "final")
        bpms = sorted(
            {
                max(80.0, dance_config["bpm"] * 0.95),
                dance_config["bpm"],
                min(140.0, dance_config["bpm"] * 1.05),
            }
        )
        evaluations = [
            evaluate(
                dance,
                lambda obs: model.predict(obs, deterministic=True)[0],
                bpm,
                trace=(index == 1),
            )
            for index, bpm in enumerate(bpms)
        ]
        # trace 落在 enumerate 的 index==1 上，但 bpms 经 80/140 钳位去重后
        # 配置 BPM 不一定还在 index 1；按“谁带 qpos 谁是 trace”取，避免
        # ndarray 残留进 evaluation.json 导致序列化崩溃。
        trace = next((item for item in evaluations if "qpos" in item), evaluations[-1] if evaluations else {})
        replay = None
        if "qpos" in trace:
            replay_path = output / "dance-replay.npz"
            np.savez_compressed(replay_path, qpos=trace.pop("qpos"), bpm=trace["bpm"])
            replay = {
                "file": replay_path.name,
                "sha256": hashlib.sha256(replay_path.read_bytes()).hexdigest(),
                "sizeBytes": replay_path.stat().st_size,
            }
        report = {
            "schemaVersion": 1,
            "taskId": "originman-dance",
            "engine": "originman-dance-ppo",
            "contract": contract,
            "danceConfig": dance_config,
            "requestedTrainingSteps": dance_config["trainingSteps"],
            "trainedSteps": int(model.num_timesteps),
            "rolloutIterations": int(math.ceil(model.num_timesteps / rollout_size)),
            "optimizerSteps": int(
                math.ceil(model.num_timesteps / rollout_size)
                * model.n_epochs
                * math.ceil(rollout_size / model.batch_size)
            ),
            "trainingSeconds": time.monotonic() - started,
            "trainingDevice": str(model.device),
            "trainingDeviceName": (
                torch.cuda.get_device_name(model.device)
                if model.device.type == "cuda"
                else "cpu"
            ),
            "runtimeVersions": {
                "python": platform.python_version(),
                "numpy": importlib.metadata.version("numpy"),
                "scipy": importlib.metadata.version("scipy"),
                "mujoco": importlib.metadata.version("mujoco"),
                "gymnasium": importlib.metadata.version("gymnasium"),
                "stableBaselines3": importlib.metadata.version("stable-baselines3"),
                "torch": importlib.metadata.version("torch"),
                "onnx": importlib.metadata.version("onnx"),
            },
            "evaluations": evaluations,
            "replay": replay,
            "qualityGate": {
                "passed": bool(evaluations and all(item["allSectionsPassed"] for item in evaluations)),
                "criteria": "every configured section passes its style and fall-free completion checks at all three BPMs",
            },
            "physicsBackend": "cpu-mujoco",
            "hardwareEligible": False,
            "deployable": False,
            "demonstrations": 0,
        }
        (output / "evaluation.json").write_text(
            json.dumps(report, indent=2, allow_nan=False, default=_json_default) + "\n"
        )
        return report
    finally:
        if vector is not None:
            vector.close()
        else:
            train_env.close()

