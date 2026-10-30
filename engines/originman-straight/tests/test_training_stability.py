"""Integration check for reward scaling and policy-update bounds."""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from env import Config
from monitor import LearnerConfig
from train import train


@pytest.mark.parametrize("architecture", ["shared", "separate"])
def test_scaled_critic_keeps_raw_reward_and_stops_large_policy_updates(
    tmp_path, architecture
):
    scene = os.environ.get("ORIGINMAN_SCENE")
    if not scene:
        pytest.skip("ORIGINMAN_SCENE must name caller-owned adapted robot scene")
    result = train(
        scene,
        tmp_path / "run",
        iterations=2,
        num_envs=2,
        steps=16,
        learner=LearnerConfig(
            value_network=architecture,
            reward_scale=0.01,
            target_kl=0.000001,
            learning_rate=0.001,
            minibatch=16,
            checkpoint_every=2,
            trace_every=2,
        ),
    )
    points = [
        json.loads(s)
        for s in (tmp_path / "run/telemetry.jsonl").read_text().splitlines()
    ]
    assert len(points) == 2
    for point in points:
        assert point["meanLearningReward"] == pytest.approx(
            point["meanReward"] * 0.01, rel=1e-5
        )
        assert point["klEarlyStopped"]
        assert 1 <= point["optimizerUpdates"] < 8
    assert not result["sourceChangedDuringRun"]
    assert result["onnxParityMaxAbsError"] < 1e-5


def test_inactive_recovery_does_not_train_actor_on_unexecuted_actions(tmp_path):
    scene = os.environ.get("ORIGINMAN_SCENE")
    if not scene:
        pytest.skip("ORIGINMAN_SCENE must name caller-owned adapted robot scene")
    train(
        scene,
        tmp_path / "inactive",
        iterations=2,
        num_envs=2,
        steps=16,
        config=Config(recovery_roll_threshold=0.13),
        learner=LearnerConfig(
            value_network="separate",
            reward_scale=0.01,
            reset_asymmetry_range=0,
            reset_yaw_range=0,
        ),
    )
    points = [
        json.loads(line)
        for line in (tmp_path / "inactive/telemetry.jsonl").read_text().splitlines()
    ]
    assert all(p["actorEnabledFraction"] == 0 and p["actorLoss"] == 0 for p in points)
    import numpy as np
    import onnxruntime as ort

    session = ort.InferenceSession(
        str(tmp_path / "inactive/policy.onnx"), providers=["CPUExecutionProvider"]
    )
    np.testing.assert_allclose(
        session.run(None, {"obs": np.ones((4, 41), dtype=np.float32)})[0], 0, atol=0
    )
