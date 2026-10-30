"""Exported history preprocessing must match SB3's actual vector wrappers."""

import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sb3 = pytest.importorskip("stable_baselines3")
from env import Config
from gym_bridge import OriginManGym
from sb3_evaluate import ArtifactPolicy
from stable_baselines3.common.vec_env import DummyVecEnv, VecFrameStack, VecNormalize


@pytest.mark.parametrize("mode", ["joints", "feet"])
def test_exported_history_matches_actual_sb3_wrappers(mode):
    root = os.environ.get("ORIGINMAN_SB3_SMOKES")
    if not root:
        pytest.skip("requires caller-owned completed SB3 smoke artifacts")
    run = Path(root) / f"sb3-smoke-{mode}"
    summary = json.loads((run / "training-summary.json").read_text())
    bridge = OriginManGym(
        run / "model/scene.xml", Config(**summary["config"]), mode=mode
    )
    vector = DummyVecEnv([lambda: bridge])
    norm = VecNormalize.load(run / "normalization.pkl", vector)
    norm.training = False
    norm.norm_reward = False
    stacked = VecFrameStack(norm, n_stack=4)
    stacked.seed(423)
    observation = stacked.reset()
    model = sb3.PPO.load(run / "policy.zip", device="cpu")
    exported = ArtifactPolicy(run)
    for _ in range(20):
        action = exported(bridge.physical.observe())
        np.testing.assert_allclose(
            exported.history.reshape(1, -1), observation, atol=1e-7
        )
        expected = model.predict(observation, deterministic=True)[0]
        np.testing.assert_allclose(action, expected[0], atol=1e-6)
        observation, _, _, _ = stacked.step(expected)
    stacked.close()
