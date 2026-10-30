import os
import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("gymnasium")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from env import Config
from residual_env import CONTROLLER, ResidualStandingGym
from standing_env import StandingGym, feedback


@pytest.fixture(scope="module")
def scene():
    value = os.environ.get("ORIGINMAN_SCENE")
    if not value:
        pytest.skip("caller-owned model required")
    return value


def test_zero_correction_preserves_full_baseline_physics_exactly(scene):
    cfg = Config(stride=0, lift=0, sway=0, episode_seconds=6, residual_scale=0.3)
    base = StandingGym(scene, cfg)
    learned = ResidualStandingGym(scene, cfg)
    base.reset(seed=100, options={"force": 6.95, "start": 1.65})
    learned.reset(seed=100, options={"force": 6.95, "start": 1.65})
    for _ in range(300):
        _, _, done, timeout, _a = base.step(feedback(base, CONTROLLER["baselineGains"]))
        _, _, b_done, b_timeout, _b = learned.step(np.zeros(2))
        np.testing.assert_array_equal(
            base.physical.data.qpos, learned.physical.data.qpos
        )
        np.testing.assert_array_equal(
            base.physical.data.ctrl, learned.physical.data.ctrl
        )
        assert (done, timeout) == (b_done, b_timeout)
        if done or timeout:
            break


def test_actor_has_no_force_clock_or_world_position_and_baseline_is_frozen(scene):
    cfg = Config(stride=0, lift=0, sway=0, residual_scale=0.3)
    e = ResidualStandingGym(scene, cfg)
    a, _ = e.reset(seed=1, options={"force": 8, "start": 2})
    b, _ = e.reset(seed=1, options={"force": -8, "start": 3})
    np.testing.assert_array_equal(a, b)
    assert a.shape == (14,)
    original = e.gains.copy()
    _, _, _, _, info = e.step(np.array([1.0, -1.0]))
    np.testing.assert_array_equal(e.gains, original)
    np.testing.assert_allclose(info["learningCorrectionRadians"], [0.12, -0.2])
    assert np.max(abs(e.physical.last_action)) <= 1


def test_saturated_request_is_not_logged_as_an_effective_rl_action(scene):
    import mujoco

    cfg = Config(stride=0, lift=0, sway=0, residual_scale=0.3)
    e = ResidualStandingGym(scene, cfg)
    e.reset(seed=1, options={"force": 0, "start": 2})
    e.physical.data.qpos[3:7] = [np.cos(0.15), np.sin(0.15), 0, 0]
    mujoco.mj_forward(e.physical.model, e.physical.data)
    _, _, _, _, info = e.step(np.array([1.0, 0.0]))
    assert info["learningCorrectionRadians"][0] > 0.1
    assert info["executedExtraTargetRadians"][0] == pytest.approx(0)


def test_exported_residual_policy_matches_training_wrapper_and_initial_is_zero():
    import json

    import stable_baselines3 as sb3
    from sb3_evaluate import ArtifactPolicy
    from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize

    value = os.environ.get("ORIGINMAN_RESIDUAL_SMOKE")
    if not value:
        pytest.skip("requires caller-owned residual smoke artifacts")
    run = Path(value)
    cfg = Config(**json.loads((run / "training-summary.json").read_text())["config"])
    bridge = ResidualStandingGym(run / "model/scene.xml", cfg)
    norm = VecNormalize.load(run / "normalization.pkl", DummyVecEnv([lambda: bridge]))
    norm.training, norm.norm_reward = False, False
    norm.seed(423)
    obs = norm.reset()
    model = sb3.SAC.load(run / "policy.zip", device="cpu")
    exported = ArtifactPolicy(run)
    initial = ArtifactPolicy(run / "initial")
    for _ in range(20):
        raw = bridge.observation()
        action = exported(raw)
        np.testing.assert_array_equal(initial(raw), [0, 0])
        np.testing.assert_array_equal(exported.history.reshape(1, -1), obs)
        expected = model.predict(obs, deterministic=True)[0]
        np.testing.assert_allclose(action, expected[0], atol=1e-6)
        obs, _, _, _ = norm.step(expected)
    norm.close()


def test_final_policy_decisions_are_replayable_from_recorded_inputs():
    import json

    from sb3_evaluate import ArtifactPolicy

    run = os.environ.get("ORIGINMAN_RESIDUAL_RUN")
    evaluation = os.environ.get("ORIGINMAN_RESIDUAL_EVAL")
    if not run or not evaluation:
        pytest.skip("requires caller-owned frozen residual run and evaluation")
    row = None
    with (Path(evaluation) / "episodes.jsonl").open() as stream:
        for line in stream:
            candidate = json.loads(line)
            if candidate["controller"] == "rl":
                row = candidate
                break
    assert row is not None
    policy = ArtifactPolicy(Path(run))
    decisions = row["decisions"]
    assert len(decisions) == round(row["seconds"] / 0.02)
    np.testing.assert_allclose(
        np.diff([d["timeBefore"] for d in decisions]), 0.02, atol=1e-10
    )
    start = round(row["start"] / 0.02)
    chosen = sorted(
        {
            0,
            min(start, len(decisions) - 1),
            min(start + 5, len(decisions) - 1),
            len(decisions) - 1,
        }
    )
    for index in chosen:
        decision = decisions[index]
        assert decision["policyEvaluated"] and len(decision["policyInput"]) == 14
        actual = policy(np.asarray(decision["policyInput"], dtype=np.float32))
        np.testing.assert_allclose(actual, decision["actorOutput"], atol=2e-6)
    assert json.loads((Path(evaluation) / "summary.json").read_text())[
        "initialPolicyMatchesBaselineExactly"
    ]
