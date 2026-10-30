"""Existing local-training-worker file protocol, simulation-only artifacts.

The trusted worker supplies the scene path via environment; callers cannot
select arbitrary model paths in request.json. No hardware adapter is exposed.
"""

import hashlib
import json
import os
import re
import shutil
from pathlib import Path

from env import Config
from evaluate import evaluate
from train import train


def bounded(value, default, low, high):
    if value is None:
        return default
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not low <= value <= high
    ):
        raise ValueError("training budget out of range")
    return value


def main():
    request_file = Path(os.environ["RDK_SIM2REAL_REQUEST_FILE"])
    result_file = Path(os.environ["RDK_SIM2REAL_RESULT_FILE"])
    scene = Path(os.environ["ORIGINMAN_SCENE"]).resolve()
    request = json.loads(request_file.read_text())
    if (
        request.get("schemaVersion") != 1
        or request.get("taskId") != "originman-straight-residual"
    ):
        raise ValueError("expected schema 1 and originman-straight-residual")
    contract = request.get("contract", {})
    if (contract.get("observationSize"), contract.get("actionSize")) != (41, 10):
        raise ValueError("expected 41D -> 10D contract")
    spec = request.get("training", {})
    if spec.get("algorithm", "ppo") != "ppo":
        raise ValueError("only PPO is implemented")
    out = result_file.parent
    out.mkdir(parents=True, exist_ok=True)
    # Local source/model snapshots are hashed for reproducibility, not deployed.
    snapshot = out
    for name in [
        "model.py",
        "env.py",
        "train.py",
        "evaluate.py",
        "platform_adapter.py",
    ]:
        shutil.copyfile(Path(__file__).parent / name, snapshot / ("source-" + name))
    shutil.copyfile(
        Path(__file__).resolve().parents[1] / "microduck-football/train_football.py",
        out / "source-reused-actor.py",
    )
    cfg = Config()
    summary = train(
        scene,
        out,
        iterations=bounded(spec.get("maxIterations"), 120, 1, 5000),
        num_envs=bounded(spec.get("numEnvs"), 8, 1, 64),
        steps=128,
        seed=7,
        config=cfg,
    )
    report = evaluate(scene, out / "policy.onnx", out, episodes=30)
    manifest = json.loads((scene.parent / "model-manifest.json").read_text())
    manifest["sceneSha256"] = hashlib.sha256(scene.read_bytes()).hexdigest()
    (out / "model-manifest.json").write_text(json.dumps(manifest, indent=2))
    names = [
        "policy.pt",
        "policy.onnx",
        "training-summary.json",
        "eval-report.json",
        "model-manifest.json",
        "trajectories.json",
    ]
    names += [p.name for p in sorted(snapshot.glob("source-*.py"))]

    def digest(p):
        return hashlib.sha256((out / p).read_bytes()).hexdigest()

    (out / "SHA256SUMS").write_text("".join(f"{digest(n)}  {n}\n" for n in names))
    run = (
        re.sub(
            "[^a-zA-Z0-9._-]", "-", str(request.get("idempotencyKey", "simulation"))
        )[:64]
        or "simulation"
    )
    result = {
        "status": "completed",
        "engine": "originman-straight",
        "taskId": "originman-straight-residual",
        "physicsBackend": summary["physicsBackend"],
        "deployable": False,
        "hardwareEligible": False,
        "metrics": {
            "contractValid": True,
            "observationSize": 41,
            "actionSize": 10,
            "iterations": summary["iterations"],
            "reward": summary["curve"][-1]["meanReward"],
            "lateralImprovementMeters": report["lateralImprovementMeters"],
            "forwardProgressRetention": report["forwardProgressRetention"],
            "demonstratesCorrectionWithoutSlowing": report[
                "demonstratesCorrectionWithoutSlowing"
            ],
            "simulationOnly": True,
        },
        "checkpoint": {
            "checkpointId": "originman-" + run,
            "artifactRef": f"artifact://originman-straight/{run}/policy.pt",
            "iteration": summary["iterations"],
        },
        "artifact": {
            "ref": f"artifact://originman-straight/{run}/policy.onnx",
            "artifactId": "originman-" + run,
            "name": "policy.onnx",
            "format": "onnx",
            "role": "calibration",
            "kind": "source",
            "runtime": "",
            "workload": "locomotion",
            "targetPlatforms": [],
            "sizeBytes": (out / "policy.onnx").stat().st_size,
            "sha256": digest("policy.onnx"),
        },
    }
    result_file.write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
