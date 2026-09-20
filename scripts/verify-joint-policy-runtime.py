#!/usr/bin/env python3
"""Pure contract/safety checks for the MicroDuck joint policy runtime."""

import importlib.util
import json
import os
import pathlib
import tempfile
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME_PATH = ROOT / "services" / "sim2real-web" / "board-joint-policy-runtime.py"
ADAPTER_PATH = ROOT / "adapters" / "microduck-leg.json"


def load_runtime():
    with tempfile.TemporaryDirectory(prefix="microduck-runtime-") as runtime_dir:
        os.chmod(runtime_dir, 0o700)
        os.environ["RDK_BOARD_RUNTIME_DIR"] = runtime_dir
        os.environ["RDK_SIM2REAL_ADAPTER_CONFIG"] = str(ADAPTER_PATH)
        spec = importlib.util.spec_from_file_location("microduck_joint_runtime_test", RUNTIME_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        yield module


def main():
    runtime_iter = load_runtime()
    module = next(runtime_iter)
    now = time.monotonic_ns()
    snapshot = {
        "imu": {
            "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
            "gyro": {"x": 0.1, "y": -0.2, "z": 0.3},
            "sampleMonotonicNs": now,
        },
        "jointStates": {
            "names": list(reversed(module.JOINT_NAMES)),
            "position": list(reversed([0.1 * index for index in range(14)])),
            "velocity": list(reversed([0.01 * index for index in range(14)])),
            "sampleMonotonicNs": now,
        },
    }
    observation = module.build_joint_observation(snapshot, module.JOINT_NAMES, module.HOME_POSITION)
    assert observation is not None and len(observation) == 61
    assert observation[:3] == [0.1, -0.2, 0.3]
    assert all(value == value and abs(value) != float("inf") for value in observation)
    stale = json.loads(json.dumps(snapshot))
    stale["imu"]["sampleMonotonicNs"] = time.monotonic_ns() - 2_000_000_000
    assert module.build_joint_observation(stale, module.JOINT_NAMES, module.HOME_POSITION) is None
    target = module.project_joint_action([10.0] * 14, module.HOME_POSITION, 0.35)
    assert len(target) == 14
    assert max(abs(target[index] - module.HOME_POSITION[index]) for index in range(14)) <= 0.04 + 1e-9
    limited = module.project_joint_action(
        [-1.0] * 14,
        module.HOME_POSITION,
        0.35,
        previous_target=target,
        max_step=0.08,
        max_velocity=2.0,
        decision_hz=50,
    )
    assert max(abs(limited[index] - target[index]) for index in range(14)) <= 0.04 + 1e-9
    print("[joint-policy-runtime] PASS — 61D observation, freshness, reorder and step limits")


if __name__ == "__main__":
    main()
