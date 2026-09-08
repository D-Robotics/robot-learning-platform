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
        self.create_subscription(Imu, "/imu", self._on_imu, sensor_qos)
        self.create_subscription(Odometry, "/odom", self._on_odom, sensor_qos)
        self._status_type = self._load_status_type()
        if self._status_type is not None:
            self.create_subscription(
                self._status_type, "/originbot_status", self._on_status, status_qos
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
        self._imu = {
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
        data = {}
        if self._imu and now - self._imu["ts"] <= STALE_SEC:
            data["imu"] = {k: self._imu[k] for k in ("x", "y", "z", "w")}
        if self._odom and now - self._odom["ts"] <= STALE_SEC:
            data["odom"] = {
                k: self._odom[k]
                for k in ("positionX", "positionY", "linearX", "angularZ")
            }
        if self._battery and now - self._battery["ts"] <= STALE_SEC:
            data["batteryVoltage"] = self._battery["voltage"]
        payload = {"ts": now, "data": data if data else None}
        tmp = SNAPSHOT_FILE + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
            os.replace(tmp, SNAPSHOT_FILE)
        except OSError:
            pass


def main():
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
