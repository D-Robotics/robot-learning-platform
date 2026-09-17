"""Task-level success criteria for MicroDuck, stated in physical units.

The upstream trainer scores rewards; it does not say whether the robot actually
did the thing. Each task below turns the same episode trace into a boolean plus
physical measurements, so the platform gate can read a success rate whose
meaning is written down.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .envelope import EvalEnvelope, InitialState


@dataclass
class EpisodeTrace:
    """Per-step measurements collected while the episode runs."""

    dt: float
    base_xy: list[tuple[float, float]] = field(default_factory=list)
    base_z: list[float] = field(default_factory=list)
    body_pitch: list[float] = field(default_factory=list)
    body_roll: list[float] = field(default_factory=list)
    ball_xy: list[tuple[float, float]] = field(default_factory=list)
    ball_z: list[float] = field(default_factory=list)
    ground_contact: list[bool] = field(default_factory=list)

    def base_speed(self) -> list[float]:
        speeds = []
        for index in range(1, len(self.base_xy)):
            (x0, y0), (x1, y1) = self.base_xy[index - 1], self.base_xy[index]
            speeds.append(((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 / self.dt)
        return speeds

    def ball_speed(self) -> list[float]:
        speeds = []
        for index in range(1, len(self.ball_xy)):
            (x0, y0), (x1, y1) = self.ball_xy[index - 1], self.ball_xy[index]
            speeds.append(((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 / self.dt)
        return speeds


@dataclass
class EpisodeOutcome:
    success: bool
    fall: bool
    collision: bool
    reward: float
    length_seconds: float
    metrics: dict[str, float]


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return (sum((value - mean) ** 2 for value in values) / (len(values) - 1)) ** 0.5


class Task:
    """Base class: one task = initial conditions + one success rule."""

    task_id: str = "base"
    #: Physical constants the report must record so the reader can verify units.
    definition: dict[str, Any] = {}

    def initial_state(self, envelope: EvalEnvelope) -> InitialState:
        return envelope.initial_state

    def judge(self, trace: EpisodeTrace, envelope: EvalEnvelope) -> EpisodeOutcome:
        raise NotImplementedError

    def as_dict(self) -> dict[str, Any]:
        return {"taskId": self.task_id, **self.definition}


class BallKickTask(Task):
    """Kick the ball forward without falling.

    Matches upstream ``microduck_ball_kick_env_cfg.py``: 70 mm / 15 g ball
    spawned in front of the kicking foot (``BALL_OFFSET_X = 0.09``,
    ``|BALL_OFFSET_ABS_Y| = 0.042``), target ball speed ``1.0 m/s``, and the
    actor is **blind to the ball** — placement error is up to the envelope, not
    something the policy can react to.
    """

    task_id = "ball-kick"
    definition = {
        "ballDiameterM": 0.07,
        "ballMassKg": 0.015,
        "ballSpawnOffsetX": 0.09,
        "ballSpawnOffsetAbsY": 0.042,
        "upstreamTargetBallSpeedMps": 1.0,
        "minBallTravelM": 0.35,
        "minPeakBallSpeedMps": 0.50,
        "fallHeightM": 0.06,
        "fallTiltRad": 1.05,
    }

    def __init__(
        self,
        min_ball_travel: float = 0.35,
        min_peak_ball_speed: float = 0.50,
        fall_height: float = 0.06,
        fall_tilt: float = 1.05,
    ) -> None:
        self.min_ball_travel = min_ball_travel
        self.min_peak_ball_speed = min_peak_ball_speed
        self.fall_height = fall_height
        self.fall_tilt = fall_tilt

    def judge(self, trace: EpisodeTrace, envelope: EvalEnvelope) -> EpisodeOutcome:
        start_xy = trace.ball_xy[0] if trace.ball_xy else (0.0, 0.0)
        end_xy = trace.ball_xy[-1] if trace.ball_xy else start_xy
        travel = ((end_xy[0] - start_xy[0]) ** 2 + (end_xy[1] - start_xy[1]) ** 2) ** 0.5
        forward = end_xy[0] - start_xy[0]
        speeds = trace.ball_speed()
        mean_speed = sum(speeds) / len(speeds) if speeds else 0.0
        peak_speed = max(speeds) if speeds else 0.0
        min_z = min(trace.base_z) if trace.base_z else 0.0
        tilt = max(
            [abs(value) for value in trace.body_pitch] + [abs(value) for value in trace.body_roll]
        ) if trace.body_pitch else 0.0
        fell = min_z < self.fall_height or tilt > self.fall_tilt
        success = (not fell) and travel >= self.min_ball_travel and peak_speed >= self.min_peak_ball_speed
        return EpisodeOutcome(
            success=success,
            fall=fell,
            collision=any(trace.ground_contact),
            reward=0.0,
            length_seconds=len(trace.base_z) * trace.dt,
            metrics={
                "ballTravelM": round(travel, 4),
                "ballForwardM": round(forward, 4),
                "ballPeakSpeedMps": round(peak_speed, 4),
                "ballMeanSpeedMps": round(mean_speed, 4),
                "minBaseHeightM": round(min_z, 4),
                "maxTiltRad": round(tilt, 4),
            },
        )


class VelocityTask(Task):
    """Track a commanded forward speed without falling.

    Success = mean |v - v_cmd| below tolerance over the steady window, gait not
    stalled, and the body upright. The tolerance is absolute m/s, not a reward
    unit, so a reader can check it with a stopwatch.
    """

    task_id = "walking-velocity"
    definition = {
        "speedToleranceMps": 0.15,
        "minForwardM": 0.20,
        "fallHeightM": 0.06,
        "fallTiltRad": 1.05,
        "steadyWindowStartS": 1.0,
    }

    def __init__(
        self,
        speed_tolerance: float = 0.15,
        min_forward: float = 0.20,
        fall_height: float = 0.06,
        fall_tilt: float = 1.05,
        steady_window_start: float = 1.0,
    ) -> None:
        self.speed_tolerance = speed_tolerance
        self.min_forward = min_forward
        self.fall_height = fall_height
        self.fall_tilt = fall_tilt
        self.steady_window_start = steady_window_start

    def judge(self, trace: EpisodeTrace, envelope: EvalEnvelope) -> EpisodeOutcome:
        command = envelope.command
        target = (command.lin_vel_x**2 + command.lin_vel_y**2) ** 0.5
        first = int(self.steady_window_start / trace.dt)
        speeds = trace.base_speed()
        window = speeds[first:] if len(speeds) > first else speeds
        mean_speed = sum(window) / len(window) if window else 0.0
        tracking_error = abs(mean_speed - target)
        start_xy = trace.base_xy[0] if trace.base_xy else (0.0, 0.0)
        end_xy = trace.base_xy[-1] if trace.base_xy else start_xy
        forward = end_xy[0] - start_xy[0]
        min_z = min(trace.base_z) if trace.base_z else 0.0
        tilt = max(
            [abs(value) for value in trace.body_pitch] + [abs(value) for value in trace.body_roll]
        ) if trace.body_pitch else 0.0
        fell = min_z < self.fall_height or tilt > self.fall_tilt
        success = (
            (not fell)
            and tracking_error <= self.speed_tolerance
            and forward >= self.min_forward
        )
        return EpisodeOutcome(
            success=success,
            fall=fell,
            collision=any(trace.ground_contact),
            reward=0.0,
            length_seconds=len(trace.base_z) * trace.dt,
            metrics={
                "meanSpeedMps": round(mean_speed, 4),
                "commandedSpeedMps": round(target, 4),
                "speedTrackingErrorMps": round(tracking_error, 4),
                "forwardM": round(forward, 4),
                "minBaseHeightM": round(min_z, 4),
                "maxTiltRad": round(tilt, 4),
            },
        )


class BalanceTask(Task):
    """Stay upright for the whole episode. Survival *is* the criterion.

    Community balance experiments (e.g. standing on a ball) report 60 s
    survival rates; a 4 s episode cannot distinguish "balances" from "slow to
    fall", so this task pairs with the ``endurance`` envelope. Standing
    perfectly still the entire time is success: for balance, unlike walking,
    doing nothing extra is exactly the job.
    """

    task_id = "balance"
    definition = {
        "fallHeightM": 0.06,
        "fallTiltRad": 1.05,
    }

    def __init__(
        self,
        fall_height: float = 0.06,
        fall_tilt: float = 1.05,
    ) -> None:
        self.fall_height = fall_height
        self.fall_tilt = fall_tilt

    def judge(self, trace: EpisodeTrace, envelope: EvalEnvelope) -> EpisodeOutcome:
        fell_at: int | None = None
        for step, height in enumerate(trace.base_z):
            pitch = trace.body_pitch[step] if step < len(trace.body_pitch) else 0.0
            roll = trace.body_roll[step] if step < len(trace.body_roll) else 0.0
            if height < self.fall_height or abs(pitch) > self.fall_tilt or abs(roll) > self.fall_tilt:
                fell_at = step
                break
        episode_seconds = len(trace.base_z) * trace.dt
        survived = episode_seconds if fell_at is None else fell_at * trace.dt
        min_z = min(trace.base_z) if trace.base_z else 0.0
        tilt = max(
            [abs(value) for value in trace.body_pitch] + [abs(value) for value in trace.body_roll]
        ) if trace.body_pitch else 0.0
        metrics = {
            "survivedSeconds": round(survived, 4),
            "minBaseHeightM": round(min_z, 4),
            "maxTiltRad": round(tilt, 4),
        }
        return EpisodeOutcome(
            success=fell_at is None,
            fall=fell_at is not None,
            collision=any(trace.ground_contact),
            reward=0.0,
            length_seconds=episode_seconds,
            metrics=metrics,
        )


TASKS: dict[str, Task] = {
    BallKickTask.task_id: BallKickTask(),
    VelocityTask.task_id: VelocityTask(),
    BalanceTask.task_id: BalanceTask(),
}
