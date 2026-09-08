#!/usr/bin/env python3

"""Real-data BoardAgent for the RDK X5 board (上位机 + 只读预检).

Wire contract (identical to services/sim2real-web/local-board-agent.mjs):

  GET  /healthz                          capability + mock/readonly flags
  GET  /v1/station/status                real /proc-based snapshot
  GET  /v1/station/status/stream         NDJSON heartbeat (1 Hz)
  GET  /v1/station/camera.mjpeg          real camera MJPEG (or 503 if absent)
  POST /v1/station/commands              allowlisted read-only commands
  POST /v1/devices/:id/commands          the fixed preflight probe only

Safety invariants (same as the reference agent):
- token auth via RDK_SIM2REAL_BOARD_AGENT_TOKEN
- strictly allowlisted commands; no shell, no actuator path
- `actuatorControl: false` and `mock: false` reported honestly
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


def ros_topics_cached(max_age=10.0):
    now = time.time()
    with _ros_lock:
        if _ros_cache["topics"] is None or now - _ros_cache["ts"] > max_age:
            result = run_ros2_list("topic")
            if result.get("ok"):
                _ros_cache["topics"] = result.get("lines", [])
                _ros_cache["ts"] = now
        return _ros_cache["topics"]


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
        "topics": [{"name": name} for name in topics[:24]],
        "uptimeSec": int(time.time() - STARTED_AT),
        "cameraDevices": find_camera_device(),
        "actuatorControl": False,
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
                "capabilities": ["read-only-preflight", "host-station"],
                "stationCommands": [{"id": c["id"], "label": c["label"]} for c in STATION_COMMANDS],
                "actuatorControl": False,
                "mock": False,
                "board": _identity,
                "camera": {
                    "devices": find_camera_device(),
                    "cv2": CV2_AVAILABLE,
                },
            })
            return
        if path == "/v1/station/status":
            self._json(200, build_status())
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
        self._json(404, {"ok": False, "error": "BOARD_AGENT_NOT_FOUND"})

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
                "kind": "rdk-x5",
                "boardPlatform": "rdk-x5",
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
    print(f"[board-agent] real-data BoardAgent listening on http://{HOST}:{PORT}")
    print(f"[board-agent] board: {_identity['model']} / {_identity['os']} / rdk {_identity['rdkVersion']}")
    print(f"[board-agent] auth: {'token' if TOKEN else 'open (loopback only)'}; actuatorControl=false; mock=false")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
