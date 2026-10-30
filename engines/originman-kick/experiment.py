"""Compare fixed kick, calibrated interpolation, and episodic PPO.

PPO chooses continuous stroke/duration once per kick. This is a one-step
contextual MDP over a physical joint trajectory, NOT 50Hz joint feedback RL.
The same nominal physics, objectives and final held-out cases apply to all.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "microduck-football"))
from kick_env import KickEnv, prepare_scene
from train_football import ActorCritic

TRAIN_TARGETS = [0.05, 0.09, 0.13, 0.17]
TEST_TARGETS = [0.07, 0.11, 0.15, 0.19]
SEEDS = [7, 17, 27]


def save(path, data):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, allow_nan=False))
    tmp.replace(path)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def valid(row):
    return bool(
        row["footBallContact"]
        and not row["otherRobotBallContact"]
        and not row["fallen"]
        and abs(row["ballLateralM"]) <= 0.05
        and row["finalTiltDegrees"] < 10
        and row["robotTranslationM"] < 0.05
        and row["ballSpeedMps"] < 0.005
    )


def score(row, target):
    parts = {
        "distance": float(-abs(row["ballForwardM"] - target) / 0.04),
        "direction": float(-abs(row["ballLateralM"]) / 0.05),
        "hitBonus": 1.0 if row["footBallContact"] else -1.0,
        "accuracyBonus": float(
            2 * np.exp(-(((row["ballForwardM"] - target) / 0.025) ** 2))
        ),
        "fallPenalty": -8.0 if row["fallen"] else 0.0,
        "otherContactPenalty": -3.0 if row["otherRobotBallContact"] else 0.0,
        "posturePenalty": -2.0
        if row["finalTiltDegrees"] >= 10 or row["robotTranslationM"] > 0.05
        else 0.0,
    }
    return float(sum(parts.values())), parts


def observation(target):
    return np.array([(target - 0.11) / 0.08], dtype=np.float32)


def calibrate(env, out):
    rows = []
    started = time.monotonic()
    for a in np.linspace(-1, 1, 7):
        for b in np.linspace(-1, 1, 9):
            row = env.rollout([a, b])
            row["action"] = [float(a), float(b)]
            rows.append(row)
    # Predeclared conservative baseline: longest swing duration; interpolate
    # between successful stroke calibration points. No test outcomes are used.
    anchors = sorted(
        [r for r in rows if valid(r) and r["action"][1] == 1],
        key=lambda r: r["ballForwardM"],
    )
    if len(anchors) < 3:
        raise RuntimeError("fewer than three stable baseline anchors")
    save(
        out / "calibration.json",
        {
            "cases": rows,
            "anchors": anchors,
            "elapsedSeconds": time.monotonic() - started,
            "selection": "valid fixed-duration=0.48s anchors sorted by measured distance",
        },
    )
    print(
        f"calibration {len(rows)} episodes; {sum(valid(r) for r in rows)} valid; {len(anchors)} interpolation anchors",
        flush=True,
    )
    return rows, anchors


def lookup(target, anchors):
    distances = [r["ballForwardM"] for r in anchors]
    return np.array(
        [
            np.interp(target, distances, [r["action"][i] for r in anchors])
            for i in range(2)
        ]
    )


def train(env, out, seed, iterations=12, batch=32):
    out.mkdir()
    (out / "sources").mkdir()
    (out / "checkpoints").mkdir()
    (out / "traces").mkdir()
    for p in Path(__file__).parent.glob("*.py"):
        shutil.copyfile(p, out / "sources" / p.name)
    for name in ["env.py", "model.py"]:
        shutil.copyfile(
            Path(__file__).resolve().parents[1] / "originman-straight" / name,
            out / "sources" / ("straight-" + name),
        )
    reused = (
        Path(__file__).resolve().parents[1] / "microduck-football/train_football.py"
    )
    shutil.copyfile(reused, out / "sources/reused-actor.py")
    torch.set_num_threads(1)
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    p = ActorCritic(1, 2)
    torch.nn.init.zeros_(p.mean.weight)
    torch.nn.init.zeros_(p.mean.bias)
    p.mean.bias.data[1] = 1.3
    p.log_std.data.fill_(-1.0)
    optimizer = torch.optim.Adam(p.parameters(), lr=0.001)
    identity = {
        "task": "originman-fixed-ball-distance",
        "algorithm": "one-step episodic PPO",
        "policyScope": "target distance -> continuous stroke/duration; reference joint trajectory supplies motion; not a 50Hz joint feedback policy",
        "seed": seed,
        "iterations": iterations,
        "episodesPerIteration": batch,
        "trainingTargetsM": TRAIN_TARGETS,
        "heldOutTargetsM": TEST_TARGETS,
        "trainingFriction": 0.001,
        "parameterMapping": {"strokeM": [0.012, 0.05], "durationSeconds": [0.08, 0.48]},
        "learningRate": 0.001,
        "updateEpochs": 8,
        "clip": 0.2,
        "initialMean": [0, 1.3],
        "initialLogStd": -1,
        "sourceSha256": {f.name: sha(f) for f in (out / "sources").glob("*.py")},
        "sceneSha256": sha(env.scene_path),
        "calibrationSha256": sha(out.parent / "calibration.json"),
        "hardwareEligible": False,
    }
    save(out / "experiment.json", identity)
    episodes = (out / "episodes.jsonl").open("w")
    telemetry = (out / "telemetry.jsonl").open("w")
    curve = []
    started = time.monotonic()
    for it in range(1, iterations + 1):
        targets = rng.choice(TRAIN_TARGETS, batch)
        obs = torch.tensor(np.stack([observation(t) for t in targets]))
        with torch.no_grad():
            mean, value = p(obs)
            dist = torch.distributions.Normal(mean, p.log_std.exp())
            raw = dist.sample()
            actions = raw.tanh()
            oldlp = dist.log_prob(raw).sum(-1)
        rewards = []
        rows = []
        parts = []
        for n, (target, action) in enumerate(
            zip(targets, actions.numpy(), strict=True)
        ):
            row = env.rollout(action, trace=n == 0 and it in [1, 4, 8, iterations])
            reward, terms = score(row, target)
            if "frames" in row:
                save(
                    out / "traces" / f"iter-{it:04d}.json",
                    {"targetM": float(target), "action": action.tolist(), **row},
                )
                row.pop("frames")
            episodes.write(
                json.dumps(
                    {
                        "iteration": it,
                        "episode": n,
                        "targetM": float(target),
                        "action": action.tolist(),
                        "reward": reward,
                        "rewardTerms": terms,
                        **row,
                    }
                )
                + "\n"
            )
            rewards.append(reward)
            rows.append(row)
            parts.append(terms)
        episodes.flush()
        ret = torch.tensor(rewards, dtype=torch.float32)
        adv = ret - value
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        diagnostics = []
        for epoch in range(8):
            mean, v = p(obs)
            dist = torch.distributions.Normal(mean, p.log_std.exp())
            lp = dist.log_prob(raw).sum(-1)
            logratio = lp - oldlp
            ratio = logratio.clamp(-15, 15).exp()
            kl = float(((ratio - 1) - logratio).mean().detach())
            if epoch > 0 and kl > 0.05:
                break
            actor = -torch.minimum(ratio * adv, ratio.clamp(0.8, 1.2) * adv).mean()
            vl = 0.5 * (v - ret).square().mean()
            loss = actor + 0.5 * vl - 0.002 * dist.entropy().sum(-1).mean()
            if not torch.isfinite(loss):
                raise RuntimeError("nonfinite PPO loss")
            optimizer.zero_grad()
            loss.backward()
            grad = torch.nn.utils.clip_grad_norm_(p.parameters(), 0.5)
            optimizer.step()
            diagnostics.append(
                {
                    "actorLoss": float(actor.detach()),
                    "valueLoss": float(vl.detach()),
                    "approxKl": kl,
                    "gradientNorm": float(grad),
                }
            )
        point = {
            "iteration": it,
            "episodes": it * batch,
            "meanReward": float(np.mean(rewards)),
            "meanDistanceErrorM": float(
                np.mean(
                    [
                        abs(r["ballForwardM"] - t)
                        for r, t in zip(rows, targets, strict=True)
                    ]
                )
            ),
            "validRate": float(np.mean([valid(r) for r in rows])),
            "fallRate": float(np.mean([r["fallen"] for r in rows])),
            "rewardTerms": {k: float(np.mean([d[k] for d in parts])) for k in parts[0]},
            **{k: float(np.mean([d[k] for d in diagnostics])) for k in diagnostics[0]},
            "elapsedSeconds": time.monotonic() - started,
        }
        curve.append(point)
        telemetry.write(json.dumps(point) + "\n")
        telemetry.flush()
        save(
            out / "status.json",
            {
                "state": "training",
                "iteration": it,
                "totalIterations": iterations,
                "latest": point,
            },
        )
        if it in [1, 2, 4, 8, iterations]:
            torch.save(
                {"state_dict": p.state_dict(), "seed": seed, "iteration": it},
                out / "checkpoints" / f"iter-{it:04d}.pt",
            )
        print(
            f"seed={seed} iter={it}/{iterations} error={point['meanDistanceErrorM']:.4f}m valid={point['validRate']:.2f} reward={point['meanReward']:.3f} elapsed={point['elapsedSeconds']:.1f}s",
            flush=True,
        )
    episodes.close()
    telemetry.close()
    torch.save(
        {"state_dict": p.state_dict(), "seed": seed, "iteration": iterations},
        out / "policy.pt",
    )

    class Export(torch.nn.Module):
        def __init__(self, p):
            super().__init__()
            self.p = p

        def forward(self, obs):
            return self.p(obs)[0].tanh()

    p.eval()
    export = Export(p)
    torch.onnx.export(
        export,
        torch.zeros(1, 1),
        str(out / "policy.onnx.pending"),
        input_names=["target"],
        output_names=["parameters"],
        opset_version=17,
        dynamic_axes={"target": {0: "batch"}, "parameters": {0: "batch"}},
        dynamo=False,
    )
    import onnx
    import onnxruntime as ort

    onnx.checker.check_model(onnx.load(out / "policy.onnx.pending"))
    session = ort.InferenceSession(
        str(out / "policy.onnx.pending"), providers=["CPUExecutionProvider"]
    )
    probe = np.linspace(-1, 1, 31, dtype=np.float32)[:, None]
    with torch.no_grad():
        expected = export(torch.tensor(probe)).numpy()
    error = float(abs(expected - session.run(None, {"target": probe})[0]).max())
    if not np.isfinite(error) or error > 1e-5:
        raise RuntimeError("ONNX parity failed")
    (out / "policy.onnx.pending").rename(out / "policy.onnx")
    save(
        out / "training-summary.json",
        {
            "identity": identity,
            "curve": curve,
            "onnxParityMaxAbsError": error,
            "elapsedSeconds": time.monotonic() - started,
        },
    )
    save(out / "status.json", {"state": "completed", "iteration": iterations})
    return p


def evaluate(env, out, anchors, policies):
    # Fixed predeclared held-out target distances and nuisance conditions.
    conditions = [
        ("nominal", 0.001, (0.0, 0.0)),
        ("lower-rolling-friction", 0.0008, (0.0, 0.0)),
        ("higher-rolling-friction", 0.0012, (0.0, 0.0)),
        ("ball-forward-3mm", 0.001, (0.003, 0.0)),
        ("ball-side-3mm", 0.001, (0.0, 0.003)),
    ]
    fixed = lookup(0.11, anchors)
    controllers = {
        "fixed-kick": lambda target: fixed,
        "calibrated-interpolation": lambda target: lookup(target, anchors),
    }
    for seed, p in policies.items():

        def actor(target, p=p):
            with torch.no_grad():
                return p(torch.tensor(observation(target)[None]))[0].tanh().numpy()[0]

        controllers[f"ppo-seed-{seed}"] = actor
    rows = []
    for name, act in controllers.items():
        for condition, friction, offset in conditions:
            for target in TEST_TARGETS:
                a = act(target)
                r = env.rollout(a, friction=friction, ball_offset=offset)
                r.update(
                    {
                        "controller": name,
                        "condition": condition,
                        "targetM": target,
                        "action": a.tolist(),
                        "distanceErrorM": abs(r["ballForwardM"] - target),
                        "valid": valid(r),
                    }
                )
                r["success"] = bool(r["valid"] and r["distanceErrorM"] <= 0.025)
                rows.append(r)
    aggregate = {}
    for name in controllers:
        aggregate[name] = {}
        for group in ["nominal", "all-conditions"]:
            rs = [
                r
                for r in rows
                if r["controller"] == name
                and (group == "all-conditions" or r["condition"] == "nominal")
            ]
            aggregate[name][group] = {
                "episodes": len(rs),
                "meanDistanceErrorM": float(np.mean([r["distanceErrorM"] for r in rs])),
                "successRate": float(np.mean([r["success"] for r in rs])),
                "validRate": float(np.mean([r["valid"] for r in rs])),
                "fallRate": float(np.mean([r["fallen"] for r in rs])),
            }
    report = {
        "scope": "deterministic simulation comparison, fixed physical ball position; no onboard visual localization; not hardware validation",
        "policyScope": "one stroke/duration decision per kick, reference joint trajectory; not full-joint feedback RL",
        "testTargetsM": TEST_TARGETS,
        "trainingTargetsM": TRAIN_TARGETS,
        "conditions": conditions,
        "toleranceM": 0.025,
        "calibrationEpisodes": 63,
        "rlEpisodesPerSeed": 384,
        "cases": rows,
        "aggregate": aggregate,
        "hardwareEligible": False,
    }
    save(out / "evaluation.json", report)
    print(json.dumps(aggregate, indent=2), flush=True)
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source-scene", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    if a.out.exists():
        raise SystemExit("use a new output directory to retain all previous evidence")
    a.out.mkdir(parents=True)
    scene = prepare_scene(a.source_scene, a.out / "model")
    env = KickEnv(a.out / "model/source-scene.xml", scene)
    _, anchors = calibrate(env, a.out)
    policies = {seed: train(env, a.out / f"seed-{seed}", seed) for seed in SEEDS}
    evaluate(env, a.out, anchors, policies)
