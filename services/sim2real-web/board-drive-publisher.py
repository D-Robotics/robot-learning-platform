#!/usr/bin/env python3
"""Persistent constrained-drive publisher for the RDK board agent.

The agent owns the motion window; this script owns the 10 Hz /cmd_vel stream.

Cold start is the trap this script exists to defuse: importing rclpy and
bringing up DDS takes ~2-3 s on the board, longer than the agent's 2 s motion
window. So this script only signals READY (marker file) after it has a live
publisher AND the chassis (/cmd_vel subscriber) is discovered. The agent waits
for that marker before writing speeds and opening the window, so a motion
window can never expire while the publisher is still importing.

Every cycle re-reads the YAML command file, so mid-window speed changes and
the emergency zero written by drive_stop() take effect within ~100 ms. After
five seconds of continuous zero it exits on its own, so /cmd_vel goes silent
and the chassis firmware watchdog (500 ms) keeps the robot at rest even if
the agent dies.

Run inside the board's TROS + OriginBot workspace environment:
  python3 board-drive-publisher.py
"""

import os
import sys
import time

import rclpy
import yaml
from geometry_msgs.msg import Twist

CMD_FILE = os.environ.get(
    "RDK_BOARD_DRIVE_CMD_FILE", "/tmp/rdk-board-agent-drive.yaml"
)
READY_FILE = os.environ.get(
    "RDK_BOARD_DRIVE_READY", "/tmp/board-drive-publisher.ready"
)
LOG_FILE = os.environ.get("RDK_BOARD_DRIVE_LOG", "/tmp/board-drive-publisher.log")
RATE_HZ = float(os.environ.get("RDK_BOARD_DRIVE_RATE_HZ", "10"))
IDLE_ZERO_SEC = float(os.environ.get("RDK_BOARD_DRIVE_IDLE_ZERO_SEC", "5"))
# When the board drive switch is on, the agent pre-warms this publisher at
# boot and owns teardown via its own watchdog (idle 5 s -> _stop_drive_publisher),
# so the in-script idle self-exit is disabled: it would kill the pre-warmed
# process and force the next command to pay the ~2-3 s rclpy cold start
# again. When the switch is off the agent never spawns this script at all,
# and a manually started copy still self-terminates as a safety floor.
PERSIST_WHILE_ENABLED = os.environ.get(
    "RDK_BOARD_DRIVE_PERSIST", ""
).strip() == "1"
READY_WAIT_SEC = 4.0  # max time to wait for the chassis subscription


def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(f"{time.time():.3f} pid={os.getpid()} {msg}\n")
    except OSError:
        pass


def read_cmd():
    try:
        with open(CMD_FILE, "r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    except (OSError, yaml.YAMLError) as exc:
        return 0.0, 0.0, f"read-failed: {exc!r}"
    linear = ((data.get("linear") or {}).get("x")) or 0.0
    angular = ((data.get("angular") or {}).get("z")) or 0.0
    try:
        return float(linear), float(angular), None
    except (TypeError, ValueError):
        return 0.0, 0.0, "cast-failed"


def main():
    log(f"start cmd_file={CMD_FILE} rate={RATE_HZ} cwd={os.getcwd()}")
    rclpy.init()
    node = rclpy.create_node("rdk_board_drive_publisher")
    pub = node.create_publisher(Twist, "/cmd_vel", 10)

    # Readiness handshake: only declare live once the chassis subscription is
    # discovered, so the agent never opens a motion window against a publisher
    # that cannot deliver.
    deadline = time.time() + READY_WAIT_SEC
    subscribers = 0
    while time.time() < deadline:
        subscribers = node.count_subscribers("/cmd_vel")
        if subscribers >= 1:
            break
        rclpy.spin_once(node, timeout_sec=0.2)
    if subscribers < 1:
        log(f"no /cmd_vel subscriber after {READY_WAIT_SEC}s; exiting")
        try:
            node.destroy_node()
            rclpy.shutdown()
        except Exception:
            pass
        return 3
    try:
        with open(READY_FILE, "w", encoding="utf-8") as handle:
            handle.write(f"{os.getpid()} {time.time()}\n")
        log(f"ready with {subscribers} subscriber(s)")
    except OSError:
        log(f"ready with {subscribers} subscriber(s) (marker write failed)")

    msg = Twist()
    zero_rounds = 0
    last_reported = None
    cycles = 0
    cycle = 1.0 / RATE_HZ
    try:
        while rclpy.ok():
            linear, angular, err = read_cmd()
            if err:
                log(err)
            msg.linear.x = linear
            msg.angular.z = angular
            pub.publish(msg)
            cycles += 1
            current = (linear, angular)
            if current != last_reported:
                log(f"cmd -> lin={linear} ang={angular} (cycle {cycles})")
                last_reported = current
            if linear == 0.0 and angular == 0.0:
                zero_rounds += 1
                if (
                    not PERSIST_WHILE_ENABLED
                    and zero_rounds >= RATE_HZ * IDLE_ZERO_SEC
                ):
                    log(f"idle-zero exit after {cycles} cycles")
                    break
            else:
                zero_rounds = 0
            time.sleep(cycle)
    finally:
        # Publish one final zero on the way out so a torn-down publisher can
        # never leave a stale non-zero command as the last thing the chassis
        # received before the stream goes silent.
        try:
            msg.linear.x = 0.0
            msg.angular.z = 0.0
            pub.publish(msg)
        except Exception:
            pass
        node.destroy_node()
        try:
            rclpy.shutdown()
        except Exception:
            # SIGTERM can race the shutdown: rcl may already be torn down.
            pass
        try:
            os.unlink(READY_FILE)
        except OSError:
            pass
        log(f"exit after {cycles} cycles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
