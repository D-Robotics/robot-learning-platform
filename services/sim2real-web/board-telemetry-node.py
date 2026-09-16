#!/usr/bin/env python3
"""Persistent read-only OriginBot telemetry sampler for the RDK board agent.

Replaces the per-sample `ros2 topic echo --once` subprocesses (three Python
interpreters + DDS discovery every 2 s, ~80% of a core). This node subscribes
once and writes a small JSON snapshot at 10 Hz by default; the agent reads
that file.

Strictly read-only: subscriptions only, never publishes, never calls a
service, never moves the robot. Absence of the bringup stack is reported by
letting the snapshot go stale (the agent treats a stale file as None), so
telemetry appears when bringup starts and disappears when it stops.

Run inside the board's TROS + OriginBot workspace environment:
  python3 board-telemetry-node.py
"""

import json
import os
import sys
import time

# Keep the telemetry writer on the same private IPC contract as the agent and
# policy runtime.  The flat deployment layout means this helper is imported by
# path rather than as a package.
_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)
from board_ipc import atomic_write_json, ipc_path, secure_unlink

import rclpy
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import Imu

from board_camera_frame import declared_shape as declared_camera_shape
from board_camera_frame import frame_to_nhwc

SNAPSHOT_FILE = ipc_path(
    "RDK_BOARD_TELEMETRY_SNAPSHOT", "telemetry-snapshot.json"
)
# The policy watchdog is intentionally tight (normally 500 ms).  A 2 Hz
# writer can therefore publish a snapshot just as the previous sensor sample
# crosses that boundary, and a frozen IMU/odom value can look fresh merely
# because the wrapper file keeps changing.  Write often enough that the
# snapshot cadence is comfortably inside the policy budget; the payload is
# tiny and the atomic replace is bounded.
try:
    _snapshot_hz = float(os.environ.get("RDK_BOARD_TELEMETRY_HZ", "10"))
except (TypeError, ValueError):
    _snapshot_hz = 10.0
SNAPSHOT_HZ = max(1.0, min(50.0, _snapshot_hz)) if _snapshot_hz == _snapshot_hz else 10.0
STALE_SEC = 5.0  # snapshot older than this means "no fresh data"
ADAPTER_CONFIG_PATH = os.environ.get("RDK_SIM2REAL_ADAPTER_CONFIG", "").strip()

def _adapter_config():
    if not ADAPTER_CONFIG_PATH:
        return {}
    try:
        with open(ADAPTER_CONFIG_PATH, "r", encoding="utf-8") as fh:
            value = json.load(fh)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


_ADAPTER = _adapter_config()
ADAPTER_ID = str(_ADAPTER.get("id") or os.environ.get("RDK_SIM2REAL_ADAPTER_ID", "generic-differential-drive"))[:80]
_TOPICS = _ADAPTER.get("sensors") if isinstance(_ADAPTER.get("sensors"), dict) else None
if _TOPICS is None:
    ros = _ADAPTER.get("ros") if isinstance(_ADAPTER.get("ros"), dict) else {}
    _TOPICS = ros.get("topics") if isinstance(ros.get("topics"), dict) else {}


def _topic(name, default):
    value = _TOPICS.get(name) or {}
    if isinstance(value, dict):
        return str(value.get("topic") or value.get("name") or default)
    return default


IMU_TOPIC = os.environ.get("RDK_SIM2REAL_IMU_TOPIC", _topic("imu", "/imu"))
ODOM_TOPIC = os.environ.get("RDK_SIM2REAL_ODOM_TOPIC", _topic("odom", "/odom"))
BATTERY_TOPIC = os.environ.get("RDK_SIM2REAL_BATTERY_TOPIC", _topic("battery", "/originbot_status"))
# The camera topic is only subscribed when the adapter declares a frame shape.
# Without the declaration the sampler stays exactly as it was: a camera block in
# the snapshot is an input a vision policy will consume, so it must never appear
# unless the operator has stated which geometry the policy was trained for.
CAMERA_TOPIC = os.environ.get("RDK_SIM2REAL_CAMERA_TOPIC", _topic("camera", "/camera/image_raw"))
CAMERA_SHAPE = declared_camera_shape()


class TelemetryNode(Node):
    def __init__(self):
        super().__init__("rdk_board_telemetry_sampler")
        # Sensor topics are best-effort streams; RELIABLE would also work but
        # adds retransmission noise for data that is refreshed anyway.
        # Sensor streams (imu/odom) publish BEST_EFFORT; a BEST_EFFORT
        # subscription matches. /originbot_status publishes RELIABLE from
        # originbot_base, and RELIABLE pub + BEST_EFFORT sub proved flaky on
        # this stack, so match it exactly with a RELIABLE subscription.
        sensor_qos = QoSProfile(depth=5, reliability=ReliabilityPolicy.BEST_EFFORT)
        status_qos = QoSProfile(depth=5, reliability=ReliabilityPolicy.RELIABLE)
        self._imu = None
        self._odom = None
        self._battery = None
        self._camera = None
        self._camera_dropped = 0
        self._seq = 0
        self.create_subscription(Imu, IMU_TOPIC, self._on_imu, sensor_qos)
        self.create_subscription(Odometry, ODOM_TOPIC, self._on_odom, sensor_qos)
        self._status_type = self._load_status_type()
        if self._status_type is not None:
            self.create_subscription(
                self._status_type, BATTERY_TOPIC, self._on_status, status_qos
            )
        self._load_camera_type()
        self.create_timer(1.0 / SNAPSHOT_HZ, self._write_snapshot)

    def _load_camera_type(self):
        """Subscribe to the camera only when a frame shape is declared.

        Lazily imported and wrapped: a board without sensor_msgs.image, without
        the camera bringup, or with a malformed topic name must keep sampling
        IMU/odom/battery rather than dying at startup. The snapshot then simply
        has no camera block, which the policy runtime treats as fail-closed.
        """
        if CAMERA_SHAPE is None:
            return
        try:
            from sensor_msgs.msg import Image
        except ImportError:
            print(
                "camera declared but sensor_msgs.msg.Image is unavailable; "
                "sampling without a camera block",
                file=sys.stderr,
                flush=True,
            )
            return
        try:
            self.create_subscription(Image, CAMERA_TOPIC, self._on_image, sensor_qos)
        except Exception as exc:  # noqa: BLE001 - never let this stop the sampler
            print(f"camera subscription failed: {exc!r}", file=sys.stderr, flush=True)

    @staticmethod
    def _load_status_type():
        # Import lazily so the node still runs (minus battery telemetry) when
        # the OriginBot workspace is not sourced.
        try:
            from originbot_msgs.msg import OriginbotStatus

            return OriginbotStatus
        except ImportError:
            return None

    def _on_image(self, msg):
        """Convert one camera frame to the declared shape, or drop it.

        A dropped frame is counted and never emitted: the policy runtime rejects
        a frame whose length or channel count does not match the declaration, so
        emitting a malformed one would only move the failure to the control loop.
        """
        channels, height, width = CAMERA_SHAPE
        frame = frame_to_nhwc(
            encoding=getattr(msg, "encoding", ""),
            width=getattr(msg, "width", 0),
            height=getattr(msg, "height", 0),
            step=getattr(msg, "step", 0),
            data=getattr(msg, "data", b""),
            channels=channels,
            out_height=height,
            out_width=width,
        )
        if frame is None:
            self._camera_dropped += 1
            return
        self._camera = {
            "channels": channels,
            "height": height,
            "width": width,
            "encoding": str(getattr(msg, "encoding", ""))[:16],
            # Quantised to the integer pixel values the sensor actually
            # produced. The snapshot is rewritten at SNAPSHOT_HZ and a float
            # list would roughly double its size for no extra information.
            "data": [int(round(value)) for value in frame],
            "ts": time.time(),
            "monotonicNs": time.monotonic_ns(),
        }

    def _on_imu(self, msg):
        q = msg.orientation
        a = getattr(msg, "angular_velocity", None)
        accel = getattr(msg, "linear_acceleration", None)
        if a is None:
            a = type("Vec", (), {"x": 0.0, "y": 0.0, "z": 0.0})()
        if accel is None:
            accel = type("Vec", (), {"x": 0.0, "y": 0.0, "z": 0.0})()
        self._imu = {
            # Keep the nested names stable with board-policy-runtime.py.
            # Older consumers can still read the quaternion fields directly.
            "quaternion": {"x": q.x, "y": q.y, "z": q.z, "w": q.w},
            "gyro": {"x": a.x, "y": a.y, "z": a.z},
            "linearAcceleration": {"x": accel.x, "y": accel.y, "z": accel.z},
            "x": q.x,
            "y": q.y,
            "z": q.z,
            "w": q.w,
            "ts": time.time(),
            "monotonicNs": time.monotonic_ns(),
        }

    def _on_odom(self, msg):
        pose = msg.pose.pose
        twist = msg.twist.twist
        self._odom = {
            "positionX": pose.position.x,
            "positionY": pose.position.y,
            "linearX": twist.linear.x,
            "angularZ": twist.angular.z,
            "ts": time.time(),
            "monotonicNs": time.monotonic_ns(),
        }

    def _on_status(self, msg):
        voltage = getattr(msg, "battery_voltage", None)
        self._battery = (
            {"voltage": round(float(voltage), 2), "ts": time.time()}
            if voltage is not None
            else None
        )

    def _write_snapshot(self):
        now = time.time()
        self._seq += 1
        data = {}
        if self._imu and now - self._imu["ts"] <= STALE_SEC:
            data["imu"] = {
                "quaternion": dict(self._imu["quaternion"]),
                "gyro": dict(self._imu["gyro"]),
                "linearAcceleration": dict(self._imu["linearAcceleration"]),
                # These are the source sample times, rather than the file
                # write time.  Consumers that drive actuators must validate
                # them; otherwise a healthy writer can mask a stalled topic.
                "sampleTs": float(self._imu["ts"]),
                "sampleMonotonicNs": int(self._imu["monotonicNs"]),
            }
        if self._odom and now - self._odom["ts"] <= STALE_SEC:
            data["odom"] = {
                k: self._odom[k]
                for k in ("positionX", "positionY", "linearX", "angularZ")
            }
            data["odom"]["sampleTs"] = float(self._odom["ts"])
            data["odom"]["sampleMonotonicNs"] = int(self._odom["monotonicNs"])
        if self._battery and now - self._battery["ts"] <= STALE_SEC:
            data["batteryVoltage"] = self._battery["voltage"]
        if self._camera and now - self._camera["ts"] <= STALE_SEC:
            # Shape and channel count travel with the frame so the consumer can
            # verify them instead of trusting the producer. frame_to_nhwc
            # already guarantees the length, so a block that reaches here is
            # internally consistent by construction.
            data["camera"] = {
                "channels": self._camera["channels"],
                "height": self._camera["height"],
                "width": self._camera["width"],
                "encoding": self._camera["encoding"],
                "data": list(self._camera["data"]),
                # Source sample time, matching the imu/odom contract: a healthy
                # writer must not be able to mask a frozen camera topic.
                "sampleTs": float(self._camera["ts"]),
                "sampleMonotonicNs": int(self._camera["monotonicNs"]),
            }
        payload = {
            "ts": now,
            "sourceWallTimeMs": int(now * 1000),
            "sourceMonotonicNs": time.monotonic_ns(),
            "seq": self._seq,
            "adapterId": ADAPTER_ID,
            "topics": {"imu": IMU_TOPIC, "odom": ODOM_TOPIC, "battery": BATTERY_TOPIC},
            "data": data if data else None,
        }
        if CAMERA_SHAPE is not None:
            # Report the camera wiring even when no frame is currently arriving,
            # so a missing block can be told apart from an unconfigured camera.
            payload["topics"]["camera"] = CAMERA_TOPIC
            payload["cameraShape"] = list(CAMERA_SHAPE)
            payload["cameraDropped"] = self._camera_dropped
        try:
            atomic_write_json(SNAPSHOT_FILE, payload)
        except Exception as exc:  # keep the sampler alive and make failures observable
            print(f"telemetry snapshot write failed: {exc!r}", file=sys.stderr, flush=True)


def _pick_ros_log_dir():
    # Under the board systemd unit (ProtectHome=true, ProtectSystem=strict)
    # the default /root/.ros/log cannot be created and rclpy.init() aborts
    # before any subscription is registered, so the agent sees a permanently
    # stale snapshot. Point ROS logging at a writable path instead.
    for cand in ("/var/lib/rdk-board-agent/roslogs", "/tmp/roslogs"):
        try:
            os.makedirs(cand, exist_ok=True)
            os.environ["ROS_LOG_DIR"] = cand
            return
        except OSError:
            continue


def main():
    _pick_ros_log_dir()
    rclpy.init()
    node = TelemetryNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            node.destroy_node()
            rclpy.shutdown()
        except Exception:
            pass
        try:
            secure_unlink(SNAPSHOT_FILE)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
