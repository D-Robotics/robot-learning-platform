"""Residual PPO, reusing the platform football engine's generic ActorCritic.

No teacher labels, base force, trajectory teleport, or reward-only evaluation.
Finite-horizon truncations bootstrap the actual terminal observation; falls do
not. Training exports a 41 -> 10 ONNX policy with independent ORT parity.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "microduck-football"))
from env import Config, OriginManEnv
from monitor import LearnerConfig, RunRecorder, parse_experiment, seal_run, write_json
from policy import ResidualActorCritic
from validation import ValidationProbe


def train(
    scene,
    out,
    iterations=120,
    num_envs=8,
    steps=128,
    seed=7,
    config=None,
    learner=None,
    parent=None,
    warm_start=None,
):
    learner = learner or LearnerConfig()
    cfg = config or Config()
    experiment = {
        "environment": asdict(cfg),
        "training": {
            "iterations": iterations,
            "num_envs": num_envs,
            "steps": steps,
            "seed": seed,
            **asdict(learner),
        },
    }
    parse_experiment(experiment)
    rec = RunRecorder(out, scene, experiment, parent=parent, warm_start=warm_start)
    try:
        result = _train(
            rec.scene,
            out,
            iterations,
            num_envs,
            steps,
            seed,
            cfg,
            learner,
            rec,
            warm_start,
        )
        rec.status("completed", iteration=iterations, totalIterations=iterations)
        rec.emit(
            "completed",
            {
                "iteration": iterations,
                "onnxParityMaxAbsError": result["onnxParityMaxAbsError"],
            },
        )
        return result
    except BaseException:
        rec.fail()
        raise
    finally:
        rec.close()
        seal_run(out)


def _train(
    scene, out, iterations, num_envs, steps, seed, config, learner, rec, warm_start
):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(1)
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    cfg = config or Config()
    first = OriginManEnv(scene, cfg, seed)
    envs = [first] + [
        OriginManEnv(scene, cfg, seed + i, reference=first.reference)
        for i in range(1, num_envs)
    ]
    policy = ResidualActorCritic(41, 10, learner.value_network)
    torch.nn.init.zeros_(policy.mean.weight)
    torch.nn.init.zeros_(policy.mean.bias)
    policy.log_std.data.fill_(-2.0)
    if warm_start:
        checkpoint = torch.load(warm_start, map_location="cpu", weights_only=True)
        if checkpoint.get("policyArchitecture", "shared") != learner.value_network:
            raise ValueError("warm-start critic architecture does not match experiment")
        policy.load_state_dict(checkpoint["state_dict"])
    optimizer = torch.optim.Adam(policy.parameters(), lr=learner.learning_rate)
    probe = ValidationProbe(scene, cfg, first.reference, learner.validation_seconds)
    (out / "validation").mkdir()
    episodes = (out / "episodes.jsonl").open("w")
    episode_returns = np.zeros(num_envs)
    episode_ids = np.zeros(num_envs, dtype=int)
    rec.status("training", iteration=0, totalIterations=iterations)

    def reset(e):
        return e.reset(
            asymmetry=rng.uniform(
                -learner.reset_asymmetry_range, learner.reset_asymmetry_range
            ),
            initial_yaw=rng.uniform(-learner.reset_yaw_range, learner.reset_yaw_range),
        )

    obs = np.stack([reset(e) for e in envs])
    curve = []
    started = time.monotonic()
    completed = 0
    falls = 0
    log = (out / "telemetry.jsonl").open("w")
    for it in range(1, iterations + 1):
        ob = []
        raw = []
        lp = []
        val = []
        rew = []
        done = []
        nextval = []
        reward_parts = []
        dynamics = []
        frames = []
        enabled_buf = []
        trace_iteration = it == 1 or it == iterations or it % learner.trace_every == 0
        for t in range(steps):
            with torch.no_grad():
                mean, v = policy(torch.tensor(obs))
                dist = torch.distributions.Normal(mean, policy.log_std.exp())
                u = dist.sample()
                a = u.tanh()
                l = dist.log_prob(u).sum(-1)
            ob.append(obs.copy())
            raw.append(u.numpy())
            lp.append(l.numpy())
            val.append(v.numpy())
            rewards = []
            dones = []
            nextobs = []
            terminalobs = []
            terminalfalls = []
            enabled_step = []
            for i, e in enumerate(envs):
                o, r, d, info = e.step(a[i].numpy())
                enabled_step.append(info["recoveryGate"] > 0)
                if i == 0 and trace_iteration:
                    frames.append(
                        {
                            "iteration": it,
                            "rolloutStep": t,
                            "episodeIndex": int(episode_ids[i]),
                            "requestedAction": a[i].numpy().tolist(),
                            **info,
                            **e.diagnostic_frame(),
                        }
                    )
                reward_parts.append(info["rewardTerms"])
                dynamics.append(
                    {
                        "x": info["x"],
                        "y": info["y"],
                        "yaw": info["yaw"],
                        "velocity": info["forwardVelocity"],
                        "rateLimited": info["residualRateLimitedFraction"],
                        "trackingError": float(
                            np.mean(abs(e.data.qpos[e.qa] - e.data.ctrl[e.leg_a]))
                        ),
                        "actionAbs": float(np.mean(abs(e.last_action))),
                    }
                )
                episode_returns[i] += r
                terminalobs.append(o)
                terminalfalls.append(info["fallen"])
                rewards.append(r)
                dones.append(d)
                if d:
                    completed += 1
                    falls += int(info["fallen"])
                    episodes.write(
                        json.dumps(
                            {
                                "iteration": it,
                                "environment": i,
                                "episodeIndex": int(episode_ids[i]),
                                "return": float(episode_returns[i]),
                                "asymmetry": e.asymmetry,
                                "initialYaw": e.initial_yaw,
                                **info,
                            }
                        )
                        + "\n"
                    )
                    episodes.flush()
                    episode_returns[i] = 0
                    episode_ids[i] += 1
                    o = reset(e)
                nextobs.append(o)
            with torch.no_grad():
                _, nv = policy(torch.tensor(np.stack(terminalobs)))
            nv = nv.numpy()
            nv[np.array(terminalfalls)] = 0
            nextval.append(nv)
            rew.append(rewards)
            enabled_buf.append(enabled_step)
            done.append(dones)
            obs = np.stack(nextobs)
        raw_rewards = np.array(rew, dtype=np.float32)
        rewards = raw_rewards * learner.reward_scale
        values = np.array(val)
        dones = np.array(done)
        adv = np.zeros_like(rewards)
        last = np.zeros(num_envs)
        for t in reversed(range(steps)):
            delta = rewards[t] + learner.gamma * nextval[t] - values[t]
            last = delta + learner.gamma * learner.gae_lambda * (~dones[t]) * last
            adv[t] = last
        returns = adv + values
        o = torch.tensor(np.array(ob).reshape(-1, 41))
        u = torch.tensor(np.array(raw).reshape(-1, 10))
        oldlp = torch.tensor(np.array(lp).reshape(-1))
        advantages = torch.tensor(adv.reshape(-1))
        enabled = torch.tensor(np.array(enabled_buf).reshape(-1), dtype=torch.bool)
        if enabled.any():
            active_adv = advantages[enabled]
            advantages = (advantages - active_adv.mean()) / (
                active_adv.std(unbiased=False) + 1e-8
            )
        ret = torch.tensor(returns.reshape(-1))
        losses = []
        kl_stopped = False
        for epoch in range(learner.update_epochs):
            for ids in torch.randperm(len(o)).split(learner.minibatch):
                mean, v = policy(o[ids])
                dist = torch.distributions.Normal(mean, policy.log_std.exp())
                logp = dist.log_prob(u[ids]).sum(-1)
                ratio = (logp - oldlp[ids]).clamp(-15, 15).exp()
                mask = enabled[ids]
                approx_kl = (
                    ((ratio - 1) - (logp - oldlp[ids]))[mask].mean()
                    if mask.any()
                    else ratio.new_zeros(())
                )
                if learner.target_kl and float(approx_kl.detach()) > learner.target_kl:
                    kl_stopped = True
                    break
                surrogate = -torch.minimum(
                    ratio * advantages[ids],
                    ratio.clamp(1 - learner.clip, 1 + learner.clip) * advantages[ids],
                )
                actor = surrogate[mask].mean() if mask.any() else ratio.new_zeros(())
                vl = 0.5 * (v - ret[ids]).square().mean()
                entropy = (
                    dist.entropy().sum(-1)[mask].mean()
                    if mask.any()
                    else ratio.new_zeros(())
                )
                loss = (
                    actor + learner.value_weight * vl - learner.entropy_weight * entropy
                )
                if not torch.isfinite(loss):
                    raise RuntimeError("nonfinite PPO loss")
                optimizer.zero_grad()
                loss.backward()
                grad_norm = torch.nn.utils.clip_grad_norm_(
                    policy.parameters(), learner.max_grad_norm
                )
                optimizer.step()
                losses.append(
                    {
                        "actorLoss": float(actor.detach()),
                        "valueLoss": float(vl.detach()),
                        "entropy": float(entropy.detach()),
                        "approxKl": float(approx_kl.detach()),
                        "clipFraction": float(
                            ((ratio - 1).abs() > learner.clip).float().mean().detach()
                        ),
                        "gradNorm": float(grad_norm),
                    }
                )
            if kl_stopped:
                break
        point = {
            "iteration": it,
            "meanReward": float(raw_rewards.mean()),
            "meanLearningReward": float(rewards.mean()),
            "klEarlyStopped": kl_stopped,
            "optimizerUpdates": len(losses),
            "actorEnabledFraction": float(enabled.float().mean()),
            "completedEpisodes": completed,
            "falls": falls,
            **{k: float(np.mean([x[k] for x in losses])) for k in losses[0]},
            "rewardTerms": {
                k: float(np.mean([r[k] for r in reward_parts])) for k in reward_parts[0]
            },
            "dynamics": {
                k: float(np.mean([d[k] for d in dynamics])) for k in dynamics[0]
            },
            "policyStd": policy.log_std.detach().exp().tolist(),
            "elapsedSeconds": time.monotonic() - started,
        }
        curve.append(point)
        if trace_iteration:
            rec.trace(it, frames)
        rec.status("training", iteration=it, totalIterations=iterations, latest=point)
        log.write(json.dumps(point) + "\n")
        log.flush()
        if it == 1 or it % 10 == 0:
            # recentSuccess remains zero until separate held-out evaluation.
            print(
                f"[originman-straight] iter {it}/{iterations} "
                f"meanReward={point['meanReward']:.6f} recentSuccess=0 "
                f"elapsed={point['elapsedSeconds']:.2f}s",
                flush=True,
            )
        if it == 1 or it == iterations or it % learner.checkpoint_every == 0:
            checkpoint = rec.checkpoint(
                it,
                {
                    "state_dict": policy.state_dict(),
                    "config": asdict(cfg),
                    "seed": seed,
                    "iteration": it,
                    "policyArchitecture": learner.value_network,
                },
            )
            with torch.no_grad():
                validation = probe.run(
                    lambda obs: policy(torch.tensor(obs[None]))[0].tanh().numpy()[0],
                    "rl",
                )
            payload = {
                "iteration": it,
                "kind": "development-validation",
                "checkpointSha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
                "reference": probe.baseline,
                "rl": validation,
            }
            write_json(out / "validation" / f"iter-{it:05d}.json", payload)
            rec.emit(
                "validation",
                {
                    "iteration": it,
                    "reference": {
                        k: v for k, v in probe.baseline.items() if k != "cases"
                    },
                    "rl": {k: v for k, v in validation.items() if k != "cases"},
                },
            )
    log.close()
    episodes.close()
    torch.save(
        {
            "state_dict": policy.state_dict(),
            "config": asdict(cfg),
            "seed": seed,
            "policyArchitecture": learner.value_network,
        },
        out / "policy.pt",
    )
    policy.eval()

    class Export(torch.nn.Module):
        def __init__(self, p):
            super().__init__()
            self.policy = p

        def forward(self, obs):
            return self.policy(obs)[0].tanh()

    export = Export(policy)
    pending = out / "policy.onnx.pending"
    torch.onnx.export(
        export,
        torch.zeros(1, 41),
        str(pending),
        input_names=["obs"],
        output_names=["actions"],
        dynamic_axes={"obs": {0: "batch"}, "actions": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    import onnx
    import onnxruntime as ort

    onnx.checker.check_model(onnx.load(pending))
    session = ort.InferenceSession(str(pending), providers=["CPUExecutionProvider"])
    probe = rng.normal(0, 0.2, (32, 41)).astype(np.float32)
    with torch.no_grad():
        expected = export(torch.tensor(probe)).numpy()
    error = float(abs(expected - session.run(None, {"obs": probe})[0]).max())
    if not np.isfinite(error) or error > 1e-5:
        raise RuntimeError("ONNX parity failed")
    pending.replace(out / "policy.onnx")
    summary = {
        "schemaVersion": 1,
        "engine": "originman-straight",
        "algorithm": "ppo",
        "physicsBackend": "cpu-mujoco-originman-fullbody",
        "observationSize": 41,
        "actionSize": 10,
        "seed": seed,
        "iterations": iterations,
        "numEnvs": num_envs,
        "stepsPerEnv": steps,
        "trainingSteps": iterations * num_envs * steps,
        "config": asdict(cfg),
        "domainRandomization": {
            "servoGainAsymmetry": [-0.2, 0.2],
            "initialYawRad": [-0.08, 0.08],
        },
        "teacherUsed": False,
        "rootAssistance": False,
        "hardwareEligible": False,
        "onnxParityMaxAbsError": error,
        "elapsedSeconds": time.monotonic() - started,
        "curve": curve,
        "runtimeVersions": {
            "python": sys.version.split()[0],
            "torch": torch.__version__,
            "numpy": np.__version__,
        },
        "reusedActorSourceSha256": hashlib.sha256(
            (
                Path(__file__).resolve().parents[1]
                / "microduck-football/train_football.py"
            ).read_bytes()
        ).hexdigest(),
        "sceneSha256": hashlib.sha256(Path(scene).read_bytes()).hexdigest(),
        "experimentSha256": rec.identity["experimentSha256"],
        "parent": rec.identity["parent"],
        "sourceChangedDuringRun": any(
            hashlib.sha256((Path(__file__).parent / f).read_bytes()).hexdigest() != sha
            for f, sha in rec.identity["sourceSha256"].items()
            if f != "reused-actor.py"
        ),
        "sourceSha256": rec.identity["sourceSha256"],
    }
    (out / "training-summary.json").write_text(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--iterations", type=int, default=120)
    p.add_argument("--num-envs", type=int, default=8)
    p.add_argument("--steps", type=int, default=128)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--experiment", type=Path)
    p.add_argument("--warm-start", type=Path)
    p.add_argument("--parent-run")
    p.add_argument("--reward-profile", choices=["legacy", "straight"], default="legacy")
    a = p.parse_args()
    if a.experiment:
        cfg, learner, budget = parse_experiment(json.loads(a.experiment.read_text()))
        train(
            a.scene,
            a.out,
            config=cfg,
            learner=learner,
            parent=a.parent_run,
            warm_start=a.warm_start,
            **budget,
        )
        raise SystemExit(0)
    train(
        a.scene,
        a.out,
        a.iterations,
        a.num_envs,
        a.steps,
        a.seed,
        Config(
            velocity_width=0.04, heading_weight=5, lateral_weight=40, progress_weight=10
        )
        if a.reward_profile == "straight"
        else Config(),
        parent=a.parent_run,
        warm_start=a.warm_start,
    )
