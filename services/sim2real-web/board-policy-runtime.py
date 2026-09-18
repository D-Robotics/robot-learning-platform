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
  * source-fresh observations (IMU/odom monotonic sample timestamps must be
    inside the same stall budget; a refreshed wrapper file cannot hide a
    frozen ROS topic)

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
For wheeled policies trained directly on (v, w) the projection is identity;
the separate ``runtime.actionOutput`` declaration says whether that head is
already physical (``physical-twist``) or normalized to [-1, 1]
(``normalized-twist``).  The latter is scaled by the adapter's safety limits
before publication.

OriginBot's native 8→2 contract uses the same observation layout as the
reference environment: [x, y, sin(yaw), cos(yaw), goal_dx, goal_dy, v, w].
The runtime only enables this layout when an explicit
RDK_SIM2REAL_GOAL_X/Y is configured; without a goal it fails closed instead
of silently driving toward an invented target.

Run inside the board's TROS environment:
  python3 board-policy-runtime.py
State machine: idle → (load) ready → (start) running → (stop) idle;
fault ← any exception → (reset) ready. Op results are folded into every
state snapshot as `lastOp` (seq-correlated) so callers see honest errors.
"""

import json
import base64
import hashlib
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
    ensure_private_parent,
    ipc_path,
    secure_append_text,
    secure_read_json,
    secure_read_text,
    secure_size,
)

RUNTIME_STATE_FILE = ipc_path("RDK_BOARD_POLICY_STATE", "policy-runtime-state.json")


def _configured_private_file(env_name, default_path):
    if env_name in os.environ:
        return ipc_path(env_name, os.path.basename(default_path))
    return default_path


TELEMETRY_SPOOL_FILE = _configured_private_file(
    "RDK_BOARD_TELEMETRY_SPOOL", "/var/lib/rdk-board-agent/telemetry/policy.jsonl"
)
TELEMETRY_RUN_ID = os.environ.get("RDK_SIM2REAL_RUN_ID", "").strip()
TELEMETRY_MODEL_ID = os.environ.get("RDK_SIM2REAL_MODEL_ID", "").strip()
TELEMETRY_DEVICE_ID = os.environ.get("RDK_SIM2REAL_DEVICE_ID", "").strip()
TELEMETRY_CONTRACT_ID = os.environ.get("RDK_SIM2REAL_CONTRACT_ID", "").strip()
TELEMETRY_MAX_BYTES = int(os.environ.get("RDK_BOARD_TELEMETRY_SPOOL_MAX_BYTES", str(256 * 1024 * 1024)))
TELEMETRY_SNAPSHOT_FILE = ipc_path(
    "RDK_BOARD_TELEMETRY_SNAPSHOT", "telemetry-snapshot.json"
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
# Keep the adapter-declared contract immutable across model reloads.  The
# native 8D/BPU path temporarily selects an 8→2 model contract below, but a
# later load must be validated against the profile again rather than inheriting
# dimensions from the previous model in this long-lived process.
DECLARED_OBS_DIM = EXPECTED_OBS_DIM
DECLARED_ACTION_DIM = EXPECTED_ACTION_DIM
MAX_LINEAR = _bounded_env("RDK_SIM2REAL_MAX_LINEAR", _safety.get("maxLinear", 0.3), 0.01, 0.3)
MAX_ANGULAR = _bounded_env("RDK_SIM2REAL_MAX_ANGULAR", _safety.get("maxAngular", 1.0), 0.05, 1.0)
DECISION_HZ = _bounded_env("RDK_SIM2REAL_DECISION_HZ", _runtime.get("decisionHz", 10), 1, 50)
STATS_EVERY_SEC = 1.0
STALL_LIMIT_SEC = _bounded_env("RDK_SIM2REAL_SENSOR_STALL_SEC", _safety.get("sensorStallSec", 0.5), 0.1, 2.0)
ACTION_PROJECTION = os.environ.get("RDK_SIM2REAL_ACTION_PROJECTION", _runtime.get("actionProjection", "paired"))
if ACTION_PROJECTION not in ("paired", "identity"):
    ACTION_PROJECTION = "paired"
_configured_action_output = os.environ.get(
    "RDK_SIM2REAL_ACTION_OUTPUT", _runtime.get("actionOutput", "physical-twist")
)
ACTION_OUTPUT = str(_configured_action_output or "physical-twist").strip().lower()[:80]
ACTION_OUTPUT_CONFIG_ERROR = None
if ACTION_OUTPUT not in ("physical-twist", "normalized-twist"):
    ACTION_OUTPUT_CONFIG_ERROR = ACTION_OUTPUT
_actuator = _ADAPTER.get("actuator") if isinstance(_ADAPTER.get("actuator"), dict) else {}
_ros_topics = (_ADAPTER.get("ros") or {}).get("topics") if isinstance((_ADAPTER.get("ros") or {}).get("topics"), dict) else {}
_configured_topic = os.environ.get("RDK_SIM2REAL_COMMAND_TOPIC") or _actuator.get("commandTopic") or ((_ros_topics.get("cmdVel") or {}).get("name")) or "/cmd_vel"
COMMAND_TOPIC = _configured_topic if isinstance(_configured_topic, str) and _configured_topic.startswith("/") else "/cmd_vel"
COMMAND_MESSAGE_TYPE = str(_actuator.get("messageType") or ((_ros_topics.get("cmdVel") or {}).get("type")) or "geometry_msgs/msg/Twist")


# ---- declarative observation layout + inference provider -----------------
# The adapter's runtime block is the single declaration of HOW observations
# are assembled and WHERE inference runs; the runtime code only implements
# the declared layouts. "auto" preserves the legacy dimension-based pick for
# older adapter files, but any layout this runtime does not know fails
# closed at start — a mis-declared adapter must never silently feed a policy
# a differently-shaped observation.
KNOWN_OBSERVATION_LAYOUTS = ("imu-gravity-v1", "originbot-imu-odom-v1", "imu-gravity-camera-v1")
OBSERVATION_LAYOUT = str(
    os.environ.get("RDK_SIM2REAL_OBSERVATION_LAYOUT")
    or _runtime.get("observationLayout")
    or "auto"
).strip().lower() or "auto"

VISION_LAYOUT = OBSERVATION_LAYOUT == "imu-gravity-camera-v1"


def _visual_image_shape():
    """``(channels, height, width)`` declared by the adapter, or ``None``.

    The image shape is board hardware configuration (which camera, which
    downscale), not something the runtime may guess: a policy that expects
    3x64x64 fed a differently-shaped frame would either raise mid-loop or, worse,
    be fed a silently reinterpreted buffer. A vision layout with no declared
    shape therefore fails at start rather than at the first frame.
    """
    raw = os.environ.get("RDK_SIM2REAL_OBSERVATION_IMAGE", "").strip().lower()
    if not raw:
        return None
    parts = raw.replace(",", "x").split("x")
    if len(parts) != 3:
        return None
    try:
        values = tuple(int(part) for part in parts)
    except (TypeError, ValueError):
        return None
    if any(value < 1 or value > 4096 for value in values):
        return None
    return values


VISUAL_IMAGE_SHAPE = _visual_image_shape()


def _frame_stride():
    """How many samples apart the spooled camera frames are.

    ``0`` disables frame spooling entirely, which is what a board without a
    vision policy or with a tight spool budget should set. Bounded so a typo
    cannot turn the spool into a video stream.
    """
    try:
        value = int(os.environ.get("RDK_SIM2REAL_FRAME_STRIDE", "10"))
    except (TypeError, ValueError):
        value = 10
    return max(0, min(600, value))


TELEMETRY_FRAME_STRIDE = _frame_stride()

def _provider_request():
    value = os.environ.get("RDK_BOARD_POLICY_PROVIDER", "").strip().lower()
    if not value:
        value = str(_runtime.get("inferenceProvider") or "cpu").strip().lower()
    return value if value in ("cpu", "bpu") else "cpu"

PROVIDER_REQUESTED = _provider_request()
def _optional_float_env(name):
    try:
        value = float(os.environ[name])
    except (KeyError, TypeError, ValueError):
        return None
    return value if value == value and abs(value) != float("inf") else None

ORIGINBOT_GOAL_X = _optional_float_env("RDK_SIM2REAL_GOAL_X")
ORIGINBOT_GOAL_Y = _optional_float_env("RDK_SIM2REAL_GOAL_Y")


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def _atomic_write_json(path, payload):
    # Keep this local name for callers/tests while delegating all path and
    # inode handling to the shared O_EXCL + O_NOFOLLOW implementation.
    return atomic_write_json(path, payload)


def _iso_timestamp(epoch):
    """Return a bounded UTC ISO-8601 timestamp for evidence fields."""
    if epoch is None:
        return None
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(epoch)))
    except (TypeError, ValueError, OverflowError):
        return None


def _sha256_file(path):
    """Hash a regular model file without loading it all into memory."""
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _read_telemetry():
    """Latest board telemetry snapshot (None when absent/stale)."""
    try:
        snap = secure_read_json(TELEMETRY_SNAPSHOT_FILE)
        # The policy loop must use the same freshness budget as the safety
        # watchdog.  A stale snapshot is not a valid observation.
        snapshot_ts = float(snap.get("ts", 0))
        now = time.time()
        # Reject malformed and implausibly future wall-clock values too.  A
        # clock jump must never turn an old sensor frame into a fresh one.
        if not math.isfinite(snapshot_ts) or snapshot_ts - now > 0.25:
            return None
        if now - snapshot_ts > STALL_LIMIT_SEC:
            return None
        data = snap.get("data")
        return data if isinstance(data, dict) else None
    except (OSError, TypeError, ValueError):
        return None


def _sensor_sample_fresh(sensor, *, now_monotonic_ns=None):
    """Validate the source timestamp carried by a sensor sample.

    The sampler rewrites the wrapper file periodically.  Looking only at the
    wrapper's ``ts`` therefore cannot detect a frozen ROS topic.  Motion
    policies require a monotonic source timestamp on every sensor they use;
    missing metadata fails closed instead of accepting a legacy/unverifiable
    frame.  A small future tolerance handles scheduling/clock conversion
    noise but still rejects impossible timestamps.
    """
    if not isinstance(sensor, dict):
        return False
    try:
        sample_ns = int(sensor.get("sampleMonotonicNs"))
    except (TypeError, ValueError, OverflowError):
        return False
    if sample_ns <= 0:
        return False
    now_ns = time.monotonic_ns() if now_monotonic_ns is None else int(now_monotonic_ns)
    age_sec = (now_ns - sample_ns) / 1_000_000_000.0
    return math.isfinite(age_sec) and age_sec >= -0.25 and age_sec <= STALL_LIMIT_SEC


def _read_camera_frame():
    """The declared image as a flat float list, or ``None``.

    Fail-closed on every axis, because the alternative is a policy acting on a
    fabricated or silently reinterpreted frame:

    - the snapshot must exist and be fresh (same wall-clock rules as the IMU);
    - the frame must carry a monotonic source stamp inside the same stall
      budget, so a frozen camera topic cannot be mistaken for a live one;
    - its channel count and length must match the declared shape exactly, so a
      driver that changed resolution or pixel format fails instead of being
      reshaped into something plausible.

    The frame is intentionally NOT written to the telemetry spool: that spool
    carries flat float observation/action pairs at control rate, and a frame per
    step would inflate it by orders of magnitude. Frames are inference input,
    not telemetry, and replay uses the recorded vector observation.
    """
    if VISUAL_IMAGE_SHAPE is None:
        return None
    channels, height, width = VISUAL_IMAGE_SHAPE
    try:
        snap = secure_read_json(TELEMETRY_SNAPSHOT_FILE)
        snapshot_ts = float(snap.get("ts", 0))
        now = time.time()
        if not math.isfinite(snapshot_ts) or snapshot_ts - now > 0.25:
            return None
        if now - snapshot_ts > STALL_LIMIT_SEC:
            return None
        data = snap.get("data")
        if not isinstance(data, dict):
            return None
        camera = data.get("camera")
        if not _sensor_sample_fresh(camera):
            return None
        frame = camera.get("data")
        if not isinstance(frame, list):
            return None
        try:
            declared_channels = int(camera.get("channels", channels))
        except (TypeError, ValueError, OverflowError):
            return None
        if declared_channels != channels:
            return None
        expected = channels * height * width
        if len(frame) != expected:
            return None
        values = []
        for value in frame:
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                return None
            if not math.isfinite(numeric):
                return None
            values.append(numeric)
        return values
    except (OSError, TypeError, ValueError):
        return None


def wheeled_observation_layout(obs_dim, action_dim):
    """Named segments the wheeled adapter fills, as (name, width, provenance).

    Single source of truth for the slot arithmetic: the load path refuses a
    contract these do not fit exactly, and `_build_observation` writes exactly
    these. Keeping one function means the check cannot drift from the assembly.
    """
    remaining = max(0, obs_dim - 6)
    action_width = min(action_dim, remaining)
    command_width = 1 if remaining > action_width else 0
    return (
        ("gyro", 3, "real"),
        ("projected_gravity", 3, "real"),
        ("last_action", action_width, "adapter"),
        ("command", command_width, "adapter"),
    )


def goalnav_tail_slots(obs_dim, action_dim):
    """Goal-navigation slots after the six sensor slots, or None.

    The starter-ppo and mjx-adapter trainers build the 42D imu-gravity-v1
    goalnav contract as [gyro(3), gravity(3), last_action(2), goal_delta(2),
    twist(2), zeros(30)] — body-frame goal delta (slots 8-9) and believed
    twist (slots 10-11). A runtime that zero-fills those slots runs a policy
    with no idea where its goal is; it must either source them or refuse.
    Only the exact 42D/2D goalnav shape qualifies: other widths keep the
    generic partial-adapter behaviour (zero-fill, reported in obsSlots).
    """
    if obs_dim == 42 and action_dim == 2:
        return {"last_action": 2, "goal_delta": 2, "twist": 2}
    return None


def wheeled_observation_size(obs_dim, action_dim):
    """Total slots `wheeled_observation_layout` fills.

    Never exceeds `obs_dim`: the layout caps itself. That is a property of this
    arithmetic, not a checked precondition, and it means the assembly can never
    overflow the contract -- the shortfall (if any) is zero-padded by design.
    """
    return sum(width for _, width, _ in wheeled_observation_layout(obs_dim, action_dim))


class PolicyRuntime:
    def __init__(self):
        self._lock = threading.Lock()
        self._model = None            # onnxruntime session or hobot_dnn model
        self._model_kind = None       # onnx | bpu
        self._model_meta = None       # {path, bytes, inputDim, outputDim}
        # Resolved at load time from the real session inputs so the control loop
        # never has to search for them (a lookup failure inside the loop would
        # raise, and any raise in the loop stops motion).
        self._vector_input_name = ""
        self._image_input_name = ""
        # Counts spooled samples so frames can be emitted every Nth one.
        self._spool_sample_index = 0
        self._state = "idle"          # idle | ready | running | fault
        self._last_error = None
        self._last_op = None          # {op, seq, ok, error, detail, at}
        self._command_dir = 0.0       # operator direction command (-1..1)
        self._last_obs = None
        self._last_action = None
        # Named observation segments the wheeled adapter actually wrote, as
        # (name, width, provenance). Populated by _build_observation so the slot
        # report describes the real assembly instead of a hand-written literal.
        self._obs_segments = ()
        self._published = 0
        self._infer_ms_avg = 0.0
        self._started_at = None
        self._stop_flag = threading.Event()
        self._cmd_pub = None
        self._node = None
        self._last_cmd = (0.0, 0.0)
        self._telemetry_dropped = 0
        self._goal = (ORIGINBOT_GOAL_X, ORIGINBOT_GOAL_Y)
        # A policy load and a policy motion session are separate lifecycle
        # objects.  The session fields below make every board run auditable:
        # callers can tell which exact model was active, when motion began,
        # how many inferences were published, and why it stopped.  Evidence
        # survives a stop/fault until the next explicit start; it is never
        # replaced by a fabricated "healthy" snapshot.
        self._session_id = None
        self._session_started_at = None
        self._session_stopped_at = None
        self._session_stop_reason = "never-started"
        self._session_stop_event_emitted = False
        self._inference_count = 0
        self._last_inference_at = None

    # ---- state reporting ------------------------------------------------
    def snapshot(self):
        try:
            spool_bytes = secure_size(TELEMETRY_SPOOL_FILE)
        except OSError:
            spool_bytes = 0
        with self._lock:
            return {
                "ok": True,
                "ts": time.time(),
                "state": self._state,
                "adapterId": ADAPTER_ID,
                "actionProjection": ACTION_PROJECTION,
                "actionOutput": ACTION_OUTPUT,
                "actionOutputConfigError": ACTION_OUTPUT_CONFIG_ERROR,
                "actionScale": {
                    "linear": float(MAX_LINEAR),
                    "angular": float(MAX_ANGULAR),
                    "units": "m/s,rad/s",
                },
                "commandTopic": COMMAND_TOPIC,
                "observationLayout": OBSERVATION_LAYOUT,
                "providerRequested": PROVIDER_REQUESTED,
                "model": self._model_meta,
                "command": self._command_dir,
                "lastCmdVel": {
                    "linear": float(self._last_cmd[0]),
                    "angular": float(self._last_cmd[1]),
                },
                "controlHz": int(DECISION_HZ),
                "controlPeriodSeconds": float(1.0 / DECISION_HZ),
                "published": self._published,
                "inferMs": round(self._infer_ms_avg, 2),
                "lastError": self._last_error,
                "lastOp": self._last_op,
                "session": {
                    "id": self._session_id,
                    "startedAt": _iso_timestamp(self._session_started_at),
                    "stoppedAt": _iso_timestamp(self._session_stopped_at),
                    "stopReason": self._session_stop_reason,
                    "inferenceCount": self._inference_count,
                    "lastInferenceAt": _iso_timestamp(self._last_inference_at),
                    "durationSec": round(
                        max(
                            0.0,
                            (self._session_stopped_at or time.time())
                            - self._session_started_at,
                        ),
                        3,
                    )
                    if self._session_started_at
                    else 0.0,
                    "mock": False,
                },
                "obsSlots": self._obs_slot_report(),
                "goal": {"x": self._goal[0], "y": self._goal[1]}
                if self._goal[0] is not None and self._goal[1] is not None
                else None,
                "telemetry": {
                    "spool": TELEMETRY_SPOOL_FILE,
                    "bytes": spool_bytes,
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
        if EXPECTED_OBS_DIM == 8 and EXPECTED_ACTION_DIM == 2:
            return {
                "contract": "8D obs / 2D act (native OriginBot twist)",
                "layoutDeclared": OBSERVATION_LAYOUT != "auto",
                "layoutSource": "adapter declaration" if OBSERVATION_LAYOUT != "auto" else "auto (dimension-based)",
                "layout": "originbot-imu-odom-v1" if OBSERVATION_LAYOUT == "auto" else OBSERVATION_LAYOUT,
                "source": "real (/odom + /imu)",
                "goal": "explicit RDK_SIM2REAL_GOAL_X/Y required",
                "slots_real": 8,
                "slots_adapter": 0,
            }
        if (
            goalnav_tail_slots(EXPECTED_OBS_DIM, EXPECTED_ACTION_DIM) is not None
            and (OBSERVATION_LAYOUT == "imu-gravity-v1"
                 or (OBSERVATION_LAYOUT == "auto" and EXPECTED_OBS_DIM == 42))
        ):
            return {
                "contract": "42D obs / 2D act (goalnav imu-gravity-v1)",
                "layoutDeclared": OBSERVATION_LAYOUT != "auto",
                "layoutSource": "adapter declaration" if OBSERVATION_LAYOUT != "auto" else "auto (dimension-based)",
                "layout": "imu-gravity-v1",
                "source": "real (/imu gyro+gravity, /odom pose+twist)",
                "goal": "explicit goalX/goalY (odom absolute) required at start",
                "slots_real": 10,
                "slots_adapter": 32,
                "slotPlan": [
                    {"name": "gyro", "width": 3, "provenance": "real"},
                    {"name": "projected_gravity", "width": 3, "provenance": "real"},
                    {"name": "last_action", "width": 2, "provenance": "adapter (normalized last cmd)"},
                    {"name": "goal_delta", "width": 2, "provenance": "real (/odom + goal)"},
                    {"name": "twist", "width": 2, "provenance": "real (/odom)"},
                    {"name": "zeros", "width": EXPECTED_OBS_DIM - 12, "provenance": "adapter"},
                ],
            }
        # Built from the recorded segments (what _build_observation actually
        # wrote) rather than a hand-written literal: the previous strings said
        # "slots 0-5 real; slots 6-N adapter" without knowing whether that was
        # true, so a contract the adapter did not fit would have been described
        # confidently and wrongly. Before the first observation there is nothing
        # to report yet, which is stated rather than guessed.
        with self._lock:
            segments = self._obs_segments
        if not segments:
            return {
                "contract": f"{EXPECTED_OBS_DIM}D obs / {EXPECTED_ACTION_DIM}D act (or 2D vw)",
                "source": "no observation assembled yet in this session",
                "slots_real": 0,
                "slots_adapter": 0,
                "slotPlan": [
                    {"name": name, "width": width, "provenance": provenance}
                    for name, width, provenance in wheeled_observation_layout(
                        EXPECTED_OBS_DIM, EXPECTED_ACTION_DIM
                    )
                ],
            }
        offset = 0
        entries = []
        for name, width, provenance in segments:
            entries.append(
                {
                    "name": name,
                    "range": f"{offset}-{offset + width - 1}" if width else "absent",
                    "width": width,
                    "provenance": provenance,
                }
            )
            offset += width
        real = sum(width for _, width, provenance in segments if provenance == "real")
        adapter = sum(width for _, width, provenance in segments if provenance == "adapter")
        report = {
            "contract": f"{EXPECTED_OBS_DIM}D obs / {EXPECTED_ACTION_DIM}D act (or 2D vw)",
            "source": "real sensors where marked real; other slots are honest adapter values",
            "slots_real": real,
            "slots_adapter": adapter,
            "slots_total": offset,
            "slots": entries,
            "note": "ranges describe what the adapter actually wrote this session; "
                    f"the assembled vector is exactly {offset} slots and must equal the contract",
        }
        if VISION_LAYOUT:
            # The image is a separate model input, not a slot in the vector
            # contract, so it is reported separately rather than inflating
            # slots_real. Absent shape/input means the load path already failed,
            # so reaching here with a missing one would be a bug worth showing.
            report["image"] = (
                "real (camera frame -> model image input)"
                if VISUAL_IMAGE_SHAPE and self._image_input_name
                else "missing (no declared shape or no model image input)"
            )
            report["imageShape"] = list(VISUAL_IMAGE_SHAPE) if VISUAL_IMAGE_SHAPE else None
            report["imageInput"] = self._image_input_name or None
        return report

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
        global EXPECTED_OBS_DIM, EXPECTED_ACTION_DIM
        with self._lock:
            if self._state == "running":
                return {"ok": False, "error": "model-load-while-running", "state": self._state}
            if ACTION_OUTPUT_CONFIG_ERROR is not None:
                return {
                    "ok": False,
                    "error": "action-output-mode-invalid",
                    "detail": "runtime.actionOutput must be physical-twist or normalized-twist",
                    "actual": ACTION_OUTPUT_CONFIG_ERROR,
                }
            # Loading is transactional from the actuator's point of view. A
            # failed replacement must not leave the previous model object
            # paired with the newly reset contract dimensions. Clear the old
            # model first; callers must explicitly load a valid replacement
            # before motion can become ready again.
            self._model = None
            self._model_kind = None
            self._model_meta = None
            self._state = "idle"
            self._last_error = None
            # Do not let a previous 8D native load poison the next contract
            # check (or vice versa).  A model reload is a fresh declaration
            # boundary even though the process remains alive.
            EXPECTED_OBS_DIM = DECLARED_OBS_DIM
            EXPECTED_ACTION_DIM = DECLARED_ACTION_DIM
        try:
            if model_path.lower().endswith('.bin'):
                import numpy as np
                from hobot_dnn import pyeasy_dnn
                if not os.path.isfile(model_path):
                    return {"ok": False, "error": "model-file-missing"}
                size = os.path.getsize(model_path)
                if size > 50 * 1024 * 1024:
                    return {"ok": False, "error": "model-too-large"}
                loaded = pyeasy_dnn.load(model_path)
                if not loaded:
                    return {"ok": False, "error": "bpu-model-empty"}
                model = loaded[0]
                in_shape = tuple(int(v) for v in model.inputs[0].buffer.shape)
                out_shape = tuple(int(v) for v in model.outputs[0].buffer.shape)
                if in_shape != (1, 8, 1, 1) or out_shape != (1, 2, 1, 1):
                    return {"ok": False, "error": "policy-shape-mismatch", "expectedInput": [1, 8, 1, 1], "actualInput": list(in_shape), "expectedOutput": [1, 2, 1, 1], "actualOutput": list(out_shape)}
                EXPECTED_OBS_DIM = 8
                EXPECTED_ACTION_DIM = 2
                meta = {"path": model_path, "bytes": size, "inputDim": 8, "outputDim": 2, "provider": "hobot_dnn", "providerRequested": PROVIDER_REQUESTED, "format": "bpu-bin", "inputShape": list(in_shape), "outputShape": list(out_shape), "sha256": _sha256_file(model_path)}
                meta["actionOutput"] = ACTION_OUTPUT
                meta["actionScale"] = {"linear": float(MAX_LINEAR), "angular": float(MAX_ANGULAR), "units": "m/s,rad/s"}
                with self._lock:
                    self._model = model
                    self._model_kind = "bpu"
                    self._model_meta = meta
                    self._state = "ready" if self._state == "idle" else self._state
                    self._last_error = None
                return {"ok": True, "model": meta}
            import onnxruntime as rt

            if not os.path.isfile(model_path):
                return {"ok": False, "error": "model-file-missing"}
            size = os.path.getsize(model_path)
            if size > 50 * 1024 * 1024:
                return {"ok": False, "error": "model-too-large"}
            # Provider selection is explicit and fail-closed: a requested BPU
            # provider that this onnxruntime build does not register refuses
            # the load instead of silently falling back to CPU — the station
            # UI then shows exactly what is available on this board.
            available = list(rt.get_available_providers())
            if PROVIDER_REQUESTED == "bpu":
                bpu = [name for name in available if "bpu" in name.lower()]
                if not bpu:
                    return {
                        "ok": False,
                        "error": "bpu-provider-unavailable",
                        "detail": "requested BPU inference but this onnxruntime provides: "
                                  + ", ".join(available),
                    }
                session_providers = bpu
            else:
                session_providers = ["CPUExecutionProvider"]
            sess = rt.InferenceSession(
                model_path, providers=session_providers
            )
            inputs = sess.get_inputs()
            # The vector input is matched by RANK, not by position: a vision
            # export has two inputs and onnxruntime does not promise an order,
            # so `get_inputs()[0]` would silently read the image's last axis as
            # the observation width on a model that happened to list it first.
            vector_inputs = [i for i in inputs if len(i.shape) == 2]
            if not vector_inputs:
                return {
                    "ok": False,
                    "error": "policy-input-dimension-mismatch",
                    "detail": "no rank-2 observation input in this model",
                    "actual": [list(i.shape) for i in inputs],
                }
            inp = vector_inputs[0]
            out = sess.get_outputs()[0]
            input_dim = int(inp.shape[-1]) if inp.shape and isinstance(inp.shape[-1], (int, float)) else 0
            output_dim = int(out.shape[-1]) if out.shape and isinstance(out.shape[-1], (int, float)) else 0
            if input_dim not in (EXPECTED_OBS_DIM, 8):
                return {"ok": False, "error": "policy-input-dimension-mismatch", "expected": [EXPECTED_OBS_DIM, 8], "actual": input_dim}
            if output_dim not in (EXPECTED_ACTION_DIM, 2):
                return {"ok": False, "error": "policy-output-dimension-mismatch", "expected": [EXPECTED_ACTION_DIM, 2], "actual": output_dim}
            if ACTION_PROJECTION == "identity" and output_dim != 2:
                return {
                    "ok": False,
                    "error": "identity-action-dimension-mismatch",
                    "detail": "identity projection requires a 2D (linear, angular) policy head",
                    "actual": output_dim,
                }
            # Declared layout and loaded model must agree. "auto" keeps the
            # legacy dimension pick (the 8 in the allowlists above); an
            # explicitly declared layout pins the contract: the model input
            # must match both the declared layout and the adapter's declared
            # observationSize exactly — no cross-layout papering over.
            if OBSERVATION_LAYOUT == "originbot-imu-odom-v1" and (input_dim != 8 or EXPECTED_OBS_DIM != 8):
                return {"ok": False, "error": "layout-model-mismatch",
                        "detail": "adapter declares originbot-imu-odom-v1 (observationSize=%d) but model input is %dD" % (EXPECTED_OBS_DIM, input_dim)}
            if OBSERVATION_LAYOUT == "imu-gravity-v1" and input_dim != EXPECTED_OBS_DIM:
                return {"ok": False, "error": "layout-model-mismatch",
                        "detail": "adapter declares imu-gravity-v1 (contract head %dD) but model input is %dD" % (EXPECTED_OBS_DIM, input_dim)}
            # ---- vision branch ---------------------------------------------
            # A declared vision layout is a claim that this model consumes a
            # camera frame. Check it against the real session inputs now, the
            # same way the vector layouts are checked, so a model exported
            # without its image branch is rejected at load instead of failing
            # (or worse, being read as vector-only) at the first frame.
            image_input_name = ""
            if VISION_LAYOUT:
                if VISUAL_IMAGE_SHAPE is None:
                    return {
                        "ok": False,
                        "error": "observation-image-shape-missing",
                        "detail": "layout imu-gravity-camera-v1 requires "
                                  "RDK_SIM2REAL_OBSERVATION_IMAGE (channelsxheightxwidth)",
                    }
                channels, height, width = VISUAL_IMAGE_SHAPE
                rank4 = [i for i in inputs if len(i.shape) == 4]
                if len(rank4) != 1:
                    return {
                        "ok": False,
                        "error": "layout-model-mismatch",
                        "detail": "layout imu-gravity-camera-v1 requires exactly one rank-4 image "
                                  "input; this model exposes %d" % len(rank4),
                    }
                image_input = rank4[0]
                image_input_name = str(image_input.name)
                declared_channels = image_input.shape[-1]
                if not isinstance(declared_channels, (int, float)):
                    return {
                        "ok": False,
                        "error": "layout-model-mismatch",
                        "detail": "model image input %r has a dynamic channel axis; the declared "
                                  "shape %dx%dx%d cannot be verified" % (image_input.name, channels, height, width),
                    }
                if int(declared_channels) != channels:
                    return {
                        "ok": False,
                        "error": "layout-model-mismatch",
                        "detail": "declared image has %d channels but model input %r has %d"
                                  % (channels, image_input.name, int(declared_channels)),
                    }
            if not image_input_name and not inp.name:
                return {"ok": False, "error": "policy-input-name-missing"}
            vector_input_name = str(inp.name)
            # ---- recurrent state: refuse, do not silently run on zeros ------
            # This runtime binds exactly two input roles, the observation (and,
            # for a vision export, the frame). A recurrent export adds history
            # inputs (h_in/c_in) whose carried values are the whole point of the
            # policy. ONNX Runtime would happily default them to zeros on every
            # step, so the duck would run a policy that never remembers anything
            # and produce plausible-looking but wrong actions -- far worse than
            # refusing. Until the carried-state contract is implemented here, a
            # graph that exposes unbound inputs is rejected at load, with their
            # names in the error so the operator knows what to fix.
            bound_names = {str(inp.name)}
            if image_input_name:
                bound_names.add(image_input_name)
            unbound_inputs = [item for item in inputs if str(item.name) not in bound_names]
            state_inputs = [item for item in unbound_inputs if len(item.shape) == 3]
            if state_inputs:
                return {
                    "ok": False,
                    "error": "policy-state-input-unsupported",
                    "detail": "this export carries recurrent state (%s) but the board runtime does "
                              "not carry it across steps yet; loading it would run the policy on "
                              "zeroed history every step"
                              % ", ".join(str(item.name) for item in state_inputs),
                    "stateInputs": [str(item.name) for item in state_inputs],
                }
            if unbound_inputs:
                return {
                    "ok": False,
                    "error": "policy-input-unbound",
                    "detail": "this export declares inputs (%s) that the board runtime cannot feed"
                              % ", ".join(str(item.name) for item in unbound_inputs),
                    "unboundInputs": [str(item.name) for item in unbound_inputs],
                }
            # Select the adapter contract from the inspected model. This lets
            # OriginBot 8D->2D policies share the same runtime as 61D->14D
            # policies without a second board service.
            if input_dim == 8 and not VISION_LAYOUT:
                EXPECTED_OBS_DIM = 8
                EXPECTED_ACTION_DIM = 2
            meta = {
                "path": model_path,
                "bytes": size,
                "inputDim": input_dim,
                "outputDim": output_dim,
                "provider": session_providers[0],
                "providerRequested": PROVIDER_REQUESTED,
                "providersAvailable": available[:8],
                "sha256": _sha256_file(model_path),
                "actionOutput": ACTION_OUTPUT,
                "actionScale": {"linear": float(MAX_LINEAR), "angular": float(MAX_ANGULAR), "units": "m/s,rad/s"},
                "observationLayout": OBSERVATION_LAYOUT,
                "imageInput": image_input_name or None,
                "imageShape": list(VISUAL_IMAGE_SHAPE) if (VISION_LAYOUT and VISUAL_IMAGE_SHAPE) else None,
            }
            with self._lock:
                self._model = sess
                self._model_kind = "onnx"
                self._model_meta = meta
                self._vector_input_name = vector_input_name
                self._image_input_name = image_input_name
                self._state = "ready" if self._state == "idle" else self._state
                self._last_error = None
            return {"ok": True, "model": meta}
        except ImportError:
            return {"ok": False, "error": "onnxruntime-not-installed"}
        except Exception as exc:  # noqa: BLE001 - report any load failure
            with self._lock:
                self._last_error = str(exc)[:200]
            return {"ok": False, "error": "model-load-failed", "detail": str(exc)[:200]}

    def start(self, direction, goal_x=None, goal_y=None):
        with self._lock:
            if self._model is None:
                return {"ok": False, "error": "no-model", "state": self._state}
            if self._state not in ("ready", "running"):
                return {"ok": False, "error": "not-ready", "state": self._state}
            if OBSERVATION_LAYOUT not in KNOWN_OBSERVATION_LAYOUTS and OBSERVATION_LAYOUT != "auto":
                return {"ok": False, "error": "observation-layout-unknown",
                        "detail": "adapter/env declares layout %r which this runtime does not implement" % OBSERVATION_LAYOUT,
                        "known": list(KNOWN_OBSERVATION_LAYOUTS)}
            goalnav_42d = goalnav_tail_slots(EXPECTED_OBS_DIM, EXPECTED_ACTION_DIM) is not None and (
                OBSERVATION_LAYOUT == "imu-gravity-v1"
                or (OBSERVATION_LAYOUT == "auto" and EXPECTED_OBS_DIM == 42)
            )
            if (EXPECTED_OBS_DIM == 8 and EXPECTED_ACTION_DIM == 2) or goalnav_42d:
                if goal_x is not None or goal_y is not None:
                    try:
                        candidate = (float(goal_x), float(goal_y))
                        if not all(value == value and abs(value) != float("inf") for value in candidate):
                            raise ValueError
                        self._goal = candidate
                    except (TypeError, ValueError):
                        return {"ok": False, "error": "invalid-goal", "detail": "goalX/goalY 需为有限数值"}
                if self._goal[0] is None or self._goal[1] is None:
                    contract = "8D OriginBot" if EXPECTED_OBS_DIM == 8 else "42D goalnav (imu-gravity-v1)"
                    return {"ok": False, "error": "goal-required",
                            "message": "%s 策略需要 goalX/goalY（odom 绝对坐标）" % contract}
            self._command_dir = _clamp(float(direction), -1.0, 1.0)
            if self._state == "running":
                return {"ok": True, "state": "running"}
            self._state = "running"
            self._started_at = time.time()
            self._published = 0
            self._session_id = str(uuid.uuid4())
            self._session_started_at = self._started_at
            self._session_stopped_at = None
            self._session_stop_reason = None
            self._session_stop_event_emitted = False
            self._inference_count = 0
            self._last_inference_at = None
            self._stop_flag.clear()
            # Snapshot the session facts under the lock; the event append
            # below does file I/O and must not hold the control lock.
            started_event = {
                "kind": "session-started",
                "sessionId": self._session_id,
                "startedAt": _iso_timestamp(self._session_started_at),
                "adapterId": ADAPTER_ID,
                "controlHz": int(DECISION_HZ),
                "mock": False,
                "model": self._session_model_summary(),
            }
            if self._goal[0] is not None and self._goal[1] is not None:
                # The goal is task evidence: the acceptance question is
                # "did the robot reach THIS point and stop", so the target
                # rides the lifecycle marker next to the session it framed.
                started_event["goalX"] = round(self._goal[0], 4)
                started_event["goalY"] = round(self._goal[1], 4)
        self._append_event_record(started_event)
        threading.Thread(target=self._loop, daemon=True).start()
        return {"ok": True, "state": "running"}

    def stop(self, reason="operator-stop"):
        now = time.time()
        with self._lock:
            if self._state == "running":
                self._state = "idle"
                self._session_stopped_at = now
                self._session_stop_reason = str(reason or "operator-stop")[:120]
            elif self._session_id and self._session_stopped_at is None:
                # A concurrent loop/fault may have already changed state; keep
                # the first terminal timestamp and reason deterministic.
                self._session_stopped_at = now
                self._session_stop_reason = str(reason or "operator-stop")[:120]
            elif not self._session_id:
                self._session_stop_reason = str(reason or "operator-stop")[:120]
            self._command_dir = 0.0
            self._stop_flag.set()
            stopped_event = self._session_stopped_event_locked()
        # Publish one zero frame immediately on the ROS side (below); the
        # chassis watchdog covers the 500 ms gap regardless.
        self._publish_zero(reason)
        if stopped_event is not None:
            self._append_event_record(stopped_event)
        return {"ok": True, "state": self._state, "reason": reason}

    def _fault(self, message):
        now = time.time()
        with self._lock:
            self._state = "fault"
            self._last_error = message[:200]
            self._command_dir = 0.0
            if self._session_id and self._session_stopped_at is None:
                self._session_stopped_at = now
                self._session_stop_reason = "fault:" + message[:60]
            stopped_event = self._session_stopped_event_locked()
        self._stop_flag.set()
        self._publish_zero("fault:" + message[:60])
        if stopped_event is not None:
            self._append_event_record(stopped_event)

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
        odom = tel.get("odom") or {}
        # Validate source samples before decoding values.  The outer snapshot
        # timestamp only proves that the sampler process is alive; these
        # per-sensor stamps prove that the IMU/odom topics themselves are
        # advancing within the same watchdog budget.
        if not _sensor_sample_fresh(imu):
            return None
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

        # The OriginBot trainer and runtime share this exact native wheeled
        # layout. A real goal is mandatory: the policy must never infer a
        # target from a stale demo value or from the operator direction.
        # The layout is selected by the adapter's declaration (with "auto"
        # preserving the legacy dimension-based pick).
        native_layout = (
            OBSERVATION_LAYOUT == "originbot-imu-odom-v1"
            or (OBSERVATION_LAYOUT == "auto" and EXPECTED_OBS_DIM == 8 and EXPECTED_ACTION_DIM == 2)
        )
        if native_layout:
            if not _sensor_sample_fresh(odom):
                return None
            if self._goal[0] is None or self._goal[1] is None:
                return None
            def _odom_value(*keys):
                for key in keys:
                    value = _finite(odom, key)
                    if value is not None:
                        return value
                return None
            x = _odom_value("positionX", "x")
            y = _odom_value("positionY", "y")
            v = _odom_value("linearX", "v")
            w = _odom_value("angularZ", "w")
            if any(value is None for value in (x, y, v, w)):
                return None
            quaternion_values = [_finite(q, key) for key in ("x", "y", "z", "w")]
            if any(value is None for value in quaternion_values):
                return None
            qx, qy, qz, qw = quaternion_values
            norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
            if norm < 1e-6:
                return None
            qx, qy, qz, qw = (value / norm for value in quaternion_values)
            yaw = math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz))
            return [x, y, math.sin(yaw), math.cos(yaw), self._goal[0] - x, self._goal[1] - y, v, w]

        gyro_values = [_finite(gyro, key) for key in ("x", "y", "z")]
        quaternion_values = [_finite(q, key) for key in ("x", "y", "z", "w")]
        # Never turn a missing/broken IMU into a plausible zero observation:
        # doing so could drive a policy with fabricated state.  The caller
        # treats None as telemetry-stale and publishes a bounded zero frame.
        if any(value is None for value in gyro_values + quaternion_values):
            return None
        gx, gy, gz = gyro_values
        # projected gravity from quaternion (roll/pitch only; yaw-independent).
        # The training environments use the conventional robotics vector
        # ``gravity = (0, 0, -1)``; keeping that sign here is load-bearing:
        # feeding +1 to a policy trained on -1 produces a valid-shaped but
        # semantically inverted observation and can drive a real base.
        qx, qy, qz, qw = quaternion_values
        quaternion_norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
        if quaternion_norm < 1e-6:
            return None
        # ROS publishers normally normalize orientation, but this boundary is
        # also used with recorded/replayed telemetry.  Normalize here so a
        # harmless serializer scale cannot change the policy's gravity
        # magnitude while preserving the zero-norm fail-closed guard.
        qx, qy, qz, qw = (value / quaternion_norm for value in (qx, qy, qz, qw))
        pg_x = 2 * (qw * qy - qx * qz)
        pg_y = 2 * (-qw * qx - qy * qz)
        pg_z = 2 * (qx * qx + qy * qy) - 1

        # The 42D goalnav contract (imu-gravity-v1, 42 obs / 2 act) carries the
        # goal and believed twist in slots 6-11, exactly as both trainers build
        # it: [gyro(3), gravity(3), last_action(2), goal_delta(2), twist(2),
        # zeros(30)]. The goal delta is the odom-pose delta rotated into the
        # chassis frame via the odom quaternion yaw — the same believed pose
        # the 8D path uses. Zero-filling these slots would run a policy with no
        # idea where its goal is, so a missing goal or dead odom fails closed.
        goalnav_tail = goalnav_tail_slots(EXPECTED_OBS_DIM, EXPECTED_ACTION_DIM)
        goalnav_layout = (
            goalnav_tail is not None
            and (OBSERVATION_LAYOUT == "imu-gravity-v1"
                 or (OBSERVATION_LAYOUT == "auto" and EXPECTED_OBS_DIM == 42))
        )
        if goalnav_layout:
            if not _sensor_sample_fresh(odom):
                return None
            if self._goal[0] is None or self._goal[1] is None:
                return None

            def _odom_value(*keys):
                for key in keys:
                    value = _finite(odom, key)
                    if value is not None:
                        return value
                return None

            odom_x = _odom_value("positionX", "x")
            odom_y = _odom_value("positionY", "y")
            v_lag = _odom_value("linearX", "v")
            w_lag = _odom_value("angularZ", "w")
            if any(value is None for value in (odom_x, odom_y, v_lag, w_lag)):
                return None
            # Chassis-frame goal delta needs a heading: a dedicated odom yaw
            # field when present, else the IMU quaternion — the same heading
            # source the 8D native path uses for its sin/cos slots.
            yaw_value = _finite(odom, "yaw")
            if yaw_value is None:
                quat_yaw = [_finite(q, key) for key in ("x", "y", "z", "w")]
                if any(value is None for value in quat_yaw):
                    return None
                rqx, rqy, rqz, rqw = quat_yaw
                quat_norm = math.sqrt(rqx * rqx + rqy * rqy + rqz * rqz + rqw * rqw)
                if quat_norm < 1e-6:
                    return None
                rqx, rqy, rqz, rqw = (value / quat_norm for value in (rqx, rqy, rqz, rqw))
                yaw_value = math.atan2(2 * (rqw * rqz + rqx * rqy), 1 - 2 * (rqy * rqy + rqz * rqz))
            world_dx = self._goal[0] - odom_x
            world_dy = self._goal[1] - odom_y
            cos_yaw = math.cos(yaw_value)
            sin_yaw = math.sin(yaw_value)
            body_dx = cos_yaw * world_dx + sin_yaw * world_dy
            body_dy = -sin_yaw * world_dx + cos_yaw * world_dy
            # last_action: the previous published command, in the trainer's
            # normalized units (physical command / adapter safety limit).
            norm_linear = (self._last_cmd[0] / MAX_LINEAR) if MAX_LINEAR else 0.0
            norm_angular = (self._last_cmd[1] / MAX_ANGULAR) if MAX_ANGULAR else 0.0
            tail = [norm_linear, norm_angular, body_dx, body_dy, v_lag, w_lag]
            with self._lock:
                self._obs_segments = [
                    ("gyro", 3, "real"),
                    ("projected_gravity", 3, "real"),
                    ("last_action", 2, "adapter"),
                    ("goal_delta", 2, "real (/odom + goal)"),
                    ("twist", 2, "real (/odom)"),
                    ("zeros", EXPECTED_OBS_DIM - 12, "adapter"),
                ]
            return [gx, gy, gz, pg_x, pg_y, pg_z] + tail + [0.0] * (EXPECTED_OBS_DIM - 12)

        segments = wheeled_observation_layout(EXPECTED_OBS_DIM, EXPECTED_ACTION_DIM)
        action_width = segments[2][1]
        head = [gx, gy, gz, pg_x, pg_y, pg_z]
        # Exactly the declared width: a recorded action of a different length
        # (a contract change mid-session) must not shift the command slot.
        last = (self._last_action or [])[:action_width]
        last = last + [0.0] * (action_width - len(last))
        tail = [round(v, 4) for v in last]
        if segments[3][1]:
            tail = tail + [self._command_dir]
        assembled = head + tail
        if len(assembled) > EXPECTED_OBS_DIM:
            # Unreachable by construction (`wheeled_observation_layout` caps
            # itself), kept as an assertion rather than a silent truncation: an
            # overflow here would mean the layout arithmetic and this assembly
            # disagree, which must surface as a fault, never as a policy quietly
            # reading shifted slots.
            raise ValueError(
                "observation assembly produced %d values for a %dD contract"
                % (len(assembled), EXPECTED_OBS_DIM)
            )
        # A shortfall is the documented partial-adapter behaviour: the slots this
        # board cannot source are zero-filled so the vector matches the contract.
        obs = assembled + [0.0] * (EXPECTED_OBS_DIM - len(assembled))
        with self._lock:
            # Recorded so the slot report describes what was actually written
            # rather than a hand-written literal that could drift from the code.
            self._obs_segments = segments
        return obs

    def _build_observation_for_inference(self):
        """``(vector, image)`` for one inference step.

        The vector half is always ``_build_observation()`` — the same
        real-sensor head and the same fail-closed ``None`` — so a vision policy
        keeps exactly the vector semantics (and the staleness budget) of a
        vector-only one. ``image`` is ``None`` unless this runtime was started
        with an explicitly declared vision layout, and a missing or malformed
        frame yields ``None`` for the whole tuple so the caller takes the same
        bounded zero-output path it takes for stale telemetry. A policy must
        never act on a fabricated frame.
        """
        vector = self._build_observation()
        if vector is None:
            return None
        if not VISION_LAYOUT or VISUAL_IMAGE_SHAPE is None:
            return vector, None
        frame = _read_camera_frame()
        # A vision policy must never act on a fabricated or missing frame. Return
        # None for the WHOLE step (not an empty frame) so the caller takes the
        # same bounded zero-output path it takes for stale IMU/odom telemetry.
        # Returning a tuple here would push the failure into numpy.reshape inside
        # the control loop, and any raise in the loop stops motion.
        if frame is None:
            return None
        return vector, frame
    def _project_action(self, action):
        """Map policy output onto bounded (linear, angular) base motion.

        For a 14-D leg-style output, antagonistic-pair statistics carry a
        walking-intent signal: pair mean ~ forward drive, left/right asymmetry
        ~ yaw. For 2-D policies the declared action output mode determines
        whether values are physical or normalized. Both paths clamp to the
        canary limits.
        """
        if len(action) not in (2, EXPECTED_ACTION_DIM):
            raise ValueError(
                "policy output length %d does not match 2 or declared %d"
                % (len(action), EXPECTED_ACTION_DIM)
            )
        if not all(math.isfinite(float(value)) for value in action):
            raise ValueError("policy output contains non-finite value")
        # Identity means the policy head is already (v, w).  Silently taking
        # the first two values of a leg-style head would make a malformed
        # adapter drive a real chassis with unrelated joint outputs.
        if ACTION_PROJECTION == "identity" and len(action) != 2:
            raise ValueError("identity action projection requires exactly 2 outputs")
        if len(action) == 2:
            linear, angular = float(action[0]), float(action[1] if len(action) > 1 else 0.0)
            if ACTION_OUTPUT == "normalized-twist":
                linear *= MAX_LINEAR
                angular *= MAX_ANGULAR
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
                step = self._build_observation_for_inference()
                if step is None:
                    self._publish_zero("telemetry-stale")
                    stats_t = self._maybe_stats(stats_t, stale=True)
                    time.sleep(period)
                    continue
                obs, frame = step
                import numpy as np

                t_infer = time.time()
                if self._model_kind == "bpu":
                    result = self._model.forward(np.array(obs, dtype=np.float32).reshape(1, 8, 1, 1))[0].buffer.reshape(-1)
                elif self._image_input_name:
                    # Vision export: the frame goes in as NHWC so the board does
                    # no implicit layout guess. Both feeds were validated against
                    # the declared shape at load time.
                    channels, height, width = VISUAL_IMAGE_SHAPE
                    image = np.array(frame, dtype=np.float32).reshape(1, height, width, channels)
                    result = self._model.run(
                        None,
                        {
                            self._vector_input_name: np.array([obs], dtype=np.float32),
                            self._image_input_name: image,
                        },
                    )[0][0]
                else:
                    result = self._model.run(
                        None, {self._vector_input_name: np.array([obs], dtype=np.float32)}
                    )[0][0]
                infer_ms = (time.time() - t_infer) * 1000
                action = [float(v) for v in result]
                linear, angular = self._project_action(action)
                self._publish_cmd(linear, angular)
                self._append_telemetry(obs, action, (linear, angular), frame)
                with self._lock:
                    self._last_obs = obs
                    self._last_action = action[:EXPECTED_ACTION_DIM]
                    self._published += 1
                    self._inference_count += 1
                    self._last_inference_at = time.time()
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
            self._spin_ros_once()
            elapsed = time.time() - t0
            time.sleep(max(0.0, period - elapsed))
        self._publish_zero("stopped")
        self._write_state()

    def _spin_ros_once(self):
        """Pump the rclpy executor so DDS discovery and reliable writes drain.

        rclpy publish() only queues; without a periodic spin the writer
        endpoints never finish discovery and messages silently never reach the
        chassis. This is a bounded, non-blocking pump (subscribers would run
        here too if the runtime ever subscribes).
        """
        node = self._node
        if node is None:
            return
        try:
            import rclpy

            rclpy.spin_once(node, timeout_sec=0.0)
        except Exception:  # noqa: BLE001 - transport pump must never kill motion
            pass

    def _session_model_summary(self):
        # Bounded fingerprint of the artifact that is active for the session.
        # The full meta stays in the state snapshot; events carry only the
        # fields the platform needs to correlate a session with a run's
        # artifacts (sha256) and its inference provider.
        meta = self._model_meta or {}
        return {
            key: meta.get(key)
            for key in ("sha256", "provider", "inputDim", "outputDim", "bytes")
            if meta.get(key) is not None
        }

    def _session_stopped_event_locked(self):
        # Caller holds the lock. Returns the terminal event payload for the
        # current session, or None when no session ever started (e.g. a fault
        # during startup) or when a stop path already emitted this session's
        # event — a double stop (operator + sigterm) must not produce two
        # terminal records for one session.
        if not self._session_id or self._session_stopped_at is None:
            return None
        if self._session_stop_event_emitted:
            return None
        self._session_stop_event_emitted = True
        return {
            "kind": "session-stopped",
            "sessionId": self._session_id,
            "startedAt": _iso_timestamp(self._session_started_at),
            "stoppedAt": _iso_timestamp(self._session_stopped_at),
            "stopReason": self._session_stop_reason,
            "inferenceCount": self._inference_count,
            "lastInferenceAt": _iso_timestamp(self._last_inference_at),
            "durationSec": round(
                max(0.0, self._session_stopped_at - (self._session_started_at or self._session_stopped_at)),
                3,
            ),
            "inferMs": round(self._infer_ms_avg, 2),
            "published": self._published,
            "mock": False,
        }

    def _append_event_record(self, event):
        """Persist a session lifecycle event beside the sample spool.

        Events ride the same bounded, append-only spool so the uploader
        carries them with identical retry/idempotency semantics. The platform
        keeps them out of replay statistics and aggregates them into board
        sessions; like samples, event loss never blocks motion.
        """
        if not TELEMETRY_RUN_ID:
            return
        try:
            ensure_private_parent(TELEMETRY_SPOOL_FILE, create=True)
            if secure_size(TELEMETRY_SPOOL_FILE) >= TELEMETRY_MAX_BYTES:
                self._telemetry_dropped += 1
                return
            record = {
                "source": "board-agent",
                "t": max(0.0, time.time() - (self._started_at or time.time())),
                "event": event,
            }
            secure_append_text(
                TELEMETRY_SPOOL_FILE,
                json.dumps(record, separators=(",", ":")) + "\n",
            )
        except OSError:
            # Identical stance to sample telemetry: motion must continue under
            # the watchdog; spool loss is surfaced by health checks instead.
            return

    def _append_telemetry(self, observation, action, cmd_vel=None, camera_frame=None):
        """Persist the exact observation/action pair used for inference.

        The spool is append-only and bounded. A separate uploader can retry
        chunks after reconnecting; inference never performs network I/O.
        """
        if not TELEMETRY_RUN_ID:
            return
        try:
            ensure_private_parent(TELEMETRY_SPOOL_FILE, create=True)
            if secure_size(TELEMETRY_SPOOL_FILE) >= TELEMETRY_MAX_BYTES:
                self._telemetry_dropped += 1
                return
            self._spool_sample_index += 1
            record = {
                "source": "board-agent",
                "t": max(0.0, time.time() - (self._started_at or time.time())),
                "observation": [float(v) for v in observation],
                "action": [float(v) for v in action],
                # ``action`` is the model head output (often normalized),
                # while calibration and replay analysis need the bounded
                # physical command that was actually published to ROS.
                "cmd_vel": {
                    "linear": float(cmd_vel[0]),
                    "angular": float(cmd_vel[1]),
                } if cmd_vel is not None else None,
                "controlPeriodSeconds": float(1.0 / DECISION_HZ),
                "controlHz": int(DECISION_HZ),
                "actionOutput": ACTION_OUTPUT,
                "actionScale": {
                    "linear": float(MAX_LINEAR),
                    "angular": float(MAX_ANGULAR),
                    "units": "m/s,rad/s",
                },
            }
            # Sparse aligned camera frame for the evaluation page. The vector
            # observation stays a flat float list - calibration and replay
            # analysis read it as one - so the frame rides in its own field.
            #
            # Emitted once every TELEMETRY_FRAME_STRIDE samples rather than every
            # step: a frame per control step would multiply the spool by orders
            # of magnitude (a 3x64x64 frame is 12288 bytes against ~300 bytes of
            # vector data), and the spool is bounded at TELEMETRY_MAX_BYTES with
            # no eviction. Striding keeps frames spread across the whole timeline
            # for scrubbing while holding the cost to roughly one frame per
            # second at the default decision rate.
            if (
                camera_frame is not None
                and TELEMETRY_FRAME_STRIDE > 0
                and VISUAL_IMAGE_SHAPE is not None
                and self._spool_sample_index % TELEMETRY_FRAME_STRIDE == 0
            ):
                channels, _height, _width = VISUAL_IMAGE_SHAPE
                record["cameraFrame"] = {
                    "encoding": "rgb8" if channels == 3 else "mono8",
                    "width": int(_width),
                    "height": int(_height),
                    "channels": int(channels),
                    "data": base64.b64encode(
                        bytes(
                            max(0, min(255, int(round(float(value)))))
                            for value in camera_frame
                        )
                    ).decode("ascii"),
                }
            # Preserve the measured base state needed for calibration and
            # replay.  For the native 8D contract the heading is already
            # encoded as sin/cos in the exact observation supplied to the
            # model, so deriving yaw here avoids copying an untrusted global
            # pose or introducing a second sensor timestamp.
            native_layout = (
                OBSERVATION_LAYOUT == "originbot-imu-odom-v1"
                or (
                    OBSERVATION_LAYOUT == "auto"
                    and EXPECTED_OBS_DIM == 8
                    and EXPECTED_ACTION_DIM == 2
                )
            )
            if len(observation) >= 8 and native_layout:
                record["telemetry"] = {
                    "odom": {
                        "x": float(observation[0]),
                        "y": float(observation[1]),
                        "yaw": float(math.atan2(observation[2], observation[3])),
                        "linearX": float(observation[6]),
                        "angularZ": float(observation[7]),
                    }
                }
            secure_append_text(
                TELEMETRY_SPOOL_FILE,
                json.dumps(record, separators=(",", ":")) + "\n",
            )
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
CMD_FILE = ipc_path("RDK_BOARD_POLICY_CMD", "policy-runtime-cmd.json")
READY_FILE = ipc_path("RDK_BOARD_POLICY_READY", "policy-runtime.ready")


def _serve_file_protocol(runtime):
    """Agent-facing control loop: watch the command file, apply requests."""
    last_seen = ""
    while True:
        time.sleep(0.05)
        try:
            raw = secure_read_text(CMD_FILE)
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
            res = runtime.start(float(req.get("direction", 0.0)), req.get("goalX"), req.get("goalY"))
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
    _atomic_write_json(READY_FILE, {"pid": os.getpid()})
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
