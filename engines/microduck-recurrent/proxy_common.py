"""Shared MicroDuck proxy-environment contract for the recurrent trainer.

Every proxy in this engine keeps the MicroDuck deployment contract — 61
observation slots at 50 Hz, 14 action slots, the same slot layout as
``microduck_eval.sim.MicroDuckSim.observation`` (gyro, projected gravity,
posture offsets, posture velocities, last action, command). The physics and
the reward differ per task module; the contract, the 14-channel posture
reduction and the episode scaffolding live here, so a new proxy is one scene
plus a few dynamics hooks — never a fork of the observation code.

The posture channels are real environment state (a low-pass filter over past
actions) that reaches the physics through a fixed random projection, a
first-order stand-in for "14 servos shift the centre of mass". The policy
sees no hidden state directly: whatever the task hides (ball spin, swing
phase, climb rhythm) must be inferred from gyro/tilt *history*, which is why
these tasks need a recurrent policy at all.
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
DUCK_MASS = 0.8

#: Posture low-pass factor: posture <- (1-A)*posture + A*action.
POSTURE_ALPHA = 0.35
#: |tilt| beyond this (radians, duck z-axis vs world z) is a fall.
TILT_FALL_RADIUS = 1.0
#: N·m per unit of the normalised posture projection.
TORQUE_GAIN = 0.6
#: N·m per unit of the commanded lean.
LEAN_GAIN = 0.4


def posture_projection(seed: int) -> np.ndarray:
    """Fixed (3, 14) posture->torque projection, rows L2-normalised.

    Part of the environment definition, not a learned weight: every posture
    channel reaches the physics through a deterministic, documented map, the
    same way a real posture change reaches the centre of mass.
    """
    rng = np.random.default_rng(seed)
    matrix = rng.uniform(-1.0, 1.0, (3, ACTION_SIZE))
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix.astype(np.float64)


def quat_to_matrix(quat: np.ndarray) -> np.ndarray:
    matrix = np.zeros(9, dtype=np.float64)
    mujoco.mju_quat2Mat(matrix, np.asarray(quat, dtype=np.float64))
    return matrix.reshape(3, 3)


@dataclass(frozen=True)
class ProxyConfig:
    episode_seconds: float = 12.0
    seed: int = 20260922
    posture_projection_seed: int = 20260922


class ProxyEnvBase:
    """Episode scaffolding shared by every MicroDuck proxy task.

    Subclasses provide the MuJoCo scene, the actuation map, the reward and
    any task-specific termination; this base owns the observation contract,
    the posture state and the step timing.
    """

    def __init__(self, config: ProxyConfig):
        self.config = config
        self.model = mujoco.MjModel.from_xml_string(self._scene_xml())
        self.data = mujoco.MjData(self.model)
        self.projection = posture_projection(config.posture_projection_seed)
        self.tilt_joint = self._joint_id("duck_tilt")
        if self.model.jnt_type[self.tilt_joint] != mujoco.mjtJoint.mjJNT_BALL:
            raise RuntimeError("duck_tilt must be a ball joint")
        self.tilt_qpos = int(self.model.jnt_qposadr[self.tilt_joint])
        self.tilt_dof = int(self.model.jnt_dofadr[self.tilt_joint])
        self.tilt_tau_dofs = slice(self.tilt_dof, self.tilt_dof + 3)
        self.gyro_adr = int(self.model.sensor_adr[self._sensor_id("imu_ang_vel")])
        self.quat_adr = int(self.model.sensor_adr[self._sensor_id("duck_quat")])
        self.substeps = max(1, int(round((1.0 / CONTROL_HZ) / PHYSICS_TIMESTEP)))
        self.rng = np.random.default_rng(config.seed)
        self.episode_steps = int(round(config.episode_seconds * CONTROL_HZ))
        self.step_count = 0
        self.posture = np.zeros(ACTION_SIZE, dtype=np.float64)
        self.prev_posture = np.zeros(ACTION_SIZE, dtype=np.float64)
        self.last_action = np.zeros(ACTION_SIZE, dtype=np.float64)
        self.command = np.zeros(COMMAND_SIZE, dtype=np.float64)

    # ---- hooks a task must implement --------------------------------------

    def _scene_xml(self) -> str:
        raise NotImplementedError

    def _apply_action(self) -> np.ndarray:
        """Apply the posture-derived actuation; return the applied torque."""
        raise NotImplementedError

    def _reset_command(self) -> None:
        """Fill ``self.command`` for a fresh episode."""
        raise NotImplementedError

    def _reward(self, tilt: float, torque: np.ndarray) -> float:
        raise NotImplementedError

    def _extra_reset(self) -> None:
        """Task-specific state after mj_resetData and the initial tilt."""

    def _extra_termination(self) -> tuple[bool, dict]:
        """Task-specific end condition; returns (terminated, info extras)."""
        return False, {}

    # ---- optional hooks ----------------------------------------------------

    def _initial_tilt_angle(self) -> float:
        return float(self.rng.uniform(0.0, 0.15))

    # ---- contract plumbing -------------------------------------------------

    def _joint_id(self, name: str) -> int:
        return mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, name)

    def _sensor_id(self, name: str) -> int:
        return mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SENSOR, name)

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
        # Domain randomisation: a small initial tilt, so every episode starts
        # away from the (unstable) equilibrium and the policy must react.
        axis = self.rng.normal(size=3)
        axis /= np.linalg.norm(axis) + 1e-9
        angle = self._initial_tilt_angle()
        half = angle / 2.0
        self.data.qpos[self.tilt_qpos : self.tilt_qpos + 4] = (
            np.cos(half), axis[0] * np.sin(half), axis[1] * np.sin(half), axis[2] * np.sin(half),
        )
        self._extra_reset()
        self._reset_command()
        mujoco.mj_forward(self.model, self.data)
        return self.observation()

    def _tilt(self) -> float:
        matrix = quat_to_matrix(self.data.sensordata[self.quat_adr : self.quat_adr + 4])
        return float(np.arccos(np.clip(matrix[2, 2], -1.0, 1.0)))

    def observation(self) -> np.ndarray:
        gyro = self.data.sensordata[self.gyro_adr : self.gyro_adr + 3]
        matrix = quat_to_matrix(self.data.sensordata[self.quat_adr : self.quat_adr + 4])
        projected_gravity = matrix.T @ np.array([0.0, 0.0, -1.0])
        posture_vel = (self.posture - self.prev_posture) * CONTROL_HZ
        observation = np.concatenate([
            gyro, projected_gravity, self.posture, posture_vel,
            self.last_action, self.command,
        ]).astype(np.float32)
        if observation.shape != (OBSERVATION_SIZE,):
            raise RuntimeError(f"observation assembled as {observation.shape}, expected (61,)")
        return observation

    def step(self, action: np.ndarray):
        action = np.clip(np.asarray(action, dtype=np.float64).reshape(ACTION_SIZE), -1.0, 1.0)
        self.prev_posture = self.posture
        self.posture = (1.0 - POSTURE_ALPHA) * self.posture + POSTURE_ALPHA * action
        torque = self._apply_action()
        for _ in range(self.substeps):
            mujoco.mj_step(self.model, self.data)
        self.last_action = action
        self.step_count += 1
        tilt = self._tilt()
        extra_terminated, info_extra = self._extra_termination()
        fallen = tilt > TILT_FALL_RADIUS
        reward = self._reward(tilt, torque)
        terminated = bool(fallen or extra_terminated)
        truncated = self.step_count >= self.episode_steps
        info = {"tilt": tilt, "fallen": fallen, **info_extra}
        return self.observation(), np.float32(reward), terminated or truncated, info


class ProxyBatch:
    """Independent MuJoCo worlds with a torch-friendly batch API."""

    def __init__(self, num_envs: int, factory):
        self.envs = [factory(i) for i in range(num_envs)]
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
