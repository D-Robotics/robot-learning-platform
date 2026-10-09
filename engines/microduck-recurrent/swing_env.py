"""Self-contained MicroDuck swing-pump proxy (course task: 摆动旋转).

A duck-proxy body sits on a swing seat hung from an overhead bar by two
rigid rods. The swing rotates around a horizontal hinge at the bar; the
policy pumps it by shifting its 14 posture channels, which reach the hinge
as torque through the shared random projection. The hinge angle and angular
velocity are *not* in the observation: the duck only senses its own gyro and
tilt, so the pump timing relative to the swing's phase must be inferred from
history — a genuinely recurrent control task (drive the pendulum at
resonance and the amplitude grows; drive it out of phase and it dies).

Reward is commanded-direction swing power with an effort penalty; the
episode ends when the duck tips off the seat or the swing wraps past the
bar. The seat/rod assembly is massless-rod idealisation at the same
abstraction level as the sphere duck proxy.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from proxy_common import (  # noqa: F401  (re-exported contract constants)
    ACTION_SIZE,
    COMMAND_SIZE,
    CONTROL_HZ,
    DUCK_MASS,
    LEAN_GAIN,
    OBSERVATION_SIZE,
    PHYSICS_TIMESTEP,
    ProxyBatch,
    ProxyConfig,
    ProxyEnvBase,
    TORQUE_GAIN,
)

ROD_LENGTH = 0.8
SEAT_MASS = 0.3
#: Swing angle past this (radians from straight down) ends the episode.
SWING_WRAP_RADIUS = 2.0
#: Hinge angular velocity (rad/s) that maps to a full reward credit.
SWING_RATE_REFERENCE = 2.5
#: Swing angle (rad) that maps to a full amplitude credit.
SWING_AMPLITUDE_REFERENCE = 1.0
#: N·m per unit of the normalised posture projection on the hinge. A rider
#: pumps softly: strong constant torque tips the duck off the seat long
#: before the amplitude grows, so phase timing — not raw force — pays.
PUMP_TORQUE_GAIN = 0.45


@dataclass(frozen=True)
class SwingConfig(ProxyConfig):
    pass


_SCENE_XML = f"""
<mujoco model="microduck-swing-pump">
  <option timestep="{PHYSICS_TIMESTEP}" gravity="0 0 -9.81" integrator="implicitfast"/>
  <size njmax="500" nconmax="100"/>
  <default>
    <geom friction="1.0 0.005 0.0001" condim="3"/>
    <joint damping="0.01"/>
  </default>
  <worldbody>
    <light name="top" pos="0 -1 3" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="3 3 0.05"/>
    <geom name="bar" type="capsule" fromto="-0.3 0 {ROD_LENGTH} 0.3 0 {ROD_LENGTH}"
          size="0.02" contype="0" conaffinity="0"/>
    <body name="swing" pos="0 0 {ROD_LENGTH}">
      <joint name="swing_hinge" type="hinge" axis="0 1 0" damping="0.002"/>
      <geom name="rod_left" type="capsule" fromto="-0.12 0 0 -0.12 0 -{ROD_LENGTH}" size="0.008"
            mass="0" contype="0" conaffinity="0"/>
      <geom name="rod_right" type="capsule" fromto="0.12 0 0 0.12 0 -{ROD_LENGTH}" size="0.008"
            mass="0" contype="0" conaffinity="0"/>
      <geom name="seat" type="box" size="0.10 0.08 0.012" pos="0 0 -{ROD_LENGTH}"
            mass="{SEAT_MASS}" contype="0" conaffinity="0"/>
      <body name="duck" pos="0 0 -{ROD_LENGTH}">
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


class SwingPumpEnv(ProxyEnvBase):
    """One duck pumping one swing. Obs (61,), action (14,), 50 Hz."""

    def __init__(self, config: SwingConfig | None = None):
        self.config = config or SwingConfig()
        super().__init__(self.config)
        self.hinge_joint = self._joint_id("swing_hinge")
        self.hinge_dof = int(self.model.jnt_dofadr[self.hinge_joint])

    def _scene_xml(self) -> str:
        return _SCENE_XML

    def _reset_command(self) -> None:
        self.command = np.zeros(COMMAND_SIZE, dtype=np.float64)
        # command[0]: commanded pump direction (+1 swings toward +x, -1 the
        # other way); command[3]: effort scale, same slot as the balance task.
        self.command[0] = self.rng.choice([-1.0, 1.0])
        self.command[3] = self.rng.uniform(0.8, 1.2)

    def _apply_action(self) -> np.ndarray:
        # The posture projection's y-row drives the hinge (axis 0 1 0); the
        # x/z rows are recorded effort but transfer no swing torque.
        projected = self.projection @ self.posture
        hinge_torque = float(projected[1]) * PUMP_TORQUE_GAIN * self.command[3]
        hinge_torque += LEAN_GAIN * self.command[0]
        hinge_torque = float(np.clip(hinge_torque, -2.4, 2.4))
        self.data.qfrc_applied[self.hinge_dof] = hinge_torque
        return np.array([0.0, hinge_torque, 0.0])

    def _extra_termination(self) -> tuple[bool, dict]:
        hinge_qpos = int(self.model.jnt_qposadr[self.hinge_joint])
        angle = float(self.data.qpos[hinge_qpos])
        wrapped = abs(angle) > SWING_WRAP_RADIUS
        return wrapped, {"swingAngle": round(angle, 4), "wrapped": wrapped}

    def _reward(self, tilt: float, torque: np.ndarray) -> float:
        hinge_qpos = int(self.model.jnt_qposadr[self.hinge_joint])
        hinge_qvel = int(self.model.jnt_dofadr[self.hinge_joint])
        angle = abs(float(self.data.qpos[hinge_qpos]))
        rate = float(self.data.qvel[hinge_qvel])
        # Amplitude is a potential (a symmetric oscillation has zero mean
        # directed power, so growth must be rewarded directly); power keeps
        # the commanded-direction semantics.
        amplitude = min(angle / SWING_AMPLITUDE_REFERENCE, 1.0)
        power = float(np.clip(self.command[0] * rate / SWING_RATE_REFERENCE, -1.0, 1.0))
        return 0.25 + 0.5 * amplitude + 0.25 * power - 0.001 * float(np.sum(torque**2))


class SwingBatch(ProxyBatch):
    """Independent swing worlds with a torch-friendly batch API."""

    def __init__(self, num_envs: int, seed: int = 20260922, episode_seconds: float = 12.0):
        super().__init__(num_envs, lambda i: SwingPumpEnv(SwingConfig(
            seed=seed + i,
            episode_seconds=episode_seconds,
        )))
