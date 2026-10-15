#!/usr/bin/env python3
"""Pure contract/safety checks for the MicroDuck joint policy runtime."""

import importlib.util
import json
import math
import os
import pathlib
import tempfile
import time
from types import SimpleNamespace
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIME_PATH = ROOT / "services" / "sim2real-web" / "board-joint-policy-runtime.py"
ADAPTER_PATH = ROOT / "adapters" / "microduck-leg.json"


def load_runtime():
    with tempfile.TemporaryDirectory(prefix="microduck-runtime-") as runtime_dir:
        os.chmod(runtime_dir, 0o700)
        os.environ["RDK_BOARD_RUNTIME_DIR"] = runtime_dir
        os.environ["RDK_SIM2REAL_ADAPTER_CONFIG"] = str(ADAPTER_PATH)
        spec = importlib.util.spec_from_file_location("microduck_joint_runtime_test", RUNTIME_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        yield module


def main():
    runtime_iter = load_runtime()
    module = next(runtime_iter)
    now = time.monotonic_ns()
    snapshot = {
        "imu": {
            "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
            "gyro": {"x": 0.1, "y": -0.2, "z": 0.3},
            "sampleMonotonicNs": now,
        },
        "jointStates": {
            "names": list(reversed(module.JOINT_NAMES)),
            "position": list(reversed([0.1 * index for index in range(14)])),
            "velocity": list(reversed([0.01 * index for index in range(14)])),
            "sampleMonotonicNs": now,
        },
    }
    observation = module.build_joint_observation(snapshot, module.JOINT_NAMES, module.HOME_POSITION)
    assert observation is not None and len(observation) == 61
    assert observation[:3] == [0.1, -0.2, 0.3]
    assert all(value == value and abs(value) != float("inf") for value in observation)
    stale = json.loads(json.dumps(snapshot))
    stale["imu"]["sampleMonotonicNs"] = time.monotonic_ns() - 2_000_000_000
    assert module.build_joint_observation(stale, module.JOINT_NAMES, module.HOME_POSITION) is None
    target = module.project_joint_action([10.0] * 14, module.HOME_POSITION, 0.35)
    assert len(target) == 14
    assert max(abs(target[index] - module.HOME_POSITION[index]) for index in range(14)) <= 0.04 + 1e-9
    limited = module.project_joint_action(
        [-1.0] * 14,
        module.HOME_POSITION,
        0.35,
        previous_target=target,
        max_step=0.08,
        max_velocity=2.0,
        decision_hz=50,
    )
    assert max(abs(limited[index] - target[index]) for index in range(14)) <= 0.04 + 1e-9
    command = {"vx": 0.03, "vy": -0.02, "wz": 0.4, "ttlMs": 200}
    commanded = module.build_joint_observation(
        snapshot, module.JOINT_NAMES, module.HOME_POSITION, command=[0.03, -0.02, 0.4]
    )
    assert commanded is not None and commanded[48:51] == [0.03, -0.02, 0.4]
    assert commanded[51:] == [0.0] * 10
    assert module.build_joint_observation(snapshot, command=[float("nan"), 0.0, 0.0]) is None
    clock = [10_000_000_000]
    runtime = module.JointPolicyRuntime()
    runtime._model = object()
    runtime._publisher = object()
    runtime._state = "ready"
    with mock.patch.object(module.threading.Thread, "start"), \
            mock.patch.object(module.time, "monotonic_ns", side_effect=lambda: clock[0]), \
            mock.patch.object(runtime, "_write_state"), \
            mock.patch.object(runtime, "_publish_target") as publish:
        # A reference profile cannot become motion-capable simply because
        # the caller enabled all switches or used an all-zero command.
        refused = runtime.start(command=command)
        assert refused.get("error") == "joint-profile-not-calibrated", refused
        calibrated = {**module.ADAPTER, "provenance": {"kind": "real", "mock": False}}
        with mock.patch.object(module, "ADAPTER", calibrated):
            assert runtime.start(1.0).get("ok")  # historical direction stays standing
            assert runtime.snapshot()["command"] == {"vx": 0.0, "vy": 0.0, "wz": 0.0}
            assert runtime.set_command(command).get("ok")
            assert runtime.snapshot()["command"] == {"vx": 0.03, "vy": -0.02, "wz": 0.4}
            clock[0] += 200_000_000
            assert runtime.snapshot()["command"] == {"vx": 0.0, "vy": 0.0, "wz": 0.0}
            assert runtime.snapshot()["commandExpired"] is True
            assert runtime.set_command(command).get("ok")
            clock[0] += 100_000_000
            assert runtime.snapshot()["command"]["vx"] == 0.03
            for invalid in ({"vx": 1}, {**command, "vy": True}, {**command, "wz": "1"},
                            {**command, "vx": float("nan")}, {**command, "ttlMs": 0},
                            {**command, "ttlMs": 2001}, {**command, "ttlMs": 1.5}):
                assert runtime.set_command(invalid).get("error") == "invalid-command", invalid
                assert runtime.snapshot()["command"] == {"vx": 0.0, "vy": 0.0, "wz": 0.0}
            assert runtime.set_command({"vx": 10.0, "vy": 10.0, "wz": -10.0, "ttlMs": 2000}).get("ok")
            bounded = runtime.snapshot()
            assert math.hypot(bounded["command"]["vx"], bounded["command"]["vy"]) <= 0.05 + 1e-9
            assert bounded["command"]["wz"] == -1.0
            assert bounded["commandTtlMs"] == 500
            # A delayed IPC request must not earn a fresh lease on receipt.
            assert runtime.set_command(command, issued_monotonic_ns=clock[0] - 300_000_000).get("error") == "command-expired"
            assert runtime.snapshot()["command"] == {"vx": 0.0, "vy": 0.0, "wz": 0.0}
            assert runtime.set_command(command).get("ok")
            runtime.stop()
            assert runtime.snapshot()["command"] == {"vx": 0.0, "vy": 0.0, "wz": 0.0}
            assert runtime.set_command(command).get("error") == "not-running"
            runtime._state = "ready"
            assert runtime.start(command=command).get("ok")
            runtime._fault("test")
            assert runtime.snapshot()["command"] == {"vx": 0.0, "vy": 0.0, "wz": 0.0}
            runtime._state = "ready"
            assert runtime.start(command=command).get("ok")
            fresh = json.loads(json.dumps(snapshot))
            fresh["imu"]["sampleMonotonicNs"] = clock[0]
            fresh["jointStates"]["sampleMonotonicNs"] = clock[0]
            runtime._input_name = "obs"
            infer = mock.Mock(return_value=[[[0.0] * 14]])
            runtime._model = SimpleNamespace(run=infer)
            fake_numpy = SimpleNamespace(asarray=lambda value, dtype: value, float32="float32")
            with mock.patch.dict("sys.modules", {"numpy": fake_numpy}), \
                    mock.patch.object(module, "_read_snapshot", return_value=fresh), \
                    mock.patch.object(module.time, "sleep", side_effect=lambda _delay: runtime._stop_flag.set()):
                publish.reset_mock()
                runtime._loop()
                assert infer.call_args[0][1]["obs"][0][48:51] == [0.03, -0.02, 0.4]
                assert publish.call_count == 1  # simulated publish only
                runtime._state = "running"
                runtime._stop_flag.clear()

                def expire_during_inference(*_args):
                    clock[0] += 200_000_000
                    return [[[0.0] * 14]]

                infer.side_effect = expire_during_inference
                publish.reset_mock()
                runtime._loop()
                assert publish.call_count == 0  # discard the expired command's late result
                assert runtime.snapshot()["command"] == {"vx": 0.0, "vy": 0.0, "wz": 0.0}
                runtime._stop_flag.clear()
                fresh["imu"]["sampleMonotonicNs"] = clock[0]
                fresh["jointStates"]["sampleMonotonicNs"] = clock[0]

                def stop_during_inference(*_args):
                    runtime.stop()
                    return [[[0.0] * 14]]

                infer.side_effect = stop_during_inference
                publish.reset_mock()
                runtime._loop()
                # stop's held target is the only publish; the late ONNX
                # result cannot supersede it after the stop has returned.
                assert publish.call_count == 1
                assert runtime.snapshot()["command"] == {"vx": 0.0, "vy": 0.0, "wz": 0.0}
        assert module.apply_request(runtime, {"op": "command", "command": command}).get("error") == "command-timestamp-required"
    print("[joint-policy-runtime] PASS — observation, command leases/clamps/stop, template refusal and IPC freshness")


if __name__ == "__main__":
    main()
