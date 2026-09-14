#!/usr/bin/env python3
"""OriginBot PPO trainer using the shared Worker file protocol.

The trainer deliberately consumes the same domain-randomized environment used
by local contract tests.  It emits a small nominal/randomized evaluation block
alongside the policy artifact so downstream release tooling can distinguish a
training reward from a reproducible navigation result.
"""

import json
import os
import random

import torch

from originbot_env import RDKRobotEnv


class ActorCritic(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.body = torch.nn.Sequential(
            torch.nn.Linear(8, 64),
            torch.nn.Tanh(),
            torch.nn.Linear(64, 64),
            torch.nn.Tanh(),
        )
        self.mu = torch.nn.Linear(64, 2)
        self.value = torch.nn.Linear(64, 1)
        self.logstd = torch.nn.Parameter(torch.full((2,), -0.5))

    def forward(self, x):
        h = self.body(x)
        return torch.tanh(self.mu(h)), self.value(h).squeeze(-1)


def _environment_config(request):
    training = request.get("training", {}) or {}
    task = request.get("task", {}) or {}
    randomization_spec = task.get("domainRandomization") or training.get("domainRandomizationSpec")
    enabled = training.get("domainRandomization", randomization_spec is not None)
    curriculum = task.get("curriculum", {}) or {}
    termination = task.get("termination", {}) or {}
    workspace = task.get("workspace", {}) or {}
    obstacles = workspace.get("obstacles", {}) or {}
    return {
        "horizon": int(termination.get("timeoutSteps", 200)),
        "goal_distance": curriculum.get("initialGoalDistance", (1.0, 2.0)),
        "goal_tolerance": float(termination.get("goalDistance", 0.12)),
        "workspace_bound": workspace.get("bound"),
        "obstacle_count": int(obstacles.get("count", 0)),
        "obstacle_radius": float(obstacles.get("radius", 0.15)),
        "domain_randomization": bool(enabled),
        "randomization_spec": randomization_spec,
    }


def _make_env(seed, config, randomized=True):
    return RDKRobotEnv(
        seed=seed,
        horizon=config["horizon"],
        domain_randomization=bool(randomized and config["domain_randomization"]),
        randomization_spec=config["randomization_spec"],
        goal_distance=config["goal_distance"],
        goal_tolerance=config["goal_tolerance"],
        workspace_bound=config["workspace_bound"],
        obstacle_count=config["obstacle_count"],
        obstacle_radius=config["obstacle_radius"],
    )


def _policy_command(action, env):
    """Project the policy's normalized [-1, 1] head to physical cmd_vel."""

    return [
        float(action[0]) * env.adapter.max_linear,
        float(action[1]) * env.adapter.max_angular,
    ]


def _evaluate(net, device, seed, config, episodes, randomized):
    """Run whole episodes and return auditable aggregate metrics."""

    env = _make_env(seed, config, randomized=randomized)
    records = []
    net.eval()
    with torch.no_grad():
        for episode in range(max(1, int(episodes))):
            obs, _ = env.reset(seed=seed + episode)
            terminal_record = None
            for _ in range(env.horizon):
                tensor = torch.tensor([obs], dtype=torch.float32, device=device)
                mean, _value = net(tensor)
                obs, _reward, done, truncated, info = env.step(_policy_command(mean[0].cpu().tolist(), env))
                if done or truncated:
                    terminal_record = info.get("episode", env.episode_metrics())
                    break
            records.append(terminal_record or env.episode_metrics())
    count = max(1, len(records))
    successes = sum(1 for row in records if row.get("success"))
    collisions = sum(1 for row in records if row.get("collision"))

    def wilson(k, n, z=1.959964):
        if n <= 0:
            return None
        p = k / n
        denominator = 1.0 + z * z / n
        center = (p + z * z / (2.0 * n)) / denominator
        spread = z * ((p * (1.0 - p) / n + z * z / (4.0 * n * n)) ** 0.5) / denominator
        return [center - spread, center + spread]

    return {
        "episodes": len(records),
        "successRate": successes / count,
        "collisionRate": collisions / count,
        "successRateCi95": wilson(successes, len(records)),
        "collisionRateCi95": wilson(collisions, len(records)),
        "meanGoalDistance": sum(float(row.get("goalDistance", 0.0)) for row in records) / count,
        "meanEpisodeReturn": sum(float(row.get("return", 0.0)) for row in records) / count,
        "meanControlLatencySteps": sum(float(row.get("controlLatencySteps", 0.0)) for row in records) / count,
        "randomized": bool(randomized and config["domain_randomization"]),
        # Keep per-episode evidence bounded while preserving enough detail to
        # diagnose a smoke run in the UI.
        "episodesDetail": records[:20],
    }


def main():
    with open(os.environ["RDK_SIM2REAL_REQUEST_FILE"]) as handle:
        request = json.load(handle)
    out = os.environ["RDK_SIM2REAL_RESULT_FILE"]
    training = request.get("training", {}) or {}
    profile = training.get("profile", "smoke")
    updates = {"smoke": 20, "low-vram": 80, "standard": 180, "high-vram": 300}.get(profile, 20)
    requested = os.environ.get("RDK_STARTER_ENGINE_DEVICE", "auto").strip().lower()
    if requested not in ("auto", "cpu", "cuda"):
        raise ValueError("RDK_STARTER_ENGINE_DEVICE must be auto, cpu, or cuda")
    cuda_available = torch.cuda.is_available()
    if requested == "cuda" and not cuda_available:
        print("[originbot] cuda requested but unavailable; using CPU")
    use_cuda = cuda_available and requested != "cpu"
    device = torch.device("cuda" if use_cuda else "cpu")
    seed = int(request.get("seed", training.get("seed", 7)))
    torch.manual_seed(seed)
    random.seed(seed)
    if use_cuda:
        torch.cuda.manual_seed_all(seed)

    config = _environment_config(request)
    env = _make_env(seed, config, randomized=True)
    net = ActorCritic().to(device)
    opt = torch.optim.Adam(net.parameters(), lr=3e-4)
    gamma, lam, clip = 0.99, 0.95, 0.2
    rewards = []
    episode_records = []

    for update in range(updates):
        obs, _ = env.reset(seed=seed + update)
        observations, actions, old_log_probs, values, returns, terminals = [], [], [], [], [], []
        for _ in range(128):
            x = torch.tensor([obs], dtype=torch.float32, device=device)
            mu, value = net(x)
            dist = torch.distributions.Normal(mu, torch.exp(net.logstd))
            sampled = dist.sample()
            log_prob = dist.log_prob(sampled).sum(-1)
            action = sampled[0].detach().cpu().tolist()
            next_obs, reward, done, truncated, info = env.step(_policy_command(action, env))
            terminal = bool(done or truncated)
            observations.append(x[0])
            actions.append(sampled[0])
            old_log_probs.append(log_prob[0].detach())
            values.append(value[0].detach())
            returns.append(float(reward))
            terminals.append(terminal)
            obs = next_obs
            if terminal:
                episode_records.append(info.get("episode", env.episode_metrics()))
                # Keep the RNG stream moving between episodes. Re-seeding here
                # would replay the same goal and domain envelope after every
                # early success, defeating domain randomization.
                obs, _ = env.reset()

        with torch.no_grad():
            _, last_value = net(torch.tensor([obs], dtype=torch.float32, device=device))
            last_value = last_value[0]
        advantages = []
        gae = torch.tensor(0.0, device=device)
        all_values = values + [last_value]
        for index in reversed(range(len(returns))):
            alive = 0 if terminals[index] else 1
            delta = torch.tensor(returns[index], device=device) + gamma * all_values[index + 1] * alive - all_values[index]
            gae = delta + gamma * lam * alive * gae
            advantages.insert(0, gae)
        obs_tensor = torch.stack(observations)
        action_tensor = torch.stack(actions)
        old_log_prob_tensor = torch.stack(old_log_probs)
        advantage_tensor = torch.stack(advantages)
        target_values = advantage_tensor + torch.stack(values)
        advantage_tensor = (advantage_tensor - advantage_tensor.mean()) / (advantage_tensor.std() + 1e-8)
        for _ in range(4):
            mu, value = net(obs_tensor)
            dist = torch.distributions.Normal(mu, torch.exp(net.logstd))
            log_prob = dist.log_prob(action_tensor).sum(-1)
            # Log-space clamp prevents an outlier sampled action from creating
            # an infinite PPO ratio while retaining the unclipped action/logp
            # pairing required by PPO.
            ratio = torch.exp(torch.clamp(log_prob - old_log_prob_tensor, -20.0, 20.0))
            policy_loss = -torch.min(
                ratio * advantage_tensor,
                torch.clamp(ratio, 1 - clip, 1 + clip) * advantage_tensor,
            ).mean()
            loss = policy_loss + 0.5 * torch.nn.functional.mse_loss(value, target_values)
            loss -= 0.001 * dist.entropy().sum(-1).mean()
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 0.5)
            opt.step()
        rewards.append(sum(returns) / len(returns))

    eval_episodes = int(os.environ.get("RDK_ORIGINBOT_EVAL_EPISODES", "8"))
    evaluation = {
        "nominal": _evaluate(net, device, seed + 10000, config, eval_episodes, randomized=False),
        "randomized": _evaluate(net, device, seed + 20000, config, eval_episodes, randomized=True),
    }
    job = os.path.dirname(out)
    checkpoint = os.path.join(job, "originbot-ppo.pt")
    torch.save({"model": net.state_dict(), "observationSize": 8, "actionSize": 2}, checkpoint)
    onnx_exported = False
    try:
        torch.onnx.export(
            net,
            torch.zeros(1, 8, device=device),
            os.path.join(job, "originbot-policy.onnx"),
            input_names=["observation"],
            output_names=["action", "value"],
            opset_version=17,
        )
        onnx_exported = True
    except Exception:
        # Torch checkpoint remains a valid smoke artifact when the optional
        # ONNX exporter is unavailable in a minimal worker image.
        pass
    metrics = {
        "algorithm": "ppo",
        "rewardStart": rewards[0],
        "rewardEnd": rewards[-1],
        "reward": max(rewards),
        "iterations": updates,
        "observationSize": 8,
        "actionSize": 2,
        "actionOutput": "normalized-twist",
        "onnxExported": onnx_exported,
        "simulator": "originbot-kinematic",
        "device": device.type,
        "deviceName": torch.cuda.get_device_name(0) if use_cuda else "cpu",
        "domainRandomizationEnabled": bool(config["domain_randomization"]),
        "trainingEpisodes": len(episode_records),
        "evaluation": evaluation,
        # Keep the nominal values at the top level for older result consumers.
        "successRate": evaluation["nominal"]["successRate"],
        "collisionRate": evaluation["nominal"]["collisionRate"],
        "evalEpisodes": evaluation["nominal"]["episodes"],
        "episodeMetrics": episode_records[-20:],
    }
    result = {
        "status": "completed",
        "checkpoint": {"checkpointId": "originbot-ppo-final", "artifactRef": "artifact://originbot/ppo-checkpoint", "iteration": updates},
        "artifact": {"artifactRef": "artifact://originbot/ppo-policy", "format": "onnx" if onnx_exported else "torch", "observationSize": 8, "actionSize": 2, "actionOutput": "normalized-twist"},
        "metrics": metrics,
        "cuda": use_cuda,
        "deployable": False,
    }
    with open(out, "w") as handle:
        json.dump(result, handle)
    print(json.dumps({"status": "completed", "algorithm": "ppo", "iterations": updates, "rewardStart": rewards[0], "rewardEnd": rewards[-1], "onnxExported": onnx_exported, "device": device.type, "domainRandomizationEnabled": bool(config["domain_randomization"]), "evalSuccessRate": evaluation["nominal"]["successRate"]}))


if __name__ == "__main__":
    main()
