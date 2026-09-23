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


def _engines_dir_on_path():
    """Put the `engines/` directory on sys.path so the shared reward vocabulary
    is importable. `engines/starter-ppo` carries a hyphen and cannot be a package
    itself, so the shared module sits one level up."""
    engines_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if engines_dir not in sys.path:
        sys.path.insert(0, engines_dir)


_engines_dir_on_path()
def write_artifact_manifest(job_dir, names=None):
    """Write SHA256SUMS covering every file this run produced.

    A run's outputs travel together (policy, telemetry, evaluation report), and a
    digest for one file does not show that the rest are the ones that were
    produced. This manifest is what a consumer verifies as a set: the worker
    hashes every listed file and refuses the bundle on any mismatch, so a
    partially copied or later-edited job directory cannot be read as intact.

    The listing is discovered from the directory rather than hard-coded, so a
    future artifact cannot silently fall outside the manifest; only the two
    protocol files are excluded. `result.json` is written after this manifest
    (and its integrity is covered separately by the platform's normalized
    `reportSha256`), and `request.json` is an input, not an output.
    """
    import hashlib

    directory = os.path.abspath(job_dir)
    excluded = {"SHA256SUMS", "result.json", "request.json"}
    candidates = sorted(names) if names is not None else sorted(os.listdir(directory))
    lines = []
    for name in candidates:
        if name in excluded or os.sep in name or name.startswith("."):
            continue
        path = os.path.join(directory, name)
        try:
            if not os.path.isfile(path):
                continue
            digest = hashlib.sha256()
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
        except OSError:
            # A file that cannot be read is not listed; inventing an entry would
            # make the manifest unverifiable.
            continue
        lines.append("%s  %s" % (digest.hexdigest(), name))
    if not lines:
        raise RuntimeError("no artifacts to record in SHA256SUMS under %s" % directory)
    target = os.path.join(directory, "SHA256SUMS")
    with open(target, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    return target



def source_commit_short():
    """Commit id for the run's metrics, or None when it cannot be determined."""
    revision = source_revision()
    return revision.get("commit") if revision.get("known") else None



def dependency_versions():
    """Versions of the libraries that actually produced this artifact.

    `sourceCommit` answers "which code?" but not "which libraries?". A training
    run is reproducible only if both are pinned: numerics move between torch
    releases, and `torch.onnx.export` output changes with the exporter/opset in
    use. Reporting the *installed* versions (never the requested ones) makes a
    result auditable after the environment has moved on, and `uv.lock`-style
    pinning can be layered on top without changing this contract.
    """
    from importlib import metadata

    def version_of(distribution):
        try:
            return metadata.version(distribution)
        except Exception:  # noqa: BLE001 - a missing library is simply absent
            return None

    # Distribution names differ from import names for the ONNX exporter helper.
    packages = ("numpy", "torch", "onnx", "onnxruntime", "onnxscript", "jax", "mujoco")
    resolved = {name: version_of(name) for name in packages}
    return {name: version for name, version in resolved.items() if version is not None}



def dependency_lock_digest():
    """SHA-256 of this engine's pinned lock, or None when it is not shipped.

    The lock is the *intended* environment; `dependency_versions()` reports only
    the handful of libraries the engine imports directly, so a transitive
    package can differ between the lock and the machine that ran the training
    without anything noticing. Recording the lock's digest makes that auditable
    after the fact: two runs with the same digest used the same declared
    dependency set, and a run whose digest differs from the current lock was
    produced under a different one.

    Best-effort by design: a packaged board install has no `requirements.txt`
    beside the engine, so an absent digest is reported as `None` rather than
    failing the run or inventing one.
    """
    import hashlib

    engine_dir = os.path.dirname(os.path.abspath(__file__))
    lock = os.path.join(engine_dir, "requirements.txt")
    try:
        with open(lock, "rb") as handle:
            payload = handle.read()
    except OSError:
        return None
    return hashlib.sha256(payload).hexdigest()


def source_revision():
    """Exact revision of the training code that produced this artifact.

    A result carries a package version such as "starter-ppo-0.1.0", which cannot
    answer "which reward/observation code trained this policy?" once the tree has
    moved on. This records the commit and whether the working tree was clean, so
    a later reviewer can retrieve the code or discount the run.

    Best-effort by design: a checkout without `.git` (a packaged board install, a
    container) yields `known=False` rather than failing the run or inventing an
    identity.
    """
    import subprocess

    def run(*args):
        return subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )

    try:
        head = run("rev-parse", "HEAD")
        if head.returncode != 0:
            return {"known": False, "reason": "not-a-git-checkout"}
        commit = head.stdout.strip().lower()
        if len(commit) != 40:
            return {"known": False, "reason": "unexpected-revision-format"}
        status = run("status", "--porcelain")
        remote = run("config", "--get", "remote.origin.url")
        branch = run("rev-parse", "--abbrev-ref", "HEAD")
        provenance = {
            "known": True,
            "commit": commit,
            # A dirty tree means the recorded commit does not fully describe the
            # code that ran; say so instead of implying exact reproducibility.
            "dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
        }
        if remote.returncode == 0 and remote.stdout.strip():
            provenance["repository"] = remote.stdout.strip()[:200]
        if branch.returncode == 0 and branch.stdout.strip():
            provenance["ref"] = branch.stdout.strip()[:120]
        return provenance
    except (OSError, subprocess.SubprocessError):
        return {"known": False, "reason": "git-unavailable"}



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

# Keep shared reward code behind the dependency guards above.  It imports
# NumPy itself, so importing it before the guards made the runner report a
# raw ModuleNotFoundError instead of its stable exit-2 dependency contract.
from reward_vocabulary import (  # noqa: E402  (import after dependency guards)
    VectorRewardTracker,
    evaluate_formula_vector,
    historical_reward,
)

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
    # 42D: [gyro(3), gravity(3), last action(2), goal delta(2, body frame),
    # twist(2), zeros(30)] — the board's goalnav path fills gyro/gravity from
    # real IMU, goal delta from /odom + goalX/goalY, twist from /odom, and
    # last_action from the previous published command; a session without an
    # explicit goal is refused (fail-closed, never zero-filled).
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

    KEYS = ("motorGain", "lagTau", "gyroNoise", "odomNoise", "angularBias",
            "latencySteps", "odomDropout", "slipScale")

    def __init__(self, motor_gain=1.0, lag_tau=0.1, gyro_noise=0.0, odom_noise=0.0,
                 angular_bias=0.0, latency_steps=0, odom_dropout=0.0, slip_scale=1.0):
        self.motor_gain = motor_gain
        self.lag_tau = lag_tau
        self.gyro_noise = gyro_noise
        self.odom_noise = odom_noise
        self.angular_bias = angular_bias
        self.latency_steps = int(latency_steps)
        # Per-step probability that the whole observation frame is stale
        # (the board runtime republishes the last good frame on a drop).
        self.odom_dropout = odom_dropout
        # Wheel-slip scale: true body motion = wheel-reported motion * slip.
        # Odometry integrates the wheel speeds (slip-blind), so the believed
        # pose drifts from the true pose exactly as on loose flooring.
        self.slip_scale = slip_scale

    @classmethod
    def sample(cls, rng, spec):
        def uniform(key, default=0.0):
            values = (spec or {}).get(key)
            if not values:
                return default
            return float(rng.uniform(values[0], values[1]))
        # Integer latency drawn from its own inclusive range.
        latency = (spec or {}).get("actionLatencySteps") or [0, 0]
        latency_values = [float(latency[0]), float(latency[1])]
        if (
            not all(math.isfinite(value) and value >= 0 and value.is_integer() for value in latency_values)
            or latency_values[0] > latency_values[1]
        ):
            raise ValueError("domainRandomization.actionLatencySteps must be non-negative integers")
        steps = int(rng.integers(int(latency_values[0]), int(latency_values[1]) + 1))
        return cls(
            motor_gain=uniform("motorGain", 1.0),
            lag_tau=uniform("lagTauSeconds", 0.05),
            gyro_noise=uniform("gyroNoiseStdRadSec", 0.0),
            odom_noise=uniform("odomNoiseStdM", 0.0),
            angular_bias=uniform("angularBiasRadSec", 0.0),
            latency_steps=steps,
            odom_dropout=uniform("odomDropoutProb", 0.0),
            slip_scale=uniform("slipScale", 1.0),
        )

    def as_dict(self):
        return {
            "motorGain": round(self.motor_gain, 4),
            "lagTauSeconds": round(self.lag_tau, 4),
            "gyroNoiseStdRadSec": round(self.gyro_noise, 4),
            "odomNoiseStdM": round(self.odom_noise, 4),
            "angularBiasRadSec": round(self.angular_bias, 4),
            "actionLatencySteps": self.latency_steps,
            "odomDropoutProb": round(self.odom_dropout, 4),
            "slipScale": round(self.slip_scale, 4),
        }


def eval_domain_params(envelope):
    """Build pinned DomainParams from a task eval envelope.

    Envelope order: [motorGain, lagTauSeconds, gyroNoiseStdRadSec,
    odomNoiseStdM, angularBiasRadSec, actionLatencySteps, odomDropoutProb,
    slipScale]. Every value is pinned exactly, so envelope A/B comparisons
    are reproducible. A legacy 6-number envelope keeps the old semantics
    (no dropout, no slip) so old records stay re-loadable.
    """
    values = [float(value) for value in envelope]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("evaluation envelope values must be finite")
    while len(values) < 8:
        values.append(0.0 if len(values) < 7 else 1.0)
    (motor_gain, lag_tau, gyro_noise, odom_noise, angular_bias,
     latency, odom_dropout, slip_scale) = values
    if latency < 0 or not latency.is_integer():
        raise ValueError("evaluation envelope actionLatencySteps must be a non-negative integer")
    return DomainParams(
        motor_gain=motor_gain,
        lag_tau=lag_tau,
        gyro_noise=gyro_noise,
        odom_noise=odom_noise,
        angular_bias=angular_bias,
        latency_steps=int(latency),
        odom_dropout=odom_dropout,
        slip_scale=slip_scale,
    )


WILSON_Z = {0.90: 1.644854, 0.95: 1.959964, 0.99: 2.575829}


def wilson_bounds(successes, total, confidence=0.95):
    """Wilson score interval for a binomial proportion.

    Returns (low, high), or None when there are no episodes — the caller
    must treat that as missing evidence (fail closed), never as 0.
    """
    if total <= 0:
        return None
    z = WILSON_Z.get(round(float(confidence), 2))
    if z is None:
        raise ValueError("confidence must be one of 0.90/0.95/0.99")
    p = successes / total
    denom = 1.0 + z * z / total
    center = (p + z * z / (2.0 * total)) / denom
    spread = z * math.sqrt(p * (1.0 - p) / total + z * z / (4.0 * total * total)) / denom
    return center - spread, center + spread


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
        # Vector state (TRUE pose): x, y, yaw, gx, gy, v, w (cmd), v_lag, w_lag.
        # The believed pose lives separately in self.odom [odom_x, odom_y,
        # odom_yaw]: odometry integrates the wheel-reported velocities and is
        # blind to wheel slip and body-rotation bias, so it drifts from the
        # true pose exactly the way real odometry does. Success and collision
        # are measured on the TRUE pose — a policy that only "believes" it
        # arrived does not pass.
        self.state = np.zeros((num_envs, 8), dtype=np.float32)
        self.odom = np.zeros((num_envs, 3), dtype=np.float32)
        self.last_obs = np.zeros((num_envs, self.observation_size), dtype=np.float32)
        self._obs_initialized = np.zeros(num_envs, dtype=bool)
        self.steps = np.zeros(num_envs, dtype=np.int64)
        self.domain = [DomainParams() for _ in range(num_envs)]
        # Seed each queue with N zero commands at episode start.  Popping one
        # entry per step then gives exact transport latency (N=0 is
        # immediate).  A fixed maxlen queue made latency=0 accidentally
        # behave like a multi-step delay and silently truncated larger
        # declared envelopes.
        self.action_fifo = [deque() for _ in range(num_envs)]
        self._queue_latency = np.zeros(num_envs, dtype=np.int64)
        self.obstacles = [self._sample_obstacles() for _ in range(num_envs)]
        self.has_obstacles = bool((pack.get("workspace") or {}).get("obstacles", {}).get("count", 0)) > 0
        self.timeout_steps = int(pack["termination"]["timeoutSteps"])
        self._collision_flags = np.zeros(num_envs, dtype=bool)
        self._episode_final = {}
        # The reward is a validated vocabulary formula, not a fixed expression.
        # A pack that declares `rewardFormula` gets exactly that; a legacy pack
        # gets its `reward` map expanded by the resolver into the same form, so a
        # single evaluation path serves both.
        self.reward_formula = pack.get("rewardFormula")
        if not self.reward_formula:
            raise ValueError(
                "pack carries no rewardFormula; resolve the pack through "
                "scripts/resolve-task-pack.mjs so the legacy `reward` map is expanded"
            )
        self._reward_tracker = VectorRewardTracker(num_envs)
        self._prev_distance = np.zeros(num_envs, dtype=np.float32)
        # Per-term totals, so a run can report what each term actually paid
        # rather than only the sum.
        self.reward_term_totals = {}
        self.reset()

    def _sample_obstacles(self):
        obstacles = []
        spec = (self.pack.get("workspace") or {}).get("obstacles") or {}
        spread = float((self.pack.get("workspace") or {}).get("bound") or 1.5)
        for _ in range(int(spec.get("count", 0))):
            obstacles.append((float(self.rng.uniform(-spread, spread)),
                              float(self.rng.uniform(-spread, spread)),
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
        self.odom[:, :] = 0.0
        self.odom[:, 2] = self.state[:, 2]
        self._obs_initialized[:] = False
        self.steps[:] = 0
        self._collision_flags[:] = False
        for env_idx in range(self.num_envs):
            self.domain[env_idx] = DomainParams.sample(self.rng, self.pack.get("domainRandomization"))
            self.action_fifo[env_idx].clear()
            latency = max(0, int(self.domain[env_idx].latency_steps))
            self.action_fifo[env_idx].extend([(0.0, 0.0)] * latency)
            self._queue_latency[env_idx] = latency
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
        latency = max(0, int(domain.latency_steps))
        # Domain parameters are normally episode-scoped.  Keep direct
        # evaluation/tests safe when a caller injects a pinned envelope after
        # reset by restarting the queue with the matching zero prefix.
        if int(self._queue_latency[env_idx]) != latency:
            fifo.clear()
            fifo.extend([(0.0, 0.0)] * latency)
            self._queue_latency[env_idx] = latency
        fifo.append((linear, angular))
        # Latency: execute the command from N steps ago.  The zero prefix
        # makes the first N calls safe zero commands and applies command k at
        # step k+N.
        delayed = fifo.popleft()
        target_v, target_w = delayed
        # First-order actuator lag toward the delayed target, scaled by the
        # motor gain (a weak motor converges to a slower top speed).
        alpha = self.control_dt / max(domain.lag_tau, 1e-6)
        alpha = min(alpha, 1.0)
        v_lag = self.state[env_idx, 6] + alpha * (target_v * domain.motor_gain - self.state[env_idx, 6])
        w_lag = self.state[env_idx, 7] + alpha * (target_w * domain.motor_gain - self.state[env_idx, 7])
        self.state[env_idx, 6] = v_lag
        self.state[env_idx, 7] = w_lag
        # True body motion: wheel speeds degrade by slip, and an unmodeled
        # rotation bias veers the chassis (wheel scrub, uneven floor).
        yaw = self.state[env_idx, 2] + (w_lag + domain.angular_bias) * self.control_dt
        yaw = (yaw + math.pi) % (2.0 * math.pi) - math.pi
        self.state[env_idx, 2] = yaw
        self.state[env_idx, 0] += v_lag * domain.slip_scale * math.cos(yaw) * self.control_dt
        self.state[env_idx, 1] += v_lag * domain.slip_scale * math.sin(yaw) * self.control_dt
        # Odometry: integrates the wheel-reported velocities — slip- and
        # bias-blind, so the believed pose drifts from the true pose.
        odom_yaw = self.odom[env_idx, 2] + w_lag * self.control_dt
        odom_yaw = (odom_yaw + math.pi) % (2.0 * math.pi) - math.pi
        self.odom[env_idx, 2] = odom_yaw
        self.odom[env_idx, 0] += v_lag * math.cos(odom_yaw) * self.control_dt
        self.odom[env_idx, 1] += v_lag * math.sin(odom_yaw) * self.control_dt

    def step(self, action):
        """Advance all envs one control step. Returns (obs, reward, done,
        success_mask); auto-reset keeps rollouts dense and records episode
        outcomes for the curriculum.

        Episodes terminate on goal reach, obstacle collision, timeout, or the
        TRUE pose leaving workspace.bound (the arena edge an operator or
        safety layer would stop the robot at — also caps how far the drifting
        odometry input can wander, which keeps the value targets bounded).
        Episode terminal state is captured BEFORE the auto-reset so
        evaluation reads the real final distance and collision, not the
        resampled state.
        """
        goal_eps = float(self.pack["termination"]["goalDistance"])
        workspace_bound = float((self.pack.get("workspace") or {}).get("bound") or 0.0)
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
        collision_now = np.zeros(self.num_envs, dtype=bool)
        for env_idx in range(self.num_envs):
            collided = self._collided(env_idx)
            collision_now[env_idx] = collided
            if collided:
                self._collision_flags[env_idx] = True
        success = distance < goal_eps
        if workspace_bound > 0.0:
            out_of_bound = (np.abs(self.state[:, 0]) > workspace_bound) | (
                np.abs(self.state[:, 1]) > workspace_bound
            )
        else:
            out_of_bound = np.zeros(self.num_envs, dtype=bool)

        # The reward is the pack's validated vocabulary formula, evaluated
        # vectorised. Every term the pack declared is measured here; a term this
        # environment cannot measure was already refused at resolve time, so an
        # absent feature means "not measured this step", never "silently skipped".
        features = {
            "progress": distance,
            "goal_reach": success.astype(np.float32),
            "collision": collision_now.astype(np.float32),
            "action_magnitude": np.mean(
                np.abs(np.clip(action, -1.0, 1.0)), axis=1
            ).astype(np.float32),
            # Dwell is the same distance check the success rule uses on hardware.
            # Progress reward alone is flat on an orbit around the goal (per-step
            # distance deltas cancel), which trains limit cycles that never
            # settle -- observed as nominal 0% with min-distance 0.16 m against a
            # 0.12 m goal.
            "goal_hold": (distance < goal_eps * 1.5).astype(np.float32),
        }
        previous = {"progress": previous_distance}
        rewards, contributions = evaluate_formula_vector(
            self.reward_formula,
            features,
            previous=previous,
            tracker=self._reward_tracker,
            iteration=int(self.pack.get("_iteration", 0)),
        )
        for name, values in contributions.items():
            self.reward_term_totals[name] = (
                self.reward_term_totals.get(name, 0.0) + float(np.sum(values))
            )
        done = success | collision_now | out_of_bound | (
            self.steps >= self.timeout_steps
        )
        # Curriculum + auto-reset for finished episodes.
        reset_indices = np.nonzero(done)[0]
        # A rate-limited payment is per episode, so nothing may carry over into
        # the next one -- otherwise a fresh episode could inherit the slew
        # position and the bonus could be collected twice.
        self._reward_tracker.reset(reset_indices)
        self._episode_final = {}
        for env_idx in reset_indices:
            self._episode_final[env_idx] = {
                "finalDistance": float(distance[env_idx]),
                "collision": bool(self._collision_flags[env_idx]),
            }
            self.success_history.append(bool(success[env_idx]))
        obs = self.observe()
        for env_idx in reset_indices:
            lo, hi = self.goal_distance
            angles = self.rng.uniform(0.0, 2.0 * math.pi)
            distance_value = self.rng.uniform(lo, hi)
            self.state[env_idx, 0] = 0.0
            self.state[env_idx, 1] = 0.0
            self.state[env_idx, 2] = self.rng.uniform(-math.pi, math.pi)
            self.state[env_idx, 3] = distance_value * np.cos(angles)
            self.state[env_idx, 4] = distance_value * np.sin(angles)
            self.state[env_idx, 5:] = 0.0
            self.odom[env_idx, :] = 0.0
            self.odom[env_idx, 2] = self.state[env_idx, 2]
            self._obs_initialized[env_idx] = False
            self.last_obs[env_idx, :] = 0.0
            self.steps[env_idx] = 0
            self._collision_flags[env_idx] = False
            self.domain[env_idx] = DomainParams.sample(self.rng, self.pack.get("domainRandomization"))
            self.action_fifo[env_idx].clear()
            latency = max(0, int(self.domain[env_idx].latency_steps))
            self.action_fifo[env_idx].extend([(0.0, 0.0)] * latency)
            self._queue_latency[env_idx] = latency
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
        # Frame dropout: with per-episode probability the whole observation
        # repeats the previous frame — exactly what the board runtime does
        # when a sensor publish is missed (last good frame). All fresh-noise
        # draws happen first so the RNG call order stays deterministic.
        for env_idx in range(self.num_envs):
            if (self._obs_initialized[env_idx]
                    and self.rng.random() < self.domain[env_idx].odom_dropout):
                out[env_idx] = self.last_obs[env_idx]
            else:
                self._obs_initialized[env_idx] = True
            self.last_obs[env_idx] = out[env_idx]
        return out

    def observe_one(self, env_idx):
        domain = self.domain[env_idx]
        x, y, yaw, gx, gy = self.state[env_idx, :5]
        odom_x, odom_y, odom_yaw = self.odom[env_idx]
        v_lag = float(self.state[env_idx, 6])
        w_lag = float(self.state[env_idx, 7])
        if self.observation_size == 8:
            # Native board layout: x, y, sin, cos, dx, dy, v, w — pose from
            # odometry (the robot's own belief), goal delta derived from the
            # same noisy pose so frame internals stay self-consistent.
            noisy_x = odom_x + self.rng.normal(0.0, domain.odom_noise)
            noisy_y = odom_y + self.rng.normal(0.0, domain.odom_noise)
            return np.asarray([
                noisy_x, noisy_y,
                math.sin(odom_yaw), math.cos(odom_yaw),
                gx - noisy_x, gy - noisy_y,
                v_lag, w_lag + self.rng.normal(0.0, domain.gyro_noise),
            ], dtype=np.float32)
        # Generic 42D layout: [gyro(3), gravity(3), last command(2),
        # body-frame goal delta(2), twist(2), zeros(30)]. The gyro measures
        # TRUE body angular rate (so the rotation bias is visible here, the
        # only place it is); the goal delta is the odom-pose delta rotated
        # into the chassis frame (derivable on hardware from the odom pose
        # + goal): a goal-relative direction the policy can steer toward
        # without an explicit yaw slot. Without this rotation the
        # world-frame delta is unlearnable — no heading information exists
        # anywhere else in the layout.
        out = np.zeros(self.observation_size, dtype=np.float32)
        out[0:3] = self.rng.normal(0.0, domain.gyro_noise, size=3)
        out[2] += w_lag + domain.angular_bias
        out[3:6] = (0.0, 0.0, -1.0)  # projected gravity, upright chassis
        out[6:8] = (v_lag / self.max_linear if self.max_linear else 0.0,
                    w_lag / self.max_angular if self.max_angular else 0.0)
        world_dx = gx - odom_x
        world_dy = gy - odom_y
        cos_yaw = math.cos(odom_yaw)
        sin_yaw = math.sin(odom_yaw)
        out[8:10] = (cos_yaw * world_dx + sin_yaw * world_dy,
                     -sin_yaw * world_dx + cos_yaw * world_dy)
        out[10:12] = (v_lag, w_lag)
        return out

    def rollout_episode(self, model, device, seed, domain, deterministic=True, squashed=False):
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
        final_distance = None
        action_change_sq = []
        previous_action = None
        with torch.no_grad():
            obs_tensor = torch.from_numpy(obs).to(device)
            for step in range(single.timeout_steps):
                action, _ = model.act(obs_tensor, deterministic=deterministic, squashed=squashed)
                action_np = action.cpu().numpy()
                if previous_action is not None:
                    delta = action_np[0] - previous_action
                    action_change_sq.append(float(np.dot(delta, delta)))
                previous_action = action_np[0]
                next_obs, reward, done, success = single.step(action_np)
                # Read the terminal state captured BEFORE the auto-reset —
                # single.step() resamples collision flags and pose the moment
                # an episode finishes, so post-reset reads always look clean.
                term = single._episode_final.get(0)
                step_collided = bool(term["collision"]) if (done[0] and term) else bool(single._collision_flags[0])
                if done[0] and term:
                    final_distance = term["finalDistance"]
                rows.append({
                    "t": round(steps * self.control_dt, 4),
                    "observation": [round(float(v), 6) for v in obs[0]],
                    "action": [round(float(v), 6) for v in action_np[0]],
                    "reward": round(float(reward[0]), 6),
                    "done": bool(done[0]),
                    "fall": step_collided,
                })
                obs = next_obs
                obs_tensor = torch.from_numpy(obs).to(device)
                steps += 1
                collided = collided or step_collided
                reached = reached or bool(success[0])
                if done[0]:
                    break
        if final_distance is None:
            final_distance = float(np.hypot(single.state[0, 3] - single.state[0, 0],
                                            single.state[0, 4] - single.state[0, 1]))
        return {
            "rows": rows,
            "success": reached,
            "collision": collided,
            "steps": steps,
            "finalDistance": final_distance,
            # None for a one-step episode: a single sample has no change to
            # describe, and reporting 0.0 would read as "perfectly smooth".
            "actionChangeRms": (
                float(np.sqrt(np.mean(action_change_sq))) if action_change_sq else None
            ),
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

    def act(self, obs, deterministic=False, squashed=False):
        dist = self.distribution(obs)
        if squashed:
            # SAC uses a tanh-squashed Gaussian.  Keeping this opt-in leaves
            # the historical PPO log-prob contract untouched while ensuring
            # every SAC action seen by the critic and environment is bounded
            # by the same [-1, 1] actuator contract.
            latent = dist.mean if deterministic else dist.rsample()
            action = torch.tanh(latent)
            logp = (
                dist.log_prob(latent)
                - torch.log(1.0 - action.pow(2) + 1e-6)
            ).sum(-1)
            return action, logp
        action = dist.mean if deterministic else dist.sample()
        return action.clamp(-1.0, 1.0), dist.log_prob(action.clamp(-1.0, 1.0)).sum(-1)

    def sac_action(self, obs, deterministic=False):
        """Return a bounded SAC action and its tanh-corrected log-probability."""
        return self.act(obs, deterministic=deterministic, squashed=True)


def evaluate_policy(model, joint_count, command_size, control_dt, physics_dt, decimation,
                    seed, episodes=EVAL_EPISODES, collect_jsonl=False, squashed=False):
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
    # Action-change RMS is the "is this actually usable motion?" figure that a
    # success rate cannot express: a policy can survive every episode while
    # chattering the actuators. It costs one subtraction per step because the
    # loop already holds both actions, and it is reported for whatever policy is
    # evaluated, so a task can gate on smoothness and compare against a baseline.
    action_change_sq = []
    with torch.no_grad():
        for episode in range(episodes):
            env.reset()
            obs = torch.from_numpy(env.observe()).to(device)
            episode_return = 0.0
            steps = 0
            fell = False
            previous_action = None
            for step in range(EPISODE_CONTROL_STEPS):
                action, _ = model.act(obs, deterministic=True, squashed=squashed)
                if previous_action is not None:
                    delta = action - previous_action
                    action_change_sq.append(float((delta * delta).sum().item()))
                previous_action = action
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
        "actionChangeRms": (
            float(np.sqrt(np.mean(action_change_sq))) if action_change_sq else None
        ),
        "jsonl": jsonl_rows,
    }


def measure_control_latency_ms(model, obs_size, control_dt, squashed=False):
    """Single-sample inference latency for the one-thread CPU budget."""
    model.eval()
    sample = torch.zeros(1, obs_size)
    with torch.no_grad():
        model.act(sample, deterministic=True, squashed=squashed)  # warm-up
        timings = []
        for _ in range(32):
            started = time.perf_counter()
            model.act(sample, deterministic=True, squashed=squashed)
            timings.append((time.perf_counter() - started) * 1000.0)
    return round(float(np.median(timings)), 3)


def export_onnx(model, obs_size, act_size, path, squashed=False):
    model.eval()
    dummy = torch.zeros(1, obs_size)

    class ActorOnly(torch.nn.Module):
        def __init__(self, ac):
            super().__init__()
            self.ac = ac

        def forward(self, observation):
            mu, _ = self.ac.forward(observation)
            return torch.tanh(mu) if squashed else mu.clamp(-1.0, 1.0)

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
    # torch>=2.9 emits IR 10 and (even for tiny models) external-data tensors.
    # Board runtimes ship onnxruntime 1.16.x (IR <= 9) and the platform stages a
    # single self-contained policy.onnx, so normalize both right after export
    # instead of relying on every consumer to patch or carry a .data sibling.
    import onnx

    exported = onnx.load(path)
    if exported.ir_version > 9:
        exported.ir_version = 9
    onnx.save(exported, path)
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
            # Log-space guard: clamp the log-ratio so a pathological tail
            # (ratio ~ e^30) can never reach the unclamped PPO branch, whose
            # gradient would overflow into NaN weights. Healthy ratios are
            # untouched (|logp diff| stays O(1)).
            ratio = (new_logp - mb_logp).clamp(-20.0, 20.0).exp()
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


# ---------------------------------------------------------------------------
# Off-policy alternative: SAC. Same ActorCritic backbone, same ONNX export
# contract, same evaluators — only the update rule changes, so an algorithm
# A/B comparison (request.training.algorithm) is honest: both learners see
# the same env, budget, and evaluation protocol.
# ---------------------------------------------------------------------------
SAC_HYPERPARAMS = {
    "gamma": 0.99,
    # Polyak averaging rate for the target critic/value network.
    "tau": 0.005,
    # Entropy temperature tuning: alpha minimizes J(alpha) = E[-log pi - H·alpha],
    # target entropy is -dim(A) (SAC's standard heuristic for bounded torque
    # commands). A fixed alpha would need per-task hand tuning.
    "targetEntropyScale": 1.0,
    "actorLr": 3e-4,
    "criticLr": 3e-4,
    "alphaLr": 3e-4,
    # Replayed transitions per gradient step.
    "batchSize": 256,
    # Gradient steps per iteration: min(updatesPerStep * rollout_steps,
    # maxUpdatesPerIteration). One update per collected step-column keeps the
    # CPU starter inside its budget; the cap bounds the worst case at large
    # rollout lengths. Both numbers land in training-summary.json so the
    # update-to-data ratio is auditable, not implied.
    "updatesPerStep": 1,
    "maxUpdatesPerIteration": 32,
    # Replay capacity. 8192 transitions ≈ 64 envs × 128 steps, one full PPO
    # rollout — the CPU starter trains short-horizon tasks that do not need
    # a larger buffer, and memory stays bounded on the worker.
    "replayCapacity": 8192,
    "warmupSteps": 512,
    "initAlpha": 0.2,
}


class ReplayBuffer:
    """Fixed-capacity uniform replay over (obs, action, reward, next_obs, done).

    done=1 marks a true terminal (bootstrapping must stop); auto-reset
    transitions after a done are stored with done=1 so the target y stops at
    the terminal reward — identical semantics to the PPO GAE reset mask.
    """

    def __init__(self, capacity, obs_size, act_size, device):
        self.capacity = int(capacity)
        self.device = device
        self.obs = torch.zeros((self.capacity, obs_size))
        self.actions = torch.zeros((self.capacity, act_size))
        self.rewards = torch.zeros(self.capacity)
        self.next_obs = torch.zeros((self.capacity, obs_size))
        self.dones = torch.zeros(self.capacity)
        self.index = 0
        self.size = 0

    def push_batch(self, obs, actions, rewards, next_obs, dones):
        """Append one vectorized step (numpy arrays, [num_envs, ...])."""
        count = obs.shape[0]
        for row in range(count):
            slot = self.index
            self.obs[slot] = torch.from_numpy(obs[row])
            self.actions[slot] = torch.from_numpy(actions[row])
            self.rewards[slot] = float(rewards[row])
            self.next_obs[slot] = torch.from_numpy(next_obs[row])
            self.dones[slot] = float(bool(dones[row]))
            self.index = (self.index + 1) % self.capacity
            self.size = min(self.size + 1, self.capacity)

    def sample(self, batch_size, generator=None):
        upper = self.size if self.size > 0 else 1
        indices = torch.randint(0, upper, (min(batch_size, self.size),), generator=generator)
        return (
            self.obs[indices].to(self.device),
            self.actions[indices].to(self.device),
            self.rewards[indices].to(self.device),
            self.next_obs[indices].to(self.device),
            self.dones[indices].to(self.device),
        )


class SacLearner:
    """SAC learner over the shared ActorCritic backbone.

    The critic is a twin-Q head grafted onto the same trunk (twinQ1/twinQ2
    plus a target copy updated by Polyak averaging). SAC uses a
    tanh-squashed Gaussian during learning and deterministic tanh(mean) for
    evaluation/export; the Q heads are never exported.
    """

    def __init__(self, model, obs_size, act_size, device, hyperparams=None):
        hp = dict(SAC_HYPERPARAMS)
        if hyperparams:
            hp.update(hyperparams)
        self.hp = hp
        self.model = model
        self.device = device
        self.act_size = act_size
        self.log_alpha = torch.tensor(math.log(hp["initAlpha"]), device=device, requires_grad=True)
        self.target_entropy = -hp["targetEntropyScale"] * act_size
        self.actor_opt = torch.optim.Adam(model.parameters(), lr=hp["actorLr"])
        # Twin-Q heads live outside the PPO-shaped ActorCritic so the shared
        # trunk serves both algorithms; they are never exported (deployment
        # only ever consumes the deterministic actor).
        self.q1 = _TwinQ(obs_size, act_size).to(device)
        self.q2 = _TwinQ(obs_size, act_size).to(device)
        self.critic_opt = torch.optim.Adam(
            list(self.q1.parameters()) + list(self.q2.parameters()), lr=hp["criticLr"]
        )
        self.alpha_opt = torch.optim.Adam([self.log_alpha], lr=hp["alphaLr"])
        self.target_q1 = _TwinQ(obs_size, act_size).to(device)
        self.target_q2 = _TwinQ(obs_size, act_size).to(device)
        for target, source in ((self.target_q1, self.q1), (self.target_q2, self.q2)):
            target.load_state_dict(source.state_dict())
            for parameter in target.parameters():
                parameter.requires_grad_(False)

    def alpha(self):
        return self.log_alpha.exp()

    def update(self, buffer, rng):
        """One gradient step from a uniform replay batch; returns loss dict."""
        obs, action, reward, next_obs, done = buffer.sample(self.hp["batchSize"], generator=rng)
        with torch.no_grad():
            # SAC's policy is a tanh-squashed Gaussian.  The correction term
            # in sac_action keeps the entropy target in the bounded action
            # space actually consumed by the environment.
            next_action, next_logp = self.model.sac_action(next_obs)
            q1_target = self.target_q1(next_obs, next_action)
            q2_target = self.target_q2(next_obs, next_action)
            soft_value = torch.min(q1_target, q2_target) - self.alpha().detach() * next_logp
            y = reward + self.hp["gamma"] * (1.0 - done) * soft_value
        q1_error = (self.q1(obs, action) - y).pow(2)
        q2_error = (self.q2(obs, action) - y).pow(2)
        critic_loss = (q1_error + q2_error).mean()
        self.critic_opt.zero_grad()
        critic_loss.backward()
        self.critic_opt.step()
        self._sync_targets()

        sampled, logp = self.model.sac_action(obs)
        # Do not detach the sampled action: SAC's actor gradient must flow
        # through Q(s, a).  Freeze critic parameters for this phase so the
        # actor update does not accumulate an unused critic gradient.
        for parameter in (*self.q1.parameters(), *self.q2.parameters()):
            parameter.requires_grad_(False)
        actor_loss = (self.alpha().detach() * logp - torch.min(
            self.q1(obs, sampled), self.q2(obs, sampled)
        )).mean()
        self.actor_opt.zero_grad()
        actor_loss.backward()
        torch.nn.utils.clip_grad_norm_(self.model.parameters(), PPO_HYPERPARAMS["maxGradNorm"])
        self.actor_opt.step()
        for parameter in (*self.q1.parameters(), *self.q2.parameters()):
            parameter.requires_grad_(True)

        alpha_loss = -(self.log_alpha * (logp.detach() + self.target_entropy)).mean()
        self.alpha_opt.zero_grad()
        alpha_loss.backward()
        self.alpha_opt.step()
        return {
            "criticLoss": float(critic_loss.detach()),
            "actorLoss": float(actor_loss.detach()),
            "alpha": float(self.alpha().detach()),
        }

    def _sync_targets(self):
        tau = self.hp["tau"]
        for target, source in ((self.target_q1, self.q1), (self.target_q2, self.q2)):
            for target_parameter, source_parameter in zip(target.parameters(), source.parameters()):
                target_parameter.mul_(1.0 - tau).add_(source_parameter, alpha=tau)


class _TwinQ(torch.nn.Module):
    def __init__(self, obs_size, act_size, hidden=128):
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(obs_size + act_size, hidden),
            torch.nn.ReLU(),
            torch.nn.Linear(hidden, hidden),
            torch.nn.ReLU(),
            torch.nn.Linear(hidden, 1),
        )

    def forward(self, obs, action):
        return self.net(torch.cat([obs, action], dim=-1)).squeeze(-1)


def collect_rollout(model, env, rollout_steps, device, step_fn):
    """Gather one PPO rollout from a vectorized env via step_fn(actions)->(reward, done).

    PPO trains on the UNCLAMPED sampled action with its own log-prob; the
    env saturates the command at execution. Scoring the clamped point under
    a drifting Gaussian mean is a log-prob cliff (mu far outside [-1, 1]
    makes log_prob(+-1) astronomically negative), which is what blew the
    importance ratio up to 1e28 and NaN'd the network once the navigation
    task pushed means toward saturation.
    """
    batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done = [], [], [], [], [], []
    obs = torch.from_numpy(env.observe()).to(device)
    for _ in range(rollout_steps):
        with torch.no_grad():
            dist = model.distribution(obs)
            raw_action = dist.sample()
            logp = dist.log_prob(raw_action).sum(-1)
            value = model.forward(obs)[1]
        reward, done = step_fn(raw_action.clamp(-1.0, 1.0).cpu().numpy())
        batch_obs.append(obs)
        batch_act.append(raw_action)
        batch_logp.append(logp)
        batch_val.append(value)
        batch_rew.append(torch.from_numpy(reward.astype(np.float32)).to(device))
        batch_done.append(torch.from_numpy(done.astype(np.float32)).to(device))
        obs = torch.from_numpy(env.observe()).to(device)
    return batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done


def requested_algorithm(training):
    """Read request.training.algorithm with the same fail-loud contract as
    the TS normalizer: unknown values raise, absence means PPO (the
    platform default since the first engine build)."""
    value = (training or {}).get("algorithm")
    if value is None:
        return "ppo"
    text = str(value).strip().lower()
    if text not in ("ppo", "sac"):
        raise ValueError("training.algorithm must be 'ppo' or 'sac' (got {!r})".format(value))
    return text


def sac_collect(model, env, rollout_steps, device, step_fn):
    """Gather one SAC transition batch.

    SAC stores the bounded tanh-squashed action it actually sampled (log_prob
    is recomputed analytically in the update, so no logp column is needed
    here). The explicit clamp at the environment boundary is only a final
    numerical guard. step_fn(actions) -> (next_obs, reward, done).
    """
    obs = env.observe()
    obs_list, act_list, rew_list, done_list, next_list = [], [], [], [], []
    for _ in range(rollout_steps):
        with torch.no_grad():
            action, _ = model.sac_action(torch.from_numpy(obs).to(device))
        # sac_action is already bounded; keep the explicit clamp as a final
        # numerical guard before crossing the environment boundary.
        action_np = action.clamp(-1.0, 1.0).cpu().numpy()
        next_obs, reward, done = step_fn(action_np)
        obs_list.append(obs)
        act_list.append(action.cpu().numpy())
        rew_list.append(reward)
        done_list.append(done)
        next_list.append(next_obs)
        obs = next_obs
    return (
        np.concatenate(obs_list, axis=0),
        np.concatenate(act_list, axis=0),
        np.stack(rew_list, axis=0).reshape(-1),
        np.stack(done_list, axis=0).reshape(-1),
        np.concatenate(next_list, axis=0),
    )


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
    # Seed torch's global RNG from the pack seed: model init, action
    # sampling, and DataLoader shuffle all consume it. Without this the
    # same request trains a different policy in every process — the env
    # alone was seeded, the learner never was.
    torch.manual_seed(seed)
    if requested_device.type == "cuda":
        torch.cuda.manual_seed_all(seed)
    np.random.seed(seed % (2 ** 31))
    algorithm = requested_algorithm(training)
    stdout(
        "engine=start task={} profile={} algorithm={} iters={} envs={} steps={} obs={} act={} control={}Hz device={}{}".format(
            pack["id"], profile, algorithm, iterations, num_envs, rollout_steps, obs_size, act_size, control_hz,
            requested_device.type, " ({})".format(device_name) if device_name != "cpu" else "",
        )
    )

    env = GoalNavEnv(pack, num_envs, seed=seed)
    device = requested_device
    model = ActorCritic(obs_size, act_size).to(device)
    to_tensor = lambda array: torch.from_numpy(array).to(device)  # noqa: E731 - local shim
    model_opt = torch.optim.Adam(model.parameters(), lr=PPO_HYPERPARAMS["actorLr"]) if algorithm != "sac" else None
    if algorithm == "sac":
        # SAC trains the SAME actor trunk through the learner; the PPO critic
        # head stays present (ActorCritic is shared) but is updated only as
        # part of the composite backbone gradient — the Q target supplies the
        # value signal instead of the head's MSE.
        learner = SacLearner(model, obs_size, act_size, device)
        buffer = ReplayBuffer(SAC_HYPERPARAMS["replayCapacity"], obs_size, act_size, device)
        replay_rng = torch.Generator(device="cpu")
        replay_rng.manual_seed(seed)

    reward_curve = []
    success_curve = []
    sac_curve = []
    # Periodic checkpoints (Playground-style): a mid-training crash used to
    # lose everything, and the final iteration is not necessarily the best
    # policy. Keep the last state per interval and pick the export candidate
    # by measured eval performance, never by "it was last".
    checkpoint_dir = "checkpoints"
    os.makedirs(checkpoint_dir, exist_ok=True)
    checkpoint_every = max(1, iterations // 8)
    saved_checkpoints = []
    started = time.time()
    for iteration in range(iterations):
        if algorithm == "sac":
            batch_obs, batch_act, batch_rew, batch_done, batch_next_obs = sac_collect(
                model, env, rollout_steps, device,
                lambda actions: (lambda result: (result[0], result[1], result[2]))(env.step(actions)),
            )
            buffer.push_batch(batch_obs, batch_act, batch_rew, batch_next_obs, batch_done)
            if buffer.size >= SAC_HYPERPARAMS["warmupSteps"]:
                updates = min(
                    SAC_HYPERPARAMS["updatesPerStep"] * rollout_steps,
                    SAC_HYPERPARAMS["maxUpdatesPerIteration"],
                )
                for _ in range(updates):
                    losses = learner.update(buffer, replay_rng)
                sac_curve.append(round(losses["alpha"], 4))
            rewards = torch.from_numpy(batch_rew.astype(np.float32))
        else:
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
                model,
                model_opt,
                torch.cat(batch_obs), torch.cat(batch_act), torch.cat(batch_logp),
                (returns - values).reshape(-1), returns.reshape(-1), device,
            )
        reward_curve.append(round(float(rewards.mean()), 4))
        recent = env.success_history[-50:]
        success_curve.append(round(sum(recent) / len(recent), 3) if recent else 0.0)
        if (iteration + 1) % checkpoint_every == 0 or (iteration + 1) == iterations:
            try:
                ckpt_path = os.path.join(checkpoint_dir, "iter-{:05d}.pt".format(iteration + 1))
                torch.save(
                    {
                        "iteration": iteration + 1,
                        "model_state": model.state_dict(),
                        "algorithm": algorithm,
                        "rewardCurveTail": reward_curve[-8:],
                        "successCurveTail": success_curve[-8:],
                        "obsSize": obs_size,
                        "actSize": act_size,
                    },
                    ckpt_path,
                )
                saved_checkpoints.append(ckpt_path)
                stdout(
                    "checkpoint saved: {} (iter {}, recentSuccess={:.2f})".format(
                        ckpt_path, iteration + 1, success_curve[-1]
                    )
                )
            except Exception as error:  # noqa: BLE001 - checkpointing is best-effort
                stdout("checkpoint save failed: {}".format(error))
        if (iteration + 1) % max(1, iterations // 8) == 0:
            stdout(
                "iter {}/{} meanReward={:.3f} recentSuccess={:.2f} goalRange=[{:.2f},{:.2f}] elapsed={:.1f}s".format(
                    iteration + 1, iterations, rewards.mean(),
                    success_curve[-1], env.goal_distance[0], env.goal_distance[1], time.time() - started,
                )
            )

    # ---- evaluation under pinned envelopes ----
    envelopes = (pack.get("domainRandomization") or {}).get("evalEnvelopes") or {}
    eval_cfg = pack.get("evaluationConfig") or {}
    episodes_per_envelope = clamp_int(eval_cfg.get("episodesPerEnvelope"), 1, 200, 50)
    confidence = float(eval_cfg.get("confidenceLevel", 0.95))
    eval_seed = seed + 1000
    # ---- best-checkpoint selection (probe, don't trust "last") ----
    # The pinned-envelope report and the ONNX export below must use the best
    # measured policy, not merely the newest one. Probe the late checkpoints
    # (the final iteration is always checkpointed, so it stays in the race)
    # with a light evaluation and promote the winner into `model`. Any
    # failure leaves the untouched final weights in place.
    best_checkpoint = {
        "saved": len(saved_checkpoints),
        "selectedIteration": iterations,
        "probedIterations": [],
        "probeScore": None,
        "probeEpisodesPerEnvelope": 0,
    }
    if len(saved_checkpoints) > 1:
        probe_episodes = 4
        probe_seed = seed + 2000
        candidates = []
        for path in saved_checkpoints[-4:]:
            try:
                ckpt = torch.load(path, map_location=device)
                candidate = ActorCritic(obs_size, act_size).to(device)
                candidate.load_state_dict(ckpt["model_state"])
                probe = evaluate_goal_navigation(
                    candidate, env, device, envelopes, probe_seed,
                    episodes_per_envelope=probe_episodes, confidence=confidence,
                    squashed=algorithm == "sac",
                )
                success_scores = [
                    float((metrics or {}).get("successRate", 0.0))
                    for metrics in probe["envelopes"].values()
                ]
                collision_scores = [
                    float((metrics or {}).get("collisionRate", 0.0))
                    for metrics in probe["envelopes"].values()
                ]
                candidates.append(
                    {
                        "iteration": int(ckpt.get("iteration", 0)),
                        "state": ckpt["model_state"],
                        "success": sum(success_scores) / len(success_scores) if success_scores else 0.0,
                        "collisions": sum(collision_scores) / len(collision_scores) if collision_scores else 0.0,
                    }
                )
                best_checkpoint["probedIterations"].append(candidates[-1]["iteration"])
            except Exception as error:  # noqa: BLE001 - a bad checkpoint must not fail the run
                stdout("checkpoint probe failed for {}: {}".format(path, error))
        if candidates:
            # Rank by probe success, then collision rate, then iteration: on
            # ties the LATEST checkpoint wins, so the probe can promote a
            # better older snapshot but never silently regress to a weaker
            # one on a measurement tie.
            winner = sorted(
                candidates,
                key=lambda item: (-item["success"], item["collisions"], -item["iteration"]),
            )[0]
            best_checkpoint["selectedIteration"] = winner["iteration"]
            best_checkpoint["probeScore"] = round(winner["success"], 4)
            best_checkpoint["probeEpisodesPerEnvelope"] = probe_episodes
            if winner["iteration"] != iterations:
                model.load_state_dict(winner["state"])
                stdout(
                    "best checkpoint: iter {} (probe success {:.2f} beat final iter {})".format(
                        winner["iteration"], winner["success"], iterations
                    )
                )
            else:
                stdout(
                    "best checkpoint: final iter {} (probe success {:.2f})".format(
                        iterations, winner["success"]
                    )
                )
    trained_report = evaluate_goal_navigation(
        model, env, device, envelopes, eval_seed,
        episodes_per_envelope=episodes_per_envelope, confidence=confidence,
        squashed=algorithm == "sac",
    )
    baseline_model = ActorCritic(obs_size, act_size).to(device)
    baseline_report = evaluate_goal_navigation(
        baseline_model, env, device, envelopes, eval_seed,
        episodes_per_envelope=episodes_per_envelope, confidence=confidence,
        squashed=algorithm == "sac",
    )
    latency = measure_control_latency_ms(
        model.to("cpu"), obs_size, 1.0 / control_hz, squashed=algorithm == "sac"
    )
    model = model.to(device)

    onnx_bytes = 0
    if HAVE_ONNX:
        try:
            onnx_bytes = export_onnx(
                model.to("cpu"), obs_size, act_size, "policy.onnx", squashed=algorithm == "sac"
            )
            model = model.to(device)
            stdout("exported policy.onnx ({} bytes)".format(onnx_bytes))
        except Exception as error:  # noqa: BLE001 - export failure must not lose the run
            model = model.to(device)
            stdout("ONNX export failed: {}; continuing without it".format(error))

    gate = evaluate_quality_gate(
        trained_report, pack.get("qualityGate") or {}, baseline_report
    )
    nominal = trained_report["envelopes"].get("nominal") or {}
    baseline_nominal = baseline_report["envelopes"].get("nominal") or {}
    stdout(
        "eval nominal: successRate={:.2f} [CI{:.0f}% {:.2f},{:.2f}] collisionRate={:.2f} ({} eps) "
        "(baseline {:.2f}/{:.2f}) gate={} gap={:+.2f}".format(
            nominal.get("successRate", 0.0), confidence * 100,
            nominal.get("successRateCiLow", 0.0), nominal.get("successRateCiHigh", 0.0),
            nominal.get("collisionRate", 0.0), nominal.get("episodes", 0),
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
                "algorithm": algorithm,
                "iterations": iterations,
                "numEnvs": num_envs,
                "rolloutSteps": rollout_steps,
                "seed": seed,
                "hyperparams": SAC_HYPERPARAMS if algorithm == "sac" else PPO_HYPERPARAMS,
                **({"alphaCurve": sac_curve} if algorithm == "sac" and sac_curve else {}),
                "curriculum": {
                    "initialGoalDistance": pack["curriculum"]["initialGoalDistance"],
                    "finalGoalDistance": pack["curriculum"]["finalGoalDistance"],
                    "reachedGoalDistance": [round(env.goal_distance[0], 3), round(env.goal_distance[1], 3)],
                },
                "controlHz": control_hz,
                "actionOutput": "normalized-twist" if act_size == 2 else "physical-joint",
                "rewardCurve": reward_curve,
                "successCurve": success_curve,
                "checkpoints": best_checkpoint,
                "device": requested_device.type,
                **({"deviceName": device_name} if device_name != "cpu" else {}),
                "eval": {k: v for k, v in trained_report.items() if k not in ("jsonl",)},
                "baseline": {k: v for k, v in baseline_report.items() if k not in ("jsonl",)},
                "controlLatencyMs": latency,
                "measurementStage": "host-torch",
                "sourceCommit": source_commit_short(),
                "onnxExported": bool(onnx_bytes),
                "trainingSeconds": round(time.time() - started, 1),
                "evaluationConfig": {
                    "episodesPerEnvelope": episodes_per_envelope,
                    "confidenceLevel": confidence,
                    "gateOn": str((pack.get("qualityGate") or {}).get("gateOn", "point")),
                },
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
                "measurementStage": "host-torch",
                "sourceCommit": source_commit_short(),
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
            "savedCheckpoints": len(saved_checkpoints),
            "selectedIteration": best_checkpoint["selectedIteration"],
            "selectedByProbe": best_checkpoint["probeScore"] is not None,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://starter/{}/{}/policy.onnx".format(slug_model, slug_version),
            "kind": "source",
            "format": "onnx" if onnx_bytes else "unknown",
            **({"runtime": "cpu-onnx", "workload": "goal-navigation", "threads": 1} if onnx_bytes else {}),
            **({"sizeBytes": onnx_bytes} if onnx_bytes else {}),
            "actionOutput": "normalized-twist" if act_size == 2 else "physical-joint",
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": "starter-ppo",
            "algorithm": algorithm,
            "taskId": pack["id"],
            "taskKind": "goal-navigation",
            "observationSize": obs_size,
            "actionSize": act_size,
            "actionOutput": "normalized-twist" if act_size == 2 else "physical-joint",
            "reward": round(trained_report.get("meanReward", 0.0), 4),
            "initialReward": round(baseline_report.get("meanReward", 0.0), 4),
            "successRate": round(nominal.get("successRate", 0.0), 4),
            "successRateCiLow": round(nominal.get("successRateCiLow", 0.0), 4),
            "successRateCiHigh": round(nominal.get("successRateCiHigh", 0.0), 4),
            "evalEpisodes": nominal.get("episodes"),
            "collisionRate": round(nominal.get("collisionRate", 0.0), 4),
            "hardSuccessRate": round((trained_report["envelopes"].get("hard") or {}).get("successRate", 0.0), 4),
            "hardSuccessRateCiLow": round((trained_report["envelopes"].get("hard") or {}).get("successRateCiLow", 0.0), 4),
            "qualityGatePassed": gate["passed"],
            "controlLatencyMs": latency,
            "measurementStage": "host-torch",
            "sourceCommit": source_commit_short(),
            "iterations": iterations,
            "onnxExported": bool(onnx_bytes),
            "telemetrySamples": sum(len(rows) for rows in trained_report["jsonl"].values()),
        },
        "deployable": False,
        "source": source_revision(),
        "dependencies": dependency_versions(),
        "dependencyLockSha256": dependency_lock_digest(),
        "actionOutput": "normalized-twist" if act_size == 2 else "physical-joint",
        "cuda": requested_device.type == "cuda",
    }
    return result


def evaluate_goal_navigation(model, env, device, envelopes, seed,
                             episodes_per_envelope=50, confidence=0.95, squashed=False):
    """Evaluate an actor under each pinned envelope on a fixed seed.

    Envelope order: [motorGain, lagTauSeconds, gyroNoiseStdRadSec,
    odomNoiseStdM, angularBiasRadSec, actionLatencySteps, odomDropoutProb,
    slipScale]. Each envelope metric carries its episode count and Wilson
    95% confidence bounds — a point estimate alone (5/6, 6/6...) claims
    far more certainty than the evidence supports.
    """
    model.eval()
    report = {"envelopes": {}, "jsonl": {}, "meanReward": 0.0, "episodesPerEnvelope": episodes_per_envelope,
              "confidenceLevel": confidence}
    rewards_all = []
    for name, envelope in (envelopes or {"nominal": [1.0, 0.1, 0.01, 0.005, 0.0, 1, 0.0, 1.0]}).items():
        domain = eval_domain_params(envelope)
        successes, collisions, finals, lengths, rewards = 0, 0, [], [], []
        action_changes = []
        jsonl_rows = []
        for episode in range(episodes_per_envelope):
            episode_seed = seed * 7919 + episode
            outcome = env.rollout_episode(model, device, episode_seed, domain, squashed=squashed)
            successes += int(outcome["success"])
            collisions += int(outcome["collision"])
            finals.append(outcome["finalDistance"])
            lengths.append(outcome["steps"])
            episode_reward = sum(row["reward"] for row in outcome["rows"])
            rewards.append(episode_reward)
            if outcome.get("actionChangeRms") is not None:
                action_changes.append(outcome["actionChangeRms"])
            if episode == 0:
                jsonl_rows = outcome["rows"]
        success_ci = wilson_bounds(successes, episodes_per_envelope, confidence)
        collision_ci = wilson_bounds(collisions, episodes_per_envelope, confidence)
        report["envelopes"][name] = {
            "episodes": episodes_per_envelope,
            "successRate": successes / episodes_per_envelope,
            "successRateCiLow": round(success_ci[0], 4),
            "successRateCiHigh": round(success_ci[1], 4),
            "collisionRate": collisions / episodes_per_envelope,
            "collisionRateCiLow": round(collision_ci[0], 4),
            "collisionRateCiHigh": round(collision_ci[1], 4),
            "meanFinalDistance": round(float(np.mean(finals)), 4),
            "meanEpisodeLength": round(float(np.mean(lengths)), 2),
            "meanReward": round(float(np.mean(rewards)), 4),
            # The non-success figure a task can gate on: a policy can survive
            # every episode while chattering its actuators, and no pass/fail rate
            # expresses that.
            "actionChangeRms": (
                round(float(np.mean(action_changes)), 6) if action_changes else None
            ),
        }
        report["jsonl"][name] = jsonl_rows
        rewards_all.extend(rewards)
    if model.training:
        model.train()
    report["meanReward"] = round(float(np.mean(rewards_all)), 4) if rewards_all else 0.0
    return report


def evaluate_quality_gate(report, quality_gate, baseline=None):
    """Apply the task's quality gate to the nominal-envelope metrics.

    A gate verdict is PASS only from measured evidence — never from a
    missing metric (absent metrics fail closed). With gateOn
    "ciLowerBound" the verdict uses the Wilson confidence bounds: success
    is judged on the CI lower bound and collision on the CI upper bound,
    so a 50-episode 84% point rate no longer hides the 71% floor. Missing
    bounds under ciLowerBound fail closed, exactly like missing rates.

    Two optional criteria beyond the pass/fail rates:

    * ``maxActionChangeRms`` — a smoothness ceiling. A policy can survive every
      episode while chattering its actuators, and a success rate cannot express
      that. The figure is measured for whichever policy is evaluated.
    * ``ablation`` — the trained policy must beat the untrained baseline by
      enough to show training did something. ``requireBaseline`` additionally
      refuses a run that cannot demonstrate the comparison at all, so "we could
      not measure it" cannot be read as "it passed".
    """
    nominal = (report.get("envelopes") or {}).get("nominal") or {}
    baseline_nominal = ((baseline or {}).get("envelopes") or {}).get("nominal") or {}
    gate_on = str(quality_gate.get("gateOn", "point"))
    errors = []
    if gate_on not in ("point", "ciLowerBound"):
        errors.append("unknown gateOn {!r}".format(quality_gate.get("gateOn")))
    min_success = quality_gate.get("minSuccessRate")
    if min_success is not None:
        if gate_on == "ciLowerBound":
            success_value = nominal.get("successRateCiLow")
            label = "successRate CI low"
        else:
            success_value = nominal.get("successRate")
            label = "successRate"
        if success_value is None:
            errors.append("nominal {} missing".format(label))
        elif success_value < float(min_success):
            errors.append("{} {:.4f} below gate {:.2f}".format(label, success_value, float(min_success)))
    max_collision = quality_gate.get("maxCollisionRate")
    if max_collision is not None:
        if gate_on == "ciLowerBound":
            collision_value = nominal.get("collisionRateCiHigh")
            label = "collisionRate CI high"
        else:
            collision_value = nominal.get("collisionRate")
            label = "collisionRate"
        if collision_value is None:
            errors.append("nominal {} missing".format(label))
        elif collision_value > float(max_collision):
            errors.append("{} {:.4f} above gate {:.2f}".format(label, collision_value, float(max_collision)))
    max_action_change = quality_gate.get("maxActionChangeRms")
    action_change = nominal.get("actionChangeRms")
    if max_action_change is not None:
        if action_change is None:
            errors.append("nominal actionChangeRms missing")
        elif float(action_change) > float(max_action_change):
            errors.append(
                "actionChangeRms {:.4f} above gate {:.4f}".format(
                    float(action_change), float(max_action_change)
                )
            )
    ablation = quality_gate.get("ablation") or {}
    if isinstance(ablation, dict) and ablation:
        min_delta = ablation.get("minSuccessRateDelta")
        baseline_success = baseline_nominal.get("successRate")
        if ablation.get("requireBaseline") and not baseline_nominal:
            errors.append("ablation requires a baseline report, but none was evaluated")
        elif min_delta is not None:
            trained_success = nominal.get("successRate")
            if trained_success is None:
                errors.append("nominal successRate missing for the ablation comparison")
            elif baseline_success is None:
                errors.append("baseline successRate missing for the ablation comparison")
            elif float(trained_success) - float(baseline_success) < float(min_delta):
                errors.append(
                    "ablation: trained successRate {:.4f} minus baseline {:.4f} is below the required delta {:.4f}".format(
                        float(trained_success), float(baseline_success), float(min_delta)
                    )
                )
    return {
        "passed": not errors,
        "errors": errors,
        "criteria": {
            "minSuccessRate": min_success,
            "maxCollisionRate": max_collision,
            "gateOn": gate_on,
            **({"maxActionChangeRms": max_action_change} if max_action_change is not None else {}),
            **({"ablation": ablation} if ablation else {}),
        },
        "measured": {
            "successRate": nominal.get("successRate"),
            "collisionRate": nominal.get("collisionRate"),
            "successRateCiLow": nominal.get("successRateCiLow"),
            "collisionRateCiHigh": nominal.get("collisionRateCiHigh"),
            "episodes": nominal.get("episodes"),
            **({"actionChangeRms": action_change} if action_change is not None else {}),
            **(
                {"baselineSuccessRate": baseline_nominal.get("successRate")}
                if baseline_nominal
                else {}
            ),
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
    algorithm = requested_algorithm(training)
    stdout(
        "engine=start task=pendulum-chain-{}j profile={} algorithm={} iters={} envs={} steps={} obs={} act={} control={}Hz device={}{}".format(
            joint_count, profile, algorithm, iterations, num_envs, rollout_steps, obs_size, act_size, control_hz,
            requested_device.type, " ({})".format(device_name) if device_name != "cpu" else "",
        )
    )
    if not HAVE_ONNX:
        stdout("onnx wheel missing; ONNX export will be skipped ({})".format(ONNX_MISSING_HINT))

    torch.manual_seed(7)
    env = PendulumChain(num_envs, joint_count, command_size, seed=7)
    device = requested_device
    model = ActorCritic(obs_size, act_size).to(device)
    # One optimizer over the full parameter set (shared body + actor head +
    # critic head) with the composite PPO loss; a split optimizer adds
    # bookkeeping without changing the CPU starter result.
    model_opt = torch.optim.Adam(model.parameters(), lr=PPO_HYPERPARAMS["actorLr"]) if algorithm != "sac" else None
    to_tensor = lambda array: torch.from_numpy(array).to(device)  # noqa: E731 - local shim
    sac_learner = sac_buffer = sac_rng = None
    if algorithm == "sac":
        sac_learner = SacLearner(model, obs_size, act_size, device)
        sac_buffer = ReplayBuffer(SAC_HYPERPARAMS["replayCapacity"], obs_size, act_size, device)
        sac_rng = torch.Generator(device="cpu")
        sac_rng.manual_seed(7)
    initial_eval = evaluate_policy(
        model, joint_count, command_size, control_dt, physics_dt, decimation,
        seed=11, squashed=algorithm == "sac",
    )
    stdout(
        "eval before training: stepReward={:.3f} successRate={:.2f}".format(
            initial_eval["meanStepReward"], initial_eval["successRate"]
        )
    )

    gamma = PPO_HYPERPARAMS["gamma"]
    lam = PPO_HYPERPARAMS["gaeLambda"]
    clip = PPO_HYPERPARAMS["clip"]
    reward_curve = []
    sac_curve = []
    started = time.time()
    for iteration in range(iterations):
        if algorithm == "sac":
            obs_np = env.observe()
            obs_list, act_list, rew_list, done_list, next_list = [], [], [], [], []
            for _ in range(rollout_steps):
                with torch.no_grad():
                    action, _ = model.sac_action(to_tensor(obs_np))
                next_obs_np, reward, done, _ = env.step(
                    action.clamp(-1.0, 1.0).cpu().numpy(), physics_dt, decimation
                )
                obs_list.append(obs_np)
                act_list.append(action.cpu().numpy())
                rew_list.append(reward)
                done_list.append(done)
                next_list.append(next_obs_np)
                obs_np = next_obs_np
            sac_buffer.push_batch(
                np.concatenate(obs_list, axis=0),
                np.concatenate(act_list, axis=0),
                np.stack(rew_list, axis=0).reshape(-1),
                np.concatenate(next_list, axis=0),
                np.stack(done_list, axis=0).reshape(-1),
            )
            mean_reward = float(np.mean(np.concatenate(rew_list, axis=0)))
            if sac_buffer.size >= SAC_HYPERPARAMS["warmupSteps"]:
                updates = min(
                    SAC_HYPERPARAMS["updatesPerStep"] * rollout_steps,
                    SAC_HYPERPARAMS["maxUpdatesPerIteration"],
                )
                for _ in range(updates):
                    losses = sac_learner.update(sac_buffer, sac_rng)
                sac_curve.append(round(losses["alpha"], 4))
            reward_curve.append(round(mean_reward, 4))
            if (iteration + 1) % max(1, iterations // 8) == 0:
                stdout(
                    "iter {}/{} meanStepReward={:.3f} elapsed={:.1f}s".format(
                        iteration + 1, iterations, mean_reward, time.time() - started
                    )
                )
            continue
        batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done = [], [], [], [], [], []
        obs = to_tensor(env.observe())
        for _ in range(rollout_steps):
            with torch.no_grad():
                dist = model.distribution(obs)
                # Train on the unclamped sample (see collect_rollout): the env
                # saturates the torque at execution, and PPO's ratio needs the
                # log-prob of the point actually stored.
                action = dist.sample()
                logp = dist.log_prob(action).sum(-1)
                value = model.forward(obs)[1]
            next_obs_np, reward, done, _ = env.step(action.clamp(-1.0, 1.0).cpu().numpy(), physics_dt, decimation)
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
                # Same log-space ratio guard as ppo_update().
                ratio = (new_logp - mb_logp).clamp(-20.0, 20.0).exp()
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
        seed=11, collect_jsonl=True, squashed=algorithm == "sac",
    )
    baseline_eval = evaluate_policy(
        ActorCritic(obs_size, act_size).to(device), joint_count, command_size, control_dt, physics_dt,
        decimation, seed=11, collect_jsonl=True, squashed=algorithm == "sac",
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
    latency = measure_control_latency_ms(
        model.to("cpu"), obs_size, control_dt, squashed=algorithm == "sac"
    )
    model = model.to(device)

    onnx_bytes = 0
    if HAVE_ONNX:
        try:
            onnx_bytes = export_onnx(
                model.to("cpu"), obs_size, act_size, "policy.onnx", squashed=algorithm == "sac"
            )
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
                "algorithm": algorithm,
                "iterations": iterations,
                "numEnvs": num_envs,
                "rolloutSteps": rollout_steps,
                "hyperparams": SAC_HYPERPARAMS if algorithm == "sac" else PPO_HYPERPARAMS,
                **({"alphaCurve": sac_curve} if algorithm == "sac" and sac_curve else {}),
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
                "measurementStage": "host-torch",
                "sourceCommit": source_commit_short(),
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
            "algorithm": algorithm,
            "observationSize": obs_size,
            "actionSize": act_size,
            "reward": round(final_eval["episodeReward"], 4),
            "initialReward": round(initial_eval["episodeReward"], 4),
            "successRate": round(final_eval["successRate"], 4),
            "fallRate": round(final_eval["fallRate"], 4),
            "episodeLength": round(final_eval["episodeLength"], 2),
            "controlLatencyMs": latency,
            "measurementStage": "host-torch",
            "sourceCommit": source_commit_short(),
            "iterations": iterations,
            "onnxExported": bool(onnx_bytes),
            "telemetrySamples": len(final_eval["jsonl"]),
        },
        "deployable": False,
        "source": source_revision(),
        "dependencies": dependency_versions(),
        "dependencyLockSha256": dependency_lock_digest(),
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
    # Integrity manifest for the artifacts this run produced. Written before the
    # result so the consumer can verify the bundle it is about to trust.
    write_artifact_manifest(os.path.dirname(os.path.abspath(result_path)))

    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    stdout("wrote result with real PPO training artifacts")


if __name__ == "__main__":
    main()
