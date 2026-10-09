"""Behavioural suite for the recurrent trainer and its exported graph.

The heavyweight assertion is the last one: the artifact this engine produces
must load through ``microduck_eval.policy.load_policy`` — the same loader the
evaluation harness uses — as a recurrent policy whose state carries and whose
``reset()`` matches a hand-fed onnxruntime loop.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]
ENGINES_DIR = ENGINE_DIR.parent
for entry in (str(ENGINE_DIR), str(ENGINES_DIR / "microduck-eval")):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import mujoco  # noqa: E402
import onnxruntime as ort  # noqa: E402

from balance_env import (  # noqa: E402
    ACTION_SIZE,
    COMMAND_SIZE,
    OBSERVATION_SIZE,
    BalanceBatch,
    BasketballBalanceEnv,
)
from train_recurrent import RecurrentActorCritic, export_onnx, train  # noqa: E402


def test_observation_and_action_contract():
    env = BasketballBalanceEnv()
    obs = env.reset(seed=3)
    assert obs.shape == (OBSERVATION_SIZE,)
    assert obs.dtype == np.float32
    assert np.all(np.isfinite(obs))
    step_obs, reward, done, info = env.step(np.zeros(ACTION_SIZE))
    assert step_obs.shape == (OBSERVATION_SIZE,)
    assert ACTION_SIZE == 14 and OBSERVATION_SIZE == 61 and COMMAND_SIZE == 13
    assert np.isfinite(float(reward))
    assert {"tilt", "fallen", "rolledAway"} <= set(info)


def test_tilt_past_fall_radius_terminates():
    env = BasketballBalanceEnv()
    env.reset(seed=5)
    half = np.pi / 4
    # Tip the duck 90 degrees about x directly in the joint state.
    env.data.qpos[env.tilt_qpos : env.tilt_qpos + 4] = (np.cos(half), np.sin(half), 0.0, 0.0)
    mujoco.mj_forward(env.model, env.data)
    _, _, done, info = env.step(np.zeros(ACTION_SIZE))
    assert done and info["fallen"]


def test_batch_shapes_and_auto_reset():
    batch = BalanceBatch(2, seed=11, episode_seconds=2.0)
    obs = batch.reset()
    assert obs.shape == (2, OBSERVATION_SIZE)
    # 2 s at 50 Hz with an initial shove must trip at least one reset in some
    # seeds; here we only assert the batch stays consistent either way.
    for _ in range(10):
        obs, rewards, dones, _ = batch.step(np.zeros((2, ACTION_SIZE)))
        assert obs.shape == (2, OBSERVATION_SIZE)
        assert rewards.shape == (2,)
        assert len(dones) == 2


def test_stilts_variant_contract_and_mass_formula():
    from balance_env import BalanceBatch as _B  # noqa: F401
    from balance_env import BalanceConfig, _stilt_mass_per_rod

    assert _stilt_mass_per_rod(25.0) == 0.012 + 0.001 * 25.0
    env = BasketballBalanceEnv(BalanceConfig(stilts=True, stilts_height_cm=25.0))
    obs = env.reset(seed=19)
    assert obs.shape == (OBSERVATION_SIZE,)
    assert env.ball_qpos is None, "stilt scene has no rolling ball"
    assert np.all(np.isfinite(obs))
    step_obs, reward, done, info = env.step(np.zeros(ACTION_SIZE))
    assert step_obs.shape == (OBSERVATION_SIZE,) and np.isfinite(float(reward))
    batch = BalanceBatch(2, seed=23, episode_seconds=2.0, stilts=True, stilts_height_cm=25.0)
    batch_obs = batch.reset()
    assert batch_obs.shape == (2, OBSERVATION_SIZE)
    batch_obs, _, dones, _ = batch.step(np.zeros((2, ACTION_SIZE)))
    assert batch_obs.shape == (2, OBSERVATION_SIZE) and len(dones) == 2


def test_swing_env_contract_and_commanded_direction():
    from swing_env import SwingBatch, SwingConfig, SwingPumpEnv

    env = SwingPumpEnv(SwingConfig(episode_seconds=4.0))
    obs = env.reset(seed=29)
    assert obs.shape == (OBSERVATION_SIZE,) and np.all(np.isfinite(obs))
    assert env.command[0] in (-1.0, 1.0), "pump direction must be a ±1 command"
    step_obs, reward, done, info = env.step(np.zeros(ACTION_SIZE))
    assert step_obs.shape == (OBSERVATION_SIZE,)
    assert {"tilt", "fallen", "swingAngle", "wrapped"} <= set(info)
    assert np.isfinite(float(reward))
    batch = SwingBatch(2, seed=31, episode_seconds=2.0)
    batch_obs = batch.reset()
    batch_obs, rewards, dones, _ = batch.step(np.zeros((2, ACTION_SIZE)))
    assert batch_obs.shape == (2, OBSERVATION_SIZE) and rewards.shape == (2,) and len(dones) == 2


def test_swing_wrap_terminates():
    from swing_env import SwingConfig, SwingPumpEnv

    env = SwingPumpEnv(SwingConfig(episode_seconds=30.0))
    env.reset(seed=37)
    hinge_qpos = int(env.model.jnt_qposadr[env.hinge_joint])
    # Wrap the swing past the bar directly in joint state.
    env.data.qpos[hinge_qpos] = 2.4
    mujoco.mj_forward(env.model, env.data)
    _, _, done, info = env.step(np.zeros(ACTION_SIZE))
    assert done and info["wrapped"]


def test_ballbalance_env_contract_and_hidden_ball():
    from ballbalance_env import (
        BALL_ROLLAWAY_RADIUS,
        BallBalanceBatch,
        BallBalanceConfig,
        BallBalanceEnv,
    )

    assert BALL_ROLLAWAY_RADIUS == 0.8
    env = BallBalanceEnv(BallBalanceConfig(episode_seconds=4.0))
    obs = env.reset(seed=41)
    assert obs.shape == (OBSERVATION_SIZE,) and np.all(np.isfinite(obs))
    assert env.ball_qpos is not None, "stability-ball scene keeps the rolling pivot"
    step_obs, reward, done, info = env.step(np.zeros(ACTION_SIZE))
    assert step_obs.shape == (OBSERVATION_SIZE,)
    assert {"tilt", "fallen", "rolledAway"} <= set(info)
    assert np.isfinite(float(reward))
    batch = BallBalanceBatch(2, seed=43, episode_seconds=2.0)
    batch_obs = batch.reset()
    batch_obs, rewards, dones, _ = batch.step(np.zeros((2, ACTION_SIZE)))
    assert batch_obs.shape == (2, OBSERVATION_SIZE) and rewards.shape == (2,) and len(dones) == 2


def test_ladder_env_contract_and_rung_phase_gain():
    from ladder_env import GRIP_FORCE, RUNG_PITCH, LadderBatch, LadderClimbEnv, LadderConfig

    env = LadderClimbEnv(LadderConfig(episode_seconds=4.0))
    obs = env.reset(seed=47)
    assert obs.shape == (OBSERVATION_SIZE,) and np.all(np.isfinite(obs))
    step_obs, reward, done, info = env.step(np.zeros(ACTION_SIZE))
    assert step_obs.shape == (OBSERVATION_SIZE,)
    assert {"tilt", "fallen", "height", "slipped"} <= set(info)
    assert np.isfinite(float(reward))
    # The same posture transfers more climb force at a rung (phase peak) than
    # between rungs (phase trough): that phase is the hidden state.
    forces = {}
    for name, z in (("peak", 4 * RUNG_PITCH), ("mid", 4 * RUNG_PITCH + RUNG_PITCH / 2)):
        env.reset(seed=53)
        env.posture = np.full(ACTION_SIZE, 0.5)
        env.data.qpos[env.slide_qpos] = z
        mujoco.mj_forward(env.model, env.data)
        env._apply_action()
        forces[name] = abs(float(env.data.qfrc_applied[env.slide_dof]) - GRIP_FORCE)
    assert forces["peak"] > forces["mid"]
    batch = LadderBatch(2, seed=55, episode_seconds=2.0)
    batch_obs = batch.reset()
    batch_obs, rewards, dones, _ = batch.step(np.zeros((2, ACTION_SIZE)))
    assert batch_obs.shape == (2, OBSERVATION_SIZE) and rewards.shape == (2,) and len(dones) == 2


def test_ladder_slip_terminates():
    from ladder_env import LadderConfig, LadderClimbEnv

    env = LadderClimbEnv(LadderConfig(episode_seconds=30.0))
    env.reset(seed=59)
    env.data.qpos[env.slide_qpos] = 0.5 - 0.3
    mujoco.mj_forward(env.model, env.data)
    _, _, done, info = env.step(np.zeros(ACTION_SIZE))
    assert done and info["slipped"]


def test_task_id_map_covers_all_envs():
    import argparse as _argparse

    from train_recurrent import TASK_IDS, build_batch

    assert set(TASK_IDS) == {"basketball", "stilts", "swing", "ball", "ladder"}
    for env_id in TASK_IDS:
        args = _argparse.Namespace(
            env=env_id,
            num_envs=1,
            seed=1,
            episode_seconds=0.5,
            stilts_height_cm=25.0,
        )
        batch = build_batch(args)
        assert batch.observation_dim == 61 and batch.action_dim == 14


@pytest.fixture(scope="module")
def trained(tmp_path_factory):
    """One tiny real training run; its summary and export feed several tests."""
    out_dir = tmp_path_factory.mktemp("recurrent-run")
    export_path = out_dir / "policy.onnx"
    args = argparse.Namespace(
        env="basketball",
        stilts_height_cm=25.0,
        num_envs=3,
        iterations=2,
        steps_per_env=48,
        chunk=16,
        update_epochs=2,
        learning_rate=3e-4,
        gamma=0.99,
        gae_lambda=0.95,
        clip=0.2,
        entropy_weight=0.005,
        hidden=64,
        lstm_hidden=32,
        episode_seconds=4.0,
        seed=20260922,
        out=str(out_dir / "training-summary.json"),
        checkpoint=str(out_dir / "policy.pt"),
        export=str(export_path),
    )
    summary = train(args)
    return summary, export_path


def test_training_summary_contract(trained):
    summary, export_path = trained
    assert summary["observationSize"] == 61
    assert summary["actionSize"] == 14
    assert summary["task"] == "basketball-balance-recurrent"
    assert len(summary["curve"]) == 2
    assert all(np.isfinite(point["meanReward"]) for point in summary["curve"])
    assert summary["export"]["format"] == "onnx"
    assert export_path.is_file() and export_path.stat().st_size == summary["export"]["bytes"]
    assert len(summary["export"]["sha256"]) == 64
    assert summary["export"]["parityMaxAbsError"] < 1e-4


def test_export_loads_through_microduck_eval_loader(trained):
    from microduck_eval.policy import load_policy

    _, export_path = trained
    policy = load_policy(export_path)
    assert policy.recurrent is True
    assert policy.facts() == {
        "recurrent": True,
        "stateInputs": ["h_in", "c_in"],
        "stateOutputs": ["h_out", "c_out"],
    }
    assert policy.state[0].shape == (1, 1, 32)  # lstm_hidden of the fixture run

    rng = np.random.default_rng(42)
    observations = [rng.normal(0, 0.3, OBSERVATION_SIZE).astype(np.float32) for _ in range(5)]
    ours = [policy.act(obs) for obs in observations]
    session = ort.InferenceSession(str(export_path), providers=["CPUExecutionProvider"])
    h = np.zeros((1, 1, 32), dtype=np.float32)
    c = np.zeros((1, 1, 32), dtype=np.float32)
    for step, obs in enumerate(observations):
        reference, h, c = session.run(
            ["actions", "h_out", "c_out"], {"obs": obs.reshape(1, -1), "h_in": h, "c_in": c}
        )
        np.testing.assert_allclose(ours[step], reference.reshape(-1), atol=1e-4)

    # reset() must detach the episode: the next action matches a fresh state.
    policy.reset()
    tail = rng.normal(0, 0.3, OBSERVATION_SIZE).astype(np.float32)
    after_reset = policy.act(tail)
    fresh, _, _ = session.run(
        ["actions", "h_out", "c_out"],
        {"obs": tail.reshape(1, -1),
         "h_in": np.zeros((1, 1, 32), dtype=np.float32),
         "c_in": np.zeros((1, 1, 32), dtype=np.float32)},
    )
    np.testing.assert_allclose(after_reset, fresh.reshape(-1), atol=1e-4)


def test_export_supports_batched_state(trained):
    """Dynamic batch: one graph serves [4,61] observations with [1,4,32] state."""
    _, export_path = trained
    session = ort.InferenceSession(str(export_path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(9)
    actions, h_out, c_out = session.run(
        ["actions", "h_out", "c_out"],
        {
            "obs": rng.normal(0, 0.3, (4, OBSERVATION_SIZE)).astype(np.float32),
            "h_in": np.zeros((1, 4, 32), dtype=np.float32),
            "c_in": np.zeros((1, 4, 32), dtype=np.float32),
        },
    )
    assert actions.shape == (4, ACTION_SIZE)
    assert h_out.shape == (1, 4, 32) and c_out.shape == (1, 4, 32)
    assert np.all(np.isfinite(actions))


def test_failed_verification_renames_artifact(tmp_path, monkeypatch):
    """When parity fails the artifact must be renamed .rejected, never shipped."""
    import train_recurrent as trainer

    policy = RecurrentActorCritic(hidden=16, lstm_hidden=8)
    target = tmp_path / "policy.onnx"
    monkeypatch.setattr(
        trainer, "verify_export", lambda _policy, _path: {"ok": False, "parity": 9.9, "failures": ["injected"]}
    )
    with pytest.raises(RuntimeError, match="rejected"):
        trainer.export_onnx(policy, str(target))
    assert not target.exists()
    assert (tmp_path / "policy.onnx.rejected").is_file()
