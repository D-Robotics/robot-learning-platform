#!/usr/bin/env python3
"""Contract tests for the board agent's constrained-drive state machine.

Runs on the development machine (no ROS, no board): imports board-agent-x5.py
with stubbed environment, then exercises the drive refusal/clamp/stop logic
and the pure functions. Wired into `npm run verify` via verify:board-drive.

What these tests protect:
- drive stays refused while the switch is off (fail closed);
- clamps and window bounds reject out-of-range values instead of truncating;
- the ready-marker handshake cannot pass on a stale marker (unlinked before
  every launch) — this was the silent window-swallow bug;
- emergency stop always wins over an active window;
- the drive YAML command file is written atomically and zeroed on stop.
"""

import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_FILE = os.path.join(HERE, "board-agent-x5.py")  # hyphenated: spec-load
_load_count = [0]


def load_agent_module(enable_drive=False, profile_path=None):
    """Spec-load the agent with a clean, offline environment.

    The filename carries hyphens, so plain `import` cannot load it; each call
    returns a FRESH module instance so drive-on/off variants never share
    module state."""
    import importlib.util

    _load_count[0] += 1
    env = {
        "RDK_SIM2REAL_BOARD_AGENT_TOKEN": "test-token",
        "RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": "1" if enable_drive else "",
        "RDK_SIM2REAL_BOARD_AGENT_BIND_HOST": "127.0.0.1",
        "RDK_SIM2REAL_BOARD_AGENT_PORT": "19100",
        "RDK_SIM2REAL_ADAPTER_CONFIG": profile_path or "",
    }
    with mock.patch.dict(os.environ, env, clear=True):
        spec = importlib.util.spec_from_file_location(
            f"board_agent_x5_test_{_load_count[0]}", AGENT_FILE
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


class DriveDisabledContract(unittest.TestCase):
    def setUp(self):
        self.agent = load_agent_module(enable_drive=False)

    def test_switch_off_refuses_everything(self):
        ok, reason = self.agent.drive_command(0.0, 0.0, 1.0)
        self.assertFalse(ok)
        self.assertEqual(reason, "drive-disabled")

    def test_switch_off_reports_honest_state(self):
        status = self.agent.drive_status()
        self.assertFalse(status["enabled"])
        self.assertFalse(status["active"])
        self.assertEqual(status["lastStopReason"], "idle")

    def test_stop_always_succeeds_even_when_disabled(self):
        self.assertTrue(self.agent.drive_stop("operator-emergency-stop"))
        status = self.agent.drive_status()
        self.assertEqual(status["lastStopReason"], "operator-emergency-stop")


class DriveEnabledContract(unittest.TestCase):
    def setUp(self):
        self.agent = load_agent_module(enable_drive=True)
        self.workdir = tempfile.mkdtemp(prefix="board-drive-test-")
        self.agent.DRIVE_COMMAND_FILE = os.path.join(self.workdir, "cmd.yaml")
        self.agent.DRIVE_PUBLISHER_READY = os.path.join(self.workdir, "pub.ready")
        # No real publisher: the handshake must fail closed.
        self.agent.DRIVE_PUBLISHER_SCRIPT = os.path.join(self.workdir, "nope.py")

    def test_handshake_failure_refuses_instead_of_silent_success(self):
        ok, reason = self.agent.drive_command(0.05, 0.0, 1.0)
        self.assertFalse(ok)
        self.assertEqual(reason, "publisher-unavailable")
        # and crucially: no motion window was opened
        self.assertFalse(self.agent.drive_status()["active"])

    def test_stale_ready_marker_is_unlinked_before_handshake(self):
        # Simulate a marker left behind by a SIGKILLed publisher.
        with open(self.agent.DRIVE_PUBLISHER_READY, "w") as handle:
            handle.write("stale\n")
        # Script still missing -> launch refuses, but the marker must be gone
        # by then so a later real launch can never race on the stale file.
        started = self.agent._start_drive_publisher()
        self.assertFalse(started)
        self.assertFalse(
            os.path.exists(self.agent.DRIVE_PUBLISHER_READY),
            "stale ready marker survived the launch attempt",
        )

    def test_out_of_range_rejected_before_publisher(self):
        cases = [
            (0.5, 0.0, 1.0, "linear-out-of-range"),
            (0.0, 2.0, 1.0, "angular-out-of-range"),
            (0.05, 0.0, 0.0, "duration-out-of-range"),
            (0.05, 0.0, 3.0, "duration-out-of-range"),
            ("fast", 0.0, 1.0, "invalid-type"),
        ]
        for linear, angular, duration, expected in cases:
            with self.subTest(expected=expected):
                ok, reason = self.agent.drive_command(linear, angular, duration)
                self.assertFalse(ok)
                self.assertEqual(reason, expected)
        # no window opened by any of them
        self.assertFalse(self.agent.drive_status()["active"])

    def test_yaml_write_is_atomic_and_zeroed_on_stop(self):
        self.agent._write_drive_yaml(0.05, 0.25)
        with open(self.agent.DRIVE_COMMAND_FILE) as handle:
            content = handle.read()
        self.assertIn("x: 0.05", content)
        self.assertIn("z: 0.25", content)
        self.assertFalse(os.path.exists(self.agent.DRIVE_COMMAND_FILE + ".tmp"))
        self.agent.drive_stop("test-stop")
        with open(self.agent.DRIVE_COMMAND_FILE) as handle:
            content = handle.read()
        self.assertIn("x: 0.0", content)
        self.assertIn("z: 0.0", content)

    def test_actuator_policy_is_complete_and_honest(self):
        policy = self.agent._actuator_policy()
        self.assertTrue(policy["enabled"])
        self.assertEqual(policy["maxLinear"], 0.3)
        self.assertEqual(policy["maxAngular"], 1.0)
        self.assertEqual(policy["maxWindowSec"], 2.0)
        self.assertEqual(policy["chassisWatchdogMs"], 500)
        self.assertIn("drive/stop", policy["emergencyStop"])

    def test_profile_wiring_lowers_limits_and_selects_command_topic(self):
        profile_path = os.path.join(self.workdir, "custom-profile.json")
        with open(profile_path, "w") as handle:
            json.dump(
                {
                    "id": "custom-diff-drive",
                    "actuator": {"commandTopic": "/robot/cmd_vel", "watchdogMs": 700},
                    "runtime": {"decisionHz": 5},
                    "safety": {"maxLinear": 0.12, "maxAngular": 0.4},
                    "ros": {"topics": {"cmdVel": {"name": "/robot/cmd_vel"}}},
                },
                handle,
            )
        agent = load_agent_module(enable_drive=True, profile_path=profile_path)
        self.assertEqual(agent.DRIVE_MAX_LINEAR, 0.12)
        self.assertEqual(agent.DRIVE_MAX_ANGULAR, 0.4)
        self.assertEqual(agent.DRIVE_PUBLISH_HZ, 5)
        self.assertEqual(agent.DRIVE_WATCHDOG_MS, 700)
        self.assertEqual(agent.DRIVE_COMMAND_TOPIC, "/robot/cmd_vel")

    def test_telemetry_snapshot_reader_rejects_stale_and_absent(self):
        # No file: None
        self.agent.TELEMETRY_SNAPSHOT_FILE = os.path.join(self.workdir, "missing.json")
        self.assertIsNone(self.agent._read_telemetry_snapshot())
        # Stale: None
        stale_path = os.path.join(self.workdir, "stale.json")
        with open(stale_path, "w") as handle:
            json.dump({"ts": time.time() - 60, "data": {"imu": {}}}, handle)
        self.agent.TELEMETRY_SNAPSHOT_FILE = stale_path
        self.assertIsNone(self.agent._read_telemetry_snapshot())
        # Fresh: dict
        fresh_path = os.path.join(self.workdir, "fresh.json")
        with open(fresh_path, "w") as handle:
            json.dump({"ts": time.time(), "data": {"batteryVoltage": 4.9}}, handle)
        self.agent.TELEMETRY_SNAPSHOT_FILE = fresh_path
        self.assertEqual(self.agent._read_telemetry_snapshot(), {"batteryVoltage": 4.9})

    def test_publisher_env_propagates_profile_drive_rate(self):
        # Regression for 76b7bd4: DRIVE_PUBLISH_HZ lowered by the profile's
        # decisionHz must reach the publisher process, otherwise it keeps
        # re-publishing at the compile-time default and the watchdog window
        # drifts. Capture the env Popen would receive without spawning bash.
        profile_path = os.path.join(self.workdir, "rate-profile.json")
        with open(profile_path, "w") as handle:
            json.dump({"id": "custom-diff-drive", "runtime": {"decisionHz": 5}}, handle)
        agent = load_agent_module(enable_drive=True, profile_path=profile_path)
        self.assertEqual(agent.DRIVE_PUBLISH_HZ, 5)
        self.agent.DRIVE_COMMAND_FILE = os.path.join(self.workdir, "cmd.yaml")
        self.agent.DRIVE_PUBLISHER_READY = os.path.join(self.workdir, "pub.ready")
        self.agent.DRIVE_PUBLISHER_SCRIPT = os.path.join(self.workdir, "nope.py")

        captured = {}

        class FakeProc(object):
            def poll(self):
                return None

            def kill(self):
                pass

            def wait(self, timeout=None):
                return None

        def fake_popen(*args, **kwargs):
            captured.update(kwargs.get("env") or {})
            return FakeProc()

        with mock.patch.object(agent.subprocess, "Popen", side_effect=fake_popen), \
                mock.patch.object(
                    os.path,
                    "exists",
                    side_effect=lambda p: p in (
                        agent.DRIVE_PUBLISHER_SCRIPT,
                        agent.DRIVE_COMMAND_FILE,
                        agent.DRIVE_PUBLISHER_READY,
                    ),
                ):
            # The marker exists, so the handshake wait loop returns True on
            # its first cycle without sleeping on the real clock.
            started = agent._start_drive_publisher()
        self.assertTrue(started)
        # decisionHz is parsed as float, so the env var is "5.0" not "5".
        self.assertEqual(captured.get("RDK_BOARD_DRIVE_RATE_HZ"), "5.0")
        self.assertEqual(captured.get("RDK_BOARD_DRIVE_CMD_TOPIC"), agent.DRIVE_COMMAND_TOPIC)
        self.assertEqual(captured.get("RDK_BOARD_DRIVE_PERSIST"), "1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
