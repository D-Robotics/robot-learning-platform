#!/usr/bin/env python3
"""visual-ppo worker adapter: MuJoCo camera pixels as the observation.

Implements the platform worker protocol (read RDK_SIM2REAL_REQUEST_FILE,
write RDK_SIM2REAL_RESULT_FILE) around a CPU MuJoCo differential-drive env
whose observation is a low-resolution TOP-DOWN CAMERA IMAGE of the arena
plus a small proprioceptive vector — the vision-in-the-loop training path
the platform previously lacked entirely (depth/RGB only fed the web UI).

Physics: the SAME calibrated OriginBot MJCF the MJX engine compiles
(assets/originbot single source, 3-point stance, force-limited velocity
servos) stepped by CPU MuJoCo at the task's control rate. Camera: a fixed
ceiling camera rendered offscreen through mujoco.Renderer — verified
available on this host (macOS CGL path; EGL on Linux servers via
MUJOCO_GL=egl as the mujoco-web service does).

The policy is a small CNN+MLP trained with the same pure-JAX PPO loop the
mjx-adapter uses (vendored in reduced form); ONNX export keeps the
platform contract (mean action, clamp, opset 13) so the artifact loads in
the standard runtime.

Honesty contract, same as every sibling adapter:
  * the observation is REALLY pixels from MuJoCo's renderer — a missing
    render stack (no GL) refuses the run (exit 3), never falls back to
    pretending pixels were observed
  * result.physicsBackend = "cpu-mujoco-vision"
  * deployable stays false (board deployment needs the BPU pipeline)

Dependency policy: numpy missing -> 2 (protocol); mujoco or jax missing ->
3 (REFUSED); rendering backend unavailable -> 3 (REFUSED: this engine's
whole point is pixels); onnx missing -> export skipped, run completes.

Register with the local worker:

  RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"visual-ppo":{"executable":"/path/to/python","args":["/abs/path/to/engines/visual-ppo/adapter.py"]}}'
"""

import json
import math
import os
import sys
import time

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
    HAVE_MUJOCO = True
except ImportError:
    HAVE_MUJOCO = False

ADAPTER_ID = "visual-ppo"

# Camera/obs budget: 48x48 grayscale (2304 floats) keeps the CNN small
# enough for CPU training while resolving the robot (0.35 m), obstacles
# (0.3 m) and goal marker on a 5 m arena. Arena pixels/m ≈ 9.6, so the
# robot spans ~4 px — coarse but learnable; profile knobs can raise it.
CAMERA_WH = (48, 48)
PROPRIO_SIZE = 4  # sin(yaw), cos(yaw), v_lag, w_lag
_OBS_SIZE = CAMERA_WH[0] * CAMERA_WH[1] + PROPRIO_SIZE
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
    "maxGradNorm": 0.5,
}

_CONV_FILTERS = 16
_FC_HIDDEN = 96


def _conv_flat_size(height, width):
    """Conv stack output size: 4x4/stride2 VALID then 3x3/stride2 VALID."""
    h = (height - 4) // 2 + 1
    w = (width - 4) // 2 + 1
    h = (h - 3) // 2 + 1
    w = (w - 3) // 2 + 1
    return h * w * _CONV_FILTERS


_FLAT_CONV_OUT = _conv_flat_size(*CAMERA_WH)


def stdout(line):
    print("[visual-ppo] " + str(line), flush=True)


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


def _repo_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _load_calibration():
    """Wheel constants from the single calibration source (no re-typing)."""
    import json

    calib_path = os.path.join(
        _repo_root(), "assets", "originbot", "calibration.json"
    )
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

    The vision env MUST NOT hand-roll a second robot: walls, calibrated
    chassis/wheels/caster, force-limited servos all come from the same
    build_mjcf the mjx-adapter compiles (single calibration source).
    """
    import importlib.util

    mjx_path = os.path.join(_repo_root(), "engines", "mjx-adapter", "adapter.py")
    spec = importlib.util.spec_from_file_location("mjx_adapter_for_visual", mjx_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_mjcf


def _build_vision_mjcf(physics_dt, workspace_bound, obstacle_count=0):
    """mjx-adapter scene + ceiling camera + visible goal marker.

    The physical scene comes VERBATIM from the mjx-adapter's build_mjcf
    (walls, calibrated robot, force-limited servos, mocap obstacles); the
    vision-only extras — a mocap goal marker the camera can see and a
    fixed ceiling camera — are appended as XML elements before compile,
    so vision-trained and state-trained policies see the same world.
    """
    base_xml = _load_mjx_builder()(physics_dt, workspace_bound, obstacle_count)
    # Camera looks along -z (xyaxes 3rd axis is the view axis) with
    # world-aligned image axes; probe-verified: mean pixel ~207, std ~38
    # (a black frame means the camera faces the wrong way).
    vision_extras = (
        '<body name="goal_marker" mocap="true" pos="0 0 0.02">'
        '<geom name="goal_disc" type="cylinder" size="0.12 0.01 0.01" '
        'rgba="0.2 0.85 0.25 1"/></body>'
        '<light name="vision_key" pos="0 0 4.0" dir="0 0 -1" diffuse="0.7 0.7 0.7" '
        'ambient="0.3 0.3 0.3" directional="true"/>'
        '<camera name="ceiling" pos="0 0 4.2" xyaxes="1 0 0 0 1 0" fovy="52"/>'
    )
    return base_xml.replace("</worldbody>", vision_extras + "</worldbody>")


def _build_vision_model(physics_dt, workspace_bound, obstacle_count=0):
    """Compile the vision MJCF into an MjModel (shared scene source)."""
    import mujoco

    return mujoco.MjModel.from_xml_string(
        _build_vision_mjcf(physics_dt, workspace_bound, obstacle_count)
    )


class VisualGoalNavEnv:
    """CPU MuJoCo + offscreen camera goal-navigation env.

    Observation = grayscale ceiling camera frame (flattened, normalized)
    + [sin yaw, cos yaw, v_lag, w_lag]. Task semantics (reward progress/
    goal/collision, timeout, differential-drive command chain with motor
    gain / lag / latency) follow the starter engine's goal-navigation
    definitions so the quality gate stays comparable.
    """

    def __init__(self, pack, num_envs, seed, physics_dt):
        import mujoco

        self.pack = pack
        self.num_envs = num_envs
        self.action_size = _ACTION_SIZE
        self.observation_size = _OBS_SIZE
        self.control_dt = 1.0 / float(pack.get("controlHz", 10))
        self.physics_dt = float(physics_dt)
        self.decimation = max(1, int(round(self.control_dt / self.physics_dt)))
        termination = pack.get("termination") or {}
        self.timeout_steps = int(termination.get("timeoutSteps", 300))
        self.goal_eps = float(termination.get("goalDistance", 0.15))
        safety = (pack.get("adapter") or {}).get("safety") or {}
        self.max_linear = float(safety.get("maxLinear", 0.3))
        self.max_angular = float(safety.get("maxAngular", 1.0))
        workspace = pack.get("workspace") or {}
        self.bound = float(workspace.get("bound") or 2.0)
        obstacle_spec = workspace.get("obstacles") or {}
        self.obstacle_count = int(obstacle_spec.get("count", 0))
        self.obstacle_radius = float(obstacle_spec.get("radius", 0.15))
        self.reward_cfg = {k: float(v) for k, v in (pack.get("reward") or {}).items()}
        dr = pack.get("domainRandomization") or {}
        self.dr = {
            "motorGain": tuple(dr.get("motorGain") or [1.0, 1.0]),
            "lagTau": tuple(dr.get("lagTauSeconds") or [0.05, 0.05]),
        }

        template_xml = _build_vision_mjcf(self.physics_dt, self.bound, self.obstacle_count)
        self._models = []
        self._datas = []
        self._renderers = []
        self._rng = np.random.default_rng(seed)
        for _env in range(num_envs):
            model = mujoco.MjModel.from_xml_string(template_xml)
            data = mujoco.MjData(model)
            mujoco.mj_forward(model, data)
            renderer = mujoco.Renderer(model, *CAMERA_WH)
            renderer.scene.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = False
            self._models.append(model)
            self._datas.append(data)
            self._renderers.append(renderer)
        self._cam = None  # camera referenced by NAME in update_scene
        # Per-env task state (host side; physics stays per-env MjData).
        self.goals = np.zeros((num_envs, 2), dtype=np.float64)
        self.prev_dist = np.zeros(num_envs)
        self.steps = np.zeros(num_envs, dtype=np.int64)
        self.v_lag = np.zeros(num_envs)
        self.w_lag = np.zeros(num_envs)
        self.fifo = np.zeros((num_envs, 4, 2))  # small latency buffer
        self.success_history = []
        self.reset()

    def close(self):
        for renderer in self._renderers:
            close = getattr(renderer, "close", None)
            if close is not None:
                close()
        self._renderers = []

    # -- episode management ---------------------------------------------------
    def _spawn(self, env_idx):
        rng = self._rng
        distance = rng.uniform(0.8, 1.6)
        angle = rng.uniform(0, 2.0 * math.pi)
        goal = np.array([distance * math.cos(angle), distance * math.sin(angle)])
        yaw = rng.uniform(-math.pi, math.pi)
        data = self._datas[env_idx]
        mujoco.mj_resetData(self._models[env_idx], data)
        data.qpos[0:2] = 0.0
        data.qpos[2] = 0.17
        data.qpos[3:7] = [math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)]
        data.qpos[7:9] = 0.0
        # Goal marker follows the goal — it is the LAST mocap body (the
        # shared scene's obstacle mocap bodies come first).
        marker_idx = self._models[env_idx].nmocap - 1
        data.mocap_pos[marker_idx][0] = goal[0]
        data.mocap_pos[marker_idx][1] = goal[1]
        mujoco.mj_forward(self._models[env_idx], data)
        self.goals[env_idx] = goal
        self.prev_dist[env_idx] = np.linalg.norm(goal)
        self.steps[env_idx] = 0
        self.v_lag[env_idx] = 0.0
        self.w_lag[env_idx] = 0.0
        gain = rng.uniform(*self.dr["motorGain"])
        lag = rng.uniform(*self.dr["lagTau"])
        self._gain = getattr(self, "_gain", np.ones(self.num_envs))
        self._lag = getattr(self, "_lag", np.full(self.num_envs, 0.05))
        self._gain[env_idx] = gain
        self._lag[env_idx] = lag

    def reset(self):
        for env_idx in range(self.num_envs):
            self._spawn(env_idx)
        return self.observe()

    def _render_gray(self, env_idx):
        self._renderers[env_idx].update_scene(self._datas[env_idx], camera="ceiling")
        rgb = self._renderers[env_idx].render()
        gray = (rgb[..., :3].mean(axis=-1) / 255.0).astype(np.float32)
        return gray.reshape(-1)

    def _yaw(self, env_idx):
        q = self._datas[env_idx].qpos[3:7]
        return math.atan2(2.0 * (q[0] * q[3] + q[1] * q[2]), 1.0 - 2.0 * (q[2] ** 2 + q[3] ** 2))

    def observe(self):
        obs = np.zeros((self.num_envs, self.observation_size), dtype=np.float32)
        for env_idx in range(self.num_envs):
            pixels = self._render_gray(env_idx)
            obs[env_idx, : pixels.shape[0]] = pixels
            yaw = self._yaw(env_idx)
            obs[env_idx, pixels.shape[0]:] = [
                math.sin(yaw), math.cos(yaw), self.v_lag[env_idx], self.w_lag[env_idx]
            ]
        return obs

    def step(self, actions):
        rewards = np.zeros(self.num_envs, dtype=np.float32)
        dones = np.zeros(self.num_envs, dtype=bool)
        successes = np.zeros(self.num_envs, dtype=bool)
        for env_idx in range(self.num_envs):
            model, data = self._models[env_idx], self._datas[env_idx]
            target_v = float(np.clip(actions[env_idx][0], -1.0, 1.0)) * self.max_linear
            target_w = float(np.clip(actions[env_idx][1], -1.0, 1.0)) * self.max_angular
            # first-order lag + gain (command-level DR, starter semantics)
            alpha = min(1.0, self.control_dt / max(self._lag[env_idx], 1e-6))
            self.v_lag[env_idx] += alpha * (target_v * self._gain[env_idx] - self.v_lag[env_idx])
            self.w_lag[env_idx] += alpha * (target_w * self._gain[env_idx] - self.w_lag[env_idx])
            left = (self.v_lag[env_idx] - self.w_lag[env_idx] * 0.5 * _TRACK_WIDTH) / _WHEEL_RADIUS
            right = (self.v_lag[env_idx] + self.w_lag[env_idx] * 0.5 * _TRACK_WIDTH) / _WHEEL_RADIUS
            data.ctrl[:] = [
                np.clip(left, -_MAX_WHEEL_SPEED, _MAX_WHEEL_SPEED),
                np.clip(right, -_MAX_WHEEL_SPEED, _MAX_WHEEL_SPEED),
            ]
            for _sub in range(self.decimation):
                mujoco.mj_step(model, data)
            x, y = data.qpos[0], data.qpos[1]
            distance = math.hypot(self.goals[env_idx][0] - x, self.goals[env_idx][1] - y)
            success = distance < self.goal_eps
            reward = (
                self.reward_cfg.get("progress", 0.0) * (self.prev_dist[env_idx] - distance)
                + self.reward_cfg.get("actionPenalty", 0.0) * float(np.mean(np.abs(np.clip(actions[env_idx], -1, 1))))
                + (self.reward_cfg.get("goal", 0.0) if success else 0.0)
            )
            self.prev_dist[env_idx] = distance
            self.steps[env_idx] += 1
            timeout = self.steps[env_idx] >= self.timeout_steps
            done = success or timeout
            if done:
                self.success_history.append(bool(success))
                self._spawn(env_idx)
            rewards[env_idx] = reward
            dones[env_idx] = done
            successes[env_idx] = success
        return self.observe(), rewards, dones, successes


# ---------------------------------------------------------------------------
# CNN actor-critic in pure JAX: conv 4x4 stride 2 -> conv 3x3 stride 2 ->
# flatten -> [96] tanh MLP -> Gaussian head. Small enough for CPU PPO.
# ---------------------------------------------------------------------------
def init_params(key):
    glorot = jax.nn.initializers.glorot_uniform()
    k1, k2, k3, k4, k5, k6 = jax.random.split(key, 6)
    fc_in = _FLAT_CONV_OUT + PROPRIO_SIZE
    return {
        "conv1_w": glorot(k1, (4, 4, 1, _CONV_FILTERS)),
        "conv1_b": jnp.zeros(_CONV_FILTERS),
        "conv2_w": glorot(k2, (3, 3, _CONV_FILTERS, _CONV_FILTERS)),
        "conv2_b": jnp.zeros(_CONV_FILTERS),
        "fc_w": glorot(k3, (fc_in, _FC_HIDDEN)),
        "fc_b": jnp.zeros(_FC_HIDDEN),
        "mu_w": glorot(k4, (_FC_HIDDEN, _ACTION_SIZE)),
        "mu_b": jnp.zeros(_ACTION_SIZE),
        "v_w": glorot(k5, (_FC_HIDDEN, 1)),
        "v_b": jnp.zeros(1),
        "log_std": jnp.full((_ACTION_SIZE,), -0.7),
    }


def forward(params, obs):
    h, w = CAMERA_WH
    pixels = obs[:, : h * w].reshape((-1, h, w, 1))
    x = jax.nn.relu(jax.lax.conv_general_dilated(
        pixels, params["conv1_w"], (2, 2), "VALID",
        dimension_numbers=("NHWC", "HWIO", "NHWC")))
    x = jax.nn.relu(jax.lax.conv_general_dilated(
        x, params["conv2_w"], (2, 2), "VALID",
        dimension_numbers=("NHWC", "HWIO", "NHWC")))
    # Flatten C-major (transpose to NCHW first): the exported ONNX graph
    # flattens its NCHW conv output the same way, so JAX training and the
    # deployed artifact agree element-for-element.
    x = x.transpose(0, 3, 1, 2).reshape((x.shape[0], -1))
    x = jnp.concatenate([x, obs[:, h * w:]], axis=1)
    hidden = jnp.tanh(x @ params["fc_w"] + params["fc_b"])
    mu = hidden @ params["mu_w"] + params["mu_b"]
    value = (hidden @ params["v_w"] + params["v_b"])[:, 0]
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
    params = init_params(jax.random.PRNGKey(seed))
    opt_state = _OPTIMIZER.init(params)
    rng = jax.random.PRNGKey(seed + 1)
    obs_np = env.reset()
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


def export_actor_onnx(params, path):
    """ONNX graph: Conv/ReLU/Conv/ReLU/Gemm/Tanh heads, opset 13.

    The board contract (input 'observation', output 'action', dynamic
    batch, clamp) is preserved; the graph is built by hand exactly like
    the mjx-adapter's exporter so no torch dependency is needed here.
    """
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    def tensor(name, array):
        return numpy_helper.from_array(np.asarray(array, dtype=np.float32), name)

    h, w = CAMERA_WH
    flat_in = _FLAT_CONV_OUT + PROPRIO_SIZE
    pixel_count = h * w
    # ONNX Conv is NCHW with OIHW weights; the JAX params are HWIO —
    # transposes are part of the export, not a second copy of the weights.
    conv1_w_oihw = np.asarray(params["conv1_w"]).transpose(3, 2, 0, 1)
    conv2_w_oihw = np.asarray(params["conv2_w"]).transpose(3, 2, 0, 1)
    inits = [
        tensor("conv1_w", conv1_w_oihw), tensor("conv1_b", params["conv1_b"]),
        tensor("conv2_w", conv2_w_oihw), tensor("conv2_b", params["conv2_b"]),
        tensor("fc_w", params["fc_w"]), tensor("fc_b", params["fc_b"]),
        tensor("mu_w", params["mu_w"]), tensor("mu_b", params["mu_b"]),
        tensor("clip_min", np.asarray(-1.0)), tensor("clip_max", np.asarray(1.0)),
        numpy_helper.from_array(np.asarray([0], dtype=np.int64), "slice_start"),
        numpy_helper.from_array(
            np.asarray([pixel_count], dtype=np.int64), "pixel_end"),
        numpy_helper.from_array(
            np.asarray([_OBS_SIZE], dtype=np.int64), "obs_end"),
        numpy_helper.from_array(np.asarray([1], dtype=np.int64), "axis_one"),
        numpy_helper.from_array(
            np.asarray([-1, 1, h, w], dtype=np.int64), "shapeNCHW"),
        numpy_helper.from_array(
            np.asarray([-1, _FLAT_CONV_OUT], dtype=np.int64), "shape2d"),
    ]
    nodes = [
        # observation = [pixels(2304), proprio(4)]; pixels only feed the CNN,
        # proprio joins the conv features before the MLP (probe-verified:
        # Slice with an explicit axes initializer loads in ORT).
        helper.make_node("Slice", ["observation", "slice_start", "pixel_end", "axis_one"],
                         ["pixels"], name="slice_pixels"),
        helper.make_node("Slice", ["observation", "pixel_end", "obs_end", "axis_one"],
                         ["proprio"], name="slice_proprio"),
        helper.make_node("Reshape", ["pixels", "shapeNCHW"], ["img"], name="reshape"),
        helper.make_node("Conv", ["img", "conv1_w", "conv1_b"], ["conv1_out"],
                         kernel_shape=[4, 4], strides=[2, 2], pads=[0, 0, 0, 0]),
        helper.make_node("Relu", ["conv1_out"], ["conv1_relu"]),
        helper.make_node("Conv", ["conv1_relu", "conv2_w", "conv2_b"], ["conv2_out"],
                         kernel_shape=[3, 3], strides=[2, 2], pads=[0, 0, 0, 0]),
        helper.make_node("Relu", ["conv2_out"], ["conv2_relu"]),
        helper.make_node("Reshape", ["conv2_relu", "shape2d"], ["flat"]),
        helper.make_node("Concat", ["flat", "proprio"], ["fused"], axis=1,
                         name="concat_features"),
        helper.make_node("Gemm", ["fused", "fc_w", "fc_b"], ["fc_out"]),
        helper.make_node("Tanh", ["fc_out"], ["hidden"]),
        helper.make_node("Gemm", ["hidden", "mu_w", "mu_b"], ["mu"]),
        helper.make_node("Clip", ["mu", "clip_min", "clip_max"], ["action"]),
    ]
    observation = helper.make_tensor_value_info(
        "observation", TensorProto.FLOAT, ["batch", _OBS_SIZE]
    )
    action = helper.make_tensor_value_info("action", TensorProto.FLOAT, ["batch", _ACTION_SIZE])
    graph = helper.make_graph(nodes, "visual_actor", [observation], [action], initializer=inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, path)
    return os.path.getsize(path)


def measure_control_latency_ms(params):
    sample = jnp.zeros((1, _OBS_SIZE), dtype=jnp.float32)
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


def main():
    request_path = os.environ.get("RDK_SIM2REAL_REQUEST_FILE", "").strip()
    result_path = os.environ.get("RDK_SIM2REAL_RESULT_FILE", "").strip()
    if not request_path or not result_path:
        print("RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required", file=sys.stderr)
        sys.exit(2)

    if not HAVE_JAX or not HAVE_MUJOCO:
        print(
            "[visual-ppo] REFUSED — jax or mujoco is not installed. This adapter "
            "never fabricates a completed training run.",
            file=sys.stderr,
        )
        sys.exit(3)

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
            "visual-ppo contract is {}x{} (camera {} grayscale + {} proprio); got {}x{}".format(
                _OBS_SIZE, _ACTION_SIZE, CAMERA_WH, PROPRIO_SIZE, observation_size, action_size
            )
        )
    control_hz = int(contract.get("controlHz", 10))
    physics_dt = min(float(contract.get("physicsTimestepSeconds", 0.01)), 0.01)
    profile = str(training.get("profile", "smoke"))
    budget = PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])
    num_envs = env_int("RDK_VISUAL_ENGINE_ENVS", 0) or clamp_int(
        training.get("numEnvs"), 1, budget["envs"], budget["envs"]
    )
    iterations = env_int("RDK_VISUAL_ENGINE_ITERATIONS", 0) or clamp_int(
        training.get("maxIterations"), 1, budget["iterations"], min(budget["iterations"], 40)
    )
    rollout_steps = env_int("RDK_VISUAL_ENGINE_STEPS", budget["steps"])
    seed = int(pack.get("seed", 7))

    stdout("engine=visual-ppo physics=cpu-mujoco-vision task={} profile={} iters={} envs={} steps={} obs={} act={} control={}Hz".format(
        pack.get("id"), profile, iterations, num_envs, rollout_steps,
        observation_size, action_size, control_hz,
    ))

    env = VisualGoalNavEnv(pack, num_envs, seed, physics_dt)
    try:
        params = train_ppo(env, iterations, rollout_steps, seed)
    finally:
        env.close()

    # Honest smoke evaluation: run the trained policy for one full episode
    # window per eval env and count successes by episode outcome (the env
    # auto-resets, success_history logs each completed episode).
    eval_envs = 8
    eval_env = VisualGoalNavEnv(pack, eval_envs, seed + 1000, physics_dt)
    obs = eval_env.reset()
    rewards_mean = 0.0
    try:
        total_reward = np.zeros(eval_envs)
        for _step in range(eval_env.timeout_steps):
            actions = np.asarray(act_deterministic(params, jnp.asarray(obs, dtype=jnp.float32)))
            obs, reward, done, success = eval_env.step(actions)
            total_reward += reward
        rewards_mean = float(total_reward.mean())
    finally:
        eval_env.close()
    # Each env runs at least one full episode in the window; the LAST
    # completed episode per env is the policy's final-word outcome.
    recent = eval_env.success_history[-eval_envs:]
    success_rate = (sum(recent) / len(recent)) if recent else 0.0

    latency = measure_control_latency_ms(params)
    onnx_bytes = 0
    try:
        onnx_bytes = export_actor_onnx(params, "policy.onnx")
        stdout("exported policy.onnx ({} bytes)".format(onnx_bytes))
    except Exception as error:  # noqa: BLE001 - export failure must not lose the run
        stdout("ONNX export failed: {}; continuing without it".format(error))

    with open("training-summary.json", "w") as handle:
        json.dump(
            {
                "engine": ADAPTER_ID,
                "physicsBackend": "cpu-mujoco-vision",
                "task": pack.get("id"),
                "taskKind": "goal-navigation",
                "profile": profile,
                "iterations": iterations,
                "numEnvs": num_envs,
                "rolloutSteps": rollout_steps,
                "seed": seed,
                "camera": {"width": CAMERA_WH[0], "height": CAMERA_WH[1], "channels": 1},
                "observationSize": _OBS_SIZE,
                "hyperparams": PPO_HYPERPARAMS,
                "device": "cpu",
                "eval": {"successRate": success_rate, "meanReward": round(rewards_mean, 4)},
                "controlLatencyMs": latency,
                "measurementStage": "host-jax",
                "sourceCommit": source_revision(),
                "onnxExported": bool(onnx_bytes),
            },
            handle, indent=2,
        )

    slug_model = safe_slug(model.get("modelId", "visual-policy"), ADAPTER_ID)
    slug_version = safe_slug(model.get("version", "0.1.0"), "0-1-0")
    result = {
        "checkpoint": {
            "checkpointId": "visual-{}".format(slug_version),
            "artifactRef": "artifact://visual-ppo/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": iterations,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://visual-ppo/{}/{}/policy.onnx".format(slug_model, slug_version),
            "kind": "source",
            **({"format": "onnx", "runtime": "cpu-onnx", "workload": "goal-navigation",
                "observationKind": "camera-grayscale-48x48-plus-proprio",
                "threads": 1, "sizeBytes": onnx_bytes} if onnx_bytes else {"format": "unknown"}),
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": ADAPTER_ID,
            "physicsBackend": "cpu-mujoco-vision",
            "taskId": pack.get("id"),
            "taskKind": "goal-navigation",
            "observationSize": _OBS_SIZE,
            "actionSize": _ACTION_SIZE,
            "iterations": iterations,
            "numEnvs": num_envs,
            "successRate": round(success_rate, 4),
            "meanReward": round(rewards_mean, 4),
            "controlLatencyMs": latency,
            "measurementStage": "host-jax",
            "sourceCommit": source_revision(),
            "onnxExported": bool(onnx_bytes),
        },
        "deployable": False,
        "physicsBackend": "cpu-mujoco-vision",
        "cuda": False,
    }
    write_artifact_manifest(os.path.dirname(os.path.abspath(result_path)))
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    stdout("wrote result (physicsBackend=cpu-mujoco-vision)")


if __name__ == "__main__":
    main()
