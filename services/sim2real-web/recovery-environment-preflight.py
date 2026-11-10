"""Read-only OriginMan environment probe. No training, device access or policy promotion."""
from __future__ import annotations

import contextlib
from datetime import datetime, timezone
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import sys


def inspect(task_id=None, scene=None):
    task = task_id if task_id is not None else os.environ.get("RDK_PREFLIGHT_TASK_ID", "originman-recovery")
    scene = scene if scene is not None else os.environ.get("ORIGINMAN_SCENE", "")
    checks = []

    def check(name, fn):
        try:
            detail = fn()
            checks.append({"id": name, "status": "passed", "detail": str(detail)[:1000]})
        except Exception as exc:
            # The report names the failed capability without exposing caller-owned paths.
            checks.append({"id": name, "status": "blocked", "detail": type(exc).__name__,
                           "recovery": f"Repair the trusted worker {name} configuration; no training was started."})

    def python():
        if sys.version_info < (3, 10):
            raise RuntimeError("Python 3.10+ required")
        return f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"

    def dependencies():
        names = ["numpy", "scipy", "mujoco", "torch", "stable_baselines3", "gymnasium", "onnx", "onnxruntime"]
        return ", ".join(f"{name}={getattr(importlib.import_module(name), '__version__', 'imported')}" for name in names)

    def task_registry():
        if task != "originman-recovery":
            raise ValueError("unsupported task")
        return "originman-recovery; simulation only; no hardware eligibility"

    def robot_assets():
        import numpy as np
        from env import Config
        from residual_env import ResidualStandingGym
        if not scene:
            raise ValueError("trusted ORIGINMAN_SCENE required")
        env = ResidualStandingGym(scene, Config(stride=0, lift=0, sway=0, residual_scale=0.3))
        try:
            observation, _ = env.reset(seed=7, options={"force": 0, "start": 2})
            assert observation.shape == (14,) and env.action_space.shape == (2,)
            physical = env.physical
            assert (physical.model.nq, physical.model.nv, physical.model.nu) == (27, 26, 20)
            observation, _, _, _, _ = env.step(np.zeros(2))
            assert observation.shape == (14,) and np.isfinite(observation).all()
            return "Original 20-joint free-base scene compiles; real MuJoCo 14→2 reset and one step passed"
        finally:
            env.close()

    def exporter():
        import numpy as np
        import onnx
        from onnx import helper, TensorProto, numpy_helper
        import onnxruntime as ort
        model = helper.make_model(helper.make_graph(
            [helper.make_node("Gather", ["obs", "indices"], ["action"], axis=1)], "preflight-only",
            [helper.make_tensor_value_info("obs", TensorProto.FLOAT, [1, 14])],
            [helper.make_tensor_value_info("action", TensorProto.FLOAT, [1, 2])],
            [numpy_helper.from_array(np.array([0, 1], dtype=np.int64), "indices")]),
            opset_imports=[helper.make_opsetid("", 17)], ir_version=9)
        onnx.checker.check_model(model)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(model.SerializeToString(), sess_options=options, providers=["CPUExecutionProvider"])
        action = session.run(None, {"obs": np.ones((1, 14), dtype=np.float32)})[0]
        assert action.shape == (1, 2) and np.isfinite(action).all()
        return "In-memory ONNX and ORT CPU 14→2 probe; not a learned policy"

    def training_device():
        import torch
        requested = os.environ.get("ORIGINMAN_TRAIN_DEVICE", "cuda")
        if requested != "cuda" or not torch.cuda.is_available():
            raise RuntimeError("CUDA is required; no CPU fallback")
        value = torch.ones(1, device="cuda") * 2
        torch.cuda.synchronize()
        if value.item() != 2:
            raise RuntimeError("CUDA arithmetic failed")
        return json.dumps({"requestedDevice": requested, "resolvedDevice": "cuda",
                           "torchVersion": torch.__version__, "cudaRuntime": torch.version.cuda,
                           "gpuName": torch.cuda.get_device_name(torch.cuda.current_device()),
                           "physicsBackend": "cpu-mujoco"})

    def source_snapshot():
        root = Path(__file__).resolve().parent
        required = [root / name for name in ["workshop_adapter.py", "workshop.py", "standing_sac.py", "residual_env.py", "monitor.py"]]
        required.append(root.parent / "microduck-football/train_football.py")
        digest = hashlib.sha256()
        for path in required:
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
        return "Required source snapshot inputs readable; sha256=" + digest.hexdigest()

    with contextlib.redirect_stdout(io.StringIO()):
        for name, fn in [("python", python), ("dependencies", dependencies), ("task-registry", task_registry),
                         ("robot-assets", robot_assets), ("exporter", exporter), ("source-snapshot", source_snapshot), ("training-device", training_device)]:
            check(name, fn)
    return {"schemaVersion": 1, "engine": "originman-recovery", "taskId": task,
            "checkedAt": datetime.now(timezone.utc).isoformat(), "trainingPerformed": False,
            "hardwareEligible": False, "readyForSmokeTraining": all(x["status"] == "passed" for x in checks),
            "checks": checks}


if __name__ == "__main__":
    print(json.dumps(inspect(), ensure_ascii=False))
