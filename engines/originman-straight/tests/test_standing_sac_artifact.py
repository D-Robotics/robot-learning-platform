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
from standing_env import StandingGym


@pytest.fixture(scope="module")
def run():
    value = os.environ.get("ORIGINMAN_SAC_SMOKE")
    if not value:
        pytest.skip("requires caller-owned completed SAC smoke artifacts")
    return Path(value)


def test_sac_export_matches_actual_normalized_wrapper(run):
    cfg = Config(**json.loads((run / "training-summary.json").read_text())["config"])
    bridge = StandingGym(run / "model/scene.xml", cfg)
    norm = VecNormalize.load(run / "normalization.pkl", DummyVecEnv([lambda: bridge]))
    norm.training, norm.norm_reward = False, False
    norm.seed(423)
    observation = norm.reset()
    model = sb3.SAC.load(run / "policy.zip", device="cpu")
    exported = ArtifactPolicy(run)
    for _ in range(20):
        action = exported(bridge.physical.observe())
        np.testing.assert_allclose(
            exported.history.reshape(1, -1), observation, atol=1e-7
        )
        expected = model.predict(observation, deterministic=True)[0]
        np.testing.assert_allclose(action, expected[0], atol=1e-6)
        observation, _, _, _ = norm.step(expected)
    norm.close()


def test_sac_initial_log_std_is_actually_initialized(run):
    import torch

    model = sb3.SAC.load(run / "initial/policy.zip", device="cpu")
    with torch.no_grad():
        _, log_std, _ = model.actor.get_action_dist_params(torch.randn(8, 41))
    np.testing.assert_allclose(log_std.numpy(), -2, atol=1e-7)
