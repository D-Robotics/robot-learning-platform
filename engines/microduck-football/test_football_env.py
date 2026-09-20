from __future__ import annotations

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
