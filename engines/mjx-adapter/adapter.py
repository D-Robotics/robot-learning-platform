#!/usr/bin/env python3
"""mjx worker adapter: one file protocol, two physics backends.

Implements the platform worker protocol (read RDK_SIM2REAL_REQUEST_FILE,
write RDK_SIM2REAL_RESULT_FILE) around a pure-JAX PPO learner:

  * physicsBackend "mjx" — the real path. When mujoco + mujoco.mjx are
    importable the adapter builds a differential-drive robot (freejoint
    chassis, sphere wheels on velocity actuators, caster) whose body
    dynamics, wheel spin-up, contact friction and projected gravity come
    from MuJoCo stepped on the MJX (XLA) backend, batched across envs with
    vmap and compiled with jit. Goal/obstacle/reward semantics stay at the
    task level exactly as the starter engine defines them, so the pinned
    envelope evaluation and the Wilson-CI quality gate remain comparable
    across engines.
  * physicsBackend "starter-kinematic" — the honest fallback. Without
    mujoco the same JAX learner trains on the platform's own vectorized
    goal-navigation environment (engines/starter-ppo, which needs torch);
    the result says so (result.physicsBackend, metrics.physicsBackend) so
    nobody can mistake a kinematic run for contact-dynamics training.

The contract in the request is the one the platform validated against the
manifest, so both backends must build the env with exactly those dimensions
(observation_size, action_size, control Hz / decimation); a mismatch is a
contract violation, never a tuning choice.

Dependency policy (exit codes match the sibling adapters):
  numpy missing                     -> exit 2 (protocol dependency)
  jax or optax missing              -> exit 3 (REFUSED: never fabricate a run)
  mujoco AND torch both missing     -> exit 3 (no physics backend available)
  onnx missing                      -> export skipped, run still completes

Register with the local worker:

  RDK_SIM2REAL_TRAIN_EXECUTABLE=/path/to/python
  RDK_SIM2REAL_TRAIN_ARGS_JSON='["/abs/path/to/engines/mjx-adapter/adapter.py"]'
"""

import json
import math
import os
import sys
import time

# RDK_STARTER_ENGINE_DEVICE=cpu must reach JAX before the first jax import
# (JAX_PLATFORMS is read at import time), or the process would happily use
# whatever accelerator it finds.
_REQUESTED_DEVICE = (os.environ.get("RDK_STARTER_ENGINE_DEVICE") or "auto").strip().lower()
if _REQUESTED_DEVICE == "cpu":
    os.environ.setdefault("JAX_PLATFORMS", "cpu")

try:
    import numpy as np
except ImportError:  # pragma: no cover - environment guard
    print("adapter requires numpy: python3 -m pip install --user numpy", file=sys.stderr)
    sys.exit(2)

try:
    import jax
    import jax.numpy as jnp
    import optax
    HAVE_JAX = True
except ImportError:
    HAVE_JAX = False

try:
    import mujoco
    from mujoco import mjx
    HAVE_MJX = True
except ImportError:
    HAVE_MJX = False

try:
    import torch  # noqa: F401 - only the kinematic fallback needs it
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False

ADAPTER_ID = "mjx-ppo"

# MJX physics-timestep cap. Probe-verified on mujoco-mjx 3.13 (CPU backend):
# at dt=0.02 the MJX contact solver injects energy into this exact-touch
# 3-point stance — the chassis ends up outrunning the wheels' rolling speed
# (0.48 m/s vs 0.36 m/s) and CPU/MJX trajectories diverge by 0.4 m in 2 s.
# At dt=0.01 the two backends agree to ~2 cm over 2 s. The env compensates
# with more substeps so control timing stays exact.
_MJX_MAX_PHYSICS_DT = 0.01

# Physical-domain DR knobs (task-pack `physicalDomainRandomization`), applied
# as traced per-env scalings of the SHARED mjx model inside the vmap'd step
# (probe_mjx.py check_traced_physical_dr: vmap(step) with scaled
# geom_friction/body_mass/body_inertia/actuator_gainprm/actuator_biasprm runs
# and produces distinct trajectories). Each key defaults to [1.0, 1.0]
# (no randomization); the sampled multipliers ride in the env state next to
# the command-level domain vector.
_PHYSICAL_DR_KEYS = (
    "wheelFrictionScale", "chassisMassScale", "wheelServoKvScale",
)
_PHYSICAL_DR_DEFAULTS = {
    "wheelFrictionScale": [1.0, 1.0],
    "chassisMassScale": [1.0, 1.0],
    "wheelServoKvScale": [1.0, 1.0],
}

# Mocap obstacle sphere radius (visual radius; the task's analytic radius
# stays the termination authority). Sphere CENTER z equals the geom radius
# so the ball sits exactly on the floor — a lower center interpenetrates
# the floor and the contact solver diverges (probe-verified: z=0.05 with
# r=0.15 launches the robot to z=2.9 then NaN in 3 control steps).
_OBSTACLE_GEOM_RADIUS = 0.15
_OBSTACLE_CENTER_Z = _OBSTACLE_GEOM_RADIUS

# Mirrors engines/starter-ppo budgets: a CPU trainer must clamp instead of
# silently burning hours; the result records what actually ran.
PROFILE_BUDGETS = {
    "smoke": {"iterations": 40, "envs": 16, "steps": 128},
    "low-vram": {"iterations": 400, "envs": 32, "steps": 128},
    "standard": {"iterations": 400, "envs": 64, "steps": 128},
    "high-vram": {"iterations": 600, "envs": 128, "steps": 128},
}

# PPO hyper-parameters are the platform's calibrated starter values
# (engines/starter-ppo PPO_HYPERPARAMS) so every engine sharing the
# goal-navigation task shares one tuning story.
PPO_HYPERPARAMS = {
    "gamma": 0.99,
    "gaeLambda": 0.95,
    "clip": 0.2,
    "actorLr": 3.0e-4,
    "entropyCoef": 0.002,
    "valueCoef": 0.5,
    "epochs": 4,
    "minibatch": 256,
    "maxGradNorm": 0.5,
}

HIDDEN = 128
INIT_LOG_STD = -0.7

# Robot geometry comes from the single source of truth in
# assets/originbot/calibration.json (Menagerie-style), the same file the
# mujoco-web service builds its visual MJCF from: the two must not silently
# drift apart on the same robot.
# engines/mjx-adapter/adapter.py -> three dirname hops reach the repo root
# (two reach only engines/, where the assets package does not exist).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from assets.originbot import originbot as _originbot  # noqa: E402



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



WHEEL_RADIUS = _originbot.WHEEL_RADIUS
TRACK_WIDTH = _originbot.TRACK_WIDTH
MAX_WHEEL_SPEED = _originbot.MAX_WHEEL_SPEED
# Rest height where the wheel rims exactly touch the floor. This is NOT the
# calibration's nominal BASE_HEIGHT: with base at 0.16 the rims (center
# 0.16+offsetZ, radius 0.09) start 1 cm underground and the contact solver
# resolves that pre-loaded penetration by launching the robot — every episode
# would begin airborne. Derived from geometry so a future calibration change
# keeps the 3-point stance consistent.
REST_HEIGHT = WHEEL_RADIUS - float(_originbot.WHEELS["offsetZ"])


def stdout(line):
    print("[mjx-adapter] " + str(line), flush=True)


def clamp_int(value, low, high, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, parsed))


def env_int(name, fallback):
    return clamp_int(os.environ.get(name), 1, 2_000_000, fallback)


def safe_slug(value, fallback):
    slug = "".join(ch if (ch.isalnum() or ch in "._-") else "-" for ch in str(value)).strip("-")
    return slug[:48] or fallback


def jax_device_summary():
    kinds = []
    for device in jax.devices():
        # jax>=0.5: device_kind is the marketing name ("NVIDIA GeForce RTX
        # 5090"), which contains neither "gpu" nor "cuda" — the platform
        # attribute ("gpu"/"cpu"/"tpu") is the reliable accelerator signal.
        # Match on both so old and new jax report CUDA honestly.
        kind = (
            getattr(device, "device_kind", None)
            or getattr(device, "platform", "?")
        )
        platform = str(getattr(device, "platform", "")).lower()
        kinds.append(str(kind).lower())
        if "cuda" in platform or "gpu" in platform or "rocm" in platform:
            kinds[-1] = platform + ":" + kinds[-1]
    cuda = any(("gpu" in kind or "cuda" in kind or "rocm" in kind) for kind in kinds)
    return ",".join(kinds), cuda


# ---------------------------------------------------------------------------
# Evaluation protocol helpers for the mjx path. These mirror
# engines/starter-ppo/runner.py (wilson_bounds / eval_domain_params /
# evaluate_quality_gate) field for field: the TS release gate re-computes
# the Wilson CI from raw episode counts and cross-checks at tolerance 0.01,
# so any divergence here fails closed at the release boundary instead of
# passing silently. They are vendored (not imported) because the starter
# module hard-requires torch, and the mjx true path must run on a
# jax-only deployment. The kinematic fallback path instead reuses the
# starter engine's own canonical evaluator (see evaluate_kinematic).
# ---------------------------------------------------------------------------
WILSON_Z = {0.90: 1.644854, 0.95: 1.959964, 0.99: 2.575829}


def wilson_bounds(successes, total, confidence=0.95):
    """Wilson score interval; (low, high), or None when total <= 0."""
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


def eval_domain_tuple(envelope):
    """Parse a pinned eval envelope into the 8-tuple starter defines.

    Envelope order: [motorGain, lagTauSeconds, gyroNoiseStdRadSec,
    odomNoiseStdM, angularBiasRadSec, actionLatencySteps, odomDropoutProb,
    slipScale]. A legacy 6-number envelope keeps the old semantics.
    """
    values = [float(value) for value in envelope]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("evaluation envelope values must be finite")
    while len(values) < 8:
        values.append(0.0 if len(values) < 7 else 1.0)
    if values[5] < 0 or not values[5].is_integer():
        raise ValueError("evaluation envelope actionLatencySteps must be a non-negative integer")
    return tuple(values)


# NOTE: this function is intentionally vendored from engines/starter-ppo/runner.py
# rather than imported: that module hard-requires torch at import time, and the
# mjx true path must run on a jax-only deployment. `tests/test_quality_gate_parity.py`
# asserts the two bodies stay identical, so the duplication cannot drift silently.
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


# ---------------------------------------------------------------------------
# Pure-JAX actor-critic, 1:1 with the starter architecture: [128, 128] tanh
# MLP, Gaussian head with a learnable log-std clamped to [-1.5, 0.0] on use.
# ---------------------------------------------------------------------------
def init_params(key, obs_size, act_size):
    glorot = jax.nn.initializers.glorot_uniform()
    keys = jax.random.split(key, 5)
    return {
        "w1": glorot(keys[0], (obs_size, HIDDEN)),
        "b1": jnp.zeros(HIDDEN),
        "w2": glorot(keys[1], (HIDDEN, HIDDEN)),
        "b2": jnp.zeros(HIDDEN),
        "mu_w": glorot(keys[2], (HIDDEN, act_size)),
        "mu_b": jnp.zeros(act_size),
        "v_w": glorot(keys[3], (HIDDEN, 1)),
        "v_b": jnp.zeros(1),
        "log_std": jnp.full((act_size,), INIT_LOG_STD),
    }


def forward(params, obs):
    hidden = jnp.tanh(obs @ params["w1"] + params["b1"])
    hidden = jnp.tanh(hidden @ params["w2"] + params["b2"])
    mu = hidden @ params["mu_w"] + params["mu_b"]
    value = (hidden @ params["v_w"] + params["v_b"])[..., 0]
    return mu, value


def _std_of(params):
    return jnp.exp(jnp.clip(params["log_std"], -1.5, 0.0))


def _normal_logp(action, mu, std):
    return jnp.sum(
        -0.5 * ((action - mu) / std) ** 2 - jnp.log(std) - 0.5 * math.log(2.0 * math.pi),
        axis=-1,
    )


@jax.jit
def act_sample(params, key, obs):
    """Sample an UNCLAMPED action with its log-prob (PPO trains on it;
    the environment saturates the command at execution)."""
    mu, value = forward(params, obs)
    std = _std_of(params)
    noise = jax.random.normal(key, mu.shape)
    action = mu + std * noise
    return action, _normal_logp(action, mu, std), value


@jax.jit
def act_deterministic(params, obs):
    """Mean action clamped to the [-1, 1] actuator contract."""
    mu, _value = forward(params, obs)
    return jnp.clip(mu, -1.0, 1.0)


def policy_np(params):
    """Host-side callable for evaluation and export: numpy in, numpy out."""

    def act(obs_np):
        return np.asarray(act_deterministic(params, jnp.asarray(obs_np, dtype=jnp.float32)))

    return act


_OPTIMIZER = optax.chain(
    optax.clip_by_global_norm(PPO_HYPERPARAMS["maxGradNorm"]),
    optax.adam(PPO_HYPERPARAMS["actorLr"]),
)


def _ppo_minibatch_update(params, opt_state, obs, act, old_logp, adv, ret):
    """One clipped-PPO gradient step over a minibatch (jitted at module
    level below).

    The log-ratio is clamped to +/-20 before exp, mirroring the starter's
    guard: a pathological tail must never reach the unclipped PPO branch
    whose gradient would overflow into NaN weights.
    """

    def loss_fn(p):
        mu, value = forward(p, obs)
        std = _std_of(p)
        new_logp = _normal_logp(act, mu, std)
        ratio = jnp.exp(jnp.clip(new_logp - old_logp, -20.0, 20.0))
        unclipped = ratio * adv
        clipped = jnp.clip(ratio, 1.0 - PPO_HYPERPARAMS["clip"], 1.0 + PPO_HYPERPARAMS["clip"]) * adv
        policy_loss = -jnp.mean(jnp.minimum(unclipped, clipped))
        value_loss = jnp.mean((ret - value) ** 2)
        entropy = jnp.mean(jnp.sum(jnp.log(std) + 0.5 * math.log(2.0 * math.pi * math.e), axis=-1))
        return (
            policy_loss
            + PPO_HYPERPARAMS["valueCoef"] * value_loss
            - PPO_HYPERPARAMS["entropyCoef"] * entropy
        )

    grads = jax.grad(loss_fn)(params)
    updates, new_opt_state = _OPTIMIZER.update(grads, opt_state, params)
    return optax.apply_updates(params, updates), new_opt_state


ppo_minibatch_update = jax.jit(_ppo_minibatch_update)


def gae_returns(rewards, values, dones, gamma, lam):
    """GAE over (T, N) arrays; the reverse loop matches the starter's
    next_value bootstrapping and done masking exactly."""
    adv = jnp.zeros_like(rewards)
    last_gae = jnp.zeros(rewards.shape[1])
    next_value = jnp.zeros(rewards.shape[1])
    for t in reversed(range(rewards.shape[0])):
        delta = rewards[t] + gamma * next_value * (1.0 - dones[t]) - values[t]
        last_gae = delta + gamma * lam * (1.0 - dones[t]) * last_gae
        adv = adv.at[t].set(last_gae)
        next_value = values[t]
    return adv + values


def train_ppo(env, obs_size, act_size, iterations, rollout_steps, seed):
    """The shared JAX PPO loop: rollout -> GAE -> clipped PPO epochs."""
    params = init_params(jax.random.PRNGKey(seed), obs_size, act_size)
    opt_state = _OPTIMIZER.init(params)
    rng = jax.random.PRNGKey(seed + 1)
    obs_np = env.observe()
    started = time.time()
    for iteration in range(iterations):
        batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done = [], [], [], [], [], []
        obs = jnp.asarray(obs_np, dtype=jnp.float32)
        for _step in range(rollout_steps):
            rng, key = jax.random.split(rng)
            action, logp, value = act_sample(params, key, obs)
            next_obs, reward, done, _success = env.step(
                np.clip(np.asarray(action), -1.0, 1.0)
            )
            batch_obs.append(obs)
            batch_act.append(action)
            batch_logp.append(logp)
            batch_val.append(value)
            batch_rew.append(jnp.asarray(reward, dtype=jnp.float32))
            batch_done.append(jnp.asarray(done, dtype=jnp.float32))
            obs = jnp.asarray(next_obs, dtype=jnp.float32)
        obs_np = np.asarray(obs)
        flat_obs = jnp.stack(batch_obs)
        flat_act = jnp.stack(batch_act)
        flat_logp = jnp.stack(batch_logp)
        flat_val = jnp.stack(batch_val)
        flat_rew = jnp.stack(batch_rew)
        flat_done = jnp.stack(batch_done)
        returns = gae_returns(flat_rew, flat_val, flat_done,
                              PPO_HYPERPARAMS["gamma"], PPO_HYPERPARAMS["gaeLambda"])
        advantage = (returns - flat_val).reshape(-1)
        advantage = (advantage - advantage.mean()) / (advantage.std() + 1e-8)
        obs_flat = flat_obs.reshape((-1, obs_size))
        act_flat = flat_act.reshape((-1, act_size))
        logp_flat = flat_logp.reshape(-1)
        returns_flat = returns.reshape(-1)
        total = obs_flat.shape[0]
        mb_size = min(PPO_HYPERPARAMS["minibatch"], total)
        for _epoch in range(PPO_HYPERPARAMS["epochs"]):
            rng, perm_key = jax.random.split(rng)
            order = jax.random.permutation(perm_key, total)
            for start in range(0, total, mb_size):
                idx = order[start:start + mb_size]
                params, opt_state = ppo_minibatch_update(
                    params, opt_state, obs_flat[idx], act_flat[idx],
                    logp_flat[idx], advantage[idx], returns_flat[idx],
                )
        mean_reward = float(np.mean(np.asarray(flat_rew)))
        recent = env.success_history[-50:]
        recent_success = round(sum(recent) / len(recent), 3) if recent else 0.0
        if (iteration + 1) % max(1, iterations // 8) == 0 or iteration == iterations - 1:
            stdout(
                "iter {}/{} meanReward={:.3f} recentSuccess={:.2f} goalRange=[{:.2f},{:.2f}] elapsed={:.1f}s".format(
                    iteration + 1, iterations, mean_reward, recent_success,
                    env.goal_distance[0], env.goal_distance[1], time.time() - started,
                )
            )
    return params


# ---------------------------------------------------------------------------
# ONNX export: hand-built graph matching the starter contract (mean action,
# clamp to [-1, 1], dynamic batch axis, opset 13, input "observation",
# output "action") so the board runtime loads either engine's artifact
# identically.
# ---------------------------------------------------------------------------
def export_actor_onnx(params, obs_size, act_size, path):
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    def tensor(name, array):
        return numpy_helper.from_array(np.asarray(array, dtype=np.float32), name)

    initializers = [
        tensor("w1", params["w1"]), tensor("b1", params["b1"]),
        tensor("w2", params["w2"]), tensor("b2", params["b2"]),
        tensor("mu_w", params["mu_w"]), tensor("mu_b", params["mu_b"]),
        tensor("clip_min", np.asarray(-1.0)),
        tensor("clip_max", np.asarray(1.0)),
    ]

    def gemm(a, b, c, out):
        return helper.make_node("Gemm", [a, b, c], [out], alpha=1.0, beta=1.0, transA=0, transB=0)

    nodes = [
        gemm("observation", "w1", "b1", "hidden1"),
        helper.make_node("Tanh", ["hidden1"], ["hidden1t"]),
        gemm("hidden1t", "w2", "b2", "hidden2"),
        helper.make_node("Tanh", ["hidden2"], ["hidden2t"]),
        gemm("hidden2t", "mu_w", "mu_b", "mu"),
        # opset 13 moved Clip's bounds from attributes to scalar inputs.
        helper.make_node("Clip", ["mu", "clip_min", "clip_max"], ["action"]),
    ]
    observation = helper.make_tensor_value_info(
        "observation", TensorProto.FLOAT, ["batch", obs_size]
    )
    action = helper.make_tensor_value_info("action", TensorProto.FLOAT, ["batch", act_size])
    graph = helper.make_graph(
        nodes, "mjx_actor", [observation], [action], initializer=initializers
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8  # opset 13 canonical pairing
    onnx.checker.check_model(model)
    onnx.save(model, path)
    return os.path.getsize(path)


def measure_control_latency_ms(params, obs_size):
    """Median single-sample policy latency on the CPU inference budget."""
    sample = jnp.zeros((1, obs_size), dtype=jnp.float32)
    act_deterministic(params, sample).block_until_ready()  # warm-up / compile
    timings = []
    for _ in range(32):
        started = time.perf_counter()
        act_deterministic(params, sample).block_until_ready()
        timings.append((time.perf_counter() - started) * 1000.0)
    return round(float(np.median(timings)), 3)


# ---------------------------------------------------------------------------
# MJX physics environment.
#
# Division of labor with the starter engine (documented so the quality-gate
# comparability claim stays checkable):
#   * MuJoCo/MJX owns the ROBOT: freejoint body dynamics, wheel spin-up
#     through velocity actuators, contact friction against the floor, real
#     projected gravity and body rates for the 42D observation.
#   * The task layer keeps starter semantics verbatim: goals, analytic
#     circle obstacles, reward weights, termination rules, curriculum,
#     command-level domain randomization (gain / lag / latency) and
#     observation-level randomization (gyro noise, odom noise, frame
#     dropout). True pose vs odometry drift emerges from physics (slip)
#     plus the same command/observation randomization.
# ---------------------------------------------------------------------------
MJCF_TEMPLATE = """
<mujoco model="mjx-goalnav">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="{TIMESTEP}" gravity="0 0 -9.81" integrator="implicitfast"/>
  <worldbody>
    <geom name="floor" type="plane" size="12 12 0.1"/>
    {WALLS}
    {OBSTACLES}
    <body name="base" pos="0 0 {BASE_HEIGHT}">
      <freejoint name="base_free"/>
      <geom name="chassis" type="box" size="{CHASSIS_SIZE}" mass="{CHASSIS_MASS}" friction="0.1"/>
      {WHEEL_BODIES}
      {CASTER}
    </body>
  </worldbody>
  <actuator>
    {WHEEL_ACTUATORS}
  </actuator>
</mujoco>
"""

# Wall placement. A vertical plane is single-sided: only the half-space its
# normal points into collides, so every wall quat points its normal inward
# (probe_mjx.py check_walls_block_robot: a robot at max command plateaus at
# the wall with ncon contacts, never crosses).
_WALL_QUATS = {
    "x+": "0.7071 0 -0.7071 0",   # normal -x
    "x-": "0.7071 0 0.7071 0",    # normal +x
    "y+": "0.7071 0.7071 0 0",    # normal -y
    "y-": "0.7071 -0.7071 0 0",   # normal +y
}
_WALL_MARGIN = 0.05


def _walls_xml(inset):
    """Four inward-normal walls at ±inset; probe-verified to block the robot."""
    positions = {
        "x+": (inset, 0.0), "x-": (-inset, 0.0),
        "y+": (0.0, inset), "y-": (0.0, -inset),
    }
    return "\n      ".join(
        '<geom name="wall_{axis}" type="plane" size="6 6 0.1" pos="{x} {y} 0" quat="{q}"/>'.format(
            axis=axis, x=x, y=y, q=_WALL_QUATS[axis],
        )
        for axis, (x, y) in positions.items()
    )


def build_mjcf(physics_dt, workspace_bound=0.0, obstacle_count=0):
    # Geometry mirrors the calibrated OriginBot single source
    # (assets/originbot/calibration.json; cylinder wheels r=0.09 on the
    # center line, track 0.50, kv=8 wheel servos). Three deviations, all
    # probe-verified (probe_mjx.py):
    #   * the caster is lowered to touch the floor — the visual model keeps
    #     it airborne behind two center-line wheels, which pitches
    #     unstably under acceleration; here it is a real 3-point stance
    #     with near-frictionless contact
    #   * integrator is implicitfast — Euler/RK4 diverge (NaN) on the
    #     stiff wheel servo, and velocity-actuator feedback is exactly
    #     what implicitfast integrates implicitly
    #   * wheel servos are force-limited at the calibrated motor stall
    #     torque (wheels.maxTorque): the CG sits almost exactly above the
    #     wheel axle (the caster carries only ~0.2 N), so an uncapped
    #     kv*error torque — 26.6 N·m per wheel at full command — wheelies
    #     the robot off the floor at every spin-up; a real gearmotor
    #     saturates, and so does this model
    # Scene fidelity (probe_mjx.py): obstacles are SPHERE bodies under mocap
    # — the only shape family MuJoCo-MJX collides against every robot part
    # (cylinder-box is unsupported, probe-asserted) — and workspace walls
    # are inward-normal vertical planes. Obstacles move by writing per-env
    # mocap_pos inside the vmap'd step; the analytic circle judgment stays
    # authoritative for task termination so the quality gate remains
    # cross-engine comparable with the starter.
    wheels = _originbot.wheel_bodies_template()
    base = _originbot.BASE
    chassis = base["chassisSize"]
    bound = float(workspace_bound) if workspace_bound else 0.0
    walls = _walls_xml(bound + _WALL_MARGIN) if bound > 0.0 else ""
    obstacles = ""
    if obstacle_count > 0:
        obstacles = "\n      ".join(
            '<body name="obs_{i}" mocap="true" pos="0 0 {z}">'
            '<geom name="obs_geom_{i}" type="sphere" size="{r}"/></body>'.format(
                i=i, z=_OBSTACLE_CENTER_Z, r=_OBSTACLE_GEOM_RADIUS,
            )
            for i in range(obstacle_count)
        )
    return MJCF_TEMPLATE.format(
        TIMESTEP=repr(float(physics_dt)),
        BASE_HEIGHT=repr(REST_HEIGHT),
        CHASSIS_SIZE="{} {} {}".format(chassis[0], chassis[1], chassis[2]),
        CHASSIS_MASS=float(base["chassisMass"]),
        WALLS=walls,
        OBSTACLES=obstacles,
        WHEEL_BODIES=wheels,
        CASTER='<geom name="caster" pos="{x} 0 {z}" type="sphere" size="{s}" mass="{m}" friction="0.02 0.005 0.001"/>'.format(
            x=_originbot.CASTER["posX"], z=-0.115, s=_originbot.CASTER["size"], m=_originbot.CASTER["mass"]),
        WHEEL_ACTUATORS=_originbot.wheel_actuators(
            "wheel_first", forcerange=float(_originbot.WHEELS["maxTorque"])
        ),
    )


def _measure_spawn_clearance(mj_model, mj_data, obstacle_radius):
    """Distance from the spawn origin to the farthest robot-geom point.

    Rotates the compiled model's fixed geoms through a yaw sweep (the
    freejoint spawn draws any yaw) and measures the max xy norm over every
    robot geom's bounding-box corners, so obstacle spawns projected past
    this ring plus the obstacle radius can never start interpenetrating
    the robot. Host-side, once per env build; not on the jit path.
    """
    robot_geoms = [
        i for i in range(mj_model.ngeom)
        if mujoco.mj_id2name(mj_model, mujoco.mjtObj.mjOBJ_GEOM, i)
        not in ("floor",) and not mujoco.mj_id2name(
            mj_model, mujoco.mjtObj.mjOBJ_GEOM, i
        ).startswith(("wall_", "obs_geom_"))
    ]
    worst = 0.0
    for yaw in np.linspace(-math.pi, math.pi, 12):
        quat = [np.cos(yaw / 2.0), 0.0, 0.0, np.sin(yaw / 2.0)]
        for i in robot_geoms:
            geom = mj_model.geom(i)
            if geom.type == mujoco.mjtGeom.mjGEOM_BOX:
                h = np.asarray(geom.size)
                corners = np.array([
                    [sx * h[0], sy * h[1], 0.0]  # plan distance: z irrelevant
                    for sx in (-1, 1) for sy in (-1, 1)
                ])
            elif geom.type == mujoco.mjtGeom.mjGEOM_SPHERE:
                r = float(geom.size[0])
                corners = np.array([
                    [r, 0.0, 0.0], [0.0, r, 0.0], [-r, 0.0, 0.0], [0.0, -r, 0.0],
                ])
            elif geom.type == mujoco.mjtGeom.mjGEOM_CYLINDER:
                r = float(geom.size[0])
                corners = np.array([
                    [r, 0.0, 0.0], [0.0, r, 0.0], [-r, 0.0, 0.0], [0.0, -r, 0.0],
                ])
            else:
                continue
            # geom frame -> body frame: pos + rotated corner, then yaw
            # the whole thing about the spawn origin (base at the origin).
            for corner in corners:
                world = np.zeros(3)
                mujoco.mju_rotVecQuat(world, corner, np.asarray(geom.quat))
                p = np.asarray(geom.pos) + world
                rotated = np.zeros(3)
                mujoco.mju_rotVecQuat(rotated, p, np.asarray(quat))
                worst = max(worst, float(np.hypot(rotated[0], rotated[1])))
    return worst + float(obstacle_radius) + 0.05


def _quat_yaw(q):
    """Yaw from a (w, x, y, z) quaternion."""
    return jnp.arctan2(2.0 * (q[0] * q[3] + q[1] * q[2]), 1.0 - 2.0 * (q[2] ** 2 + q[3] ** 2))


def _quat_rotate_inv(q, v):
    """Rotate v by the inverse quaternion (world -> body frame)."""
    u = q[1:4]
    t = 2.0 * jnp.cross(u, v)
    return v - q[0] * t + jnp.cross(u, t)


def _wrap_angle(value):
    return (value + math.pi) % (2.0 * math.pi) - math.pi


# The free joint's qvel rotational part is body-frame in MuJoCo. The probe
# (probe_mjx.py) verifies this against a known rotation; if a future mujoco
# version changes the convention the probe is the place that catches it.
_FREEJOINT_ANGULAR_IS_BODY = True


class MjxGoalNavEnv:
    """Vectorized goal-navigation env over MJX physics.

    Training uses auto-reset episodes with curriculum goal ranges passed as
    traced arguments (the host widens them as the success rate clears the
    task threshold, exactly like the starter engine). Evaluation runs
    batched episodes that freeze at their terminal state so all pinned
    episodes advance in one jitted call per control step.
    """

    def __init__(self, pack, num_envs, seed, physics_dt, obs_layout):
        self.pack = pack
        self.num_envs = num_envs
        self.observation_size = 8 if obs_layout == "originbot-imu-odom-v1" else 42
        self.action_size = 2
        self.obs_layout = obs_layout
        self.control_dt = 1.0 / float(pack.get("controlHz", 10))
        self.physics_dt = float(physics_dt)
        # Decimation is DERIVED so physics time and task time advance
        # together: decimation * physics_dt == control_dt exactly. The
        # request's decimation field is not trusted for this — the shared
        # contract builder computes round(controlHz * timestep), the
        # reciprocal of the substep count, and honoring it verbatim would
        # run the robot 5x slow-motion relative to the task layer.
        self.decimation = max(1, int(round(self.control_dt / self.physics_dt)))
        self.timeout_steps = int(pack["termination"]["timeoutSteps"])
        self.goal_eps = float(pack["termination"]["goalDistance"])
        self.max_linear = float(pack["adapter"]["safety"]["maxLinear"])
        self.max_angular = float(pack["adapter"]["safety"]["maxAngular"])
        self.workspace_bound = float((pack.get("workspace") or {}).get("bound") or 0.0)
        obstacle_spec = (pack.get("workspace") or {}).get("obstacles") or {}
        self.obstacle_count = int(obstacle_spec.get("count", 0))
        self.obstacle_radius = float(obstacle_spec.get("radius", 0.15))
        self.obstacle_spread = self.workspace_bound or 1.5
        dr = pack.get("domainRandomization") or {}

        def dr_range(key, default):
            values = dr.get(key) or default
            return float(values[0]), float(values[1])

        dr_keys = (
            ("motorGain", [1.0, 1.0]), ("lagTauSeconds", [0.05, 0.05]),
            ("gyroNoiseStdRadSec", [0.0, 0.0]), ("odomNoiseStdM", [0.0, 0.0]),
            ("angularBiasRadSec", [0.0, 0.0]), ("odomDropoutProb", [0.0, 0.0]),
            ("slipScale", [1.0, 1.0]),
        )
        self.dr_mins = jnp.asarray([dr_range(k, d)[0] for k, d in dr_keys], dtype=jnp.float32)
        self.dr_maxs = jnp.asarray([dr_range(k, d)[1] for k, d in dr_keys], dtype=jnp.float32)
        # Physical-level DR: per-env traced scalings of friction / mass / kv
        # (probe_mjx.py check_traced_physical_dr). Defaults keep the
        # historical behavior exactly when the task pack does not opt in.
        phys_dr = pack.get("physicalDomainRandomization") or {}
        phys_keys = (
            ("wheelFrictionScale", [1.0, 1.0]),
            ("chassisMassScale", [1.0, 1.0]),
            ("wheelServoKvScale", [1.0, 1.0]),
        )
        self.phys_dr_mins = jnp.asarray(
            [dr_range(k, d)[0] for k, d in phys_keys if phys_dr.get(k) is not None]
            + [dr_range(k, d)[0] for k, d in phys_keys if phys_dr.get(k) is None],
            dtype=jnp.float32,
        )
        self.phys_dr_maxs = jnp.asarray(
            [dr_range(k, d)[1] for k, d in phys_keys if phys_dr.get(k) is not None]
            + [dr_range(k, d)[1] for k, d in phys_keys if phys_dr.get(k) is None],
            dtype=jnp.float32,
        )
        self.physical_dr_active = bool(
            any(phys_dr.get(k) is not None and dr_range(k, d)[0] != dr_range(k, d)[1]
                for k, d in phys_keys)
        )
        latency_range = dr.get("actionLatencySteps") or [0, 0]
        self.latency_min = int(latency_range[0])
        self.latency_max = int(latency_range[1])
        # The latency FIFO must hold BOTH the training draw range and every
        # pinned eval envelope latency (the hard envelope can pin more
        # latency than training ever samples); a traced negative index
        # would otherwise crash mid-eval.
        envelope_latencies = [
            int(eval_domain_tuple(envelope)[5])
            for envelope in ((dr.get("evalEnvelopes") or {}).values())
        ]
        self._fifo_capacity = max([self.latency_max, 1] + envelope_latencies)
        # Reward weights are read inside the jitted step; capture as plain
        # floats so the closure bakes them in.
        self.reward_cfg = {k: float(v) for k, v in (pack.get("reward") or {}).items()}
        self.has_dwell = "dwell" in self.reward_cfg

        curriculum = pack.get("curriculum") or {}
        self.curriculum_lookback = int(curriculum.get("lookbackEpisodes", 50))
        self.curriculum_threshold = float(curriculum.get("successRateThreshold", 0.7))
        self.curriculum_factor = float(curriculum.get("expandFactor", 1.15))
        initial_goal = curriculum.get("initialGoalDistance", [0.8, 1.2])
        self.goal_distance = [float(initial_goal[0]), float(initial_goal[1])]
        self.final_goal_distance = float(curriculum.get("finalGoalDistance", [1.4, 1.6])[1])
        self.success_history = []
        self._initial_goal = [float(initial_goal[0]), float(initial_goal[1])]

        mj_model = mujoco.MjModel.from_xml_string(
            build_mjcf(self.physics_dt, self.workspace_bound, self.obstacle_count)
        )
        mj_data = mujoco.MjData(mj_model)
        mujoco.mj_forward(mj_model, mj_data)
        self.mjx_model = mjx.put_model(mj_model)
        self._template = mjx.put_data(mj_model, mj_data)
        self._zero_nv = jnp.zeros(mj_model.nv)
        # Model indices the traced physical DR and mocap writes target.
        # Cached once because they are compile-time constants of the shared
        # model; the probe asserts the geom names this depends on.
        self._geom_ids = {
            mujoco.mj_id2name(mj_model, mujoco.mjtObj.mjOBJ_GEOM, i): i
            for i in range(mj_model.ngeom)
        }
        self._wheel_geom_rows = jnp.asarray(
            [self._geom_ids["wheel_left_geom"], self._geom_ids["wheel_right_geom"]]
        )
        self._base_body_row = 1  # world=0, base=1 (build_mjcf layout)
        self._nmocap = mj_model.nmocap
        self._mujoco_model = mj_model  # for probes/tests; not on the jit path
        # Obstacle spawn clearance, MEASURED from the compiled model: the
        # max xy radius of every robot geom corner at the rest pose plus
        # the obstacle radius. Rotation-invariant, so one number bounds
        # every spawn yaw (an obstacle outside this ring can never start an
        # episode interpenetrating the chassis or a wheel).
        self._spawn_clear = _measure_spawn_clearance(mj_model, mj_data, self.obstacle_radius)
        # Sampling geometry for the obstacle placement in _sample_reset_state,
        # derived once and VALIDATED here: a task pack whose workspace cannot
        # host its obstacles must fail at build time with a readable cause,
        # not NaN mid-run (see the placement comment in _sample_reset_state).
        if self.obstacle_count:
            # Worst-case pairwise distance between two slot-jittered
            # placements (both at the inner radius, relative angle
            # pi/count) must clear two obstacle radii plus slack.
            self._slot_jitter = math.pi / (2.0 * self.obstacle_count)
            min_pair = 2.0 * self._spawn_clear * math.sin(math.pi / (2.0 * self.obstacle_count))
            if min_pair < 2.0 * self.obstacle_radius + 0.02:
                raise ValueError(
                    "%d obstacle(s) of radius %.2f cannot stay separated inside the spawn "
                    "ring r>=%.3f (worst-case pairwise distance %.3f); reduce obstacle "
                    "count/radius or enlarge the workspace"
                    % (self.obstacle_count, self.obstacle_radius, self._spawn_clear, min_pair)
                )
            wall_safe = (
                self.workspace_bound + _WALL_MARGIN - self.obstacle_radius - 0.01
                if self.workspace_bound > 0.0
                else None
            )
            r_max = self.obstacle_spread if wall_safe is None else min(self.obstacle_spread, wall_safe)
            if r_max <= self._spawn_clear:
                raise ValueError(
                    "workspace cannot host obstacles: max placement radius %.3f falls inside "
                    "the robot spawn clearance %.3f (bound=%.2f, obstacle radius=%.2f)"
                    % (r_max, self._spawn_clear, self.workspace_bound, self.obstacle_radius)
                )
            self._r_max = r_max

        self._train_step = jax.jit(
            jax.vmap(self._train_step_one, in_axes=(0, 0, None, None))
        )
        self._eval_step = jax.jit(jax.vmap(self._eval_step_one, in_axes=(0, 0)))

        self.rng = jax.random.PRNGKey(seed)
        self._rng_train, self._rng_eval = jax.random.split(self.rng)
        self.state = self._reset_state_batch(self._rng_train)
        self.current_obs = np.asarray(self.state["last_obs"])

    # -- state construction --------------------------------------------------
    def _reset_state_batch(self, rng, goal_range=None):
        lo, hi = goal_range or self.goal_distance
        keys = jax.random.split(rng, self.num_envs)

        def sample_one(key):
            return self._sample_reset_state(key, lo, hi)

        return jax.vmap(sample_one)(keys)

    def _sample_reset_state(self, key, goal_lo, goal_hi):
        """One env's post-reset state, including its first observation.

        The initial obs carries sensor noise but no dropout (fresh frame),
        matching the starter's first-observation behavior. Works both
        host-side (python floats) and inside jit (traced goal range).
        Every draw gets its own subkey — reusing a key would correlate the
        draws (goal distance would equal goal angle, domain would encode
        latency) and quietly degenerate the randomization.
        """
        k_goal, k_angle, k_yaw, k_obs, k_domain, k_latency, k_carry, k_noise = jax.random.split(key, 8)
        k_phys = k_domain  # reuse split below when physical DR is active
        if self.physical_dr_active:
            _k_goal, _k_angle, _k_yaw, _k_obs, k_phys, k_domain, k_latency, k_carry, k_noise = jax.random.split(key, 9)
        distance = jax.random.uniform(k_goal, (), minval=goal_lo, maxval=goal_hi)
        angle = jax.random.uniform(k_angle, (), minval=0.0, maxval=2.0 * math.pi)
        yaw = jax.random.uniform(k_yaw, (), minval=-math.pi, maxval=math.pi)
        goal = jnp.stack([distance * jnp.cos(angle), distance * jnp.sin(angle)])
        if self.obstacle_count:
            # Obstacle placement is CONSTRUCTED, not sampled-then-repaired.
            # Every initial static-static penetration — obstacle into a wall,
            # obstacle into obstacle, obstacle into the resting robot —
            # destabilizes the MJX contact solver (a wall-penetrating or
            # mutually-overlapping sphere NaNs qpos within ~180 physics
            # steps while CPU MuJoCo stays finite; the pinned eval envelope
            # hit exactly this). A rejection loop cannot express the early
            # exit under jit, so the guarantee lives in the sampling
            # geometry instead, validated once in __init__:
            #   radius in [spawn_clear, r_max]  -> never starts inside the
            #     measured robot footprint, and never crosses a wall;
            #   angle  = one jittered slot per obstacle -> pairwise distance
            #     has the analytic lower bound 2*spawn_clear*sin(pi/2count),
            #     independent of the sampled radii.
            k_rot, k_slot, k_rad = jax.random.split(k_obs, 3)
            rotation = jax.random.uniform(k_rot, (), minval=0.0, maxval=2.0 * math.pi)
            slot = 2.0 * math.pi / self.obstacle_count
            angles = rotation + slot * jnp.arange(self.obstacle_count) + jax.random.uniform(
                k_slot, (self.obstacle_count,),
                minval=-self._slot_jitter, maxval=self._slot_jitter,
            )
            radii = jax.random.uniform(
                k_rad, (self.obstacle_count,),
                minval=self._spawn_clear, maxval=self._r_max,
            )
            xy = jnp.stack([radii * jnp.cos(angles), radii * jnp.sin(angles)], axis=1)
            obstacles = jnp.concatenate(
                [xy, jnp.full((self.obstacle_count, 1), self.obstacle_radius)], axis=1
            )
        else:
            obstacles = jnp.zeros((0, 3))
        domain = self.dr_mins + jax.random.uniform(k_domain, (7,)) * (self.dr_maxs - self.dr_mins)
        phys_domain = self.phys_dr_mins + jax.random.uniform(
            k_phys, (3,)
        ) * (self.phys_dr_maxs - self.phys_dr_mins)
        latency = jax.random.randint(
            k_latency, (), minval=self.latency_min, maxval=self.latency_max + 1
        )
        init_qpos = jnp.concatenate([
            jnp.asarray([0.0, 0.0, REST_HEIGHT]),
            jnp.asarray([jnp.cos(yaw / 2.0), 0.0, 0.0, jnp.sin(yaw / 2.0)]),
            jnp.zeros(2),
        ])
        data = self._template.replace(qpos=init_qpos, qvel=self._zero_nv)
        # Mocap obstacles sit at their sampled positions from the first
        # forward (z lifted to the geom center height); per-env values are
        # written into data.mocap_pos by _apply_physical_domain below.
        mocap_pos = jnp.tile(
            jnp.zeros((1, 3)).at[0, 2].set(_OBSTACLE_CENTER_Z), (max(self._nmocap, 1), 1)
        )[: self._nmocap]
        if self.obstacle_count:
            mocap_pos = jnp.concatenate(
                [obstacles[:, :2], jnp.full((self.obstacle_count, 1), _OBSTACLE_CENTER_Z)], axis=1
            )
        odom = jnp.stack([jnp.asarray(0.0), jnp.asarray(0.0), yaw])
        obs = self._build_obs(
            domain, k_noise, odom, goal, yaw,
            jnp.zeros(3), jnp.asarray([0.0, 0.0, -1.0]),
            jnp.asarray(0.0), jnp.asarray(0.0),
        )
        return {
            "data": data,
            "rng": k_carry,
            "goal": goal,
            "obstacles": obstacles,
            "domain": domain,
            "phys_domain": phys_domain,
            "mocap_pos": mocap_pos,
            "latency": latency,
            "fifo": jnp.zeros((self._fifo_capacity + 1, 2)),
            "odom": odom,
            "v_lag": jnp.asarray(0.0),
            "w_lag": jnp.asarray(0.0),
            "steps": jnp.asarray(0, dtype=jnp.int32),
            "collision": jnp.asarray(False),
            "prev_dist": jnp.linalg.norm(goal),
            "last_obs": obs,
            "obs_initialized": jnp.asarray(False),
            "final_dist": jnp.asarray(-1.0),
            "final_collision": jnp.asarray(False),
            "frozen": jnp.asarray(False),
        }

    # -- shared physics core (single env, traced) -----------------------------
    def _command_chain(self, state, action, domain):
        """Latency FIFO -> motor gain -> first-order lag, starter semantics.

        The FIFO holds _fifo_capacity+1 commands with the NEWEST last. The
        executed command is the one from `latency` steps ago: with a
        freshly-reset queue the prefix is zeros, so fifo[len-1-latency] is
        a zero for the first `latency` calls and the command at index k
        executes at step k+latency — the starter's popleft semantics
        expressed on a fixed-length buffer that vmap can trace.
        """
        target_v = jnp.clip(action[0], -1.0, 1.0) * self.max_linear
        target_w = jnp.clip(action[1], -1.0, 1.0) * self.max_angular
        fifo = jnp.concatenate(
            [state["fifo"][1:], jnp.stack([target_v, target_w])[None]], axis=0
        )
        latency = jnp.asarray(state["latency"], dtype=jnp.int32)
        delayed = fifo[self._fifo_capacity - latency]
        lag_tau = jnp.maximum(domain[1], 1e-6)
        alpha = jnp.clip(self.control_dt / lag_tau, 0.0, 1.0)
        v_lag = state["v_lag"] + alpha * (delayed[0] * domain[0] - state["v_lag"])
        w_lag = state["w_lag"] + alpha * (delayed[1] * domain[0] - state["w_lag"])
        return fifo, v_lag, w_lag

    def _wheel_command(self, v_lag, w_lag, domain):
        """Differential-drive IK with the DR degradations.

        slipScale degrades the body motion the robot actually achieves
        relative to the twist it believes it commanded (starter semantics,
        physically realized through the wheels); angularBias veers the true
        chassis rotation while odometry stays blind to it.
        """
        v_phys = v_lag * domain[6]
        w_phys = w_lag + domain[4]
        left = (v_phys - w_phys * TRACK_WIDTH / 2.0) / WHEEL_RADIUS
        right = (v_phys + w_phys * TRACK_WIDTH / 2.0) / WHEEL_RADIUS
        return jnp.clip(jnp.stack([left, right]), -MAX_WHEEL_SPEED, MAX_WHEEL_SPEED)

    def _physics_rollout(self, state, ctrl):
        """Decimated MJX stepping with this env's physical DR applied.

        The model is the SHARED mjx pytree; per-env randomization scales
        its leaves inside the vmap'd trace (probe-verified). Wheel friction
        scales geom_friction rows, mass/inertia scale the base body, kv
        scales actuator_gainprm[:,0] AND biasprm[:,2] together — for a
        velocity servo the two must stay consistent or the servo target
        itself shifts. With all multipliers at 1.0 the leaves are
        untouched and physics is bitwise the historical behavior.
        """
        data = state["data"].replace(ctrl=ctrl)
        if self._nmocap:
            data = data.replace(mocap_pos=state["mocap_pos"])
        model = self.mjx_model
        if self.physical_dr_active:
            friction_scale, mass_scale, kv_scale = state["phys_domain"][0], state["phys_domain"][1], state["phys_domain"][2]
            gf = model.geom_friction.at[self._wheel_geom_rows, 0].set(
                model.geom_friction[self._wheel_geom_rows, 0] * friction_scale
            )
            bm = model.body_mass.at[self._base_body_row].set(
                model.body_mass[self._base_body_row] * mass_scale
            )
            bi = model.body_inertia.at[self._base_body_row].set(
                model.body_inertia[self._base_body_row] * mass_scale
            )
            gp = model.actuator_gainprm.at[:, 0].set(
                model.actuator_gainprm[:, 0] * kv_scale
            )
            bp = model.actuator_biasprm.at[:, 2].set(
                model.actuator_biasprm[:, 2] * kv_scale
            )
            model = model.replace(geom_friction=gf, body_mass=bm, body_inertia=bi,
                                  actuator_gainprm=gp, actuator_biasprm=bp)
        data = jax.lax.fori_loop(0, self.decimation, lambda _i, d: mjx.step(model, d), data)
        return data

    def _read_truth(self, data):
        x, y = data.qpos[0], data.qpos[1]
        quat = data.qpos[3:7]
        yaw = _quat_yaw(quat)
        angular = data.qvel[3:6]
        body_omega = angular if _FREEJOINT_ANGULAR_IS_BODY else _quat_rotate_inv(quat, angular)
        gravity_body = _quat_rotate_inv(quat, jnp.asarray([0.0, 0.0, -1.0]))
        return x, y, yaw, body_omega, gravity_body

    def _build_obs(self, domain, k_noise, odom, goal, yaw, body_omega, gravity_body, v_lag, w_lag):
        """Both observation layouts, starter field semantics.

        8D: pose from (noisy) odometry, goal delta from the same believed
        pose, believed twist in slots 6/7. 42D: real body rates and real
        projected gravity from physics (the honest upgrade over the
        starter's upright constants), goal delta from the believed pose.
        """
        odom_x, odom_y, odom_yaw = odom[0], odom[1], odom[2]
        kx, ky, kw, k_gyro, k_drop = jax.random.split(k_noise, 5)
        if self.observation_size == 8:
            noisy_x = odom_x + jax.random.normal(kx, (), dtype=jnp.float32) * domain[3]
            noisy_y = odom_y + jax.random.normal(ky, (), dtype=jnp.float32) * domain[3]
            noisy_w = w_lag + jax.random.normal(kw, (), dtype=jnp.float32) * domain[2]
            return jnp.stack([
                noisy_x, noisy_y,
                jnp.sin(odom_yaw), jnp.cos(odom_yaw),
                goal[0] - noisy_x, goal[1] - noisy_y,
                v_lag, noisy_w,
            ])
        gyro = body_omega + jax.random.normal(k_gyro, (3,), dtype=jnp.float32) * domain[2]
        last_cmd = jnp.stack([
            v_lag / self.max_linear if self.max_linear else jnp.asarray(0.0),
            w_lag / self.max_angular if self.max_angular else jnp.asarray(0.0),
        ])
        world_dx = goal[0] - odom_x
        world_dy = goal[1] - odom_y
        body_dx = jnp.cos(odom_yaw) * world_dx + jnp.sin(odom_yaw) * world_dy
        body_dy = -jnp.sin(odom_yaw) * world_dx + jnp.cos(odom_yaw) * world_dy
        return jnp.concatenate([
            gyro, gravity_body, last_cmd,
            jnp.stack([body_dx, body_dy]), jnp.stack([v_lag, w_lag]),
            jnp.zeros(30),
        ])

    def _task_outcomes(self, state, x, y, action):
        """Reward, done flags and bookkeeping, starter semantics verbatim."""
        goal = state["goal"]
        distance = jnp.sqrt((goal[0] - x) ** 2 + (goal[1] - y) ** 2)
        if self.obstacle_count:
            rel = state["obstacles"][:, :2] - jnp.stack([x, y])
            collided = jnp.any(jnp.linalg.norm(rel, axis=1) <= self.obstacle_radius)
        else:
            collided = jnp.asarray(False)
        success = distance < self.goal_eps
        if self.workspace_bound > 0.0:
            out_of_bound = (jnp.abs(x) > self.workspace_bound) | (jnp.abs(y) > self.workspace_bound)
        else:
            out_of_bound = jnp.asarray(False)
        done = success | collided | out_of_bound | (state["steps"] + 1 >= self.timeout_steps)
        clipped = jnp.clip(action, -1.0, 1.0)
        reward = (
            self.reward_cfg.get("progress", 0.0) * (state["prev_dist"] - distance)
            + self.reward_cfg.get("actionPenalty", 0.0) * jnp.mean(jnp.abs(clipped))
            + jnp.where(success, self.reward_cfg.get("goal", 0.0), 0.0)
            + jnp.where(collided, self.reward_cfg.get("collision", 0.0), 0.0)
        )
        if self.has_dwell:
            reward = reward + jnp.where(
                distance < self.goal_eps * 1.5, self.reward_cfg["dwell"], 0.0
            )
        return distance, collided, success, done, reward

    def _advance(self, state, action):
        """One control step for one env: commands -> physics -> obs -> task."""
        rng, k_noise, k_drop, k_reset = jax.random.split(state["rng"], 4)
        domain = state["domain"]
        fifo, v_lag, w_lag = self._command_chain(state, action, domain)
        ctrl = self._wheel_command(v_lag, w_lag, domain)
        data = self._physics_rollout(state, ctrl)
        x, y, yaw, body_omega, gravity_body = self._read_truth(data)
        # Odometry integrates the BELIEVED twist (slip- and bias-blind),
        # exactly like the starter: drift-vs-truth is the transfer hazard.
        odom_yaw = _wrap_angle(state["odom"][2] + w_lag * self.control_dt)
        odom = jnp.stack([
            state["odom"][0] + v_lag * jnp.cos(odom_yaw) * self.control_dt,
            state["odom"][1] + v_lag * jnp.sin(odom_yaw) * self.control_dt,
            odom_yaw,
        ])
        obs = self._build_obs(
            domain, k_noise, odom, state["goal"], yaw,
            body_omega, gravity_body, v_lag, w_lag,
        )
        # Frame dropout: repeat the last good frame with the pinned
        # probability. _build_obs consumed its own subkeys first, so the
        # rng call order stays deterministic; k_drop is a separate key.
        drop = state["obs_initialized"] & (jax.random.uniform(k_drop, ()) < domain[5])
        obs = jnp.where(drop, state["last_obs"], obs)
        distance, collided, success, done, reward = self._task_outcomes(state, x, y, action)
        advanced = {
            "data": data,
            "rng": rng,
            "goal": state["goal"],
            "obstacles": state["obstacles"],
            "domain": state["domain"],
            "phys_domain": state["phys_domain"],
            "mocap_pos": state["mocap_pos"],
            "latency": state["latency"],
            "fifo": fifo,
            "odom": odom,
            "v_lag": v_lag,
            "w_lag": w_lag,
            "steps": state["steps"] + 1,
            "collision": state["collision"] | collided,
            "prev_dist": distance,
            "last_obs": obs,
            "obs_initialized": jnp.asarray(True),
            "final_dist": jnp.where(done, distance, state["final_dist"]),
            "final_collision": jnp.where(done, state["collision"] | collided, state["final_collision"]),
            "frozen": state["frozen"],
        }
        return advanced, obs, reward, done, success, k_reset

    def _train_step_one(self, state, action, goal_lo, goal_hi):
        advanced, obs, reward, done, success, k_reset = self._advance(state, action)
        # Auto-reset on done: resample the episode and hand the learner the
        # fresh episode's first observation (starter returns the post-reset
        # obs too, so batch boundaries stay consistent across engines).
        fresh = self._sample_reset_state(
            jax.random.fold_in(k_reset, advanced["steps"]), goal_lo, goal_hi
        )
        merged = jax.tree.map(
            lambda new, old: jnp.where(done, new, old), fresh, advanced
        )
        obs_out = jnp.where(done, fresh["last_obs"], obs)
        return merged, obs_out, reward, done, success

    def _eval_step_one(self, state, action):
        advanced, obs, reward, done, success, _k_reset = self._advance(state, action)
        # Freeze AFTER capturing the terminal state: the finishing step's
        # result is kept, every later step is a no-op, so batched episodes
        # of different lengths all terminate cleanly.
        was_frozen = state["frozen"]
        merged = jax.tree.map(
            lambda new, old: jnp.where(was_frozen, old, new), advanced, state
        )
        merged["frozen"] = was_frozen | done
        return merged, obs, reward, done, success, advanced["collision"]

    # -- host-side training interface ----------------------------------------
    def reset(self):
        self._rng_train, split = jax.random.split(self._rng_train)
        self.state = self._reset_state_batch(split)
        self.current_obs = np.asarray(self.state["last_obs"])
        return self.current_obs

    def step(self, actions_np):
        actions = jnp.asarray(actions_np, dtype=jnp.float32)
        goal_lo = jnp.asarray(self.goal_distance[0], dtype=jnp.float32)
        goal_hi = jnp.asarray(self.goal_distance[1], dtype=jnp.float32)
        state, obs, reward, done, success = self._train_step(
            self.state, actions, goal_lo, goal_hi
        )
        self.state = state
        self.current_obs = np.asarray(obs)
        done_np = np.asarray(done)
        for flag in np.asarray(success)[done_np]:
            self.success_history.append(bool(flag))
        self._maybe_expand_curriculum()
        return self.current_obs, np.asarray(reward), done_np, np.asarray(success)

    def _maybe_expand_curriculum(self):
        if len(self.success_history) < self.curriculum_lookback:
            return
        recent = self.success_history[-self.curriculum_lookback:]
        if sum(recent) / len(recent) >= self.curriculum_threshold:
            self.goal_distance = [
                min(self.goal_distance[0] * self.curriculum_factor, self.final_goal_distance),
                min(self.goal_distance[1] * self.curriculum_factor, self.final_goal_distance),
            ]
            self.success_history.clear()

    def observe(self):
        return self.current_obs

    # -- host-side batched evaluation ----------------------------------------
    def run_episodes(self, policy_fn, domain_tuple, seed, episodes):
        """Run `episodes` pinned-domain episodes; freeze at termination.

        Episode i is seeded by fold_in(PRNGKey(seed), i) with the starter
        evaluator's episode_seed = seed * 7919 + i offset, so a pinned
        envelope is reproducible within this engine and the report stays
        recomputable.
        """
        (motor_gain, lag_tau, gyro_noise, odom_noise, angular_bias,
         latency, dropout, slip) = domain_tuple
        domain = jnp.asarray([motor_gain, lag_tau, gyro_noise, odom_noise,
                              angular_bias, dropout, slip], dtype=jnp.float32)
        base_key = jax.random.PRNGKey(seed * 7919)
        keys = jax.vmap(lambda i: jax.random.fold_in(base_key, i))(jnp.arange(episodes))
        state = jax.vmap(
            lambda key: self._sample_reset_state(
                key, self._initial_goal[0], self._initial_goal[1]
            )
        )(keys)
        # Pin the envelope: exact domain values and exact latency for every
        # episode — the whole point of a pinned-envelope A/B. Physical DR
        # multipliers pin at 1.0 (the calibrated robot): pinned envelopes
        # compare command/observation degradation, not physical drift.
        state["domain"] = jnp.tile(domain, (episodes, 1))
        state["latency"] = jnp.full((episodes,), int(latency), dtype=jnp.int32)
        state["phys_domain"] = jnp.ones((episodes, 3))

        obs = np.asarray(state["last_obs"])
        rewards_sum = np.zeros(episodes, dtype=np.float64)
        steps_count = np.zeros(episodes, dtype=np.int64)
        reached = np.zeros(episodes, dtype=bool)
        rows = []
        for step_idx in range(self.timeout_steps):
            was_live = ~np.asarray(state["frozen"])
            actions = policy_fn(obs)
            state, obs_out, reward, done, success, collision = self._eval_step(
                state, jnp.asarray(actions, dtype=jnp.float32)
            )
            rewards_sum += np.where(was_live, np.asarray(reward), 0.0)
            steps_count += was_live
            reached |= np.asarray(success) & was_live
            # Telemetry rows mirror the starter evaluator: the observation
            # the policy SAW when it chose the action, and the cumulative
            # episode collision flag (starter's _collision_flags).
            if was_live[0]:
                rows.append({
                    "t": round(step_idx * self.control_dt, 4),
                    "observation": [round(float(v), 6) for v in obs[0]],
                    "action": [round(float(v), 6) for v in actions[0]],
                    "reward": round(float(np.asarray(reward)[0]), 6),
                    "done": bool(np.asarray(done)[0]),
                    "fall": bool(np.asarray(collision)[0]),
                })
            obs = np.asarray(obs_out)
        outcomes = []
        final_dist = np.asarray(state["final_dist"])
        final_collision = np.asarray(state["final_collision"])
        for episode in range(episodes):
            outcomes.append({
                "success": bool(reached[episode]),
                "collision": bool(final_collision[episode]),
                "steps": int(steps_count[episode]),
                "finalDistance": float(final_dist[episode]),
                "episodeReward": float(rewards_sum[episode]),
            })
        # A diverged MJX episode produces NaN rewards. Python's json.dump
        # would happily emit bare NaN, which is not JSON: the platform worker
        # and every Node consumer then fail to parse the result at all, and
        # the run's real failure mode (physics divergence) is erased by a
        # serialization error. Refuse here instead, so the engine exits
        # non-zero with a readable cause and the platform marks the run
        # failed. Never coerce NaN to 0 — that would fabricate a reward.
        if not np.all(np.isfinite(rewards_sum)):
            bad = int(np.argmax(~np.isfinite(rewards_sum)))
            raise ValueError(
                "evaluation episode {} diverged: reward is non-finite "
                "(NaN/Inf) — the physics run is unstable; refusing to "
                "report a reward that cannot be serialized honestly".format(bad)
            )
        return outcomes, rows


def evaluate_goal_navigation_mjx(env, policy_fn, envelopes, seed,
                                 episodes_per_envelope=50, confidence=0.95):
    """Pinned-envelope evaluation with Wilson CIs over the mjx env — the
    report shape is identical to the starter engine's, so the TS release
    gate recomputes the verdict from the same numbers."""
    report = {"envelopes": {}, "jsonl": {}, "meanReward": 0.0,
              "episodesPerEnvelope": episodes_per_envelope, "confidenceLevel": confidence}
    rewards_all = []
    for name, envelope in (envelopes or {}).items():
        domain_tuple = eval_domain_tuple(envelope)
        outcomes, rows = env.run_episodes(policy_fn, domain_tuple, seed, episodes_per_envelope)
        successes = sum(1 for outcome in outcomes if outcome["success"])
        collisions = sum(1 for outcome in outcomes if outcome["collision"])
        finals = [outcome["finalDistance"] for outcome in outcomes]
        lengths = [outcome["steps"] for outcome in outcomes]
        rewards = [outcome["episodeReward"] for outcome in outcomes]
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
        }
        report["jsonl"][name] = rows
        rewards_all.extend(rewards)
    report["meanReward"] = round(float(np.mean(rewards_all)), 4) if rewards_all else 0.0
    return report


class KinematicTrainEnv:
    """Training wrapper over the starter GoalNavEnv (numpy) for the honest
    fallback: same JAX learner, kinematic physics. torch is required only
    because the starter module imports it at module level."""

    def __init__(self, pack, num_envs, seed):
        from starter_ppo_loader import load_starter_engine  # noqa: PLC0415

        starter = load_starter_engine()
        self.env = starter.GoalNavEnv(pack, num_envs, seed=seed)
        self.observation_size = self.env.observation_size
        self.action_size = self.env.action_size

    @property
    def success_history(self):
        return self.env.success_history

    @property
    def goal_distance(self):
        return self.env.goal_distance

    def reset(self):
        return self.env.reset()

    def step(self, actions_np):
        return self.env.step(np.asarray(actions_np, dtype=np.float32))

    def observe(self):
        return self.env.observe()


def evaluate_kinematic(params, pack, seed, episodes_per_envelope, confidence):
    """Fallback evaluation: the starter engine's own canonical evaluator
    driven through a torch-shaped adapter around the JAX policy, so the
    kinematic report is bit-for-bit the protocol starter emits.

    The rsl-rl adapter does the same (see _RslPolicy there): the evaluator
    only calls .act(obs_tensor)/.eval()/.train()/.training, so a numpy
    bridge is enough.
    """
    from starter_ppo_loader import load_starter_engine  # noqa: PLC0415

    _engines_dir_on_path()
    starter = load_starter_engine()
    envelopes = (pack.get("domainRandomization") or {}).get("evalEnvelopes") or {}
    env = starter.GoalNavEnv(pack, 1, seed=seed)
    policy_fn = policy_np(params)

    class _JaxPolicyBridge:
        """Give the starter evaluator the torch .act() it expects."""

        def __init__(self, fn):
            self.fn = fn

        def act(self, obs_tensor, deterministic=True, squashed=False):
            obs_np = np.array(obs_tensor.detach().cpu().numpy(), copy=True)
            action = self.fn(obs_np)
            tensor = torch.from_numpy(np.ascontiguousarray(action, dtype=np.float32))
            return tensor, torch.zeros(tensor.shape[0])

        @property
        def training(self):
            return False

        def eval(self):
            return self

        def train(self):
            return self

    device = torch.device("cpu")
    eval_seed = seed + 1000
    trained_report = starter.evaluate_goal_navigation(
        _JaxPolicyBridge(policy_fn), env, device, envelopes, eval_seed,
        episodes_per_envelope=episodes_per_envelope, confidence=confidence,
    )
    baseline_params = init_params(jax.random.PRNGKey(seed + 4242),
                                  env.observation_size, env.action_size)
    baseline_report = starter.evaluate_goal_navigation(
        _JaxPolicyBridge(policy_np(baseline_params)), env, device, envelopes, eval_seed,
        episodes_per_envelope=episodes_per_envelope, confidence=confidence,
    )
    gate = starter.evaluate_quality_gate(
        trained_report, pack.get("qualityGate") or {}, baseline_report
    )
    return trained_report, baseline_report, gate


def _engines_dir_on_path():
    engines_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if engines_dir not in sys.path:
        sys.path.insert(0, engines_dir)


def main():
    _engines_dir_on_path()

    request_path = os.environ.get("RDK_SIM2REAL_REQUEST_FILE", "").strip()
    result_path = os.environ.get("RDK_SIM2REAL_RESULT_FILE", "").strip()
    if not request_path or not result_path:
        print(
            "RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required; "
            "run this through local-training-worker.mjs",
            file=sys.stderr,
        )
        sys.exit(2)

    if _REQUESTED_DEVICE not in ("auto", "cpu", "cuda"):
        raise ValueError("RDK_STARTER_ENGINE_DEVICE must be 'auto', 'cuda', or 'cpu'")

    if not HAVE_JAX:
        print(
            "[mjx-adapter] REFUSED — jax/optax is not installed "
            "(python3 -m pip install --user jax optax). This adapter "
            "never fabricates a completed training run.",
            file=sys.stderr,
        )
        sys.exit(3)

    with open(request_path) as handle:
        request = json.load(handle)
    if request.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")

    contract = request.get("contract") or {}
    model = request.get("model") or {}
    training = request.get("training") or {}
    task = request.get("task") or {}
    observation_size = int(contract.get("observationSize", 0))
    action_size = int(contract.get("actionSize", 0))
    if observation_size <= 0 or action_size <= 0:
        raise ValueError("contract.observationSize and contract.actionSize are required")
    control_hz = int(contract.get("controlHz", 10))
    physics_dt = float(contract.get("physicsTimestepSeconds", 0.01))
    # MJX physics-timestep cap, probe-verified (probe_mjx.py
    # check_cpu_mjx_parity): at 0.02 the MJX contact solver injects energy
    # into this exact-touch 3-point stance (body outruns the wheel's
    # rolling speed); at 0.01 CPU MuJoCo and MJX agree to ~2 cm over 2 s.
    # The env derives decimation so control timing stays exact; the actual
    # values are recorded in the training summary and result metrics.
    physics_dt = min(physics_dt, _MJX_MAX_PHYSICS_DT)
    model_id = str(model.get("modelId", "mjx-policy"))
    version = str(model.get("version", "0.1.0"))
    profile = str(training.get("profile", "smoke"))
    pack = task if isinstance(task, dict) and task.get("kind") == "goal-navigation" else None
    # Layout resolution: the task pack's observationAdapterId is authoritative
    # (the platform injects it with the pack). A contract observationLayout
    # string names the same adapter id. The per-slot list form ({name: "x",
    # size: 1}, ...) describes slots, not a layout id — deriving a layout from
    # its first slot name misclassifies 8D manifest contracts as 42D.
    raw_layout = contract.get("observationLayout")
    if pack and pack.get("observationAdapterId"):
        obs_layout = str(pack["observationAdapterId"])
    elif isinstance(raw_layout, str) and raw_layout:
        obs_layout = raw_layout
    else:
        obs_layout = "originbot-imu-odom-v1"
    if obs_layout == "originbot-imu-odom-v1" and observation_size != 8:
        raise ValueError(
            "contract.observationSize {} violates the originbot-imu-odom-v1 layout (8)".format(observation_size)
        )
    if obs_layout == "imu-gravity-v1" and observation_size != 42:
        raise ValueError(
            "contract.observationSize {} violates the imu-gravity-v1 layout (42)".format(observation_size)
        )

    if pack is None:
        raise ValueError(
            "this adapter requires a goal-navigation task pack in the request; "
            "submit through the platform's task-pack training path"
        )

    # ---- choose the physics backend honestly --------------------------------
    use_mjx = HAVE_MJX and os.environ.get("RDK_MJX_ADAPTER_FORCE_MJX", "") != "0"
    if not use_mjx and not HAVE_TORCH:
        print(
            "[mjx-adapter] REFUSED — neither the mjx physics backend (mujoco) nor "
            "the kinematic fallback (torch) is importable; install one of them. "
            "This adapter never fabricates a completed training run.",
            file=sys.stderr,
        )
        sys.exit(3)
    physics_backend = "mjx" if use_mjx else "starter-kinematic"

    seed = int(pack.get("seed", 7))
    budget = PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])
    num_envs = env_int("RDK_MJX_ENGINE_ENVS", 0) or clamp_int(
        training.get("numEnvs"), 1, budget["envs"], budget["envs"]
    )
    max_iterations = env_int("RDK_MJX_ENGINE_ITERATIONS", 0) or clamp_int(
        training.get("maxIterations"), 1, budget["iterations"], min(budget["iterations"], 60)
    )
    rollout_steps = env_int("RDK_MJX_ENGINE_STEPS", budget["steps"])
    obs_size = observation_size
    act_size = action_size

    device_names, cuda = jax_device_summary()
    env = None
    decimation = 1
    if use_mjx:
        env = MjxGoalNavEnv(pack, num_envs, seed, physics_dt, obs_layout)
        decimation = env.decimation
    stdout(
        "engine=mjx-ppo physics={} task={} profile={} iters={} envs={} steps={} obs={} act={} "
        "control={}Hz decim={} physics_dt={} layout={} jax-devices={}".format(
            physics_backend, pack.get("id"), profile, max_iterations, num_envs, rollout_steps,
            obs_size, act_size, control_hz, decimation, physics_dt, obs_layout, device_names,
        )
    )

    started = time.time()
    if env is None:
        env = KinematicTrainEnv(pack, num_envs, seed)
    if env.observation_size != obs_size or env.action_size != act_size:
        raise ValueError(
            "environment dimensions {}x{} violate the contract {}x{}".format(
                env.observation_size, env.action_size, obs_size, act_size
            )
        )

    params = train_ppo(env, obs_size, act_size, max_iterations, rollout_steps, seed)
    training_seconds = round(time.time() - started, 1)
    policy_fn = policy_np(params)

    # ---- evaluation under pinned envelopes ----------------------------------
    envelopes = (pack.get("domainRandomization") or {}).get("evalEnvelopes") or {}
    eval_cfg = pack.get("evaluationConfig") or {}
    episodes_per_envelope = clamp_int(eval_cfg.get("episodesPerEnvelope"), 1, 200, 50)
    confidence = float(eval_cfg.get("confidenceLevel", 0.95))
    eval_seed = seed + 1000
    if use_mjx:
        trained_report = evaluate_goal_navigation_mjx(
            env, policy_fn, envelopes, eval_seed,
            episodes_per_envelope=episodes_per_envelope, confidence=confidence,
        )
        baseline_params = init_params(jax.random.PRNGKey(seed + 4242), obs_size, act_size)
        baseline_report = evaluate_goal_navigation_mjx(
            env, policy_np(baseline_params), envelopes, eval_seed,
            episodes_per_envelope=episodes_per_envelope, confidence=confidence,
        )
        gate = evaluate_quality_gate(
            trained_report, pack.get("qualityGate") or {}, baseline_report
        )
    else:
        trained_report, baseline_report, gate = evaluate_kinematic(
            params, pack, seed, episodes_per_envelope, confidence
        )

    latency = measure_control_latency_ms(params, obs_size)

    onnx_bytes = 0
    try:
        onnx_bytes = export_actor_onnx(params, obs_size, act_size, "policy.onnx")
        stdout("exported policy.onnx ({} bytes)".format(onnx_bytes))
    except Exception as error:  # noqa: BLE001 - export failure must not lose the run
        stdout("ONNX export failed: {}; continuing without it".format(error))

    with open("telemetry.jsonl", "w") as handle:
        for row in trained_report["jsonl"].get("hard", []):
            handle.write(json.dumps(row) + "\n")
    with open("baseline-telemetry.jsonl", "w") as handle:
        for row in baseline_report["jsonl"].get("nominal", []):
            handle.write(json.dumps(row) + "\n")
    with open("training-summary.json", "w") as handle:
        json.dump(
            {
                "engine": ADAPTER_ID,
                "physicsBackend": physics_backend,
                "task": pack["id"],
                "taskKind": "goal-navigation",
                "profile": profile,
                "iterations": max_iterations,
                "numEnvs": num_envs,
                "rolloutSteps": rollout_steps,
                "seed": seed,
                "jaxVersion": jax.__version__,
                "mujocoVersion": getattr(mujoco, "__version__", None) if use_mjx else None,
                "hyperparams": PPO_HYPERPARAMS,
                "device": device_names,
                "controlHz": control_hz,
                "physicsTimestepSeconds": physics_dt,
                "decimation": decimation,
                "sceneFidelity": {
                    "walls": bool(getattr(env, "workspace_bound", 0.0) > 0.0) if use_mjx else False,
                    "physicalObstacles": int(getattr(env, "obstacle_count", 0)) if use_mjx else 0,
                    "physicalDomainRandomization": bool(getattr(env, "physical_dr_active", False)) if use_mjx else False,
                },
                "eval": {k: v for k, v in trained_report.items() if k != "jsonl"},
                "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                "controlLatencyMs": latency,
                "measurementStage": "host-jax",
                "sourceCommit": source_commit_short(),
                "onnxExported": bool(onnx_bytes),
                "trainingSeconds": training_seconds,
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
                "engine": ADAPTER_ID,
                "physicsBackend": physics_backend,
                "trained": {k: v for k, v in trained_report.items() if k != "jsonl"},
                "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                "qualityGate": gate,
                "controlLatencyMs": latency,
                "measurementStage": "host-jax",
                "sourceCommit": source_commit_short(),
                "seed": eval_seed,
            },
            handle, indent=2,
        )

    nominal = trained_report["envelopes"].get("nominal") or {}
    baseline_nominal = baseline_report["envelopes"].get("nominal") or {}
    stdout(
        "eval nominal: successRate={:.2f} collisionRate={:.2f} (baseline {:.2f}/{:.2f}) gate={} physics={}".format(
            nominal.get("successRate", 0.0), nominal.get("collisionRate", 0.0),
            baseline_nominal.get("successRate", 0.0), baseline_nominal.get("collisionRate", 0.0),
            "PASS" if gate["passed"] else "FAIL", physics_backend,
        )
    )

    slug_model = safe_slug(model_id, ADAPTER_ID)
    slug_version = safe_slug(version, "0-1-0")
    result = {
        "checkpoint": {
            "checkpointId": "mjx-{}".format(slug_version),
            "artifactRef": "artifact://mjx/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": max_iterations,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://mjx/{}/{}/policy.onnx".format(slug_model, slug_version),
            "kind": "source",
            **({"format": "onnx", "runtime": "cpu-onnx", "workload": "goal-navigation", "threads": 1,
                "sizeBytes": onnx_bytes} if onnx_bytes else {"format": "unknown"}),
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": ADAPTER_ID,
            "physicsBackend": physics_backend,
            "taskId": pack["id"],
            "taskKind": "goal-navigation",
            "observationSize": obs_size,
            "actionSize": act_size,
            "iterations": max_iterations,
            "numEnvs": num_envs,
            "successRate": round(nominal.get("successRate", 0.0), 4),
            "successRateCiLow": round(nominal.get("successRateCiLow", 0.0), 4),
            "successRateCiHigh": round(nominal.get("successRateCiHigh", 0.0), 4),
            "evalEpisodes": nominal.get("episodes"),
            "collisionRate": round(nominal.get("collisionRate", 0.0), 4),
            "hardSuccessRate": round(
                (trained_report.get("envelopes", {}).get("hard") or {}).get("successRate", 0.0), 4
            ),
            "initialReward": round(baseline_report.get("meanReward", 0.0), 4),
            "reward": round(trained_report.get("meanReward", 0.0), 4),
            "qualityGatePassed": gate["passed"],
            "controlLatencyMs": latency,
            "measurementStage": "host-jax",
            "sourceCommit": source_commit_short(),
            "onnxExported": bool(onnx_bytes),
            "telemetrySamples": sum(len(rows) for rows in trained_report.get("jsonl", {}).values()),
        },
        "taskEvaluation": {
            "schemaVersion": 1,
            "taskId": pack["id"],
            "adapterId": pack["adapter"]["id"],
            "observationAdapterId": pack["adapter"]["policy"]["observationAdapterId"],
            "trained": {k: v for k, v in trained_report.items() if k != "jsonl"},
            "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
            "qualityGate": gate,
            "controlLatencyMs": latency,
            "measurementStage": "host-jax",
            "sourceCommit": source_commit_short(),
            "seed": eval_seed,
        },
        "deployable": False,
        "source": source_revision(),
        "dependencies": dependency_versions(),
        "dependencyLockSha256": dependency_lock_digest(),
        "cuda": cuda,
        "physicsBackend": physics_backend,
    }
    # Integrity manifest for the artifacts this run produced. Written before the
    # result so the consumer can verify the bundle it is about to trust.
    write_artifact_manifest(os.path.dirname(os.path.abspath(result_path)))

    # allow_nan=False is a contract, not a nicety: the platform worker parses
    # this file with a strict JSON parser, and a bare NaN token would make the
    # whole result unreadable (masking whatever actually went wrong) on every
    # consumer. A ValueError here names the offending key.
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2, allow_nan=False)
    stdout("wrote result (physicsBackend={})".format(physics_backend))


if __name__ == "__main__":
    main()
