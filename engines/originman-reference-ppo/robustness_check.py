#!/usr/bin/env python3
"""Compare a retained OriginMan policy and its baseline under simulation changes."""

import argparse
from concurrent.futures import ProcessPoolExecutor
from functools import lru_cache
import hashlib
import importlib.util
import json
import math
import multiprocessing
from pathlib import Path
import platform

import mujoco
import numpy as np
import onnxruntime as ort


@lru_cache
def reference_engine():
    spec = importlib.util.spec_from_file_location(
        "originman_reference_engine", Path(__file__).with_name("adapter.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def compare(task):
    candidates, bundle, record, nominal_lag, nominal_friction = task
    engine = reference_engine()
    preset = record["preset"]
    directory = candidates / f"preset{preset}"
    policy = (directory / "policy.onnx").read_bytes()
    raw = (directory / "reference.json").read_bytes()
    trajectory = json.loads(raw)
    if (sha256(policy) != record["modelSha256"]
            or sha256(raw) != record["trajectoryFileSha256"]
            or engine.trajectory_digest(trajectory) != record["trajectorySha256"]):
        raise ValueError(f"Preset {preset}: model or reference differs from the candidate manifest")

    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    session = ort.InferenceSession(policy, sess_options=options, providers=["CPUExecutionProvider"])
    metadata = session.get_modelmeta().custom_metadata_map
    trained_lead = record["referenceLeadFrames"]
    expected = engine.policy_metadata(engine.CONTRACT, record["sceneSha256"], engine.TRACKED)
    if (any(metadata.get(key) != value for key, value in expected.items())
            or metadata.get("rdk.reference.lead_frames", "0") != str(trained_lead)
            or [(node.name, node.shape, node.type) for node in session.get_inputs()]
            != [("observation", [1, 78], "tensor(float)")]
            or [(node.name, node.shape, node.type) for node in session.get_outputs()]
            != [("action", [1, 18], "tensor(float)")]):
        raise ValueError(f"Preset {preset}: ONNX metadata or I/O contract differs from training")

    def predict(observation):
        return session.run(["action"], {"observation": observation[None, :]})[0][0]

    env = engine.ReferenceTracking(
        bundle, engine.validate_trajectory(trajectory), stance_profile=record["stanceProfile"],
        contract_id=engine.CONTRACT, bpm=record["bpm"],
    )
    # 120 ms is the RL pack/current simulation value. 200 ms is the value in
    # originman-env 1.0.0. The reduced friction case is a sensitivity probe.
    slower_actuator_lag_s = 0.2
    scenarios = [
        ("nominal", nominal_lag, trained_lead, nominal_friction),
        ("env-1.0.0-lag", slower_actuator_lag_s, trained_lead, nominal_friction),
        ("env-1.0.0-lag-with-matched-lead", slower_actuator_lag_s,
         round(slower_actuator_lag_s * engine.HZ), nominal_friction),
        ("reduced-sliding-friction", nominal_lag, trained_lead, 0.8 * nominal_friction),
        ("rotating-joint-readback", nominal_lag, trained_lead, nominal_friction),
    ]
    contact_geoms = np.flatnonzero(env.model.geom_contype | env.model.geom_conaffinity)
    servo_order = engine.PROFILE["robot"]["servoOrder"]
    if len(servo_order) != len(engine.TRACKED) or set(servo_order) != set(engine.TRACKED):
        raise ValueError("The calibration servo order does not cover every policy joint")
    joint_slots = np.array([engine.TRACKED.index(joint) for joint in servo_order])
    # The reference v2 contract packs 18 positions and 18 velocities after
    # gravity, gyro and beat fields. Keep the simulated reference clock live.
    readback_slots = [
        np.r_[11 + group, 29 + group] for group in np.split(joint_slots, 3)
    ]

    def predict_with_rotating_readback(observation):
        nonlocal cached_observation
        if env.tick == 0:
            cached_observation = observation.copy()
        if env.tick % 2 == 0:
            slots = readback_slots[(env.tick // 2) % len(readback_slots)]
            cached_observation[slots] = observation[slots]
        delayed = observation.copy()
        delayed[11:47] = cached_observation[11:47]
        return predict(delayed)

    results = []
    for name, lag, lead, friction in scenarios:
        env.lag_mix = -math.expm1(-engine.DT / lag)
        env.reference_lead_frames = lead
        env.model.geom_friction[contact_geoms, 0] = friction
        if name == "rotating-joint-readback":
            # The no-residual baseline ignores observations. The other
            # simulation parameters are identical to the nominal case.
            baseline = results[0]["baseline"]
            cached_observation = None
            trained, _ = engine.evaluate(env, predict_with_rotating_readback)
        else:
            baseline, _ = engine.evaluate(env, lambda _: np.zeros(18))
            trained, _ = engine.evaluate(env, predict)
        both_complete = baseline["completed"] and trained["completed"]
        results.append({
            "scenario": name, "lagSeconds": lag, "leadFrames": lead, "slidingFriction": friction,
            "baseline": baseline, "ppo": trained,
            "ppoImprovementPercent": (
                100 * (1 - trained["trackingRmseRad"] / baseline["trackingRmseRad"])
                if both_complete and baseline["trackingRmseRad"] > 0 else None
            ),
        })
        if name == "nominal" and (
            not trained["qualityGatePassed"] or not baseline["qualityGatePassed"]
            or abs(trained["trackingRmseRad"] - record["ppoRmseRad"]) >= 1e-5
        ):
            raise ValueError(f"Preset {preset}: nominal replay did not reproduce the acceptance result")
    return {
        "preset": preset, "policySha256": record["modelSha256"],
        "trajectorySha256": record["trajectorySha256"], "scenarios": results,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--preset", action="append", type=int)
    parser.add_argument("--workers", default=1, type=int)
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers must be positive")
    manifest = json.loads((args.candidates / "manifest.json").read_text())
    engine = reference_engine()
    if (manifest["robot"] != "OriginMan" or manifest["contractId"] != engine.CONTRACT
            or manifest["controlHz"] != engine.HZ or manifest["actionJoints"] != engine.TRACKED):
        parser.error("expected an OriginMan reference v2 candidate bundle")
    if any(type(row["preset"]) is not int or row["preset"] < 1 for row in manifest["policies"]):
        parser.error("preset IDs must be positive integers")
    scene = engine.validate_bundle(args.bundle)["sceneSha256"]
    records = [row for row in manifest["policies"] if not args.preset or row["preset"] in args.preset]
    if not records or (args.preset and set(args.preset) != {row["preset"] for row in records}):
        parser.error("one or more requested presets are missing")
    for row in records:
        stance = row["stanceProfile"]
        calibration = engine.PROFILE_PATH.read_bytes()
        if stance:
            calibration += b"\0" + stance.encode()
        if row["sceneSha256"] != scene or sha256(calibration) != row["calibrationSha256"]:
            parser.error(f"preset {row['preset']} does not match the scene and calibration")
    sim = engine.PROFILE["simulation"]
    tasks = [(args.candidates, args.bundle, row, sim["lagSeconds"], sim["friction"][0]) for row in records]
    result = []
    with ProcessPoolExecutor(max_workers=args.workers, mp_context=multiprocessing.get_context("spawn")) as pool:
        for row in pool.map(compare, tasks):
            result.append(row)
            print(f"Preset {row['preset']}: " + ", ".join(
                f"{case['scenario']}={case['ppo']['qualityGatePassed']}"
                for case in row["scenarios"]
            ), flush=True)
    receipt = {
        "schemaVersion": 1, "simulationOnly": True, "authorizesDeployment": False,
        "sceneSha256": scene, "controlHz": engine.HZ,
        "runtime": {"mujoco": mujoco.__version__, "onnxruntime": ort.__version__, "architecture": platform.machine()},
        "presets": result,
    }
    with args.report.open("x") as report:
        json.dump(receipt, report, allow_nan=False, indent=2)
        report.write("\n")


if __name__ == "__main__":
    main()
