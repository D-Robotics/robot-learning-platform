#!/usr/bin/env python3
"""Recurrent (LSTM) PPO trainer for the MicroDuck balance proxy.

Closes the training-side gap the evaluation engine already anticipates:
``microduck_eval.policy.load_policy`` accepts recurrent ONNX graphs (one 61-d
observation input, one 14-d action output, paired h/c state tensors), but no
engine in this repository could *produce* one. This trainer exports exactly
that graph: ``obs[batch,61] + h/c[1,batch,256] -> actions[batch,14] +
h_out/c_out[1,batch,256]``, verified against onnxruntime with state carry
before the artifact is allowed to exist.

The rollout stores each step's LSTM input state; the PPO update recomputes
fixed-length chunks starting from those stored states (stored-state BPTT).
Like every first-party trainer here it runs on CPU for smoke evidence — a
run to policy competence at quality scale is GPU-runner work and is recorded
as such, never implied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from balance_env import ACTION_SIZE, OBSERVATION_SIZE, BalanceBatch


class RecurrentActorCritic(nn.Module):
    """ELU encoder -> single-layer LSTM -> tanh-squashed Gaussian policy + value."""

    def __init__(self, obs_size: int = OBSERVATION_SIZE, act_size: int = ACTION_SIZE,
                 hidden: int = 128, lstm_hidden: int = 256):
        super().__init__()
        self.encoder = nn.Sequential(nn.Linear(obs_size, hidden), nn.ELU())
        self.lstm = nn.LSTM(hidden, lstm_hidden)
        self.mean_head = nn.Linear(lstm_hidden, act_size)
        self.value_head = nn.Linear(lstm_hidden, 1)
        self.log_std = nn.Parameter(torch.full((act_size,), -0.5))
        self.lstm_hidden = lstm_hidden

    def step(self, obs: torch.Tensor, state: tuple[torch.Tensor, torch.Tensor]):
        """One control step. obs [N, obs_size]; state is ([1,N,H], [1,N,H])."""
        features = self.encoder(obs).unsqueeze(0)
        out, next_state = self.lstm(features, state)
        mean = self.mean_head(out.squeeze(0))
        value = self.value_head(out.squeeze(0)).squeeze(-1)
        return mean, value, next_state

    def sequence(self, obs: torch.Tensor, state: tuple[torch.Tensor, torch.Tensor]):
        """A chunk of T steps. obs [T,N,obs_size]; state opens the chunk."""
        features = self.encoder(obs)
        out, _ = self.lstm(features, state)
        return self.mean_head(out), self.value_head(out).squeeze(-1)


def _squashed_logp(mean: torch.Tensor, log_std: torch.Tensor, raw_action: torch.Tensor):
    std = log_std.exp().expand_as(mean)
    dist = torch.distributions.Normal(mean, std)
    squashed = torch.tanh(raw_action)
    logp = dist.log_prob(raw_action).sum(-1) - torch.log(1.0 - squashed.pow(2) + 1e-6).sum(-1)
    entropy = dist.entropy().sum(-1)
    return squashed, logp, entropy


def train(args: argparse.Namespace) -> dict:
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    batch = BalanceBatch(
        args.num_envs,
        seed=args.seed,
        episode_seconds=args.episode_seconds,
        stilts=args.env == "stilts",
        stilts_height_cm=args.stilts_height_cm,
    )
    policy = RecurrentActorCritic(hidden=args.hidden, lstm_hidden=args.lstm_hidden)
    optimizer = torch.optim.Adam(policy.parameters(), lr=args.learning_rate)
    num_envs = args.num_envs
    state = (torch.zeros(1, num_envs, args.lstm_hidden), torch.zeros(1, num_envs, args.lstm_hidden))
    obs = batch.reset()
    episode_reward = np.zeros(num_envs, dtype=np.float64)
    resets = 0
    curve = []
    started = time.time()
    for iteration in range(1, args.iterations + 1):
        obs_buf, act_buf, logp_buf, value_buf, reward_buf, done_buf = [], [], [], [], [], []
        h_buf, c_buf = [], []
        for _ in range(args.steps_per_env):
            obs_tensor = torch.from_numpy(obs)
            with torch.no_grad():
                mean, value, next_state = policy.step(obs_tensor, state)
                raw = torch.distributions.Normal(mean, policy.log_std.exp().expand_as(mean)).sample()
                squashed = torch.tanh(raw)
                logp = _squashed_logp(mean, policy.log_std, raw)[1]
            action_np = squashed.numpy()
            obs_buf.append(obs.copy())
            act_buf.append(action_np.copy())
            logp_buf.append(logp.numpy().copy())
            value_buf.append(np.float64(value.numpy()))
            h_buf.append(state[0].numpy().copy())
            c_buf.append(state[1].numpy().copy())
            obs, rewards, dones, _ = batch.step(action_np)
            reward_buf.append(rewards.copy())
            done_buf.append(np.asarray(dones, dtype=np.float32))
            episode_reward += rewards
            # A reset env's continuation state is meaningless; zero just that
            # column so the stored per-step states stay exactly what the
            # behaviour policy saw.
            h_new = next_state[0].clone()
            c_new = next_state[1].clone()
            for i, flag in enumerate(dones):
                if flag:
                    resets += 1
                    episode_reward[i] = 0.0
                    h_new[:, i] = 0.0
                    c_new[:, i] = 0.0
            state = (h_new, c_new)
        obs_arr = torch.from_numpy(np.asarray(obs_buf))                       # [T,N,obs]
        act_arr = torch.from_numpy(np.asarray(act_buf))                       # [T,N,act]
        old_logp = torch.from_numpy(np.asarray(logp_buf))                     # [T,N]
        rewards = np.asarray(reward_buf, dtype=np.float32)                    # [T,N]
        values = np.asarray(value_buf, dtype=np.float32)
        dones = np.asarray(done_buf, dtype=np.float32)
        advantages = np.zeros_like(rewards)
        returns = np.zeros_like(rewards)
        last_adv = np.zeros(num_envs, dtype=np.float32)
        for t in range(args.steps_per_env - 1, -1, -1):
            next_value = values[t + 1] if t + 1 < args.steps_per_env else np.zeros(num_envs, dtype=np.float32)
            delta = rewards[t] + args.gamma * next_value * (1.0 - dones[t]) - values[t]
            last_adv = delta + args.gamma * args.gae_lambda * (1.0 - dones[t]) * last_adv
            advantages[t] = last_adv
            returns[t] = advantages[t] + values[t]
        adv = torch.from_numpy(advantages)
        ret = torch.from_numpy(returns)
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        h_states = torch.from_numpy(np.asarray(h_buf))                        # [T,1,N,H]
        c_states = torch.from_numpy(np.asarray(c_buf))
        policy_loss_total = 0.0
        for _ in range(args.update_epochs):
            for start in range(0, args.steps_per_env - args.chunk + 1, args.chunk):
                stop = start + args.chunk
                h0 = h_states[start].clone()
                c0 = c_states[start].clone()
                mean, value = policy.sequence(obs_arr[start:stop], (h0, c0))
                raw = torch.atanh(torch.clamp(act_arr[start:stop], -0.999, 0.999))
                _, logp, entropy = _squashed_logp(mean, policy.log_std, raw)
                ratio = (logp - old_logp[start:stop]).exp()
                chunk_adv = adv[start:stop]
                policy_loss = -torch.min(
                    ratio * chunk_adv, torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * chunk_adv
                ).mean()
                value_loss = 0.5 * (value - ret[start:stop]).pow(2).mean()
                loss = policy_loss + 0.5 * value_loss - args.entropy_weight * entropy.mean()
                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
                optimizer.step()
                policy_loss_total += float(policy_loss.detach())
        point = {
            "iteration": iteration,
            "meanReward": float(rewards.mean()),
            "resets": resets,
            "survivedSteps": int(args.steps_per_env * num_envs - resets),
        }
        curve.append(point)
        print(
            f"iter {iteration}/{args.iterations} meanReward={point['meanReward']:.4f} "
            f"resets={resets} policyLoss={policy_loss_total:.4f} device=cpu",
            flush=True,
        )
    payload = {
        "task": "stilt-balance-recurrent" if args.env == "stilts" else "basketball-balance-recurrent",
        "env": args.env,
        "stiltsHeightCm": args.stilts_height_cm if args.env == "stilts" else None,
        "device": "cpu",
        "observationSize": OBSERVATION_SIZE,
        "actionSize": ACTION_SIZE,
        "numEnvs": num_envs,
        "iterations": args.iterations,
        "stepsPerEnv": args.steps_per_env,
        "lstmHidden": args.lstm_hidden,
        "chunkedBptt": {"chunk": args.chunk, "epochs": args.update_epochs},
        "curve": curve,
        "resets": resets,
        "elapsedSeconds": round(time.time() - started, 3),
    }
    if args.checkpoint:
        torch.save({"model": policy.state_dict(), "meta": payload}, args.checkpoint)
        payload["checkpoint"] = {"path": args.checkpoint}
    if args.export:
        payload["export"] = export_onnx(policy, args.export)
    if args.out:
        Path(args.out).write_text(json.dumps(payload, indent=2) + "\n")
    return payload


class RecurrentPolicyExport(nn.Module):
    """Actor-only wrapper whose forward is exactly the deployment graph."""

    def __init__(self, ac: RecurrentActorCritic):
        super().__init__()
        self.encoder = ac.encoder
        self.lstm = ac.lstm
        self.mean_head = ac.mean_head

    def forward(self, obs, h_in, c_in):
        features = self.encoder(obs).unsqueeze(0)
        out, (h_out, c_out) = self.lstm(features, (h_in, c_in))
        actions = torch.tanh(self.mean_head(out.squeeze(0)))
        return actions, h_out, c_out


def export_onnx(policy: RecurrentActorCritic, path: str) -> dict:
    export_model = RecurrentPolicyExport(policy).eval()
    state_example = torch.zeros((1, 1, policy.lstm_hidden))
    torch.onnx.export(
        export_model,
        (torch.zeros((1, OBSERVATION_SIZE)), state_example, state_example.clone()),
        path,
        input_names=["obs", "h_in", "c_in"],
        output_names=["actions", "h_out", "c_out"],
        dynamic_axes={
            "obs": {0: "batch"},
            "h_in": {1: "batch"},
            "c_in": {1: "batch"},
            "actions": {0: "batch"},
            "h_out": {1: "batch"},
            "c_out": {1: "batch"},
        },
        opset_version=17,
    )
    report = verify_export(policy, path)
    if not report["ok"]:
        rejected = path + ".rejected"
        os.replace(path, rejected)
        raise RuntimeError(
            f"export failed verification ({report['failures']}); artifact renamed {rejected}"
        )
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return {
        "path": path,
        "format": "onnx",
        "opset": 17,
        "bytes": Path(path).stat().st_size,
        "sha256": digest,
        "recurrent": {
            "hidden": policy.lstm_hidden,
            "stateShape": [1, "batch", policy.lstm_hidden],
            "stateInputs": ["h_in", "c_in"],
            "stateOutputs": ["h_out", "c_out"],
        },
        "parityMaxAbsError": report["parity"],
    }


def verify_export(policy: RecurrentActorCritic, path: str) -> dict:
    """The exported graph must match torch step-for-step *with state carry*."""
    import onnx
    import onnxruntime as ort

    model = onnx.load(path)
    onnx.checker.check_model(model)
    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    export_model = RecurrentPolicyExport(policy).eval()
    rng = np.random.default_rng(7)
    h = np.zeros((1, 1, policy.lstm_hidden), dtype=np.float32)
    c = np.zeros((1, 1, policy.lstm_hidden), dtype=np.float32)
    th = torch.from_numpy(h)
    tc = torch.from_numpy(c)
    failures = []
    worst = 0.0
    with torch.no_grad():
        for _ in range(6):
            obs = rng.normal(0, 0.4, (1, OBSERVATION_SIZE)).astype(np.float32)
            torch_actions, th, tc = export_model(torch.from_numpy(obs), th, tc)
            ort_actions, h, c = session.run(
                ["actions", "h_out", "c_out"],
                {"obs": obs, "h_in": h, "c_in": c},
            )
            worst = max(worst, float(np.max(np.abs(ort_actions - torch_actions.numpy()))))
            if not (np.all(np.isfinite(ort_actions)) and np.all(np.isfinite(h)) and np.all(np.isfinite(c))):
                failures.append("non-finite output")
    return {"ok": not failures and worst < 1e-4, "parity": worst, "failures": failures}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", choices=["basketball", "stilts"], default="basketball",
                        help="balance proxy: rolling basketball (drifting pivot) or rigid stilts (fixed pivot)")
    parser.add_argument("--stilts-height-cm", type=float, default=25.0)
    parser.add_argument("--num-envs", type=int, default=8)
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--steps-per-env", type=int, default=64)
    parser.add_argument("--chunk", type=int, default=16)
    parser.add_argument("--update-epochs", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--gamma", type=float, default=0.99)
    parser.add_argument("--gae-lambda", type=float, default=0.95)
    parser.add_argument("--clip", type=float, default=0.2)
    parser.add_argument("--entropy-weight", type=float, default=0.005)
    parser.add_argument("--hidden", type=int, default=128)
    parser.add_argument("--lstm-hidden", type=int, default=256)
    parser.add_argument("--episode-seconds", type=float, default=12.0)
    parser.add_argument("--seed", type=int, default=20260922)
    parser.add_argument("--out")
    parser.add_argument("--checkpoint")
    parser.add_argument("--export")
    train(parser.parse_args())


if __name__ == "__main__":
    main()
