"""High-level football task machine: search -> approach -> align -> kick.

The football engine's 4D action (forward / strafe / turn / kick) was, until
now, only exercised by reward shaping inside the training env — the missing
"task layer" between the trained policy and any demo surface. This module is
that layer as a pure, testable state machine.

Phase geometry follows the upstream-style shooting contract demonstrated in
the Duck Together livestream:

* stand-off point ``p_stage = b - d_stage * d`` behind the ball, with
  ``d = normalize(goal - b)`` — the duck shoots from the goal-facing side;
* hysteresis bands (enter 0.27 m, exit 0.38 m) stop the duck from oscillating
  around the ball when lining up the shot;
* a kick is only released inside the contact window with the duck roughly on
  the ball->goal line, then the machine backs off (RECOVER) before re-approach.

The machine never touches actuators itself: it maps world-state observations
to the same 4D action the training env and platform adapter already speak, so
the browser sim, the board runtime, or a demo runner can drive it without a
new contract.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Sequence

#: Stand-off distance behind the ball for the shooting stance (metres).
STAGE_DISTANCE_M = 0.27
#: Hysteresis band: re-approach beyond this distance once staged (metres).
STAGE_EXIT_M = 0.38
#: Kick is allowed inside this ball distance (metres).
KICK_WINDOW_M = 0.42
#: Kick requires the duck within this angular error of the ball->goal line.
KICK_ALIGN_ERROR_RAD = 0.5


class TaskPhase(Enum):
    SEARCH = "search"
    APPROACH = "approach"
    ALIGN = "align"
    KICK = "kick"
    RECOVER = "recover"


@dataclass
class TaskMachineTelemetry:
    phase: str
    ballDistance: float
    alignError: float
    stepsInPhase: int
    kicks: int
    history: list[str] = field(default_factory=list)


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _normalize(vector: Sequence[float]) -> tuple[float, float]:
    norm = math.hypot(vector[0], vector[1])
    if norm < 1e-9:
        return 0.0, 0.0
    return vector[0] / norm, vector[1] / norm


def _wrap_angle(angle: float) -> float:
    while angle > math.pi:
        angle -= 2.0 * math.pi
    while angle < -math.pi:
        angle += 2.0 * math.pi
    return angle


@dataclass
class FootballTaskMachine:
    """World-state -> 4D action, with the phase machine as the product."""

    goal: tuple[float, float] = (3.0, 0.0)
    phase: TaskPhase = TaskPhase.SEARCH
    steps_in_phase: int = 0
    kicks: int = 0
    _history: list[str] = field(default_factory=list)

    def _switch(self, phase: TaskPhase) -> None:
        if phase is not self.phase:
            self.phase = phase
            self.steps_in_phase = 0
            self._history.append(phase.value)
            if len(self._history) > 64:
                del self._history[:-64]

    def step(self, duck_xy: Sequence[float], duck_heading: float,
             ball_xy: Sequence[float]) -> tuple[tuple[float, float, float, float], TaskMachineTelemetry]:
        """One decision tick. Returns ((forward, strafe, turn, kick), telemetry)."""
        duck = (float(duck_xy[0]), float(duck_xy[1]))
        ball = (float(ball_xy[0]), float(ball_xy[1]))
        ball_distance = math.hypot(ball[0] - duck[0], ball[1] - duck[1])
        goal_dir = _normalize((self.goal[0] - ball[0], self.goal[1] - ball[1]))
        stage = (ball[0] - goal_dir[0] * STAGE_DISTANCE_M, ball[1] - goal_dir[1] * STAGE_DISTANCE_M)
        to_stage = _normalize((stage[0] - duck[0], stage[1] - duck[1]))
        heading_error = _wrap_angle(math.atan2(to_stage[1], to_stage[0]) - duck_heading)
        # Alignment error: how far the duck's heading points off the shot line.
        shot_line = math.atan2(goal_dir[1], goal_dir[0])
        align_error = abs(_wrap_angle(shot_line - duck_heading))

        forward = strafe = turn = 0.0
        kick = 0.0

        if self.phase is TaskPhase.SEARCH:
            turn = _clamp(heading_error * 2.0)
            forward = 0.4 if ball_distance > 1.5 else 0.0
            self._switch(TaskPhase.APPROACH)
        elif self.phase is TaskPhase.APPROACH:
            turn = _clamp(heading_error * 2.0)
            forward = _clamp(ball_distance * 1.6)
            if ball_distance <= STAGE_DISTANCE_M + 0.06:
                self._switch(TaskPhase.ALIGN)
        elif self.phase is TaskPhase.ALIGN:
            strafe = _clamp(-heading_error * 1.5)
            forward = _clamp((ball_distance - STAGE_DISTANCE_M) * 1.2)
            if ball_distance > STAGE_EXIT_M:
                # Hysteresis: lost the stance; go back to approach.
                self._switch(TaskPhase.APPROACH)
            elif align_error <= KICK_ALIGN_ERROR_RAD and ball_distance <= KICK_WINDOW_M:
                # Fire on the transition: the stance is confirmed, the window
                # is open — waiting one more tick would drift out of it.
                kick = 1.0
                self.kicks += 1
                self._switch(TaskPhase.RECOVER)
        elif self.phase is TaskPhase.KICK:
            kick = 1.0 if align_error <= KICK_ALIGN_ERROR_RAD and ball_distance <= KICK_WINDOW_M else 0.0
            if kick > 0.0:
                self.kicks += 1
            self._switch(TaskPhase.RECOVER)
        elif self.phase is TaskPhase.RECOVER:
            # Back off along the shot line so the next stance starts clean.
            forward = -0.5
            strafe = _clamp(-heading_error * 1.0)
            if ball_distance > STAGE_EXIT_M:
                self._switch(TaskPhase.APPROACH)

        self.steps_in_phase += 1
        telemetry = TaskMachineTelemetry(
            phase=self.phase.value,
            ballDistance=round(ball_distance, 4),
            alignError=round(align_error, 4),
            stepsInPhase=self.steps_in_phase,
            kicks=self.kicks,
            history=list(self._history),
        )
        return (_clamp(forward), _clamp(strafe), _clamp(turn), kick), telemetry


def run_scripted_trace(env, machine: FootballTaskMachine | None = None, max_steps: int = 300) -> dict:
    """Drive the football env with the machine and return the phase trace.

    Demo/verification runner: the env is the same single-goal-kick world the
    trainer uses, so a passing trace is direct evidence that the task layer
    and the training env speak the same 4D contract.
    """
    from football_env import GOAL_X

    machine = machine or FootballTaskMachine(goal=(GOAL_X, 0.0))
    observation = env.reset(seed=20260920)
    phases: list[str] = []
    kicks = 0
    goals = 0
    for _ in range(max_steps):
        duck = env._duck_xy(0)
        heading = 0.0  # spherical proxy has no heading; the machine steers by stage geometry
        action, telemetry = machine.step(duck, heading, env._ball_xy())
        observation, _rewards, done, info = env.step(action)
        phases.append(telemetry.phase)
        kicks = telemetry.kicks
        if info.get("goal"):
            goals += 1
        if done:
            break
    return {
        "steps": len(phases),
        "phasesVisited": sorted(set(phases)),
        "kicks": kicks,
        "goals": goals,
        "finalPhase": phases[-1] if phases else None,
    }
