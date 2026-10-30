import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

sb3 = pytest.importorskip("stable_baselines3")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from env import Config
from sb3_evaluate import ArtifactPolicy
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize
from standing_linear_env import RollRateGym


@pytest.fixture(scope="module")
def run():
    value = os.environ.get("ORIGINMAN_LINEAR_SMOKE")
    if not value:
        pytest.skip("requires caller-owned completed two-input SAC smoke")
    return Path(value)


def test_two_input_export_matches_wrapper_and_initial_policy_is_zero(run):
    cfg = Config(**json.loads((run / "training-summary.json").read_text())["config"])
    bridge = RollRateGym(run / "model/scene.xml", cfg)
    norm = VecNormalize.load(run / "normalization.pkl", DummyVecEnv([lambda: bridge]))
    norm.training, norm.norm_reward = False, False
    norm.seed(423)
    observation = norm.reset()
    model = sb3.SAC.load(run / "policy.zip", device="cpu")
    exported = ArtifactPolicy(run)
    initial = ArtifactPolicy(run / "initial")
    for _ in range(20):
        obs = bridge.observation()
        assert obs.shape == (2,)
        np.testing.assert_array_equal(initial(obs), [0, 0])
        action = exported(obs)
        expected = model.predict(observation, deterministic=True)[0]
        np.testing.assert_allclose(action, expected[0], atol=1e-6)
        np.testing.assert_array_equal(exported.history.reshape(1, -1), observation)
        observation, _, _, _ = norm.step(expected)
    assert np.linalg.norm(model.actor.mu.weight.detach().numpy()) > 1e-4
    np.testing.assert_array_equal(model.actor.mu.bias.detach().numpy(), [0, 0])
    norm.close()


def test_push_timing_and_force_do_not_enter_minimal_observation(run):
    cfg = Config(**json.loads((run / "training-summary.json").read_text())["config"])
    bridge = RollRateGym(run / "model/scene.xml", cfg)
    a, _ = bridge.reset(seed=9, options={"force": 8, "start": 2})
    b, _ = bridge.reset(seed=9, options={"force": -8, "start": 3})
    np.testing.assert_array_equal(a, b)
