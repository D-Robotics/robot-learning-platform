"""Independent known-task learning check; explicitly not OriginMan evidence."""

import argparse
import json
from pathlib import Path

import gymnasium as gym
import numpy as np
import stable_baselines3 as sb3
import torch
from monitor import digest, write_json
from stable_baselines3.common.env_util import make_vec_env


def evaluate(act):
    env = gym.make("CartPole-v1")
    scores = []
    for seed in range(8100, 8120):
        obs, _ = env.reset(seed=seed)
        total = 0.0
        while True:
            obs, reward, terminated, truncated, _ = env.step(act(obs))
            total += reward
            if terminated or truncated:
                break
        scores.append(total)
    env.close()
    return scores


def run(out):
    out.mkdir(parents=True, exist_ok=False)
    write_json(
        out / "plan.json",
        {
            "environment": "CartPole-v1",
            "trainingSteps": 50000,
            "trainSeed": 7,
            "evaluationSeeds": list(range(8100, 8120)),
            "criterionMean": 400,
            "scope": "trainer sanity check only; cannot validate OriginMan dynamics or hardware",
            "versions": {
                "sb3": sb3.__version__,
                "gymnasium": gym.__version__,
                "torch": torch.__version__,
            },
            "sourceSha256": digest(Path(__file__)),
        },
    )
    rng = np.random.default_rng(7)
    random_scores = evaluate(lambda obs: int(rng.integers(2)))
    vec = make_vec_env("CartPole-v1", n_envs=8, seed=7)
    model = sb3.PPO(
        "MlpPolicy",
        vec,
        seed=7,
        device="cpu",
        n_steps=128,
        batch_size=256,
        n_epochs=5,
        verbose=0,
    )
    model.learn(total_timesteps=50000)
    scores = evaluate(lambda obs: int(model.predict(obs, deterministic=True)[0]))
    model.save(out / "policy.zip")
    result = {
        "randomScores": random_scores,
        "ppoScores": scores,
        "randomMean": float(np.mean(random_scores)),
        "ppoMean": float(np.mean(scores)),
        "passed": bool(np.mean(scores) >= 400),
        "notRobotEvidence": True,
    }
    write_json(out / "results.json", result)
    vec.close()
    print(json.dumps(result), flush=True)
    if not result["passed"]:
        raise RuntimeError("known-task learning sanity check failed")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    torch.set_num_threads(1)
    run(args.out)
