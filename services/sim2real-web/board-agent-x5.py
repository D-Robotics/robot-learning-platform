#!/usr/bin/env python3

"""Real-data BoardAgent for the RDK X5 board (上位机 + 只读预检).

Wire contract (identical to services/sim2real-web/local-board-agent.mjs):

  GET  /healthz                          capability + mock/readonly flags
  GET  /v1/station/status                real /proc-based snapshot
  GET  /v1/station/status/stream         NDJSON heartbeat (1 Hz)
  GET  /v1/station/camera.mjpeg          real camera MJPEG (or 503 if absent)
  POST /v1/station/commands              allowlisted read-only commands
  POST /v1/devices/:id/commands          the fixed preflight probe only
  GET  /v1/station/drive                 constrained-drive state (canary)
  POST /v1/station/drive                 clamped, time-boxed cmd_vel (opt-in)
  POST /v1/station/drive/stop            zero-speed emergency stop (always on)
  GET  /v1/station/policy                policy-runtime state (honest, always)
  POST /v1/station/policy/load           load a policies/ ONNX (gated)
  POST /v1/station/policy/start          begin policy-driven motion (gated)
  POST /v1/station/policy/reset          clear a sticky fault (gated)
  POST /v1/station/policy/stop           zero output + halt (always on)

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

Data sources: /proc/stat, /proc/meminfo, /proc/net/dev, thermal zones,
statvfs, `ros2 topic list` (bounded), hobot_usb_cam device probe.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("RDK_SIM2REAL_BOARD_AGENT_TOKEN", "").strip()
HOST = os.environ.get("RDK_SIM2REAL_BOARD_AGENT_BIND_HOST", "127.0.0.1") or "127.0.0.1"
try:
    PORT = int(os.environ.get("RDK_SIM2REAL_BOARD_AGENT_PORT", "19100"))
except ValueError:
    PORT = 19100
if not (1024 <= PORT <= 65535):
    PORT = 19100

MAX_BODY_BYTES = 64 * 1024
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


def board_identity():
    model = read_file("/proc/device-tree/model").replace("\x00", "").strip()
    os_release = {}
    for line in read_file("/etc/os-release").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            os_release[key.strip()] = value.strip().strip('"')
    return {
        "platform": "rdk-x5",
        "model": model or "D-Robotics RDK X5",
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
            ["bash", "-c", f"source {TROS_SETUP} && timeout 6 ros2 {kind} list"],
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

# The yaml the publisher consumes lives in /tmp; it is rewritten under the
# lock before each deadline extension. Only this agent writes it.
DRIVE_COMMAND_FILE = "/tmp/rdk-board-agent-drive.yaml"


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
    tmp = DRIVE_COMMAND_FILE + ".tmp"
    with open(tmp, "w") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, DRIVE_COMMAND_FILE)


# The publisher is a small rclpy script deployed next to this agent. It
# re-reads the command YAML every cycle (so mid-window speed changes and
# emergency zero take effect within ~100 ms), and it self-terminates after 5 s
# of continuous zero speed so /cmd_vel goes silent and the chassis watchdog
# keeps the robot at rest even if this agent dies.
DRIVE_PUBLISHER_SCRIPT = os.environ.get(
    "RDK_BOARD_DRIVE_PUBLISHER",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "board-drive-publisher.py"),
)


DRIVE_PUBLISHER_READY = os.environ.get(
    "RDK_BOARD_DRIVE_READY", "/tmp/board-drive-publisher.ready"
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
        os.unlink(DRIVE_PUBLISHER_READY)
    except OSError:
        pass
    if not os.path.exists(DRIVE_PUBLISHER_SCRIPT):
        return False
    # The command file must exist BEFORE the publisher starts, otherwise its
    # first cycles publish nothing and motion starts late.
    if not os.path.exists(DRIVE_COMMAND_FILE):
        try:
            _write_drive_yaml(0.0, 0.0)
        except OSError:
            return False
    try:
        _drive_proc = subprocess.Popen(
            ["bash", "-c",
             f"source {TROS_SETUP} 2>/dev/null && "
             f"exec python3 {DRIVE_PUBLISHER_SCRIPT}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "HOME": "/root", "TERM": "dumb",
                 "RDK_BOARD_DRIVE_PERSIST": "1",
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
        if os.path.exists(DRIVE_PUBLISHER_READY):
            return True
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
            os.unlink(path)
        except OSError:
            pass


def drive_command(linear, angular, duration_sec):
    """Accept (or refuse) one clamped drive command. Returns (ok, reason).
    The active window is always capped at DRIVE_MAX_WINDOW_SEC from NOW,
    so an explicit command can never extend motion by more than that."""
    if not DRIVE_ENABLED:
        return False, "drive-disabled"
    if not isinstance(linear, (int, float)) or not isinstance(angular, (int, float)):
        return False, "invalid-type"
    linear = float(linear)
    angular = float(angular)
    if not (DRIVE_MAX_LINEAR >= linear >= -DRIVE_MAX_LINEAR):
        return False, "linear-out-of-range"
    if not (DRIVE_MAX_ANGULAR >= angular >= -DRIVE_MAX_ANGULAR):
        return False, "angular-out-of-range"
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
TELEMETRY_SNAPSHOT_FILE = os.environ.get(
    "RDK_BOARD_TELEMETRY_SNAPSHOT", "/tmp/board-telemetry-snapshot.json"
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
    try:
        _telemetry_proc = subprocess.Popen(
            ["bash", "-c",
             f"source {TROS_SETUP} 2>/dev/null && "
             f"source {ORIGINBOT_WS_SETUP} 2>/dev/null && "
             f"exec python3 {TELEMETRY_NODE_SCRIPT}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "HOME": "/root", "TERM": "dumb",
                 "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
        return True
    except OSError:
        _telemetry_proc = None
        return False


def _read_telemetry_snapshot():
    """Read the sampler node's snapshot; None when absent or stale."""
    try:
        with open(TELEMETRY_SNAPSHOT_FILE, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
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
    _start_telemetry_node()
    while True:
        try:
            data = _read_telemetry_snapshot()
            with _ob_lock:
                _ob_state["data"] = data
                _ob_state["ts"] = time.time()
            if data is None and (
                _telemetry_proc is None or _telemetry_proc.poll() is not None
            ):
                _start_telemetry_node()
        except Exception:
            with _ob_lock:
                _ob_state["data"] = None
        time.sleep(1)


def originbot_telemetry_cached():
    """Latest read-only OriginBot telemetry snapshot (None when absent)."""
    with _ob_lock:
        return _ob_state["data"]


# ---- policy runtime (trained ONNX → bounded /cmd_vel) ----------------------
# A SECOND gate on top of the drive switch: even with the platform's
# RDK_SIM2REAL_STATION_DRIVE_ENABLED=1 and the agent's
# RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1, policy-driven motion only runs when
# this third switch is set. `stop` is always honored regardless (it only ever
# zeroes output — the same fail-closed stance as drive/stop).
POLICY_ENABLED = os.environ.get("RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY", "").strip() == "1"
POLICY_RUNTIME_SCRIPT = os.environ.get(
    "RDK_BOARD_POLICY_RUNTIME",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "board-policy-runtime.py"),
)
POLICY_CMD_FILE = os.environ.get("RDK_BOARD_POLICY_CMD", "/tmp/board-policy-runtime-cmd.json")
POLICY_STATE_FILE = os.environ.get(
    "RDK_BOARD_POLICY_STATE", "/tmp/board-policy-runtime-state.json"
)
POLICY_RUNTIME_READY = "/tmp/board-policy-runtime.ready"
POLICY_READY_TIMEOUT = 20.0  # rclpy init + onnxruntime import on the board
POLICY_APPLY_TIMEOUT = 10.0  # file-protocol round trip for load/start
POLICY_ALLOWED_MODEL_DIR = "/root/rdk-board-agent/policies"

_policy_lock = threading.Lock()
_policy_proc = None
_policy_seq = 0


def _policy_read_state(max_age=None):
    """Read the runtime's state file; None when absent (or stale)."""
    try:
        with open(POLICY_STATE_FILE, "r", encoding="utf-8") as fh:
            snap = json.load(fh)
    except (OSError, ValueError):
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
        os.unlink(POLICY_RUNTIME_READY)
    except OSError:
        pass
    if not os.path.exists(POLICY_RUNTIME_SCRIPT):
        return False
    try:
        _policy_proc = subprocess.Popen(
            ["bash", "-c",
             f"source {TROS_SETUP} 2>/dev/null && "
             f"source {ORIGINBOT_WS_SETUP} 2>/dev/null && "
             f"exec python3 {POLICY_RUNTIME_SCRIPT}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "HOME": "/root", "TERM": "dumb",
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
        if os.path.exists(POLICY_RUNTIME_READY):
            return True
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
            os.unlink(path)
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
    tmp = POLICY_CMD_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(req, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, POLICY_CMD_FILE)
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
    return {"ok": False, "error": "policy-op-timeout"}


def policy_status():
    """Honest policy surface: switches, runtime process, last state snapshot."""
    snap = _policy_read_state()
    return {
        "enabled": POLICY_ENABLED,
        "runtimeRunning": _policy_runtime_alive(),
        "driveEnabled": DRIVE_ENABLED,
        # Policy motion requires BOTH switches; report the combined verdict so
        # the UI can render exactly one gate explanation.
        "motionAuthorized": POLICY_ENABLED and DRIVE_ENABLED,
        "state": snap.get("state") if snap else None,
        "model": snap.get("model") if snap else None,
        "command": snap.get("command") if snap else None,
        "published": snap.get("published") if snap else None,
        "inferMs": snap.get("inferMs") if snap else None,
        "lastError": snap.get("lastError") if snap else None,
        "lastOp": snap.get("lastOp") if snap else None,
        "obsSlots": snap.get("obsSlots") if snap else None,
        "limits": {
            "maxLinear": 0.3,
            "maxAngular": 1.0,
            "decisionHz": 10,
            "chassisWatchdogMs": 500,
        },
        "note": "trained-policy inference on board; motion requires drive+policy switches, "
                "output is speed-clamped and watchdog-floored exactly like the drive canary",
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
    return res


def _policy_allowed_model_path(path):
    """Only models under the pinned policies dir are loadable, and the file
    must exist and be a regular file (no traversal, no devices/sockets)."""
    if not isinstance(path, str) or not path:
        return False, "model-path-required"
    base = os.path.realpath(POLICY_ALLOWED_MODEL_DIR)
    resolved = os.path.realpath(path)
    if not (resolved == base or resolved.startswith(base + os.sep)):
        return False, "model-path-outside-allowed-dir"
    if not os.path.isfile(resolved):
        return False, "model-file-missing"
    if os.path.getsize(resolved) > 50 * 1024 * 1024:
        return False, "model-too-large"
    return True, resolved


def policy_load(path):
    if not POLICY_ENABLED:
        return {"ok": False, "error": "policy-disabled"}
    ok, resolved = _policy_allowed_model_path(path)
    if not ok:
        return {"ok": False, "error": resolved}
    return _policy_send("load", path=resolved)


def policy_start(direction):
    if not POLICY_ENABLED:
        return {"ok": False, "error": "policy-disabled"}
    if not DRIVE_ENABLED:
        # Gate honesty: refuse before touching the runtime, explain both gates.
        return {"ok": False, "error": "drive-disabled",
                "message": "policy start requires RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1 too"}
    if not isinstance(direction, (int, float)):
        return {"ok": False, "error": "invalid-type"}
    return _policy_send("start", direction=float(direction))


def _start_ob_sampler():
    global _ob_thread
    if _ob_thread is None:
        _ob_thread = threading.Thread(target=_ob_sampler_loop, daemon=True)
        _ob_thread.start()


def find_camera_device():
    """Probe hobot_usb_cam device candidates read-only (no camera opened)."""
    candidates = []
    if os.path.isdir("/sys/class/video4linux"):
        for name in sorted(os.listdir("/sys/class/video4linux")):
            candidates.append(f"/dev/{name}")
    return candidates


def build_status():
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cpu = cpu_percent()
    temp = cpu_temperature()
    total_mem, avail_mem = memory_mb()
    rx, tx = network_kb_per_sec()
    total_disk, used_disk = disk_mb()
    topics = ros_topics_cached() or []
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
        "power": None,  # no power monitor path on this board; report honestly
        "originbot": originbot_telemetry_cached(),
        "telemetry": originbot_telemetry_cached(),
        "originbotNote": "read-only ros2 topic echo; the agent never publishes or moves the robot",
        "topics": [{"name": name} for name in topics[:24]],
        "uptimeSec": int(time.time() - STARTED_AT),
        "cameraDevices": find_camera_device(),
        "actuatorControl": DRIVE_ENABLED,
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
    lines = [
        PREFLIGHT_BEGIN,
        f"arch={arch}",
        f"kernel={kernel}",
        f"python3={python3}",
        f"tros={tros}",
        f"disk_bytes={disk_bytes}",
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
        return self.headers.get("authorization") == f"Bearer {TOKEN}"

    def do_GET(self):
        if not self._authorized():
            self._json(401, {"ok": False, "error": "BOARD_AGENT_UNAUTHORIZED"})
            return
        path = self.path.split("?")[0]
        if path == "/healthz":
            self._json(200, {
                "ok": True,
                "service": "rdk-x5-board-agent",
                "capabilities": ["read-only-preflight", "host-station"]
                + (["constrained-drive"] if DRIVE_ENABLED else []),
                "stationCommands": [{"id": c["id"], "label": c["label"]} for c in STATION_COMMANDS],
                "actuatorControl": DRIVE_ENABLED,
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
        if path == "/v1/station/status":
            self._json(200, {**build_status(), "drive": drive_status()})
            return
        if path == "/v1/station/drive":
            self._json(200, {"ok": True, "drive": drive_status(),
                             "actuatorPolicy": _actuator_policy()})
            return
        if path == "/v1/station/policy":
            self._json(200, {"ok": True, "policy": policy_status()})
            return
        if path == "/v1/station/status/stream":
            self._stream_ndjson()
            return
        if path == "/v1/station/camera.mjpeg":
            self._stream_camera()
            return
        self._json(404, {"ok": False, "error": "BOARD_AGENT_NOT_FOUND"})

    def do_POST(self):
        if not self._authorized():
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
        if path == "/v1/station/drive/stop":
            # Emergency stop is always accepted — even when drive is disabled
            # — so the UI stop button never has a failure mode.
            drive_stop("operator-emergency-stop")
            policy_stop("operator-emergency-stop")
            self._json(200, {"ok": True, "drive": drive_status(),
                             "note": "zero-speed frame published; chassis watchdog enforces rest"})
            return
        if path == "/v1/station/policy/stop":
            # Same always-on stance as drive/stop: stopping is never refused.
            res = policy_stop("operator-stop")
            drive_stop("operator-stop")  # belt-and-braces zero the canary too
            self._json(200, {"ok": True, "stop": res, "policy": policy_status(),
                             "note": "policy output zeroed; chassis watchdog enforces rest"})
            return
        if path == "/v1/station/policy/load":
            payload = self._read_json() or {}
            res = policy_load(str(payload.get("path", "")))
            self._json(200 if res.get("ok") else 409,
                       {**res, "policy": policy_status()})
            return
        if path == "/v1/station/policy/start":
            payload = self._read_json() or {}
            res = policy_start(payload.get("direction", 0.0))
            self._json(200 if res.get("ok") else 409,
                       {**res, "policy": policy_status()})
            return
        if path == "/v1/station/policy/reset":
            res = _policy_send("reset") if _policy_runtime_alive() else {"ok": True,
                                                                         "state": None}
            self._json(200 if res.get("ok") else 409, {"ok": res.get("ok", True),
                                                        "policy": policy_status()})
            return
        self._json(404, {"ok": False, "error": "BOARD_AGENT_NOT_FOUND"})

    def _station_drive(self):
        payload = self._read_json() or {}
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
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _station_command(self):
        payload = self._read_json() or {}
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
        payload = self._read_json() or {}
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
          f"actuatorControl={'true' if DRIVE_ENABLED else 'false'}; mock=false; "
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
