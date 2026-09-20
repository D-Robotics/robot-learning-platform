#!/usr/bin/env python3
"""Platform worker adapter for the MuJoCo MicroDuck football engine.

The web workbench starts this file through ``local-training-worker.mjs``.  It
keeps the platform protocol (request.json -> result.json + SHA256SUMS) at the
edge of the engine, so submitting a football run is the same operation as any
other platform training run.  The PPO runner is intentionally small and
high-level (4D duck command); the returned metadata makes that boundary clear
while preserving the real MicroDuck 61D -> 14D actor path for later evaluation.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

import torch


ADAPTER_ID = "microduck-football"
PHYSICS_BACKEND = "microduck-football-mujoco"
TASKS = {
    "football-single-goal-kick": "single-goal-kick",
    "football-goal-kick": "single-goal-kick",
    "football-2v2": "soccer-2v2",
    "football-3v3": "soccer-3v3",
    "single-goal-kick": "single-goal-kick",
    "soccer-2v2": "soccer-2v2",
    "soccer-3v3": "soccer-3v3",
}


def stdout(message: str) -> None:
    print(f"[{ADAPTER_ID}] {message}", flush=True)


def read_json(path: Path) -> dict:
    with path.open() as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("request.json must contain an object")
    return value


def int_value(value: object, fallback: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return fallback


def task_for(request: dict) -> str:
    raw = str(request.get("taskId") or "").strip().lower()
    training = request.get("training")
    if isinstance(training, dict):
        raw = str(training.get("footballTask") or raw).strip().lower()
    return TASKS.get(raw, "single-goal-kick")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(job_dir: Path, names: list[str]) -> None:
    lines = [f"{sha256(job_dir / name)}  {name}" for name in names]
    (job_dir / "SHA256SUMS").write_text("\n".join(lines) + "\n")


def main() -> None:
    request_file = os.environ.get("RDK_SIM2REAL_REQUEST_FILE")
    result_file = os.environ.get("RDK_SIM2REAL_RESULT_FILE")
    if not request_file or not result_file:
        raise SystemExit("RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required")
    request = read_json(Path(request_file))
    if request.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")
    job_dir = Path(os.environ.get("RDK_SIM2REAL_JOB_DIR") or Path(result_file).parent).resolve()
    job_dir.mkdir(parents=True, exist_ok=True)
    training = request.get("training") if isinstance(request.get("training"), dict) else {}
    task = task_for(request)
    num_envs = int_value(training.get("numEnvs"), 8, 1, 4096)
    iterations = int_value(training.get("maxIterations"), 2, 1, 2_000_000)
    # These are the validated CUDA defaults for the football task.  They match
    # the optimized standalone run; the platform request still controls the
    # environment count and iteration budget.
    steps = int_value(training.get("stepsPerEnv"), 128, 8, 4096)
    device = str(os.environ.get("RDK_MICRODUCK_FOOTBALL_DEVICE") or "auto")
    run_name = str(request.get("idempotencyKey") or os.environ.get("RDK_SIM2REAL_JOB_ID") or "run")
    safe_name = "".join(ch for ch in run_name[:64] if ch.isalnum() or ch in "._-") or "run"
    checkpoint = job_dir / "policy.pt"
    export_path = job_dir / "policy.ts"
    onnx_path = job_dir / "policy.onnx"
    summary_path = job_dir / "training-summary.json"
    evaluation_path = job_dir / "evaluation.json"
    script_dir = Path(__file__).resolve().parent
    sys.path.insert(0, str(script_dir))
    from train_football import train  # type: ignore
    from evaluate_policy import evaluate  # type: ignore

    class Args:
        pass

    args = Args()
    args.seed = int_value(training.get("seed"), 20260920, 0, 2**31 - 1)
    args.device = device if device in ("auto", "cpu", "cuda") else "auto"
    args.task = task
    args.num_envs = num_envs
    args.iterations = iterations
    args.steps_per_env = steps
    args.learning_rate = 1e-4
    args.gamma = 0.99
    args.gae_lambda = 0.95
    args.clip = 0.2
    args.update_epochs = 8
    args.teacher_weight = float(training.get("teacherWeight", 0.35))
    args.out = str(summary_path)
    args.checkpoint = str(checkpoint)
    args.export = str(export_path)
    stdout(f"task={task} envs={num_envs} iterations={iterations} steps={steps}")
    started = time.time()
    payload = train(args)
    # Convert the exported actor inside the same platform job.  This is the
    # artifact consumed by the platform's staging endpoint.
    actor = torch.jit.load(str(export_path), map_location="cpu").eval()
    example = torch.zeros((1, int(payload["observationDim"])), dtype=torch.float32)
    torch.onnx.export(
        actor,
        example,
        str(onnx_path),
        input_names=["observation"],
        output_names=["action"],
        dynamic_axes={"observation": {0: "batch"}, "action": {0: "batch"}},
        opset_version=17,
    )
    # Evaluation is part of the platform job, so the completed run is already
    # quality checked when it reaches the ledger.  It uses the exported actor
    # in MuJoCo rather than the training counters.
    evaluation = evaluate(str(export_path), task, episodes=200, seed=args.seed)
    evaluation_path.write_text(json.dumps(evaluation, indent=2) + "\n")
    payload.update(
        {
            "platformTaskId": request.get("taskId"),
            "runName": safe_name,
            "engine": ADAPTER_ID,
            "physicsBackend": PHYSICS_BACKEND,
            "realActorContract": "microduck-policy-v1 (61D observation -> 14D servo action)",
            "footballPolicyActionDim": 4,
            "evaluation": {
                "episodes": evaluation["episodes"],
                "goals": evaluation["goals"],
                "successRate": evaluation["successRate"],
                "meanReturn": evaluation["meanReturn"],
            },
            "trainingSeconds": round(time.time() - started, 3),
        }
    )
    summary_path.write_text(json.dumps(payload, indent=2) + "\n")
    write_manifest(job_dir, ["policy.pt", "policy.ts", "policy.onnx", "training-summary.json", "evaluation.json"])
    cuda = bool(payload.get("cuda"))
    result = {
        "status": "completed",
        "engine": ADAPTER_ID,
        "taskId": request.get("taskId") or task,
        "physicsBackend": PHYSICS_BACKEND,
        "cuda": cuda,
        "deployable": False,
        "metrics": {
            "contractValid": True,
            "task": task,
            "observationSize": payload.get("observationDim"),
            "actionSize": payload.get("actionDim"),
            "realActorObservationSize": 61,
            "realActorActionSize": 14,
            "reward": payload.get("curve", [{}])[-1].get("meanReward") if payload.get("curve") else None,
            "goals": payload.get("goals", 0),
            "completedEpisodes": payload.get("completedEpisodes", 0),
            "successRate": evaluation["successRate"],
            "evaluationEpisodes": evaluation["episodes"],
            "meanReturn": evaluation["meanReturn"],
            "iterations": payload.get("iterations"),
            "cuda": cuda,
        },
        "checkpoint": {
            "checkpointId": f"{ADAPTER_ID}-{safe_name}",
            "artifactRef": f"artifact://{ADAPTER_ID}/{safe_name}/policy.pt",
            "iteration": int(payload.get("iterations") or 0),
        },
        "artifact": {
            "ref": f"artifact://{ADAPTER_ID}/{safe_name}/policy.onnx",
            "artifactId": f"{ADAPTER_ID}-{safe_name}",
            "version": f"iter-{int(payload.get('iterations') or 0)}",
            "role": "calibration",
            "name": "policy.onnx",
            "kind": "source",
            "format": "onnx",
            "runtime": "",
            "workload": "locomotion",
            "targetPlatforms": ["rdk-x5"],
            "sizeBytes": onnx_path.stat().st_size,
            "sha256": sha256(onnx_path),
        },
        "exports": [
            {
                "name": "policy.ts",
                "format": "torchscript",
                "ref": f"artifact://{ADAPTER_ID}/{safe_name}/policy.ts",
                "sizeBytes": export_path.stat().st_size,
                "sha256": sha256(export_path),
            },
            {
                "name": "policy.onnx",
                "format": "onnx",
                "ref": f"artifact://{ADAPTER_ID}/{safe_name}/policy.onnx",
                "sizeBytes": onnx_path.stat().st_size,
                "sha256": sha256(onnx_path),
            },
            {
                "name": "evaluation.json",
                "format": "unknown",
                "ref": f"artifact://{ADAPTER_ID}/{safe_name}/evaluation.json",
                "sizeBytes": evaluation_path.stat().st_size,
                "sha256": sha256(evaluation_path),
            },
        ],
    }
    Path(result_file).write_text(json.dumps(result, indent=2) + "\n")
    stdout(f"completed physicsBackend={PHYSICS_BACKEND} cuda={cuda} artifact=policy.pt")


if __name__ == "__main__":
    main()
