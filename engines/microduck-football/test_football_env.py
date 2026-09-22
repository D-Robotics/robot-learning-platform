from __future__ import annotations

import argparse

import numpy as np

from football_env import FootballBatch, FootballConfig, MicroDuckFootballEnv


def test_single_task_loads_and_steps():
    env = MicroDuckFootballEnv(FootballConfig(task="single-goal-kick"))
    obs = env.reset(seed=7)
    assert obs.shape == (1, 20)
    next_obs, reward, done, info = env.step(np.zeros(4, dtype=np.float32))
    assert next_obs.shape == (1, 20)
    assert reward.shape == (1,)
    assert isinstance(done, bool)
    assert {"goal", "scored", "ballX", "ballY"} <= info.keys()


def test_team_tasks_have_shared_ball_and_local_observations():
    for task, agents in (("soccer-2v2", 2), ("soccer-3v3", 3)):
        env = MicroDuckFootballEnv(FootballConfig(task=task))
        obs = env.reset(seed=9)
        assert obs.shape == (agents, 24)
        team_obs, rewards, _, _ = env.step(np.zeros((agents, 4), dtype=np.float32))
        assert team_obs.shape == (agents, 24)
        assert rewards.shape == (agents,)


def test_batch_resets_finished_worlds():
    batch = FootballBatch("single-goal-kick", 3, seed=10)
    obs = batch.reset()
    assert obs.shape == (3, 1, 20)
    obs, rewards, dones, infos = batch.step(np.zeros((3, 4), dtype=np.float32))
    assert obs.shape == (3, 1, 20)
    assert rewards.shape == (3, 1)
    assert dones.shape == (3,)
    assert len(infos) == 3


def test_privileged_observation_exposes_world_frame_truth():
    for task, dim in (("single-goal-kick", 10), ("soccer-2v2", 16), ("soccer-3v3", 20)):
        env = MicroDuckFootballEnv(FootballConfig(task=task))
        env.reset(seed=13)
        assert env.privileged_observation_dim == dim
        privileged = env.observe_privileged(0)
        assert privileged.shape == (dim,)
        assert np.all(np.isfinite(privileged))
        # The first two channels are the world-frame ball position; they must
        # match what the sim actually holds, not a re-derived local view.
        ball_xy = env._ball_xy()
        np.testing.assert_allclose(privileged[0:2], ball_xy, atol=1e-5)


def test_batch_privileged_obs_matches_agent_layout():
    batch = FootballBatch("soccer-2v2", 2, seed=17)
    batch.reset()
    privileged = batch.privileged_obs()
    assert privileged.shape == (2, 2, batch.privileged_observation_dim)
    assert np.all(np.isfinite(privileged))


def test_asymmetric_training_smoke(tmp_path):
    """One tiny asymmetric run: critic trains on ball truth, actor exports the same interface."""
    import json

    import torch

    import train_football

    args = argparse.Namespace(
        task="single-goal-kick",
        num_envs=2,
        iterations=2,
        steps_per_env=32,
        device="cpu",
        learning_rate=3e-4,
        gamma=0.99,
        gae_lambda=0.95,
        clip=0.2,
        update_epochs=2,
        teacher_weight=0.35,
        asymmetric=True,
        seed=20260920,
        out=str(tmp_path / "summary.json"),
        checkpoint=str(tmp_path / "policy.pt"),
        export=None,
    )
    summary = train_football.train(args)
    assert summary["asymmetric"] is True
    assert summary["privilegedObservationDim"] == 10
    assert np.isfinite(summary["curve"][-1]["meanReward"])
    checkpoint = torch.load(args.checkpoint, weights_only=False)
    assert "critic" in checkpoint, "asymmetric checkpoint must carry the critic"
    payload = json.loads(open(args.out).read())
    assert payload["asymmetric"] is True


def test_symmetric_training_default_unchanged(tmp_path):
    """Without --asymmetric the trainer behaves as before (no critic in checkpoint)."""
    import torch

    import train_football

    args = argparse.Namespace(
        task="single-goal-kick",
        num_envs=2,
        iterations=1,
        steps_per_env=16,
        device="cpu",
        learning_rate=3e-4,
        gamma=0.99,
        gae_lambda=0.95,
        clip=0.2,
        update_epochs=1,
        teacher_weight=0.35,
        asymmetric=False,
        seed=20260920,
        out=None,
        checkpoint=str(tmp_path / "policy.pt"),
        export=None,
    )
    summary = train_football.train(args)
    assert summary["asymmetric"] is False
    assert summary["privilegedObservationDim"] is None
    checkpoint = torch.load(args.checkpoint, weights_only=False)
    assert "critic" not in checkpoint


def test_task_machine_phase_progression_and_hysteresis():
    from task_machine import FootballTaskMachine, KICK_ALIGN_ERROR_RAD, KICK_WINDOW_M, STAGE_EXIT_M

    machine = FootballTaskMachine(goal=(3.0, 0.0))
    # Far from the ball: SEARCH hands over to APPROACH on the first tick.
    action, telemetry = machine.step(duck_xy=(-2.0, 0.0), duck_heading=0.0, ball_xy=(0.0, 0.0))
    assert telemetry.phase in ("search", "approach")
    assert all(-1.0 <= component <= 1.0 for component in action)
    # Staged behind the ball on the goal-facing side -> ALIGN.
    _, staged = machine.step(duck_xy=(-0.27, 0.0), duck_heading=0.0, ball_xy=(0.0, 0.0))
    assert staged.phase == "align"
    # Losing the stance beyond the exit band returns to APPROACH (hysteresis).
    _, lost = machine.step(duck_xy=(-0.27 - STAGE_EXIT_M - 0.05, 0.0), duck_heading=0.0, ball_xy=(0.0, 0.0))
    assert lost.phase == "approach"
    # Inside the window and aligned -> ALIGN fires the kick on the transition
    # and hands over to RECOVER.
    from task_machine import TaskPhase

    machine3 = FootballTaskMachine(goal=(3.0, 0.0))
    machine3.phase = TaskPhase.ALIGN
    machine3.steps_in_phase = 0
    heading_on_line = 0.0  # ball at origin, goal +x: the shot line is heading 0
    action, kicked = machine3.step(
        duck_xy=(-KICK_WINDOW_M * 0.5, 0.0), duck_heading=heading_on_line, ball_xy=(0.0, 0.0)
    )
    assert kicked.phase == "recover" and action[3] == 1.0 and kicked.kicks == 1
    _, after = machine3.step(duck_xy=(-KICK_WINDOW_M, 0.0), duck_heading=heading_on_line, ball_xy=(0.0, 0.0))
    assert after.phase == "recover" or after.phase == "approach"
    assert KICK_ALIGN_ERROR_RAD > 0 and KICK_WINDOW_M > 0


def test_task_machine_scripted_trace_matches_env_contract():
    from football_env import FootballConfig, MicroDuckFootballEnv
    from task_machine import run_scripted_trace

    env = MicroDuckFootballEnv(FootballConfig(task="single-goal-kick"))
    trace = run_scripted_trace(env, max_steps=120)
    assert trace["steps"] > 0
    assert trace["finalPhase"] is not None
    assert set(trace["phasesVisited"]) <= {"search", "approach", "align", "kick", "recover"}
    assert trace["phasesVisited"]  # at least one phase was visited
