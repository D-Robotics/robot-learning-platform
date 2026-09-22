"""Self-contained MicroDuck basketball-balance proxy for the recurrent trainer.

Like ``microduck-football``, this environment is deliberately self contained: a
procedural MuJoCo scene, no upstream checkout, runnable on a laptop CPU. A
duck-proxy body is articulated on top of a rolling basketball through a ball
joint, so tilting the duck makes the ball roll away — the classic
broom-on-a-ball instability. The policy sees no ball state: it must infer the
ball's motion from gyro/tilt *history*, which is why this task needs a
recurrent policy at all.

The observation/action interface matches the MicroDuck deployment contract
(61 observation slots at 50 Hz, 14 action slots) with the same slot layout as
``microduck_eval.sim.MicroDuckSim.observation``: gyro, projected gravity,
posture offsets, posture velocities, last action, command. The 14 posture
channels are real environment state (a low-pass filter over past actions) and
drive the tilt torque through a fixed random projection — a first-order stand
in for "14 servos shift the centre of mass". A later adapter can replace this
reduction with the real 14-servo MJCF actor (which needs the upstream
``microduck_rl`` checkout) without changing the observation/action contract.
"""

from __future__ import annotations

from dataclasses import dataclass

import mujoco
import numpy as np

OBSERVATION_SIZE = 61
ACTION_SIZE = 14
COMMAND_SIZE = 13
CONTROL_HZ = 50.0
PHYSICS_TIMESTEP = 0.004

BALL_RADIUS = 0.12
DUCK_MASS = 0.8
BALL_MASS = 0.55
#: |tilt| beyond this (radians, duck z-axis vs world z) is a fall.
TILT_FALL_RADIUS = 1.0
#: Ball centre drifting this far from the origin also ends the episode.
BALL_ROLLAWAY_RADIUS = 1.0
#: Posture low-pass factor: posture <- (1-A)*posture + A*action.
POSTURE_ALPHA = 0.35
#: N·m per unit of the normalised posture projection.
TORQUE_GAIN = 0.6
#: N·m per unit of the commanded lean.
LEAN_GAIN = 0.4

_SCENE_XML = f"""
<mujoco model="microduck-basketball-balance">
  <option timestep="{PHYSICS_TIMESTEP}" gravity="0 0 -9.81" integrator="implicitfast"/>
  <size njmax="500" nconmax="100"/>
  <default>
    <geom friction="1.0 0.005 0.0001" condim="3"/>
    <joint damping="0.01"/>
  </default>
  <worldbody>
    <light name="top" pos="0 -1 3" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="3 3 0.05"/>
    <body name="basketball" pos="0 0 {BALL_RADIUS}">
      <freejoint name="ball_free"/>
      <geom name="ball" type="sphere" size="{BALL_RADIUS}" mass="{BALL_MASS}" friction="0.9 0.02 0.001"/>
      <body name="duck" pos="0 0 {BALL_RADIUS}">
        <joint name="duck_tilt" type="ball" damping="0.05"/>
        <geom name="duck_body" type="sphere" size="0.10" mass="{DUCK_MASS}" pos="0 0 0.10"
              contype="0" conaffinity="0"/>
        <site name="duck_imu" pos="0 0 0.10" size="0.005"/>
      </body>
    </body>
  </worldbody>
  <sensor>
    <gyro name="imu_ang_vel" site="duck_imu"/>
    <framequat name="duck_quat" objtype="body" objname="duck"/>
  </sensor>
</mujoco>
"""


def _posture_projection(seed: int) -> np.ndarray:
    """Fixed (3, 14) posture->torque projection, rows L2-normalised.

    Part of the environment definition, not a learned weight: every posture
    channel reaches the physics through a deterministic, documented map, the
    same way a real posture change reaches the centre of mass.
    """
    rng = np.random.default_rng(seed)
    matrix = rng.uniform(-1.0, 1.0, (3, ACTION_SIZE))
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix.astype(np.float64)


def _quat_to_matrix(quat: np.ndarray) -> np.ndarray:
    matrix = np.zeros(9, dtype=np.float64)
    mujoco.mju_quat2Mat(matrix, np.asarray(quat, dtype=np.float64))
    return matrix.reshape(3, 3)


@dataclass(frozen=True)
class BalanceConfig:
    episode_seconds: float = 12.0
    seed: int = 20260922
    posture_projection_seed: int = 20260922
    #: False -> duck on a rolling basketball (drifting pivot, memory matters).
    #: True  -> duck on two rigid stilts (fixed pivot at the stilt height).
    stilts: bool = False
    #: Stilt height in cm; mass follows the upstream-style formula
    #: (0.012 + 0.001 * h_cm) kg per stilt, so geometry and mass move together.
    stilts_height_cm: float = 25.0


def _stilt_mass_per_rod(height_cm: float) -> float:
    return 0.012 + 0.001 * height_cm


_STILT_SCENE_XML_TEMPLATE = """
<mujoco model="microduck-stilt-balance">
  <option timestep="{timestep}" gravity="0 0 -9.81" integrator="implicitfast"/>
  <size njmax="500" nconmax="100"/>
  <default>
    <geom friction="1.0 0.005 0.0001" condim="3"/>
    <joint damping="0.01"/>
  </default>
  <worldbody>
    <light name="top" pos="0 -1 3" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="3 3 0.05"/>
    <body name="duck" pos="0 0 {pivot_z}">
      <joint name="duck_tilt" type="ball" damping="0.05"/>
      <geom name="stilt_left" type="capsule" fromto="-0.04 0 -{pivot_z} -0.04 0 -0.02" size="0.012"
            mass="{rod_mass}" contype="0" conaffinity="0"/>
      <geom name="stilt_right" type="capsule" fromto="0.04 0 -{pivot_z} 0.04 0 -0.02" size="0.012"
            mass="{rod_mass}" contype="0" conaffinity="0"/>
      <geom name="duck_body" type="sphere" size="0.10" mass="{duck_mass}" pos="0 0 0.10"
            contype="0" conaffinity="0"/>
      <site name="duck_imu" pos="0 0 0.10" size="0.005"/>
    </body>
  </worldbody>
  <sensor>
    <gyro name="imu_ang_vel" site="duck_imu"/>
    <framequat name="duck_quat" objtype="body" objname="duck"/>
  </sensor>
</mujoco>
"""


def _scene_for(config: BalanceConfig) -> str:
    if not config.stilts:
        return _SCENE_XML
    return _STILT_SCENE_XML_TEMPLATE.format(
        timestep=PHYSICS_TIMESTEP,
        pivot_z=round(config.stilts_height_cm / 100.0, 4),
        rod_mass=round(_stilt_mass_per_rod(config.stilts_height_cm), 5),
        duck_mass=DUCK_MASS,
    )


class BasketballBalanceEnv:
    """One duck on one basketball. Obs (61,), action (14,), 50 Hz."""

    def __init__(self, config: BalanceConfig | None = None):
        self.config = config or BalanceConfig()
        self.model = mujoco.MjModel.from_xml_string(_scene_for(self.config))
        self.data = mujoco.MjData(self.model)
        self.projection = _posture_projection(self.config.posture_projection_seed)
        self.ball_joint = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, "ball_free")
        self.tilt_joint = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, "duck_tilt")
        self.ball_qpos = int(self.model.jnt_qposadr[self.ball_joint]) if self.ball_joint >= 0 else None
        self.ball_dof = int(self.model.jnt_dofadr[self.ball_joint]) if self.ball_joint >= 0 else None
        self.tilt_qpos = int(self.model.jnt_qposadr[self.tilt_joint])
        self.tilt_dof = int(self.model.jnt_dofadr[self.tilt_joint])
        self.gyro_adr = int(self.model.sensor_adr[
            mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SENSOR, "imu_ang_vel")])
        self.quat_adr = int(self.model.sensor_adr[
            mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SENSOR, "duck_quat")])
        # Tilt torque is applied as a generalized force on the ball joint's
        # three dofs (a motor actuator on a ball joint is scalar in this MuJoCo
        # version, which is not what the task needs).
        if self.model.jnt_type[self.tilt_joint] != mujoco.mjtJoint.mjJNT_BALL:
            raise RuntimeError("duck_tilt must be a ball joint")
        self.tilt_tau_dofs = slice(self.tilt_dof, self.tilt_dof + 3)
        self.substeps = max(1, int(round((1.0 / CONTROL_HZ) / PHYSICS_TIMESTEP)))
        self.rng = np.random.default_rng(self.config.seed)
        self.episode_steps = int(round(self.config.episode_seconds * CONTROL_HZ))
        self.step_count = 0
        self.posture = np.zeros(ACTION_SIZE, dtype=np.float64)
        self.prev_posture = np.zeros(ACTION_SIZE, dtype=np.float64)
        self.last_action = np.zeros(ACTION_SIZE, dtype=np.float64)
        self.command = np.zeros(COMMAND_SIZE, dtype=np.float64)

    @property
    def observation_dim(self) -> int:
        return OBSERVATION_SIZE

    @property
    def action_dim(self) -> int:
        return ACTION_SIZE

    def reset(self, seed: int | None = None) -> np.ndarray:
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        mujoco.mj_resetData(self.model, self.data)
        self.step_count = 0
        self.posture = np.zeros(ACTION_SIZE, dtype=np.float64)
        self.prev_posture = np.zeros(ACTION_SIZE, dtype=np.float64)
        self.last_action = np.zeros(ACTION_SIZE, dtype=np.float64)
        # Domain randomisation: a small initial tilt — and, on the basketball,
        # a shove on the ball — so every episode starts away from the
        # (unstable) equilibrium and the policy must react to pivot motion it
        # cannot observe directly.
        axis = self.rng.normal(size=3)
        axis /= np.linalg.norm(axis) + 1e-9
        angle = self.rng.uniform(0.0, 0.15)
        half = angle / 2.0
        self.data.qpos[self.tilt_qpos : self.tilt_qpos + 4] = (
            np.cos(half), axis[0] * np.sin(half), axis[1] * np.sin(half), axis[2] * np.sin(half),
        )
        if self.ball_qpos is not None:
            self.data.qvel[self.ball_dof + 0] = self.rng.uniform(-0.2, 0.2)
            self.data.qvel[self.ball_dof + 1] = self.rng.uniform(-0.2, 0.2)
        self.command = np.zeros(COMMAND_SIZE, dtype=np.float64)
        self.command[0] = self.rng.uniform(-0.3, 0.3)
        self.command[1] = self.rng.uniform(-0.3, 0.3)
        self.command[2] = self.rng.uniform(0.0, 0.4)
        self.command[3] = self.rng.uniform(0.8, 1.2)
        mujoco.mj_forward(self.model, self.data)
        return self.observation()

    def _tilt(self) -> float:
        matrix = _quat_to_matrix(self.data.sensordata[self.quat_adr : self.quat_adr + 4])
        return float(np.arccos(np.clip(matrix[2, 2], -1.0, 1.0)))

    def _torque(self) -> np.ndarray:
        torque = self.projection @ self.posture * TORQUE_GAIN * self.command[3]
        torque[0] += LEAN_GAIN * self.command[0]
        torque[1] += LEAN_GAIN * self.command[1]
        return np.clip(torque, -0.96, 0.96)

    def observation(self) -> np.ndarray:
        gyro = self.data.sensordata[self.gyro_adr : self.gyro_adr + 3]
        matrix = _quat_to_matrix(self.data.sensordata[self.quat_adr : self.quat_adr + 4])
        projected_gravity = matrix.T @ np.array([0.0, 0.0, -1.0])
        posture_offset = self.posture
        posture_vel = (self.posture - self.prev_posture) * CONTROL_HZ
        observation = np.concatenate([
            gyro, projected_gravity, posture_offset, posture_vel,
            self.last_action, self.command,
        ]).astype(np.float32)
        if observation.shape != (OBSERVATION_SIZE,):
            raise RuntimeError(f"observation assembled as {observation.shape}, expected (61,)")
        return observation

    def step(self, action: np.ndarray):
        action = np.clip(np.asarray(action, dtype=np.float64).reshape(ACTION_SIZE), -1.0, 1.0)
        self.prev_posture = self.posture
        self.posture = (1.0 - POSTURE_ALPHA) * self.posture + POSTURE_ALPHA * action
        self.data.qfrc_applied[self.tilt_tau_dofs] = self._torque()
        for _ in range(self.substeps):
            mujoco.mj_step(self.model, self.data)
        self.last_action = action
        self.step_count += 1
        tilt = self._tilt()
        if self.ball_qpos is not None:
            ball_xy = self.data.qpos[self.ball_qpos : self.ball_qpos + 2]
            rolled_away = float(np.linalg.norm(ball_xy)) > BALL_ROLLAWAY_RADIUS
        else:
            rolled_away = False
        fallen = tilt > TILT_FALL_RADIUS
        reward = 0.5 + 0.5 * float(np.cos(tilt)) - 0.001 * float(np.sum(self._torque() ** 2))
        terminated = bool(fallen or rolled_away)
        truncated = self.step_count >= self.episode_steps
        info = {"tilt": tilt, "fallen": fallen, "rolledAway": rolled_away}
        return self.observation(), np.float32(reward), terminated or truncated, info


class BalanceBatch:
    """Independent MuJoCo worlds with a torch-friendly batch API."""

    def __init__(self, num_envs: int, seed: int = 20260922, episode_seconds: float = 12.0,
                 stilts: bool = False, stilts_height_cm: float = 25.0):
        self.envs = [
            BasketballBalanceEnv(BalanceConfig(
                seed=seed + i,
                episode_seconds=episode_seconds,
                stilts=stilts,
                stilts_height_cm=stilts_height_cm,
            ))
            for i in range(num_envs)
        ]
        self.observation_dim = OBSERVATION_SIZE
        self.action_dim = ACTION_SIZE

    def reset(self) -> np.ndarray:
        return np.stack([env.reset() for env in self.envs])

    def step(self, actions: np.ndarray):
        results = [env.step(actions[i]) for i, env in enumerate(self.envs)]
        obs, rewards, dones, infos = zip(*results)
        for i, done in enumerate(dones):
            if done:
                obs = list(obs)
                obs[i] = self.envs[i].reset()
        return np.stack(obs), np.asarray(rewards, dtype=np.float32), dones, list(infos)
