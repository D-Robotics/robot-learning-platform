"""Phase tables from the published simulations, adapted to continuous choreography."""

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

MESH_SCENE = "bfc52f6ebd4ecdb81f1e62dc4ec337c268aff3f89760c29ebafcab33c94cd7f8"
SOURCE_SCENE = "eac60475eb622c2731b36d9957a0c0445f8b00d4d588de7b1b4f25d518a56ad4"
SOURCE_DIR = Path(__file__).resolve().parents[2] / "services/sim2real-web/public/originman-dance-references"

# These coefficients were fitted in the mesh scene over two 4-beat cycles.
# They preserve swing phase and use torso inclination and angular rate to
# avoid carrying the first landing's rotation into the next lift.
PHASE_WARP = (-0.1079583069, -0.0216998225)
LEG_GAIN = np.array([1.00582115796, .81611703724, .81160151777, 1.13322949959, .90331515707] * 2)
ARM_GAIN = .79130528815
TRANSITION_WARP = (-.06720685899, .05325341140)
TRANSITION_LEG_GAIN = np.array([.84195451614, 1.03117908614, 1.09669828021, .96879432141, .91970304729] * 2)
TRANSITION_ARM_GAIN = .88522165657
TRANSITION_FEEDBACK_GAIN = 1.24269427052
HIP_PITCH_FEEDBACK = (-.30292234568, .13805969247)
HIP_ROLL_FEEDBACK = (.05551048361, .20024331155)
ANKLE_PITCH_FEEDBACK = 1.09334880902
ANKLE_ROLL_FEEDBACK = -1.06359704184


def load_phase_table(kind):
    directory = SOURCE_DIR / kind
    metadata = json.loads((directory / "verification.json").read_text())
    policy = (directory / "policy.onnx").read_bytes()
    if (metadata.get("sceneSha256") != SOURCE_SCENE or metadata.get("action") != kind
            or metadata.get("contractId") != "custom-policy-originman-dance-v2"
            or hashlib.sha256(policy).hexdigest() != metadata.get("policySha256")):
        raise ValueError(f"invalid phase table provenance for {kind}")
    graph = onnx.load_from_string(policy).graph
    table = next((numpy_helper.to_array(item) for item in graph.initializer if item.name == "commands"), None)
    if table is None or table.shape != (1025, 18) or not np.isfinite(table).all():
        raise ValueError(f"invalid phase table commands for {kind}")
    sections = metadata.get("config", {}).get("sections", [])
    if len(sections) != 1 or sections[0].get("type") != kind or sections[0].get("beats") != 4:
        raise ValueError(f"invalid phase table section for {kind}")
    return table, sections[0]["intensity"]


def sample_table(table, phase):
    position = float(np.clip(phase / 4, 0, 1)) * (len(table) - 1)
    index = min(int(position), len(table) - 2)
    return table[index] + (position - index) * (table[index + 1] - table[index])


def knee_cycle(table, phase):
    # The second retiming accounts for the body entering from a preceding move.
    side = math.sin(math.pi * phase / 2)
    lift = math.sin(math.pi * (phase % 2) / 2) ** 2
    shifted = phase + TRANSITION_WARP[0] * side + TRANSITION_WARP[1] * math.sin(math.pi * phase)
    warped = shifted + PHASE_WARP[0] * math.sin(math.pi * shifted / 2) + PHASE_WARP[1] * math.sin(math.pi * shifted)
    action = sample_table(table, warped)
    action[:10] *= LEG_GAIN
    action[10:] *= ARM_GAIN
    shifted_side = math.sin(math.pi * shifted / 2)
    shifted_lift = math.sin(math.pi * (shifted % 2) / 2) ** 2
    action[[0, 5]] += -.0125604365 * shifted_side
    action[[4, 9]] += .12067424134 * shifted_side
    action[[1, 6]] += -.21047969323 * (1 - shifted_lift)
    action[[3, 8]] += -.03424324203 * shifted_lift - .05316991112 * (1 - shifted_lift)
    action[[2, 7]] += -.06596608319 * shifted_lift
    action[:10] *= TRANSITION_LEG_GAIN
    action[10:] *= TRANSITION_ARM_GAIN
    action[[2, 7]] -= .02215924398 * lift
    action[[3, 8]] += .07580064138 * lift
    action[[1, 6]] -= .04789892830 * lift
    action[[0, 5]] -= .03153814521 * side
    action[[4, 9]] += .03581487568 * side
    return action


def knee_feedback():
    correction = np.zeros((18, 6), dtype=np.float32)
    correction[[1, 6], 0] = HIP_PITCH_FEEDBACK[0]
    correction[[1, 6], 4] = HIP_PITCH_FEEDBACK[1]
    correction[[3, 8]] = ANKLE_PITCH_FEEDBACK * correction[[1, 6]]
    correction[[0, 5], 1] = HIP_ROLL_FEEDBACK[0]
    correction[[0, 5], 3] = HIP_ROLL_FEEDBACK[1]
    correction[[4, 9]] = ANKLE_ROLL_FEEDBACK * correction[[0, 5]]
    return TRANSITION_FEEDBACK_GAIN * correction
