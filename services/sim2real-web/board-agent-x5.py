#!/usr/bin/env python3

"""Real-data BoardAgent for the RDK X5 board (上位机 + 只读预检).

Wire contract (identical to services/sim2real-web/local-board-agent.mjs):

  GET  /healthz                          capability + mock/readonly flags
  GET  /v1/station/status                real /proc-based snapshot
  GET  /v1/station/status/stream         NDJSON heartbeat (1 Hz)
  GET  /v1/station/camera.mjpeg          real camera MJPEG (or 503 if absent)
  GET  /v1/station/camera.snapshot       one real JPEG frame for bridge transports
  POST /v1/station/commands              allowlisted read-only commands
  POST /v1/devices/:id/commands          the fixed preflight probe only
  GET  /v1/station/drive                 constrained-drive state (canary)
  POST /v1/station/drive                 clamped, time-boxed cmd_vel (opt-in)
  POST /v1/station/drive/stop            zero-speed emergency stop (always on)
  GET  /v1/station/policy                policy-runtime state (honest, always)
  GET  /v1/station/policy/files          list staged policies (name/size)
  POST /v1/station/policy/upload         stage one SHA-256-verified ONNX (gated)
  POST /v1/station/policy/load           load a policies/ ONNX (gated)
  POST /v1/station/policy/start          begin policy-driven motion (gated)
  POST /v1/station/policy/reset          clear a sticky fault (gated)
  POST /v1/station/policy/stop           zero output + halt (always on)
  POST /v1/station/policy-infer          batch inference [N,obs]->[N,act] (pure compute, ungated)
  GET  /v1/config                        switch states + env file path (read-only)
  POST /v1/config                        toggle drive/policy switches + restart

Safety invariants (same as the reference agent):
- token auth via RDK_SIM2REAL_BOARD_AGENT_TOKEN
- strictly allowlisted commands; no shell, no actuator path
- constrained drive is DISABLED unless RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1;
  when enabled every command is speed-clamped (<=0.3 m/s, <=1 rad/s) and
  time-boxed (<=2 s), and the chassis firmware watchdog (500 ms cmd_vel
  silence -> zero speed) is the final safety floor. `drive/stop` is always
  accepted regardless of the switch.
- policy-driven motion needs a THIRD gate (RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY=1)
  on top of the drive switch; its output shares the same clamps, the same
  watchdog floor, and the same always-accepted stop. load() is restricted to
  files under /root/rdk-board-agent/policies (<=50 MB).
- `actuatorControl` mirrors the drive switch; `mock: false` reported honestly
- camera stream reports 503 CAMERA_UNAVAILABLE when no device is connected;
  it never substitutes synthetic frames.
- the web-managed switch surface (`/v1/config`) can only flip the two
  opt-in switches (RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE / _ENABLE_POLICY),
  never the token, ports or any other env. Applying a change writes the
  env file and restarts this systemd unit; the agent then cold-starts with
  the usual publisher handshake and watchdog. The restart is refused (and
  the env untouched) while a motion window is active; stop endpoints stay
  reachable during the whole exchange.

Data sources: /proc/stat, /proc/meminfo, /proc/net/dev, thermal zones,
statvfs, `ros2 topic list` (bounded), hobot_usb_cam device probe.
"""

import base64
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The board bundle is deployed as a flat directory (the filename contains a
# hyphen, so it is not a Python package).  Keep the shared IPC helper beside
# the scripts and make spec-loaded development tests resolve it identically.
_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)
from board_ipc import (
    atomic_write_bytes,
    atomic_write_text,
    ensure_private_parent,
    ipc_path,
    secure_exists,
    secure_open_read,
    secure_open_append,
    secure_read_json,
    secure_size,
    secure_unlink,
)

TOKEN = os.environ.get("RDK_SIM2REAL_BOARD_AGENT_TOKEN", "").strip()
HOST = (os.environ.get("RDK_SIM2REAL_BOARD_AGENT_BIND_HOST", "127.0.0.1") or "127.0.0.1").strip()


def _loopback_bind_host(value):
    """Return whether a bind value is unambiguously loopback-only.

    An empty token is a supported development convenience only when the
    socket cannot accept traffic from another host.  Reject hostnames other
    than ``localhost`` here instead of resolving them at import time: DNS can
    change after startup and turn an apparently safe configuration into a
    network-facing one.
    """
    normalized = str(value or "").strip().lower().strip("[]")
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


if not TOKEN and not _loopback_bind_host(HOST):
    raise RuntimeError(
        "RDK_SIM2REAL_BOARD_AGENT_TOKEN is required when "
        "RDK_SIM2REAL_BOARD_AGENT_BIND_HOST is not loopback"
    )


try:
    PORT = int(os.environ.get("RDK_SIM2REAL_BOARD_AGENT_PORT", "19100"))
except ValueError:
    PORT = 19100
if not (1024 <= PORT <= 65535):
    PORT = 19100

MAX_BODY_BYTES = 64 * 1024
# Bodyless control routes accept the platform's historical ``{}`` JSON body
# for compatibility, but never read an unbounded payload just to decide that
# it is empty.
MAX_EMPTY_BODY_BYTES = 4 * 1024
# Policy upload ceiling: one bounded ONNX at a time, base64-inflated. Matches
# the runtime's 50 MB model limit with headroom for JSON encoding.
MAX_POLICY_BODY_BYTES = 68 * 1024 * 1024
STATUS_INTERVAL_MS = 1000
CAMERA_INTERVAL_MS = 200
MAX_STREAM_CLIENTS = 4
BOUNDARY = "rdk-board-station-frame"
STARTED_AT = time.time()

# ---- constrained drive (motion canary) ----------------------------------
# Drive is DISABLED unless the operator explicitly sets
# RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1 in the agent's environment file.
# Even when enabled, every command is clamped to tiny speeds and expires
# within a bounded window; the chassis firmware watchdog (auto_stop_on,
# 500 ms without cmd_vel -> zero-speed frame) is the final safety floor.
DRIVE_ENABLED = os.environ.get("RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE", "").strip() == "1"
DRIVE_MAX_LINEAR = 0.3      # m/s, hard clamp
DRIVE_MAX_ANGULAR = 1.0     # rad/s, hard clamp
DRIVE_MAX_WINDOW_SEC = 2.0  # one command may drive at most this long
DRIVE_PUBLISH_HZ = 10       # cmd_vel re-publish rate inside the window
DRIVE_MIN_INTERVAL_MS = 200  # rate limit between accepted drive commands

ORIGINBOT_WS_SETUP = "/userdata/dev_ws/install/setup.bash"

STATION_COMMANDS = [
    {"id": "list-tros-nodes", "label": "TROS 节点列表", "timeoutMs": 8000},
    {"id": "list-tros-topics", "label": "TROS 话题列表", "timeoutMs": 8000},
    {"id": "disk-usage", "label": "磁盘用量", "timeoutMs": 5000},
    {"id": "service-status", "label": "服务状态", "timeoutMs": 5000},
]
COMMAND_IDS = {item["id"] for item in STATION_COMMANDS}

PREFLIGHT_BEGIN = "__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__"
PREFLIGHT_END = "__STUDIO_SIM2REAL_PREFLIGHT_END__"

TROS_SETUP = "/opt/tros/humble/setup.bash"

# ---- read-only probes (no shell string ever reaches a board interface) ----


def read_file(path):
    try:
        with open(path, "r") as handle:
            return handle.read()
    except OSError:
        return ""


_prev_cpu = None


def cpu_percent():
    """CPU utilization from /proc/stat deltas (read-only)."""
    global _prev_cpu
    fields = read_file("/proc/stat").splitlines()
    total = 0.0
    idle = 0.0
    for line in fields:
        if line.startswith("cpu ") and len(line.split()) >= 5:
            parts = [float(value) for value in line.split()[1:]]
            idle = parts[3] + (parts[4] if len(parts) > 4 else 0.0)
            total = sum(parts)
            break
    if _prev_cpu is None or total <= _prev_cpu[0] or total - _prev_cpu[0] < 0.05:
        _prev_cpu = (total, idle)
        return None  # first sample or no measurable interval yet
    delta_total = total - _prev_cpu[0]
    delta_idle = idle - _prev_cpu[1]
    _prev_cpu = (total, idle)
    if delta_total <= 0:
        return None
    return round(max(0.0, min(100.0, (1.0 - delta_idle / delta_total) * 100.0)), 1)


def cpu_temperature():
    for zone in range(4):
        raw = read_file(f"/sys/class/thermal/thermal_zone{zone}/type")
        if "cpu" in raw.lower():
            temp = read_file(f"/sys/class/thermal/thermal_zone{zone}/temp")
            if temp.strip().isdigit():
                return round(int(temp.strip()) / 1000.0, 1)
    # fall back to the first zone with a plausible value
    for zone in range(4):
        temp = read_file(f"/sys/class/thermal/thermal_zone{zone}/temp")
        if temp.strip().isdigit() and 20 < int(temp.strip()) / 1000.0 < 120:
            return round(int(temp.strip()) / 1000.0, 1)
    return None


def memory_mb():
    info = {}
    for line in read_file("/proc/meminfo").splitlines():
        parts = line.split(":", 1)
        if len(parts) == 2:
            key = parts[0].strip()
            value = parts[1].strip().split()[0]
            if value.isdigit():
                info[key] = int(value) // 1024  # KiB -> MiB
    return info.get("MemTotal", 0), info.get("MemAvailable", 0)


_prev_net = None


def network_kb_per_sec():
    """RX/TX rate from /proc/net/dev deltas over the probe interval."""
    global _prev_net
    rx = tx = 0
    for line in read_file("/proc/net/dev").splitlines()[2:]:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        name = name.strip()
        if name == "lo":
            continue
        values = rest.split()
        if len(values) > 9:
            rx += int(values[0])
            tx += int(values[8])
    if _prev_net is None:
        _prev_net = (time.time(), rx, tx)
        return None, None
    now = time.time()
    elapsed = now - _prev_net[0]
    if elapsed < 0.05:
        return None, None
    rx_rate = max(0, (rx - _prev_net[1]) / elapsed / 1024.0)
    tx_rate = max(0, (tx - _prev_net[2]) / elapsed / 1024.0)
    _prev_net = (now, rx, tx)
    return round(rx_rate), round(tx_rate)


def disk_mb():
    try:
        st = os.statvfs("/")
        total = st.f_blocks * st.f_frsize // (1024 * 1024)
        free = st.f_bavail * st.f_frsize // (1024 * 1024)
        return total, total - free
    except OSError:
        return 0, 0


def configured_board_identity():
    """Read only the identity fields from the selected adapter profile.

    The X5 agent remains the reference implementation, but its identity must
    not lie when the same runtime is configured for another RDK family. A
    malformed profile is ignored and the conservative X5 defaults remain.
    """
    path = os.environ.get("RDK_SIM2REAL_ADAPTER_CONFIG", "").strip()
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        board = value.get("board") if isinstance(value, dict) else None
        return board if isinstance(board, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def board_identity():
    model = read_file("/proc/device-tree/model").replace("\x00", "").strip()
    os_release = {}
    for line in read_file("/etc/os-release").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            os_release[key.strip()] = value.strip().strip('"')
    configured = configured_board_identity()
    platform = str(os.environ.get("RDK_SIM2REAL_BOARD_PLATFORM") or configured.get("platform") or "rdk-x5").strip()[:80]
    configured_model = str(configured.get("model") or "").strip()
    return {
        "platform": platform,
        "family": str(configured.get("family") or "rdk-custom").strip()[:80],
        "model": model or configured_model or "D-Robotics RDK X5",
        "os": os_release.get("PRETTY_NAME", ""),
        "rdkVersion": read_file("/etc/version").strip(),
    }


_identity = board_identity()


ADAPTER_PROFILE_PATH = os.environ.get("RDK_SIM2REAL_ADAPTER_CONFIG", "").strip()


def load_adapter_profile():
    """Load a declarative hardware profile without allowing it to alter safety.

    The agent keeps its hard safety ceilings in code; the profile only supplies
    identity, capabilities and already-bounded wiring metadata for clients.
    """
    if not ADAPTER_PROFILE_PATH:
        return {}
    try:
        with open(ADAPTER_PROFILE_PATH, "r", encoding="utf-8") as handle:
            profile = json.load(handle)
        return profile if isinstance(profile, dict) else {}
    except (OSError, ValueError):
        return {}


_adapter_profile = load_adapter_profile()
_adapter_id = str(_adapter_profile.get("id") or "rdk-x5-reference")[:80]
_adapter_capabilities = [str(item)[:80] for item in (_adapter_profile.get("capabilities") or []) if isinstance(item, str)]


def _profile_number(section, key, default, lower, upper):
    value = (_adapter_profile.get(section) or {}).get(key)
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return max(lower, min(upper, parsed))


_profile_actuator = _adapter_profile.get("actuator") or {}
_profile_topics = ((_adapter_profile.get("ros") or {}).get("topics") or {})
PROFILE_ACTUATOR_KIND = str(_profile_actuator.get("kind") or "diff-drive").strip().lower()
JOINT_ACTUATOR = PROFILE_ACTUATOR_KIND == "joint"
# The existing environment switch is the operator's actuator authorization for
# both chassis and leg profiles. A joint profile must never start the Twist
# publisher, though, so keep a separate authorization bit and disable the
# drive-specific surface after profile selection.
MOTION_SWITCH_ENABLED = DRIVE_ENABLED
if JOINT_ACTUATOR:
    DRIVE_ENABLED = False
DRIVE_MAX_LINEAR = min(DRIVE_MAX_LINEAR, _profile_number("safety", "maxLinear", DRIVE_MAX_LINEAR, 0.01, 0.3))
DRIVE_MAX_ANGULAR = min(DRIVE_MAX_ANGULAR, _profile_number("safety", "maxAngular", DRIVE_MAX_ANGULAR, 0.05, 1.0))
DRIVE_PUBLISH_HZ = min(DRIVE_PUBLISH_HZ, _profile_number("runtime", "decisionHz", DRIVE_PUBLISH_HZ, 1, 50))
DRIVE_WATCHDOG_MS = int(_profile_number("actuator", "watchdogMs", 500, 500, 2000))
DRIVE_COMMAND_TOPIC = str(
    os.environ.get("RDK_BOARD_DRIVE_CMD_TOPIC")
    or _profile_actuator.get("commandTopic")
    or (_profile_topics.get("cmdVel") or {}).get("name")
    or "/cmd_vel"
).strip()
if not DRIVE_COMMAND_TOPIC.startswith("/"):
    DRIVE_COMMAND_TOPIC = "/cmd_vel"


def run_ros2_list(kind):
    """`ros2 node/topic list` through TROS, bounded to 8 s, read-only.

    `kind` is constrained by the caller to the literals 'node'/'topic'; the
    f-string interpolation therefore never carries request input.
    """
    if kind not in ("node", "topic"):
        return {"ok": False, "error": "invalid-kind"}
    if not os.path.exists(TROS_SETUP):
        return {"ok": False, "error": "tros-missing"}
    try:
        result = subprocess.run(
            [
                "bash",
                "-c",
                'source "$1" && timeout 6 ros2 "$2" list',
                "rdk-ros2-list",
                TROS_SETUP,
                kind,
            ],
            capture_output=True,
            text=True,
            timeout=8,
        )
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return {"ok": result.returncode == 0 or bool(lines), "lines": lines[:80]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout"}
    except OSError:
        return {"ok": False, "error": "unavailable"}


_ros_cache = {"topics": None, "ts": 0.0}
_ros_lock = threading.Lock()
_ros_thread = None

ROS_TOPICS_REFRESH_SEC = 10.0


def _ros_topics_sampler_loop():
    """Refresh `ros2 topic list` in a background thread. Sourcing the TROS
    environment costs ~2-4 s per call, so the status request path must only
    read the cache and never run the subprocess itself."""
    while True:
        result = run_ros2_list("topic")
        if result.get("ok"):
            with _ros_lock:
                _ros_cache["topics"] = result.get("lines", [])
                _ros_cache["ts"] = time.time()
        time.sleep(ROS_TOPICS_REFRESH_SEC)


def _start_ros_topics_sampler():
    global _ros_thread
    if _ros_thread is None:
        _ros_thread = threading.Thread(target=_ros_topics_sampler_loop, daemon=True)
        _ros_thread.start()


def ros_topics_cached():
    """Latest topic list snapshot; empty until the first background refresh
    completes, and stale (not blocked) while TROS is unavailable."""
    with _ros_lock:
        return _ros_cache["topics"]


# ---- constrained drive state machine (motion canary) --------------------
# One long-lived background publisher process owns /cmd_vel. The HTTP layer
# only mutates _drive_state; the publisher thread enforces the window and
# publishes zero speed when no active command exists. If the publisher dies
# for any reason, the chassis watchdog (500 ms without cmd_vel) stops the
# robot, so the failure mode of this whole layer is "robot stops".

_drive_state = {
    "linear": 0.0,
    "angular": 0.0,
    "until": 0.0,     # absolute deadline (time.time()); 0 = idle
    "lastCmdAt": 0.0,
    "active": False,
    "lastStopReason": "idle",
    "published": 0,
}
_drive_lock = threading.Lock()
_drive_proc = None  # subprocess running the persistent ros2 topic pub

# The command/handshake files live in a root-only runtime directory. Direct
# file overrides remain supported for field compatibility, but board_ipc
# validates them at every operation and rejects public or symlinked paths.
DRIVE_COMMAND_FILE = ipc_path(
    "RDK_BOARD_DRIVE_CMD_FILE", "drive-command.yaml"
)


def _drive_log(msg):
    print(f"[drive] {time.time():.3f} {msg}", flush=True)


def _actuator_policy():
    return {
        "enabled": DRIVE_ENABLED,
        "maxLinear": DRIVE_MAX_LINEAR,
        "maxAngular": DRIVE_MAX_ANGULAR,
        "maxWindowSec": DRIVE_MAX_WINDOW_SEC,
        "publishHz": DRIVE_PUBLISH_HZ,
        "chassisWatchdogMs": 500,
        "emergencyStop": "/v1/station/drive/stop (always available)",
    }


def _drive_feedback():
    """Return best-effort measured motion feedback for the drive surface.

    The command state is not proof that the chassis moved: a controller can
    be stopped, disconnected, or blocked while the command window is active.
    Keep the command state and measured odometry separate so callers can
    render that distinction without turning telemetry into a motion gate.
    """
    with _ob_lock:
        telemetry = _ob_state.get("data")
        sampled_at = float(_ob_state.get("ts") or 0.0)
    odom = telemetry.get("odom") if isinstance(telemetry, dict) else None
    if not isinstance(odom, dict):
        return {
            "available": False,
            "fresh": False,
            "linearX": None,
            "angularZ": None,
            "positionX": None,
            "positionY": None,
            "ageMs": None,
        }
    age_ms = max(0, int((time.time() - sampled_at) * 1000)) if sampled_at else None
    fresh = age_ms is not None and age_ms <= TELEMETRY_SNAPSHOT_STALE_SEC * 1000
    def number(name):
        value = odom.get(name)
        return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None
    return {
        "available": True,
        "fresh": fresh,
        "linearX": number("linearX"),
        "angularZ": number("angularZ"),
        "positionX": number("positionX"),
        "positionY": number("positionY"),
        "ageMs": age_ms,
    }


def drive_status():
    with _drive_lock:
        return {
            "enabled": DRIVE_ENABLED,
            "active": _drive_state["active"],
            "linear": _drive_state["linear"],
            "angular": _drive_state["angular"],
            "remainingMs": max(0, int((_drive_state["until"] - time.time()) * 1000))
            if _drive_state["active"] else 0,
            "lastStopReason": _drive_state["lastStopReason"],
            "published": _drive_state["published"],
            # Feedback is observational only; command acceptance remains
            # represented by active/lastStopReason above.
            "feedback": _drive_feedback(),
        }


def _write_drive_yaml(linear, angular):
    content = (
        "linear:\n"
        f"  x: {linear}\n"
        "  y: 0.0\n"
        "  z: 0.0\n"
        "angular:\n"
        "  x: 0.0\n"
        "  y: 0.0\n"
        f"  z: {angular}\n"
    )
    # board_ipc uses a random O_EXCL temp inode, validates the private parent
    # and target, fsyncs both file and directory, and rejects symlinks.
    atomic_write_text(DRIVE_COMMAND_FILE, content)


# The publisher is a small rclpy script deployed next to this agent. It
# re-reads the command YAML every cycle (so mid-window speed changes and
# emergency zero take effect within ~100 ms), and it self-terminates after 5 s
# of continuous zero speed so /cmd_vel goes silent and the chassis watchdog
# keeps the robot at rest even if this agent dies.
DRIVE_PUBLISHER_SCRIPT = os.environ.get(
    "RDK_BOARD_DRIVE_PUBLISHER",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "board-drive-publisher.py"),
)


DRIVE_PUBLISHER_READY = ipc_path(
    "RDK_BOARD_DRIVE_READY", "drive-publisher.ready"
)
DRIVE_PUBLISHER_LOG = ipc_path(
    "RDK_BOARD_DRIVE_LOG", "drive-publisher.log"
)
DRIVE_PUBLISHER_READY_TIMEOUT = 8.0  # spawn + rclpy import + DDS discovery


def _start_drive_publisher():
    """Launch the persistent rclpy drive-publisher script if it is not alive.

    Blocks until the publisher signals ready (live DDS publisher + chassis
    subscription discovered) or the timeout expires. On timeout the process
    is killed and we return False, so drive_command refuses with
    "publisher-unavailable" instead of opening a window that can never reach
    the wheels."""
    global _drive_proc
    if _drive_proc is not None and _drive_proc.poll() is None:
        return True
    # A stale ready marker from a SIGKILLed publisher would pass the wait
    # loop below instantly while the fresh process is still importing rclpy —
    # the exact silent-window-swallow failure this handshake exists to kill.
    # Unlink UNCONDITIONALLY (even when we bail out below), so a stale marker
    # can never outlive any launch attempt. The marker is only consumed by
    # this function's wait loop, so a live publisher losing it is harmless.
    try:
        secure_unlink(DRIVE_PUBLISHER_READY)
    except OSError:
        # A missing or unsafe marker must never make a launch look ready. The
        # subsequent secure_exists() checks keep the handshake fail-closed.
        pass
    if not os.path.exists(DRIVE_PUBLISHER_SCRIPT):
        return False
    # The command file must exist BEFORE the publisher starts, otherwise its
    # first cycles publish nothing and motion starts late.
    try:
        command_exists = secure_exists(DRIVE_COMMAND_FILE)
    except OSError:
        command_exists = False
    if not command_exists:
        try:
            _write_drive_yaml(0.0, 0.0)
        except OSError:
            return False
    try:
        _drive_proc = subprocess.Popen(
            [
                "bash",
                "-c",
                'set -e; source "$1" 2>/dev/null && exec python3 "$2"',
                "rdk-drive-publisher",
                TROS_SETUP,
                DRIVE_PUBLISHER_SCRIPT,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "HOME": "/root", "TERM": "dumb",
                 "RDK_BOARD_DRIVE_PERSIST": "1",
                 "RDK_BOARD_DRIVE_CMD_TOPIC": DRIVE_COMMAND_TOPIC,
                 "RDK_BOARD_RUNTIME_DIR": os.path.dirname(DRIVE_COMMAND_FILE),
                 "RDK_BOARD_DRIVE_CMD_FILE": DRIVE_COMMAND_FILE,
                 "RDK_BOARD_DRIVE_READY": DRIVE_PUBLISHER_READY,
                 "RDK_BOARD_DRIVE_LOG": DRIVE_PUBLISHER_LOG,
                 "RDK_BOARD_DRIVE_RATE_HZ": str(DRIVE_PUBLISH_HZ),
                 "ROS_LOG_DIR": "/var/lib/rdk-board-agent/roslogs",
                 "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
    except OSError:
        _drive_proc = None
        return False
    deadline = time.time() + DRIVE_PUBLISHER_READY_TIMEOUT
    while time.time() < deadline:
        if _drive_proc.poll() is not None:
            _drive_proc = None
            return False
        try:
            if secure_exists(DRIVE_PUBLISHER_READY):
                return True
        except OSError:
            # Unsafe marker paths are treated exactly like a missing marker.
            pass
        time.sleep(0.1)
    _drive_log("publisher failed to signal ready; killing")
    try:
        _drive_proc.kill()
        _drive_proc.wait(timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        pass
    _drive_proc = None
    return False


def _stop_drive_publisher():
    global _drive_proc
    if _drive_proc is not None:
        try:
            _drive_proc.terminate()
            _drive_proc.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            try:
                _drive_proc.kill()
            except OSError:
                pass
        _drive_proc = None
    for path in (DRIVE_COMMAND_FILE, DRIVE_PUBLISHER_READY):
        try:
            secure_unlink(path)
        except OSError:
            pass


def _finite_number(value):
    """Return true for JSON numeric scalars that are safe to actuate."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


# ---- constrained arm (D6A, arm_sdk) ---------------------------------------
# Arm motion is DISABLED unless the operator explicitly sets
# RDK_SIM2REAL_BOARD_AGENT_ENABLE_ARM=1. Read-only arm preflight (pose probe)
# is separately gated by RDK_SIM2REAL_BOARD_AGENT_ENABLE_ARM_PREFLIGHT
# (default on: it never actuates). Every move is clamped to the workspace box
# and speed cap; arm_sdk move_to is BLOCKING, so moves run on a worker thread
# and an in-flight move cannot be interrupted — `arm/stop` refuses NEW
# commands and best-effort returns home. The arm's own physical e-stop stays
# the final safety floor.
ARM_ENABLED = os.environ.get("RDK_SIM2REAL_BOARD_AGENT_ENABLE_ARM", "").strip() == "1"
ARM_PREFLIGHT_ENABLED = (
    os.environ.get("RDK_SIM2REAL_BOARD_AGENT_ENABLE_ARM_PREFLIGHT", "1").strip() != "0"
)
ARM_SDK_HOST = "127.0.0.1"
ARM_SDK_PORT = 9339
# Hard clamps, mirroring profiles/rdk-x5-d6a-arm.json (the profile declares;
# these enforce — both must agree).
ARM_WORKSPACE_MM = {"x": (120.0, 450.0), "y": (-250.0, 250.0), "z": (20.0, 320.0)}
ARM_MAX_SPEED_MM_PER_S = 120.0
ARM_MAX_GRIPPER_WIDTH_MM = 65.0
ARM_MAX_CLOSE_FORCE = 20.0
ARM_MIN_INTERVAL_MS = 400

_arm_lock = threading.Lock()
_arm_state = {
    "lastCmdAt": 0.0,
    "moving": False,
    "lastPose": None,
    "lastError": None,
}
_arm_sdk_module = None
_arm_sdk_probed = False


def _arm_log(msg):
    print(f"[arm] {time.time():.3f} {msg}", flush=True)


def _arm_module():
    """Import arm_sdk once; cache the probe. Absent SDK -> arm capability is
    simply not advertised (never simulated)."""
    global _arm_sdk_module, _arm_sdk_probed
    if not _arm_sdk_probed:
        try:
            import arm_sdk as module

            _arm_sdk_module = module
        except ImportError:
            _arm_sdk_module = None
        _arm_sdk_probed = True
    return _arm_sdk_module


def arm_capability():
    """What THIS board can honestly advertise right now."""
    capabilities = []
    if ARM_PREFLIGHT_ENABLED and _arm_module() is not None:
        capabilities.append("arm-preflight")
        if ARM_ENABLED:
            capabilities.append("constrained-arm-drive")
    return capabilities


def arm_status():
    """Read-only pose snapshot. Never actuates."""
    module = _arm_module()
    if module is None or not ARM_PREFLIGHT_ENABLED:
        return {"available": False, "reason": "arm-sdk-unavailable"}
    try:
        arm = module.connect(host=ARM_SDK_HOST, port=ARM_SDK_PORT)
        pose = arm.get_pose()
        status = {
            "available": True,
            "mock": False,
            "enabled": ARM_ENABLED,
            "moving": _arm_state["moving"],
            "lastPose": _arm_state["lastPose"],
            "lastError": _arm_state["lastError"],
        }
        if isinstance(pose, dict):
            status["pose"] = pose
        return status
    except (OSError, RuntimeError) as error:
        return {"available": False, "reason": f"arm-sdk-error: {error}"}


def _clamp_arm_target(x, y, z, speed):
    """Clamp to the workspace box / speed cap. Returns (values, reason)."""
    clamped = {}
    for axis, value in (("x", x), ("y", y), ("z", z)):
        low, high = ARM_WORKSPACE_MM[axis]
        if not _finite_number(value):
            return None, f"{axis}-invalid"
        clamped[axis] = min(high, max(low, float(value)))
    if not _finite_number(speed) or speed <= 0:
        return None, "speed-invalid"
    clamped["speed"] = min(ARM_MAX_SPEED_MM_PER_S, float(speed))
    return clamped, None


def arm_move(x, y, z, speed):
    """One clamped Cartesian move on a worker thread. Returns (ok, reason) —
    acceptance, NOT completion; completion lands in arm_status()."""
    module = _arm_module()
    if module is None:
        return False, "arm-sdk-unavailable"
    if not ARM_ENABLED:
        return False, "arm-disabled"
    with _arm_lock:
        if _arm_state["moving"]:
            return False, "move-in-progress"
        if time.time() - _arm_state["lastCmdAt"] < ARM_MIN_INTERVAL_MS / 1000.0:
            return False, "rate-limited"
        clamped, reason = _clamp_arm_target(x, y, z, speed)
        if clamped is None:
            return False, reason
        _arm_state["lastCmdAt"] = time.time()
        _arm_state["moving"] = True
        _arm_state["lastError"] = None

    def _run():
        try:
            arm = module.connect(host=ARM_SDK_HOST, port=ARM_SDK_PORT)
            arm.move_to(
                clamped["x"], clamped["y"], clamped["z"], speed=clamped["speed"]
            )
            pose = arm.get_pose()
            with _arm_lock:
                _arm_state["moving"] = False
                _arm_state["lastPose"] = pose if isinstance(pose, dict) else None
        except (OSError, RuntimeError) as error:
            with _arm_lock:
                _arm_state["moving"] = False
                _arm_state["lastError"] = str(error)
            _arm_log(f"move failed: {error}")

    threading.Thread(target=_run, daemon=True, name="arm-move").start()
    _arm_log(
        f"move x={clamped['x']} y={clamped['y']} z={clamped['z']} speed={clamped['speed']}"
    )
    return True, None


def arm_gripper(action, value):
    """Clamped gripper close(force)/open(width). Short and blocking — runs
    inline like the tiny station commands."""
    module = _arm_module()
    if module is None:
        return False, "arm-sdk-unavailable", None
    if not ARM_ENABLED:
        return False, "arm-disabled", None
    if action not in ("close", "open"):
        return False, "action-invalid", None
    if not _finite_number(value) or value <= 0:
        return False, "value-invalid", None
    with _arm_lock:
        if _arm_state["moving"]:
            return False, "move-in-progress", None
    try:
        arm = module.connect(host=ARM_SDK_HOST, port=ARM_SDK_PORT)
        if action == "close":
            force = min(ARM_MAX_CLOSE_FORCE, float(value))
            grasped = bool(arm.gripper.close(force=force))
            _arm_log(f"gripper close force={force} grasped={grasped}")
            return True, None, {"grasped": grasped}
        width = min(ARM_MAX_GRIPPER_WIDTH_MM, float(value))
        arm.gripper.open(width=width)
        _arm_log(f"gripper open width={width}")
        return True, None, {"width": width}
    except (OSError, RuntimeError) as error:
        _arm_log(f"gripper failed: {error}")
        with _arm_lock:
            _arm_state["lastError"] = str(error)
        return False, "gripper-failed", None


def arm_stop():
    """Refuse new commands and best-effort return home. Mid-move interrupts
    are NOT possible with a blocking arm_sdk — stated, not hidden."""
    with _arm_lock:
        was_moving = _arm_state["moving"]
        _arm_state["moving"] = False
    module = _arm_module()
    homed = False
    if module is not None and not was_moving:
        try:
            module.connect(host=ARM_SDK_HOST, port=ARM_SDK_PORT).home()
            homed = True
        except (OSError, RuntimeError) as error:
            _arm_log(f"home failed: {error}")
    _arm_log(f"stop (wasMoving={was_moving} homed={homed})")
    return {"ok": True, "wasMoving": was_moving, "homed": homed}


def drive_command(linear, angular, duration_sec):
    """Accept (or refuse) one clamped drive command. Returns (ok, reason).
    The active window is always capped at DRIVE_MAX_WINDOW_SEC from NOW,
    so an explicit command can never extend motion by more than that."""
    if not DRIVE_ENABLED:
        return False, "drive-disabled"
    if not _finite_number(linear) or not _finite_number(angular):
        return False, "invalid-type"
    linear = float(linear)
    angular = float(angular)
    if not (DRIVE_MAX_LINEAR >= linear >= -DRIVE_MAX_LINEAR):
        return False, "linear-out-of-range"
    if not (DRIVE_MAX_ANGULAR >= angular >= -DRIVE_MAX_ANGULAR):
        return False, "angular-out-of-range"
    if not _finite_number(duration_sec):
        return False, "invalid-type"
    duration_sec = float(duration_sec)
    if not (0 < duration_sec <= DRIVE_MAX_WINDOW_SEC):
        return False, "duration-out-of-range"
    _drive_log(f"cmd lin={linear} ang={angular} dur={duration_sec}")
    with _drive_lock:
        if not _start_drive_publisher():
            return False, "publisher-unavailable"
        # Re-capture now AFTER the (possibly multi-second) readiness
        # handshake: the motion window must start when the wheels can
        # actually receive it, not when the API call arrived.
        now = time.time()
        if now - _drive_state["lastCmdAt"] < DRIVE_MIN_INTERVAL_MS / 1000.0:
            return False, "rate-limited"
        _write_drive_yaml(round(linear, 3), round(angular, 3))
        _drive_log(f"yaml written, window until {now + duration_sec:.3f}")
        _drive_state.update({
            "linear": linear,
            "angular": angular,
            "until": now + duration_sec,
            "lastCmdAt": now,
            "active": True,
            "lastStopReason": "driving",
            "published": _drive_state["published"] + 1,
        })
        return True, "accepted"


def drive_stop(reason="operator-stop"):
    """Immediately zero the command file and mark idle. The publisher keeps
    re-publishing zero speed (harmless) until the watchdog sweeper kills it."""
    _drive_log(f"STOP reason={reason} active={_drive_state.get('active')}")
    with _drive_lock:
        try:
            _write_drive_yaml(0.0, 0.0)
        except OSError:
            pass
        _drive_state.update({
            "linear": 0.0,
            "angular": 0.0,
            "active": False,
            "until": 0.0,
            "lastStopReason": reason,
        })
        return True


def _drive_watchdog_loop():
    """Kill the motion window after its deadline. Runs as a daemon thread.
    While the drive switch is on the publisher stays resident (warm) and
    keeps publishing zero speed between windows — zero speed IS rest, and
    the chassis watchdog (500 ms silence -> stop) still floors everything
    if this publisher or the agent dies."""
    while True:
        time.sleep(0.2)
        with _drive_lock:
            active = _drive_state["active"]
            deadline = _drive_state["until"]
            expired = active and time.time() > deadline
        if expired:
            _drive_log(f"watchdog expired at {time.time():.3f} deadline {deadline:.3f}")
            drive_stop("window-expired")


def _start_drive_watchdog():
    thread = threading.Thread(target=_drive_watchdog_loop, daemon=True)
    thread.start()


    """Latest topic list snapshot; empty until the first background refresh
    completes, and stale (not blocked) while TROS is unavailable."""
    with _ros_lock:
        return _ros_cache["topics"]


_ob_cache = {"ts": 0.0, "data": None}
_ob_lock = threading.Lock()


_ob_state = {"data": None, "ts": 0.0}
_ob_lock = threading.Lock()
_ob_thread = None





TELEMETRY_NODE_SCRIPT = os.environ.get(
    "RDK_BOARD_TELEMETRY_NODE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "board-telemetry-node.py"),
)
TELEMETRY_SNAPSHOT_FILE = ipc_path(
    "RDK_BOARD_TELEMETRY_SNAPSHOT", "telemetry-snapshot.json"
)
TELEMETRY_SNAPSHOT_STALE_SEC = 5.0
_telemetry_proc = None


def _start_telemetry_node():
    """Run the persistent read-only rclpy sampler next to this agent.

    One resident subscription node replaces three `ros2 topic echo --once`
    subprocesses per sample cycle (three Python interpreters + DDS discovery
    every 2 s, ~80% of a core). Strictly read-only: it subscribes, never
    publishes. When the bringup stack is absent the snapshot goes stale and
    the sampler loop below reports an honest None."""
    global _telemetry_proc
    if not os.path.exists(TELEMETRY_NODE_SCRIPT) or not os.path.exists(TROS_SETUP):
        return False
    telemetry_log = None
    try:
        # Keep diagnostics inside the service's declared writable state
        # directory; open it through the same no-symlink helper as IPC files.
        telemetry_log_fd = secure_open_append(
            "/var/lib/rdk-board-agent/telemetry/sampler.log"
        )
        telemetry_log = os.fdopen(telemetry_log_fd, "a", encoding="utf-8")
        _telemetry_proc = subprocess.Popen(
            [
                "bash",
                "-c",
                'set -e; source "$1" 2>/dev/null && source "$2" 2>/dev/null && exec python3 "$3"',
                "rdk-telemetry-node",
                TROS_SETUP,
                ORIGINBOT_WS_SETUP,
                TELEMETRY_NODE_SCRIPT,
            ],
            stdout=telemetry_log,
            stderr=telemetry_log,
            env={**os.environ, "HOME": "/root", "TERM": "dumb",
                 "RDK_BOARD_RUNTIME_DIR": os.path.dirname(TELEMETRY_SNAPSHOT_FILE),
                 "RDK_BOARD_TELEMETRY_SNAPSHOT": TELEMETRY_SNAPSHOT_FILE,
                 "ROS_LOG_DIR": "/var/lib/rdk-board-agent/roslogs",
                 "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
        telemetry_log.close()
        telemetry_log = None
        return True
    except OSError:
        if telemetry_log is not None:
            try:
                telemetry_log.close()
            except OSError:
                pass
        _telemetry_proc = None
        return False


def _read_telemetry_snapshot():
    """Read the sampler node's snapshot; None when absent or stale."""
    try:
        payload = secure_read_json(TELEMETRY_SNAPSHOT_FILE)
    except (OSError, ValueError, TypeError):
        return None
    ts = payload.get("ts")
    if not isinstance(ts, (int, float)) or time.time() - ts > TELEMETRY_SNAPSHOT_STALE_SEC:
        return None
    data = payload.get("data")
    return data if isinstance(data, dict) and data else None


def _ob_sampler_loop():
    """Background read-only sampler. Absence of the bringup stack is an
    honest None; the loop keeps trying so telemetry appears when bringup
    starts and disappears (as None) when it stops. Restarts the sampler
    node if it died (e.g. TROS was sourced after the agent started).
    """
    try:
        _start_telemetry_node()
    except Exception as exc:
        print(f"[board-agent] telemetry sampler start failed: {exc!r}", flush=True)
    while True:
        try:
            data = _read_telemetry_snapshot()
            with _ob_lock:
                _ob_state["data"] = data
                _ob_state["ts"] = time.time()
            if data is None and (
                _telemetry_proc is None or _telemetry_proc.poll() is not None
            ):
                try:
                    _start_telemetry_node()
                except Exception as exc:
                    print(f"[board-agent] telemetry sampler restart failed: {exc!r}", flush=True)
        except Exception:
            with _ob_lock:
                _ob_state["data"] = None
        time.sleep(1)


def originbot_telemetry_cached():
    """Latest read-only OriginBot telemetry snapshot (None when absent)."""
    with _ob_lock:
        return _ob_state["data"]


# ---- policy runtime (trained ONNX → bounded adapter command) ----------------
# A SECOND gate on top of the drive switch: even with the platform's
# RDK_SIM2REAL_STATION_DRIVE_ENABLED=1 and the agent's
# RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1, policy-driven motion only runs when
# this third switch is set. `stop` is always honored regardless (it only ever
# zeroes output — the same fail-closed stance as drive/stop).
POLICY_ENABLED = os.environ.get("RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY", "").strip() == "1"
POLICY_RUNTIME_SCRIPT = os.environ.get(
    "RDK_BOARD_POLICY_RUNTIME",
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "board-joint-policy-runtime.py" if JOINT_ACTUATOR else "board-policy-runtime.py",
    ),
)
POLICY_CMD_FILE = ipc_path("RDK_BOARD_POLICY_CMD", "policy-runtime-cmd.json")
POLICY_STATE_FILE = ipc_path("RDK_BOARD_POLICY_STATE", "policy-runtime-state.json")
POLICY_RUNTIME_READY = ipc_path(
    "RDK_BOARD_POLICY_READY", "policy-runtime.ready"
)
POLICY_READY_TIMEOUT = 20.0  # rclpy init + onnxruntime import on the board
POLICY_APPLY_TIMEOUT = 10.0  # file-protocol round trip for load/start
POLICY_ALLOWED_MODEL_DIR = "/root/rdk-board-agent/policies"

_policy_lock = threading.Lock()
_policy_proc = None
_policy_seq = 0


def _policy_read_state(max_age=None):
    """Read the runtime's state file; None when absent (or stale)."""
    try:
        snap = secure_read_json(POLICY_STATE_FILE)
    except (OSError, ValueError, TypeError):
        return None
    if max_age is not None:
        ts = snap.get("ts")
        if not isinstance(ts, (int, float)) or time.time() - ts > max_age:
            return None
    return snap


def _policy_runtime_alive():
    global _policy_proc
    if _policy_proc is None or _policy_proc.poll() is not None:
        return False
    snap = _policy_read_state(max_age=5.0)
    return bool(snap and snap.get("ok") is not False)


def _start_policy_runtime():
    """Spawn board-policy-runtime.py under the TROS environment if not alive.
    Blocks until its state file appears (or timeout) so callers get an honest
    launched/failed answer instead of accepting into the void."""
    global _policy_proc
    if _policy_runtime_alive():
        return True
    try:
        secure_unlink(POLICY_RUNTIME_READY)
    except OSError:
        pass
    if not os.path.exists(POLICY_RUNTIME_SCRIPT):
        return False
    try:
        _policy_proc = subprocess.Popen(
            [
                "bash",
                "-c",
                'set -e; source "$1" 2>/dev/null && source "$2" 2>/dev/null && exec python3 "$3"',
                "rdk-policy-runtime",
                TROS_SETUP,
                ORIGINBOT_WS_SETUP,
                POLICY_RUNTIME_SCRIPT,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "HOME": "/root", "TERM": "dumb",
                 "RDK_BOARD_RUNTIME_DIR": os.path.dirname(POLICY_CMD_FILE),
                 "RDK_BOARD_POLICY_CMD": POLICY_CMD_FILE,
                 "RDK_BOARD_POLICY_STATE": POLICY_STATE_FILE,
                 "RDK_BOARD_POLICY_READY": POLICY_RUNTIME_READY,
                 "RDK_BOARD_TELEMETRY_SNAPSHOT": TELEMETRY_SNAPSHOT_FILE,
                 "ROS_LOG_DIR": "/var/lib/rdk-board-agent/roslogs",
                 "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
    except OSError:
        _policy_proc = None
        return False
    deadline = time.time() + POLICY_READY_TIMEOUT
    while time.time() < deadline:
        if _policy_proc.poll() is not None:
            _policy_proc = None
            return False
        try:
            if secure_exists(POLICY_RUNTIME_READY):
                return True
        except OSError:
            pass
        time.sleep(0.1)
    try:
        _policy_proc.terminate()
        _policy_proc.wait(timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        pass
    _policy_proc = None
    return False


def _stop_policy_runtime():
    global _policy_proc
    if _policy_proc is not None:
        try:
            _policy_proc.terminate()
            _policy_proc.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            try:
                _policy_proc.kill()
            except OSError:
                pass
        _policy_proc = None
    for path in (POLICY_CMD_FILE, POLICY_RUNTIME_READY):
        try:
            secure_unlink(path)
        except OSError:
            pass


def _policy_send(op, **fields):
    """Write one file-protocol request and wait for the runtime's ack.

    Returns the runtime's post-op state snapshot (which carries a seq-
    correlated `lastOp` for THIS request), or an error dict."""
    global _policy_seq
    if not _start_policy_runtime():
        return {"ok": False, "error": "runtime-unavailable"}
    with _policy_lock:
        _policy_seq += 1
        seq = _policy_seq
    req = {"op": op, "seq": seq, **fields}
    try:
        atomic_write_text(
            POLICY_CMD_FILE,
            json.dumps(req, ensure_ascii=False, separators=(",", ":")),
        )
    except OSError:
        return {"ok": False, "error": "cmd-file-write-failed"}
    # The runtime polls at 50 ms; state file rewrite is atomic. Wait until
    # lastOp.seq == our seq (success or failure), or until timeout.
    deadline = time.time() + POLICY_APPLY_TIMEOUT
    while time.time() < deadline:
        snap = _policy_read_state()
        last = snap.get("lastOp") if snap else None
        if last and last.get("seq") == seq:
            if last.get("ok"):
                return {**snap, "ok": True}
            return {
                "ok": False,
                "error": last.get("error") or "policy-op-failed",
                "detail": last.get("detail"),
                "state": snap.get("state"),
            }
        if _policy_proc is not None and _policy_proc.poll() is not None:
            return {"ok": False, "error": "runtime-died"}
        time.sleep(0.05)
    # Surface the runtime's own last state so an operator can tell a wedged
    # runtime from a slow-but-progressing one without SSHing to the board.
    snap = _policy_read_state() or {}
    last_op = snap.get("lastOp") or {}
    return {
        "ok": False,
        "error": "policy-op-timeout",
        "detail": (
            f"apply timeout {POLICY_APPLY_TIMEOUT:.0f}s; runtime state={snap.get('state')}, "
            f"lastError={snap.get('lastError')}, lastOp.seq={last_op.get('seq')}"
        )[:300],
        "state": snap.get("state"),
    }


def policy_status():
    """Honest policy surface: switches, runtime process, last state snapshot."""
    snap = _policy_read_state()
    runtime_running = _policy_runtime_alive()
    return {
        "enabled": POLICY_ENABLED,
        "runtimeRunning": runtime_running,
        "driveEnabled": DRIVE_ENABLED,
        "actuatorEnabled": MOTION_SWITCH_ENABLED,
        "actuatorKind": PROFILE_ACTUATOR_KIND,
        "commandTopic": DRIVE_COMMAND_TOPIC,
        # Policy motion requires BOTH switches; report the combined verdict so
        # the UI can render exactly one gate explanation.
        "motionAuthorized": POLICY_ENABLED and MOTION_SWITCH_ENABLED,
        # A historical state file must never make a stopped process look
        # ready/running to the station UI or API consumers.
        "state": snap.get("state") if runtime_running and snap else "stopped" if snap else None,
        "model": snap.get("model") if snap else None,
        "command": snap.get("command") if runtime_running and snap else 0.0 if snap else None,
        "published": snap.get("published") if runtime_running and snap else 0 if snap else None,
        "inferMs": snap.get("inferMs") if runtime_running and snap else None,
        "provider": (snap.get("model") or {}).get("provider") if snap else None,
        "providerRequested": snap.get("providerRequested") if snap else None,
        "providersAvailable": (snap.get("model") or {}).get("providersAvailable") if snap else None,
        "observationLayout": snap.get("observationLayout") if snap else None,
        "actionProjection": snap.get("actionProjection") if snap else None,
        "actionOutput": snap.get("actionOutput") if snap else None,
        "actionOutputConfigError": snap.get("actionOutputConfigError") if snap else None,
        "actionScale": snap.get("actionScale") if snap else None,
        "controlHz": snap.get("controlHz") if snap else None,
        "controlPeriodSeconds": snap.get("controlPeriodSeconds") if snap else None,
        "lastCmdVel": snap.get("lastCmdVel") if snap else None,
        "lastError": snap.get("lastError") if snap else None,
        "lastOp": snap.get("lastOp") if snap else None,
        "obsSlots": snap.get("obsSlots") if snap else None,
        # Structured session evidence is kept separate from the live state so
        # a stopped process still exposes the last model fingerprint, start /
        # stop timestamps and inference count for Run reconciliation.
        "session": snap.get("session") if snap else None,
        "sessionId": (snap.get("session") or {}).get("id") if snap else None,
        "sessionStartedAt": (snap.get("session") or {}).get("startedAt") if snap else None,
        "sessionStoppedAt": (snap.get("session") or {}).get("stoppedAt") if snap else None,
        "sessionStopReason": (snap.get("session") or {}).get("stopReason") if snap else None,
        "inferenceCount": (snap.get("session") or {}).get("inferenceCount") if snap else None,
        "lastInferenceAt": (snap.get("session") or {}).get("lastInferenceAt") if snap else None,
        # Policy commands use the same bounded cmd_vel channel as the manual
        # canary, but the policy runtime has its own state machine. Expose
        # measured odometry here so a running policy cannot be mistaken for
        # proof that the chassis actually moved.
        "feedback": _drive_feedback(),
        "limits": {
            "maxLinear": DRIVE_MAX_LINEAR,
            "maxAngular": DRIVE_MAX_ANGULAR,
            "decisionHz": DRIVE_PUBLISH_HZ,
            "chassisWatchdogMs": DRIVE_WATCHDOG_MS,
        },
        "note": "trained-policy inference on board; motion requires the board drive/policy switches, "
                "and the selected adapter runtime publishes only its declared command type",
    }


def policy_stop(reason="operator-stop"):
    """Always honored: forward stop even when disabled, and kill the runtime
    output by file protocol + process termination as a floor."""
    res = None
    if _policy_runtime_alive():
        res = _policy_send("stop", reason=reason)
        if not res.get("ok"):
            _stop_policy_runtime()
            res = {"ok": True, "state": "idle", "stoppedBy": "process-terminated"}
    else:
        res = {"ok": True, "state": None, "stoppedBy": "runtime-not-running"}
    # A joint runtime owns its trajectory topic and has no resident /cmd_vel
    # publisher to restore. The drive runtime releases /cmd_vel exclusively
    # and is re-warmed after the policy session.
    if not JOINT_ACTUATOR:
        _rewarm_drive_publisher()
    return res


# ---- policy artifact staging (upload into the pinned policies dir) -------
def policy_stage(policy_bytes_b64, filename, sha256_hex):
    """Store one uploaded ONNX into the pinned policies directory.

    Contract, mirroring policy_load's fail-closed stance:
      * filename must be a bare <word>.onnx name (no separators, no ..,
        no NUL smuggling) so a staged file can never land outside the
        pinned dir;
      * bytes arrive base64-encoded inside the JSON body (bounded), are
        size-checked (<= 50 MB, same as runtime load) and SHA-256-verified
        against the caller's declared digest BEFORE anything touches disk;
      * the write is atomic (tmp + rename) and never overwrites an existing
        different model silently — a same-name upload must hash identically
        or be refused;
      * the runtime is never told to load it: staging and loading stay two
        explicit operator actions.
    """
    if not POLICY_ENABLED:
        return {"ok": False, "error": "policy-disabled"}
    if not isinstance(filename, str) or not re.match(r"^[\w.-]+\.(?:onnx|bin)$", filename) or ".." in filename:
        return {"ok": False, "error": "policy-filename-invalid",
                "message": "仅接受 policies 目录内的 .onnx 或 .bin 文件名"}
    try:
        payload = base64.b64decode(policy_bytes_b64 or "", validate=True)
    except (ValueError, TypeError):
        return {"ok": False, "error": "policy-bytes-invalid",
                "message": "制品字节必须是合法 base64"}
    if len(payload) == 0:
        return {"ok": False, "error": "policy-bytes-empty"}
    if len(payload) > 50 * 1024 * 1024:
        return {"ok": False, "error": "policy-too-large",
                "message": "制品超过 50MB 上限"}
    digest = hashlib.sha256(payload).hexdigest()
    if not isinstance(sha256_hex, str) or digest != sha256_hex.strip().lower():
        return {"ok": False, "error": "policy-digest-mismatch",
                "message": "制品 SHA-256 与声明不一致；拒绝写入",
                "actual": digest}
    target = os.path.join(POLICY_ALLOWED_MODEL_DIR, filename)
    try:
        # Ensure the pinned directory itself is a private, trusted boundary;
        # this also creates it on a fresh board without following a symlink.
        ensure_private_parent(target, create=True)
        target_exists = secure_exists(target)
    except OSError:
        return {"ok": False, "error": "policy-path-unsafe",
                "message": "策略目录或目标文件不是受信任的 root-only 路径"}
    if target_exists:
        fd = None
        try:
            fd = secure_open_read(target)
            with os.fdopen(fd, "rb", closefd=True) as fh:
                fd = None
                existing_size = 0
                existing_digest = hashlib.sha256()
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    existing_size += len(chunk)
                    if existing_size > 50 * 1024 * 1024:
                        return {"ok": False, "error": "policy-too-large"}
                    existing_digest.update(chunk)
            existing = existing_digest.hexdigest()
        except OSError:
            return {"ok": False, "error": "policy-path-unsafe",
                    "message": "同名策略文件不是受信任的普通文件"}
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if existing != digest:
            return {"ok": False, "error": "policy-name-conflict",
                    "message": "同名制品已存在且内容不同；请先在板上删除或换名重传",
                    "existing": existing}
        return {"ok": True, "staged": True, "path": filename, "bytes": len(payload),
                "sha256": digest, "note": "byte-identical to the staged file; no rewrite"}
    try:
        # Random O_EXCL temp + O_NOFOLLOW target checks eliminate the historic
        # target + ".tmp" symlink race and fsync the model before publishing it.
        atomic_write_bytes(target, payload, max_bytes=50 * 1024 * 1024)
    except OSError:
        return {"ok": False, "error": "policy-write-failed",
                "message": "策略文件写入失败；拒绝继续"}
    return {"ok": True, "staged": True, "path": filename, "bytes": len(payload),
            "sha256": digest, "note": "staged into the pinned policies dir; loading stays a separate action"}


def _policy_file_digest(path):
    """SHA-256 of a staged policy, or None when it cannot be read safely."""
    digest = hashlib.sha256()
    fd = None
    try:
        fd = secure_open_read(path)
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    except OSError:
        return None
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
    return digest.hexdigest()


# Digest of every listed policy as (size, mtime_ns, sha256). Hashing up to 50 MB
# on every list request would be wasteful, and the digest is what binds a board
# latency rehearsal to the bytes it measured, so it is cached until the file
# actually changes. A test can clear it; nothing else needs to.
_POLICY_DIGEST_CACHE = {}


def policy_list():
    """List loadable ONNX files in the pinned policies dir.

    Each entry carries the size and the SHA-256 of the file on disk. The digest
    is not decoration: `shared/board-rehearsal.ts` binds a rehearsal receipt to
    an artifact by digest, so a policy cannot be certified by a rehearsal that
    measured different bytes.
    """
    try:
        ensure_private_parent(
            os.path.join(POLICY_ALLOWED_MODEL_DIR, ".policy-list-probe"),
            create=False,
        )
        entries = []
        for name in os.listdir(POLICY_ALLOWED_MODEL_DIR):
            if not re.match(r"^[\w.-]+\.(?:onnx|bin)$", name):
                continue
            path = os.path.join(POLICY_ALLOWED_MODEL_DIR, name)
            try:
                size = secure_size(path)
                stat = os.stat(path)
            except OSError:
                # Symlink/non-regular/foreign-owned entries are omitted rather
                # than exposed as loadable artifacts.
                continue
            fingerprint = (size, getattr(stat, "st_mtime_ns", None))
            cached = _POLICY_DIGEST_CACHE.get(name)
            if cached and cached[0] == fingerprint:
                sha256 = cached[1]
            else:
                sha256 = _policy_file_digest(path)
                _POLICY_DIGEST_CACHE[name] = (fingerprint, sha256)
            entries.append((name, size, sha256))
        entries.sort()
    except OSError:
        entries = []
    return {
        "ok": True,
        "dir": POLICY_ALLOWED_MODEL_DIR,
        "policies": [
            {"name": name, "bytes": size, **({"sha256": sha256} if sha256 else {})}
            for name, size, sha256 in entries
        ],
    }


def _policy_allowed_model_path(path):
    """Only models under the pinned policies dir are loadable, and the file
    must exist and be a regular file (no traversal, no devices/sockets).

    Accepts either a bare filename (resolved against the policies dir, which
    is what the platform proxy sends) or a caller-supplied path already
    inside that dir (what older platform builds sent); anything else is
    rejected before it reaches the runtime."""
    if not isinstance(path, str) or not path:
        return False, "model-path-required"
    if "/" not in path and "\\" not in path:
        # Bare filename: reject separators smuggled in any other form (e.g.
        # NUL bytes) before joining with the pinned dir.
        if not re.match(r"^[\w.-]+$", path) or ".." in path:
            return False, "model-path-invalid"
        path = os.path.join(POLICY_ALLOWED_MODEL_DIR, path)
    base = os.path.realpath(POLICY_ALLOWED_MODEL_DIR)
    resolved = os.path.realpath(path)
    if not (resolved == base or resolved.startswith(base + os.sep)):
        return False, "model-path-outside-allowed-dir"
    try:
        # The policy directory and the selected inode must both be private
        # regular files.  realpath containment alone would allow an in-tree
        # symlink to silently change between validation and load.
        ensure_private_parent(resolved, create=False)
        if os.path.islink(path) or os.path.islink(resolved):
            return False, "model-file-symlink"
        if not os.path.isfile(resolved):
            return False, "model-file-missing"
        model_size = secure_size(resolved)
    except OSError:
        return False, "model-file-unsafe"
    if model_size > 50 * 1024 * 1024:
        return False, "model-too-large"
    if model_size <= 0:
        return False, "model-file-missing"
    return True, resolved


def policy_load(path):
    if not POLICY_ENABLED:
        return {"ok": False, "error": "policy-disabled"}
    ok, resolved = _policy_allowed_model_path(path)
    if not ok:
        return {"ok": False, "error": resolved}
    return _policy_send("load", path=resolved)


def policy_start(direction, goal_x=None, goal_y=None):
    if not POLICY_ENABLED:
        return {"ok": False, "error": "policy-disabled"}
    if not MOTION_SWITCH_ENABLED:
        # Gate honesty: refuse before touching the runtime, explain both gates.
        return {"ok": False, "error": "drive-disabled",
                "message": "policy start requires RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1 too"}
    if not JOINT_ACTUATOR and not _finite_number(direction):
        return {"ok": False, "error": "invalid-type"}
    if (goal_x is None) != (goal_y is None):
        return {"ok": False, "error": "invalid-goal",
                "message": "goalX 与 goalY 必须同时提供或同时省略"}
    if goal_x is not None and (not _finite_number(goal_x) or not _finite_number(goal_y)):
        return {"ok": False, "error": "invalid-goal",
                "message": "goalX/goalY 必须是有限数字"}
    snap = _policy_read_state()
    model = snap.get("model") if isinstance(snap, dict) else None
    if not JOINT_ACTUATOR and isinstance(model, dict) and model.get("inputDim") in (8, 42):
        if goal_x is None or goal_y is None:
            contract = "8D OriginBot" if model.get("inputDim") == 8 else "42D goalnav (imu-gravity-v1)"
            return {"ok": False, "error": "goal-required",
                    "message": "%s 策略需要同时提供 goalX/goalY（odom 绝对坐标，单位：米）" % contract}
    payload = {"direction": float(direction) if _finite_number(direction) else 0.0}
    if goal_x is not None or goal_y is not None:
        payload.update({"goalX": goal_x, "goalY": goal_y})
    # Exclusive /cmd_vel ownership: the resident drive publisher streams idle
    # zeros at 10 Hz whenever the drive switch is on, so a policy session
    # would interleave its own frames with zeros — the chassis target speed
    # resets every cycle and the robot never accelerates. Policy motion is a
    # separate motion authority: tear the publisher down first and re-warm it
    # when the session ends. drive_command re-warms on demand anyway, so the
    # manual canary path is unaffected.
    if not JOINT_ACTUATOR:
        _stop_drive_publisher()
    res = _policy_send("start", **payload)
    if not (isinstance(res, dict) and res.get("ok")) and not JOINT_ACTUATOR:
        _rewarm_drive_publisher()
    return res


def _rewarm_drive_publisher():
    """Asynchronously restore the resident publisher after policy motion
    releases /cmd_vel. Boot pre-warm exists to keep the first manual drive
    window latency-free; this restores the same steady state. Failures are
    harmless — drive_command starts the publisher on demand."""
    if DRIVE_ENABLED and not JOINT_ACTUATOR:
        threading.Thread(target=_start_drive_publisher, daemon=True).start()


def _start_ob_sampler():
    global _ob_thread
    if _ob_thread is None:
        _ob_thread = threading.Thread(target=_ob_sampler_loop, daemon=True)
        _ob_thread.start()


# ---- web-managed switch surface (/v1/config) ----------------------------
# The two motion switches stay opt-in env flags; this surface only rewrites
# those two lines in the unit's EnvironmentFile and restarts the unit so the
# agent cold-starts through the normal publisher handshake + watchdog. The
# token, ports, and every other env line pass through untouched.

AGENT_ENV_FILE = os.environ.get(
    "RDK_SIM2REAL_BOARD_AGENT_ENV_FILE", "/etc/rdk-board-agent/agent.env"
)
AGENT_UNIT_NAME = os.environ.get(
    "RDK_SIM2REAL_BOARD_AGENT_UNIT", "rdk-board-agent.service"
)
_CONFIG_SWITCHES = ("RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE", "RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY")


def config_status():
    """Switch states as this agent sees them, plus the env-file source."""
    try:
        env_info = os.lstat(AGENT_ENV_FILE)
        env_present = (
            stat.S_ISREG(env_info.st_mode)
            and env_info.st_uid == (0 if os.geteuid() == 0 else os.geteuid())
            and (env_info.st_mode & 0o7777) == 0o600
        )
    except OSError:
        env_present = False
    return {
        "ok": True,
        "envFile": AGENT_ENV_FILE,
        "envFileExists": env_present,
        "unit": AGENT_UNIT_NAME,
        "systemdManaged": os.path.isdir("/run/systemd/system"),
        "switches": {
            "RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": MOTION_SWITCH_ENABLED,
            "RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY": POLICY_ENABLED,
        },
        "restartable": env_present and os.path.isdir("/run/systemd/system"),
    }


def _config_apply(desired):
    """Rewrite the two switch lines in the env file, then restart the unit.

    Returns a dict like the route responses: ok/error/message. The env file is
    rewritten atomically; a restart is refused while a motion window is active
    so a mid-motion unit restart can never swap the safety layer out from
    under the robot."""
    if not isinstance(desired, dict):
        return {"ok": False, "error": "invalid-type"}
    parsed = {}
    for key in _CONFIG_SWITCHES:
        if key in desired:
            value = desired[key]
            if not isinstance(value, bool):
                return {"ok": False, "error": "invalid-value",
                        "message": f"{key} 需为布尔值"}
            parsed[key] = "1" if value else "0"
    if not parsed:
        return {"ok": False, "error": "no-switches"}
    with _drive_lock:
        if _drive_state["active"]:
            return {"ok": False, "error": "motion-active",
                    "message": "运动窗口进行中，拒绝重启；等待窗口结束或先急停。"}
    expected_uid = 0 if os.geteuid() == 0 else os.geteuid()
    try:
        env_info = os.lstat(AGENT_ENV_FILE)
    except OSError:
        env_info = None
    if env_info is None:
        return {"ok": False, "error": "env-file-missing",
                "message": f"未找到 {AGENT_ENV_FILE}；此 agent 可能不是 systemd 部署。"}
    if os.path.islink(AGENT_ENV_FILE) or not stat.S_ISREG(env_info.st_mode):
        return {"ok": False, "error": "env-file-unsafe",
                "message": "env 文件必须是普通文件，拒绝跟随符号链接。"}
    if env_info.st_uid != expected_uid:
        return {"ok": False, "error": "env-file-owner",
                "message": "env 文件必须由运行账号所有。"}
    if (env_info.st_mode & 0o7777) != 0o600:
        return {"ok": False, "error": "env-file-permissions",
                "message": "env 文件必须保持 0600 权限，避免泄露 agent token。"}
    parent = os.path.dirname(AGENT_ENV_FILE) or "."
    try:
        parent_info = os.lstat(parent)
        if not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode):
            return {"ok": False, "error": "env-directory-unsafe",
                    "message": "env 文件所在目录必须是普通目录。"}
    except OSError as error:
        return {"ok": False, "error": "env-directory-missing", "message": str(error)}
    try:
        with open(AGENT_ENV_FILE, "r", encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError as error:
        return {"ok": False, "error": "env-read-failed", "message": str(error)}
    kept = [line for line in lines
            if line.split("=", 1)[0].strip() not in _CONFIG_SWITCHES]
    for key, value in parsed.items():
        kept.append(f"{key}={value}")
    temporary = AGENT_ENV_FILE + ".agent-tmp"
    temp_fd = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        temp_fd = os.open(temporary, flags, 0o600)
        os.fchmod(temp_fd, 0o600)
        with os.fdopen(temp_fd, "w", encoding="utf-8") as handle:
            temp_fd = None
            handle.write("\n".join(kept) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, AGENT_ENV_FILE)
        # A successful rename is durable only after the containing directory is
        # synced.  Keep the token-bearing EnvironmentFile update atomic across
        # a board reboot or sudden power loss.
        dir_flags = os.O_RDONLY
        if hasattr(os, "O_DIRECTORY"):
            dir_flags |= os.O_DIRECTORY
        directory_fd = os.open(parent, dir_flags)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as error:
        if temp_fd is not None:
            try:
                os.close(temp_fd)
            except OSError:
                pass
        try:
            os.unlink(temporary)
        except OSError:
            pass
        return {"ok": False, "error": "env-write-failed", "message": str(error)}
    if not os.path.isdir("/run/systemd/system"):
        # Not systemd-managed (e.g. developer running the agent by hand): the
        # env is updated but this process keeps its current switches. Say so
        # instead of pretending a restart happened.
        return {"ok": True, "restarted": False, "switches": {"applied": parsed},
                "message": "env 文件已更新；当前进程非 systemd 管理，需手动重启后生效。"}
    restart = subprocess.run(
        ["systemctl", "restart", AGENT_UNIT_NAME],
        capture_output=True, text=True, timeout=15,
    )
    if restart.returncode != 0:
        return {"ok": False, "error": "restart-failed",
                "message": (restart.stderr or "").strip()[:300] or "systemctl restart 失败"}
    return {"ok": True, "restarted": True, "switches": {"applied": parsed},
            "message": "开关已写入 env 并重启服务；约 2 秒后重新查询状态确认。"}


def find_camera_device():
    """Probe hobot_usb_cam device candidates read-only (no camera opened)."""
    candidates = []
    if os.path.isdir("/sys/class/video4linux"):
        for name in sorted(os.listdir("/sys/class/video4linux")):
            candidates.append(f"/dev/{name}")
    return candidates


def onboarding_preflight():
    """Return a structured, read-only onboarding passport for a new board.

    The legacy deployment probe intentionally stays byte-compatible with the
    server contract.  This richer surface is additive: it lets a new device
    be diagnosed in one call without granting the web layer arbitrary shell
    access or silently enabling motion.  Every check is derived from local
    observations; ``ready`` is never inferred from the board model alone.
    """
    camera_devices = find_camera_device()
    topics = ros_topics_cached() or []
    telemetry = originbot_telemetry_cached()
    tros_present = os.path.exists(TROS_SETUP) or os.path.isdir("/opt/ros")
    python_present = bool(shutil.which("python3"))
    policy_dir = os.path.isdir(POLICY_ALLOWED_MODEL_DIR)
    policy_files = policy_list().get("policies", [])
    expected_topics = {
        "imu": str((_profile_topics.get("imu") or {}).get("name") or "/imu"),
        "odom": str((_profile_topics.get("odom") or {}).get("name") or "/odom"),
        "cmdVel": DRIVE_COMMAND_TOPIC,
    }
    topic_names = set(str(item) for item in topics)
    topic_checks = {
        key: {"name": name, "present": name in topic_names}
        for key, name in expected_topics.items()
    }
    checks = {
        "identity": {
            "ok": bool(_identity.get("platform") and _identity.get("model")),
            "board": _identity,
            "adapterId": _adapter_id,
        },
        "python": {"ok": python_present, "path": shutil.which("python3") or "missing"},
        "tros": {"ok": tros_present, "setup": TROS_SETUP if os.path.exists(TROS_SETUP) else "/opt/ros"},
        "camera": {"ok": bool(camera_devices), "devices": camera_devices, "cv2": CV2_AVAILABLE},
        "ros": {
            "ok": bool(topics),
            "topicCount": len(topics),
            "topics": sorted(topic_names)[:80],
            "expected": topic_checks,
        },
        "telemetry": {
            "ok": isinstance(telemetry, dict),
            "fresh": isinstance(telemetry, dict),
            "fields": sorted(telemetry.keys())[:32] if isinstance(telemetry, dict) else [],
        },
        "policy": {
            "enabled": POLICY_ENABLED,
            "runtimeRunning": _policy_runtime_alive(),
            "artifactDir": POLICY_ALLOWED_MODEL_DIR,
            "artifactDirPresent": policy_dir,
            "artifactCount": len(policy_files),
        },
        "safety": {
            "driveEnabled": DRIVE_ENABLED,
            "actuatorEnabled": MOTION_SWITCH_ENABLED,
            "actuatorKind": PROFILE_ACTUATOR_KIND,
            "policyEnabled": POLICY_ENABLED,
            "motionAuthorized": MOTION_SWITCH_ENABLED and POLICY_ENABLED,
            "limits": _actuator_policy(),
            "emergencyStop": "/v1/station/drive/stop",
        },
    }
    required = ("identity", "python", "tros", "camera", "ros", "telemetry")
    missing = [key for key in required if not checks[key]["ok"]]
    next_actions = []
    if not tros_present:
        next_actions.append("install or source TROS (/opt/tros or /opt/ros)")
    if not camera_devices:
        next_actions.append("connect a V4L2 camera and verify /dev/video*")
    if not topics:
        next_actions.append("start the OriginBot bringup and verify ROS topics")
    if not isinstance(telemetry, dict):
        next_actions.append("start the read-only IMU/odom telemetry sampler")
    if not POLICY_ENABLED:
        next_actions.append("stage/load a policy first; keep policy motion disabled by default")
    status = "ready" if not missing else "attention"
    return {
        "ok": True,
        "kind": "originbot-onboarding-preflight",
        "schemaVersion": 1,
        "mock": False,
        "status": status,
        "ready": not missing,
        "blockingChecks": missing,
        "nextActions": next_actions,
        "checks": checks,
        "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "motion": {"started": False, "note": "onboarding preflight is read-only"},
    }


def build_status():
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cpu = cpu_percent()
    temp = cpu_temperature()
    total_mem, avail_mem = memory_mb()
    rx, tx = network_kb_per_sec()
    total_disk, used_disk = disk_mb()
    topics = ros_topics_cached() or []
    originbot = originbot_telemetry_cached()
    battery_voltage = originbot.get("batteryVoltage") if isinstance(originbot, dict) else None
    power = {"voltage": battery_voltage} if isinstance(battery_voltage, (int, float)) else None
    return {
        "timestamp": now,
        "board": {
            "platform": _identity["platform"],
            "model": _identity["model"],
            "mock": False,
        },
        "profile": {
            "id": _adapter_id,
            "displayName": _adapter_profile.get("displayName", _identity["model"]),
            "capabilities": _adapter_capabilities,
        },
        "adapterId": _adapter_id,
        "arm": arm_status(),
        "cpu": {
            "percent": cpu,
            "temperatureC": temp,
        },
        "memory": {
            "totalMB": total_mem,
            "usedMB": total_mem - avail_mem,
        },
        "disk": {"totalMB": total_disk, "usedMB": used_disk},
        "network": {
            "mode": "ethernet",
            **({"rxKbPerSec": rx} if rx is not None else {}),
            **({"txKbPerSec": tx} if tx is not None else {}),
        },
        "power": power,
        "originbot": originbot,
        "telemetry": originbot,
        "originbotNote": "read-only ros2 topic echo; the agent never publishes or moves the robot",
        "topics": [{"name": name} for name in topics[:24]],
        "uptimeSec": int(time.time() - STARTED_AT),
        "cameraDevices": find_camera_device(),
        "actuatorControl": MOTION_SWITCH_ENABLED,
        "policy": policy_status(),
    }


def build_command_result(command_id):
    if command_id == "list-tros-nodes":
        result = run_ros2_list("node")
        lines = result.get("lines") or [f"(ros2 node list: {result.get('error', 'no nodes')})"]
    elif command_id == "list-tros-topics":
        result = run_ros2_list("topic")
        lines = result.get("lines") or [f"(ros2 topic list: {result.get('error', 'no topics')})"]
    elif command_id == "disk-usage":
        lines = [line for line in (shutil.disk_usage.__doc__ or "")]
        # render `df -h /` output bounded to 12 lines without running a shell
        total, used, free = shutil.disk_usage("/")
        gib = 1024 ** 3
        lines = [
            "Filesystem      Size  Used Avail Use%",
            f"/dev/root       {total // gib}G  {used // gib}G  {free // gib}G  {round(used * 100 / total)}%",
        ]
    elif command_id == "service-status":
        def is_active(unit):
            # unit comes from the fixed literal list below, never from a request
            if unit not in ("tros", "sshd", "systemd-journald"):
                return "unknown"
            try:
                out = subprocess.run(
                    ["systemctl", "is-active", unit],
                    capture_output=True, text=True, timeout=3,
                )
                return out.stdout.strip() or "unknown"
            except (subprocess.TimeoutExpired, OSError):
                return "unknown"

        lines = [f"{unit}: {is_active(unit)}" for unit in ("tros", "sshd", "systemd-journald")]
    else:
        return None
    return {
        "ok": True,
        "id": command_id,
        "output": "\n".join(lines)[:4000],
        "mock": False,
        "actuatorControl": False,
        "executedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def build_preflight_command():
    """Byte-identical to the server's buildBoardPreflightCommand() so the
    allowlist comparison is a simple equality check on a fixed string."""
    return "; ".join([
        "set +e",
        f'printf "{PREFLIGHT_BEGIN}\\n"',
        'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
        'printf "kernel=%s\\n" "$(uname -r 2>/dev/null || echo unknown)"',
        'printf "python3=%s\\n" "$(command -v python3 2>/dev/null || echo missing)"',
        'printf "tros=%s\\n" "$(if test -d /opt/tros || test -d /opt/ros; then echo present; else echo missing; fi)"',
        "printf \"disk_bytes=%s\\n\" \"$(df -Pk /tmp 2>/dev/null | awk 'NR==2 {print $4 * 1024}' || echo unknown)\"",
        'printf "bpu_toolchain=%s\\n" "$(if command -v hbdk-sim >/dev/null 2>&1 && (command -v hbrtmlin >/dev/null 2>&1 || command -v hbrt-tv >/dev/null 2>&1); then echo present; else echo missing; fi)"',
        f'printf "{PREFLIGHT_END}\\n"',
    ])


PREFLIGHT_COMMAND = build_preflight_command()


def build_preflight_output():
    arch = os.uname().machine
    kernel = os.uname().release
    python3 = "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else "missing"
    tros = "present" if os.path.exists(TROS_SETUP) or os.path.exists("/opt/ros") else "missing"
    try:
        st = os.statvfs("/tmp")
        disk_bytes = str(st.f_bavail * st.f_frsize)
    except OSError:
        disk_bytes = "unknown"
    # Same presence-only contract as the fixed probe string: the agent answers
    # from its own PATH so the value is real, never assumed from the board model.
    bpu = "present" if shutil.which("hbdk-sim") and (shutil.which("hbrtmlin") or shutil.which("hbrt-tv")) else "missing"
    lines = [
        PREFLIGHT_BEGIN,
        f"arch={arch}",
        f"kernel={kernel}",
        f"python3={python3}",
        f"tros={tros}",
        f"disk_bytes={disk_bytes}",
        f"bpu_toolchain={bpu}",
        PREFLIGHT_END,
    ]
    return "\n".join(lines) + "\n"


# ---- camera: real device only, never synthetic -----------------------------

try:
    import cv2  # noqa: F401  (optional; checked at request time)

    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False


class CameraStream:
    """Opens the first hobot_usb_cam-compatible V4L2 device via OpenCV.

    Devices are only opened when a client actually requests the stream; the
    agent never fabricates frames. When nothing is connected the route answers
    503 CAMERA_UNAVAILABLE so the workbench can render the honest placeholder.
    """

    def __init__(self):
        self._lock = threading.Lock()

    def open(self):
        devices = find_camera_device()
        if not devices or not CV2_AVAILABLE:
            return None
        import cv2

        for device in devices:
            cap = cv2.VideoCapture(device)
            if cap.isOpened():
                return cap
            cap.release()
        return None


CAMERA = CameraStream()


# ---- HTTP surface -----------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "rdk-board-agent/1.0"

    # A board agent is commonly exposed through a local tunnel, so a client
    # that opens a socket and then drips headers/body bytes must not be able to
    # pin one of the threaded request workers forever.  Keep the timeout on the
    # socket itself; route-level command timeouts cannot protect this phase.
    def setup(self):
        super().setup()
        try:
            self.connection.settimeout(30.0)
        except OSError:
            # Test doubles and unusual embedded sockets may not expose a
            # writable timeout.  The normal HTTP server still works there.
            pass

    def log_message(self, fmt, *args):  # keep the board journal quiet
        sys.stderr.write("[board-agent] " + (fmt % args) + "\n")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if not TOKEN:
            return True
        # Constant-time comparison: an attacker able to time responses must
        # not learn the token byte by byte. hmac.compare_digest also refuses
        # non-ASCII input, which `==` would silently accept.
        return hmac.compare_digest(self.headers.get("authorization") or "", f"Bearer {TOKEN}")

    def _header_values(self, name):
        """Return every occurrence of an HTTP header, preserving duplicates.

        ``Message.get()`` returns only the first value.  That is unsafe for
        framing headers because a second (possibly conflicting) value can be
        interpreted differently by a proxy in front of this process.  The
        small dict fallback keeps the helper easy to exercise with the test
        doubles used by the board contract tests.
        """
        getter = getattr(self.headers, "get_all", None)
        if callable(getter):
            values = getter(name) or []
            return [str(value) for value in values]
        value = self.headers.get(name)
        return [] if value is None else [str(value)]

    def _framing_headers_valid(self):
        """Validate framing syntax before authentication or route dispatch.

        Python's ``BaseHTTPRequestHandler`` deliberately leaves chunked body
        decoding to applications.  This agent does not implement a chunk
        decoder, so every non-identity transfer coding is rejected.  Multiple
        or comma-separated ``Content-Length`` values are rejected even when
        they happen to contain the same number; accepting them would make the
        request boundary depend on which intermediary parsed the request.
        """
        transfer_values = self._header_values("transfer-encoding")
        if len(transfer_values) > 1:
            self.close_connection = True
            return False
        if transfer_values:
            transfer = transfer_values[0].strip().lower()
            if not transfer or "," in transfer or transfer != "identity":
                self.close_connection = True
                return False
        content_lengths = self._header_values("content-length")
        if len(content_lengths) > 1:
            self.close_connection = True
            return False
        if content_lengths:
            raw = content_lengths[0]
            if "," in raw or not re.fullmatch(r"[0-9]+", raw.strip()):
                self.close_connection = True
                return False
        return True

    def _declared_body_length(self):
        """Return a syntactically valid declared length, or ``None``.

        A missing ``Content-Length`` is represented as zero for the routes in
        this agent that do not accept a body.  Unsupported transfer codings
        and malformed/duplicate lengths close the connection first.
        """
        if not self._framing_headers_valid():
            return None
        values = self._header_values("content-length")
        if not values:
            return 0
        try:
            return int(values[0].strip())
        except (TypeError, ValueError):
            self.close_connection = True
            return None

    def _require_empty_body(self):
        """Reject a body on a logically bodyless route.

        ``Content-Length: 0`` and an absent length are valid empty requests.
        The platform historically sent ``{}`` to stop/reset endpoints, so a
        small, strictly empty JSON object is consumed and accepted as well.
        Any other body is consumed when bounded, then rejected with the
        connection marked for close; an oversized body is rejected without
        reading and likewise closed, preventing unread bytes from becoming a
        second HTTP/1.1 request.
        """
        length = self._declared_body_length()
        if length is None or length < 0:
            self.close_connection = True
            return False
        if length == 0:
            return True
        if length > MAX_EMPTY_BODY_BYTES:
            self.close_connection = True
            return False
        try:
            raw = self.rfile.read(length)
        except (OSError, ValueError):
            self.close_connection = True
            return False
        if len(raw) != length:
            self.close_connection = True
            return False
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self.close_connection = True
            return False
        if isinstance(payload, dict) and not payload:
            return True
        self.close_connection = True
        return False

    def _content_length(self, ceiling, *, allow_empty=False):
        """Return a safe body length, closing the connection on bad framing.

        ``BaseHTTPRequestHandler`` does not decode chunked request bodies. If
        we simply return an empty payload for a malformed/oversized request,
        unread bytes can be interpreted as the next request on a persistent
        HTTP/1.1 connection.  Marking that connection for close makes the
        rejection deterministic and prevents request-smuggling style desync.
        """
        if not self._framing_headers_valid():
            return None
        values = self._header_values("content-length")
        if not values:
            if allow_empty:
                return 0
            self.close_connection = True
            return None
        try:
            length = int(values[0].strip())
        except (TypeError, ValueError):
            self.close_connection = True
            return None
        if length < 0 or (length == 0 and not allow_empty) or length > ceiling:
            self.close_connection = True
            return None
        return length

    def do_GET(self):
        # GET handlers never consume a request body.  Validate the framing
        # before auth/dispatch and close on any declared bytes so a body
        # cannot be reinterpreted as the next request on keep-alive.
        if not self._framing_headers_valid():
            self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_FRAMING"})
            return
        if self._declared_body_length() != 0:
            self.close_connection = True
            self._json(400, {"ok": False, "error": "BOARD_AGENT_BODY_NOT_ALLOWED"})
            return
        if not self._authorized():
            self._json(401, {"ok": False, "error": "BOARD_AGENT_UNAUTHORIZED"})
            return
        path = self.path.split("?")[0]
        if path == "/healthz":
            self._json(200, {
                "ok": True,
                "service": "rdk-x5-board-agent",
                "capabilities": ["read-only-preflight", "originbot-onboarding", "host-station"]
                + (["constrained-drive"] if DRIVE_ENABLED else [])
                + arm_capability(),
                "stationCommands": [{"id": c["id"], "label": c["label"]} for c in STATION_COMMANDS],
                "actuatorControl": MOTION_SWITCH_ENABLED,
                "actuatorPolicy": _actuator_policy(),
                "mock": False,
                "board": _identity,
                "profile": {
                    "id": _adapter_id,
                    "displayName": _adapter_profile.get("displayName", _identity["model"]),
                    "capabilities": _adapter_capabilities,
                },
                "adapterId": _adapter_id,
                "camera": {
                    "devices": find_camera_device(),
                    "cv2": CV2_AVAILABLE,
                },
                "drive": drive_status(),
            })
            return
        if path == "/v1/onboarding/preflight":
            # Additive structured passport for new-device onboarding.  It is
            # deliberately read-only and does not start ROS, load a model, or
            # touch an actuator.
            self._json(200, onboarding_preflight())
            return
        if path == "/v1/station/status":
            self._json(200, {**build_status(), "drive": drive_status()})
            return
        if path == "/v1/station/drive":
            self._json(200, {"ok": True, "drive": drive_status(),
                             "actuatorPolicy": _actuator_policy()})
            return
        if path == "/v1/station/arm/status":
            self._json(200, {"ok": True, "arm": arm_status(),
                             "capabilities": arm_capability()})
            return
        if path == "/v1/station/policy":
            self._json(200, {"ok": True, "policy": policy_status()})
            return
        if path == "/v1/station/policy/files":
            self._json(200, policy_list())
            return
        if path == "/v1/config":
            self._json(200, config_status())
            return
        if path == "/v1/station/status/stream":
            self._stream_ndjson()
            return
        if path == "/v1/station/camera.snapshot":
            self._camera_snapshot()
            return
        if path == "/v1/station/camera.mjpeg":
            self._stream_camera()
            return
        self._json(404, {"ok": False, "error": "BOARD_AGENT_NOT_FOUND"})

    def do_POST(self):
        # Validate duplicate/conflicting framing headers before authentication.
        # This agent does not implement chunked decoding, and returning an
        # error while leaving an unread body on a persistent socket would
        # desynchronise the next request.
        if not self._framing_headers_valid():
            self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_FRAMING"})
            return
        if not self._authorized():
            # An authenticated route would consume its body below; an
            # unauthenticated request is rejected before route dispatch.  Close
            # whenever it declares bytes so those bytes cannot become a second
            # request after the 401 response.
            if self._declared_body_length() not in (0, None):
                self.close_connection = True
            self._json(401, {"ok": False, "error": "BOARD_AGENT_UNAUTHORIZED"})
            return
        path = self.path.split("?")[0]
        match = re.match(r"^/v1/devices/([^/]+)/commands$", path)
        if match:
            self._device_commands(match.group(1))
            return
        if path == "/v1/station/commands":
            self._station_command()
            return
        if path == "/v1/station/drive":
            self._station_drive()
            return
        if path == "/v1/station/arm/move":
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
                return
            ok, reason = arm_move(
                payload.get("x"), payload.get("y"), payload.get("z"),
                payload.get("speedMmPerS", 60.0),
            )
            if not ok:
                self._json(409, {"ok": False, "error": "BOARD_AGENT_ARM_REFUSED",
                                 "reason": reason, "arm": arm_status()})
                return
            self._json(200, {"ok": True, "arm": arm_status()})
            return
        if path == "/v1/station/arm/gripper":
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
                return
            ok, reason, detail = arm_gripper(
                payload.get("action"), payload.get("value")
            )
            if not ok:
                self._json(409, {"ok": False, "error": "BOARD_AGENT_ARM_REFUSED",
                                 "reason": reason, "arm": arm_status()})
                return
            self._json(200, {"ok": True, "detail": detail, "arm": arm_status()})
            return
        if path == "/v1/station/arm/stop":
            if not self._require_empty_body():
                self._json(400, {"ok": False, "error": "BOARD_AGENT_BODY_NOT_ALLOWED"})
                return
            # Like drive stop: always accepted, even when the arm is disabled,
            # so the stop control never has a failure mode.
            self._json(200, {**arm_stop(), "arm": arm_status()})
            return
        if path == "/v1/station/drive/stop":
            if not self._require_empty_body():
                self._json(400, {"ok": False, "error": "BOARD_AGENT_BODY_NOT_ALLOWED"})
                return
            # Emergency stop is always accepted — even when drive is disabled
            # — so the UI stop button never has a failure mode.
            drive_stop("operator-emergency-stop")
            policy_stop("operator-emergency-stop")
            self._json(200, {"ok": True, "drive": drive_status(),
                             "note": "zero-speed frame published; chassis watchdog enforces rest"})
            return
        if path == "/v1/station/policy/stop":
            if not self._require_empty_body():
                self._json(400, {"ok": False, "error": "BOARD_AGENT_BODY_NOT_ALLOWED"})
                return
            # Same always-on stance as drive/stop: stopping is never refused.
            res = policy_stop("operator-stop")
            drive_stop("operator-stop")  # belt-and-braces zero the canary too
            self._json(200, {"ok": True, "stop": res, "policy": policy_status(),
                             "note": "policy output zeroed; chassis watchdog enforces rest"})
            return
        if path == "/v1/station/policy/load":
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
                return
            res = policy_load(str(payload.get("path", "")))
            self._json(200 if res.get("ok") else 409,
                       {**res, "policy": policy_status()})
            return
        if path == "/v1/station/policy-infer":
            # Batch inference for multi-instance clients (e.g. a browser sim
            # driving N ducks over one board). Pure compute: nothing here
            # touches actuators, so the motion switches do not gate it — the
            # runtime must simply have a loaded, ready model, and every
            # row/action is validated fail-closed by the runtime itself.
            payload = self._read_json()
            if not isinstance(payload, dict) or not isinstance(payload.get("observations"), list):
                self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
                return
            observations = payload["observations"]
            if not observations or not isinstance(observations[0], list):
                self._json(400, {"ok": False, "error": "observations-not-2d"})
                return
            res = _policy_send("infer_batch", observations=observations)
            if not res.get("ok"):
                self._json(409, {"ok": False, "error": res.get("error") or "policy-infer-failed",
                                 "detail": res.get("detail"), "state": res.get("state")})
                return
            last = res.get("lastOp") or {}
            self._json(200, {"ok": True, "actions": last.get("actions"),
                             "count": last.get("count"), "path": last.get("batchPath"),
                             "elapsedMs": last.get("elapsedMs"), "mock": False})
            return
        if path == "/v1/station/policy/start":
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
                return
            res = policy_start(payload.get("direction", 0.0), payload.get("goalX"), payload.get("goalY"))
            self._json(200 if res.get("ok") else 409,
                       {**res, "policy": policy_status()})
            return
        if path == "/v1/station/policy/reset":
            if not self._require_empty_body():
                self._json(400, {"ok": False, "error": "BOARD_AGENT_BODY_NOT_ALLOWED"})
                return
            res = _policy_send("reset") if _policy_runtime_alive() else {"ok": True,
                                                                         "state": None}
            self._json(200 if res.get("ok") else 409, {"ok": res.get("ok", True),
                                                        "policy": policy_status()})
            return
        if path == "/v1/station/policy/upload":
            # Bounded body (a whole base64'd ONNX), token-gated, and verified
            # against the declared SHA-256 before any byte touches the pinned
            # policies dir. Over size ceiling → reject without reading.
            length = self._content_length(MAX_POLICY_BODY_BYTES)
            if length is None:
                self._json(413, {"ok": False, "error": "policy-upload-too-large"})
                return
            try:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    self.close_connection = True
                    raise ValueError("short request body")
                payload = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
                return
            if not isinstance(payload, dict):
                self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
                return
            res = policy_stage(
                payload.get("bytesBase64"),
                payload.get("filename"),
                payload.get("sha256"),
            )
            self._json(200 if res.get("ok") else 409, {**res, "policies": policy_list().get("policies", [])})
            return
        if path == "/v1/config":
            # Switch writes are only meaningful through this same token-gated
            # surface; the restart that applies them is refused mid-motion.
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
                return
            result = _config_apply(payload.get("switches") if isinstance(payload.get("switches"), dict) else payload)
            self._json(200 if result.get("ok") else 409, result)
            return
        if not self._require_empty_body():
            self._json(400, {"ok": False, "error": "BOARD_AGENT_BODY_NOT_ALLOWED"})
            return
        self._json(404, {"ok": False, "error": "BOARD_AGENT_NOT_FOUND"})

    def _station_drive(self):
        payload = self._read_json()
        if not isinstance(payload, dict):
            self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
            return
        ok, reason = drive_command(
            payload.get("linear", 0.0),
            payload.get("angular", 0.0),
            payload.get("durationSec", 1.0),
        )
        if not ok:
            # 409 keeps a disabled drive honest: the capability is off, the
            # robot never moved, and the client can render why.
            self._json(409, {
                "ok": False,
                "error": "BOARD_AGENT_DRIVE_REFUSED",
                "reason": reason,
                "drive": drive_status(),
            })
            return
        self._json(200, {"ok": True, "drive": drive_status()})

    def _read_json(self):
        length = self._content_length(MAX_BODY_BYTES)
        if length is None:
            return None
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                self.close_connection = True
                return None
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                self.close_connection = True
                return None
            return payload
        except (ValueError, UnicodeDecodeError):
            self.close_connection = True
            return None

    def _read_json_bounded(self, ceiling):
        length = self._content_length(ceiling)
        if length is None:
            return None
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                self.close_connection = True
                return None
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                self.close_connection = True
                return None
            return payload
        except (ValueError, UnicodeDecodeError):
            self.close_connection = True
            return None

    def _station_command(self):
        payload = self._read_json()
        if not isinstance(payload, dict):
            self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
            return
        command_id = str(payload.get("id", "")).strip()
        if command_id not in COMMAND_IDS:
            self._json(403, {
                "ok": False,
                "error": "BOARD_AGENT_READ_ONLY",
                "message": "unknown station command; only the allowlisted read-only commands are accepted",
                "commands": [{"id": c["id"], "label": c["label"]} for c in STATION_COMMANDS],
            })
            return
        result = build_command_result(command_id)
        self._json(200, result)

    def _device_commands(self, device_id):
        payload = self._read_json()
        if not isinstance(payload, dict):
            self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_JSON"})
            return
        commands = payload.get("commands")
        if not isinstance(commands, list) or not commands or len(commands) > 8:
            self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_COMMANDS"})
            return
        if any(not isinstance(c, str) or len(c) > 16000 for c in commands):
            self._json(400, {"ok": False, "error": "BOARD_AGENT_INVALID_COMMANDS"})
            return
        # The agent only understands the fixed read-only preflight probe. It
        # never passes a caller string to a shell or a board interface.
        if len(commands) != 1 or commands[0] != PREFLIGHT_COMMAND:
            self._json(403, {
                "ok": False,
                "error": "BOARD_AGENT_READ_ONLY",
                "message": "this agent only accepts the fixed read-only preflight command",
            })
            return
        self._json(200, {
            "ok": True,
            "device": {
                "id": device_id,
                "kind": _adapter_profile.get("board", {}).get("family", "rdk-x5"),
                "boardPlatform": _adapter_profile.get("board", {}).get("platform", _identity["platform"]),
                "boardModel": _identity["model"],
                "boardOsVersion": _identity["os"],
            },
            "output": build_preflight_output(),
            "exitCode": 0,
            "mock": False,
            "actuatorControl": False,
        })

    # -- streaming routes ---------------------------------------------------

    def _stream_ndjson(self):
        if not self._acquire_stream_slot():
            self._json(503, {
                "ok": False,
                "error": "BOARD_AGENT_STREAM_BUSY",
                "message": f"station streams support at most {MAX_STREAM_CLIENTS} concurrent clients",
            })
            return
        self.send_response(200)
        self.send_header("content-type", "application/x-ndjson; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("connection", "close")
        self.end_headers()
        try:
            while True:
                snapshot = json.dumps(build_status()) + "\n"
                self.wfile.write(snapshot.encode("utf-8"))
                self.wfile.flush()
                time.sleep(STATUS_INTERVAL_MS / 1000.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self._release_stream_slot()

    def _camera_snapshot(self):
        """Return one real JPEG frame for transports that cannot carry MJPEG.

        Studio Local Bridge exec is a request/response channel, so the
        platform's bridge adapter polls this endpoint and rebuilds the same
        multipart stream for the browser. No synthetic frame is substituted.
        """
        devices = find_camera_device()
        if not devices or not CV2_AVAILABLE:
            self._json(503, {
                "ok": False,
                "error": "CAMERA_UNAVAILABLE",
                "message": "no camera device is connected to this board; the agent never substitutes synthetic frames",
                "devices": devices,
                "cv2": CV2_AVAILABLE,
            })
            return
        cap = CAMERA.open()
        if cap is None:
            self._json(503, {
                "ok": False,
                "error": "CAMERA_UNAVAILABLE",
                "message": "camera device present but could not be opened",
                "devices": devices,
            })
            return
        try:
            import cv2
            ok, frame = cap.read()
            if not ok:
                self._json(503, {"ok": False, "error": "CAMERA_FRAME_UNAVAILABLE", "devices": devices})
                return
            ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            if not ok:
                self._json(503, {"ok": False, "error": "CAMERA_FRAME_UNAVAILABLE", "devices": devices})
                return
            data = encoded.tobytes()
            self.send_response(200)
            self.send_header("content-type", "image/jpeg")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.send_header("x-board-camera", "real-device")
            self.end_headers()
            self.wfile.write(data)
        finally:
            cap.release()

    def _stream_camera(self):
        devices = find_camera_device()
        if not devices or not CV2_AVAILABLE:
            self._json(503, {
                "ok": False,
                "error": "CAMERA_UNAVAILABLE",
                "message": "no camera device is connected to this board; the agent never substitutes synthetic frames",
                "devices": devices,
                "cv2": CV2_AVAILABLE,
            })
            return
        if not self._acquire_stream_slot():
            self._json(503, {
                "ok": False,
                "error": "BOARD_AGENT_STREAM_BUSY",
                "message": f"station streams support at most {MAX_STREAM_CLIENTS} concurrent clients",
            })
            return
        cap = CAMERA.open()
        if cap is None:
            self._release_stream_slot()
            self._json(503, {
                "ok": False,
                "error": "CAMERA_UNAVAILABLE",
                "message": "camera device present but could not be opened",
                "devices": devices,
            })
            return
        import cv2

        self.send_response(200)
        self.send_header("content-type", f"multipart/x-mixed-replace; boundary={BOUNDARY}")
        self.send_header("cache-control", "no-store")
        self.send_header("x-board-camera", "real-device")
        self.send_header("connection", "close")
        self.end_headers()
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    time.sleep(0.5)
                    continue
                ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                if not ok:
                    continue
                data = encoded.tobytes()
                header = (
                    f"--{BOUNDARY}\r\ncontent-type: image/jpeg\r\n"
                    f"content-length: {len(data)}\r\n\r\n"
                ).encode("ascii")
                self.wfile.write(header + data + b"\r\n")
                self.wfile.flush()
                time.sleep(CAMERA_INTERVAL_MS / 1000.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            cap.release()
            self._release_stream_slot()

    # -- shared stream budget ------------------------------------------------

    _stream_lock = threading.Lock()
    _stream_clients = 0

    def _acquire_stream_slot(self):
        with Handler._stream_lock:
            if Handler._stream_clients >= MAX_STREAM_CLIENTS:
                return False
            Handler._stream_clients += 1
            return True

    def _release_stream_slot(self):
        with Handler._stream_lock:
            Handler._stream_clients = max(0, Handler._stream_clients - 1)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True

    def _terminate(_sig, _frm):
        # systemd's stop sends SIGTERM to every process in the cgroup. Do not
        # wait on children here — the policy runtime zeroes its own outputs on
        # SIGTERM, and any synchronous wait (policy_stop's ack, DDS teardown)
        # burns the unit's stop budget before os._exit can run.
        for child in (_policy_proc, _telemetry_proc, _drive_proc):
            if child is not None and child.poll() is None:
                try:
                    child.terminate()
                except OSError:
                    pass
        try:
            server.server_close()
        except OSError:
            pass
        os._exit(0)

    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGINT, _terminate)
    _start_ob_sampler()
    _start_ros_topics_sampler()
    _start_drive_watchdog()
    if DRIVE_ENABLED:
        # Warm the drive publisher up front: the rclpy import + DDS discovery
        # takes ~1-3 s, and doing it at boot means the first motion command
        # after enabling the switch executes immediately instead of paying
        # the handshake inside its request.
        threading.Thread(target=_start_drive_publisher, daemon=True).start()
    print(f"[board-agent] real-data BoardAgent listening on http://{HOST}:{PORT}")
    print(f"[board-agent] board: {_identity['model']} / {_identity['os']} / rdk {_identity['rdkVersion']}")
    print(f"[board-agent] auth: {'token' if TOKEN else 'open (loopback only)'}; "
        f"actuatorControl={'true' if MOTION_SWITCH_ENABLED else 'false'}; mock=false; "
          f"policyRuntime={'true' if POLICY_ENABLED else 'false'}")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        policy_stop("agent-shutdown")
        if _telemetry_proc is not None and _telemetry_proc.poll() is None:
            try:
                _telemetry_proc.terminate()
            except OSError:
                pass
        if DRIVE_ENABLED:
            drive_stop("agent-shutdown")


if __name__ == "__main__":
    main()
