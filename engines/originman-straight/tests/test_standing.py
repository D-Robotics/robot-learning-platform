import os
import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("gymnasium")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from env import Config
from standing_env import StandingGym, episode


@pytest.fixture(scope="module")
def bridge():
    scene = os.environ.get("ORIGINMAN_SCENE")
    if not scene:
        pytest.skip("caller-owned adapted OriginMan scene required")
    return StandingGym(scene, Config(stride=0, lift=0, sway=0, episode_seconds=6))


def test_reference_is_static_and_roll_actions_use_physical_joint_axes(bridge):
    env = bridge.physical
    np.testing.assert_allclose(np.ptp(env.reference, axis=0), 0, atol=1e-12)
    residual = bridge.modes.residual([0.2, -0.3])
    for i in [4, 9]:
        assert residual[i] * env.model.jnt_axis[env.leg_j[i], 0] == pytest.approx(0.2)
    for i in [0, 5]:
        assert residual[i] * env.model.jnt_axis[env.leg_j[i], 0] == pytest.approx(-0.3)
    np.testing.assert_allclose(residual[[1, 2, 3, 6, 7, 8]], 0)


def test_passive_survival_is_not_counted_as_rl_and_strong_push_falls(bridge):
    zero = lambda obs: np.zeros(2)
    no_push = episode(bridge, {"force": 0, "start": 2}, zero)
    assert no_push["recoverySuccess"] and not no_push["fallen"]
    strong = episode(bridge, {"force": 8, "start": 2}, zero)
    assert strong["fallen"] and not strong["recoverySuccess"]


def test_fixed_force_is_not_in_actor_observation(bridge):
    a, _ = bridge.reset(seed=8, options={"force": 8, "start": 2})
    b, _ = bridge.reset(seed=8, options={"force": -8, "start": 3})
    np.testing.assert_array_equal(a, b)
    assert a.shape == (41,)


def test_recovery_needs_full_final_settled_window(bridge):
    bridge.reset(seed=8, options={"force": 0, "start": 2})
    for _ in range(50):
        _, _, _, _, info = bridge.step(np.zeros(2))
    assert not info["recoverySuccess"]  # stable early in episode is not final recovery


@pytest.mark.parametrize("force", [0, 8])
def test_trace_contains_actual_terminal_time_and_pose(bridge, force):
    row = episode(
        bridge, {"force": force, "start": 2}, lambda obs: np.zeros(2), trace=True
    )
    assert row["frames"][-1]["time"] == row["seconds"]
    np.testing.assert_array_equal(row["frames"][-1]["qpos"], bridge.physical.data.qpos)
