#!/usr/bin/env python3
"""Reference adapter: wire mjlab + rsl-rl into the platform worker protocol.

This file is a deliberately honest skeleton. It implements the full file
protocol around your training code:

  read   RDK_SIM2REAL_REQUEST_FILE  (schemaVersion 1, validated)
  run    YOUR mjlab + rsl-rl training entrypoint
  write  RDK_SIM2REAL_RESULT_FILE   (checkpoint / artifact / metrics)

and refuses to fake a completed run when mjlab or rsl-rl are not installed.
Fill in the three blocks marked "PROJECT HOOKS" and register the engine with
the local worker:

  RDK_SIM2REAL_TRAIN_EXECUTABLE=/usr/bin/python3
  RDK_SIM2REAL_TRAIN_ARGS_JSON='["/abs/path/to/engines/mjlab-rsl-rl-adapter/adapter.py"]'

The contract in the request is the same one the platform validated against
the manifest, so the adapter must build the mjlab env with exactly those
dimensions (observation_size, action_size, control Hz / decimation).
"""

import json
import os
import sys

REQUIRED_PACKAGES = ("mujoco", "mjlab", "rsl_rl")

try:
    import torch  # noqa: F401 - present in every rsl-rl deployment
    import mujoco  # noqa: F401
    import mjlab  # noqa: F401
    import rsl_rl  # noqa: F401
except ImportError as error:  # pragma: no cover - environment guard
    print(
        "[mjlab-adapter] REFUSED — required training stack is not installed "
        f"({error}). This adapter never fabricates a completed training run.",
        file=sys.stderr,
    )
    sys.exit(3)


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
    model = request.get("model") or {}
    training = request.get("training") or {}
    observation_size = int(contract.get("observationSize", 0))
    action_size = int(contract.get("actionSize", 0))
    if observation_size <= 0 or action_size <= 0:
        raise ValueError("contract.observationSize and contract.actionSize are required")
    control_hz = int(contract.get("controlHz", 50))
    physics_dt = float(contract.get("physicsTimestepSeconds", 0.002))
    decimation = int(contract.get("decimation", max(1, round(control_hz * physics_dt))))
    model_id = str(model.get("modelId", "mjlab-policy"))
    version = str(model.get("version", "0.1.0"))
    profile = str(training.get("profile", "standard"))
    max_iterations = int(training.get("maxIterations", 1_000))

    # ------------------------------------------------------------------
    # PROJECT HOOK 1 — build the vectorized mjlab environment from the
    # manifest contract. observation/action sizes and the control loop
    # (controlHz x physicsTimestepSeconds x decimation) MUST match; a
    # mismatch here is a policy-contract violation, not a tuning choice.
    # ------------------------------------------------------------------
    raise NotImplementedError(
        "PROJECT HOOK 1: build your mjlab VecEnv here "
        f"(obs={observation_size}, act={action_size}, "
        f"control={control_hz}Hz, physics_dt={physics_dt}, decimation={decimation})"
    )

    # ------------------------------------------------------------------
    # PROJECT HOOK 2 — run rsl-rl PPO for max_iterations ({profile} profile).
    # On export, torch.onnx.export(...) the actor exactly as the platform
    # manifest declares it (cpu-onnx, workload=locomotion, threads=1) and
    # write the bytes next to the result (the worker only persists bounded
    # metadata, never model bytes, through result.json).
    # ------------------------------------------------------------------
    raise NotImplementedError("PROJECT HOOK 2: rsl-rl PPO training + ONNX export")

    # ------------------------------------------------------------------
    # PROJECT HOOK 3 — evaluate the trained policy (survival rate, reward,
    # control latency under one CPU thread) and emit the result contract.
    # Keep deployable=false unless a board-compiled artifact is produced by
    # the X5 toolchain; the platform enforces this at preflight anyway.
    # ------------------------------------------------------------------
    result = {
        "checkpoint": {
            "checkpointId": f"mjlab-{version}",
            "artifactRef": f"artifact://mjlab/{model_id}/{version}/checkpoint",
            "iteration": max_iterations,
        },
        "artifact": {
            "artifactId": f"{model_id}-policy",
            "artifactRef": f"artifact://mjlab/{model_id}/{version}/policy.onnx",
            "kind": "source",
            "format": "onnx",
            "runtime": "cpu-onnx",
            "workload": "locomotion",
            "threads": 1,
            "sizeBytes": 0,
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": "mjlab-rsl-rl",
            "observationSize": observation_size,
            "actionSize": action_size,
            "iterations": max_iterations,
        },
        "deployable": False,
        "cuda": torch.cuda.is_available(),
    }
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)


if __name__ == "__main__":
    main()
