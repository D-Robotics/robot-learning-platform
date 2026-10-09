"""Self-contained MicroDuck balance proxies (basketball / stilts).

Like ``microduck-football``, these environments are deliberately self
contained: a procedural MuJoCo scene, no upstream checkout, runnable on a
laptop CPU. A duck-proxy body is articulated on top of a rolling basketball
through a ball joint, so tilting the duck makes the ball roll away — the
classic broom-on-a-ball instability. On stilts the pivot is fixed at the
stilt height and the rod mass follows the height, so geometry and mass move
together. The policy sees no ball state: it must infer the pivot's motion
from gyro/tilt *history*, which is why this task needs a recurrent policy.

The observation/action contract, posture reduction and episode scaffolding
live in ``proxy_common``; this module owns the two balance scenes.
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
    POSTURE_ALPHA,
    ProxyBatch,
    ProxyConfig,
    ProxyEnvBase,
    TILT_FALL_RADIUS,
    TORQUE_GAIN,
)

BALL_RADIUS = 0.12
BALL_MASS = 0.55
#: Ball centre drifting this far from the origin also ends the episode.
BALL_ROLLAWAY_RADIUS = 1.0


@dataclass(frozen=True)
class BalanceConfig(ProxyConfig):
    #: False -> duck on a rolling basketball (drifting pivot, memory matters).
    #: True  -> duck on two rigid stilts (fixed pivot at the stilt height).
    stilts: bool = False
    #: Stilt height in cm; mass follows the upstream-style formula
    #: (0.012 + 0.001 * h_cm) kg per stilt, so geometry and mass move together.
    stilts_height_cm: float = 25.0


def _stilt_mass_per_rod(height_cm: float) -> float:
    return 0.012 + 0.001 * height_cm


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


class BasketballBalanceEnv(ProxyEnvBase):
    """One duck on one basketball (or rigid stilts). Obs (61,), action (14,), 50 Hz."""

    def __init__(self, config: BalanceConfig | None = None):
        self.config = config or BalanceConfig()
        super().__init__(self.config)
        self.ball_joint = self._joint_id("ball_free")
        self.ball_qpos = int(self.model.jnt_qposadr[self.ball_joint]) if self.ball_joint >= 0 else None
        self.ball_dof = int(self.model.jnt_dofadr[self.ball_joint]) if self.ball_joint >= 0 else None

    def _scene_xml(self) -> str:
        return _scene_for(self.config)

    def _reset_command(self) -> None:
        self.command = np.zeros(COMMAND_SIZE, dtype=np.float64)
        self.command[0] = self.rng.uniform(-0.3, 0.3)
        self.command[1] = self.rng.uniform(-0.3, 0.3)
        self.command[2] = self.rng.uniform(0.0, 0.4)
        self.command[3] = self.rng.uniform(0.8, 1.2)

    def _extra_reset(self) -> None:
        if self.ball_qpos is None:
            return
        # A shove on the ball, so the policy must react to pivot motion it
        # cannot observe directly.
        self.data.qvel[self.ball_dof + 0] = self.rng.uniform(-0.2, 0.2)
        self.data.qvel[self.ball_dof + 1] = self.rng.uniform(-0.2, 0.2)

    def _apply_action(self) -> np.ndarray:
        torque = self.projection @ self.posture * TORQUE_GAIN * self.command[3]
        torque[0] += LEAN_GAIN * self.command[0]
        torque[1] += LEAN_GAIN * self.command[1]
        torque = np.clip(torque, -0.96, 0.96)
        self.data.qfrc_applied[self.tilt_tau_dofs] = torque
        return torque

    def _extra_termination(self) -> tuple[bool, dict]:
        if self.ball_qpos is None:
            return False, {"rolledAway": False}
        ball_xy = self.data.qpos[self.ball_qpos : self.ball_qpos + 2]
        rolled_away = float(np.linalg.norm(ball_xy)) > BALL_ROLLAWAY_RADIUS
        return rolled_away, {"rolledAway": rolled_away}

    def _reward(self, tilt: float, torque: np.ndarray) -> float:
        return 0.5 + 0.5 * float(np.cos(tilt)) - 0.001 * float(np.sum(torque**2))


class BalanceBatch(ProxyBatch):
    """Independent balance worlds with a torch-friendly batch API."""

    def __init__(self, num_envs: int, seed: int = 20260922, episode_seconds: float = 12.0,
                 stilts: bool = False, stilts_height_cm: float = 25.0):
        super().__init__(num_envs, lambda i: BasketballBalanceEnv(BalanceConfig(
            seed=seed + i,
            episode_seconds=episode_seconds,
            stilts=stilts,
            stilts_height_cm=stilts_height_cm,
        )))
