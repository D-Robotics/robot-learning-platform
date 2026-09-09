#!/usr/bin/env python3
"""Real local training engine for the Sim2Real platform.

This is an actual reinforcement-learning trainer: a vectorized N-joint
inverted-pendulum chain simulated with plain NumPy dynamics, a PPO
actor-critic trained on CPU with PyTorch, and an ONNX export of the
learned actor. It is NOT the MicroDuck full-body model — it exists so a
clean checkout can run a genuine observe → train → export → evaluate
loop with zero GPU hardware, and so an organisation can see exactly
where to swap in mjlab + rsl-rl (see engines/mjlab-rsl-rl-adapter/).

File protocol (driven by services/sim2real-web/local-training-worker.mjs):
  read   RDK_SIM2REAL_REQUEST_FILE  (schemaVersion 1)
  write  RDK_SIM2REAL_RESULT_FILE   (checkpoint / artifact / metrics)

Side products written next to result.json in the job directory:
  policy.onnx                 exported actor (skipped if the onnx wheel
                              is missing; the run still succeeds and is
                              honestly labeled format=unknown)
  telemetry.jsonl             post-training evaluation rollout
  baseline-telemetry.jsonl    untrained-actor rollout used as the
                              reference trajectory for sim2real gap
                              evaluation
  training-summary.json       budgets, hyperparameters, reward curve
"""

import json
import math
import os
import sys
import time

try:
    import numpy as np
except ImportError:  # pragma: no cover - environment guard
    print("starter-ppo engine requires numpy: python3 -m pip install --user numpy", file=sys.stderr)
    sys.exit(2)

try:
    import torch
except ImportError:  # pragma: no cover - environment guard
    print("starter-ppo engine requires torch: python3 -m pip install --user torch", file=sys.stderr)
    sys.exit(2)

try:
    import onnx  # noqa: F401 - presence check for export
    HAVE_ONNX = True
except ImportError:
    HAVE_ONNX = False

ONNX_MISSING_HINT = "python3 -m pip install --user onnx"

# Engine-side budget caps. The platform accepts larger requests (RoboGo
# scale), but this CPU trainer refuses to silently burn hours: it clamps
# to its own budget and records what actually ran in the result.
# Calibration on a laptop CPU: 64 envs reach solid balancing at ~240
# iterations (episode survival 40 -> 390/400 control steps).
PROFILE_BUDGETS = {
    "smoke": {"iterations": 40, "envs": 16, "steps": 128},
    "low-vram": {"iterations": 400, "envs": 32, "steps": 128},
    "standard": {"iterations": 400, "envs": 64, "steps": 128},
    "high-vram": {"iterations": 600, "envs": 128, "steps": 128},
}
PPO_HYPERPARAMS = {
    "gamma": 0.99,
    "gaeLambda": 0.95,
    "clip": 0.2,
    "actorLr": 3e-4,
    "entropyCoef": 0.002,
    "valueCoef": 0.5,
    "epochs": 4,
    "minibatch": 256,
    "maxGradNorm": 0.5,
    "actionScale": 1.5,  # Nm applied per unit action
    # A policy that falls must earn visibly less than one that stands: the
    # fall step is worth about -1 while an alive step is worth about +1, so
    # the value/advantage signal is dominated by survival, not by shaping.
    "fallPenalty": 2.0,
}

JOINT_COUNT = 12
COMMAND_SIZE = 6
COMMAND_HOLD = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0]  # hold-standing command
PHYSICS = {
    # Tuned so the untrained baseline survives ~15 steps and a few hundred
    # PPO iterations reach multi-second balancing on a laptop CPU: a demo
    # policy must visibly learn, or the training loop is meaningless.
    "gravityOverLength": 6.0,
    "damping": 0.25,
    "coupling": 0.10,  # torsional spring between neighbours
    "inertia": 0.5,
    "fallAngleRad": 0.7,
    "initialPerturbationRad": 0.05,
}
EPISODE_CONTROL_STEPS = 400  # 8 s at 50 Hz
EVAL_EPISODES = 8
TORCH_THREADS = 1  # mirror the board's one-thread CPU inference budget


def resolve_device():
    """Pick torch device: explicit override, else CUDA when genuinely usable.

    Returns (device, name, cuda_requested) so the result can report honestly:
    cuda=true only when the training actually ran on the GPU, cuda_requested
    records that the operator asked for it and it was not available.
    """
    requested = (os.environ.get("RDK_STARTER_ENGINE_DEVICE") or "auto").strip().lower()
    if requested in ("cpu", ""):
        return torch.device("cpu"), "cpu", False
    if requested != "auto" and requested != "cuda":
        raise ValueError(
            "RDK_STARTER_ENGINE_DEVICE must be 'auto', 'cuda', or 'cpu' (got {!r})".format(requested)
        )
    cuda_requested = requested == "cuda"
    if requested == "auto" or cuda_requested:
        try:
            if torch.cuda.is_available():
                return torch.device("cuda"), torch.cuda.get_device_name(0), cuda_requested
        except Exception:  # noqa: BLE001 - a broken CUDA build must fall back, not crash
            pass
    if cuda_requested:
        stdout("cuda requested but not available; falling back to cpu")
    return torch.device("cpu"), "cpu", cuda_requested


def clamp_int(value, low, high, fallback):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, parsed))


def env_int(name, fallback):
    return clamp_int(os.environ.get(name), 1, 2_000_000, fallback)


def stdout(line):
    print("[starter-ppo] " + line, flush=True)


def safe_slug(value, fallback):
    slug = "".join(ch if (ch.isalnum() or ch in "._-") else "-" for ch in str(value)).strip("-")
    return slug[:48] or fallback


# ---------------------------------------------------------------------------
# Contract-driven observation: [cos(theta) x J, sin(theta) x J, theta_dot x J,
# command x M]. The same layout is declared in the starter manifest, so the
# platform, the trainer, and the evaluator all agree on the meaning of every
# dimension without sharing code.
# ---------------------------------------------------------------------------
class PendulumChain:
    def __init__(self, num_envs, joint_count, command_size, seed):
        self.num_envs = num_envs
        self.joint_count = joint_count
        self.command_size = command_size
        # COMMAND_HOLD is a compact default for the original 6D task.  Pad
        # contract-declared command channels with zeros so arbitrary valid
        # contracts (for example MicroDuck 61D = 42 + 19) keep their exact
        # observation shape instead of silently producing a 48D tensor.
        command = np.zeros(command_size, dtype=np.float32)
        hold = np.asarray(COMMAND_HOLD[:command_size], dtype=np.float32)
        command[: hold.size] = hold
        self.command = np.tile(command, (num_envs, 1))
        self.rng = np.random.default_rng(seed)
        self.observation_size = 3 * joint_count + command_size
        self.action_size = joint_count
        # Per-env episode lengths: staggered limits desynchronize parallel
        # environments so the batched reward/advantage has real cross-env
        # variance instead of every env falling in the same step pattern.
        self.max_steps = self.rng.integers(
            EPISODE_CONTROL_STEPS // 2, EPISODE_CONTROL_STEPS + 1, size=num_envs
        ).astype(np.int64)
        self.reset()

    def reset(self):
        self.theta = self.rng.normal(
            0.0, PHYSICS["initialPerturbationRad"], size=(self.num_envs, self.joint_count)
        ).astype(np.float32)
        self.theta_dot = self.rng.normal(
            0.0, 0.02, size=(self.num_envs, self.joint_count)
        ).astype(np.float32)
        self.steps = np.zeros(self.num_envs, dtype=np.int64)
        return self.observe()

    def observe(self):
        return np.concatenate(
            [np.cos(self.theta), np.sin(self.theta), self.theta_dot, self.command],
            axis=1,
        ).astype(np.float32)

    def is_fallen(self):
        return (np.abs(self.theta) > PHYSICS["fallAngleRad"]).any(axis=1)

    def step(self, action, physics_dt, decimation, auto_reset=True):
        """Advance decimation physics substeps with a held torque.

        auto_reset=True keeps PPO rollouts dense; evaluation passes False so
        per-episode length, return, and fall statistics are real.
        """
        torque = np.clip(action, -1.0, 1.0).astype(np.float32) * PPO_HYPERPARAMS["actionScale"]
        for _ in range(decimation):
            coupled = -PHYSICS["coupling"] * (
                2.0 * self.theta - np.roll(self.theta, 1, axis=1) - np.roll(self.theta, -1, axis=1)
            )
            theta_ddot = (
                PHYSICS["gravityOverLength"] * np.sin(self.theta)
                + coupled
                - PHYSICS["damping"] * self.theta_dot
                + torque
            ) / PHYSICS["inertia"]
            self.theta += self.theta_dot * physics_dt
            self.theta_dot += theta_ddot * physics_dt
            self.theta = (self.theta + math.pi) % (2.0 * math.pi) - math.pi
        self.steps += 1
        fallen = self.is_fallen()
        done = fallen | (self.steps >= self.max_steps)
        # Survival-dominant reward: alive ≈ +1, the falling step ≈ -1. Small
        # posture terms guide learning but never outweigh survival.
        reward = (
            1.0
            - 0.05 * np.mean((self.theta / PHYSICS["fallAngleRad"]) ** 2, axis=1)
            - 0.01 * np.mean(self.theta_dot ** 2, axis=1)
            - 0.01 * np.mean(np.clip(action, -1.0, 1.0) ** 2, axis=1)
            - PPO_HYPERPARAMS["fallPenalty"] * fallen.astype(np.float32)
        ).astype(np.float32)
        obs = self.observe()
        if auto_reset and done.any():
            # Reset only the finished episodes and re-randomize their phase so
            # envs stay desynchronized over training.
            reset_mask = done
            fresh_theta = self.rng.normal(
                0.0, PHYSICS["initialPerturbationRad"], size=(int(reset_mask.sum()), self.joint_count)
            ).astype(np.float32)
            fresh_theta_dot = self.rng.normal(
                0.0, 0.02, size=(int(reset_mask.sum()), self.joint_count)
            ).astype(np.float32)
            self.theta[reset_mask] = fresh_theta
            self.theta_dot[reset_mask] = fresh_theta_dot
            self.steps[reset_mask] = 0
            self.max_steps[reset_mask] = self.rng.integers(
                EPISODE_CONTROL_STEPS // 2, EPISODE_CONTROL_STEPS + 1, size=int(reset_mask.sum())
            )
        return obs, reward, done, fallen


class ActorCritic(torch.nn.Module):
    def __init__(self, obs_size, act_size, hidden=128):
        super().__init__()
        self.body = torch.nn.Sequential(
            torch.nn.Linear(obs_size, hidden),
            torch.nn.Tanh(),
            torch.nn.Linear(hidden, hidden),
            torch.nn.Tanh(),
        )
        self.mu = torch.nn.Linear(hidden, act_size)
        self.value = torch.nn.Linear(hidden, 1)
        self.log_std = torch.nn.Parameter(torch.full((act_size,), -0.7))

    def forward(self, obs):
        h = self.body(obs)
        return self.mu(h), self.value(h).squeeze(-1)

    def distribution(self, obs):
        mu, _ = self.forward(obs)
        std = self.log_std.clamp(-1.5, 0.0).exp().expand_as(mu)
        return torch.distributions.Normal(mu, std)

    def act(self, obs, deterministic=False):
        dist = self.distribution(obs)
        action = dist.mean if deterministic else dist.sample()
        return action.clamp(-1.0, 1.0), dist.log_prob(action.clamp(-1.0, 1.0)).sum(-1)


def evaluate_policy(model, joint_count, command_size, control_dt, physics_dt, decimation,
                    seed, episodes=EVAL_EPISODES, collect_jsonl=False):
    """Run whole episodes without auto-reset; record true per-episode stats.

    Episodes run one at a time (a few hundred single-env steps each) because
    an obviously-correct serial loop beats a masked vectorized one here.
    """
    was_training = model.training
    model.eval()
    device = next(model.parameters()).device
    env = PendulumChain(1, joint_count, command_size, seed)
    returns, lengths, fell_flags = [], [], []
    jsonl_rows = []
    with torch.no_grad():
        for episode in range(episodes):
            env.reset()
            obs = torch.from_numpy(env.observe()).to(device)
            episode_return = 0.0
            steps = 0
            fell = False
            for step in range(EPISODE_CONTROL_STEPS):
                action, _ = model.act(obs, deterministic=True)
                next_obs, reward, done, fallen_now = env.step(
                    action.cpu().numpy(), physics_dt, decimation, auto_reset=False
                )
                episode_return += float(reward[0])
                steps += 1
                if collect_jsonl and episode == 0 and step < 200:
                    jsonl_rows.append({
                        "t": round(step * control_dt, 4),
                        "observation": [round(float(v), 6) for v in obs.cpu().numpy()[0]],
                        "action": [round(float(v), 6) for v in action.cpu().numpy()[0]],
                        "reward": round(float(reward[0]), 6),
                        "done": bool(done[0]),
                        "fall": bool(fallen_now[0]),
                    })
                obs = torch.from_numpy(next_obs).to(device)
                if done[0]:
                    fell = bool(fallen_now[0])
                    break
            returns.append(episode_return)
            lengths.append(steps)
            fell_flags.append(fell)
    if was_training:
        model.train()
    survived = sum(1 for flag in fell_flags if not flag)
    return {
        "episodeReward": float(np.mean(returns)),
        "meanStepReward": float(np.mean([r / max(s, 1) for r, s in zip(returns, lengths)])),
        "successRate": survived / episodes,
        "fallRate": float(np.mean(fell_flags)),
        "episodeLength": float(np.mean(lengths)),
        "jsonl": jsonl_rows,
    }


def measure_control_latency_ms(model, obs_size, control_dt):
    """Single-sample inference latency for the one-thread CPU budget."""
    model.eval()
    sample = torch.zeros(1, obs_size)
    with torch.no_grad():
        model.act(sample, deterministic=True)  # warm-up
        timings = []
        for _ in range(32):
            started = time.perf_counter()
            model.act(sample, deterministic=True)
            timings.append((time.perf_counter() - started) * 1000.0)
    return round(float(np.median(timings)), 3)


def export_onnx(model, obs_size, act_size, path):
    model.eval()
    dummy = torch.zeros(1, obs_size)

    class ActorOnly(torch.nn.Module):
        def __init__(self, ac):
            super().__init__()
            self.ac = ac

        def forward(self, observation):
            mu, _ = self.ac.forward(observation)
            return mu.clamp(-1.0, 1.0)

    actor = ActorOnly(model)
    import warnings
    with warnings.catch_warnings():
        # The legacy TorchScript exporter emits a migration DeprecationWarning
        # on torch>=2.9; it would otherwise dominate the worker-captured stderr.
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            actor,
            (dummy,),
            path,
            input_names=["observation"],
            output_names=["action"],
            dynamic_axes={"observation": {0: "batch"}, "action": {0: "batch"}},
            opset_version=13,
        )
    return os.path.getsize(path)


def train(request):
    contract = request["contract"]
    model_info = request["model"]
    training = request.get("training") or {}
    joint_count = int(contract.get("jointCount", JOINT_COUNT))
    obs_size = int(contract["observationSize"])
    act_size = int(contract["actionSize"])
    control_hz = int(contract.get("controlHz", 50))
    physics_dt = float(contract.get("physicsTimestepSeconds", 0.002))
    decimation = int(contract.get("decimation", max(1, round(control_hz * physics_dt))))
    control_dt = 1.0 / control_hz
    command_size = obs_size - 3 * joint_count
    if command_size < 0:
        raise ValueError("contract.observationSize too small for the 3x joint observation layout")
    if command_size == 0:
        command_size = 1  # degenerate command channel keeps the layout uniform
    if act_size != joint_count:
        raise ValueError("contract.actionSize must equal contract.jointCount for this engine")

    profile = str(training.get("profile", "smoke"))
    budget = PROFILE_BUDGETS.get(profile, PROFILE_BUDGETS["smoke"])
    iterations = env_int("RDK_STARTER_ENGINE_ITERATIONS", 0) or clamp_int(
        training.get("maxIterations"), 1, budget["iterations"], min(budget["iterations"], 40)
    )
    num_envs = env_int("RDK_STARTER_ENGINE_ENVS", 0) or clamp_int(
        training.get("numEnvs"), 1, budget["envs"], budget["envs"]
    )
    rollout_steps = env_int("RDK_STARTER_ENGINE_STEPS", budget["steps"])
    model_id = str(model_info.get("modelId", "starter-ppo"))
    version = str(model_info.get("version", "0.1.0"))

    requested_device, device_name, cuda_requested = resolve_device()
    torch.set_num_threads(TORCH_THREADS if requested_device.type == "cpu" else max(TORCH_THREADS, 4))
    stdout(
        "engine=start task=pendulum-chain-{}j profile={} iters={} envs={} steps={} obs={} act={} control={}Hz device={}{}".format(
            joint_count, profile, iterations, num_envs, rollout_steps, obs_size, act_size, control_hz,
            requested_device.type, " ({})".format(device_name) if device_name != "cpu" else "",
        )
    )
    if not HAVE_ONNX:
        stdout("onnx wheel missing; ONNX export will be skipped ({})".format(ONNX_MISSING_HINT))

    env = PendulumChain(num_envs, joint_count, command_size, seed=7)
    device = requested_device
    model = ActorCritic(obs_size, act_size).to(device)
    # One optimizer over the full parameter set (shared body + actor head +
    # critic head) with the composite PPO loss; a split optimizer adds
    # bookkeeping without changing the CPU starter result.
    model_opt = torch.optim.Adam(model.parameters(), lr=PPO_HYPERPARAMS["actorLr"])
    to_tensor = lambda array: torch.from_numpy(array).to(device)  # noqa: E731 - local shim
    initial_eval = evaluate_policy(model, joint_count, command_size, control_dt, physics_dt, decimation, seed=11)
    stdout(
        "eval before training: stepReward={:.3f} successRate={:.2f}".format(
            initial_eval["meanStepReward"], initial_eval["successRate"]
        )
    )

    gamma = PPO_HYPERPARAMS["gamma"]
    lam = PPO_HYPERPARAMS["gaeLambda"]
    clip = PPO_HYPERPARAMS["clip"]
    reward_curve = []
    started = time.time()
    for iteration in range(iterations):
        batch_obs, batch_act, batch_logp, batch_val, batch_rew, batch_done = [], [], [], [], [], []
        obs = to_tensor(env.observe())
        for _ in range(rollout_steps):
            with torch.no_grad():
                dist = model.distribution(obs)
                action = dist.sample().clamp(-1.0, 1.0)
                logp = dist.log_prob(action).sum(-1)
                value = model.forward(obs)[1]
            next_obs_np, reward, done, _ = env.step(action.cpu().numpy(), physics_dt, decimation)
            batch_obs.append(obs)
            batch_act.append(action)
            batch_logp.append(logp)
            batch_val.append(value)
            batch_rew.append(to_tensor(reward))
            batch_done.append(to_tensor(done.astype(np.float32)))
            obs = to_tensor(next_obs_np)

        rewards = torch.stack(batch_rew)
        values = torch.stack(batch_val)
        dones = torch.stack(batch_done)
        # GAE advantages with a terminal bootstrap of zero (auto-reset env:
        # done flags mark where the value target restarts).
        adv = torch.zeros_like(rewards, device=device)
        last_gae = 0.0
        with torch.no_grad():
            next_value = torch.zeros(num_envs, device=device)
            for t in reversed(range(rollout_steps)):
                delta = rewards[t] + gamma * next_value * (1.0 - dones[t]) - values[t]
                last_gae = delta + gamma * lam * (1.0 - dones[t]) * last_gae
                adv[t] = last_gae
                next_value = values[t]
            returns = adv + values

        flat_obs = torch.cat(batch_obs)
        flat_act = torch.cat(batch_act)
        flat_logp = torch.cat(batch_logp)
        flat_adv = adv.reshape(-1)
        flat_ret = returns.reshape(-1)
        flat_adv = (flat_adv - flat_adv.mean()) / (flat_adv.std() + 1e-8)

        dataset = torch.utils.data.TensorDataset(flat_obs, flat_act, flat_logp, flat_adv, flat_ret)
        loader = torch.utils.data.DataLoader(
            dataset,
            batch_size=min(PPO_HYPERPARAMS["minibatch"], flat_obs.shape[0]),
            shuffle=True,
        )
        for _ in range(PPO_HYPERPARAMS["epochs"]):
            for mb_obs, mb_act, mb_logp, mb_adv, mb_ret in loader:
                dist = model.distribution(mb_obs)
                new_logp = dist.log_prob(mb_act).sum(-1)
                ratio = (new_logp - mb_logp).exp()
                policy_loss = -torch.min(
                    ratio * mb_adv,
                    ratio.clamp(1.0 - clip, 1.0 + clip) * mb_adv,
                ).mean()
                value = model.forward(mb_obs)[1]
                value_loss = (mb_ret - value).pow(2).mean()
                entropy = dist.entropy().sum(-1).mean()
                loss = (
                    policy_loss
                    + PPO_HYPERPARAMS["valueCoef"] * value_loss
                    - PPO_HYPERPARAMS["entropyCoef"] * entropy
                )
                model_opt.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), PPO_HYPERPARAMS["maxGradNorm"])
                model_opt.step()

        reward_curve.append(round(float(rewards.mean()), 4))
        if (iteration + 1) % max(1, iterations // 8) == 0:
            stdout(
                "iter {}/{} meanStepReward={:.3f} elapsed={:.1f}s".format(
                    iteration + 1, iterations, rewards.mean(), time.time() - started
                )
            )

    final_eval = evaluate_policy(
        model, joint_count, command_size, control_dt, physics_dt, decimation,
        seed=11, collect_jsonl=True,
    )
    baseline_eval = evaluate_policy(
        ActorCritic(obs_size, act_size).to(device), joint_count, command_size, control_dt, physics_dt,
        decimation, seed=11, collect_jsonl=True,
    )
    stdout(
        "eval after training: stepReward={:.3f} successRate={:.2f} (baseline {:.3f}/{:.2f})".format(
            final_eval["meanStepReward"], final_eval["successRate"],
            baseline_eval["meanStepReward"], baseline_eval["successRate"],
        )
    )
    # The latency figure describes the board-like one-thread CPU budget the
    # artifact targets, so it is always measured on CPU — a GPU training run
    # must not advertise GPU inference latency.
    latency = measure_control_latency_ms(model.to("cpu"), obs_size, control_dt)
    model = model.to(device)

    onnx_bytes = 0
    if HAVE_ONNX:
        try:
            onnx_bytes = export_onnx(model.to("cpu"), obs_size, act_size, "policy.onnx")
            model = model.to(device)
            stdout("exported policy.onnx ({} bytes)".format(onnx_bytes))
        except Exception as error:  # noqa: BLE001 - export failure must not lose the run
            model = model.to(device)
            stdout("ONNX export failed: {}; continuing without it".format(error))

    with open("telemetry.jsonl", "w") as handle:
        for row in final_eval["jsonl"]:
            handle.write(json.dumps(row) + "\n")
    with open("baseline-telemetry.jsonl", "w") as handle:
        for row in baseline_eval["jsonl"]:
            handle.write(json.dumps(row) + "\n")
    with open("training-summary.json", "w") as handle:
        json.dump(
            {
                "engine": "starter-ppo",
                "task": "pendulum-chain-{}j".format(joint_count),
                "profile": profile,
                "iterations": iterations,
                "numEnvs": num_envs,
                "rolloutSteps": rollout_steps,
                "hyperparams": PPO_HYPERPARAMS,
                "physics": PHYSICS,
                "controlHz": control_hz,
                "physicsTimestepSeconds": physics_dt,
                "decimation": decimation,
                "rewardCurve": reward_curve,
                "device": requested_device.type,
                **({"deviceName": device_name} if device_name != "cpu" else {}),
                **({"cudaRequested": True} if cuda_requested and requested_device.type != "cuda" else {}),
                "eval": {k: v for k, v in final_eval.items() if k != "jsonl"},
                "baseline": {k: v for k, v in baseline_eval.items() if k != "jsonl"},
                "controlLatencyMs": latency,
                "onnxExported": bool(onnx_bytes),
                "trainingSeconds": round(time.time() - started, 1),
            },
            handle,
            indent=2,
        )

    slug_model = safe_slug(model_id, "starter-ppo")
    slug_version = safe_slug(version, "0-1-0")
    result = {
        "checkpoint": {
            "checkpointId": "starter-ppo-{}".format(slug_version),
            "artifactRef": "artifact://starter/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": iterations,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://starter/{}/{}/policy.onnx".format(slug_model, slug_version),
            "kind": "source",
            "format": "onnx" if onnx_bytes else "unknown",
            **({"runtime": "cpu-onnx", "workload": "locomotion", "threads": 1} if onnx_bytes else {}),
            **({"sizeBytes": onnx_bytes} if onnx_bytes else {}),
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": "starter-ppo",
            "observationSize": obs_size,
            "actionSize": act_size,
            "reward": round(final_eval["episodeReward"], 4),
            "initialReward": round(initial_eval["episodeReward"], 4),
            "successRate": round(final_eval["successRate"], 4),
            "fallRate": round(final_eval["fallRate"], 4),
            "episodeLength": round(final_eval["episodeLength"], 2),
            "controlLatencyMs": latency,
            "iterations": iterations,
            "onnxExported": bool(onnx_bytes),
            "telemetrySamples": len(final_eval["jsonl"]),
        },
        "deployable": False,
        # Honest device report: true only when training actually ran on CUDA.
        # A requested-but-unavailable cuda falls back to cpu and stays false.
        "cuda": requested_device.type == "cuda",
    }
    return result


def main():
    request_path = os.environ.get("RDK_SIM2REAL_REQUEST_FILE", "").strip()
    result_path = os.environ.get("RDK_SIM2REAL_RESULT_FILE", "").strip()
    if not request_path or not result_path:
        print(
            "RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required; "
            "run this through local-training-worker.mjs",
            file=sys.stderr,
        )
        sys.exit(2)
    with open(request_path) as handle:
        request = json.load(handle)
    if request.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")
    contract = request.get("contract") or {}
    if int(contract.get("observationSize", 0)) <= 0 or int(contract.get("actionSize", 0)) <= 0:
        raise ValueError("contract.observationSize and contract.actionSize are required")

    result = train(request)
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    stdout("wrote result with real PPO training artifacts")


if __name__ == "__main__":
    main()
