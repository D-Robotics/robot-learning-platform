"""Render unchanged final traces and fixed training checkpoints for continuous residual RL."""

import argparse
import json
import shutil
from pathlib import Path

import stable_baselines3 as sb3
from env import Config
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from residual_env import CONTROLLER, ResidualStandingGym
from sb3_evaluate import ArtifactPolicy
from stable_baselines3.common.vec_env import DummyVecEnv, VecNormalize
from standing_env import episode
from standing_render import render
from standing_sac import export


def run(root, report, font):
    chosen = json.loads((report / "results.json").read_text())
    seed = chosen["videoSeed"]
    run = root / f"standing-residual-seed{seed}"
    scene = run / "model/scene.xml"
    rows = [
        json.loads(s)
        for s in (report / "paired-records/episodes.jsonl").read_text().splitlines()
    ]
    labels = [
        "参考站姿（无反馈）",
        "冻结基础反馈",
        "基础＋未训练策略",
        "基础＋训练后RL",
    ]
    for i, row in enumerate(rows):
        row["displayLabel"] = labels[i % 4]
    paired = report / "paired-records"
    with (paired / "episodes.jsonl").open("w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    render(scene, paired, report / "recovery.mp4", chosen["videoCase"], font)
    if chosen["failureCase"] is not None:
        render(scene, paired, report / "failure.mp4", chosen["failureCase"], font)
    stage = root / f"residual-training-stages-seed{seed}"
    stage.mkdir(exist_ok=False)
    capture(stage, scene)
    summary = json.loads((run / "training-summary.json").read_text())
    cfg = Config(**summary["config"])
    bridge = ResidualStandingGym(scene, cfg)
    if summary["taskParameters"] != CONTROLLER:
        raise ValueError("frozen controller mismatch")
    spec = [
        ("initial", "基础＋未训练策略"),
        ("checkpoints/policy-00100000", "10万控制步"),
        ("checkpoints/policy-00300000", "30万控制步"),
        ("final", "最终50万控制步"),
    ]
    results = []
    sources = []
    for name, label in spec:
        if name == "initial":
            actor = ArtifactPolicy(run / "initial")
            source = run / "initial/policy.onnx"
        elif name == "final":
            actor = ArtifactPolicy(run)
            source = run / "policy.onnx"
        else:
            source = run / (name + ".zip")
            model = sb3.SAC.load(source, device="cpu")
            vector = VecNormalize.load(
                run / (name + "-normalization.pkl"),
                DummyVecEnv([lambda: ResidualStandingGym(scene, cfg)]),
            )
            vector.training = False
            directory = stage / source.stem
            directory.mkdir()
            export(model, vector, directory)
            vector.close()
            actor = ArtifactPolicy(directory)
        row = {
            "controller": name,
            "displayLabel": label,
            **episode(bridge, {"force": -7.25, "start": 1.9}, actor, trace=True),
        }
        results.append(row)
        sources.append(
            {"checkpoint": str(source.relative_to(root)), "sha256": digest(source)}
        )
    with (stage / "episodes.jsonl").open("w") as f:
        for row in results:
            f.write(json.dumps(row) + "\n")
    write_json(
        stage / "plan.json",
        {
            "case": {"force": -7.25, "start": 1.9},
            "checkpoints": sources,
            "scope": "development demonstration; fixed 0/100k/300k/final checkpoints, never used for final-weight selection",
        },
    )
    finish(stage, scene)
    render(scene, stage, report / "training-stages.mp4", 0, font)
    for name in ["recovery", "failure", "training-stages"]:
        pictures = sorted(report.glob(name + "-frame*.png"))
        if pictures:
            shutil.copyfile(pictures[-1], report / (name + "-poster.png"))
    print(
        json.dumps(
            {
                "seed": seed,
                "recoveryCase": chosen["videoCase"],
                "failureCase": chosen["failureCase"],
                "stageRecovery": [r["recoverySuccess"] for r in results],
            }
        )
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True)
    p.add_argument("--font", required=True)
    a = p.parse_args()
    run(a.root, a.report, a.font)
