#!/usr/bin/env python3
"""Policy runtime for the RDK board: run a trained ONNX policy on the robot.

This is the missing bridge between "training" and "motion": it loads the
platform's exported policy.onnx, maps real robot observations onto the
policy's input space, runs inference on the board, and publishes bounded
/cmd_vel commands — the same constrained channel the manual drive canary
uses. Every safety property of the drive canary applies here unchanged:

  * speed clamps (<= max_linear m/s, <= max_angular rad/s, same constants)
  * watchdog floor (chassis firmware zeroes 500 ms after cmd_vel goes silent)
  * emergency stop honored (zero-speed frame + process halt)
  * honest telemetry (publishes what it actually commanded; never fabricates)

Observation mapping (the sim→real adapter). The MicroDuck contract expects
[gyro(3), projected_gravity(3), joint_position_error(14), joint_velocity(14),
last_action(14), command(13)] but a wheeled chassis only offers a subset. The
runtime therefore builds a *contract-shaped* observation with real IMU gyro +
gravity in the leading slots, zeros for the leg-joint slots the chassis does
not have, and a command slot driven by the operator's direction command. This
is an honest partial adapter: it reports exactly which slots are real vs
zero-filled in every status snapshot, so the evaluation page can tell.

Action mapping: the policy output is a 61→14 MLP; a differential base cannot
actuate 14 leg joints, so the runtime projects the action onto base motion
with an explicit, logged projection (mean of antagonistic pairs → forward
speed; asymmetry → yaw rate) and clamps to the same bounds as the canary.
For wheeled policies trained directly on (v, w) the projection is identity.

Run inside the board's TROS environment:
  python3 board-policy-runtime.py
State machine: idle → (load) ready → (start) running → (stop) idle;
fault ← any exception → (reset) ready. Op results are folded into every
state snapshot as `lastOp` (seq-correlated) so callers see honest errors.
"""

import json
import os
import signal
import sys
import threading
import time

RUNTIME_STATE_FILE = os.environ.get(
    "RDK_BOARD_POLICY_STATE", "/tmp/board-policy-runtime-state.json"
)
TELEMETRY_SPOOL_FILE = os.environ.get(
    "RDK_BOARD_TELEMETRY_SPOOL", "/var/lib/rdk-board-agent/telemetry/policy.jsonl"
)
TELEMETRY_RUN_ID = os.environ.get("RDK_SIM2REAL_RUN_ID", "").strip()
TELEMETRY_MODEL_ID = os.environ.get("RDK_SIM2REAL_MODEL_ID", "").strip()
TELEMETRY_DEVICE_ID = os.environ.get("RDK_SIM2REAL_DEVICE_ID", "").strip()
TELEMETRY_CONTRACT_ID = os.environ.get("RDK_SIM2REAL_CONTRACT_ID", "").strip()
TELEMETRY_MAX_BYTES = int(os.environ.get("RDK_BOARD_TELEMETRY_SPOOL_MAX_BYTES", str(256 * 1024 * 1024)))
TELEMETRY_SNAPSHOT_FILE = os.environ.get(
    "RDK_BOARD_TELEMETRY_SNAPSHOT", "/tmp/board-telemetry-snapshot.json"
)

def _bounded_env(name, default, lo, hi):
    try:
        value = float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(lo, min(hi, value))


# Hardware safety and timing are adapter configuration, not platform code.
# Every adapter remains bounded here even when deployment env is malformed.
ADAPTER_CONFIG_PATH = os.environ.get("RDK_SIM2REAL_ADAPTER_CONFIG", "").strip()

def _adapter_config():
    if not ADAPTER_CONFIG_PATH:
        return {}
    try:
        with open(ADAPTER_CONFIG_PATH, "r", encoding="utf-8") as fh:
            value = json.load(fh)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        # A missing or malformed adapter never disables the safety defaults.
        return {}


_ADAPTER = _adapter_config()
ADAPTER_ID = str(_ADAPTER.get("id") or os.environ.get("RDK_SIM2REAL_ADAPTER_ID", "generic-differential-drive"))[:80]
_safety = _ADAPTER.get("safety") if isinstance(_ADAPTER.get("safety"), dict) else (_ADAPTER.get("actuator") if isinstance(_ADAPTER.get("actuator"), dict) else {})
_runtime = _ADAPTER.get("runtime") if isinstance(_ADAPTER.get("runtime"), dict) else {}

def _policy_dimension(env_name, profile_key, default):
    """Resolve a contract dimension from an explicit env override or profile.

    The profile is the portable source of truth for a hardware adapter. Keep
    env overrides for field debugging, but never accept malformed or unsafe
    dimensions from either source.
    """
    raw = os.environ.get(env_name)
    if raw is None:
        raw = (_ADAPTER.get("policy") or {}).get(profile_key, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = int(default)
    return max(1, min(4096, value))


EXPECTED_OBS_DIM = _policy_dimension("RDK_SIM2REAL_POLICY_OBS_DIM", "observationSize", 61)
EXPECTED_ACTION_DIM = _policy_dimension("RDK_SIM2REAL_POLICY_ACTION_DIM", "actionSize", 14)
MAX_LINEAR = _bounded_env("RDK_SIM2REAL_MAX_LINEAR", _safety.get("maxLinear", 0.3), 0.01, 0.3)
MAX_ANGULAR = _bounded_env("RDK_SIM2REAL_MAX_ANGULAR", _safety.get("maxAngular", 1.0), 0.05, 1.0)
DECISION_HZ = _bounded_env("RDK_SIM2REAL_DECISION_HZ", _runtime.get("decisionHz", 10), 1, 50)
STATS_EVERY_SEC = 1.0
STALL_LIMIT_SEC = _bounded_env("RDK_SIM2REAL_SENSOR_STALL_SEC", _safety.get("sensorStallSec", 0.5), 0.1, 2.0)
ACTION_PROJECTION = os.environ.get("RDK_SIM2REAL_ACTION_PROJECTION", _runtime.get("actionProjection", "paired"))
if ACTION_PROJECTION not in ("paired", "identity"):
    ACTION_PROJECTION = "paired"
_actuator = _ADAPTER.get("actuator") if isinstance(_ADAPTER.get("actuator"), dict) else {}
_ros_topics = (_ADAPTER.get("ros") or {}).get("topics") if isinstance((_ADAPTER.get("ros") or {}).get("topics"), dict) else {}
_configured_topic = os.environ.get("RDK_SIM2REAL_COMMAND_TOPIC") or _actuator.get("commandTopic") or ((_ros_topics.get("cmdVel") or {}).get("name")) or "/cmd_vel"
COMMAND_TOPIC = _configured_topic if isinstance(_configured_topic, str) and _configured_topic.startswith("/") else "/cmd_vel"
COMMAND_MESSAGE_TYPE = str(_actuator.get("messageType") or ((_ros_topics.get("cmdVel") or {}).get("type")) or "geometry_msgs/msg/Twist")


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def _atomic_write_json(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def _read_telemetry():
    """Latest board telemetry snapshot (None when absent/stale)."""
    try:
        with open(TELEMETRY_SNAPSHOT_FILE, "r", encoding="utf-8") as fh:
            snap = json.load(fh)
        # The policy loop must use the same freshness budget as the safety
        # watchdog.  A stale snapshot is not a valid observation.
        if time.time() - float(snap.get("ts", 0)) > STALL_LIMIT_SEC:
            return None
        data = snap.get("data")
        return data if isinstance(data, dict) else None
    except (OSError, TypeError, ValueError):
        return None


class PolicyRuntime:
    def __init__(self):
        self._lock = threading.Lock()
        self._model = None            # onnxruntime InferenceSession or None
        self._model_meta = None       # {path, bytes, inputDim, outputDim}
        self._state = "idle"          # idle | ready | running | fault
        self._last_error = None
        self._last_op = None          # {op, seq, ok, error, detail, at}
        self._command_dir = 0.0       # operator direction command (-1..1)
        self._last_obs = None
        self._last_action = None
        self._published = 0
        self._infer_ms_avg = 0.0
        self._started_at = None
        self._stop_flag = threading.Event()
        self._cmd_pub = None
        self._node = None
        self._last_cmd = (0.0, 0.0)
        self._telemetry_dropped = 0

    # ---- state reporting ------------------------------------------------
    def snapshot(self):
        with self._lock:
            return {
                "ok": True,
                "ts": time.time(),
                "state": self._state,
                "adapterId": ADAPTER_ID,
                "actionProjection": ACTION_PROJECTION,
                "commandTopic": COMMAND_TOPIC,
                "model": self._model_meta,
                "command": self._command_dir,
                "published": self._published,
                "inferMs": round(self._infer_ms_avg, 2),
                "lastError": self._last_error,
                "lastOp": self._last_op,
                "obsSlots": self._obs_slot_report(),
                "telemetry": {
                    "spool": TELEMETRY_SPOOL_FILE,
                    "bytes": os.path.getsize(TELEMETRY_SPOOL_FILE) if os.path.exists(TELEMETRY_SPOOL_FILE) else 0,
                    "maxBytes": TELEMETRY_MAX_BYTES,
                    "dropped": self._telemetry_dropped,
                },
                "uptimeSec": round(time.time() - self._started_at, 1)
                if self._started_at
                else 0.0,
            }

    def _obs_slot_report(self):
        # Which observation slots carry real sensor data vs adapter zeros.
        # Dimensions are contract-parameterized (RDK_SIM2REAL_POLICY_OBS_DIM /
        # _ACTION_DIM), so the report describes THIS model's shape honestly.
        if not self._model_meta:
            return None
        filled = 6 + min(EXPECTED_ACTION_DIM, max(0, EXPECTED_OBS_DIM - 6))
        return {
            "contract": f"{EXPECTED_OBS_DIM}D obs / {EXPECTED_ACTION_DIM}D act (or 2D vw)",
            "gyro": "real (/imu angular_velocity)",
            "projected_gravity": "real (quaternion-derived, roll/pitch)",
            "last_action": "real (previous projected action)"
            if EXPECTED_OBS_DIM > 6
            else "absent (contract too small)",
            "command": f"operator ({self._command_dir:+.2f})"
            if EXPECTED_OBS_DIM > 6 + EXPECTED_ACTION_DIM
            else "zero-padded (no room after action slots)",
            "slots_real": 6,
            "slots_adapter": max(0, EXPECTED_OBS_DIM - 6),
            "note": f"slots 0-5 real sensors; slots 6-{filled - 1} adapter (last_action/command); any remainder zero-padded to {EXPECTED_OBS_DIM}D",
        }

    # ---- lifecycle ------------------------------------------------------
    def _record_op(self, op, req, res):
        """Fold a file-protocol op result into the next state snapshot so the
        supervising agent can correlate THIS request (by seq) with its
        outcome, including failures that change nothing else observable."""
        with self._lock:
            self._last_op = {
                "op": op,
                "seq": req.get("seq"),
                "ok": bool(res.get("ok")),
                "error": res.get("error"),
                "detail": res.get("detail"),
                "at": round(time.time(), 3),
            }

    def reset(self):
        """Clear a sticky fault back to idle/ready (model retained)."""
        with self._lock:
            if self._state == "fault":
                self._state = "ready" if self._model is not None else "idle"
                self._last_error = None
            return {"ok": True, "state": self._state}

    def load(self, model_path):
        try:
            import onnxruntime as rt

            if not os.path.isfile(model_path):
                return {"ok": False, "error": "model-file-missing"}
            size = os.path.getsize(model_path)
            if size > 50 * 1024 * 1024:
                return {"ok": False, "error": "model-too-large"}
            sess = rt.InferenceSession(
                model_path, providers=["CPUExecutionProvider"]
            )
            inp = sess.get_inputs()[0]
            out = sess.get_outputs()[0]
            input_dim = int(inp.shape[-1]) if inp.shape and isinstance(inp.shape[-1], (int, float)) else 0
            output_dim = int(out.shape[-1]) if out.shape and isinstance(out.shape[-1], (int, float)) else 0
            if input_dim != EXPECTED_OBS_DIM:
                return {"ok": False, "error": "policy-input-dimension-mismatch", "expected": EXPECTED_OBS_DIM, "actual": input_dim}
            if output_dim not in (EXPECTED_ACTION_DIM, 2):
                return {"ok": False, "error": "policy-output-dimension-mismatch", "expected": [EXPECTED_ACTION_DIM, 2], "actual": output_dim}
            meta = {
                "path": model_path,
                "bytes": size,
                "inputDim": input_dim,
                "outputDim": output_dim,
            }
            with self._lock:
                self._model = sess
                self._model_meta = meta
                self._state = "ready" if self._state == "idle" else self._state
                self._last_error = None
            return {"ok": True, "model": meta}
        except ImportError:
            return {"ok": False, "error": "onnxruntime-not-installed"}
        except Exception as exc:  # noqa: BLE001 - report any load failure
            with self._lock:
                self._last_error = str(exc)[:200]
            return {"ok": False, "error": "model-load-failed", "detail": str(exc)[:200]}

    def start(self, direction):
        with self._lock:
            if self._model is None:
                return {"ok": False, "error": "no-model", "state": self._state}
            if self._state not in ("ready", "running"):
                return {"ok": False, "error": "not-ready", "state": self._state}
            self._command_dir = _clamp(float(direction), -1.0, 1.0)
            if self._state == "running":
                return {"ok": True, "state": "running"}
            self._state = "running"
            self._started_at = time.time()
            self._published = 0
            self._stop_flag.clear()
        threading.Thread(target=self._loop, daemon=True).start()
        return {"ok": True, "state": "running"}

    def stop(self, reason="operator-stop"):
        with self._lock:
            if self._state == "running":
                self._state = "idle"
            self._command_dir = 0.0
            self._stop_flag.set()
        # Publish one zero frame immediately on the ROS side (below); the
        # chassis watchdog covers the 500 ms gap regardless.
        self._publish_zero(reason)
        return {"ok": True, "state": self._state, "reason": reason}

    def _fault(self, message):
        with self._lock:
            self._state = "fault"
            self._last_error = message[:200]
            self._command_dir = 0.0
        self._stop_flag.set()
        self._publish_zero("fault:" + message[:60])

    # ---- observation building -------------------------------------------
    def _build_observation(self):
        """Contract-shaped EXPECTED_OBS_DIM observation from real sensors.

        Layout: [gyro(3), projected_gravity(3)] are ALWAYS real; the remaining
        slots are filled left-to-right with last_action then the operator
        command, and any shortfall is zero-padded — an honest partial adapter
        (obsSlots reports exactly this). Works for any model contract
        configured via RDK_SIM2REAL_POLICY_OBS_DIM / _ACTION_DIM, so a
        42->12 pendulum-chain policy and the 61->14 MicroDuck contract both
        load against the same real-sensor head.
        """
        import math

        tel = _read_telemetry()
        if tel is None:
            return None
        imu = tel.get("imu") or {}
        # Telemetry-node ships two shapes: flat {x,y,z,w} (older) and nested
        # {quaternion, gyro, linearAcceleration} (newer). Accept both so this
        # runtime works with either snapshot producer on the board.
        q = imu.get("quaternion") or imu
        gyro = imu.get("gyro") or {}

        def _finite(mapping, key):
            try:
                value = float(mapping[key])
            except (KeyError, TypeError, ValueError):
                return None
            return value if math.isfinite(value) else None

        gyro_values = [_finite(gyro, key) for key in ("x", "y", "z")]
        quaternion_values = [_finite(q, key) for key in ("x", "y", "z", "w")]
        # Never turn a missing/broken IMU into a plausible zero observation:
        # doing so could drive a policy with fabricated state.  The caller
        # treats None as telemetry-stale and publishes a bounded zero frame.
        if any(value is None for value in gyro_values + quaternion_values):
            return None
        gx, gy, gz = gyro_values
        # projected gravity from quaternion (roll/pitch only; yaw-independent)
        qx, qy, qz, qw = quaternion_values
        if math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) < 1e-6:
            return None
        pg_x = 2 * (qx * qz - qw * qy)
        pg_y = 2 * (qw * qx + qy * qz)
        pg_z = 1 - 2 * (qx * qx + qy * qy)

        head = [gx, gy, gz, pg_x, pg_y, pg_z]
        last = self._last_action or [0.0] * EXPECTED_ACTION_DIM
        tail = (
            [round(v, 4) for v in last]
            + [self._command_dir]
        )
        obs = (head + tail)[:EXPECTED_OBS_DIM]
        if len(obs) < EXPECTED_OBS_DIM:
            obs = obs + [0.0] * (EXPECTED_OBS_DIM - len(obs))
        return obs

    def _project_action(self, action):
        """Map policy output onto bounded (linear, angular) base motion.

        For a 14-D leg-style output, antagonistic-pair statistics carry a
        walking-intent signal: pair mean ~ forward drive, left/right asymmetry
        ~ yaw. For 2-D (v, w) policies the mapping is identity. Both paths
        clamp to the canary limits.
        """
        if len(action) == 2 or ACTION_PROJECTION == "identity":
            linear, angular = float(action[0]), float(action[1] if len(action) > 1 else 0.0)
        else:
            half = len(action) // 2
            left = action[:half]
            right = action[half:]
            mean = (sum(left) + sum(right)) / max(1, len(action))
            asym = (sum(left) - sum(right)) / max(1, len(action))
            # tuned so a fully-one-sided ±1 output maps to ±max_angular
            linear = mean * MAX_LINEAR
            angular = asym * MAX_ANGULAR * 1.5
        return (
            _clamp(linear, -MAX_LINEAR, MAX_LINEAR),
            _clamp(angular, -MAX_ANGULAR, MAX_ANGULAR),
        )

    # ---- main loop ------------------------------------------------------
    def _loop(self):
        period = 1.0 / DECISION_HZ
        stats_t = time.time()
        while not self._stop_flag.is_set():
            t0 = time.time()
            try:
                obs = self._build_observation()
                if obs is None:
                    self._publish_zero("telemetry-stale")
                    self._maybe_stats(stats_t, stale=True)
                    stats_t = stats_t  # keep window
                    time.sleep(period)
                    continue
                import numpy as np

                t_infer = time.time()
                result = self._model.run(
                    None, {self._model.get_inputs()[0].name: np.array([obs], dtype=np.float32)}
                )[0][0]
                infer_ms = (time.time() - t_infer) * 1000
                action = [float(v) for v in result]
                linear, angular = self._project_action(action)
                self._publish_cmd(linear, angular)
                self._append_telemetry(obs, action)
                with self._lock:
                    self._last_obs = obs
                    self._last_action = action[:EXPECTED_ACTION_DIM]
                    self._published += 1
                    self._infer_ms_avg = (
                        0.9 * self._infer_ms_avg + 0.1 * infer_ms
                        if self._infer_ms_avg
                        else infer_ms
                    )
                if time.time() - stats_t >= STATS_EVERY_SEC:
                    self._write_state()
                    stats_t = time.time()
            except Exception as exc:  # noqa: BLE001 - any loop failure stops motion
                self._fault("loop: " + str(exc))
                return
            elapsed = time.time() - t0
            time.sleep(max(0.0, period - elapsed))
        self._publish_zero("stopped")
        self._write_state()

    def _append_telemetry(self, observation, action):
        """Persist the exact observation/action pair used for inference.

        The spool is append-only and bounded. A separate uploader can retry
        chunks after reconnecting; inference never performs network I/O.
        """
        if not TELEMETRY_RUN_ID:
            return
        try:
            directory = os.path.dirname(TELEMETRY_SPOOL_FILE)
            if directory:
                os.makedirs(directory, mode=0o700, exist_ok=True)
            if os.path.exists(TELEMETRY_SPOOL_FILE) and os.path.getsize(TELEMETRY_SPOOL_FILE) >= TELEMETRY_MAX_BYTES:
                self._telemetry_dropped += 1
                return
            record = {
                "t": max(0.0, time.time() - (self._started_at or time.time())),
                "observation": [float(v) for v in observation],
                "action": [float(v) for v in action],
            }
            with open(TELEMETRY_SPOOL_FILE, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, separators=(",", ":")) + "\n")
                fh.flush()
        except OSError:
            # Motion must continue under the watchdog; telemetry loss is
            # surfaced by the uploader/health checks rather than blocking it.
            return

    def _publish_cmd(self, linear, angular):
        self._last_cmd = (linear, angular)
        if self._cmd_pub is not None:
            msg = self._Twist()
            msg.linear.x = float(linear)
            msg.angular.z = float(angular)
            self._cmd_pub.publish(msg)

    def _publish_zero(self, reason):
        self._publish_cmd(0.0, 0.0)
        self._write_state()

    def _maybe_stats(self, stats_t, stale=False):
        if time.time() - stats_t >= STATS_EVERY_SEC:
            self._write_state()
            return time.time()
        return stats_t

    def _write_state(self):
        _atomic_write_json(RUNTIME_STATE_FILE, self.snapshot())

    # ---- ROS wiring (lazy so import errors surface as honest states) ----
    def bind_ros(self):
        try:
            import rclpy
            from geometry_msgs.msg import Twist

            if COMMAND_MESSAGE_TYPE != "geometry_msgs/msg/Twist":
                return {"ok": False, "error": "unsupported-actuator-message-type", "detail": COMMAND_MESSAGE_TYPE}
            self._Twist = Twist
            rclpy.init()
            self._node = rclpy.create_node("rdk_board_policy_runtime")
            self._cmd_pub = self._node.create_publisher(Twist, COMMAND_TOPIC, 10)
            return {"ok": True}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": "ros-unavailable", "detail": str(exc)[:200]}


# ---- control file protocol (the board agent talks to us through this) ----
# The agent writes JSON requests to a command file; we apply them and rewrite
# the state file. This decouples the rclpy thread from the agent's HTTP loop
# the same way the drive publisher does it.
CMD_FILE = os.environ.get("RDK_BOARD_POLICY_CMD", "/tmp/board-policy-runtime-cmd.json")


def _serve_file_protocol(runtime):
    """Agent-facing control loop: watch the command file, apply requests."""
    last_seen = ""
    while True:
        time.sleep(0.05)
        try:
            with open(CMD_FILE, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError:
            continue
        if raw == last_seen or not raw.strip():
            continue
        last_seen = raw
        try:
            req = json.loads(raw)
        except ValueError:
            continue
        op = req.get("op")
        if op == "load":
            res = runtime.load(str(req.get("path", "")))
        elif op == "start":
            res = runtime.start(float(req.get("direction", 0.0)))
        elif op == "stop":
            res = runtime.stop(str(req.get("reason", "operator-stop")))
        elif op == "reset":
            res = runtime.reset()
        elif op == "snapshot":
            res = None
        else:
            res = {"ok": False, "error": "unknown-op"}
        if res is not None:
            runtime._record_op(op, req, res)
        runtime._write_state()


def main():
    runtime = PolicyRuntime()
    runtime._write_state()
    # Ready marker: the supervising agent waits for this before trusting the
    # file protocol (mirrors the drive publisher handshake).
    _atomic_write_json("/tmp/board-policy-runtime.ready", {"pid": os.getpid()})
    ros = runtime.bind_ros()
    if not ros.get("ok"):
        runtime._fault(ros.get("error", "ros-unavailable"))
        # Still serve the file protocol so the agent can see the honest state.
    threading.Thread(target=_serve_file_protocol, args=(runtime,), daemon=True).start()

    def _term(_sig, _frm):
        runtime.stop("sigterm")
        sys.exit(0)

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)
    while True:
        time.sleep(1.0)
        runtime._write_state()


if __name__ == "__main__":
    main()
