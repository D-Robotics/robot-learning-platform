"""Evaluation envelopes: the pinned conditions a result is only valid inside.

An envelope freezes everything that could move a success rate: the random seed,
the episode count, the initial state, and the disturbance profile. Two runs of
the same policy inside the same envelope must produce the same numbers; a run
reported without its envelope is not evidence.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class InitialState:
    """Deterministic initial conditions, sampled per-episode from ``seed``.

    ``ball_distance`` is expressed relative to the robot's mouth tip. Envs that
    have no ball (walking) leave it ``None`` and the simulator omits the ball.
    """

    base_pos: tuple[float, float, float] = (0.0, 0.0, 0.0)
    base_yaw: float = 0.0
    #: Uniform sampling half-width applied around ``base_pos`` / ``base_yaw``.
    base_pos_jitter: tuple[float, float, float] = (0.0, 0.0, 0.0)
    base_yaw_jitter: float = 0.0
    ball_distance: float | None = None
    ball_distance_jitter: float = 0.0
    ball_lateral_jitter: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "basePos": list(self.base_pos),
            "baseYaw": self.base_yaw,
            "basePosJitter": list(self.base_pos_jitter),
            "baseYawJitter": self.base_yaw_jitter,
        }
        if self.ball_distance is not None:
            payload.update(
                {
                    "ballDistance": self.ball_distance,
                    "ballDistanceJitter": self.ball_distance_jitter,
                    "ballLateralJitter": self.ball_lateral_jitter,
                }
            )
        return payload


#: Rated forward speed for MicroDuck velocity commands (upstream trains on
#: lin_vel_x in ±0.4 m/s and ships 0.4 m/s as the nominal walking demo).
RATED_FORWARD_SPEED_MPS = 0.4


@dataclass(frozen=True)
class CommandProfile:
    """The command the policy is asked to track for the whole episode."""

    lin_vel_x: float = 0.0
    lin_vel_y: float = 0.0
    ang_vel_z: float = 0.0
    head_pose: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    body_pose: tuple[float, float, float, float, float, float] = (0.0,) * 6

    def as_vector(self) -> list[float]:
        return [
            self.lin_vel_x,
            self.lin_vel_y,
            self.ang_vel_z,
            *self.head_pose,
            *self.body_pose,
        ]

    def as_dict(self) -> dict[str, Any]:
        return {
            "twist": [self.lin_vel_x, self.lin_vel_y, self.ang_vel_z],
            "headPose": list(self.head_pose),
            "bodyPose": list(self.body_pose),
        }


@dataclass(frozen=True)
class EvalEnvelope:
    """One pinned evaluation condition set."""

    name: str
    seed: int
    episodes: int
    episode_seconds: float
    initial_state: InitialState = field(default_factory=InitialState)
    command: CommandProfile = field(default_factory=CommandProfile)
    #: Fraction of actuator commands dropped (0 = perfect actuation).
    command_dropout: float = 0.0
    #: Uniform noise added to the gyro channel of the observation (rad/s).
    gyro_noise_std: float = 0.0
    #: Extra payload mass added to the trunk, as a fraction of nominal mass.
    payload_fraction: float = 0.0
    #: True when the evaluated policy is a known-good training artifact (not an
    #: untrained smoke checkpoint). A trusted policy failing everywhere is
    #: evidence about the harness, not about the policy.
    trusted_policy: bool = False
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "seed": self.seed,
            "episodes": self.episodes,
            "episodeSeconds": self.episode_seconds,
            "initialState": self.initial_state.as_dict(),
            "command": self.command.as_dict(),
        }
        if self.command_dropout:
            payload["commandDropout"] = self.command_dropout
        if self.gyro_noise_std:
            payload["gyroNoiseStd"] = self.gyro_noise_std
        if self.payload_fraction:
            payload["payloadFraction"] = self.payload_fraction
        if self.notes:
            payload["notes"] = self.notes
        return payload


#: Nominal: flat ground, factory calibration, no disturbance. This is the
#: envelope whose Wilson lower bound the release gate reads.
#:
#: The ball sits in front of the trunk at the upstream spawn offset (0.09 m past
#: the toe, which lands ~0.225 m ahead of the trunk origin) with the same ±2 cm
#: placement error upstream randomizes — the actor is ball-blind, so this error
#: is a task precondition, not something the policy can correct for.
NOMINAL = EvalEnvelope(
    name="nominal",
    seed=20260916,
    episodes=50,
    episode_seconds=4.0,
    initial_state=InitialState(
        base_pos=(0.0, 0.0, 0.0),
        base_pos_jitter=(0.005, 0.005, 0.0),
        base_yaw_jitter=0.02,
        ball_distance=0.225,
        ball_distance_jitter=0.02,
        ball_lateral_jitter=0.01,
    ),
    notes="工厂标定、无障碍、无外部扰动；球位前向 ±2cm（与上游 BALL_POS_NOISE_XY 同量级）",
)

#: Hard: the same policy under a disturbed envelope. Reported next to nominal
#: so the robustness cost is visible instead of implied.
HARD = EvalEnvelope(
    name="hard",
    seed=20260917,
    episodes=50,
    episode_seconds=4.0,
    initial_state=InitialState(
        base_pos=(0.0, 0.0, 0.0),
        base_pos_jitter=(0.02, 0.02, 0.0),
        base_yaw_jitter=0.12,
        ball_distance=0.225,
        ball_distance_jitter=0.05,
        ball_lateral_jitter=0.04,
    ),
    command_dropout=0.02,
    gyro_noise_std=0.05,
    payload_fraction=0.05,
    notes="初始位姿偏移、球位前向 ±5cm、2% 指令丢帧、陀螺噪声、+5% 负载",
)

#: Endurance: 60 s of the same pinned conditions, no ball. Duration *is* the
#: stress: a 4 s episode cannot tell a policy that balances from one that is
#: merely slow to fall (community balance experiments, e.g. basketball
#: balancing, report 60 s survival precisely because 4 s says nothing).
#: Disturbances stay at nominal level — pairing endurance with the hard
#: profile is a different envelope and must be named as one, not implied.
ENDURANCE = EvalEnvelope(
    name="endurance",
    seed=20260918,
    episodes=50,
    episode_seconds=60.0,
    initial_state=InitialState(
        base_pos=(0.0, 0.0, 0.0),
        base_pos_jitter=(0.005, 0.005, 0.0),
        base_yaw_jitter=0.02,
    ),
    notes="60 s 存活信封：给平衡/站立类任务用，时长本身是考验；扰动与 nominal 同级、无球",
)

ENVELOPES: dict[str, EvalEnvelope] = {
    NOMINAL.name: NOMINAL,
    HARD.name: HARD,
    ENDURANCE.name: ENDURANCE,
}
