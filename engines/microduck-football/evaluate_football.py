#!/usr/bin/env python3
"""Evaluate the deterministic chase-and-kick baseline on the MuJoCo task."""

from __future__ import annotations

import argparse
import json

import numpy as np

from football_env import FootballConfig, MicroDuckFootballEnv


def run_episode(env: MicroDuckFootballEnv, seed: int) -> dict:
    obs = env.reset(seed=seed)
    del obs
    total = 0.0
    for _ in range(int(env.config.episode_seconds * env.config.control_hz)):
        duck = env._duck_xy(0)  # high-level baseline; policy adapters use observe()
        ball = env._ball_xy()
        delta = ball - duck
        action = np.array([np.clip(delta[0] * 3.0, -1, 1), np.clip(delta[1] * 3.0, -1, 1), 0.0, 1.0 if np.linalg.norm(delta) < 0.42 else 0.0], dtype=np.float32)
        _, reward, done, info = env.step(action)
        total += float(reward[0])
        if done:
            return {"goal": bool(info["goal"]), "return": total, "steps": env.step_count, "ballX": info["ballX"]}
    return {"goal": bool(env.scored), "return": total, "steps": env.step_count, "ballX": float(env._ball_xy()[0])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=["single-goal-kick", "soccer-2v2", "soccer-3v3"], default="single-goal-kick")
    parser.add_argument("--episodes", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20260920)
    parser.add_argument("--out")
    args = parser.parse_args()
    env = MicroDuckFootballEnv(FootballConfig(task=args.task, seed=args.seed))
    episodes = [run_episode(env, args.seed + i) for i in range(args.episodes)]
    result = {"task": args.task, "episodes": len(episodes), "goals": sum(int(item["goal"]) for item in episodes), "successRate": sum(int(item["goal"]) for item in episodes) / max(1, len(episodes)), "episodeResults": episodes}
    print(json.dumps(result, indent=2))
    if args.out:
        with open(args.out, "w") as handle:
            json.dump(result, handle, indent=2)


if __name__ == "__main__":
    main()
