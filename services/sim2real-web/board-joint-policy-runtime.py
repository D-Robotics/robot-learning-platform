#!/usr/bin/env python3
"""Fail-closed ONNX runtime for a 14-servo MicroDuck on an RDK X5.

The wheeled policy runtime deliberately cannot drive a legged robot: it owns a
``Twist`` publisher and zero-fills leg observations.  This runtime is selected
automatically for a profile whose actuator kind is ``joint``.  It keeps the
same private file protocol as ``board-policy-runtime.py`` while publishing a
bounded ``JointTrajectory`` command.

Observation contract (61 values):
``gyro(3), projected_gravity(3), joint_position_error(14), joint_velocity(14),
last_action(14), command(13)``.  Every sensor value is sourced from the
atomic telemetry snapshot and carries a monotonic sample timestamp.  Missing,
stale, non-finite, or misordered joints fail closed before inference.
"""

import hashlib
import json
import math
import os
import signal
import sys
import threading
import time
import uuid

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)
from board_ipc import (
    atomic_write_json,
    ipc_path,
    secure_read_json,
    secure_read_text,
    secure_size,
)


def _load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


ADAPTER_CONFIG_PATH = os.environ.get("RDK_SIM2REAL_ADAPTER_CONFIG", "").strip()
ADAPTER = _load_json(ADAPTER_CONFIG_PATH) if ADAPTER_CONFIG_PATH else {}
RUNTIME = ADAPTER.get("runtime") if isinstance(ADAPTER.get("runtime"), dict) else {}
SAFETY = ADAPTER.get("safety") if isinstance(ADAPTER.get("safety"), dict) else {}
POLICY = ADAPTER.get("policy") if isinstance(ADAPTER.get("policy"), dict) else {}
ACTUATOR = ADAPTER.get("actuator") if isinstance(ADAPTER.get("actuator"), dict) else {}
TOPICS = (ADAPTER.get("ros") or {}).get("topics") if isinstance((ADAPTER.get("ros") or {}).get("topics"), dict) else {}

ADAPTER_ID = str(ADAPTER.get("id") or "microduck-leg")[:80]
JOINT_NAMES = tuple(str(value) for value in (RUNTIME.get("jointNames") or ()))
HOME_POSITION = tuple(float(value) for value in (RUNTIME.get("homePositionRad") or ()))
ACTION_SCALE = float(RUNTIME.get("actionScaleRad", 0.35))
EXPECTED_OBS_DIM = int(POLICY.get("observationSize", 61))
EXPECTED_ACTION_DIM = int(POLICY.get("actionSize", 14))
DECISION_HZ = max(1.0, min(50.0, float(RUNTIME.get("decisionHz", 50))))
STALL_LIMIT_SEC = max(0.1, min(2.0, float(SAFETY.get("sensorStallSec", 0.1))))
MAX_JOINT_STEP = max(0.001, min(1.0, float(SAFETY.get("maxJointStepRad", 0.08))))
MAX_JOINT_VELOCITY = max(0.01, min(20.0, float(SAFETY.get("maxJointVelocityRadSec", 2.0))))
COMMAND_VECTOR_SIZE = int(RUNTIME.get("commandVectorSize", 13))
COMMAND_TOPIC = str(
    os.environ.get("RDK_SIM2REAL_COMMAND_TOPIC")
    or ACTUATOR.get("commandTopic")
    or ((TOPICS.get("jointCommand") or {}).get("name"))
    or "/microduck_controller/joint_trajectory"
)
COMMAND_MESSAGE_TYPE = str(
    ACTUATOR.get("messageType")
    or ((TOPICS.get("jointCommand") or {}).get("type"))
    or "trajectory_msgs/msg/JointTrajectory"
)

RUNTIME_STATE_FILE = ipc_path("RDK_BOARD_POLICY_STATE", "policy-runtime-state.json")
CMD_FILE = ipc_path("RDK_BOARD_POLICY_CMD", "policy-runtime-cmd.json")
READY_FILE = ipc_path("RDK_BOARD_POLICY_READY", "policy-runtime.ready")
TELEMETRY_SNAPSHOT_FILE = ipc_path("RDK_BOARD_TELEMETRY_SNAPSHOT", "telemetry-snapshot.json")


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _sample_fresh(sensor, now_ns=None):
    if not isinstance(sensor, dict):
        return False
    try:
        sample_ns = int(sensor.get("sampleMonotonicNs"))
    except (TypeError, ValueError, OverflowError):
        return False
    current = time.monotonic_ns() if now_ns is None else int(now_ns)
    age = (current - sample_ns) / 1_000_000_000.0
    return math.isfinite(age) and -0.25 <= age <= STALL_LIMIT_SEC


def _read_snapshot():
    try:
        snapshot = secure_read_json(TELEMETRY_SNAPSHOT_FILE)
        stamp = _finite(snapshot.get("ts"))
        now = time.time()
        if stamp is None or stamp - now > 0.25 or now - stamp > STALL_LIMIT_SEC:
            return None
        data = snapshot.get("data")
        return data if isinstance(data, dict) else None
    except (OSError, TypeError, ValueError):
        return None


def _component(mapping, *keys):
    if not isinstance(mapping, dict):
        return None
    for key in keys:
        value = _finite(mapping.get(key))
        if value is not None:
            return value
    return None


def build_joint_observation(snapshot, joint_names=JOINT_NAMES, home_position=HOME_POSITION,
                            last_action=None, command_size=COMMAND_VECTOR_SIZE):
    """Build the exact MicroDuck 61D vector, or ``None`` on any bad input."""
    if len(joint_names) != 14 or len(home_position) != 14:
        return None
    data = snapshot if isinstance(snapshot, dict) else {}
    imu = data.get("imu")
    joints = data.get("jointStates") or data.get("joint")
    if not _sample_fresh(imu) or not _sample_fresh(joints):
        return None
    quaternion = imu.get("quaternion") if isinstance(imu, dict) else None
    quaternion = quaternion if isinstance(quaternion, dict) else imu
    gyro = imu.get("gyro") if isinstance(imu, dict) else None
    gyro = gyro if isinstance(gyro, dict) else {}
    gyro_values = [_component(gyro, axis) for axis in ("x", "y", "z")]
    quat_values = [_component(quaternion, axis) for axis in ("x", "y", "z", "w")]
    if any(value is None for value in gyro_values + quat_values):
        return None
    qx, qy, qz, qw = quat_values
    norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    if norm < 1e-6:
        return None
    qx, qy, qz, qw = (value / norm for value in (qx, qy, qz, qw))
    gravity = (
        2.0 * (qw * qy - qx * qz),
        2.0 * (-qw * qx - qy * qz),
        2.0 * (qx * qx + qy * qy) - 1.0,
    )
    names = joints.get("names") if isinstance(joints, dict) else None
    positions = joints.get("position") if isinstance(joints, dict) else None
    velocities = joints.get("velocity") if isinstance(joints, dict) else None
    if not isinstance(names, list) or not isinstance(positions, list) or not isinstance(velocities, list):
        return None
    by_name = {}
    for index, name in enumerate(names):
        if index >= len(positions) or index >= len(velocities) or str(name) in by_name:
            continue
        position = _finite(positions[index])
        velocity = _finite(velocities[index])
        if position is not None and velocity is not None:
            by_name[str(name)] = (position, velocity)
    if any(name not in by_name for name in joint_names):
        return None
    joint_error = [by_name[name][0] - home_position[index] for index, name in enumerate(joint_names)]
    joint_velocity = [by_name[name][1] for name in joint_names]
    previous = list(last_action or ())[:14]
    previous += [0.0] * (14 - len(previous))
    command = [0.0] * max(0, int(command_size))
    observation = list(gyro_values) + list(gravity) + joint_error + joint_velocity + previous + command
    if len(observation) != EXPECTED_OBS_DIM:
        return None
    if not all(math.isfinite(float(value)) for value in observation):
        return None
    return observation


def project_joint_action(action, home_position=HOME_POSITION, scale=ACTION_SCALE,
                         previous_target=None, max_step=MAX_JOINT_STEP,
                         max_velocity=MAX_JOINT_VELOCITY, decision_hz=DECISION_HZ):
    """Convert normalized policy output to safe position targets."""
    if len(action) != 14 or len(home_position) != 14:
        raise ValueError("joint action must have exactly 14 values")
    values = [_finite(value) for value in action]
    if any(value is None for value in values):
        raise ValueError("joint action contains non-finite values")
    desired = [home_position[index] + max(-1.0, min(1.0, values[index])) * scale for index in range(14)]
    previous = list(previous_target) if previous_target is not None else list(home_position)
    if len(previous) != 14 or not all(math.isfinite(float(value)) for value in previous):
        raise ValueError("previous joint target is invalid")
    per_cycle = min(float(max_step), float(max_velocity) / float(decision_hz))
    return [previous[index] + max(-per_cycle, min(per_cycle, desired[index] - previous[index])) for index in range(14)]


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class JointPolicyRuntime:
    def __init__(self):
        self._lock = threading.Lock()
        self._model = None
        self._input_name = None
        self._model_meta = None
        self._state = "idle"
        self._last_error = None
        self._last_op = None
        self._stop_flag = threading.Event()
        self._node = None
        self._publisher = None
        self._JointTrajectory = None
        self._JointTrajectoryPoint = None
        self._last_target = None
        self._last_action = [0.0] * 14
        self._published = 0
        self._infer_ms = 0.0
        self._session_id = None
        self._started_at = None
        self._stopped_at = None
        self._stop_reason = "never-started"

    def snapshot(self):
        with self._lock:
            return {
                "ok": True,
                "ts": time.time(),
                "state": self._state,
                "adapterId": ADAPTER_ID,
                "actuator": "joint",
                "commandTopic": COMMAND_TOPIC,
                "commandMessageType": COMMAND_MESSAGE_TYPE,
                "observationLayout": "microduck-61d-v1",
                "actionProjection": "custom",
                "actionOutput": "joint-position-offset",
                "actionScale": {"joint": ACTION_SCALE, "units": "rad offset from home position"},
                "jointNames": list(JOINT_NAMES),
                "controlHz": int(DECISION_HZ),
                "controlPeriodSeconds": 1.0 / DECISION_HZ,
                "published": self._published,
                "inferMs": round(self._infer_ms, 2),
                "model": self._model_meta,
                "lastError": self._last_error,
                "lastOp": self._last_op,
                "lastTargetRad": list(self._last_target) if self._last_target is not None else None,
                "session": {
                    "id": self._session_id,
                    "startedAt": self._started_at,
                    "stoppedAt": self._stopped_at,
                    "stopReason": self._stop_reason,
                    "inferenceCount": self._published,
                    "mock": False,
                },
            }

    def _write_state(self):
        atomic_write_json(RUNTIME_STATE_FILE, self.snapshot())

    def _record_op(self, op, req, result):
        with self._lock:
            self._last_op = {
                "op": op,
                "seq": req.get("seq"),
                "ok": bool(result.get("ok")),
                "error": result.get("error"),
                "detail": result.get("detail"),
                "at": round(time.time(), 3),
            }

    def bind_ros(self):
        try:
            if COMMAND_MESSAGE_TYPE != "trajectory_msgs/msg/JointTrajectory":
                return {"ok": False, "error": "unsupported-actuator-message-type", "detail": COMMAND_MESSAGE_TYPE}
            import rclpy
            from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint
            rclpy.init()
            self._node = rclpy.create_node("rdk_board_microduck_policy_runtime")
            self._publisher = self._node.create_publisher(JointTrajectory, COMMAND_TOPIC, 10)
            self._JointTrajectory = JointTrajectory
            self._JointTrajectoryPoint = JointTrajectoryPoint
            return {"ok": True}
        except Exception as exc:  # noqa: BLE001 - report the hardware boundary
            return {"ok": False, "error": "ros-unavailable", "detail": str(exc)[:200]}

    def load(self, model_path):
        if len(JOINT_NAMES) != 14 or len(HOME_POSITION) != 14 or EXPECTED_OBS_DIM != 61 or EXPECTED_ACTION_DIM != 14:
            return {"ok": False, "error": "joint-profile-contract-invalid"}
        try:
            if not os.path.isfile(model_path) or os.path.islink(model_path) or secure_size(model_path) <= 0:
                return {"ok": False, "error": "model-file-invalid"}
            if secure_size(model_path) > 50 * 1024 * 1024:
                return {"ok": False, "error": "model-too-large"}
            import numpy as np
            import onnxruntime as ort
            session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
            inputs = session.get_inputs()
            outputs = session.get_outputs()
            if len(inputs) != 1 or len(outputs) != 1:
                return {"ok": False, "error": "model-io-count-invalid"}
            input_shape = inputs[0].shape
            output_shape = outputs[0].shape
            if input_shape and isinstance(input_shape[-1], int) and input_shape[-1] != EXPECTED_OBS_DIM:
                return {"ok": False, "error": "model-input-dim-mismatch"}
            if output_shape and isinstance(output_shape[-1], int) and output_shape[-1] != EXPECTED_ACTION_DIM:
                return {"ok": False, "error": "model-output-dim-mismatch"}
            # A dry-run catches malformed graph dtypes/shapes before start.
            probe = session.run(
                None, {inputs[0].name: np.zeros((1, EXPECTED_OBS_DIM), dtype=np.float32)}
            )[0]
            if int(np.asarray(probe).reshape(-1).size) != EXPECTED_ACTION_DIM:
                return {"ok": False, "error": "model-output-dim-mismatch"}
            meta = {
                "path": model_path,
                "bytes": secure_size(model_path),
                "sha256": _sha256(model_path),
                "inputDim": EXPECTED_OBS_DIM,
                "outputDim": EXPECTED_ACTION_DIM,
                "provider": "cpu",
                "providersAvailable": list(ort.get_available_providers()),
            }
            with self._lock:
                if self._state == "running":
                    return {"ok": False, "error": "model-load-while-running"}
                self._model = session
                self._input_name = inputs[0].name
                self._model_meta = meta
                self._state = "ready"
                self._last_error = None
            return {"ok": True, "model": meta}
        except ImportError:
            return {"ok": False, "error": "onnxruntime-not-installed"}
        except Exception as exc:  # noqa: BLE001 - load must be transactional
            with self._lock:
                self._last_error = str(exc)[:200]
            return {"ok": False, "error": "model-load-failed", "detail": str(exc)[:200]}

    def start(self, _direction=0.0, _goal_x=None, _goal_y=None):
        with self._lock:
            if self._model is None:
                return {"ok": False, "error": "no-model", "state": self._state}
            if self._publisher is None:
                return {"ok": False, "error": "ros-unavailable", "state": self._state}
            if self._state == "running":
                return {"ok": True, "state": "running"}
            if self._state != "ready":
                return {"ok": False, "error": "not-ready", "state": self._state}
            self._state = "running"
            self._stop_flag.clear()
            self._published = 0
            self._infer_ms = 0.0
            self._last_action = [0.0] * 14
            self._last_target = None
            self._session_id = str(uuid.uuid4())
            self._started_at = time.time()
            self._stopped_at = None
            self._stop_reason = None
        threading.Thread(target=self._loop, daemon=True).start()
        return {"ok": True, "state": "running"}

    def stop(self, reason="operator-stop"):
        with self._lock:
            was_running = self._state == "running"
            self._state = "idle" if self._model is not None else "idle"
            self._stop_flag.set()
            self._stopped_at = time.time()
            self._stop_reason = str(reason or "operator-stop")[:120]
        if was_running:
            self._publish_target(self._last_target or HOME_POSITION)
        self._write_state()
        return {"ok": True, "state": "idle", "reason": reason}

    def reset(self):
        with self._lock:
            if self._state == "fault":
                self._state = "ready" if self._model is not None else "idle"
                self._last_error = None
        return {"ok": True, "state": self._state}

    def _fault(self, message):
        with self._lock:
            self._state = "fault"
            self._last_error = str(message)[:200]
            self._stop_flag.set()
            self._stopped_at = time.time()
            self._stop_reason = "fault:" + str(message)[:60]
        self._publish_target(self._last_target or HOME_POSITION)
        self._write_state()

    def _publish_target(self, target):
        if self._publisher is None or self._JointTrajectory is None:
            return
        msg = self._JointTrajectory()
        msg.joint_names = list(JOINT_NAMES)
        point = self._JointTrajectoryPoint()
        point.positions = [float(value) for value in target]
        point.time_from_start.sec = 0
        point.time_from_start.nanosec = int(1_000_000_000 / DECISION_HZ)
        msg.points = [point]
        self._publisher.publish(msg)
        self._last_target = list(target)

    def _spin_once(self):
        if self._node is None:
            return
        try:
            import rclpy
            rclpy.spin_once(self._node, timeout_sec=0.0)
        except Exception:
            pass

    def _loop(self):
        import numpy as np
        period = 1.0 / DECISION_HZ
        while not self._stop_flag.is_set():
            started = time.time()
            try:
                telemetry = _read_snapshot()
                observation = build_joint_observation(
                    telemetry, JOINT_NAMES, HOME_POSITION, self._last_action, COMMAND_VECTOR_SIZE
                )
                if observation is None:
                    # Hold the last bounded target while sensors recover. No
                    # inference or published counter increment is claimed.
                    if self._last_target is not None:
                        self._publish_target(self._last_target)
                    self._write_state()
                    time.sleep(period)
                    continue
                t0 = time.time()
                result = self._model.run(None, {self._input_name: np.asarray([observation], dtype=np.float32)})[0][0]
                action = [float(value) for value in result]
                target = project_joint_action(
                    action, HOME_POSITION, ACTION_SCALE, self._last_target,
                    MAX_JOINT_STEP, MAX_JOINT_VELOCITY, DECISION_HZ
                )
                self._publish_target(target)
                with self._lock:
                    self._last_action = [max(-1.0, min(1.0, value)) for value in action]
                    self._published += 1
                    elapsed = (time.time() - t0) * 1000.0
                    self._infer_ms = elapsed if not self._infer_ms else 0.9 * self._infer_ms + 0.1 * elapsed
                self._spin_once()
            except Exception as exc:  # noqa: BLE001 - any control error stops policy
                self._fault("loop: " + str(exc))
                return
            self._write_state()
            time.sleep(max(0.0, period - (time.time() - started)))


def _serve(runtime):
    last_seen = ""
    while True:
        time.sleep(0.05)
        try:
            raw = secure_read_text(CMD_FILE)
        except OSError:
            continue
        if not raw.strip() or raw == last_seen:
            continue
        last_seen = raw
        try:
            request = json.loads(raw)
        except ValueError:
            continue
        op = request.get("op")
        if op == "load":
            result = runtime.load(str(request.get("path", "")))
        elif op == "start":
            result = runtime.start(request.get("direction", 0.0), request.get("goalX"), request.get("goalY"))
        elif op == "stop":
            result = runtime.stop(str(request.get("reason", "operator-stop")))
        elif op == "reset":
            result = runtime.reset()
        elif op == "snapshot":
            result = None
        else:
            result = {"ok": False, "error": "unknown-op"}
        if result is not None:
            runtime._record_op(op, request, result)
        runtime._write_state()


def main():
    runtime = JointPolicyRuntime()
    runtime._write_state()
    atomic_write_json(READY_FILE, {"pid": os.getpid(), "actuator": "joint"})
    ros = runtime.bind_ros()
    if not ros.get("ok"):
        runtime._fault(ros.get("error", "ros-unavailable"))
    threading.Thread(target=_serve, args=(runtime,), daemon=True).start()

    def _term(_signal, _frame):
        runtime.stop("sigterm")
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)
    while True:
        time.sleep(1.0)
        runtime._write_state()


if __name__ == "__main__":
    main()
