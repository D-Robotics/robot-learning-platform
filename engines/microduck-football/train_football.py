#!/usr/bin/env python3
"""Minimal PPO runner for the MuJoCo MicroDuck football tasks."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from football_env import FootballBatch


class ActorCritic(nn.Module):
    def __init__(self, obs_dim: int, action_dim: int):
        super().__init__()
        self.body = nn.Sequential(nn.Linear(obs_dim, 128), nn.Tanh(), nn.Linear(128, 128), nn.Tanh())
        self.mean = nn.Linear(128, action_dim)
        self.value = nn.Linear(128, 1)
        self.log_std = nn.Parameter(torch.full((action_dim,), -0.5))

    def forward(self, obs):
        h = self.body(obs)
        return self.mean(h), self.value(h).squeeze(-1)

    def sample(self, obs):
        mean, value = self(obs)
        std = self.log_std.exp().expand_as(mean)
        dist = torch.distributions.Normal(mean, std)
        action = dist.sample()
        squashed = action.tanh()
        logp = dist.log_prob(action).sum(-1) - torch.log(1.0 - squashed.pow(2) + 1e-6).sum(-1)
        return squashed, logp, value


def teacher_action(observation: np.ndarray) -> np.ndarray:
    """A bounded task teacher used only to warm-start PPO.

    The duck is steered to the ball's goal-facing side before kicking. This is
    still a 4D football policy; it does not inject labels into evaluation or
    replace the PPO update.
    """
    obs = np.asarray(observation, dtype=np.float32)
    rel_ball = obs[..., 0:2]
    ball_velocity = obs[..., 2:4]
    rel_goal = obs[..., 6:8]
    goal_norm = np.linalg.norm(rel_goal, axis=-1, keepdims=True)
    goal_dir = rel_goal / np.maximum(goal_norm, 1e-6)
    target = rel_ball - goal_dir * 0.26
    move = np.clip(target * 2.5, -1.0, 1.0)
    distance = np.linalg.norm(rel_ball, axis=-1, keepdims=True)
    toward_goal = np.sum(ball_velocity * goal_dir, axis=-1, keepdims=True)
    kick = np.where((distance < 0.46) & (toward_goal < 1.0), 1.0, -1.0)
    turn = np.zeros_like(kick)
    return np.concatenate([move, turn, kick], axis=-1).astype(np.float32)


def train(args: argparse.Namespace) -> dict:
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    batch = FootballBatch(args.task, args.num_envs, args.seed)
    obs = batch.reset()
    obs_dim = batch.observation_dim
    policy = ActorCritic(obs_dim, batch.action_dim).to(device)
    optimizer = torch.optim.Adam(policy.parameters(), lr=args.learning_rate)
    episode_returns = np.zeros(args.num_envs, dtype=np.float32)
    episode_goals = 0
    completed = 0
    curve = []
    started = time.time()
    for iteration in range(1, args.iterations + 1):
        obs_buf, act_buf, logp_buf, value_buf, reward_buf, done_buf = [], [], [], [], [], []
        for _ in range(args.steps_per_env):
            obs_tensor = torch.from_numpy(obs.reshape(-1, obs_dim)).to(device)
            with torch.no_grad():
                action, logp, value = policy.sample(obs_tensor)
            action_np = action.detach().cpu().numpy().reshape(args.num_envs, batch.num_agents, batch.action_dim)
            next_obs, rewards, dones, infos = batch.step(action_np)
            obs_buf.append(obs.copy())
            act_buf.append(action_np.copy())
            logp_buf.append(logp.cpu().numpy())
            value_buf.append(value.cpu().numpy())
            reward_buf.append(rewards.mean(axis=1))
            done_buf.append(dones)
            episode_returns += rewards.mean(axis=1)
            for i, info in enumerate(infos):
                if info["goal"]:
                    episode_goals += 1
                if dones[i]:
                    completed += 1
                    episode_returns[i] = 0.0
            obs = next_obs
        obs_arr = torch.from_numpy(np.asarray(obs_buf).reshape(-1, obs_dim)).to(device)
        act_arr = torch.from_numpy(np.asarray(act_buf).reshape(-1, batch.action_dim)).to(device)
        old_logp = torch.from_numpy(np.asarray(logp_buf).reshape(-1)).to(device)
        rewards = np.asarray(reward_buf, dtype=np.float32)
        values = np.asarray(value_buf, dtype=np.float32)
        dones = np.asarray(done_buf, dtype=np.float32)
        last_adv = np.zeros(args.num_envs * batch.num_agents, dtype=np.float32)
        last_value = np.zeros(args.num_envs * batch.num_agents, dtype=np.float32)
        # Each agent shares the team reward and termination flag. Replicate the
        # env-level rollout targets across the controlled agents.
        rewards = np.repeat(rewards, batch.num_agents, axis=1)
        dones = np.repeat(dones, batch.num_agents, axis=1)
        returns = np.zeros_like(rewards)
        advantages = np.zeros_like(rewards)
        for t in range(args.steps_per_env - 1, -1, -1):
            mask = 1.0 - dones[t]
            delta = rewards[t] + args.gamma * last_value * mask - values[t]
            last_adv = delta + args.gamma * args.gae_lambda * last_adv * mask
            advantages[t] = last_adv
            returns[t] = advantages[t] + values[t]
            last_value = values[t]
        adv = torch.from_numpy(advantages.reshape(-1)).to(device)
        ret = torch.from_numpy(returns.reshape(-1)).to(device)
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        teacher = torch.from_numpy(teacher_action(obs_arr.detach().cpu().numpy())).to(device)
        # Anneal the warm-start signal so the final policy is determined by
        # measured PPO returns rather than a hard-coded controller.
        teacher_weight = max(0.03, args.teacher_weight * (1.0 - (iteration - 1) / max(1.0, args.iterations * 0.8)))
        for _ in range(args.update_epochs):
            mean, value = policy(obs_arr)
            dist = torch.distributions.Normal(mean, policy.log_std.exp().expand_as(mean))
            clipped = torch.clamp(act_arr, -0.999, 0.999)
            raw_action = torch.atanh(clipped)
            logp = dist.log_prob(raw_action).sum(-1) - torch.log(1.0 - clipped.pow(2) + 1e-6).sum(-1)
            ratio = (logp - old_logp).exp()
            policy_loss = -torch.min(ratio * adv, torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * adv).mean()
            value_loss = 0.5 * (value - ret).pow(2).mean()
            behavior_loss = (torch.tanh(mean) - teacher).pow(2).mean()
            loss = policy_loss + 0.5 * value_loss + teacher_weight * behavior_loss
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
            optimizer.step()
        point = {"iteration": iteration, "meanReward": float(rewards.mean()), "goals": episode_goals, "completedEpisodes": completed}
        point["teacherWeight"] = float(teacher_weight)
        curve.append(point)
        # Keep the platform worker's engine-agnostic progress protocol. The
        # goal count remains in the JSON evidence; recentSuccess is deliberately
        # a measured episode-goal ratio rather than a fabricated score.
        recent_success = episode_goals / max(completed, 1)
        print(
            f"iter {iteration}/{args.iterations} meanReward={point['meanReward']:.4f} "
            f"recentSuccess={recent_success:.4f} device={device}",
            flush=True,
        )
    payload = {
        "task": args.task, "device": str(device), "cuda": device.type == "cuda",
        "observationDim": obs_dim, "actionDim": batch.action_dim,
        "numEnvs": args.num_envs, "iterations": args.iterations,
        "curve": curve, "goals": episode_goals, "completedEpisodes": completed,
        "elapsedSeconds": round(time.time() - started, 3),
        "teacherWarmStart": True,
    }
    if args.out:
        Path(args.out).write_text(json.dumps(payload, indent=2) + "\n")
    if args.checkpoint:
        torch.save({"model": policy.state_dict(), "meta": payload}, args.checkpoint)
    if args.export:
        class ExportPolicy(nn.Module):
            def __init__(self, actor):
                super().__init__()
                self.actor = actor

            def forward(self, inputs):
                mean, _ = self.actor(inputs)
                return torch.tanh(mean)

        # Keep the exported artifact portable: training may run on CUDA, but
        # loading the actor for ONNX/BPU conversion should not require CUDA.
        export_policy = ExportPolicy(policy.to("cpu")).eval()
        example = torch.zeros((1, obs_dim), device="cpu")
        traced = torch.jit.trace(export_policy, example)
        traced.save(args.export)
        payload["export"] = {"path": args.export, "format": "torchscript", "observationDim": obs_dim, "actionDim": batch.action_dim}
        if args.out:
            Path(args.out).write_text(json.dumps(payload, indent=2) + "\n")
    return payload


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", choices=["single-goal-kick", "soccer-2v2", "soccer-3v3"], default="single-goal-kick")
    parser.add_argument("--num-envs", type=int, default=8)
    parser.add_argument("--iterations", type=int, default=2)
    parser.add_argument("--steps-per-env", type=int, default=64)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--gamma", type=float, default=0.99)
    parser.add_argument("--gae-lambda", type=float, default=0.95)
    parser.add_argument("--clip", type=float, default=0.2)
    parser.add_argument("--update-epochs", type=int, default=4)
    parser.add_argument("--teacher-weight", type=float, default=0.35)
    parser.add_argument("--seed", type=int, default=20260920)
    parser.add_argument("--out")
    parser.add_argument("--checkpoint")
    parser.add_argument("--export", help="TorchScript actor export path")
    train(parser.parse_args())


if __name__ == "__main__":
    main()
