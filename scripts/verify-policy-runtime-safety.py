#!/usr/bin/env python3
"""Focused regression checks for fail-closed policy observations."""

import importlib.util
import json
import os
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "services/sim2real-web/board-policy-runtime.py"
spec = importlib.util.spec_from_file_location("board_policy_runtime", MODULE_PATH)
runtime = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(runtime)

policy = runtime.PolicyRuntime()
read_telemetry_from_file = runtime._read_telemetry

valid_imu = {
    "gyro": {"x": 0.01, "y": -0.02, "z": 0.03},
    "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
}

runtime._read_telemetry = lambda: {"odom": {"linear": {"x": 0.0}}}
assert policy._build_observation() is None, "missing IMU must fail closed"

runtime._read_telemetry = lambda: {"imu": {"gyro": {"x": 0.0, "y": 0.0, "z": float("nan")}, "quaternion": valid_imu["quaternion"]}}
assert policy._build_observation() is None, "non-finite IMU must fail closed"

runtime._read_telemetry = lambda: {"imu": valid_imu}
observation = policy._build_observation()
assert observation is not None and len(observation) == runtime.EXPECTED_OBS_DIM
assert observation[:6] == [0.01, -0.02, 0.03, 0.0, 0.0, 1.0]

with tempfile.TemporaryDirectory() as temp_dir:
    snapshot = Path(temp_dir) / "snapshot.json"
    runtime.TELEMETRY_SNAPSHOT_FILE = str(snapshot)
    runtime._read_telemetry = read_telemetry_from_file
    snapshot.write_text(json.dumps({"ts": time.time() - runtime.STALL_LIMIT_SEC - 0.1, "data": {"imu": valid_imu}}))
    assert runtime._read_telemetry() is None, "stale snapshot must be rejected at watchdog budget"
    snapshot.write_text(json.dumps({"ts": time.time(), "data": {"imu": valid_imu}}))
    assert runtime._read_telemetry() is not None

print("policy runtime safety: PASS (missing/non-finite IMU rejected; stale snapshots rejected)")
