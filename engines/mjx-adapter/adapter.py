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
        kind = getattr(device, "device_kind", None) or getattr(device, "platform", "?")
        kinds.append(str(kind).lower())
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


def evaluate_quality_gate(report, quality_gate):
    """Apply the task's quality gate to the nominal envelope metrics.

    Identical fail-closed semantics to the starter engine: a missing metric
    never passes, ciLowerBound judges success on the CI low bound and
    collision on the CI high bound.
    """
    nominal = (report.get("envelopes") or {}).get("nominal") or {}
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
    return {
        "passed": not errors,
        "errors": errors,
        "criteria": {
            "minSuccessRate": min_success,
            "maxCollisionRate": max_collision,
            "gateOn": gate_on,
        },
        "measured": {
            "successRate": nominal.get("successRate"),
            "collisionRate": nominal.get("collisionRate"),
            "successRateCiLow": nominal.get("successRateCiLow"),
            "collisionRateCiHigh": nominal.get("collisionRateCiHigh"),
            "episodes": nominal.get("episodes"),
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


def build_mjcf(physics_dt):
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
    # No walls or box obstacles in this MJCF: MJX has no cylinder-box
    # collision, and obstacles are task-level analytic circles anyway
    # (which is what keeps the quality gate cross-engine comparable).
    wheels = _originbot.wheel_bodies_template()
    base = _originbot.BASE
    chassis = base["chassisSize"]
    return MJCF_TEMPLATE.format(
        TIMESTEP=repr(float(physics_dt)),
        BASE_HEIGHT=repr(REST_HEIGHT),
        CHASSIS_SIZE="{} {} {}".format(chassis[0], chassis[1], chassis[2]),
        CHASSIS_MASS=float(base["chassisMass"]),
        WHEEL_BODIES=wheels,
        CASTER='<geom name="caster" pos="{x} 0 {z}" type="sphere" size="{s}" mass="{m}" friction="0.02 0.005 0.001"/>'.format(
            x=_originbot.CASTER["posX"], z=-0.115, s=_originbot.CASTER["size"], m=_originbot.CASTER["mass"]),
        WHEEL_ACTUATORS=_originbot.wheel_actuators(
            "wheel_first", forcerange=float(_originbot.WHEELS["maxTorque"])
        ),
    )


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

        mj_model = mujoco.MjModel.from_xml_string(build_mjcf(self.physics_dt))
        mj_data = mujoco.MjData(mj_model)
        mujoco.mj_forward(mj_model, mj_data)
        self.mjx_model = mjx.put_model(mj_model)
        self._template = mjx.put_data(mj_model, mj_data)
        self._zero_nv = jnp.zeros(mj_model.nv)

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
        distance = jax.random.uniform(k_goal, (), minval=goal_lo, maxval=goal_hi)
        angle = jax.random.uniform(k_angle, (), minval=0.0, maxval=2.0 * math.pi)
        yaw = jax.random.uniform(k_yaw, (), minval=-math.pi, maxval=math.pi)
        goal = jnp.stack([distance * jnp.cos(angle), distance * jnp.sin(angle)])
        if self.obstacle_count:
            obstacles = jax.random.uniform(
                k_obs, (self.obstacle_count, 3),
                minval=-self.obstacle_spread, maxval=self.obstacle_spread,
            ).at[:, 2].set(self.obstacle_radius)
        else:
            obstacles = jnp.zeros((0, 3))
        domain = self.dr_mins + jax.random.uniform(k_domain, (7,)) * (self.dr_maxs - self.dr_mins)
        latency = jax.random.randint(
            k_latency, (), minval=self.latency_min, maxval=self.latency_max + 1
        )
        init_qpos = jnp.concatenate([
            jnp.asarray([0.0, 0.0, REST_HEIGHT]),
            jnp.asarray([jnp.cos(yaw / 2.0), 0.0, 0.0, jnp.sin(yaw / 2.0)]),
            jnp.zeros(2),
        ])
        data = self._template.replace(qpos=init_qpos, qvel=self._zero_nv)
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
        data = state["data"].replace(ctrl=ctrl)
        data = jax.lax.fori_loop(0, self.decimation, lambda _i, d: mjx.step(self.mjx_model, d), data)
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
        # episode — the whole point of a pinned-envelope A/B.
        state["domain"] = jnp.tile(domain, (episodes, 1))
        state["latency"] = jnp.full((episodes,), int(latency), dtype=jnp.int32)

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
    gate = starter.evaluate_quality_gate(trained_report, pack.get("qualityGate") or {})
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
        gate = evaluate_quality_gate(trained_report, pack.get("qualityGate") or {})
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
                "eval": {k: v for k, v in trained_report.items() if k != "jsonl"},
                "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                "controlLatencyMs": latency,
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
            "seed": eval_seed,
        },
        "deployable": False,
        "cuda": cuda,
        "physicsBackend": physics_backend,
    }
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    stdout("wrote result (physicsBackend={})".format(physics_backend))


if __name__ == "__main__":
    main()
