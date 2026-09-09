#!/usr/bin/env python3
"""Persistent read-only OriginBot telemetry sampler for the RDK board agent.

Replaces the per-sample `ros2 topic echo --once` subprocesses (three Python
interpreters + DDS discovery every 2 s, ~80% of a core). This node subscribes
once and writes a small JSON snapshot at 2 Hz; the agent reads that file.

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

import rclpy
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import Imu

SNAPSHOT_FILE = os.environ.get(
    "RDK_BOARD_TELEMETRY_SNAPSHOT", "/tmp/board-telemetry-snapshot.json"
)
SNAPSHOT_HZ = float(os.environ.get("RDK_BOARD_TELEMETRY_HZ", "2"))
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
        self._seq = 0
        self.create_subscription(Imu, IMU_TOPIC, self._on_imu, sensor_qos)
        self.create_subscription(Odometry, ODOM_TOPIC, self._on_odom, sensor_qos)
        self._status_type = self._load_status_type()
        if self._status_type is not None:
            self.create_subscription(
                self._status_type, BATTERY_TOPIC, self._on_status, status_qos
            )
        self.create_timer(1.0 / SNAPSHOT_HZ, self._write_snapshot)

    @staticmethod
    def _load_status_type():
        # Import lazily so the node still runs (minus battery telemetry) when
        # the OriginBot workspace is not sourced.
        try:
            from originbot_msgs.msg import OriginbotStatus

            return OriginbotStatus
        except ImportError:
            return None

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
            }
        if self._odom and now - self._odom["ts"] <= STALE_SEC:
            data["odom"] = {
                k: self._odom[k]
                for k in ("positionX", "positionY", "linearX", "angularZ")
            }
        if self._battery and now - self._battery["ts"] <= STALE_SEC:
            data["batteryVoltage"] = self._battery["voltage"]
        payload = {
            "ts": now,
            "sourceWallTimeMs": int(now * 1000),
            "sourceMonotonicNs": time.monotonic_ns(),
            "seq": self._seq,
            "adapterId": ADAPTER_ID,
            "topics": {"imu": IMU_TOPIC, "odom": ODOM_TOPIC, "battery": BATTERY_TOPIC},
            "data": data if data else None,
        }
        tmp = SNAPSHOT_FILE + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
            os.replace(tmp, SNAPSHOT_FILE)
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
            os.unlink(SNAPSHOT_FILE)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
