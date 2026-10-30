"""Episode-level PPO learns two IMU feedback gains from physical recovery rewards.

The deployed controller is PD, not a neural joint policy. This deliberately
narrow experiment separates reward-based parameter learning from per-step RL.
"""

import argparse
import json
from dataclasses import asdict
from pathlib import Path

import gymnasium as gym
import numpy as np
import stable_baselines3 as sb3
import torch
from env import Config
from evaluation_evidence import capture, finish
from monitor import RunRecorder, digest, seal_run, write_json
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import DummyVecEnv
from standing_env import CRITERIA, StandingGym, episode, feedback

GAIN_SCALES = np.array([3.0, 0.6])


def gains(action):
    return [*(np.clip(action, -1, 1) * GAIN_SCALES).tolist(), 0.0, 0.0]


def score(row):
    if row["fallen"]:
        return -5 + row["seconds"] / 6
    return float(
        2
        + 4 * row["settledFraction"]
        + 4 * row["recoverySuccess"]
        - 0.02 * row["peakTiltDegrees"]
        - 0.1 * row["finalAngularSpeed"]
    )


class GainTrial(gym.Env):
    def __init__(self, scene, config, seed):
        self.bridge = StandingGym(scene, config)
        self.rng = np.random.default_rng(seed)
        self.count = 0
        self.action_space = gym.spaces.Box(-1, 1, shape=(2,), dtype=np.float32)
        self.observation_space = gym.spaces.Box(1, 1, shape=(1,), dtype=np.float32)

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        return np.ones(1, dtype=np.float32), {}

    def step(self, action):
        self.count += 1
        case = {
            "force": 0.0
            if self.rng.random() < 0.2
            else float(self.rng.choice([-6.75, 6.75])),
            "start": float(self.rng.uniform(1.5, 3.0)),
        }
        chosen = gains(action)
        row = episode(
            self.bridge,
            case,
            lambda obs: feedback(self.bridge, chosen),
            trace=self.count % 16 == 0,
        )
        return (
            np.ones(1, dtype=np.float32),
            score(row),
            True,
            False,
            {"trial": row, "gains": chosen},
        )


class GainRecorder(BaseCallback):
    def __init__(self, rec):
        super().__init__()
        self.rec, self.iteration, self.batch = rec, 0, []
        self.log = (rec.out / "telemetry.jsonl").open("w")
        self.episodes = (rec.out / "episodes.jsonl").open("w")

    def _on_step(self):
        for i, info in enumerate(self.locals["infos"]):
            row = info["trial"]
            lean = {k: v for k, v in row.items() if k != "frames"}
            self.batch.append((score(row), bool(row["recoverySuccess"])))
            self.episodes.write(
                json.dumps(
                    {
                        **lean,
                        "trialNumber": self.num_timesteps,
                        "environment": i,
                        "gains": info["gains"],
                        "learningReward": score(row),
                    }
                )
                + "\n"
            )
            if "frames" in row:
                self.rec.trace(self.num_timesteps + i, row["frames"])
        self.episodes.flush()
        return True

    def _on_rollout_end(self):
        self.iteration += 1
        chosen = gains(
            self.model.predict(np.ones(1, dtype=np.float32), deterministic=True)[0]
        )
        point = {
            "iteration": self.iteration,
            "timesteps": self.num_timesteps,
            "unit": "complete physical recovery episodes",
            "meanReward": float(np.mean([r[0] for r in self.batch])),
            "sampledRecoveryFraction": float(np.mean([r[1] for r in self.batch])),
            "gains": chosen,
        }
        self.batch.clear()
        self.log.write(json.dumps(point) + "\n")
        self.log.flush()
        self.rec.status("training", timesteps=self.num_timesteps, latest=point)
        self.rec.emit("gain-training", point)
        self.model.save(self.rec.out / "checkpoints" / f"gain-{self.num_timesteps:05d}")
        print(
            f"[gain-ppo] episodes={self.num_timesteps} reward={point['meanReward']:.3f} recovery={point['sampledRecoveryFraction']:.2f} gains={chosen[:2]}",
            flush=True,
        )


def train(scene, experiment, out, total, seed):
    cfg = Config(**experiment["environment"])
    identity = {
        "environment": asdict(cfg),
        "training": {
            "algorithm": "PPO",
            "policyScope": "one gain decision per full physical episode; runtime PD at 50Hz",
            "seed": seed,
            "totalEpisodes": total,
            "numEnvs": 4,
            "stepsPerRollout": 16,
            "batchSize": 64,
            "epochs": 8,
            "learningRate": 0.003,
            "gamma": 0,
            "trainForceN": [-6.75, 6.75],
            "noForceFraction": 0.2,
            "startRangeSeconds": [1.5, 3.0],
            "actionToGainScales": GAIN_SCALES.tolist(),
            "hipGains": [0, 0],
            "initialGains": [0, 0, 0, 0],
            "teacherLabels": False,
            "criteria": CRITERIA,
            "reward": "fallen: -5+t/6; otherwise 2+4*settledFraction+4*recovered-.02*peakTilt-.1*finalAngularSpeed",
        },
    }
    rec = RunRecorder(out, scene, identity)
    callback, vector = None, None
    try:
        envs = [GainTrial(rec.scene, cfg, seed + i) for i in range(4)]
        vector = DummyVecEnv([lambda e=e: e for e in envs])
        model = sb3.PPO(
            "MlpPolicy",
            vector,
            device="cpu",
            seed=seed,
            n_steps=16,
            batch_size=64,
            n_epochs=8,
            learning_rate=0.003,
            gamma=0,
            ent_coef=0.001,
            policy_kwargs={"net_arch": {"pi": [], "vf": [16]}, "log_std_init": -0.5},
            verbose=0,
        )
        torch.nn.init.zeros_(model.policy.action_net.weight)
        torch.nn.init.zeros_(model.policy.action_net.bias)
        model.save(out / "initial-policy.zip")
        callback = GainRecorder(rec)
        model.learn(total_timesteps=total, callback=callback)
        model.save(out / "policy.zip")
        chosen = gains(
            model.predict(np.ones(1, dtype=np.float32), deterministic=True)[0]
        )
        write_json(
            out / "gains.json",
            {
                "coefficients": chosen,
                "scope": "learned ankle roll PD; hip residual zero",
                "hardwareEligible": False,
            },
        )
        summary = {
            "config": asdict(cfg),
            "seed": seed,
            "actualPhysicalEpisodes": model.num_timesteps,
            "algorithm": "PPO",
            "policyScope": identity["training"]["policyScope"],
            "coefficients": chosen,
            "initialCoefficients": [0, 0, 0, 0],
            "hardwareEligible": False,
            "sourceChangedDuringRun": any(
                digest(Path(__file__).parent / f) != h
                for f, h in rec.identity["sourceSha256"].items()
                if f != "reused-actor.py"
            ),
        }
        write_json(out / "training-summary.json", summary)
        rec.status("completed", timesteps=model.num_timesteps)
        rec.emit("completed", summary)
        print(json.dumps(summary), flush=True)
    except BaseException:
        rec.fail()
        raise
    finally:
        if callback:
            callback.log.close()
            callback.episodes.close()
        if vector:
            vector.close()
        rec.close()
        seal_run(out)
    write_json(
        out / "gain-evidence.json",
        {
            "files": {
                str(p.relative_to(out)): {"sha256": digest(p)}
                for p in out.rglob("*")
                if p.is_file() and p.name != "gain-evidence.json"
            },
            "scope": "post-training local integrity",
        },
    )


def evaluate(run, pd_path, plan_path, out):
    receipt = json.loads((run / "gain-evidence.json").read_text())
    if any(digest(run / p) != v["sha256"] for p, v in receipt["files"].items()):
        raise ValueError("gain training artifact integrity failed")
    plan = json.loads(plan_path.read_text())
    if run.name not in plan["plannedRuns"]:
        raise ValueError("unplanned final run")
    summary = json.loads((run / "training-summary.json").read_text())
    scene = run / "model/scene.xml"
    bridge = StandingGym(scene, Config(**summary["config"]))
    selected = json.loads((run / "gains.json").read_text())["coefficients"]
    classic = json.loads(pd_path.read_text())["coefficients"]
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    write_json(
        out / "plan.json",
        {
            **plan,
            "gainSha256": digest(run / "gains.json"),
            "policyScope": summary["policyScope"],
            "criteria": CRITERIA,
        },
    )
    rows = []
    for case in plan["cases"]:
        for mode, coefficients in [
            ("reference", [0, 0, 0, 0]),
            ("imu-feedback", classic),
            ("untrained", [0, 0, 0, 0]),
            ("rl", selected),
        ]:
            row = {
                "controller": mode,
                **episode(
                    bridge,
                    case,
                    lambda obs, g=coefficients: feedback(bridge, g),
                    trace=True,
                ),
            }
            rows.append(row)
            with (out / "episodes.jsonl").open("a") as f:
                f.write(json.dumps(row) + "\n")
    result = {}
    for mode in ["reference", "imu-feedback", "untrained", "rl"]:
        cases = [r for r in rows if r["controller"] == mode]
        result[mode] = {
            "recoverySuccesses": sum(r["recoverySuccess"] for r in cases),
            "falls": sum(r["fallen"] for r in cases),
            "cases": len(cases),
        }
    write_json(out / "summary.json", result)
    finish(out, scene)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    s = p.add_subparsers(dest="command", required=True)
    t = s.add_parser("train")
    t.add_argument("--scene", type=Path, required=True)
    t.add_argument("--experiment", type=Path, required=True)
    t.add_argument("--out", type=Path, required=True)
    t.add_argument("--episodes", type=int, default=2048)
    t.add_argument("--seed", type=int, default=7)
    e = s.add_parser("evaluate")
    e.add_argument("--run", type=Path, required=True)
    e.add_argument("--feedback", type=Path, required=True)
    e.add_argument("--plan", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    torch.set_num_threads(1)
    if a.command == "train":
        train(a.scene, json.loads(a.experiment.read_text()), a.out, a.episodes, a.seed)
    else:
        evaluate(a.run, a.feedback, a.plan, a.out)
