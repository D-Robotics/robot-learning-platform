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
# The board runtime intentionally defaults to a root-only production path.
# This verifier runs in CI and on developer laptops as an ordinary user, so
# give the imported module an explicit private scratch runtime instead of
# weakening the production default or trying to create /var/lib as the caller.
_test_runtime = tempfile.TemporaryDirectory(prefix="rdk-policy-runtime-")
os.environ["RDK_BOARD_RUNTIME_DIR"] = _test_runtime.name
spec = importlib.util.spec_from_file_location("board_policy_runtime", MODULE_PATH)
runtime = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(runtime)

policy = runtime.PolicyRuntime()
read_telemetry_from_file = runtime._read_telemetry

valid_imu = {
    "gyro": {"x": 0.01, "y": -0.02, "z": 0.03},
    "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
    # The wrapper file may be rewritten while a ROS topic is frozen.  The
    # policy runtime therefore requires a source monotonic sample timestamp.
    "sampleMonotonicNs": time.monotonic_ns(),
}


def fresh_imu(**overrides):
    sample = dict(valid_imu)
    sample["sampleMonotonicNs"] = time.monotonic_ns()
    sample.update(overrides)
    return sample

runtime._read_telemetry = lambda: {"odom": {"linear": {"x": 0.0}}}
assert policy._build_observation() is None, "missing IMU must fail closed"

runtime._read_telemetry = lambda: {"imu": fresh_imu(gyro={"x": 0.0, "y": 0.0, "z": float("nan")})}
assert policy._build_observation() is None, "non-finite IMU must fail closed"

runtime._read_telemetry = lambda: {"imu": fresh_imu(quaternion={"x": 0, "y": 0, "z": 0, "w": 0})}
assert policy._build_observation() is None, "zero-norm quaternion must fail closed"

runtime._read_telemetry = lambda: {"imu": fresh_imu()}
observation = policy._build_observation()
assert observation is not None and len(observation) == runtime.EXPECTED_OBS_DIM
# Keep the board adapter aligned with the starter task-pack convention:
# projected gravity is world gravity (0, 0, -1) for an upright frame.
assert observation[:6] == [0.01, -0.02, 0.03, 0.0, 0.0, -1.0]

# Native OriginBot 8D policies must receive the same layout used by the
# trainer, and must fail closed when no explicit real-world goal is set.
old_dims = (runtime.EXPECTED_OBS_DIM, runtime.EXPECTED_ACTION_DIM)
old_goal = (runtime.ORIGINBOT_GOAL_X, runtime.ORIGINBOT_GOAL_Y)
runtime.EXPECTED_OBS_DIM, runtime.EXPECTED_ACTION_DIM = 8, 2
runtime.ORIGINBOT_GOAL_X, runtime.ORIGINBOT_GOAL_Y = None, None
runtime._read_telemetry = lambda: {"imu": fresh_imu(), "odom": {"positionX": 1.0, "positionY": -0.5, "linearX": 0.1, "angularZ": 0.2, "sampleMonotonicNs": time.monotonic_ns()}}
assert policy._build_observation() is None, "8D policy must require an explicit goal"
runtime.ORIGINBOT_GOAL_X, runtime.ORIGINBOT_GOAL_Y = 2.0, 0.5
policy._goal = (runtime.ORIGINBOT_GOAL_X, runtime.ORIGINBOT_GOAL_Y)
observation = policy._build_observation()
assert observation is not None and len(observation) == 8
assert observation[0:2] == [1.0, -0.5] and observation[4:6] == [1.0, 1.0]
runtime.EXPECTED_OBS_DIM, runtime.EXPECTED_ACTION_DIM = old_dims
runtime.ORIGINBOT_GOAL_X, runtime.ORIGINBOT_GOAL_Y = old_goal

# Session evidence must be durable in the state snapshot even when the loop is
# replaced by a test double.  This protects the board → Run reconciliation
# contract without requiring ROS or an ONNX provider on CI.
session_policy = runtime.PolicyRuntime()
session_policy._model = object()
session_policy._state = "ready"
session_policy._loop = lambda: None
started = session_policy.start(0.1)
assert started.get("ok") and started.get("state") == "running", started
session = session_policy.snapshot()["session"]
assert session["id"] and session["startedAt"] and session["mock"] is False, session
stopped = session_policy.stop("test-evidence")
assert stopped.get("ok"), stopped
session = session_policy.snapshot()["session"]
assert session["stoppedAt"] and session["stopReason"] == "test-evidence", session
assert session["durationSec"] >= 0 and session["inferenceCount"] == 0, session

# Session lifecycle events ride the same bounded spool as control samples so
# the uploader can carry them to the bound platform run. They must appear as
# board-agent records with mock:false, and a double stop (operator stop then
# sigterm) must never emit two terminal events for one session.
with tempfile.TemporaryDirectory() as spool_dir:
    spool_file = Path(spool_dir) / "policy.jsonl"
    runtime.TELEMETRY_SPOOL_FILE = str(spool_file)
    runtime.TELEMETRY_RUN_ID = "run-verify-safety"
    spool_policy = runtime.PolicyRuntime()
    spool_policy._model = object()
    spool_policy._state = "ready"
    spool_policy._loop = lambda: None
    spool_policy.start(0.1)
    spool_policy.stop("test-evidence")
    spool_policy.stop("operator-stop")
    records = [json.loads(line) for line in spool_file.read_text().splitlines() if line.strip()]
    assert len(records) == 2, records
    assert records[0]["source"] == "board-agent", records[0]
    assert records[0]["event"]["kind"] == "session-started", records[0]
    assert records[0]["event"]["mock"] is False, records[0]
    assert records[1]["event"]["kind"] == "session-stopped", records[1]
    assert records[1]["event"]["sessionId"] == records[0]["event"]["sessionId"]
    assert records[1]["event"]["stopReason"] == "test-evidence", records[1]
    # Without a bound run id the runtime must never spool session records.
    runtime.TELEMETRY_RUN_ID = ""
    unbound_policy = runtime.PolicyRuntime()
    unbound_policy._model = object()
    unbound_policy._state = "ready"
    unbound_policy._loop = lambda: None
    unbound_policy.start(0.1)
    unbound_policy.stop("unbound")
    assert len(spool_file.read_text().splitlines()) == 2, "unbound runtime must not spool events"

with tempfile.TemporaryDirectory() as temp_dir:
    snapshot = Path(temp_dir) / "snapshot.json"
    runtime.TELEMETRY_SNAPSHOT_FILE = str(snapshot)
    runtime._read_telemetry = read_telemetry_from_file
    snapshot.write_text(json.dumps({"ts": time.time() - runtime.STALL_LIMIT_SEC - 0.1, "data": {"imu": valid_imu}}))
    assert runtime._read_telemetry() is None, "stale snapshot must be rejected at watchdog budget"
    snapshot.write_text(json.dumps({"ts": time.time(), "data": {"imu": fresh_imu()}}))
    assert runtime._read_telemetry() is not None

# A live wrapper must not hide a stalled source topic.  The outer ``ts`` is
# fresh, but the source sample is older than the policy watchdog budget.
stale_imu = dict(valid_imu, sampleMonotonicNs=time.monotonic_ns() - int((runtime.STALL_LIMIT_SEC + 0.2) * 1_000_000_000))
runtime._read_telemetry = lambda: {"imu": stale_imu}
assert policy._build_observation() is None, "fresh wrapper with stale source IMU must fail closed"

# Identity projection is only safe for an explicit two-output twist head;
# taking the first two dimensions of a leg policy would be an actuator bug.
try:
    policy._project_action([0.0] * 14)
except ValueError as exc:
    assert "identity action projection" in str(exc) or "output length" in str(exc)
else:
    # The default profile uses paired projection, so exercise the invariant
    # directly without mutating process-wide configuration.
    old_projection = runtime.ACTION_PROJECTION
    runtime.ACTION_PROJECTION = "identity"
    try:
        try:
            policy._project_action([0.0] * 14)
        except ValueError as exc:
            assert "identity action projection" in str(exc)
        else:
            raise AssertionError("identity projection accepted a 14D action")
    finally:
        runtime.ACTION_PROJECTION = old_projection

# Normalized twist heads are converted to the adapter's physical limits once
# (and only once) before the command reaches ROS.
old_output = runtime.ACTION_OUTPUT
runtime.ACTION_OUTPUT = "normalized-twist"
linear, angular = policy._project_action([0.5, -0.5])
assert abs(linear - 0.5 * runtime.MAX_LINEAR) < 1e-9
assert abs(angular + 0.5 * runtime.MAX_ANGULAR) < 1e-9
runtime.ACTION_OUTPUT = old_output

print("policy runtime safety: PASS (source-stale observations rejected; normalized twist scaled; invalid actions rejected)")
