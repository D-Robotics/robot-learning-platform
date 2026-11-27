#!/usr/bin/env python3
"""Train and evaluate one bounded OriginMan dance specification."""

from __future__ import annotations

import json
import hashlib
import math
import importlib.metadata
import multiprocessing
import platform
import time
from collections import Counter, deque
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import SubprocVecEnv

from body import DT
from calibrated_motions import MESH_SCENE
from choreography_reference import (
    CALIBRATED_SCENES, CALIBRATED_SECTIONS, ReferenceControl, ResidualChoreography,
)
from dance_env import (
    ConfigurableChoreography, FOOT_SECTION_TYPES, TRACKED_SECTION_TYPES, squat_rise_phase,
)


def _json_default(value):
    # ndarray/numpy scalars must never abort a finished training run.
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, (np.integer, np.floating)):
        return value.item()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def resolve_training_device(requested: str) -> str:
    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested not in {"cpu", "cuda", "mps"}:
        raise ValueError("RDK_ORIGINMAN_DANCE_DEVICE must be auto, cpu, cuda, or mps")
    if requested == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA was requested but is unavailable in this Worker")
    if requested == "mps" and not torch.backends.mps.is_available():
        raise ValueError("Apple MPS was requested but is unavailable in this Worker")
    return requested


class WorkerProgress(BaseCallback):
    termination_reasons = ("contact", "tilt", "height", "travel", "nonfinite", "unknown")

    def __init__(self, total_timesteps, rollout_size, engine="originman-dance-ppo"):
        super().__init__()
        self.total_iterations = max(1, math.ceil(total_timesteps / rollout_size))
        self.rollout_size = rollout_size
        self.engine = engine
        self.started = time.monotonic()
        self.episode_outcomes = deque(maxlen=50)

    def _on_step(self):
        for info in self.locals.get("infos", []):
            if info.get("episodeDone"):
                reason = info.get("episodeEndReason")
                self.episode_outcomes.append(
                    "completed" if info.get("taskSuccess") else
                    reason if reason in self.termination_reasons else "unknown"
                )
        return True

    def _on_rollout_end(self):
        rewards = self.locals.get("rollout_buffer").rewards
        mean_reward = float(np.mean(rewards)) if rewards is not None else 0.0
        episode_counts = Counter(self.episode_outcomes)
        episode_samples = len(self.episode_outcomes)
        completed_episodes = episode_counts["completed"]
        recent_success = completed_episodes / episode_samples if episode_samples else 0.0
        termination_counts = ",".join(str(episode_counts[reason]) for reason in self.termination_reasons)
        iteration = min(self.total_iterations, max(1, math.ceil(self.model.num_timesteps / self.rollout_size)))
        print(
            f"[{self.engine}] iter {iteration}/{self.total_iterations} meanReward={mean_reward:.5f} "
            f"recentSuccess={recent_success:.4f} elapsed={time.monotonic() - self.started:.1f}s "
            f"episodeSamples={episode_samples} episodeCompleted={completed_episodes} "
            f"episodeTermination={termination_counts}",
            flush=True,
        )


ENGINE_ID = "originman-dance-ppo"


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
            height = value("heightM")
            progress = value("sectionProgress")
            target = [squat_rise_phase(point) for point in progress]
            start = height[progress <= 0.20]
            bottom = height[(progress >= 0.40) & (progress <= 0.60)]
            end = height[progress >= 0.80]
            metrics = {
                "heightRangeM": float(np.ptp(height)),
                "riseAndDipCorrelation": _corr(height, target),
                "squatDescentM": float(np.mean(start) - np.mean(bottom)) if start.size and bottom.size else 0.0,
                "squatAscentM": float(np.mean(end) - np.mean(bottom)) if end.size and bottom.size else 0.0,
                "armSweepM": float(np.ptp(value("armForwardM"))),
            }
            passes = (
                min(metrics["squatDescentM"], metrics["squatAscentM"]) >= 0.024
                and metrics["riseAndDipCorrelation"] >= 0.55
                and metrics["armSweepM"] >= 0.06
            )
        elif spec["type"] == "open-pose":
            hold = [row for row in batch if row["sectionProgress"] >= 0.75]
            still = float(np.mean([row["armSpeed"] + row["legSpeed"] < 0.26 for row in hold])) if hold else 0.0
            span = float(np.mean([row["handSpanM"] for row in hold])) if hold else 0.0
            peak_tilt = max((row["tiltDeg"] for row in hold), default=999.0)
            metrics = {"holdStillFraction": still, "meanHoldHandSpanM": span, "holdPeakTiltDeg": peak_tilt}
            passes = still >= 0.83 and span >= 0.32 and peak_tilt < 9.0
        elif spec["type"] in TRACKED_SECTION_TYPES:
            active = [row for row in batch if row["styleActive"]]
            tracking = float(np.mean([row["styleTracking"] for row in active])) if active else 0.0
            metrics = {"activePoseTracking": tracking}
            passes = tracking >= 0.62
            if spec["type"] in FOOT_SECTION_TYPES:
                contact = float(np.mean([row["styleContactMatches"] for row in active])) if active else 0.0
                metrics["activeSupportFraction"] = contact
                passes = passes and contact >= 0.8
        else:
            raise ValueError(f"Unknown dance section: {spec['type']}")
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


def choreography_quality(rows):
    completed = sum(row["completed"] for row in rows)
    passed = [sum(item["passed"] for item in row["sectionResults"]) for row in rows]
    return (all(row["allSectionsPassed"] for row in rows), completed, min(passed), sum(passed))


def train(*, bundle: Path, output: Path, dance_config: dict, num_envs: int,
          environment_class=ConfigurableChoreography, device: str = "auto", scene_sha=None):
    device = resolve_training_device(device)
    if scene_sha is None:
        scene_sha = hashlib.sha256((bundle / "model/scene.xml").read_bytes()).hexdigest()
    phase_v2 = getattr(environment_class, "observation_adapter_id", None) == "originman-dance-phase-v2"
    section_frame = phase_v2 and scene_sha == MESH_SCENE
    dance = environment_class(bundle, dance_config, training=False, section_frame=section_frame)
    contract = {
        "observationSize": int(dance.observation_space.shape[0]),
        "actionSize": int(dance.action_space.shape[0]),
        "observationAdapterId": getattr(dance, "observation_adapter_id", "originman-dance-phase-v1"),
        "actionAdapterId": "originman-20d-joint-offset-v1",
        "controlHz": 50,
        "physicsTimestepSeconds": float(dance.model.opt.timestep),
        "decimation": dance.substeps,
        "actionJoints": list(dance.names),
    }
    torch.set_num_threads(1)
    nominal_bpm = dance_config["bpm"]
    bpms = sorted({max(80.0, nominal_bpm * .95), nominal_bpm, min(140.0, nominal_bpm * 1.05)})
    reference = None
    reference_candidate = None
    zero_action = np.zeros(18, dtype=np.float32)
    if phase_v2 and (section_frame or (
        scene_sha in CALIBRATED_SCENES and all(item["type"] in CALIBRATED_SECTIONS for item in dance.sections)
    )):
        try:
            candidate = ReferenceControl(dance.sections, dance.names, mesh_scene=section_frame)
        except (OSError, ValueError) as error:
            print(json.dumps({"event": "dance-reference-unavailable", "message": str(error)}), flush=True)
        else:
            reference_candidate = [evaluate(dance, lambda obs: candidate.command(obs, zero_action), bpm,
                                            trace=(bpm == nominal_bpm)) for bpm in bpms]
            passed = all(row["allSectionsPassed"] for row in reference_candidate)
            if passed or (section_frame and all(row["completed"] for row in reference_candidate)):
                reference = candidate
                print(json.dumps({"event": "dance-reference-baseline", "bpms": bpms,
                                  "qualityGatePassed": passed}), flush=True)

    def make_training_env():
        env = environment_class(bundle, dance_config, training=True, section_frame=section_frame)
        return ResidualChoreography(env, reference) if reference is not None else env

    env_fns = [make_training_env] * num_envs
    start_method = multiprocessing.get_start_method() if device == "cpu" else "spawn"
    vector = SubprocVecEnv(env_fns, start_method=start_method) if num_envs > 1 else None
    train_env = vector or env_fns[0]()
    started = time.monotonic()
    total_timesteps = dance_config["trainingSteps"]
    steps_per_environment = min(256, 4096 // num_envs)
    rollout_size = num_envs * steps_per_environment
    callback = WorkerProgress(total_timesteps, rollout_size)
    try:
        model = PPO(
            "MlpPolicy",
            train_env,
            device=device,
            seed=dance_config["seed"],
            n_steps=steps_per_environment,
            batch_size=128,
            n_epochs=4,
            learning_rate=3e-5 if reference is not None else 3e-4,
            gamma=0.99,
            gae_lambda=0.95,
            ent_coef=0.001,
            policy_kwargs={"net_arch": [160, 160], "log_std_init": -1.1},
            verbose=0,
        )
        # The free-base body is already stable at zero action. Applying the
        # same initial exploration variance to weight-bearing legs and arms
        # makes the legs destabilize the stance before a beat can be learned.
        reference_checkpoint = output / "reference-initialization.zip"
        with torch.no_grad():
            if reference is None:
                model.policy.log_std[dance.legs] = -2.8
            else:
                model.policy.action_net.weight.zero_()
                model.policy.action_net.bias.zero_()
                model.policy.log_std.fill_(-3.5)
        if reference is not None:
            model.save(reference_checkpoint)
        model.learn(total_timesteps=total_timesteps, callback=callback, progress_bar=False)

        def predict(obs):
            action = model.predict(obs, deterministic=True)[0]
            return reference.command(obs, action) if reference is not None else action

        evaluations = [evaluate(dance, predict, bpm, trace=(bpm == nominal_bpm)) for bpm in bpms]
        policy_selection = "ppo"
        if reference is not None and choreography_quality(reference_candidate) > choreography_quality(evaluations):
            evaluations = reference_candidate
            reference_checkpoint.replace(output / "final.zip")
            policy_selection = "reference-baseline"
        else:
            model.save(output / "final")
        reference_checkpoint.unlink(missing_ok=True)
        trace = evaluations[bpms.index(nominal_bpm)]
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
            "selectedCheckpointSteps": int(model.num_timesteps) if policy_selection == "ppo" else 0,
            "policySelection": policy_selection,
            "referenceGuided": reference is not None,
            "sectionFrame": section_frame,
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
                else model.device.type
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
                "criteria": "every section passes style and fall-free completion at every evaluated BPM; squat-rise requires both descent and ascent",
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

