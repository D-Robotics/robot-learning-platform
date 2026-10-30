import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from env import Config
from feedback_benchmark import actor, candidates, conventional_action, feedback_features, score
from residual_env import CONTROLLER, ResidualStandingGym
from standing_env import StandingGym, feedback


def test_feedback_is_explicit_si_linear_law_with_equal_amplitude_limit():
    features = np.array([.1, .2, .03, .04, .05, .06])
    gains = [2, .1, -2, .2, -.5, -.1, -.6, -.2]
    np.testing.assert_allclose(conventional_action(features, gains, .3), [(.2+.02-.015-.004)/.3, (-.2+.04-.03-.012)/.3])
    np.testing.assert_array_equal(conventional_action(features*100, gains, .3), [1, -1])
    with pytest.raises(ValueError):
        conventional_action(features, [np.nan]*8, .3)


def test_search_has_hip_authority_and_retains_original_baseline():
    rows = candidates()
    assert len(rows) == 189
    assert rows[0]["coefficients"][:4] == CONTROLLER["baselineGains"]
    assert any(r["coefficients"][2] < 0 for r in rows)
    assert any(r["coefficients"][2] > 0 for r in rows)


def test_selection_prioritizes_no_force_retention_over_other_recovery():
    def row(force, success):
        return {"force": force, "recoverySuccess": success, "fallen": False, "settledFraction": float(success), "peakTiltDegrees": 1., "finalTiltDegrees": 1.}
    assert score([row(0, True), row(7, False)]) > score([row(0, False), row(7, True)])


def test_original_controller_matches_rl_zero_and_sensors_have_no_push_schedule():
    scene = os.environ.get("ORIGINMAN_SCENE")
    if not scene:
        pytest.skip("caller-owned scene required")
    cfg = Config(stride=0, lift=0, sway=0, episode_seconds=6, residual_scale=.3)
    base, rl = StandingGym(scene, cfg), ResidualStandingGym(scene, cfg)
    gains = [*CONTROLLER["baselineGains"], 0, 0, 0, 0]
    base.reset(seed=100, options={"force": 7.2, "start": 1.7})
    features = feedback_features(base)
    base.reset(seed=100, options={"force": -7.8, "start": 3.5})
    np.testing.assert_array_equal(features, feedback_features(base))
    base.reset(seed=100, options={"force": 7.2, "start": 1.7})
    rl.reset(seed=100, options={"force": 7.2, "start": 1.7})
    for _ in range(300):
        request = actor(base, gains)(None)
        np.testing.assert_array_equal(request, feedback(base, CONTROLLER["baselineGains"]))
        _, _, done, timeout, _ = base.step(request)
        _, _, rdone, rtimeout, _ = rl.step(np.zeros(2))
        np.testing.assert_array_equal(base.physical.data.qpos, rl.physical.data.qpos)
        np.testing.assert_array_equal(base.physical.data.ctrl, rl.physical.data.ctrl)
        assert (done, timeout) == (rdone, rtimeout)
        if done or timeout:
            break
