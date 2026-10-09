"""Self-contained MicroDuck ball-balance proxy (course task: 球面平衡).

The basketball sibling in this engine puts a duck on a small, lively ball;
this proxy is the large-stability-ball variant of the same family: the duck
rides a 30 cm ball whose inertia is an order of magnitude larger, so the
pivot drifts slowly and the ball's angular state stays unobservable for much
longer stretches. Same nested-body coupling as the basketball scene: tilting
the duck torques the ball through the shared joint, the ball rolls, and the
policy must infer that hidden motion from gyro/tilt history — the longer
horizon is what makes this variant a distinct curriculum step.

Observation/action contract and episode scaffolding live in
``proxy_common``; reward family matches ``balance_env`` (upright cosine
minus effort, roll-away termination).
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
    TILT_FALL_RADIUS,
    TORQUE_GAIN,
)

BALL_RADIUS = 0.30
BALL_MASS = 1.2
#: Ball centre drifting this far from the origin also ends the episode.
BALL_ROLLAWAY_RADIUS = 0.8


@dataclass(frozen=True)
class BallBalanceConfig(ProxyConfig):
    pass


_SCENE_XML = f"""
<mujoco model="microduck-ball-balance">
  <option timestep="{PHYSICS_TIMESTEP}" gravity="0 0 -9.81" integrator="implicitfast"/>
  <size njmax="500" nconmax="100"/>
  <default>
    <geom friction="1.0 0.005 0.0001" condim="3"/>
    <joint damping="0.01"/>
  </default>
  <worldbody>
    <light name="top" pos="0 -1 3" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="3 3 0.05"/>
    <body name="stability_ball" pos="0 0 {BALL_RADIUS}">
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


class BallBalanceEnv(ProxyEnvBase):
    """One duck on one large stability ball. Obs (61,), action (14,), 50 Hz."""

    def __init__(self, config: BallBalanceConfig | None = None):
        self.config = config or BallBalanceConfig()
        super().__init__(self.config)
        self.ball_joint = self._joint_id("ball_free")
        self.ball_qpos = int(self.model.jnt_qposadr[self.ball_joint])
        self.ball_dof = int(self.model.jnt_dofadr[self.ball_joint])

    def _scene_xml(self) -> str:
        return _SCENE_XML

    def _reset_command(self) -> None:
        self.command = np.zeros(COMMAND_SIZE, dtype=np.float64)
        self.command[0] = self.rng.uniform(-0.3, 0.3)
        self.command[1] = self.rng.uniform(-0.3, 0.3)
        self.command[2] = self.rng.uniform(0.0, 0.4)
        self.command[3] = self.rng.uniform(0.8, 1.2)

    def _extra_reset(self) -> None:
        # A gentle shove: with the larger inertia the drift is slow, so the
        # hidden ball state stays informative across many control steps.
        self.data.qvel[self.ball_dof + 0] = self.rng.uniform(-0.08, 0.08)
        self.data.qvel[self.ball_dof + 1] = self.rng.uniform(-0.08, 0.08)

    def _apply_action(self) -> np.ndarray:
        torque = self.projection @ self.posture * TORQUE_GAIN * self.command[3]
        torque[0] += LEAN_GAIN * self.command[0]
        torque[1] += LEAN_GAIN * self.command[1]
        torque = np.clip(torque, -0.96, 0.96)
        self.data.qfrc_applied[self.tilt_tau_dofs] = torque
        return torque

    def _extra_termination(self) -> tuple[bool, dict]:
        ball_xy = self.data.qpos[self.ball_qpos : self.ball_qpos + 2]
        rolled_away = float(np.linalg.norm(ball_xy)) > BALL_ROLLAWAY_RADIUS
        return rolled_away, {"rolledAway": rolled_away}

    def _reward(self, tilt: float, torque: np.ndarray) -> float:
        return 0.5 + 0.5 * float(np.cos(tilt)) - 0.001 * float(np.sum(torque**2))


class BallBalanceBatch(ProxyBatch):
    """Independent stability-ball worlds with a torch-friendly batch API."""

    def __init__(self, num_envs: int, seed: int = 20260922, episode_seconds: float = 12.0):
        super().__init__(num_envs, lambda i: BallBalanceEnv(BallBalanceConfig(
            seed=seed + i,
            episode_seconds=episode_seconds,
        )))
