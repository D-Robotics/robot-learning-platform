#!/usr/bin/env python3
"""dm_control worker adapter: DeepMind's env API over the shared MuJoCo scene.

Implements the platform worker protocol (read RDK_SIM2REAL_REQUEST_FILE, write
RDK_SIM2REAL_RESULT_FILE) with dm_control 1.x as the environment layer:

  * physics — mjcf.Physics.from_xml_string compiles the SAME calibrated
    OriginBot MJCF the MJX and visual engines compile (engines/mjx-adapter
    build_mjcf: walls, mocap obstacle spheres, force-limited wheel servos,
    implicitfast integrator; single calibration source in assets/originbot).
  * environment — dm_control.rl.control.Environment with control_timestep =
    the task's control period and n_sub_steps derived from the physics dt,
    so dm_control itself owns the decimation loop (its own after_step /
    episode bookkeeping runs at the task rate, exactly what the DeepMind
    ecosystem trains against).
  * task — a control.Task subclass carrying the platform's goal-navigation
    semantics: 8D board observation layout (odom pose + noisy gyro/odom),
    progress/goal/collision reward, goal/collision/timeout termination,
    first-order motor gain/lag and FIFO action latency (starter semantics),
    per-episode domain randomization.
  * learner — the same pure-JAX clipped PPO the mjx/visual engines use,
    over a vectorized host-side loop of dm_control environments
    (dm_env.TimeStep batches). One env per replica, no MJX; CPU MuJoCo.

Honesty contract, same as every sibling adapter:
  * physicsBackend = "dm-control-mujoco" — the env API is dm_control's, the
    physics is CPU MuJoCo compiled from the shared scene source. dm_control
    is NOT a second physics engine and the result never implies it is.
  * deployable stays false (board deployment needs the BPU pipeline).
  * missing dm_control / mujoco / jax -> exit 3 REFUSED, never a fabricated
    completed run; missing numpy -> exit 2 (protocol guard).

Register with the local worker:

  RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"dm-control-ppo":{"executable":"/path/to/python","args":["/abs/path/to/engines/dm-control-adapter/adapter.py"]}}'
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
    import mujoco  # noqa: F401 - the physics dm_control drives
    HAVE_MUJOCO = True
except ImportError:
    HAVE_MUJOCO = False

try:
    import dm_env  # noqa: F401
    from dm_control.rl import control as dm_control_rl  # noqa: F401
    HAVE_DM_CONTROL = True
except ImportError:
    HAVE_DM_CONTROL = False

ADAPTER_ID = "dm-control-ppo"
PHYSICS_BACKEND = "dm-control-mujoco"

# 8D board layout (starter GOAL_NAV_OBS["originbot-imu-odom-v1"]):
# [x, y, sin(yaw), cos(yaw), dx, dy, v, w] — the obs this engine accepts.
_OBS_SIZE = 8
_ACTION_SIZE = 2

PROFILE_BUDGETS = {
    "smoke": {"iterations": 40, "envs": 8, "steps": 64},
    "low-vram": {"iterations": 200, "envs": 8, "steps": 64},
    "standard": {"iterations": 200, "envs": 12, "steps": 64},
    "high-vram": {"iterations": 300, "envs": 16, "steps": 64},
}

PPO_HYPERPARAMS = {
    "gamma": 0.99, "gaeLambda": 0.95, "clip": 0.2, "actorLr": 3.0e-4,
    "entropyCoef": 0.005, "valueCoef": 0.5, "epochs": 4, "minibatch": 128,
    "maxGradNorm": 0.5, "hidden": 128,
}

HIDDEN = 128
INIT_LOG_STD = -0.7


def stdout(line):
    print("[dm-control-adapter] " + str(line), flush=True)


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


def source_revision():
    import subprocess
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                              timeout=10, cwd=os.path.dirname(os.path.abspath(__file__)))
        if head.returncode == 0:
            return head.stdout.strip().lower()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def source_commit_short():
    revision = source_revision()
    return revision[:12] if revision else None


def _repo_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_calibration():
    """Wheel constants from the single calibration source (no re-typing)."""
    calib_path = os.path.join(_repo_root(), "assets", "originbot", "calibration.json")
    with open(calib_path) as handle:
        calib = json.load(handle)
    wheels = calib["wheels"]
    return (
        float(wheels["radius"]),
        float(wheels["trackWidth"]),
        float(wheels["maxWheelSpeed"]),
    )


_WHEEL_RADIUS, _TRACK_WIDTH, _MAX_WHEEL_SPEED = _load_calibration()


def _load_mjx_builder():
    """Import the mjx-adapter's build_mjcf as the shared scene source.

    The dm_control env MUST NOT hand-roll a second robot: walls, calibrated
    chassis/wheels/caster, force-limited servos all come from the same
    build_mjcf the mjx/visual engines compile (single calibration source).
    """
    import importlib.util

    mjx_path = os.path.join(_repo_root(), "engines", "mjx-adapter", "adapter.py")
    spec = importlib.util.spec_from_file_location("mjx_adapter_for_dm_control", mjx_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_mjcf


def dependency_versions():
    """Installed versions of the stack that actually produced the artifact."""
    versions = {}
    for name, module in (("jax", jax), ("mujoco", mujoco if HAVE_MUJOCO else None),
                         ("dm-control", None), ("dm-env", None), ("optax", optax)):
        try:
            if module is not None:
                versions[name] = getattr(module, "__version__", None) or "unknown"
            elif name == "dm-control":
                from dm_control._version import __version__ as dm_version  # noqa: PLC0415
                versions[name] = dm_version
            elif name == "dm-env":
                import dm_env  # noqa: PLC0415
                versions[name] = getattr(dm_env, "__version__", None) or "unknown"
        except Exception:  # noqa: BLE001 - version probing never fails a run
            versions[name] = "unknown"
    return versions


# ---------------------------------------------------------------------------
# The dm_control Task: platform goal-navigation semantics inside control.Task.
# ---------------------------------------------------------------------------
class GoalNavTask:
    """dm_control task carrying the platform's goal-navigation semantics.

    Observation, reward, and termination are the starter engine's definitions
    (8D board layout, progress/goal/collision/dwell reward, goal-eps/timeout
    termination, first-order motor gain+lag, FIFO action latency, per-episode
    domain randomization) so the quality gate stays cross-engine comparable.

    The task reads TRUE pose from physics.qpos (success and collision are
    measured on the true pose, never the believed one) and maintains a slip-
    and bias-blind odometry belief exactly like the starter env.
    """

    def __init__(self, pack, rng):
        self.pack = pack
        self.rng = rng
        termination = pack.get("termination") or {}
        self.goal_eps = float(termination.get("goalDistance", 0.15))
        self.timeout_steps = int(termination.get("timeoutSteps", 300))
        safety = (pack.get("adapter") or {}).get("safety") or {}
        self.max_linear = float(safety.get("maxLinear", 0.3))
        self.max_angular = float(safety.get("maxAngular", 1.0))
        self.reward_cfg = {k: float(v) for k, v in (pack.get("reward") or {}).items()}
        workspace = pack.get("workspace") or {}
        self.bound = float(workspace.get("bound") or 2.0)
        obstacle_spec = workspace.get("obstacles") or {}
        self.obstacle_count = int(obstacle_spec.get("count", 0))
        self.obstacle_radius = float(obstacle_spec.get("radius", 0.15))
        dr = pack.get("domainRandomization") or {}
        self.dr = {
            "motorGain": tuple(dr.get("motorGain") or [1.0, 1.0]),
            "lagTau": tuple(dr.get("lagTauSeconds") or [0.05, 0.05]),
            "gyroNoise": tuple(dr.get("gyroNoiseStd") or [0.0, 0.0]),
            "odomNoise": tuple(dr.get("odomNoiseStd") or [0.0, 0.0]),
        }
        # Episode state (set in initialize_episode).
        self.goal = np.zeros(2, dtype=np.float64)
        self.steps = 0
        self.v_lag = 0.0
        self.w_lag = 0.0
        self.fifo = deque()
        self._queue_latency = 0
        self.gain = 1.0
        self.lag_tau = 0.05
        self.gyro_noise = 0.0
        self.odom_noise = 0.0
        self.odom = np.zeros(3, dtype=np.float64)
        self.prev_distance = 0.0
        self._obstacles = []
        self._collided = False
        self._success = False
        self._last_action_magnitude = 0.0
        # Pinned-evaluation state resets here too: a leftover pin from a
        # previous envelope would leak into training episodes.
        self._pinned_bias = 0.0
        self._pinned_slip = 1.0
        self._pinned_dropout = 0.0
        self._pinned_domain = None
        self._obs_initialized = False
        self._last_obs = None

    # ---- dm_control.Task contract ------------------------------------------
    def action_spec(self, physics):
        from dm_env import specs

        return specs.BoundedArray(
            shape=(_ACTION_SIZE,), dtype=np.float32, minimum=-1.0, maximum=1.0,
            name="command",
        )

    def observation_spec(self, physics):
        from dm_env import specs

        return specs.Array(shape=(_OBS_SIZE,), dtype=np.float32, name="board_obs")

    def initialize_episode(self, physics):
        """Spawn: origin pose, random yaw/goal, sampled domain, zeroed FIFO.

        The goal marker is not part of this scene (state obs, not vision);
        the goal lives in task state, same as the starter engine.
        """
        rng = self.rng
        distance = rng.uniform(0.8, 1.6)
        angle = rng.uniform(0.0, 2.0 * math.pi)
        self.goal = np.array([distance * math.cos(angle), distance * math.sin(angle)])
        yaw = rng.uniform(-math.pi, math.pi)
        mujoco.mj_resetData(physics.model.ptr if hasattr(physics.model, "ptr") else physics.model._model,
                            physics.data.ptr if hasattr(physics.data, "ptr") else physics.data._data)
        physics.data.qpos[0:2] = 0.0
        physics.data.qpos[2] = 0.17
        physics.data.qpos[3:7] = [math.cos(yaw / 2.0), 0.0, 0.0, math.sin(yaw / 2.0)]
        physics.data.qpos[7:9] = 0.0
        # Obstacles (mocap bodies 0..n-1, before any vision marker).
        self._obstacles = []
        spread = self.bound or 1.5
        for idx in range(self.obstacle_count):
            ox = rng.uniform(-spread, spread)
            oy = rng.uniform(-spread, spread)
            physics.data.mocap_pos[idx][0] = ox
            physics.data.mocap_pos[idx][1] = oy
            self._obstacles.append((ox, oy, self.obstacle_radius))
        mujoco.mj_forward(physics.model.ptr if hasattr(physics.model, "ptr") else physics.model._model,
                          physics.data.ptr if hasattr(physics.data, "ptr") else physics.data._data)
        self.steps = 0
        self.v_lag = 0.0
        self.w_lag = 0.0
        self.gain = rng.uniform(*self.dr["motorGain"])
        self.lag_tau = rng.uniform(*self.dr["lagTau"])
        self.gyro_noise = rng.uniform(*self.dr["gyroNoise"])
        self.odom_noise = rng.uniform(*self.dr["odomNoise"])
        latency_steps = 0  # latency DR arrives via task-pack dr; starter derives it
        dr = self.pack.get("domainRandomization") or {}
        latency_range = dr.get("actionLatencySteps")
        if latency_range:
            latency_steps = max(0, int(rng.uniform(*latency_range)))
        self.fifo.clear()
        self.fifo.extend([(0.0, 0.0)] * latency_steps)
        self._queue_latency = latency_steps
        self.odom = np.zeros(3, dtype=np.float64)
        self.odom[2] = yaw
        self.prev_distance = float(np.linalg.norm(self.goal))
        self._collided = False
        self._success = False

    def before_step(self, action, physics, random_state=None):
        """Write wheel commands from the (possibly delayed) diff-drive order.

        dm_control applies physics n_sub_steps after this returns; the
        first-order motor gain/lag is applied at command level (starter
        semantics), then differential-drive IK turns (v, w) into clipped
        wheel-speed servo targets. Hook signature probed on the installed
        wheel: (action, physics) — the legacy (physics, action, random_state)
        order was removed in dm_control 1.x.
        """
        control_dt = 1.0 / float(self.pack.get("controlHz", 10))
        linear = float(np.clip(action[0], -1.0, 1.0)) * self.max_linear
        angular = float(np.clip(action[1], -1.0, 1.0)) * self.max_angular
        self._last_action_magnitude = float(
            np.mean(np.abs(np.clip(np.asarray(action, dtype=np.float32), -1.0, 1.0)))
        )
        self.fifo.append((linear, angular))
        target_v, target_w = self.fifo.popleft()
        alpha = min(1.0, control_dt / max(self.lag_tau, 1e-6))
        self.v_lag += alpha * (target_v * self.gain - self.v_lag)
        self.w_lag += alpha * (target_w * self.gain - self.w_lag)
        # Pinned-evaluation veer/slip: a constant angular bias veers the true
        # chassis (starter applies it to the true yaw; physics here owns the
        # true pose, so it enters as a command-level veer), and slip scales
        # the effective wheel command (weak traction). The odometry belief
        # above integrates the UN-veered, UN-sipped command — hardware-blind
        # exactly as the starter's odom is.
        bias = getattr(self, "_pinned_bias", 0.0)
        slip = getattr(self, "_pinned_slip", 1.0)
        w_true = self.w_lag + bias
        left = (self.v_lag * slip - w_true * 0.5 * _TRACK_WIDTH) / _WHEEL_RADIUS
        right = (self.v_lag * slip + w_true * 0.5 * _TRACK_WIDTH) / _WHEEL_RADIUS
        physics.data.ctrl[:] = [
            np.clip(left, -_MAX_WHEEL_SPEED, _MAX_WHEEL_SPEED),
            np.clip(right, -_MAX_WHEEL_SPEED, _MAX_WHEEL_SPEED),
        ]

    def after_step(self, physics, random_state=None):
        """Integrate the slip/bias-blind odometry belief (starter semantics).

        Hook signature probed on the installed wheel: (physics) only.
        A pinned envelope's angular bias veers the TRUE body rotation (the
        starter applies it to the true yaw); here the true pose is MuJoCo's
        own, so the bias is applied to the wheel command level in
        before_step (a constant veer torque) — the odometry belief stays
        blind to it exactly as on hardware.
        """
        control_dt = 1.0 / float(self.pack.get("controlHz", 10))
        odom_yaw = self.odom[2] + self.w_lag * control_dt
        odom_yaw = (odom_yaw + math.pi) % (2.0 * math.pi) - math.pi
        self.odom[2] = odom_yaw
        self.odom[0] += self.v_lag * math.cos(odom_yaw) * control_dt
        self.odom[1] += self.v_lag * math.sin(odom_yaw) * control_dt
        self.steps += 1

    def get_observation(self, physics):
        """8D board layout from the believed pose + noisy proprio (starter)."""
        odom_x, odom_y, odom_yaw = self.odom
        noisy_x = odom_x + self.rng.normal(0.0, self.odom_noise)
        noisy_y = odom_y + self.rng.normal(0.0, self.odom_noise)
        return np.asarray([
            noisy_x, noisy_y,
            math.sin(odom_yaw), math.cos(odom_yaw),
            self.goal[0] - noisy_x, self.goal[1] - noisy_y,
            self.v_lag, self.w_lag + self.rng.normal(0.0, self.gyro_noise),
        ], dtype=np.float32)

    def get_reward(self, physics):
        # actionPenalty scales with the executed command magnitude (starter
        # semantics: penalty * mean(|clip(action)|)); get_reward has no
        # action argument, so the last executed command is remembered in
        # before_step.
        x = float(physics.data.qpos[0])
        y = float(physics.data.qpos[1])
        distance = math.hypot(self.goal[0] - x, self.goal[1] - y)
        self._success = distance < self.goal_eps
        collided = self._hit_obstacle(physics)
        penalty = self.reward_cfg.get("actionPenalty", 0.0) * self._last_action_magnitude
        reward = (
            self.reward_cfg.get("progress", 0.0) * (self.prev_distance - distance)
            + penalty
            + (self.reward_cfg.get("goal", 0.0) if self._success else 0.0)
            + (self.reward_cfg.get("collision", 0.0) if collided else 0.0)
        )
        if self.reward_cfg.get("dwell", 0.0) and distance < self.goal_eps * 1.5:
            reward += self.reward_cfg["dwell"]
        self.prev_distance = distance
        return float(reward)

    def _hit_obstacle(self, physics):
        if not self._obstacles:
            return False
        x = float(physics.data.qpos[0])
        y = float(physics.data.qpos[1])
        for ox, oy, radius in self._obstacles:
            if math.hypot(x - ox, y - oy) <= radius:
                return True
        return False

    def get_termination(self, physics):
        """dm_control discount contract (probed in control.py source):
        `episode_over = discount is not None` — returning None CONTINUES the
        episode, returning a discount value TERMINATES it.

        0.0 on termination matches the starter engine's done semantics (zero
        bootstrap at episode end: the GAE loop uses next_value=0). Terminates
        on goal reach, obstacle hit, arena exit, or timeout.
        """
        if self._success:
            return 0.0
        if self._hit_obstacle(physics):
            return 0.0
        x = float(physics.data.qpos[0])
        y = float(physics.data.qpos[1])
        if self.bound > 0.0 and (abs(x) > self.bound or abs(y) > self.bound):
            return 0.0
        if self.steps >= self.timeout_steps:
            return 0.0
        return None

    def get_discount(self, physics):
        return 1.0


# ---------------------------------------------------------------------------
# Vectorized training loop over dm_control environments.
# ---------------------------------------------------------------------------
class DmControlVecEnvs:
    """N independent dm_control Environments stepped in a host-side loop.

    Each env is a real dm_control Environment (own Physics from the shared
    MJCF, own Task with own rng); step() returns the starter-shaped
    (obs, reward, done, success) batch the shared JAX PPO loop consumes,
    with auto-reset so rollouts stay dense. Terminal state is captured
    BEFORE the reset so evaluation reads the real final distance.
    """

    def __init__(self, pack, num_envs, seed, physics_dt):
        from dm_env import specs  # noqa: F401 - guarded by HAVE_DM_CONTROL

        control_hz = float(pack.get("controlHz", 10))
        control_dt = 1.0 / control_hz
        decimation = max(1, int(round(control_dt / float(physics_dt))))
        self.num_envs = num_envs
        self.observation_size = _OBS_SIZE
        self.action_size = _ACTION_SIZE
        self.timeout_steps = int((pack.get("termination") or {}).get("timeoutSteps", 300))
        self._environments = []
        self._tasks = []
        build_mjcf = _load_mjx_builder()
        xml = build_mjcf(float(physics_dt), float((pack.get("workspace") or {}).get("bound") or 2.0),
                         int(((pack.get("workspace") or {}).get("obstacles") or {}).get("count", 0)))
        for env_idx in range(num_envs):
            physics = _physics_from_xml(xml)
            task = GoalNavTask(pack, np.random.default_rng(seed + 17 * env_idx))
            # control_timestep alone: dm_control derives n_sub_steps from the
            # model's own timestep (probing both flags raises — the API wants
            # exactly one way to say "decimation").
            env = dm_control_rl.Environment(
                physics, task,
                control_timestep=control_dt,
            )
            self._environments.append(env)
            self._tasks.append(task)
        self.success_history = []
        self._episode_final = {}

    def close(self):
        for env in self._environments:
            closer = getattr(env, "close", None)
            if closer is not None:
                closer()
        self._environments = []

    def observe(self):
        out = np.zeros((self.num_envs, self.observation_size), dtype=np.float32)
        for env_idx, env in enumerate(self._environments):
            task = self._tasks[env_idx]
            out[env_idx] = task.get_observation(env.physics)
        return out

    def step(self, actions):
        from dm_env import StepType  # noqa: PLC0415 - local import, cheap after first

        rewards = np.zeros(self.num_envs, dtype=np.float32)
        dones = np.zeros(self.num_envs, dtype=bool)
        successes = np.zeros(self.num_envs, dtype=bool)
        for env_idx, env in enumerate(self._environments):
            task = self._tasks[env_idx]
            action = np.asarray(actions[env_idx], dtype=np.float32)
            timestep = env.step(action)
            if timestep.step_type == StepType.FIRST:
                # The env just auto-reset (the previous call ended the episode
                # and this call consumed the reset): a fresh start, not done.
                # The training loop never lands here — done was True last call
                # and the PPO buffer treats that step as terminal — but if a
                # caller keeps stepping past done, this reads as a new episode.
                continue
            rewards[env_idx] = float(timestep.reward or 0.0)
            done = timestep.step_type == StepType.LAST
            successes[env_idx] = bool(task._success)
            dones[env_idx] = done
            if done:
                physics = env.physics
                x = float(physics.data.qpos[0])
                y = float(physics.data.qpos[1])
                self._episode_final[env_idx] = {
                    "finalDistance": math.hypot(task.goal[0] - x, task.goal[1] - y),
                    "collision": bool(task._hit_obstacle(physics)),
                }
                self.success_history.append(bool(task._success))
                # Next env.step() will return the FIRST timestep of the new
                # episode (dm_control resets lazily); no eager reset needed.
        return self.observe(), rewards, dones, successes


def _physics_from_xml(xml):
    """Compile the shared MJCF into a dm_control Physics object."""
    from dm_control import mjcf

    return mjcf.Physics.from_xml_string(xml)


# ---------------------------------------------------------------------------
# JAX MLP actor-critic + clipped PPO (same recipe as the mjx engine).
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


@jax.jit
def act_deterministic(params, obs):
    mu, _ = forward(params, obs)
    return jnp.clip(mu, -1.0, 1.0)


def gae_returns(rewards, values, dones, gamma, lam):
    adv = jnp.zeros_like(rewards)
    last_gae = jnp.zeros(rewards.shape[1])
    next_value = jnp.zeros(rewards.shape[1])
    for t in reversed(range(rewards.shape[0])):
        delta = rewards[t] + gamma * next_value * (1.0 - dones[t]) - values[t]
        last_gae = delta + gamma * lam * (1.0 - dones[t]) * last_gae
        adv = adv.at[t].set(last_gae)
        next_value = values[t]
    return adv + values


_OPTIMIZER = optax.chain(
    optax.clip_by_global_norm(PPO_HYPERPARAMS["maxGradNorm"]),
    optax.adam(PPO_HYPERPARAMS["actorLr"]),
)


def _loss_and_grad(params, opt_state, obs, act, old_logp, adv, ret):
    mu, value = forward(params, obs)
    std = _std_of(params)
    logp = jnp.sum(
        -0.5 * ((act - mu) / std) ** 2 - jnp.log(std) - 0.5 * math.log(2.0 * math.pi), axis=-1
    )
    ratio = jnp.exp(jnp.clip(logp - old_logp, -20.0, 20.0))
    clipped = jnp.clip(ratio, 1.0 - PPO_HYPERPARAMS["clip"], 1.0 + PPO_HYPERPARAMS["clip"]) * adv
    policy_loss = -jnp.mean(jnp.minimum(ratio * adv, clipped))
    value_loss = jnp.mean((ret - value) ** 2)
    entropy = jnp.mean(jnp.sum(jnp.log(std) + 0.5 * math.log(2.0 * math.pi * math.e), axis=-1))
    loss = (policy_loss + PPO_HYPERPARAMS["valueCoef"] * value_loss
            - PPO_HYPERPARAMS["entropyCoef"] * entropy)
    grads = jax.grad(lambda p: loss)(params)
    updates, new_state = _OPTIMIZER.update(grads, opt_state, params)
    return optax.apply_updates(params, updates), new_state


_ppo_update = jax.jit(_loss_and_grad)


def train_ppo(env, iterations, rollout_steps, seed):
    params = init_params(jax.random.PRNGKey(seed), env.observation_size, env.action_size)
    opt_state = _OPTIMIZER.init(params)
    rng = jax.random.PRNGKey(seed + 1)
    obs_np = env.observe()
    started = time.time()
    for iteration in range(iterations):
        batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done = [], [], [], [], [], []
        obs = jnp.asarray(obs_np, dtype=jnp.float32)
        for _step in range(rollout_steps):
            rng, k_act, k_noise = jax.random.split(rng, 3)
            mu, value = forward(params, obs)
            std = _std_of(params)
            noise = jax.random.normal(k_noise, mu.shape)
            action = mu + std * noise
            logp = jnp.sum(
                -0.5 * ((action - mu) / std) ** 2 - jnp.log(std) - 0.5 * math.log(2.0 * math.pi),
                axis=-1,
            )
            next_obs, reward, done, _succ = env.step(np.asarray(action))
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
        obs_flat = flat_obs.reshape((-1, env.observation_size))
        act_flat = flat_act.reshape((-1, env.action_size))
        logp_flat = flat_logp.reshape(-1)
        returns_flat = returns.reshape(-1)
        total = obs_flat.shape[0]
        mb = min(PPO_HYPERPARAMS["minibatch"], total)
        for _epoch in range(PPO_HYPERPARAMS["epochs"]):
            rng, perm_key = jax.random.split(rng)
            order = jax.random.permutation(perm_key, total)
            for start in range(0, total, mb):
                idx = order[start:start + mb]
                params, opt_state = _ppo_update(
                    params, opt_state, obs_flat[idx], act_flat[idx],
                    logp_flat[idx], advantage[idx], returns_flat[idx],
                )
        if (iteration + 1) % max(1, iterations // 8) == 0 or iteration == iterations - 1:
            recent = env.success_history[-50:]
            stdout("iter {}/{} meanReward={:.3f} recentSuccess={:.2f} elapsed={:.1f}s".format(
                iteration + 1, iterations, float(np.mean(np.asarray(flat_rew))),
                round(sum(recent) / len(recent), 3) if recent else 0.0, time.time() - started,
            ))
    return params


# ---------------------------------------------------------------------------
# ONNX export (same hand-built graph as the mjx engine's MLP exporter).
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
        helper.make_node("Clip", ["mu", "clip_min", "clip_max"], ["action"]),
    ]
    observation = helper.make_tensor_value_info(
        "observation", TensorProto.FLOAT, ["batch", obs_size]
    )
    action = helper.make_tensor_value_info("action", TensorProto.FLOAT, ["batch", act_size])
    graph = helper.make_graph(
        nodes, "dm_control_actor", [observation], [action], initializer=initializers
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, path)
    return os.path.getsize(path)


def measure_control_latency_ms(params, obs_size):
    sample = jnp.zeros((1, obs_size), dtype=jnp.float32)
    act_deterministic(params, sample).block_until_ready()
    timings = []
    for _ in range(32):
        started = time.perf_counter()
        act_deterministic(params, sample).block_until_ready()
        timings.append((time.perf_counter() - started) * 1000.0)
    return round(float(np.median(timings)), 3)


def write_artifact_manifest(job_dir):
    import hashlib
    lines = []
    for name in sorted(os.listdir(job_dir)):
        if name in {"SHA256SUMS", "result.json", "request.json"} or name.startswith("."):
            continue
        path = os.path.join(job_dir, name)
        if not os.path.isfile(path):
            continue
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        lines.append("%s  %s" % (digest.hexdigest(), name))
    if not lines:
        raise RuntimeError("no artifacts to record in SHA256SUMS under %s" % job_dir)
    with open(os.path.join(job_dir, "SHA256SUMS"), "w") as handle:
        handle.write("\n".join(lines) + "\n")


def wilson_bounds(successes, total, confidence=0.95):
    """Wilson score interval — the starter's exact formula."""
    if total <= 0:
        return 0.0, 0.0
    z = 1.959963984540054 if confidence >= 0.95 else 1.6448536269514722
    phat = successes / total
    denom = 1.0 + z * z / total
    center = (phat + z * z / (2.0 * total)) / denom
    half = z * math.sqrt(phat * (1.0 - phat) / total + z * z / (4.0 * total * total)) / denom
    return max(0.0, center - half), min(1.0, center + half)


def evaluate_quality_gate(report, quality_gate, baseline=None):
    """Starter-shaped gate verdict from the pinned-envelope report."""
    gate_cfg = quality_gate or {}
    nominal = (report.get("envelopes") or {}).get("nominal") or {}
    hard = (report.get("envelopes") or {}).get("hard") or {}
    errors = []
    min_success = gate_cfg.get("minSuccessRate")
    if min_success is not None and nominal.get("successRate", 0.0) < float(min_success):
        errors.append("nominal successRate {:.4f} below gate {:.2f}".format(
            nominal.get("successRate", 0.0), float(min_success)))
    min_hard = gate_cfg.get("minHardSuccessRate")
    if min_hard is not None and hard.get("successRate", 0.0) < float(min_hard):
        errors.append("hard successRate {:.4f} below gate {:.2f}".format(
            hard.get("successRate", 0.0), float(min_hard)))
    max_collision = gate_cfg.get("maxCollisionRate")
    if max_collision is not None and nominal.get("collisionRate", 1.0) > float(max_collision):
        errors.append("nominal collisionRate {:.4f} above gate {:.2f}".format(
            nominal.get("collisionRate", 1.0), float(max_collision)))
    if gate_cfg.get("requireBetterThanBaseline") and baseline is not None:
        trained_mean = report.get("meanReward", 0.0)
        baseline_mean = baseline.get("meanReward", 0.0)
        if trained_mean <= baseline_mean:
            errors.append("trained meanReward {:.4f} not above baseline {:.4f}".format(
                trained_mean, baseline_mean))
    return {"passed": not errors, "errors": errors}


def _parse_envelope(envelope):
    """Positional eval-envelope tuple, starter's exact order and padding:
    [motorGain, lagTauSeconds, gyroNoiseStd, odomNoiseStd, angularBias,
    actionLatencySteps, odomDropoutProb, slipScale]; a legacy 6-number
    envelope keeps old semantics (no dropout, no slip).
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
    return {
        "motorGain": motor_gain, "lagTau": lag_tau, "gyroNoise": gyro_noise,
        "odomNoise": odom_noise, "angularBias": angular_bias,
        "latencySteps": int(latency), "odomDropout": odom_dropout,
        "slipScale": slip_scale,
    }


def run_episodes(env, policy_fn, envelope, seed, episodes):
    """Pinned-envelope evaluation over the dm_control envs (mjx report shape).

    The domain tuple is pinned by re-spawning every env with the envelope's
    motor gain / lag / latency / noise values (no sampling), so every episode
    in the envelope runs the exact disturbance the task pack declared.
    """
    from dm_env import StepType

    domain = _parse_envelope(envelope)
    gain, lag = domain["motorGain"], domain["lagTau"]
    gyro, odom = domain["gyroNoise"], domain["odomNoise"]
    bias, slip = domain["angularBias"], domain["slipScale"]
    latency = domain["latencySteps"]
    dropout = domain["odomDropout"]
    outcomes, rows = [], []
    for env_idx, dm_env_instance in enumerate(env._environments):
        task = env._tasks[env_idx]
        task.dr = {
            "motorGain": (gain, gain), "lagTau": (lag, lag),
            "gyroNoise": (gyro, gyro), "odomNoise": (odom, odom),
        }
        task._pinned_domain = dict(domain)
        task.rng = np.random.default_rng(seed + 977 * (env_idx + 1))
    for episode in range(episodes):
        env_idx = episode % env.num_envs
        dm_env_instance = env._environments[env_idx]
        task = env._tasks[env_idx]
        timestep = dm_env_instance.reset()
        obs = task.get_observation(dm_env_instance.physics)
        # Pin the FIFO latency exactly (starter's zero-prefix queue).
        task.fifo.clear()
        task.fifo.extend([(0.0, 0.0)] * latency)
        task._queue_latency = latency
        # Pin angular bias / slip on the task (used in after_step/observe).
        task._pinned_bias = bias
        task._pinned_slip = slip
        task._pinned_dropout = dropout
        task._obs_initialized = False
        task._last_obs = np.zeros_like(obs)
        episode_reward = 0.0
        steps = 0
        final_distance = None
        collided = False
        success = False
        control_hz = float(task.pack.get("controlHz", 10))
        for _step in range(env.timeout_steps):
            action = policy_fn(obs.reshape(1, -1))[0]
            timestep = dm_env_instance.step(np.asarray(action, dtype=np.float32))
            episode_reward += float(timestep.reward or 0.0)
            rows.append({
                "t": round(steps * (1.0 / control_hz), 4),
                "episode": episode,
                "observation": [round(float(v), 6) for v in obs],
                "action": [round(float(v), 6) for v in action],
                "reward": round(float(timestep.reward or 0.0), 6),
                "fall": bool(task._hit_obstacle(dm_env_instance.physics)),
            })
            fresh = task.get_observation(dm_env_instance.physics)
            # Frame dropout: with pinned probability the whole observation
            # repeats the previous frame (last good frame — board semantics).
            if task._obs_initialized and task.rng.random() < dropout:
                fresh = task._last_obs
            else:
                task._obs_initialized = True
            task._last_obs = fresh
            obs = fresh
            steps += 1
            if timestep.step_type == StepType.LAST:
                physics = dm_env_instance.physics
                x = float(physics.data.qpos[0])
                y = float(physics.data.qpos[1])
                final_distance = math.hypot(task.goal[0] - x, task.goal[1] - y)
                collided = bool(task._hit_obstacle(physics))
                success = bool(task._success)
                break
        if final_distance is None:
            physics = dm_env_instance.physics
            final_distance = math.hypot(task.goal[0] - physics.data.qpos[0],
                                        task.goal[1] - physics.data.qpos[1])
            collided = bool(task._hit_obstacle(physics))
            success = bool(task._success)
        outcomes.append({
            "success": success, "collision": collided,
            "steps": steps, "finalDistance": final_distance,
            "episodeReward": episode_reward,
        })
    return outcomes, rows


def evaluate_goal_navigation(env, policy_fn, envelopes, seed,
                             episodes_per_envelope=50, confidence=0.95):
    """Pinned-envelope evaluation with Wilson CIs (mjx report shape)."""
    report = {"envelopes": {}, "jsonl": {}, "meanReward": 0.0,
              "episodesPerEnvelope": episodes_per_envelope, "confidenceLevel": confidence}
    rewards_all = []
    for name, envelope in (envelopes or {}).items():
        outcomes, rows = run_episodes(env, policy_fn, envelope, seed, episodes_per_envelope)
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


def main():
    request_path = os.environ.get("RDK_SIM2REAL_REQUEST_FILE", "").strip()
    result_path = os.environ.get("RDK_SIM2REAL_RESULT_FILE", "").strip()
    if not request_path or not result_path:
        print("RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required", file=sys.stderr)
        sys.exit(2)

    if not HAVE_JAX or not HAVE_MUJOCO or not HAVE_DM_CONTROL:
        print(
            "[dm-control-adapter] REFUSED — dm_control, mujoco or jax is not "
            "installed. This adapter never fabricates a completed training run.",
            file=sys.stderr,
        )
        sys.exit(3)

    import dm_env  # noqa: F401, PLC0415 - main-guarded: protocol already verified

    with open(request_path) as handle:
        request = json.load(handle)
    contract = request.get("contract") or {}
    model = request.get("model") or {}
    training = request.get("training") or {}
    pack = request.get("task") or {}
    observation_size = int(contract.get("observationSize", 0))
    action_size = int(contract.get("actionSize", 0))
    if observation_size != _OBS_SIZE or action_size != _ACTION_SIZE:
        raise ValueError(
            "dm-control-ppo contract is {}x{} (8D board observation, 2D diff-drive "
            "command); got {}x{}".format(_OBS_SIZE, _ACTION_SIZE, observation_size, action_size)
        )
    control_hz = int(contract.get("controlHz", 10))
    physics_dt = min(float(contract.get("physicsTimestepSeconds", 0.01)), 0.01)
    profile = str(training.get("profile", "smoke"))
    budget = PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])
    num_envs = env_int("RDK_DMC_ENGINE_ENVS", 0) or clamp_int(
        training.get("numEnvs"), 1, budget["envs"], budget["envs"]
    )
    iterations = env_int("RDK_DMC_ENGINE_ITERATIONS", 0) or clamp_int(
        training.get("maxIterations"), 1, budget["iterations"], min(budget["iterations"], 40)
    )
    rollout_steps = env_int("RDK_DMC_ENGINE_STEPS", budget["steps"])
    seed = int(pack.get("seed", 7))

    stdout("engine=dm-control-ppo physics={} task={} profile={} iters={} envs={} steps={} "
           "obs={} act={} control={}Hz".format(
               PHYSICS_BACKEND, pack.get("id"), profile, iterations, num_envs, rollout_steps,
               observation_size, action_size, control_hz,
           ))

    env = DmControlVecEnvs(pack, num_envs, seed, physics_dt)
    try:
        params = train_ppo(env, iterations, rollout_steps, seed)
    finally:
        env.close()

    # ---- evaluation under pinned envelopes ----------------------------------
    envelopes = (pack.get("domainRandomization") or {}).get("evalEnvelopes") or {}
    eval_cfg = pack.get("evaluationConfig") or {}
    episodes_per_envelope = clamp_int(eval_cfg.get("episodesPerEnvelope"), 1, 200, 50)
    confidence = float(eval_cfg.get("confidenceLevel", 0.95))
    eval_seed = seed + 1000

    def policy_fn(obs_np):
        return np.asarray(act_deterministic(params, jnp.asarray(obs_np, dtype=jnp.float32)))

    eval_env = DmControlVecEnvs(pack, min(num_envs, 8), eval_seed, physics_dt)
    try:
        trained_report = evaluate_goal_navigation(
            eval_env, policy_fn, envelopes, eval_seed,
            episodes_per_envelope=episodes_per_envelope, confidence=confidence,
        )
        baseline_params = init_params(jax.random.PRNGKey(seed + 4242), _OBS_SIZE, _ACTION_SIZE)

        def baseline_fn(obs_np):
            return np.asarray(act_deterministic(baseline_params, jnp.asarray(obs_np, dtype=jnp.float32)))

        baseline_report = evaluate_goal_navigation(
            eval_env, baseline_fn, envelopes, eval_seed,
            episodes_per_envelope=episodes_per_envelope, confidence=confidence,
        )
        gate = evaluate_quality_gate(trained_report, pack.get("qualityGate") or {}, baseline_report)
    finally:
        eval_env.close()

    latency = measure_control_latency_ms(params, _OBS_SIZE)
    onnx_bytes = 0
    try:
        onnx_bytes = export_actor_onnx(params, _OBS_SIZE, _ACTION_SIZE, "policy.onnx")
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
                "physicsBackend": PHYSICS_BACKEND,
                "task": pack.get("id"),
                "taskKind": "goal-navigation",
                "profile": profile,
                "iterations": iterations,
                "numEnvs": num_envs,
                "rolloutSteps": rollout_steps,
                "seed": seed,
                "jaxVersion": jax.__version__,
                "mujocoVersion": getattr(mujoco, "__version__", None),
                "dmControlVersion": dependency_versions().get("dm-control"),
                "hyperparams": PPO_HYPERPARAMS,
                "device": "cpu",
                "controlHz": control_hz,
                "physicsTimestepSeconds": physics_dt,
                "eval": {k: v for k, v in trained_report.items() if k != "jsonl"},
                "baseline": {k: v for k, v in baseline_report.items() if k != "jsonl"},
                "controlLatencyMs": latency,
                "measurementStage": "host-jax",
                "sourceCommit": source_commit_short(),
                "onnxExported": bool(onnx_bytes),
            },
            handle, indent=2,
        )

    nominal = trained_report["envelopes"].get("nominal") or {}
    baseline_nominal = baseline_report["envelopes"].get("nominal") or {}
    stdout(
        "eval nominal: successRate={:.2f} collisionRate={:.2f} (baseline {:.2f}/{:.2f}) gate={} physics={}".format(
            nominal.get("successRate", 0.0), nominal.get("collisionRate", 0.0),
            baseline_nominal.get("successRate", 0.0), baseline_nominal.get("collisionRate", 0.0),
            "PASS" if gate["passed"] else "FAIL", PHYSICS_BACKEND,
        )
    )

    slug_model = safe_slug(model.get("modelId", "dm-control-policy"), ADAPTER_ID)
    slug_version = safe_slug(model.get("version", "0.1.0"), "0-1-0")
    result = {
        "checkpoint": {
            "checkpointId": "dm-control-{}".format(slug_version),
            "artifactRef": "artifact://dm-control-ppo/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": iterations,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://dm-control-ppo/{}/{}/policy.onnx".format(slug_model, slug_version),
            "kind": "source",
            **({"format": "onnx", "runtime": "cpu-onnx", "workload": "goal-navigation",
                "observationKind": "board-8d-imu-odom",
                "threads": 1, "sizeBytes": onnx_bytes} if onnx_bytes else {"format": "unknown"}),
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": ADAPTER_ID,
            "physicsBackend": PHYSICS_BACKEND,
            "taskId": pack.get("id"),
            "taskKind": "goal-navigation",
            "observationSize": _OBS_SIZE,
            "actionSize": _ACTION_SIZE,
            "iterations": iterations,
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
            "taskId": pack.get("id"),
            "adapterId": (pack.get("adapter") or {}).get("id"),
            "observationAdapterId": ((pack.get("adapter") or {}).get("policy") or {}).get(
                "observationAdapterId"
            ),
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
        "cuda": False,
        "physicsBackend": PHYSICS_BACKEND,
    }
    write_artifact_manifest(os.path.dirname(os.path.abspath(result_path)))
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    stdout("wrote result (physicsBackend={})".format(PHYSICS_BACKEND))


if __name__ == "__main__":
    main()
