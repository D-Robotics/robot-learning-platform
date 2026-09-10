#!/usr/bin/env python3
"""Real local training engine for the Sim2Real platform.

Two training paths share one PPO core:

* Task-pack goal navigation (the platform's real path): a declarative
  spec embedded in the training request — task JSON (reward, termination,
  curriculum, domain randomization, quality gate) merged with an adapter
  JSON (safety clamps, decision rate, observation layout) — drives a
  vectorized differential-drive environment. Observation layouts mirror
  the board policy runtime exactly (originbot-imu-odom-v1 = 8D
  [x, y, sin, cos, dx, dy, v, w]; imu-gravity-v1 = 42D
  [gyro, gravity, last action, goal delta, twist] zero-padded), so a
  policy trained here loads against the same real-sensor mapping on the
  board. A NEW MACHINE is a new adapter pack, not new engine code.
* Legacy pendulum-chain balancing (kept for the starter demo): an
  N-joint inverted-pendulum chain with plain NumPy dynamics. It is NOT
  the MicroDuck full-body model — it exists so a clean checkout can run
  a genuine observe → train → export → evaluate loop with zero GPU
  hardware, and so an organisation can see exactly where to swap in
  mjlab + rsl-rl (see engines/mjlab-rsl-rl-adapter/).

File protocol (driven by services/sim2real-web/local-training-worker.mjs):
  read   RDK_SIM2REAL_REQUEST_FILE  (schemaVersion 1)
  write  RDK_SIM2REAL_RESULT_FILE   (checkpoint / artifact / metrics)

Side products written next to result.json in the job directory:
  policy.onnx                 exported actor (skipped if the onnx wheel is
                              missing; the run still succeeds and is
                              honestly labeled format=unknown)
  telemetry.jsonl             post-training evaluation rollout
  baseline-telemetry.jsonl    untrained-actor rollout used as the
                              reference trajectory for sim2real gap
                              evaluation
  training-summary.json       budgets, hyperparameters, reward curve
  eval-report.json            goal-navigation only: per-envelope metrics,
                              domain-randomization robustness, quality
                              gate verdict, baseline-vs-trained gap
"""

import json
import math
import os
import sys
import time
from collections import deque

try:
    import numpy as np
except ImportError:  # pragma: no cover - environment guard
    print("starter-ppo engine requires numpy: python3 -m pip install --user numpy", file=sys.stderr)
    sys.exit(2)

try:
    import torch
except ImportError:  # pragma: no cover - environment guard
    print("starter-ppo engine requires torch: python3 -m pip install --user torch", file=sys.stderr)
    sys.exit(2)

try:
    import onnx  # noqa: F401 - presence check for export
    HAVE_ONNX = True
except ImportError:
    HAVE_ONNX = False

ONNX_MISSING_HINT = "python3 -m pip install --user onnx"

# Engine-side budget caps. The platform accepts larger requests (RoboGo
# scale), but this CPU trainer refuses to silently burn hours: it clamps
# to its own budget and records what actually ran in the result.
# Calibration on a laptop CPU: 64 envs reach solid balancing at ~240
# iterations (episode survival 40 -> 390/400 control steps).
PROFILE_BUDGETS = {
    "smoke": {"iterations": 40, "envs": 16, "steps": 128},
    "low-vram": {"iterations": 400, "envs": 32, "steps": 128},
    "standard": {"iterations": 400, "envs": 64, "steps": 128},
    "high-vram": {"iterations": 600, "envs": 128, "steps": 128},
}
PPO_HYPERPARAMS = {
    "gamma": 0.99,
    "gaeLambda": 0.95,
    "clip": 0.2,
    "actorLr": 3e-4,
    "entropyCoef": 0.002,
    "valueCoef": 0.5,
    "epochs": 4,
    "minibatch": 256,
    "maxGradNorm": 0.5,
    "actionScale": 1.5,  # Nm applied per unit action
    # A policy that falls must earn visibly less than one that stands: the
    # fall step is worth about -1 while an alive step is worth about +1, so
    # the value/advantage signal is dominated by survival, not by shaping.
    "fallPenalty": 2.0,
}

JOINT_COUNT = 12
COMMAND_SIZE = 6
COMMAND_HOLD = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0]  # hold-standing command
PHYSICS = {
    # Tuned so the untrained baseline survives ~15 steps and a few hundred
    # PPO iterations reach multi-second balancing on a laptop CPU: a demo
    # policy must visibly learn, or the training loop is meaningless.
    "gravityOverLength": 6.0,
    "damping": 0.25,
    "coupling": 0.10,  # torsional spring between neighbours
    "inertia": 0.5,
    "fallAngleRad": 0.7,
    "initialPerturbationRad": 0.05,
}
EPISODE_CONTROL_STEPS = 400  # 8 s at 50 Hz
EVAL_EPISODES = 8
TORCH_THREADS = 1  # mirror the board's one-thread CPU inference budget


def resolve_device():
    """Pick torch device: explicit override, else CUDA when genuinely usable.

    Returns (device, name, cuda_requested) so the result can report honestly:
    cuda=true only when the training actually ran on the GPU, cuda_requested
    records that the operator asked for it and it was not available.
    """
    requested = (os.environ.get("RDK_STARTER_ENGINE_DEVICE") or "auto").strip().lower()
    if requested in ("cpu", ""):
        return torch.device("cpu"), "cpu", False
    if requested != "auto" and requested != "cuda":
        raise ValueError(
            "RDK_STARTER_ENGINE_DEVICE must be 'auto', 'cuda', or 'cpu' (got {!r})".format(requested)
        )
    cuda_requested = requested == "cuda"
    if requested == "auto" or cuda_requested:
        try:
            if torch.cuda.is_available():
                return torch.device("cuda"), torch.cuda.get_device_name(0), cuda_requested
        except Exception:  # noqa: BLE001 - a broken CUDA build must fall back, not crash
            pass
    if cuda_requested:
        stdout("cuda requested but not available; falling back to cpu")
    return torch.device("cpu"), "cpu", cuda_requested


def clamp_int(value, low, high, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, parsed))


def env_int(name, fallback):
    return clamp_int(os.environ.get(name), 1, 2_000_000, fallback)


def stdout(line):
    print("[starter-ppo] " + line, flush=True)


def safe_slug(value, fallback):
    slug = "".join(ch if (ch.isalnum() or ch in "._-") else "-" for ch in str(value)).strip("-")
    return slug[:48] or fallback


# ---------------------------------------------------------------------------
# Contract-driven observation: [cos(theta) x J, sin(theta) x J, theta_dot x J,
# command x M]. The same layout is declared in the starter manifest, so the
# platform, the trainer, and the evaluator all agree on the meaning of every
# dimension without sharing code.
# ---------------------------------------------------------------------------
class PendulumChain:
    def __init__(self, num_envs, joint_count, command_size, seed):
        self.num_envs = num_envs
        self.joint_count = joint_count
        self.command_size = command_size
        # COMMAND_HOLD is a compact default for the original 6D task.  Pad
        # contract-declared command channels with zeros so arbitrary valid
        # contracts (for example MicroDuck 61D = 42 + 19) keep their exact
        # observation shape instead of silently producing a 48D tensor.
        command = np.zeros(command_size, dtype=np.float32)
        hold = np.asarray(COMMAND_HOLD[:command_size], dtype=np.float32)
        command[: hold.size] = hold
        self.command = np.tile(command, (num_envs, 1))
        self.rng = np.random.default_rng(seed)
        self.observation_size = 3 * joint_count + command_size
        self.action_size = joint_count
        # Per-env episode lengths: staggered limits desynchronize parallel
        # environments so the batched reward/advantage has real cross-env
        # variance instead of every env falling in the same step pattern.
        self.max_steps = self.rng.integers(
            EPISODE_CONTROL_STEPS // 2, EPISODE_CONTROL_STEPS + 1, size=num_envs
        ).astype(np.int64)
        self.reset()

    def reset(self):
        self.theta = self.rng.normal(
            0.0, PHYSICS["initialPerturbationRad"], size=(self.num_envs, self.joint_count)
        ).astype(np.float32)
        self.theta_dot = self.rng.normal(
            0.0, 0.02, size=(self.num_envs, self.joint_count)
        ).astype(np.float32)
        self.steps = np.zeros(self.num_envs, dtype=np.int64)
        return self.observe()

    def observe(self):
        return np.concatenate(
            [np.cos(self.theta), np.sin(self.theta), self.theta_dot, self.command],
            axis=1,
        ).astype(np.float32)

    def is_fallen(self):
        return (np.abs(self.theta) > PHYSICS["fallAngleRad"]).any(axis=1)

    def step(self, action, physics_dt, decimation, auto_reset=True):
        """Advance decimation physics substeps with a held torque.

        auto_reset=True keeps PPO rollouts dense; evaluation passes False so
        per-episode length, return, and fall statistics are real.
        """
        torque = np.clip(action, -1.0, 1.0).astype(np.float32) * PPO_HYPERPARAMS["actionScale"]
        for _ in range(decimation):
            coupled = -PHYSICS["coupling"] * (
                2.0 * self.theta - np.roll(self.theta, 1, axis=1) - np.roll(self.theta, -1, axis=1)
            )
            theta_ddot = (
                PHYSICS["gravityOverLength"] * np.sin(self.theta)
                + coupled
                - PHYSICS["damping"] * self.theta_dot
                + torque
            ) / PHYSICS["inertia"]
            self.theta += self.theta_dot * physics_dt
            self.theta_dot += theta_ddot * physics_dt
            self.theta = (self.theta + math.pi) % (2.0 * math.pi) - math.pi
        self.steps += 1
        fallen = self.is_fallen()
        done = fallen | (self.steps >= self.max_steps)
        # Survival-dominant reward: alive ≈ +1, the falling step ≈ -1. Small
        # posture terms guide learning but never outweigh survival.
        reward = (
            1.0
            - 0.05 * np.mean((self.theta / PHYSICS["fallAngleRad"]) ** 2, axis=1)
            - 0.01 * np.mean(self.theta_dot ** 2, axis=1)
            - 0.01 * np.mean(np.clip(action, -1.0, 1.0) ** 2, axis=1)
            - PPO_HYPERPARAMS["fallPenalty"] * fallen.astype(np.float32)
        ).astype(np.float32)
        obs = self.observe()
        if auto_reset and done.any():
            # Reset only the finished episodes and re-randomize their phase so
            # envs stay desynchronized over training.
            reset_mask = done
            fresh_theta = self.rng.normal(
                0.0, PHYSICS["initialPerturbationRad"], size=(int(reset_mask.sum()), self.joint_count)
            ).astype(np.float32)
            fresh_theta_dot = self.rng.normal(
                0.0, 0.02, size=(int(reset_mask.sum()), self.joint_count)
            ).astype(np.float32)
            self.theta[reset_mask] = fresh_theta
            self.theta_dot[reset_mask] = fresh_theta_dot
            self.steps[reset_mask] = 0
            self.max_steps[reset_mask] = self.rng.integers(
                EPISODE_CONTROL_STEPS // 2, EPISODE_CONTROL_STEPS + 1, size=int(reset_mask.sum())
            )
        return obs, reward, done, fallen


# ---------------------------------------------------------------------------
# Task-pack goal navigation. A declarative spec (tasks/<id>.json merged with
# adapters/<id>.json, embedded in the training request) fully parametrizes
# the environment: reward weights, termination, obstacle workspace, domain
# randomization envelopes, and the curriculum. Observation layouts mirror
# the board policy runtime so the exported ONNX loads against the same
# real-sensor mapping that trained it.
# ---------------------------------------------------------------------------
GOAL_NAV_OBS = {
    # 8D: x, y, sin(yaw), cos(yaw), dx, dy, v, w — identical to the board's
    # native OriginBot layout (board-policy-runtime.py, 8==obs/2==act path).
    "originbot-imu-odom-v1": 8,
    # 42D: [gyro(3), gravity(3), last action(2), goal delta(2), twist(2),
    # zeros(30)] — the board's generic head ([gyro, projected_gravity] real,
    # remaining filled left-to-right) with task extras zero-padded away on
    # hardware exactly as obsSlots reports.
    "imu-gravity-v1": 42,
}
GOAL_NAV_ACTION = 2  # diff-drive: [linear, angular] in normalized units


class DomainParams:
    """Per-episode dynamics randomization for sim2real transfer.

    Values draw once per episode (a robot does not re-gain its motor gain
    mid-episode). Envelope semantics: [min, max] inclusive. The evaluation
    envelopes in the task JSON pin exact values (length-2 with min==max is
    still a range) so eval A/B comparisons are reproducible.
    """

    KEYS = ("motorGain", "lagTau", "gyroNoise", "odomNoise", "angularBias", "latencySteps")

    def __init__(self, motor_gain=1.0, lag_tau=0.1, gyro_noise=0.0, odom_noise=0.0,
                 angular_bias=0.0, latency_steps=0):
        self.motor_gain = motor_gain
        self.lag_tau = lag_tau
        self.gyro_noise = gyro_noise
        self.odom_noise = odom_noise
        self.angular_bias = angular_bias
        self.latency_steps = int(latency_steps)

    @classmethod
    def sample(cls, rng, spec):
        def uniform(key, default=0.0):
            values = (spec or {}).get(key)
            if not values:
                return default
            return float(rng.uniform(values[0], values[1]))
        # Integer latency drawn from its own inclusive range.
        latency = (spec or {}).get("actionLatencySteps") or [0, 0]
        steps = int(rng.integers(int(latency[0]), int(latency[1]) + 1))
        return cls(
            motor_gain=uniform("motorGain", 1.0),
            lag_tau=uniform("lagTauSeconds", 0.05),
            gyro_noise=uniform("gyroNoiseStdRadSec", 0.0),
            odom_noise=uniform("odomNoiseStdM", 0.0),
            angular_bias=uniform("angularBiasRadSec", 0.0),
            latency_steps=steps,
        )

    def as_dict(self):
        return {
            "motorGain": round(self.motor_gain, 4),
            "lagTauSeconds": round(self.lag_tau, 4),
            "gyroNoiseStdRadSec": round(self.gyro_noise, 4),
            "odomNoiseStdM": round(self.odom_noise, 4),
            "angularBiasRadSec": round(self.angular_bias, 4),
            "actionLatencySteps": self.latency_steps,
        }


def eval_domain_params(envelope):
    """Build pinned DomainParams from a task eval envelope (6 numbers).

    Envelope order: [motorGain, lagTauSeconds, gyroNoiseStdRadSec,
    odomNoiseStdM, angularBiasRadSec, actionLatencySteps]. Every value is
    pinned exactly, so envelope A/B comparisons are reproducible.
    """
    motor_gain, lag_tau, gyro_noise, odom_noise, angular_bias, latency = [
        float(value) for value in envelope
    ]
    return DomainParams(
        motor_gain=motor_gain,
        lag_tau=lag_tau,
        gyro_noise=gyro_noise,
        odom_noise=odom_noise,
        angular_bias=angular_bias,
        latency_steps=int(latency),
    )


class GoalNavEnv:
    """Vectorized differential-drive navigation with obstacles.

    Dynamics: unicycle with per-episode motor gain, first-order actuator
    lag, angular velocity bias, action latency (a FIFO of the last N
    commands), gyro/odom observation noise, and circular obstacle
    collisions. The curriculum widens goal distance as the recent
    success rate clears the task's threshold.
    """

    def __init__(self, pack, num_envs, seed):
        self.pack = pack
        self.num_envs = num_envs
        self.observation_size = GOAL_NAV_OBS[pack["adapter"]["policy"]["observationAdapterId"]]
        self.action_size = GOAL_NAV_ACTION
        self.control_dt = 1.0 / float(pack.get("controlHz", 10))
        policy = pack["adapter"]["policy"]
        if int(policy["observationSize"]) != self.observation_size or int(policy["actionSize"]) != self.action_size:
            raise ValueError(
                "adapter policy dimensions {}x{} do not match the goal-navigation layout {}x{}".format(
                    policy["observationSize"], policy["actionSize"],
                    self.observation_size, self.action_size,
                )
            )
        self.max_linear = float(pack["adapter"]["safety"]["maxLinear"])
        self.max_angular = float(pack["adapter"]["safety"]["maxAngular"])
        self.rng = np.random.default_rng(seed)
        self.goal_distance = [pack["curriculum"]["initialGoalDistance"][0],
                              pack["curriculum"]["initialGoalDistance"][1]]
        self.success_history = []
        # Vector state: x, y, yaw, gx, gy, v, w (cmd), v_lag, w_lag (lagged).
        self.state = np.zeros((num_envs, 8), dtype=np.float32)
        self.steps = np.zeros(num_envs, dtype=np.int64)
        self.domain = [DomainParams() for _ in range(num_envs)]
        self.action_fifo = [deque(maxlen=3) for _ in range(num_envs)]
        self.obstacles = [self._sample_obstacles() for _ in range(num_envs)]
        self.has_obstacles = bool((pack.get("workspace") or {}).get("obstacles", {}).get("count", 0)) > 0
        self.timeout_steps = int(pack["termination"]["timeoutSteps"])
        self._collision_flags = np.zeros(num_envs, dtype=bool)
        self.reset()

    def _sample_obstacles(self):
        obstacles = []
        spec = (self.pack.get("workspace") or {}).get("obstacles") or {}
        for _ in range(int(spec.get("count", 0))):
            obstacles.append((float(self.rng.uniform(-1.5, 1.5)),
                              float(self.rng.uniform(-1.5, 1.5)),
                              float(spec.get("radius", 0.15))))
        return obstacles

    def reset(self):
        lo, hi = self.goal_distance
        angles = self.rng.uniform(0.0, 2.0 * math.pi, size=self.num_envs)
        distances = self.rng.uniform(lo, hi, size=self.num_envs)
        self.state[:, 0] = 0.0
        self.state[:, 1] = 0.0
        self.state[:, 2] = self.rng.uniform(-math.pi, math.pi, size=self.num_envs)
        self.state[:, 3] = distances * np.cos(angles)
        self.state[:, 4] = distances * np.sin(angles)
        self.state[:, 5:] = 0.0
        self.steps[:] = 0
        self._collision_flags[:] = False
        for env_idx in range(self.num_envs):
            self.domain[env_idx] = DomainParams.sample(self.rng, self.pack.get("domainRandomization"))
            self.action_fifo[env_idx].clear()
            self.obstacles[env_idx] = self._sample_obstacles()
        return self.observe()

    def _collided(self, env_idx):
        if not self.has_obstacles:
            return False
        x, y = self.state[env_idx, 0], self.state[env_idx, 1]
        for ox, oy, radius in self.obstacles[env_idx]:
            if math.hypot(x - ox, y - oy) <= radius:
                return True
        return False

    def _apply_action(self, env_idx, action):
        domain = self.domain[env_idx]
        linear = float(np.clip(action[0], -1.0, 1.0)) * self.max_linear
        angular = float(np.clip(action[1], -1.0, 1.0)) * self.max_angular
        fifo = self.action_fifo[env_idx]
        fifo.append((linear, angular))
        # Latency: execute the command from N steps ago (agent must be robust
        # to delayed actuation; the FIFO holds at most 3 entries).
        delayed = fifo[0] if len(fifo) > domain.latency_steps else fifo[0]
        target_v, target_w = delayed
        # First-order actuator lag toward the delayed target, scaled by the
        # motor gain (a weak motor converges to a slower top speed).
        alpha = self.control_dt / max(domain.lag_tau, 1e-6)
        alpha = min(alpha, 1.0)
        v_lag = self.state[env_idx, 6] + alpha * (target_v * domain.motor_gain - self.state[env_idx, 6])
        w_lag = self.state[env_idx, 7] + alpha * (target_w * domain.motor_gain - self.state[env_idx, 7])
        self.state[env_idx, 6] = v_lag
        self.state[env_idx, 7] = w_lag
        yaw = self.state[env_idx, 2] + (w_lag + domain.angular_bias) * self.control_dt
        yaw = (yaw + math.pi) % (2.0 * math.pi) - math.pi
        self.state[env_idx, 2] = yaw
        self.state[env_idx, 0] += v_lag * math.cos(yaw) * self.control_dt
        self.state[env_idx, 1] += v_lag * math.sin(yaw) * self.control_dt

    def step(self, action):
        """Advance all envs one control step. Returns (obs, reward, done,
        success_mask); auto-reset keeps rollouts dense and records episode
        outcomes for the curriculum."""
        reward_cfg = self.pack["reward"]
        goal_eps = float(self.pack["termination"]["goalDistance"])
        rewards = np.zeros(self.num_envs, dtype=np.float32)
        done = np.zeros(self.num_envs, dtype=bool)
        success = np.zeros(self.num_envs, dtype=bool)
        previous_distance = np.hypot(self.state[:, 3] - self.state[:, 0],
                                     self.state[:, 4] - self.state[:, 1])
        for env_idx in range(self.num_envs):
            if done[env_idx]:
                continue
            self._apply_action(env_idx, action[env_idx])
        self.steps += 1
        distance = np.hypot(self.state[:, 3] - self.state[:, 0],
                            self.state[:, 4] - self.state[:, 1])
        for env_idx in range(self.num_envs):
            if done[env_idx]:
                continue
            collided = self._collided(env_idx)
            if collided:
                self._collision_flags[env_idx] = True
            success[env_idx] = distance[env_idx] < goal_eps
            reward = (
                reward_cfg["progress"] * float(previous_distance[env_idx] - distance[env_idx])
                + reward_cfg["actionPenalty"] * float(np.mean(np.abs(np.clip(action[env_idx], -1.0, 1.0))))
                + (reward_cfg["goal"] if success[env_idx] else 0.0)
                + (reward_cfg["collision"] if collided else 0.0)
            )
            rewards[env_idx] = reward
            done[env_idx] = success[env_idx] or collided or self.steps[env_idx] >= self.timeout_steps
        # Curriculum + auto-reset for finished episodes.
        reset_indices = np.nonzero(done)[0]
        for env_idx in reset_indices:
            self.success_history.append(bool(success[env_idx]))
        obs = self.observe()
        for env_idx in reset_indices:
            lo, hi = self.goal_distance
            angles = self.rng.uniform(0.0, 2.0 * math.pi)
            distance_value = self.rng.uniform(lo, hi)
            self.state[env_idx, 0] = 0.0
            self.state[env_idx, 1] = 0.0
            self.state[env_idx, 2] = self.rng.uniform(-math.pi, math.pi)
            self.state[env_idx, 3] = distance_value * math.cos(angles)
            self.state[env_idx, 4] = distance_value * math.sin(angles)
            self.state[env_idx, 5:] = 0.0
            self.steps[env_idx] = 0
            self._collision_flags[env_idx] = False
            self.domain[env_idx] = DomainParams.sample(self.rng, self.pack.get("domainRandomization"))
            self.action_fifo[env_idx].clear()
            self.obstacles[env_idx] = self._sample_obstacles()
            obs[env_idx] = self.observe_one(env_idx)
        self._maybe_expand_curriculum()
        return obs, rewards, done, success

    def _maybe_expand_curriculum(self):
        curriculum = self.pack["curriculum"]
        lookback = int(curriculum.get("lookbackEpisodes", 50))
        if len(self.success_history) < lookback:
            return
        recent = self.success_history[-lookback:]
        if sum(recent) / len(recent) >= float(curriculum.get("successRateThreshold", 0.7)):
            final = curriculum["finalGoalDistance"]
            expanded = [self.goal_distance[0] * float(curriculum.get("expandFactor", 1.15)),
                        self.goal_distance[1] * float(curriculum.get("expandFactor", 1.15))]
            self.goal_distance = [min(expanded[0], final[1]), min(expanded[1], final[1])]
            self.success_history.clear()

    def observe(self):
        out = np.zeros((self.num_envs, self.observation_size), dtype=np.float32)
        for env_idx in range(self.num_envs):
            out[env_idx] = self.observe_one(env_idx)
        return out

    def observe_one(self, env_idx):
        domain = self.domain[env_idx]
        x, y, yaw, gx, gy = self.state[env_idx, :5]
        v_lag = float(self.state[env_idx, 6])
        w_lag = float(self.state[env_idx, 7])
        if self.observation_size == 8:
            # Native board layout: x, y, sin, cos, dx, dy, v, w with noise.
            return np.asarray([
                x + self.rng.normal(0.0, domain.odom_noise),
                y + self.rng.normal(0.0, domain.odom_noise),
                math.sin(yaw), math.cos(yaw),
                gx - x, gy - y,
                v_lag, w_lag + self.rng.normal(0.0, domain.gyro_noise),
            ], dtype=np.float32)
        # Generic 42D layout: [gyro(3), gravity(3), last command(2),
        # body-frame goal delta(2), twist(2), zeros(30)]. The goal delta is
        # rotated into the chassis frame (derivable on hardware from the
        # odom pose + goal): a goal-relative direction the policy can steer
        # toward without an explicit yaw slot. Without this rotation the
        # world-frame delta is unlearnable — no heading information exists
        # anywhere else in the layout.
        out = np.zeros(self.observation_size, dtype=np.float32)
        out[0:3] = (self.rng.normal(0.0, domain.gyro_noise, size=3))
        out[3:6] = (0.0, 0.0, -1.0)  # projected gravity, upright chassis
        out[6:8] = (v_lag / self.max_linear if self.max_linear else 0.0,
                    w_lag / self.max_angular if self.max_angular else 0.0)
        world_dx = gx - x
        world_dy = gy - y
        cos_yaw = math.cos(yaw)
        sin_yaw = math.sin(yaw)
        out[8:10] = (cos_yaw * world_dx + sin_yaw * world_dy,
                     -sin_yaw * world_dx + cos_yaw * world_dy)
        out[10:12] = (v_lag, w_lag)
        return out

    def rollout_episode(self, model, device, seed, domain, deterministic=True):
        """Run one full episode for evaluation; returns per-step rows.

        Builds a dedicated single-env seeded from `seed` so evaluation never
        disturbs the training env's RNG state.
        """
        single = GoalNavEnv(self.pack, 1, seed)
        single.domain = [domain]
        single.timeout_steps = self.timeout_steps
        obs = single.observe()
        rows = []
        collided = False
        reached = False
        steps = 0
        with torch.no_grad():
            obs_tensor = torch.from_numpy(obs).to(device)
            for step in range(single.timeout_steps):
                action, _ = model.act(obs_tensor, deterministic=deterministic)
                action_np = action.cpu().numpy()
                next_obs, reward, done, success = single.step(action_np)
                rows.append({
                    "t": round(steps * self.control_dt, 4),
                    "observation": [round(float(v), 6) for v in obs[0]],
                    "action": [round(float(v), 6) for v in action_np[0]],
                    "reward": round(float(reward[0]), 6),
                    "done": bool(done[0]),
                    "fall": bool(single._collision_flags[0]),
                })
                obs = next_obs
                obs_tensor = torch.from_numpy(obs).to(device)
                steps += 1
                collided = collided or bool(single._collision_flags[0])
                reached = reached or bool(success[0])
                if done[0]:
                    break
        return {
            "rows": rows,
            "success": reached,
            "collision": collided,
            "steps": steps,
            "finalDistance": float(np.hypot(single.state[0, 3] - single.state[0, 0],
                                            single.state[0, 4] - single.state[0, 1])),
        }


class ActorCritic(torch.nn.Module):
    def __init__(self, obs_size, act_size, hidden=128):
        super().__init__()
        self.body = torch.nn.Sequential(
            torch.nn.Linear(obs_size, hidden),
            torch.nn.Tanh(),
            torch.nn.Linear(hidden, hidden),
            torch.nn.Tanh(),
        )
        self.mu = torch.nn.Linear(hidden, act_size)
        self.value = torch.nn.Linear(hidden, 1)
        self.log_std = torch.nn.Parameter(torch.full((act_size,), -0.7))

    def forward(self, obs):
        h = self.body(obs)
        return self.mu(h), self.value(h).squeeze(-1)

    def distribution(self, obs):
        mu, _ = self.forward(obs)
        std = self.log_std.clamp(-1.5, 0.0).exp().expand_as(mu)
        return torch.distributions.Normal(mu, std)

    def act(self, obs, deterministic=False):
        dist = self.distribution(obs)
        action = dist.mean if deterministic else dist.sample()
        return action.clamp(-1.0, 1.0), dist.log_prob(action.clamp(-1.0, 1.0)).sum(-1)


def evaluate_policy(model, joint_count, command_size, control_dt, physics_dt, decimation,
                    seed, episodes=EVAL_EPISODES, collect_jsonl=False):
    """Run whole episodes without auto-reset; record true per-episode stats.

    Episodes run one at a time (a few hundred single-env steps each) because
    an obviously-correct serial loop beats a masked vectorized one here.
    """
    was_training = model.training
    model.eval()
    device = next(model.parameters()).device
    env = PendulumChain(1, joint_count, command_size, seed)
    returns, lengths, fell_flags = [], [], []
    jsonl_rows = []
    with torch.no_grad():
        for episode in range(episodes):
            env.reset()
            obs = torch.from_numpy(env.observe()).to(device)
            episode_return = 0.0
            steps = 0
            fell = False
            for step in range(EPISODE_CONTROL_STEPS):
                action, _ = model.act(obs, deterministic=True)
                next_obs, reward, done, fallen_now = env.step(
                    action.cpu().numpy(), physics_dt, decimation, auto_reset=False
                )
                episode_return += float(reward[0])
                steps += 1
                if collect_jsonl and episode == 0 and step < 200:
                    jsonl_rows.append({
                        "t": round(step * control_dt, 4),
                        "observation": [round(float(v), 6) for v in obs.cpu().numpy()[0]],
                        "action": [round(float(v), 6) for v in action.cpu().numpy()[0]],
                        "reward": round(float(reward[0]), 6),
                        "done": bool(done[0]),
                        "fall": bool(fallen_now[0]),
                    })
                obs = torch.from_numpy(next_obs).to(device)
                if done[0]:
                    fell = bool(fallen_now[0])
                    break
            returns.append(episode_return)
            lengths.append(steps)
            fell_flags.append(fell)
    if was_training:
        model.train()
    survived = sum(1 for flag in fell_flags if not flag)
    return {
        "episodeReward": float(np.mean(returns)),
        "meanStepReward": float(np.mean([r / max(s, 1) for r, s in zip(returns, lengths)])),
        "successRate": survived / episodes,
        "fallRate": float(np.mean(fell_flags)),
        "episodeLength": float(np.mean(lengths)),
        "jsonl": jsonl_rows,
    }


def measure_control_latency_ms(model, obs_size, control_dt):
    """Single-sample inference latency for the one-thread CPU budget."""
    model.eval()
    sample = torch.zeros(1, obs_size)
    with torch.no_grad():
        model.act(sample, deterministic=True)  # warm-up
        timings = []
        for _ in range(32):
            started = time.perf_counter()
            model.act(sample, deterministic=True)
            timings.append((time.perf_counter() - started) * 1000.0)
    return round(float(np.median(timings)), 3)


def export_onnx(model, obs_size, act_size, path):
    model.eval()
    dummy = torch.zeros(1, obs_size)

    class ActorOnly(torch.nn.Module):
        def __init__(self, ac):
            super().__init__()
            self.ac = ac

        def forward(self, observation):
            mu, _ = self.ac.forward(observation)
            return mu.clamp(-1.0, 1.0)

    actor = ActorOnly(model)
    import warnings
    with warnings.catch_warnings():
        # The legacy TorchScript exporter emits a migration DeprecationWarning
        # on torch>=2.9; it would otherwise dominate the worker-captured stderr.
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            actor,
            (dummy,),
            path,
            input_names=["observation"],
            output_names=["action"],
            dynamic_axes={"observation": {0: "batch"}, "action": {0: "batch"}},
            opset_version=13,
        )
    return os.path.getsize(path)


# ---------------------------------------------------------------------------
# Shared PPO update (both paths). Kept as a function over tensors so the
# pendulum loop and the goal-navigation loop cannot drift apart.
# ---------------------------------------------------------------------------
def ppo_update(model, model_opt, flat_obs, flat_act, flat_logp, flat_adv, flat_ret, device):
    flat_adv = (flat_adv - flat_adv.mean()) / (flat_adv.std() + 1e-8)
    dataset = torch.utils.data.TensorDataset(flat_obs, flat_act, flat_logp, flat_adv, flat_ret)
    loader = torch.utils.data.DataLoader(
        dataset, batch_size=min(PPO_HYPERPARAMS["minibatch"], flat_obs.shape[0]), shuffle=True,
    )
    for _ in range(PPO_HYPERPARAMS["epochs"]):
        for mb_obs, mb_act, mb_logp, mb_adv, mb_ret in loader:
            dist = model.distribution(mb_obs)
            new_logp = dist.log_prob(mb_act).sum(-1)
            ratio = (new_logp - mb_logp).exp()
            policy_loss = -torch.min(
                ratio * mb_adv, ratio.clamp(1.0 - PPO_HYPERPARAMS["clip"], 1.0 + PPO_HYPERPARAMS["clip"]) * mb_adv,
            ).mean()
            value = model.forward(mb_obs)[1]
            value_loss = (mb_ret - value).pow(2).mean()
            entropy = dist.entropy().sum(-1).mean()
            loss = policy_loss + PPO_HYPERPARAMS["valueCoef"] * value_loss - PPO_HYPERPARAMS["entropyCoef"] * entropy
            model_opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), PPO_HYPERPARAMS["maxGradNorm"])
            model_opt.step()


def collect_rollout(model, env, rollout_steps, device, step_fn):
    """Gather one PPO rollout from a vectorized env via step_fn(actions)->(reward, done)."""
    batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done = [], [], [], [], [], []
    obs = torch.from_numpy(env.observe()).to(device)
    for _ in range(rollout_steps):
        with torch.no_grad():
            dist = model.distribution(obs)
            action = dist.sample().clamp(-1.0, 1.0)
            logp = dist.log_prob(action).sum(-1)
            value = model.forward(obs)[1]
        reward, done = step_fn(action.cpu().numpy())
        batch_obs.append(obs)
        batch_act.append(action)
        batch_logp.append(logp)
        batch_val.append(value)
        batch_rew.append(torch.from_numpy(reward.astype(np.float32)).to(device))
        batch_done.append(torch.from_numpy(done.astype(np.float32)).to(device))
        obs = torch.from_numpy(env.observe()).to(device)
    return batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done


def gae_returns(rewards, values, dones, gamma, lam):
    adv = torch.zeros_like(rewards)
    last_gae = 0.0
    next_value = torch.zeros(rewards.shape[1], device=rewards.device)
    with torch.no_grad():
        for t in reversed(range(rewards.shape[0])):
            delta = rewards[t] + gamma * next_value * (1.0 - dones[t]) - values[t]
            last_gae = delta + gamma * lam * (1.0 - dones[t]) * last_gae
            adv[t] = last_gae
            next_value = values[t]
    return adv + values


def train_goal_navigation(request, pack):
    """Task-pack training path: goal navigation with DR + curriculum.

    Evaluation happens under the task's pinned eval envelopes (nominal and
    hard) on a fixed seed, once for the trained actor and once for an
    untrained baseline, producing eval-report.json with the quality-gate
    verdict and the trained-vs-baseline gap.
    """
    contract = request["contract"]
    model_info = request["model"]
    training = request.get("training") or {}
    profile = str(training.get("profile", "smoke"))
    budget = PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])
    iterations = env_int("RDK_STARTER_ENGINE_ITERATIONS", 0) or clamp_int(
        training.get("maxIterations"), 1, budget["iterations"], min(budget["iterations"], 60)
    )
    num_envs = env_int("RDK_STARTER_ENGINE_ENVS", 0) or clamp_int(
        training.get("numEnvs"), 1, budget["envs"], budget["envs"]
    )
    rollout_steps = env_int("RDK_STARTER_ENGINE_STEPS", min(budget["steps"], 128))
    seed = int(pack.get("seed", 7))
    obs_size = int(contract["observationSize"])
    act_size = int(contract["actionSize"])
    control_hz = int(contract.get("controlHz", 10))

    requested_device, device_name, cuda_requested = resolve_device()
    torch.set_num_threads(TORCH_THREADS if requested_device.type == "cpu" else max(TORCH_THREADS, 4))
    stdout(
        "engine=start task={} profile={} iters={} envs={} steps={} obs={} act={} control={}Hz device={}{}".format(
            pack["id"], profile, iterations, num_envs, rollout_steps, obs_size, act_size, control_hz,
            requested_device.type, " ({})".format(device_name) if device_name != "cpu" else "",
        )
    )

    env = GoalNavEnv(pack, num_envs, seed=seed)
    device = requested_device
    model = ActorCritic(obs_size, act_size).to(device)
    model_opt = torch.optim.Adam(model.parameters(), lr=PPO_HYPERPARAMS["actorLr"])
    to_tensor = lambda array: torch.from_numpy(array).to(device)  # noqa: E731 - local shim

    reward_curve = []
    success_curve = []
    started = time.time()
    for iteration in range(iterations):
        batch = collect_rollout(
            model, env, rollout_steps, device,
            lambda actions: (lambda result: (result[1], result[2]))(env.step(actions)),
        )
        batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done = batch
        rewards = torch.stack(batch_rew)
        values = torch.stack(batch_val)
        dones = torch.stack(batch_done)
        returns = gae_returns(rewards, values, dones, PPO_HYPERPARAMS["gamma"], PPO_HYPERPARAMS["gaeLambda"])
        ppo_update(
            model, model_opt,
            torch.cat(batch_obs), torch.cat(batch_act), torch.cat(batch_logp),
            (returns - values).reshape(-1), returns.reshape(-1), device,
        )
        reward_curve.append(round(float(rewards.mean()), 4))
        recent = env.success_history[-50:]
        success_curve.append(round(sum(recent) / len(recent), 3) if recent else 0.0)
        if (iteration + 1) % max(1, iterations // 8) == 0:
            stdout(
                "iter {}/{} meanReward={:.3f} recentSuccess={:.2f} goalRange=[{:.2f},{:.2f}] elapsed={:.1f}s".format(
                    iteration + 1, iterations, rewards.mean(),
                    success_curve[-1], env.goal_distance[0], env.goal_distance[1], time.time() - started,
                )
            )

    # ---- evaluation under pinned envelopes ----
    envelopes = (pack.get("domainRandomization") or {}).get("evalEnvelopes") or {}
    eval_seed = seed + 1000
    trained_report = evaluate_goal_navigation(model, env, device, envelopes, eval_seed)
    baseline_model = ActorCritic(obs_size, act_size).to(device)
    baseline_report = evaluate_goal_navigation(baseline_model, env, device, envelopes, eval_seed)
    latency = measure_control_latency_ms(model.to("cpu"), obs_size, 1.0 / control_hz)
    model = model.to(device)

    onnx_bytes = 0
    if HAVE_ONNX:
        try:
            onnx_bytes = export_onnx(model.to("cpu"), obs_size, act_size, "policy.onnx")
            model = model.to(device)
            stdout("exported policy.onnx ({} bytes)".format(onnx_bytes))
        except Exception as error:  # noqa: BLE001 - export failure must not lose the run
            model = model.to(device)
            stdout("ONNX export failed: {}; continuing without it".format(error))

    gate = evaluate_quality_gate(trained_report, pack.get("qualityGate") or {})
    nominal = trained_report["envelopes"].get("nominal") or {}
    baseline_nominal = baseline_report["envelopes"].get("nominal") or {}
    stdout(
        "eval nominal: successRate={:.2f} collisionRate={:.2f} (baseline {:.2f}/{:.2f}) gate={} gap={:+.2f}".format(
            nominal.get("successRate", 0.0), nominal.get("collisionRate", 0.0),
            baseline_nominal.get("successRate", 0.0), baseline_nominal.get("collisionRate", 0.0),
            "PASS" if gate["passed"] else "FAIL",
            float(nominal.get("successRate", 0.0)) - float(baseline_nominal.get("successRate", 0.0)),
        )
    )

    # Telemetry: trained actor under the hard envelope (worst-case honest
    # display) and the baseline under nominal for the sim2real reference.
    with open("telemetry.jsonl", "w") as handle:
        for row in trained_report["jsonl"].get("hard", []):
            handle.write(json.dumps(row) + "\n")
    with open("baseline-telemetry.jsonl", "w") as handle:
        for row in baseline_report["jsonl"].get("nominal", []):
            handle.write(json.dumps(row) + "\n")
    with open("training-summary.json", "w") as handle:
        json.dump(
            {
                "engine": "starter-ppo",
                "task": pack["id"],
                "taskKind": "goal-navigation",
                "profile": profile,
                "iterations": iterations,
                "numEnvs": num_envs,
                "rolloutSteps": rollout_steps,
                "seed": seed,
                "hyperparams": PPO_HYPERPARAMS,
                "curriculum": {
                    "initialGoalDistance": pack["curriculum"]["initialGoalDistance"],
                    "finalGoalDistance": pack["curriculum"]["finalGoalDistance"],
                    "reachedGoalDistance": [round(env.goal_distance[0], 3), round(env.goal_distance[1], 3)],
                },
                "controlHz": control_hz,
                "rewardCurve": reward_curve,
                "successCurve": success_curve,
                "device": requested_device.type,
                **({"deviceName": device_name} if device_name != "cpu" else {}),
                "eval": {k: v for k, v in trained_report.items() if k not in ("jsonl",)},
                "baseline": {k: v for k, v in baseline_report.items() if k not in ("jsonl",)},
                "controlLatencyMs": latency,
                "onnxExported": bool(onnx_bytes),
                "trainingSeconds": round(time.time() - started, 1),
            },
            handle, indent=2,
        )
    with open("eval-report.json", "w") as handle:
        json.dump(
            {
                "schemaVersion": 1,
                "taskId": pack["id"],
                "adapterId": pack["adapter"]["id"],
                "observationAdapterId": pack["adapter"]["policy"]["observationAdapterId"],
                "trained": {k: v for k, v in trained_report.items() if k != "jsonl"},
                "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                "qualityGate": gate,
                "controlLatencyMs": latency,
                "seed": eval_seed,
            },
            handle, indent=2,
        )

    slug_model = safe_slug(model_info.get("modelId", "starter-ppo"), "starter-ppo")
    slug_version = safe_slug(model_info.get("version", "0.1.0"), "0-1-0")
    result = {
        "checkpoint": {
            "checkpointId": "starter-ppo-{}".format(slug_version),
            "artifactRef": "artifact://starter/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": iterations,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://starter/{}/{}/policy.onnx".format(slug_model, slug_version),
            "kind": "source",
            "format": "onnx" if onnx_bytes else "unknown",
            **({"runtime": "cpu-onnx", "workload": "goal-navigation", "threads": 1} if onnx_bytes else {}),
            **({"sizeBytes": onnx_bytes} if onnx_bytes else {}),
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": "starter-ppo",
            "taskId": pack["id"],
            "taskKind": "goal-navigation",
            "observationSize": obs_size,
            "actionSize": act_size,
            "reward": round(trained_report.get("meanReward", 0.0), 4),
            "initialReward": round(baseline_report.get("meanReward", 0.0), 4),
            "successRate": round(nominal.get("successRate", 0.0), 4),
            "collisionRate": round(nominal.get("collisionRate", 0.0), 4),
            "hardSuccessRate": round((trained_report["envelopes"].get("hard") or {}).get("successRate", 0.0), 4),
            "qualityGatePassed": gate["passed"],
            "controlLatencyMs": latency,
            "iterations": iterations,
            "onnxExported": bool(onnx_bytes),
            "telemetrySamples": sum(len(rows) for rows in trained_report["jsonl"].values()),
        },
        "deployable": False,
        "cuda": requested_device.type == "cuda",
    }
    return result


def evaluate_goal_navigation(model, env, device, envelopes, seed, episodes_per_envelope=6):
    """Evaluate an actor under each pinned envelope on a fixed seed.

    Envelope order: [motorGain, lagTauSeconds, gyroNoiseStdRadSec,
    odomNoiseStdM, angularBiasRadSec, actionLatencySteps].
    """
    model.eval()
    report = {"envelopes": {}, "jsonl": {}, "meanReward": 0.0}
    rewards_all = []
    for name, envelope in (envelopes or {"nominal": [1.0, 1.0, 0.1, 0.1, 0.0, 0.0, 0.0, 0]}).items():
        domain = eval_domain_params(envelope)
        successes, collisions, finals, lengths, rewards = 0, 0, [], [], []
        jsonl_rows = []
        for episode in range(episodes_per_envelope):
            episode_seed = seed * 7919 + episode
            outcome = env.rollout_episode(model, device, episode_seed, domain)
            successes += int(outcome["success"])
            collisions += int(outcome["collision"])
            finals.append(outcome["finalDistance"])
            lengths.append(outcome["steps"])
            episode_reward = sum(row["reward"] for row in outcome["rows"])
            rewards.append(episode_reward)
            if episode == 0:
                jsonl_rows = outcome["rows"]
        report["envelopes"][name] = {
            "successRate": successes / episodes_per_envelope,
            "collisionRate": collisions / episodes_per_envelope,
            "meanFinalDistance": round(float(np.mean(finals)), 4),
            "meanEpisodeLength": round(float(np.mean(lengths)), 2),
            "meanReward": round(float(np.mean(rewards)), 4),
        }
        report["jsonl"][name] = jsonl_rows
        rewards_all.extend(rewards)
    if model.training:
        model.train()
    report["meanReward"] = round(float(np.mean(rewards_all)), 4) if rewards_all else 0.0
    return report


def evaluate_quality_gate(report, quality_gate):
    """Apply the task's quality gate to the nominal-envelope metrics.

    A gate verdict is PASS only from measured evidence — never from a
    missing metric (absent metrics fail closed).
    """
    nominal = (report.get("envelopes") or {}).get("nominal") or {}
    errors = []
    min_success = quality_gate.get("minSuccessRate")
    if min_success is not None:
        if "successRate" not in nominal:
            errors.append("nominal successRate missing")
        elif nominal["successRate"] < float(min_success):
            errors.append(
                "successRate {:.2f} below gate {:.2f}".format(nominal["successRate"], float(min_success))
            )
    max_collision = quality_gate.get("maxCollisionRate")
    if max_collision is not None:
        if "collisionRate" not in nominal:
            errors.append("nominal collisionRate missing")
        elif nominal["collisionRate"] > float(max_collision):
            errors.append(
                "collisionRate {:.2f} above gate {:.2f}".format(nominal["collisionRate"], float(max_collision))
            )
    return {
        "passed": not errors,
        "errors": errors,
        "criteria": {
            "minSuccessRate": min_success,
            "maxCollisionRate": max_collision,
        },
        "measured": {
            "successRate": nominal.get("successRate"),
            "collisionRate": nominal.get("collisionRate"),
        },
    }


def train(request):
    task = request.get("task")
    if isinstance(task, dict) and task.get("kind") == "goal-navigation":
        return train_goal_navigation(request, task)
    contract = request["contract"]
    model_info = request["model"]
    training = request.get("training") or {}
    joint_count = int(contract.get("jointCount", JOINT_COUNT))
    obs_size = int(contract["observationSize"])
    act_size = int(contract["actionSize"])
    control_hz = int(contract.get("controlHz", 50))
    physics_dt = float(contract.get("physicsTimestepSeconds", 0.002))
    decimation = int(contract.get("decimation", max(1, round(control_hz * physics_dt))))
    control_dt = 1.0 / control_hz
    command_size = obs_size - 3 * joint_count
    if command_size < 0:
        raise ValueError("contract.observationSize too small for the 3x joint observation layout")
    if command_size == 0:
        command_size = 1  # degenerate command channel keeps the layout uniform
    if act_size != joint_count:
        raise ValueError("contract.actionSize must equal contract.jointCount for this engine")

    profile = str(training.get("profile", "smoke"))
    budget = PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])
    iterations = env_int("RDK_STARTER_ENGINE_ITERATIONS", 0) or clamp_int(
        training.get("maxIterations"), 1, budget["iterations"], min(budget["iterations"], 40)
    )
    num_envs = env_int("RDK_STARTER_ENGINE_ENVS", 0) or clamp_int(
        training.get("numEnvs"), 1, budget["envs"], budget["envs"]
    )
    rollout_steps = env_int("RDK_STARTER_ENGINE_STEPS", budget["steps"])
    model_id = str(model_info.get("modelId", "starter-ppo"))
    version = str(model_info.get("version", "0.1.0"))

    requested_device, device_name, cuda_requested = resolve_device()
    torch.set_num_threads(TORCH_THREADS if requested_device.type == "cpu" else max(TORCH_THREADS, 4))
    stdout(
        "engine=start task=pendulum-chain-{}j profile={} iters={} envs={} steps={} obs={} act={} control={}Hz device={}{}".format(
            joint_count, profile, iterations, num_envs, rollout_steps, obs_size, act_size, control_hz,
            requested_device.type, " ({})".format(device_name) if device_name != "cpu" else "",
        )
    )
    if not HAVE_ONNX:
        stdout("onnx wheel missing; ONNX export will be skipped ({})".format(ONNX_MISSING_HINT))

    env = PendulumChain(num_envs, joint_count, command_size, seed=7)
    device = requested_device
    model = ActorCritic(obs_size, act_size).to(device)
    # One optimizer over the full parameter set (shared body + actor head +
    # critic head) with the composite PPO loss; a split optimizer adds
    # bookkeeping without changing the CPU starter result.
    model_opt = torch.optim.Adam(model.parameters(), lr=PPO_HYPERPARAMS["actorLr"])
    to_tensor = lambda array: torch.from_numpy(array).to(device)  # noqa: E731 - local shim
    initial_eval = evaluate_policy(model, joint_count, command_size, control_dt, physics_dt, decimation, seed=11)
    stdout(
        "eval before training: stepReward={:.3f} successRate={:.2f}".format(
            initial_eval["meanStepReward"], initial_eval["successRate"]
        )
    )

    gamma = PPO_HYPERPARAMS["gamma"]
    lam = PPO_HYPERPARAMS["gaeLambda"]
    clip = PPO_HYPERPARAMS["clip"]
    reward_curve = []
    started = time.time()
    for iteration in range(iterations):
        batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done = [], [], [], [], [], []
        obs = to_tensor(env.observe())
        for _ in range(rollout_steps):
            with torch.no_grad():
                dist = model.distribution(obs)
                action = dist.sample().clamp(-1.0, 1.0)
                logp = dist.log_prob(action).sum(-1)
                value = model.forward(obs)[1]
            next_obs_np, reward, done, _ = env.step(action.cpu().numpy(), physics_dt, decimation)
            batch_obs.append(obs)
            batch_act.append(action)
            batch_logp.append(logp)
            batch_val.append(value)
            batch_rew.append(to_tensor(reward))
            batch_done.append(to_tensor(done.astype(np.float32)))
            obs = to_tensor(next_obs_np)

        rewards = torch.stack(batch_rew)
        values = torch.stack(batch_val)
        dones = torch.stack(batch_done)
        # GAE advantages with a terminal bootstrap of zero (auto-reset env:
        # done flags mark where the value target restarts).
        adv = torch.zeros_like(rewards, device=device)
        last_gae = 0.0
        with torch.no_grad():
            next_value = torch.zeros(num_envs, device=device)
            for t in reversed(range(rollout_steps)):
                delta = rewards[t] + gamma * next_value * (1.0 - dones[t]) - values[t]
                last_gae = delta + gamma * lam * (1.0 - dones[t]) * last_gae
                adv[t] = last_gae
                next_value = values[t]
            returns = adv + values

        flat_obs = torch.cat(batch_obs)
        flat_act = torch.cat(batch_act)
        flat_logp = torch.cat(batch_logp)
        flat_adv = adv.reshape(-1)
        flat_ret = returns.reshape(-1)
        flat_adv = (flat_adv - flat_adv.mean()) / (flat_adv.std() + 1e-8)

        dataset = torch.utils.data.TensorDataset(flat_obs, flat_act, flat_logp, flat_adv, flat_ret)
        loader = torch.utils.data.DataLoader(
            dataset,
            batch_size=min(PPO_HYPERPARAMS["minibatch"], flat_obs.shape[0]),
            shuffle=True,
        )
        for _ in range(PPO_HYPERPARAMS["epochs"]):
            for mb_obs, mb_act, mb_logp, mb_adv, mb_ret in loader:
                dist = model.distribution(mb_obs)
                new_logp = dist.log_prob(mb_act).sum(-1)
                ratio = (new_logp - mb_logp).exp()
                policy_loss = -torch.min(
                    ratio * mb_adv,
                    ratio.clamp(1.0 - clip, 1.0 + clip) * mb_adv,
                ).mean()
                value = model.forward(mb_obs)[1]
                value_loss = (mb_ret - value).pow(2).mean()
                entropy = dist.entropy().sum(-1).mean()
                loss = (
                    policy_loss
                    + PPO_HYPERPARAMS["valueCoef"] * value_loss
                    - PPO_HYPERPARAMS["entropyCoef"] * entropy
                )
                model_opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), PPO_HYPERPARAMS["maxGradNorm"])
                model_opt.step()

        reward_curve.append(round(float(rewards.mean()), 4))
        if (iteration + 1) % max(1, iterations // 8) == 0:
            stdout(
                "iter {}/{} meanStepReward={:.3f} elapsed={:.1f}s".format(
                    iteration + 1, iterations, rewards.mean(), time.time() - started
                )
            )

    final_eval = evaluate_policy(
        model, joint_count, command_size, control_dt, physics_dt, decimation,
        seed=11, collect_jsonl=True,
    )
    baseline_eval = evaluate_policy(
        ActorCritic(obs_size, act_size).to(device), joint_count, command_size, control_dt, physics_dt,
        decimation, seed=11, collect_jsonl=True,
    )
    stdout(
        "eval after training: stepReward={:.3f} successRate={:.2f} (baseline {:.3f}/{:.2f})".format(
            final_eval["meanStepReward"], final_eval["successRate"],
            baseline_eval["meanStepReward"], baseline_eval["successRate"],
        )
    )
    # The latency figure describes the board-like one-thread CPU budget the
    # artifact targets, so it is always measured on CPU — a GPU training run
    # must not advertise GPU inference latency.
    latency = measure_control_latency_ms(model.to("cpu"), obs_size, control_dt)
    model = model.to(device)

    onnx_bytes = 0
    if HAVE_ONNX:
        try:
            onnx_bytes = export_onnx(model.to("cpu"), obs_size, act_size, "policy.onnx")
            model = model.to(device)
            stdout("exported policy.onnx ({} bytes)".format(onnx_bytes))
        except Exception as error:  # noqa: BLE001 - export failure must not lose the run
            model = model.to(device)
            stdout("ONNX export failed: {}; continuing without it".format(error))

    with open("telemetry.jsonl", "w") as handle:
        for row in final_eval["jsonl"]:
            handle.write(json.dumps(row) + "\n")
    with open("baseline-telemetry.jsonl", "w") as handle:
        for row in baseline_eval["jsonl"]:
            handle.write(json.dumps(row) + "\n")
    with open("training-summary.json", "w") as handle:
        json.dump(
            {
                "engine": "starter-ppo",
                "task": "pendulum-chain-{}j".format(joint_count),
                "profile": profile,
                "iterations": iterations,
                "numEnvs": num_envs,
                "rolloutSteps": rollout_steps,
                "hyperparams": PPO_HYPERPARAMS,
                "physics": PHYSICS,
                "controlHz": control_hz,
                "physicsTimestepSeconds": physics_dt,
                "decimation": decimation,
                "rewardCurve": reward_curve,
                "device": requested_device.type,
                **({"deviceName": device_name} if device_name != "cpu" else {}),
                **({"cudaRequested": True} if cuda_requested and requested_device.type != "cuda" else {}),
                "eval": {k: v for k, v in final_eval.items() if k != "jsonl"},
                "baseline": {k: v for k, v in baseline_eval.items() if k != "jsonl"},
                "controlLatencyMs": latency,
                "onnxExported": bool(onnx_bytes),
                "trainingSeconds": round(time.time() - started, 1),
            },
            handle,
            indent=2,
        )

    slug_model = safe_slug(model_id, "starter-ppo")
    slug_version = safe_slug(version, "0-1-0")
    result = {
        "checkpoint": {
            "checkpointId": "starter-ppo-{}".format(slug_version),
            "artifactRef": "artifact://starter/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": iterations,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://starter/{}/{}/policy.onnx".format(slug_model, slug_version),
            "kind": "source",
            "format": "onnx" if onnx_bytes else "unknown",
            **({"runtime": "cpu-onnx", "workload": "locomotion", "threads": 1} if onnx_bytes else {}),
            **({"sizeBytes": onnx_bytes} if onnx_bytes else {}),
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": "starter-ppo",
            "observationSize": obs_size,
            "actionSize": act_size,
            "reward": round(final_eval["episodeReward"], 4),
            "initialReward": round(initial_eval["episodeReward"], 4),
            "successRate": round(final_eval["successRate"], 4),
            "fallRate": round(final_eval["fallRate"], 4),
            "episodeLength": round(final_eval["episodeLength"], 2),
            "controlLatencyMs": latency,
            "iterations": iterations,
            "onnxExported": bool(onnx_bytes),
            "telemetrySamples": len(final_eval["jsonl"]),
        },
        "deployable": False,
        # Honest device report: true only when training actually ran on CUDA.
        # A requested-but-unavailable cuda falls back to cpu and stays false.
        "cuda": requested_device.type == "cuda",
    }
    return result


def main():
    request_path = os.environ.get("RDK_SIM2REAL_REQUEST_FILE", "").strip()
    result_path = os.environ.get("RDK_SIM2REAL_RESULT_FILE", "").strip()
    if not request_path or not result_path:
        print(
            "RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required; "
            "run this through local-training-worker.mjs",
            file=sys.stderr,
        )
        sys.exit(2)
    with open(request_path) as handle:
        request = json.load(handle)
    if request.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")
    contract = request.get("contract") or {}
    if int(contract.get("observationSize", 0)) <= 0 or int(contract.get("actionSize", 0)) <= 0:
        raise ValueError("contract.observationSize and contract.actionSize are required")

    result = train(request)
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    stdout("wrote result with real PPO training artifacts")


if __name__ == "__main__":
    main()
