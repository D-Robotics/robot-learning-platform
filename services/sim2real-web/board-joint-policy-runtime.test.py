#!/usr/bin/env python3
"""Software-only tests of MicroDuck commands; no ROS or actuators are loaded."""

import importlib.util
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
RUNTIME_PATH = Path(__file__).with_name("board-joint-policy-runtime.py")


class JointCommandTest(unittest.TestCase):
    def setUp(self):
        self.runtime_dir = tempfile.TemporaryDirectory(prefix="joint-command-test-")
        os.chmod(self.runtime_dir.name, 0o700)
        self.env = patch.dict(os.environ, {
            "RDK_BOARD_RUNTIME_DIR": self.runtime_dir.name,
            "RDK_SIM2REAL_ADAPTER_CONFIG": str(ROOT / "adapters" / "microduck-leg.json"),
            "RDK_SIM2REAL_OBS_HISTORY_FRAMES": "1",
        })
        self.env.start()
        spec = importlib.util.spec_from_file_location("joint_command_runtime_test", RUNTIME_PATH)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.runtime = self.module.JointPolicyRuntime()
        self.frames = []
        self.inputs = []
        self.runtime._model = SimpleNamespace(run=self.infer)
        self.runtime._input_name = "observation"
        self.runtime._state = "ready"
        self.runtime._publisher = SimpleNamespace(publish=self.frames.append)
        self.runtime._JointTrajectory = lambda: SimpleNamespace()
        self.runtime._JointTrajectoryPoint = lambda: SimpleNamespace(time_from_start=SimpleNamespace())

    def tearDown(self):
        self.env.stop()
        self.runtime_dir.cleanup()

    def sensor_snapshot(self):
        now = time.monotonic_ns()
        return {
            "imu": {
                "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                "gyro": {"x": 0.0, "y": 0.0, "z": 0.0},
                "sampleMonotonicNs": now,
            },
            "jointStates": {
                "names": list(self.module.JOINT_NAMES),
                "position": list(self.module.HOME_POSITION),
                "velocity": [0.0] * 14,
                "sampleMonotonicNs": now,
            },
        }

    def infer(self, _outputs, feeds):
        self.inputs.append(feeds["observation"].copy())
        return [np.full((1, 14), 0.5, dtype=np.float32)]

    def start_without_thread(self, *args, **kwargs):
        with patch.object(self.module.threading, "Thread") as thread, \
                patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot):
            result = self.runtime.start(*args, **kwargs)
        return result, thread

    def run_one_tick(self):
        self.runtime._stop_flag.clear()
        with patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot), \
                patch.object(self.module.time, "sleep", side_effect=lambda _seconds: self.runtime._stop_flag.set()):
            self.runtime._loop()

    def test_legacy_nonzero_direction_is_refused_instead_of_ignored(self):
        result, thread = self.start_without_thread(1.0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "unsupported-joint-command")
        self.assertEqual(self.runtime._state, "ready")
        thread.assert_not_called()

    def test_twist_reaches_exact_evaluator_command_slots(self):
        observation = self.module.build_joint_observation(
            self.sensor_snapshot(), command={"linearX": 0.04, "linearY": -0.01, "angularZ": 0.3}
        )
        self.assertEqual(len(observation), 61)
        self.assertEqual(observation[48:51], [0.04, -0.01, 0.3])
        self.assertEqual(observation[51:], [0.0] * 10)

    def test_command_update_reaches_next_inference_and_zero_stops_gait(self):
        self.start_without_thread()
        with patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot):
            result = self.runtime.set_command({"linearX": 0.04, "angularZ": -0.3}, 1.0)
        self.assertTrue(result["ok"])
        self.run_one_tick()
        np.testing.assert_allclose(self.inputs[-1][0, 48:51], [0.04, 0.0, -0.3])
        self.runtime._stop_flag.clear()
        result = self.runtime.set_command({"linearX": 0.0, "angularZ": 0.0}, 1.0)
        self.assertTrue(result["ok"])
        self.run_one_tick()
        np.testing.assert_array_equal(self.inputs[-1][0, 48:], np.zeros(13))

    def test_stop_during_inference_cannot_publish_a_later_policy_action(self):
        self.start_without_thread()

        def stop_during_infer(outputs, feeds):
            self.runtime.stop("test-stop-during-inference")
            return self.infer(outputs, feeds)

        self.runtime._model.run = stop_during_infer
        self.run_one_tick()
        self.assertEqual(self.runtime._published, 0)
        self.assertEqual(len(self.frames), 1)
        self.assertEqual(self.frames[0].points[0].positions, list(self.module.HOME_POSITION))

    def test_old_inference_loop_cannot_join_a_new_session_after_restart(self):
        self.start_without_thread()
        first_session = self.runtime._session_id

        def restart_during_infer(outputs, feeds):
            if not self.inputs:
                self.runtime.stop("test-stop-before-restart")
                # Loading a model marks the stopped runtime ready again. Avoid
                # ONNX/ROS imports while exercising the restart lifecycle.
                self.runtime._state = "ready"
                self.start_without_thread()
            return self.infer(outputs, feeds)

        self.runtime._model.run = restart_during_infer
        self.run_one_tick()
        self.assertNotEqual(self.runtime._session_id, first_session)
        self.assertEqual(len(self.inputs), 1)
        self.assertEqual(self.runtime._published, 0)
        self.assertEqual(len(self.frames), 1)

    def test_zero_legacy_start_is_compatible_and_defaults_to_standing(self):
        result, thread = self.start_without_thread(0.0)
        self.assertTrue(result["ok"])
        thread.assert_called_once()
        self.run_one_tick()
        np.testing.assert_array_equal(self.inputs[-1][0, 48:], np.zeros(13))
        status = self.runtime.snapshot()
        self.assertEqual(status["command"], dict.fromkeys(self.module.COMMAND_KEYS, 0.0))
        self.assertIsNone(self.runtime._command_deadline)
        self.assertTrue(status["sensorFresh"])

    def test_start_accepts_an_explicit_bounded_twist(self):
        result, _thread = self.start_without_thread(
            command={"linearX": 0.04, "angularZ": 0.25}, duration_sec=0.2
        )
        self.assertTrue(result["ok"])
        self.run_one_tick()
        np.testing.assert_allclose(self.inputs[-1][0, 48:51], [0.04, 0.0, 0.25])

    def test_start_rejects_nonzero_or_ambiguous_legacy_commands(self):
        for direction, goal_x, goal_y in [(True, None, None), ("0", None, None),
                                           (float("nan"), None, None), (0, 0, 1)]:
            with self.subTest(direction=direction, goal=(goal_x, goal_y)):
                result, thread = self.start_without_thread(direction, goal_x, goal_y)
                self.assertEqual(result["error"], "unsupported-joint-command")
                thread.assert_not_called()

    def test_malformed_commands_never_replace_the_current_twist(self):
        self.start_without_thread()
        invalid = [None, [], {"linearX": True}, {"linearX": "0.03"},
                   {"linearX": float("inf")}, {"angularZ": float("nan")},
                   {"speed": 0.03}, {"linearX": 0.051}, {"angularZ": 1.01},
                   {"linearX": 0.05, "linearY": 0.05}]
        for command in invalid:
            with self.subTest(command=command):
                result = self.runtime.set_command(command)
                self.assertFalse(result["ok"])
                self.assertEqual(self.runtime._command, dict.fromkeys(self.module.COMMAND_KEYS, 0.0))
                self.assertIsNone(self.runtime._command_deadline)

    def test_out_of_range_durations_do_not_authorize_motion(self):
        self.start_without_thread()
        for duration in [True, None, "1", float("inf"), float("nan"), 0.199, 2.001]:
            with self.subTest(duration=duration):
                result = self.runtime.set_command({"linearX": 0.04}, duration)
                self.assertEqual(result["error"], "joint-command-duration-invalid")
                self.assertEqual(self.runtime._command["linearX"], 0.0)

    def test_command_only_updates_running_sessions(self):
        with patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot):
            result = self.runtime.set_command({"linearX": 0.03})
        self.assertEqual(result["error"], "not-running")
        self.assertEqual(self.runtime._state, "ready")
        self.assertEqual(self.runtime._command["linearX"], 0.0)

    def test_sensors_must_be_fresh_before_authorizing_nonzero_twist(self):
        self.start_without_thread()
        with patch.object(self.module, "_read_snapshot", return_value=None):
            result = self.runtime.set_command({"linearX": 0.03})
        self.assertEqual(result["error"], "joint-sensors-not-ready")
        self.assertFalse(self.runtime.snapshot()["sensorFresh"])
        self.assertEqual(self.runtime._command_stop_reason, "sensor-stale")
        self.assertTrue(self.runtime.set_command({})["ok"])

    def test_command_window_expiry_feeds_zero_and_requires_a_new_command(self):
        self.start_without_thread()
        with patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot), \
                patch.object(self.module.time, "monotonic", return_value=100.0):
            self.assertTrue(self.runtime.set_command({"linearX": 0.03}, 0.2)["ok"])
        with patch.object(self.module.time, "monotonic", return_value=100.201):
            self.run_one_tick()
        np.testing.assert_array_equal(self.inputs[-1][0, 48:], np.zeros(13))
        self.assertEqual(self.runtime._command_stop_reason, "command-window-expired")
        self.assertIsNone(self.runtime._command_deadline)
        self.run_one_tick()
        np.testing.assert_array_equal(self.inputs[-1][0, 48:], np.zeros(13))

    def test_expiry_during_inference_discards_the_expired_action(self):
        self.start_without_thread()
        clock = [100.0]

        def advance_clock(_outputs, feeds):
            self.inputs.append(feeds["observation"].copy())
            moving = bool(feeds["observation"][0, 48])
            if moving:
                clock[0] += 0.3
            return [np.full((1, 14), 0.5 if moving else 0.0, dtype=np.float32)]

        self.runtime._model.run = advance_clock
        with patch.object(self.module.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot):
            self.assertTrue(self.runtime.set_command({"linearX": 0.03}, 0.2)["ok"])
            self.run_one_tick()
        self.assertEqual(len(self.inputs), 2)
        self.assertEqual(self.runtime._published, 1)
        self.assertEqual(len(self.frames), 1)
        self.assertEqual(self.frames[0].points[0].positions, list(self.module.HOME_POSITION))

    def test_sensor_loss_holds_target_and_does_not_resume_the_old_twist(self):
        self.start_without_thread()
        held = [value + 0.01 for value in self.module.HOME_POSITION]
        self.runtime._last_target = list(held)
        with patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot):
            self.assertTrue(self.runtime.set_command({"linearX": 0.04})["ok"])
        with patch.object(self.module, "_read_snapshot", return_value=None), \
                patch.object(self.module.time, "sleep", side_effect=lambda _seconds: self.runtime._stop_flag.set()):
            self.runtime._loop()
        self.assertEqual(len(self.inputs), 0)
        self.assertEqual(self.frames[-1].points[0].positions, held)
        self.assertEqual(self.runtime._command_stop_reason, "sensor-stale")
        self.assertFalse(self.runtime.snapshot()["sensorFresh"])
        self.run_one_tick()
        np.testing.assert_array_equal(self.inputs[-1][0, 48:], np.zeros(13))
        self.assertTrue(self.runtime.snapshot()["sensorFresh"])

    def test_stop_clears_twist_preserves_last_target_and_reports_hold_semantics(self):
        self.start_without_thread()
        held = [value + 0.01 for value in self.module.HOME_POSITION]
        self.runtime._last_target = list(held)
        with patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot):
            self.runtime.set_command({"linearX": 0.03})
        self.runtime.stop("operator-stop")
        status = self.runtime.snapshot()
        self.assertEqual(status["command"], dict.fromkeys(self.module.COMMAND_KEYS, 0.0))
        self.assertEqual(status["lastTargetRad"], held)
        self.assertEqual(status["stopBehavior"], "hold-last-bounded-target")
        self.assertEqual(status["commandStopReason"], "operator-stop")
        self.assertEqual(self.frames[-1].points[0].positions, held)

    def test_fault_clears_twist_and_preserves_the_bounded_target(self):
        self.start_without_thread()
        with patch.object(self.module, "_read_snapshot", side_effect=self.sensor_snapshot):
            self.runtime.set_command({"linearX": 0.03})
        self.runtime._fault("invalid-action")
        self.assertEqual(self.runtime._state, "fault")
        self.assertEqual(self.runtime._command, dict.fromkeys(self.module.COMMAND_KEYS, 0.0))
        self.assertEqual(self.runtime._command_stop_reason, "fault:invalid-action")
        self.assertTrue(self.runtime._stop_flag.is_set())

    def test_limits_never_exceed_platform_ceiling_or_accept_malformed_adapter_values(self):
        with patch.dict(self.module.SAFETY, {"maxLinear": 9.0, "maxAngular": 9.0}):
            self.assertEqual(self.module._command_limit("maxLinear", 0.05, 0.3), 0.3)
            self.assertEqual(self.module._command_limit("maxAngular", 1.0, 1.0), 1.0)
        for value in [True, "0.3", float("nan"), -1.0]:
            with self.subTest(value=value), patch.dict(self.module.SAFETY, {"maxLinear": value}):
                self.assertEqual(self.module._command_limit("maxLinear", 0.05, 0.3), 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
