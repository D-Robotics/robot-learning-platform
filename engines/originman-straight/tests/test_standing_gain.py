import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

sb3 = pytest.importorskip("stable_baselines3")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from standing_gain_rl import score


def test_falling_never_scores_as_a_recovered_controller():
    assert score({"fallen": True, "seconds": 6}) < 0
    assert (
        score(
            {
                "fallen": False,
                "settledFraction": 1,
                "recoverySuccess": True,
                "peakTiltDegrees": 10,
                "finalAngularSpeed": 0.05,
            }
        )
        > 9
    )


def test_saved_gains_are_actually_the_learned_ppo_action_and_start_at_zero():
    value = os.environ.get("ORIGINMAN_GAIN_SMOKE")
    if not value:
        pytest.skip("requires caller-owned gain-PPO smoke")
    run = Path(value)
    before = sb3.PPO.load(run / "initial-policy.zip", device="cpu")
    after = sb3.PPO.load(run / "policy.zip", device="cpu")
    initial = before.predict(np.ones(1, dtype=np.float32), deterministic=True)[0]
    final = after.predict(np.ones(1, dtype=np.float32), deterministic=True)[0]
    np.testing.assert_array_equal(initial, [0, 0])
    coefficients = json.loads((run / "gains.json").read_text())["coefficients"]
    np.testing.assert_allclose(
        np.asarray(coefficients[:2]), final * [3, 0.6], atol=1e-7
    )
    assert coefficients[2:] == [0, 0]
    assert np.linalg.norm(final) > 1e-4
