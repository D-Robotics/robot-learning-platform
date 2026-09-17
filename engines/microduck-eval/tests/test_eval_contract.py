"""Pure-logic tests: no MuJoCo, no ONNX, no GPU.

These lock in the two things that must never drift: the confidence-interval
semantics the platform gate recomputes, and the task success rules.
"""

from __future__ import annotations

import math
from dataclasses import replace

import numpy as np
import pytest

from microduck_eval.envelope import (
    ENDURANCE,
    HARD,
    NOMINAL,
    CommandProfile,
    EvalEnvelope,
    InitialState,
)
from microduck_eval.metrics import (
    EnvelopeResult,
    EpisodeResult,
    harness_qualification,
)
from microduck_eval.tasks import (
    BalanceTask,
    BallKickTask,
    EpisodeOutcome,
    EpisodeTrace,
    VelocityTask,
)
from microduck_eval.wilson import wilson_bounds

#: Reference values recomputed from the platform's own formula
#: (``engines/starter-ppo/runner.py::wilson_bounds`` with ``WILSON_Z[0.95]``).
PLATFORM_REFERENCE = {
    (0, 50): (0.0, 0.0713),
    (35, 50): (0.5625, 0.8090),
    (50, 50): (0.9287, 1.0),
    (1, 100): (0.0018, 0.0545),
}


def _platform_wilson(successes: int, total: int, z: float = 1.959963984540054):
    p = successes / total
    denom = 1.0 + z * z / total
    centre = (p + z * z / (2.0 * total)) / denom
    spread = z * math.sqrt(p * (1.0 - p) / total + z * z / (4.0 * total * total)) / denom
    return centre - spread, centre + spread


@pytest.mark.parametrize("case,expected", PLATFORM_REFERENCE.items())
def test_wilson_matches_platform_formula(case, expected):
    bounds = wilson_bounds(*case)
    assert bounds is not None
    assert bounds == pytest.approx(expected, abs=5e-5)


@pytest.mark.parametrize("case", sorted(PLATFORM_REFERENCE))
def test_wilson_matches_platform_within_rounding(case):
    mine = wilson_bounds(*case)
    theirs = _platform_wilson(*case)
    assert mine is not None
    assert round(mine[0], 4) == round(theirs[0], 4)
    assert round(mine[1], 4) == round(theirs[1], 4)


def test_no_episodes_is_not_evidence():
    """Zero episodes must not be readable as 0% or 100%."""
    assert wilson_bounds(0, 0) is None


def test_impossible_counts_are_rejected():
    with pytest.raises(ValueError):
        wilson_bounds(3, 2)
    with pytest.raises(ValueError):
        wilson_bounds(-1, 2)


def test_envelope_without_episodes_reports_insufficient_evidence():
    result = EnvelopeResult(envelope=NOMINAL)
    metrics = result.as_metrics()
    assert metrics["insufficientEvidence"] is True
    assert "successRate" not in metrics


def test_rates_come_from_episode_outcomes():
    result = EnvelopeResult(envelope=NOMINAL)
    for index, success in enumerate([True, True, False, True]):
        result.episodes.append(
            EpisodeResult(
                index=index,
                seed=index,
                outcome=EpisodeOutcome(
                    success=success,
                    fall=not success,
                    collision=False,
                    reward=1.0,
                    length_seconds=4.0,
                    metrics={"ballTravelM": 0.5 if success else 0.1},
                ),
            )
        )
    metrics = result.as_metrics()
    assert metrics["episodes"] == 4
    assert metrics["successRate"] == 0.75
    assert metrics["fallRate"] == 0.25
    assert metrics["collisionRate"] == 0.0
    assert metrics["meanReward"] == 1.0
    # Wilson, not the normal approximation: the lower bound of 3/4 with n=4 is 0.30.
    assert metrics["successRateCiLow"] == pytest.approx(0.3006, abs=1e-3)


def _trace(*, base_z, base_x, ball_x, pitch=0.0, dt=0.02):
    steps = len(base_z)
    trace = EpisodeTrace(dt=dt)
    for step in range(steps):
        trace.base_z.append(base_z[step])
        trace.base_xy.append((base_x[step], 0.0))
        trace.body_pitch.append(pitch)
        trace.body_roll.append(0.0)
        trace.ball_xy.append((ball_x[step], 0.0))
        trace.ball_z.append(0.035)
        trace.ground_contact.append(False)
    return trace


def test_ball_kick_success_requires_travel_speed_and_balance():
    task = BallKickTask()
    upright = [0.118] * 200
    forward = [0.0] * 60 + [0.05 * index for index in range(140)]
    base_x = [0.0] * 200

    kicked = _trace(base_z=upright, base_x=base_x, ball_x=forward)
    assert task.judge(kicked, NOMINAL).success is True

    # Same ball motion, but the duck ends up on the floor: not a successful kick.
    fallen = [0.118] * 100 + [0.03] * 100
    assert task.judge(_trace(base_z=fallen, base_x=base_x, ball_x=forward), NOMINAL).success is False

    # Nudged 5 cm and never accelerated: travel threshold not met.
    nudged = _trace(base_z=upright, base_x=base_x, ball_x=[0.0] * 195 + [0.05] * 5)
    assert task.judge(nudged, NOMINAL).success is False


def test_ball_kick_reports_physical_measurements():
    trace = _trace(
        base_z=[0.118] * 200,
        base_x=[0.0] * 200,
        ball_x=[0.0] * 60 + [0.01 * index for index in range(140)],
    )
    outcome = BallKickTask().judge(trace, NOMINAL)
    assert outcome.metrics["ballTravelM"] == pytest.approx(1.39, abs=1e-6)
    assert outcome.metrics["ballForwardM"] == pytest.approx(1.39, abs=1e-6)
    assert outcome.metrics["ballPeakSpeedMps"] == pytest.approx(0.5, abs=1e-6)


def test_velocity_task_tracks_the_command():
    task = VelocityTask()
    commanded = replace(NOMINAL, command=CommandProfile(lin_vel_x=0.4, lin_vel_y=0.0))
    # 0.4 m/s at 50 Hz = 8 mm per step.
    base_x = [0.008 * index for index in range(200)]
    trace = _trace(base_z=[0.118] * 200, base_x=base_x, ball_x=[0.0] * 200)
    assert task.judge(trace, commanded).success is True

    still = _trace(base_z=[0.118] * 200, base_x=[0.0] * 200, ball_x=[0.0] * 200)
    outcome = task.judge(still, commanded)
    assert outcome.success is False
    assert outcome.metrics["speedTrackingErrorMps"] == pytest.approx(0.4, abs=1e-6)


def test_envelopes_are_pinned_and_distinct():
    assert NOMINAL.seed != HARD.seed
    assert NOMINAL.initial_state.ball_distance is not None
    assert HARD.payload_fraction > 0
    assert HARD.gyro_noise_std > 0


def _baseline_envelope(name: str, falls: int, episodes: int) -> EnvelopeResult:
    result = EnvelopeResult(envelope=replace(NOMINAL, name=name))
    for index in range(episodes):
        fell = index < falls
        result.episodes.append(
            EpisodeResult(
                index=index,
                seed=index,
                outcome=EpisodeOutcome(
                    success=False,
                    fall=fell,
                    collision=fell,
                    reward=0.0,
                    length_seconds=4.0,
                    metrics={"minBaseHeightM": 0.03 if fell else 0.118},
                ),
            )
        )
    return result


def test_harness_is_unqualified_when_the_zero_action_baseline_always_falls():
    qualification = harness_qualification([_baseline_envelope("nominal", 10, 10)])
    assert qualification["passed"] is False
    assert "cannot hold the robot up" in qualification["reasons"][0]
    assert qualification["envelopes"]["nominal"]["baselineFallRate"] == 1.0


def test_harness_qualifies_when_the_zero_action_baseline_stands():
    qualification = harness_qualification([_baseline_envelope("nominal", 2, 10)])
    assert qualification["passed"] is True
    assert qualification["reasons"] == []


def test_missing_baseline_is_unqualified():
    qualification = harness_qualification([])
    assert qualification["passed"] is False
    assert "unqualified" in qualification["reasons"][0]


# ---- balance task & endurance envelope --------------------------------------


def test_balance_task_survival_is_the_criterion():
    task = BalanceTask()
    upright = _trace(base_z=[0.118] * 300, base_x=[0.0] * 300, ball_x=[0.0] * 300)
    outcome = task.judge(upright, ENDURANCE)
    assert outcome.success is True
    assert outcome.fall is False
    assert outcome.metrics["survivedSeconds"] == pytest.approx(6.0, abs=1e-9)

    # Falls at step 100 of 300: survived 2 s, not the full episode.
    fell = _trace(
        base_z=[0.118] * 100 + [0.03] * 200,
        base_x=[0.0] * 300,
        ball_x=[0.0] * 300,
    )
    outcome = task.judge(fell, ENDURANCE)
    assert outcome.success is False
    assert outcome.fall is True
    assert outcome.metrics["survivedSeconds"] == pytest.approx(2.0, abs=1e-9)
    assert outcome.metrics["minBaseHeightM"] == pytest.approx(0.03, abs=1e-9)


def test_balance_task_tilt_counts_as_a_fall():
    task = BalanceTask()
    trace = _trace(base_z=[0.118] * 300, base_x=[0.0] * 300, ball_x=[0.0] * 300,
                   pitch=1.2)
    assert task.judge(trace, ENDURANCE).fall is True


def test_endurance_envelope_is_pinned():
    assert ENDURANCE.name == "endurance"
    assert ENDURANCE.episode_seconds == 60.0
    assert ENDURANCE.seed != NOMINAL.seed and ENDURANCE.seed != HARD.seed
    # Duration is the stress: disturbances stay at nominal level, no ball.
    assert ENDURANCE.command_dropout == 0.0
    assert ENDURANCE.gyro_noise_std == 0.0
    assert ENDURANCE.payload_fraction == 0.0
    assert ENDURANCE.initial_state.ball_distance is None


def test_rollout_resets_policy_state_each_episode():
    """The episode-scoped recurrent state must not leak across episodes.

    Uses the real rollout() with a fake sim: the only property rollout needs
    from the sim is the attribute surface MicroDuckSim exposes.
    """
    from microduck_eval.sim import rollout

    class FakeSim:
        step_dt = 0.02
        ball_qpos = None
        spec = None

        def reset(self, *, base_xy, base_yaw, ball_distance, payload_fraction):
            pass

        def observation(self, command, last_action):
            return np.zeros(61, dtype=np.float32)

        def apply_action(self, action):
            pass

        def advance(self):
            pass

        def base_xy(self):
            return 0.0, 0.0

        def base_z(self):
            return 0.118

        def body_tilt(self):
            return 0.0, 0.0

        def trunk_ground_contact(self):
            return False

    class CountingPolicy:
        def __init__(self):
            self.act_calls = 0
            self.reset_calls = 0

        def act(self, observation):
            self.act_calls += 1
            return np.zeros(14, dtype=np.float32)

        def reset(self):
            self.reset_calls += 1

    envelope = replace(NOMINAL, episodes=2, episode_seconds=0.02, name="reset-probe")
    policy = CountingPolicy()
    for episode_index in range(envelope.episodes):
        rollout(FakeSim(), policy, envelope, np.zeros(13, dtype=np.float32),
                episode_index=episode_index)
    # One reset per episode: the second episode must start from zeroed state,
    # not the history the first episode left behind.
    assert policy.reset_calls == envelope.episodes
    assert policy.act_calls == envelope.episodes


def _trained_envelope(name: str, successes: int, falls: int, episodes: int) -> EnvelopeResult:
    result = EnvelopeResult(envelope=replace(NOMINAL, name=name))
    for index in range(episodes):
        won = index < successes
        fell = index < falls
        result.episodes.append(
            EpisodeResult(
                index=index,
                seed=index,
                outcome=EpisodeOutcome(
                    success=won,
                    fall=fell,
                    collision=fell,
                    reward=0.0,
                    length_seconds=4.0,
                    metrics={"minBaseHeightM": 0.03 if fell else 0.118},
                ),
            )
        )
    return result


def test_a_trusted_policy_that_always_fails_disqualifies_the_harness():
    """A real training artifact beaten by "hold still" means the harness is wrong."""
    qualification = harness_qualification(
        [_baseline_envelope("nominal", 0, 10)],
        [_trained_envelope("nominal", successes=0, falls=10, episodes=10)],
    )
    assert qualification["passed"] is False
    assert "cannot currently judge learned policies" in qualification["reasons"][0]
    assert qualification["envelopes"]["nominal"]["trainedFallRate"] == 1.0


def test_a_trusted_policy_that_sometimes_succeeds_keeps_the_harness_qualified():
    qualification = harness_qualification(
        [_baseline_envelope("nominal", 0, 10)],
        [_trained_envelope("nominal", successes=6, falls=4, episodes=10)],
    )
    assert qualification["passed"] is True


def test_the_untrained_smoke_policy_is_not_treated_as_trusted():
    """Without --trusted-policy the check stays off: a smoke checkpoint failing is expected."""
    qualification = harness_qualification([_baseline_envelope("nominal", 0, 10)])
    assert qualification["passed"] is True
