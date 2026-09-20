#!/usr/bin/env python3
"""Evaluate an exported football actor in the real MuJoCo task."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from football_env import FootballConfig, MicroDuckFootballEnv


def evaluate(policy_path: str, task: str, episodes: int, seed: int) -> dict:
    policy = torch.jit.load(policy_path, map_location="cpu").eval()
    env = MicroDuckFootballEnv(FootballConfig(task=task, seed=seed))
    rows = []
    for episode in range(episodes):
        obs = env.reset(seed=seed + episode)
        total = 0.0
        for _ in range(int(env.config.episode_seconds * env.config.control_hz)):
            with torch.no_grad():
                action = policy(torch.from_numpy(obs)).cpu().numpy()
            obs, reward, done, info = env.step(action)
            total += float(np.mean(reward))
            if done:
                break
        rows.append({
            "goal": bool(info["goal"]),
            "return": total,
            "steps": int(env.step_count),
            "ballX": float(info["ballX"]),
        })
    goals = sum(int(row["goal"]) for row in rows)
    return {
        "policy": str(Path(policy_path)),
        "task": task,
        "episodes": episodes,
        "goals": goals,
        "successRate": goals / max(1, episodes),
        "meanReturn": float(np.mean([row["return"] for row in rows])),
        "episodeResults": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", required=True)
    parser.add_argument("--task", choices=["single-goal-kick", "soccer-2v2", "soccer-3v3"], default="single-goal-kick")
    parser.add_argument("--episodes", type=int, default=200)
    parser.add_argument("--seed", type=int, default=20260920)
    parser.add_argument("--out")
    args = parser.parse_args()
    result = evaluate(args.policy, args.task, args.episodes, args.seed)
    print(json.dumps(result, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
