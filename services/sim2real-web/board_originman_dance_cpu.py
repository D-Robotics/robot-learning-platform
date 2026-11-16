"""Run one disposable OriginMan policy rehearsal without opening hardware interfaces."""

import base64
import binascii
import hashlib
import math
import re
import tempfile
import time
from pathlib import Path
from threading import Lock

CONTRACT = "custom-policy-originman-dance-v2"
# Audited OriginMan dance scene. Other scenes may enumerate actuators differently.
SCENE_SHA256 = "eac60475eb622c2731b36d9957a0c0445f8b00d4d588de7b1b4f25d518a56ad4"
MAX_ARTIFACT_BYTES = 512 * 1024
MAX_REQUEST_BYTES = (MAX_ARTIFACT_BYTES + 2) // 3 * 4 + 1024
CONTROL_HZ = 50
CYCLES = 100
PERIOD_NS = 1_000_000_000 // CONTROL_HZ
OBSERVATION_LAYOUT = (
    ("projected_gravity_and_body_gyro", 6),
    ("beat_phase_phrase_and_bpm", 5),
    ("joint_position_error", 18),
    ("joint_velocity", 18),
    ("previous_joint_action", 18),
    ("dance_section_one_hot_8", 8),
    ("section_progress_alternation_phase_and_hold", 5),
)
ACTION_LAYOUT = (
    "l_hip_roll", "l_hip_pitch", "l_knee", "l_ank_pitch", "l_ank_roll",
    "r_hip_roll", "r_hip_pitch", "r_knee", "r_ank_pitch", "r_ank_roll",
    "l_sho_pitch", "l_sho_roll", "l_el", "l_hand",
    "r_sho_pitch", "r_sho_roll", "r_el", "r_hand",
)
REHEARSAL_LOCK = Lock()


def _summary_ms(samples):
    ordered = sorted(samples)
    return {
        "p95": round(ordered[math.ceil(len(ordered) * 0.95) - 1] / 1e6, 4),
        "p99": round(ordered[math.ceil(len(ordered) * 0.99) - 1] / 1e6, 4),
        "max": round(ordered[-1] / 1e6, 4),
    }


def _compute(path):
    import numpy as np
    import onnxruntime as ort

    width = sum(size for _, size in OBSERVATION_LAYOUT)
    action_size = len(ACTION_LAYOUT)
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    try:
        # Loading the verified bytes prevents the model from referencing
        # external tensor files by a relative path on the board.
        session = ort.InferenceSession(path.read_bytes(), sess_options=options,
                                       providers=["CPUExecutionProvider"])
    except Exception as exc:
        raise ValueError("ONNX Runtime rejected the model") from exc
    input_node, *additional_inputs = session.get_inputs()
    output_node, *additional_outputs = session.get_outputs()
    if (additional_inputs or additional_outputs
            or (input_node.name, input_node.type, input_node.shape)
            != ("observation", "tensor(float)", [1, width])
            or (output_node.name, output_node.type, output_node.shape)
            != ("action", "tensor(float)", [1, action_size])):
        raise ValueError("unexpected OriginMan dance ONNX input or output")

    def infer(observation):
        start = time.perf_counter_ns()
        try:
            action, = session.run(["action"], {"observation": observation})
        except Exception as exc:
            raise ValueError("ONNX Runtime inference failed") from exc
        elapsed = time.perf_counter_ns() - start
        if action.shape != (1, action_size) or not np.isfinite(action).all():
            raise ValueError("invalid OriginMan action")
        return action[0], elapsed

    # Synthetic upright observation, a 116 BPM beat, and gradual prior
    # actions. This exercises the tensor and policy loop without reading IMU,
    # opening a serial port, or constructing an actuator command.
    obs = np.zeros((1, width), dtype=np.float32)
    obs[0, 2] = 1
    obs[0, 65] = 1
    action = np.zeros(action_size, dtype=np.float32)
    observation_features = obs[0]
    infer(obs)
    latencies, tick_times, lateness = [], [], []
    missed = 0
    start = time.perf_counter_ns()
    for tick in range(CYCLES):
        due = start + tick * PERIOD_NS
        remaining = due - time.perf_counter_ns()
        if remaining > 0:
            time.sleep(remaining / 1e9)
        actual_start = time.perf_counter_ns()
        beat = tick / CONTROL_HZ * 116 / 60
        fraction = beat / 8
        observation_features[6:10] = (math.sin(2 * math.pi * beat), math.cos(2 * math.pi * beat),
                                      math.sin(2 * math.pi * fraction), math.cos(2 * math.pi * fraction))
        observation_features[73:78] = (math.sin(2 * math.pi * fraction), math.cos(2 * math.pi * fraction),
                                       math.sin(math.pi * beat), math.cos(math.pi * beat), 0)
        observation_features[47:65] = action
        raw_action, elapsed = infer(obs)
        action += np.clip(np.clip(raw_action, -1, 1) - action, -.20, .20)
        end = time.perf_counter_ns()
        latencies.append(elapsed)
        tick_times.append(end - actual_start)
        lateness.append(max(0, actual_start - due))
        missed += end > due + PERIOD_NS

    return {
        "runtime": {"name": "onnxruntime", "version": ort.__version__, "provider": "CPUExecutionProvider", "threads": 1},
        "observation": {"size": width, "source": "synthetic", "layout": [
            {"name": name, "size": size} for name, size in OBSERVATION_LAYOUT
        ], "physicalSensorsVerified": False},
        "action": {"size": action_size, "layout": [
            {"index": index, "simulatorJoint": name} for index, name in enumerate(ACTION_LAYOUT)
        ], "physicalServoMappingVerified": False, "sent": 0},
        "timing": {
            "targetHz": CONTROL_HZ, "periodMs": PERIOD_NS / 1e6, "cycles": CYCLES,
            "inferenceMs": _summary_ms(latencies), "workMs": _summary_ms(tick_times),
            "startJitterMs": _summary_ms(lateness), "deadlineMisses": missed,
            "syntheticCyclePassed": missed == 0, "physicalControlCycleVerified": False,
        },
    }


def rehearse(payload):
    digest = payload.get("sha256")
    encoded = payload.get("bytesBase64")
    if (payload.get("contractId") != CONTRACT or payload.get("sceneSha256") != SCENE_SHA256
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or not isinstance(encoded, str) or len(encoded) > (MAX_ARTIFACT_BYTES + 2) // 3 * 4):
        return {"ok": False, "error": "ORIGINMAN_DANCE_REHEARSAL_INVALID_ARTIFACT"}
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return {"ok": False, "error": "ORIGINMAN_DANCE_REHEARSAL_INVALID_ARTIFACT"}
    if not data or len(data) > MAX_ARTIFACT_BYTES or hashlib.sha256(data).hexdigest() != digest:
        return {"ok": False, "error": "ORIGINMAN_DANCE_REHEARSAL_DIGEST_MISMATCH"}
    if not REHEARSAL_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "ORIGINMAN_DANCE_REHEARSAL_BUSY"}
    try:
        with tempfile.TemporaryDirectory(prefix="rdk-originman-dance-cpu-") as directory:
            path = Path(directory) / "policy.onnx"
            with path.open("xb") as staged:
                staged.write(data)
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                return {"ok": False, "error": "ORIGINMAN_DANCE_REHEARSAL_DIGEST_MISMATCH"}
            result = _compute(path)
    except ImportError:
        return {"ok": False, "error": "ORIGINMAN_DANCE_REHEARSAL_ONNXRUNTIME_UNAVAILABLE"}
    except (OSError, ValueError, RuntimeError) as exc:
        return {"ok": False, "error": "ORIGINMAN_DANCE_REHEARSAL_LOAD_FAILED", "detail": str(exc)[:240]}
    finally:
        REHEARSAL_LOCK.release()
    return {
        "ok": True, "contractId": CONTRACT, "sceneSha256": SCENE_SHA256, "sha256": digest,
        "bytes": len(data), "staged": True, "loaded": True, "temporaryArtifactRemoved": True,
        "authorizesDeployment": False, "motionAuthorized": False, **result,
    }
