"""Self-contained MicroDuck ladder-climb proxy (course task: 梯面攀爬 · 攀爬段).

Abstraction level, stated plainly: the course task is ladder climbing with a
climb→mount→stand-up skill chain; the multi-policy relay lives in the task
state machine, not here. This proxy trains the *climb segment only*: the
duck hugs a vertical pole and must produce a steady climbing rhythm toward
a commanded climb rate.

Physics: the climber rides a prismatic (slide) joint along the vertical
axis. Climb force from the shared posture projection only transfers through
a rung-phase gain — ``0.5 + 0.5*cos(2π z / pitch)`` — so force applied
between rungs is halved. Height and phase are *not* in the observation
(the duck gyro is blind to translation), so the phase the policy has
accumulated can only be inferred from its own action history: a genuinely
recurrent rhythm task. The drawn rungs are geometric decoration at the same
abstraction level as the sphere duck proxy.

Reward tracks the commanded climb rate with an effort penalty; the episode
ends when the duck tips, or slips below its start height.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from proxy_common import (  # noqa: F401  (re-exported contract constants)
    ACTION_SIZE,
    COMMAND_SIZE,
    CONTROL_HZ,
    DUCK_MASS,
    OBSERVATION_SIZE,
    PHYSICS_TIMESTEP,
    ProxyBatch,
    ProxyConfig,
    ProxyEnvBase,
    TORQUE_GAIN,
)

GRAVITY = 9.81
#: Rung pitch in metres; the rung-phase gain keys on it.
RUNG_PITCH = 0.12
#: Slide joint travel limits (metres along the pole).
CLIMB_Z_MIN = 0.2
CLIMB_Z_MAX = 1.8
#: Climbing starts here; slipping below minus margin ends the episode.
CLIMB_Z_START = 0.5
SLIP_MARGIN = 0.25
#: N per unit of the normalised posture projection on the climb axis.
CLIMB_FORCE_GAIN = 14.0
#: N of static grip: without it gravity wins and the duck slides down.
GRIP_FORCE = DUCK_MASS * GRAVITY
#: N·m per unit of the normalised posture projection on the tilt joint
#: (the duck still has to keep itself upright on the pole).
TILT_TORQUE_GAIN = 0.6


@dataclass(frozen=True)
class LadderConfig(ProxyConfig):
    pass


def _rung_geoms() -> str:
    rungs = []
    z = CLIMB_Z_MIN
    index = 0
    while z <= CLIMB_Z_MAX:
        y = 0.18 if index % 2 == 0 else -0.18
        rungs.append(
            f'    <geom name="rung_{index}" type="capsule" '
            f'fromto="-0.12 {y} {z:.3f} 0.12 {y} {z:.3f}" size="0.008" '
            f'contype="0" conaffinity="0"/>'
        )
        z += RUNG_PITCH
        index += 1
    return "\n".join(rungs)


_SCENE_XML = f"""
<mujoco model="microduck-ladder-climb">
  <option timestep="{PHYSICS_TIMESTEP}" gravity="0 0 -9.81" integrator="implicitfast"/>
  <size njmax="500" nconmax="100"/>
  <default>
    <geom friction="1.0 0.005 0.0001" condim="3"/>
    <joint damping="0.01"/>
  </default>
  <worldbody>
    <light name="top" pos="0 -1 3" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="3 3 0.05"/>
    <geom name="pole" type="capsule" fromto="0 0 0 0 0 2.0" size="0.015"
          contype="0" conaffinity="0"/>
{_rung_geoms()}
    <body name="duck" pos="0 0 {CLIMB_Z_START}">
      <joint name="duck_slide" type="slide" axis="0 0 1" range="{CLIMB_Z_MIN} {CLIMB_Z_MAX}"
             damping="2.0"/>
      <joint name="duck_tilt" type="ball" damping="0.05"/>
      <geom name="duck_body" type="sphere" size="0.10" mass="{DUCK_MASS}" pos="0 0 0.10"
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


class LadderClimbEnv(ProxyEnvBase):
    """One duck climbing one pole. Obs (61,), action (14,), 50 Hz."""

    def __init__(self, config: LadderConfig | None = None):
        self.config = config or LadderConfig()
        super().__init__(self.config)
        self.slide_dof = int(self.model.jnt_dofadr[self._joint_id("duck_slide")])
        self.slide_qpos = int(self.model.jnt_qposadr[self._joint_id("duck_slide")])

    def _scene_xml(self) -> str:
        return _SCENE_XML

    def _reset_command(self) -> None:
        self.command = np.zeros(COMMAND_SIZE, dtype=np.float64)
        # command[4]: commanded climb rate (m/s); command[3]: effort scale.
        self.command[3] = self.rng.uniform(0.8, 1.2)
        self.command[4] = self.rng.uniform(0.02, 0.12)

    def _extra_reset(self) -> None:
        # Random start phase along the rung pitch: the policy cannot observe
        # it and must infer the phase from its own action history.
        self.data.qpos[self.slide_qpos] = CLIMB_Z_START + self.rng.uniform(0.0, RUNG_PITCH)

    def _apply_action(self) -> np.ndarray:
        projected = self.projection @ self.posture
        z = float(self.data.qpos[self.slide_qpos])
        phase = 0.5 + 0.5 * float(np.cos(2.0 * np.pi * z / RUNG_PITCH))
        climb = CLIMB_FORCE_GAIN * float(projected[2]) * self.command[3] * phase
        climb = float(np.clip(climb, -0.5 * GRIP_FORCE, 1.5 * GRIP_FORCE))
        self.data.qfrc_applied[self.slide_dof] = GRIP_FORCE + climb
        tilt_torque = np.clip(projected * TILT_TORQUE_GAIN, -0.96, 0.96)
        self.data.qfrc_applied[self.tilt_tau_dofs] = tilt_torque
        return tilt_torque

    def _extra_termination(self) -> tuple[bool, dict]:
        z = float(self.data.qpos[self.slide_qpos])
        slipped = z < CLIMB_Z_START - SLIP_MARGIN
        return slipped, {"height": round(z, 4), "slipped": slipped}

    def _reward(self, tilt: float, torque: np.ndarray) -> float:
        rate = float(self.data.qvel[self.slide_dof])
        target = self.command[4]
        tracking = float(np.clip(rate / max(target, 1e-6), -1.0, 1.0))
        return 0.25 + 0.75 * tracking - 0.001 * float(np.sum(torque**2))


class LadderBatch(ProxyBatch):
    """Independent ladder worlds with a torch-friendly batch API."""

    def __init__(self, num_envs: int, seed: int = 20260922, episode_seconds: float = 12.0):
        super().__init__(num_envs, lambda i: LadderClimbEnv(LadderConfig(
            seed=seed + i,
            episode_seconds=episode_seconds,
        )))
