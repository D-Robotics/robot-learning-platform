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

import base64
import hashlib
import json
import io
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import board_ipc

AGENT_FILE = os.path.join(HERE, "board-agent-x5.py")  # hyphenated: spec-load
_load_count = [0]


def load_agent_module(
    enable_drive=False,
    profile_path=None,
    bind_host="127.0.0.1",
    token="test-token",
    enable_policy=False,
):
    """Spec-load the agent with a clean, offline environment.

    The filename carries hyphens, so plain `import` cannot load it; each call
    returns a FRESH module instance so drive-on/off variants never share
    module state."""
    import importlib.util

    _load_count[0] += 1
    env = {
        "RDK_SIM2REAL_BOARD_AGENT_TOKEN": token,
        "RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": "1" if enable_drive else "",
        "RDK_SIM2REAL_BOARD_AGENT_BIND_HOST": bind_host,
        "RDK_SIM2REAL_BOARD_AGENT_PORT": "19100",
        "RDK_SIM2REAL_ADAPTER_CONFIG": profile_path or "",
        "RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY": "1" if enable_policy else "",
    }
    with mock.patch.dict(os.environ, env, clear=True):
        spec = importlib.util.spec_from_file_location(
            f"board_agent_x5_test_{_load_count[0]}", AGENT_FILE
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class BoardAgentBindSecurityContract(unittest.TestCase):
    def test_non_loopback_bind_requires_token(self):
        with self.assertRaisesRegex(RuntimeError, "TOKEN is required"):
            load_agent_module(bind_host="0.0.0.0", token="")

    def test_loopback_bind_may_use_empty_development_token(self):
        agent = load_agent_module(bind_host="127.0.0.1", token="")
        self.assertEqual(agent.HOST, "127.0.0.1")


class BoardIpcSecurityContract(unittest.TestCase):
    def setUp(self):
        self.workdir = tempfile.mkdtemp(prefix="board-ipc-test-")

    def test_private_atomic_write_mode_and_bounded_read(self):
        target = os.path.join(self.workdir, "state.json")
        board_ipc.atomic_write_text(target, "{}")
        self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o600)
        self.assertEqual(board_ipc.secure_read_text(target), "{}")
        # A legacy readable mode is tightened on first secure read.
        os.chmod(target, 0o640)
        self.assertEqual(board_ipc.secure_read_text(target), "{}")
        self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o600)
        with self.assertRaises(OSError):
            board_ipc.secure_read_text(target, max_bytes=1)

    def test_public_tmp_parent_is_rejected(self):
        with self.assertRaises(OSError):
            board_ipc.atomic_write_text("/tmp/rdk-board-agent-ipc-test", "x")

    def test_symlink_parent_and_target_fail_closed(self):
        real_parent = os.path.join(self.workdir, "real")
        os.mkdir(real_parent, 0o700)
        parent_link = os.path.join(self.workdir, "parent-link")
        os.symlink(real_parent, parent_link)
        with self.assertRaises(OSError):
            board_ipc.atomic_write_text(os.path.join(parent_link, "state"), "x")

        target = os.path.join(self.workdir, "target")
        outside = os.path.join(self.workdir, "outside")
        with open(outside, "w") as handle:
            handle.write("sentinel")
        os.symlink(outside, target)
        with self.assertRaises(OSError):
            board_ipc.atomic_write_text(target, "changed")
        with open(outside) as handle:
            self.assertEqual(handle.read(), "sentinel")


class BoardAgentHttpFramingContract(unittest.TestCase):
    """Malformed request framing must fail closed on persistent HTTP/1.1."""

    def setUp(self):
        self.agent = load_agent_module(enable_drive=False)

    def _handler(self, headers, body=b""):
        handler = object.__new__(self.agent.Handler)
        handler.headers = headers
        handler.rfile = io.BytesIO(body)
        handler.close_connection = False
        return handler

    class _DuplicateHeaders(dict):
        """Minimal Message-like test double that preserves duplicate fields."""

        def __init__(self, values):
            super().__init__({key: item[0] for key, item in values.items()})
            self._values = values

        def get_all(self, name):
            return self._values.get(name, [])

    def test_invalid_content_length_closes_connection(self):
        for raw in ("not-a-number", "-1", "1.5", ""):
            with self.subTest(raw=raw):
                handler = self._handler({"content-length": raw})
                self.assertIsNone(handler._content_length(self.agent.MAX_BODY_BYTES))
                self.assertTrue(handler.close_connection)

    def test_chunked_requests_are_rejected_without_body_desync(self):
        handler = self._handler({"transfer-encoding": "chunked"}, b"4\r\ntest\r\n0\r\n\r\n")
        self.assertIsNone(handler._content_length(self.agent.MAX_BODY_BYTES))
        self.assertTrue(handler.close_connection)

    def test_duplicate_or_comma_separated_content_lengths_are_rejected(self):
        cases = (
            ["7", "7"],
            ["7", "8"],
            ["7, 7"],
            ["7,8"],
        )
        for values in cases:
            with self.subTest(values=values):
                handler = self._handler(
                    self._DuplicateHeaders({"content-length": values})
                )
                self.assertIsNone(handler._content_length(self.agent.MAX_BODY_BYTES))
                self.assertTrue(handler.close_connection)

    def test_duplicate_transfer_encoding_is_rejected(self):
        handler = self._handler(
            self._DuplicateHeaders({"transfer-encoding": ["identity", "identity"]})
        )
        self.assertIsNone(handler._content_length(self.agent.MAX_BODY_BYTES))
        self.assertTrue(handler.close_connection)

    def test_empty_body_routes_accept_absent_zero_or_legacy_empty_object(self):
        for headers in ({}, {"content-length": "0"}):
            with self.subTest(headers=headers):
                handler = self._handler(headers)
                self.assertTrue(handler._require_empty_body())
                self.assertFalse(handler.close_connection)
        handler = self._handler({"content-length": "2"}, b"{}")
        self.assertTrue(handler._require_empty_body())
        self.assertFalse(handler.close_connection)
        handler = self._handler({"content-length": "1"}, b"x")
        self.assertFalse(handler._require_empty_body())
        self.assertTrue(handler.close_connection)

    def test_valid_body_is_read_only_within_ceiling(self):
        handler = self._handler({"content-length": "7"}, b'{"ok":1}')
        self.assertEqual(handler._content_length(self.agent.MAX_BODY_BYTES), 7)
        self.assertFalse(handler.close_connection)

    def test_empty_or_malformed_json_is_not_silently_defaulted(self):
        for headers, body in (
            ({"content-length": "0"}, b""),
            ({"content-length": "4"}, b"null"),
            ({"content-length": "3"}, b"bad"),
        ):
            with self.subTest(headers=headers, body=body):
                handler = self._handler(headers, body)
                self.assertIsNone(handler._read_json())
                self.assertTrue(handler.close_connection)


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
        self.assertIn("feedback", status)
        self.assertFalse(status["feedback"]["available"])

    def test_feedback_separates_measured_odom_from_command_state(self):
        self.agent._ob_state["data"] = {
            "odom": {"linearX": 0.08, "angularZ": -0.12, "positionX": 1.2, "positionY": -0.4}
        }
        self.agent._ob_state["ts"] = time.time()
        feedback = self.agent.drive_status()["feedback"]
        self.assertTrue(feedback["available"])
        self.assertTrue(feedback["fresh"])
        self.assertAlmostEqual(feedback["linearX"], 0.08)
        self.assertAlmostEqual(feedback["angularZ"], -0.12)
        self.assertAlmostEqual(feedback["positionX"], 1.2)

    def test_stop_always_succeeds_even_when_disabled(self):
        self.assertTrue(self.agent.drive_stop("operator-emergency-stop"))
        status = self.agent.drive_status()
        self.assertEqual(status["lastStopReason"], "operator-emergency-stop")


class OnboardingPreflightContract(unittest.TestCase):
    """The new-device passport is structured, honest, and read-only."""

    def setUp(self):
        self.agent = load_agent_module(enable_drive=False)

    def test_passport_never_authorizes_motion(self):
        passport = self.agent.onboarding_preflight()
        self.assertTrue(passport["ok"])
        self.assertEqual(passport["kind"], "originbot-onboarding-preflight")
        self.assertFalse(passport["mock"])
        self.assertFalse(passport["checks"]["safety"]["motionAuthorized"])
        self.assertFalse(passport["motion"]["started"])
        self.assertIn("camera", passport["checks"])
        self.assertIn("telemetry", passport["checks"])


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

    def test_non_finite_bool_and_string_inputs_are_rejected(self):
        cases = [
            (True, 0.0, 1.0),
            (0.0, False, 1.0),
            (float("nan"), 0.0, 1.0),
            (0.0, 0.0, float("inf")),
            (0.0, 0.0, "1"),
        ]
        for values in cases:
            with self.subTest(values=values):
                ok, reason = self.agent.drive_command(*values)
                self.assertFalse(ok)
                self.assertEqual(reason, "invalid-type")

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

    def test_fixed_tmp_symlink_is_never_followed(self):
        """A legacy <target>.tmp symlink cannot redirect a command write."""
        outside = os.path.join(self.workdir, "outside.txt")
        with open(outside, "w") as handle:
            handle.write("sentinel")
        legacy_tmp = self.agent.DRIVE_COMMAND_FILE + ".tmp"
        os.symlink(outside, legacy_tmp)
        self.agent._write_drive_yaml(0.04, 0.2)
        with open(outside) as handle:
            self.assertEqual(handle.read(), "sentinel")
        self.assertTrue(os.path.islink(legacy_tmp))
        with open(self.agent.DRIVE_COMMAND_FILE) as handle:
            self.assertIn("x: 0.04", handle.read())

    def test_ipc_target_symlink_fails_closed(self):
        outside = os.path.join(self.workdir, "outside-target.txt")
        with open(outside, "w") as handle:
            handle.write("sentinel")
        os.symlink(outside, self.agent.DRIVE_COMMAND_FILE)
        with self.assertRaises(OSError):
            self.agent._write_drive_yaml(0.04, 0.2)
        with open(outside) as handle:
            self.assertEqual(handle.read(), "sentinel")

    def test_policy_stage_never_follows_fixed_tmp_symlink(self):
        self.agent.POLICY_ENABLED = True
        policy_dir = os.path.join(self.workdir, "policies")
        os.mkdir(policy_dir, 0o700)
        self.agent.POLICY_ALLOWED_MODEL_DIR = policy_dir
        payload = b"tiny-policy"
        encoded = base64.b64encode(payload).decode("ascii")
        digest = hashlib.sha256(payload).hexdigest()
        outside = os.path.join(self.workdir, "outside-policy")
        with open(outside, "w") as handle:
            handle.write("sentinel")
        os.symlink(outside, os.path.join(policy_dir, "demo.onnx.tmp"))
        result = self.agent.policy_stage(encoded, "demo.onnx", digest)
        self.assertTrue(result["ok"])
        with open(outside) as handle:
            self.assertEqual(handle.read(), "sentinel")
        self.assertEqual(
            stat.S_IMODE(os.stat(os.path.join(policy_dir, "demo.onnx")).st_mode),
            0o600,
        )

    def test_actuator_policy_is_complete_and_honest(self):
        policy = self.agent._actuator_policy()
        self.assertTrue(policy["enabled"])
        self.assertEqual(policy["maxLinear"], 0.3)
        self.assertEqual(policy["maxAngular"], 1.0)
        self.assertEqual(policy["maxWindowSec"], 2.0)
        self.assertEqual(policy["chassisWatchdogMs"], 500)
        self.assertIn("drive/stop", policy["emergencyStop"])

    def test_policy_list_reports_the_digest_it_will_be_judged_by(self):
        """A staged policy's digest binds a board rehearsal to real bytes.

        `policy/stage` already returns the SHA-256 it verified, and the platform
        rehearsal gate compares that digest with the one a rehearsal measured.
        The listing therefore has to carry it too — a name and size alone cannot
        answer "will I load the bytes that were measured?".
        """
        policy_dir = os.path.join(self.workdir, "policies")
        os.mkdir(policy_dir, 0o700)
        self.agent.POLICY_ALLOWED_MODEL_DIR = policy_dir
        self.agent._POLICY_DIGEST_CACHE.clear()
        payload = b"tiny-policy-bytes"
        target = os.path.join(policy_dir, "demo.onnx")
        with open(target, "wb") as handle:
            handle.write(payload)
        os.chmod(target, 0o600)
        listed = self.agent.policy_list()["policies"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["name"], "demo.onnx")
        self.assertEqual(listed[0]["bytes"], len(payload))
        self.assertEqual(listed[0]["sha256"], hashlib.sha256(payload).hexdigest())
        # The digest is cached per (size, mtime) so a 50 MB artifact is not
        # re-hashed on every poll, and a rewrite must invalidate that cache.
        self.assertEqual(self.agent.policy_list()["policies"], listed)
        with open(target, "wb") as handle:
            handle.write(b"changed-policy-bytes")
        os.chmod(target, 0o600)
        changed = self.agent.policy_list()["policies"][0]
        self.assertNotEqual(changed["sha256"], listed[0]["sha256"])
        self.assertEqual(changed["sha256"], hashlib.sha256(b"changed-policy-bytes").hexdigest())

    def test_policy_list_omits_entries_it_cannot_read_safely(self):
        policy_dir = os.path.join(self.workdir, "policies")
        os.mkdir(policy_dir, 0o700)
        self.agent.POLICY_ALLOWED_MODEL_DIR = policy_dir
        self.agent._POLICY_DIGEST_CACHE.clear()
        outside = os.path.join(self.workdir, "outside.onnx")
        with open(outside, "wb") as handle:
            handle.write(b"outside")
        os.symlink(outside, os.path.join(policy_dir, "linked.onnx"))
        with open(os.path.join(policy_dir, "README.txt"), "w") as handle:
            handle.write("not a policy")
        self.assertEqual(self.agent.policy_list()["policies"], [])

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
                ), mock.patch.object(agent, "secure_exists", return_value=True):
            # The marker exists, so the handshake wait loop returns True on
            # its first cycle without sleeping on the real clock.
            started = agent._start_drive_publisher()
        self.assertTrue(started)
        # decisionHz is parsed as float, so the env var is "5.0" not "5".
        self.assertEqual(captured.get("RDK_BOARD_DRIVE_RATE_HZ"), "5.0")
        self.assertEqual(captured.get("RDK_BOARD_DRIVE_CMD_TOPIC"), agent.DRIVE_COMMAND_TOPIC)
        self.assertEqual(captured.get("RDK_BOARD_DRIVE_PERSIST"), "1")


class BoardConfigSurfaceContract(unittest.TestCase):
    """Web-managed switch surface (/v1/config): only the two documented
    flags, atomic env rewrite preserving foreign lines, restart refused
    mid-motion, honest non-systemd message."""

    def setUp(self):
        self.agent = load_agent_module(enable_drive=False)
        self.workdir = tempfile.mkdtemp(prefix="board-config-test-")
        self.env_file = os.path.join(self.workdir, "agent.env")
        with open(self.env_file, "w") as handle:
            handle.write(
                "RDK_SIM2REAL_BOARD_AGENT_TOKEN=secret\n"
                "RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=0\n"
                "RDK_SIM2REAL_BOARD_AGENT_BIND_HOST=0.0.0.0\n"
            )
        # The production unit keeps the token-bearing EnvironmentFile root-only.
        # The config endpoint must refuse to rewrite anything less restrictive.
        os.chmod(self.env_file, 0o600)
        self.agent.AGENT_ENV_FILE = self.env_file

    def test_config_status_reports_source_of_truth(self):
        status = self.agent.config_status()
        self.assertTrue(status["ok"])
        self.assertEqual(
            status["switches"]["RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE"],
            self.agent.DRIVE_ENABLED,
        )
        self.assertTrue(status["envFileExists"])
        self.assertIn(status["unit"], ("rdk-board-agent.service",
                                       os.environ.get("RDK_SIM2REAL_BOARD_AGENT_UNIT", "rdk-board-agent.service")))

    def test_apply_rewrites_only_the_two_switches(self):
        with mock.patch.object(self.agent.subprocess, "run") as fake_run, \
                mock.patch.object(os.path, "isdir", return_value=False):
            fake_run.return_value = mock.Mock(returncode=0)
            result = self.agent._config_apply(
                {"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": True}
            )
        self.assertTrue(result["ok"])
        self.assertFalse(result["restarted"])  # non-systemd path is honest
        with open(self.env_file) as handle:
            lines = handle.read().splitlines()
        self.assertIn("RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1", lines)
        # Foreign lines survive the atomic rewrite.
        self.assertIn("RDK_SIM2REAL_BOARD_AGENT_TOKEN=secret", lines)
        self.assertIn("RDK_SIM2REAL_BOARD_AGENT_BIND_HOST=0.0.0.0", lines)
        self.assertEqual(stat.S_IMODE(os.stat(self.env_file).st_mode), 0o600)
        # The untouched sibling switch is preserved, not deleted.
        self.assertNotIn("RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY=1", lines)

    def test_apply_rejects_unknown_keys_and_wrong_types(self):
        result = self.agent._config_apply(
            {"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": "yes"}
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid-value")
        # Unknown flags are dropped, not written.
        with open(self.env_file) as handle:
            content = handle.read()
        self.assertNotIn("POLICY", content.replace(
            "RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY", ""))

    def test_apply_refuses_when_motion_window_active(self):
        self.agent._drive_state["active"] = True
        result = self.agent._config_apply(
            {"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": True}
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "motion-active")
        # env untouched
        with open(self.env_file) as handle:
            content = handle.read()
        self.assertIn("RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=0", content)

    def test_apply_missing_env_file_is_honest(self):
        os.unlink(self.env_file)
        result = self.agent._config_apply(
            {"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": True}
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "env-file-missing")

    def test_apply_rejects_broad_permissions_before_rewriting_token_file(self):
        os.chmod(self.env_file, 0o644)
        with open(self.env_file) as handle:
            before = handle.read()
        result = self.agent._config_apply(
            {"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": True}
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "env-file-permissions")
        with open(self.env_file) as handle:
            self.assertEqual(handle.read(), before)

    def test_apply_rejects_env_file_symlink(self):
        target = self.env_file + ".target"
        os.replace(self.env_file, target)
        os.symlink(target, self.env_file)
        result = self.agent._config_apply(
            {"RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE": True}
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "env-file-unsafe")
        with open(target) as handle:
            self.assertEqual(handle.read().splitlines()[1],
                             "RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=0")

    def test_apply_restarts_unit_when_systemd_managed(self):
        captured = {}

        class FakeCompleted(object):
            returncode = 0
            stderr = ""

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            return FakeCompleted()

        with mock.patch.object(self.agent.subprocess, "run", side_effect=fake_run), \
                mock.patch.object(os.path, "isdir", return_value=True):
            result = self.agent._config_apply(
                {"RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY": True}
            )
        self.assertTrue(result["ok"])
        self.assertTrue(result["restarted"])
        self.assertIn("systemctl", captured["argv"][0])
        self.assertIn("restart", captured["argv"])
        with open(self.env_file) as handle:
            content = handle.read()
        self.assertIn("RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY=1", content)


def load_policy_runtime_module():
    """Spec-load board-policy-runtime.py (hyphenated name, stdlib-only imports)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "board_policy_runtime_test", os.path.join(HERE, "board-policy-runtime.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _optional_onnx_stack():
    """numpy/onnx for building probe graphs, or None when unavailable."""
    try:
        import numpy  # noqa: F401
        import onnx  # noqa: F401
    except ImportError:
        return None
    return True


class PolicyStartGoalGateContract(unittest.TestCase):
    """The agent's policy-start gate must refuse goal-less goalnav sessions.

    A goalnav policy (8D native or 42D imu-gravity-v1) started without a goal
    runs blind to its target — the root cause of the 2026-09-14
    "direction=0 drives straight" incident. The agent reads the loaded
    model's contract from the runtime state file and refuses BEFORE the
    file-protocol round trip; with a goal it forwards direction + goalX/goalY
    so the runtime's session carries the task target as evidence.
    """

    def _gate_result(self, input_dim, direction, goal_x=None, goal_y=None):
        agent = load_agent_module(enable_drive=True, enable_policy=True)
        state = {
            "ok": True,
            "state": "ready",
            "model": {"path": "fixture.onnx", "inputDim": input_dim, "outputDim": 2},
        }
        sent = []

        def fake_send(op, **fields):
            sent.append((op, fields))
            return {"ok": True, "state": "running"}

        with mock.patch.object(agent, "_policy_read_state", return_value=state), \
                mock.patch.object(agent, "_stop_drive_publisher"), \
                mock.patch.object(agent, "_policy_send", side_effect=fake_send):
            result = agent.policy_start(direction, goal_x, goal_y)
        return result, sent

    def test_goalnav_42d_refuses_without_goal(self):
        result, sent = self._gate_result(42, 1.0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "goal-required")
        self.assertIn("42D goalnav", result["message"])
        # Refusal happens before any file-protocol round trip.
        self.assertEqual(sent, [])

    def test_goalnav_42d_forwards_direction_and_goal(self):
        result, sent = self._gate_result(42, 1.0, 1.5, -0.25)
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(len(sent), 1)
        op, fields = sent[0]
        self.assertEqual(op, "start")
        self.assertEqual(fields["direction"], 1.0)
        self.assertEqual(fields["goalX"], 1.5)
        self.assertEqual(fields["goalY"], -0.25)

    def test_native_8d_keeps_its_goal_gate(self):
        result, sent = self._gate_result(8, 1.0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "goal-required")
        self.assertIn("8D OriginBot", result["message"])
        self.assertEqual(sent, [])

    def test_non_goal_contract_needs_no_goal(self):
        result, sent = self._gate_result(61, 0.5)
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(sent, [("start", {"direction": 0.5})])

    def test_half_or_non_finite_goal_is_rejected(self):
        result, sent = self._gate_result(42, 1.0, 1.5)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid-goal")
        result, sent = self._gate_result(42, 1.0, float("nan"), 0.0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid-goal")
        self.assertEqual(sent, [])


class PolicyRuntimeInputBindingContract(unittest.TestCase):
    """The board runtime must refuse inputs it cannot actually feed.

    A recurrent export's `h_in`/`c_in` carry the policy's memory. ONNX Runtime
    would default them to zeros on every step, so the duck would run a policy
    that never remembers anything: actions look plausible and are wrong. Until
    this runtime carries state, that export has to be refused at load.
    """

    def setUp(self):
        self.workdir = tempfile.mkdtemp(prefix="policy-runtime-binding-")
        self.addCleanup(shutil.rmtree, self.workdir, ignore_errors=True)
        self.runtime_module = load_policy_runtime_module()

    def _write_model(self, inputs, outputs, name):
        import numpy as np
        import onnx
        from onnx import TensorProto, helper, numpy_helper

        nodes = []
        inits = []
        for index, (tensor_name, shape) in enumerate(inputs):
            if len(shape) == 2:
                weight = (np.random.RandomState(index).randn(shape[1], 14) * 0.05).astype(
                    np.float32
                )
                bias = np.zeros(14, dtype=np.float32)
                nodes.append(helper.make_node("MatMul", [tensor_name, f"w{index}"], [f"h{index}"]))
                nodes.append(helper.make_node("Add", [f"h{index}", f"b{index}"], ["action"]))
                inits.append(numpy_helper.from_array(weight, f"w{index}"))
                inits.append(numpy_helper.from_array(bias, f"b{index}"))
            else:
                nodes.append(helper.make_node("Identity", [tensor_name], [outputs[index][0]]))
        graph = helper.make_graph(
            nodes,
            name,
            [
                helper.make_tensor_value_info(tensor_name, TensorProto.FLOAT, list(shape))
                for tensor_name, shape in inputs
            ],
            [
                helper.make_tensor_value_info(tensor_name, TensorProto.FLOAT, list(shape))
                for tensor_name, shape in outputs
            ],
            inits,
        )
        model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
        model.ir_version = 9
        target = os.path.join(self.workdir, f"{name}.onnx")
        onnx.save(model, target)
        return target

    def test_recurrent_export_is_refused_with_its_state_inputs_named(self):
        if not _optional_onnx_stack():
            self.skipTest("numpy/onnx unavailable on this machine")
        model = self._write_model(
            [("obs", (1, 61)), ("h_in", (1, 1, 256)), ("c_in", (1, 1, 256))],
            [("action", (1, 14)), ("h_out", (1, 1, 256)), ("c_out", (1, 1, 256))],
            "recurrent",
        )
        result = self.runtime_module.PolicyRuntime().load(model)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "policy-state-input-unsupported")
        self.assertEqual(result["stateInputs"], ["h_in", "c_in"])
        self.assertIn("zeroed history", result["detail"])

    def test_slot_report_describes_what_was_actually_written(self):
        """The observation slot report must come from the assembly, not a literal.

        It previously hand-wrote "slots 0-5 real; slots 6-N adapter", which was
        right only by coincidence and could not notice a contract the adapter did
        not fill. The report now derives from the segments the builder recorded,
        so these assertions fail if the two ever separate again.
        """
        runtime = self.runtime_module
        for obs_dim, act_dim in ((61, 14), (42, 12), (8, 2), (12, 4)):
            segments = runtime.wheeled_observation_layout(obs_dim, act_dim)
            filled = runtime.wheeled_observation_size(obs_dim, act_dim)
            # The layout caps itself, so the assembly can never overflow the
            # contract; the remainder is zero-padded by design.
            self.assertLessEqual(filled, obs_dim, (obs_dim, act_dim))

            policy = runtime.PolicyRuntime()
            policy._model_meta = {"path": "fixture"}
            before = policy._obs_slot_report()
            self.assertIn("no observation assembled", before["source"])
            self.assertNotIn("slots", before)

            policy._obs_segments = segments
            report = policy._obs_slot_report()
            ranges = [(entry["name"], entry["range"]) for entry in report["slots"]]
            offset = 0
            for name, width, provenance in segments:
                expected = f"{offset}-{offset + width - 1}" if width else "absent"
                self.assertIn((name, expected), ranges, (obs_dim, act_dim, name))
                offset += width
            self.assertEqual(report["slots_total"], filled, (obs_dim, act_dim))
            self.assertEqual(
                report["slots_real"] + report["slots_adapter"], filled, (obs_dim, act_dim)
            )

    def test_feed_forward_export_still_loads(self):
        if not _optional_onnx_stack():
            self.skipTest("numpy/onnx unavailable on this machine")
        model = self._write_model(
            [("obs", (1, 61))], [("action", (1, 14))], "feedforward"
        )
        result = self.runtime_module.PolicyRuntime().load(model)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["model"]["inputDim"], 61)
        self.assertEqual(result["model"]["outputDim"], 14)


if __name__ == "__main__":

    unittest.main(verbosity=2)
