#!/usr/bin/env python3
"""Simulated reference tracking on the existing verified OriginMan scene."""
import hashlib
import json
import math
import multiprocessing
import os
from pathlib import Path
import struct
import subprocess
import sys

import gymnasium as gym
import mujoco
import numpy as np
import onnx
from onnx.reference import ReferenceEvaluator
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import SubprocVecEnv
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engines/originman-dance-ppo"))
from adapter import read_request, validate_bundle, write_manifest, write_onnx
from env import Config, OriginManEnv
from train import WorkerProgress, resolve_training_device

TASK = "originman-reference-track"
ENGINE = "originman-reference-ppo"
CONTRACT = "custom-policy-originman-reference-v1"
PROFILE_PATH = ROOT / "plugins/rdk-robot-learning-platform/references/originman-reference-calibration.json"
PROFILE = json.loads(PROFILE_PATH.read_text())
JOINTS = PROFILE["robot"]["jointOrder"]
TRACKED = [name for name in JOINTS if not name.startswith("head_")]
HZ = PROFILE["trajectory"]["fps"]
DT = 1 / HZ
REFERENCE_DIGEST_VERSION = "originman-reference-f64be-v1"
ROLLOUT_STEPS = 4096
CHECKPOINT_STEPS = 32768


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def trajectory_digest(value):
    result = hashlib.sha256(REFERENCE_DIGEST_VERSION.encode() + b"\0")
    result.update(struct.pack(">II", value["fps"], len(value["joint_pos"])))
    for name in value["joint_names"]:
        result.update(name.encode("utf-8") + b"\0")
    for key in ("joint_pos", "joint_vel"):
        values = np.asarray(value[key], dtype=np.float64)
        canonical = np.where(values == 0, 0.0, values).astype(">f8")
        result.update(canonical.tobytes(order="C"))
    return result.hexdigest()


class ReferenceLimitError(ValueError):
    def __init__(self, violation):
        self.violation = violation
        super().__init__(
            f"joint target outside scene limits: {violation['joint']}, frame {violation['frame']}"
        )


def validate_trajectory(value):
    if (value.get("schemaVersion"), value.get("fps"), value.get("joint_names")) != (1, HZ, JOINTS):
        raise ValueError("unsupported reference trajectory format or joint order")
    pos = np.asarray(value["joint_pos"], dtype=np.float64)
    vel = np.asarray(value["joint_vel"], dtype=np.float64)
    if pos.ndim != 2 or pos.shape[1] != len(JOINTS) or not 50 <= len(pos) <= 12_000 or vel.shape != pos.shape:
        raise ValueError("trajectory arrays must have the same [50..12000, 20] shape")
    for frames, limit in ((pos, PROFILE["trajectory"]["maxAbsRad"]), (vel, PROFILE["trajectory"]["maxSpeedRadPerS"])):
        if not np.isfinite(frames).all() or np.any(np.abs(frames) > limit) or np.any(frames[:, :2]):
            raise ValueError("reference joint values exceed limits or command the head")
    if np.max(np.abs(np.diff(pos, axis=0))) * HZ > PROFILE["trajectory"]["maxSpeedRadPerS"] + 1e-4:
        raise ValueError("reference positions change faster than allowed")
    if np.max(np.abs(pos - pos[0])) < 0.05:
        raise ValueError("reference contains no motion")
    return pos[:, 2:], vel[:, 2:]


class ReferenceTracking(gym.Env):
    def __init__(self, bundle, trajectory, calibrated=True):
        self.robot = OriginManEnv(
            bundle / "model/scene.xml", Config(stride=0, lift=0, sway=0),
            reference=np.load(bundle / "reference.npy", allow_pickle=False),
        )
        self.model, self.data = self.robot.model, self.robot.data
        self.actuators = np.array([self.model.actuator(name).id for name in TRACKED])
        model_joints = self.model.actuator_trnid[self.actuators, 0]
        self.qpos = self.model.jnt_qposadr[model_joints]
        self.qvel = self.model.jnt_dofadr[model_joints]
        self.target, self.target_vel = trajectory
        self.floor = self.model.geom("ground").id
        self.feet = {self.model.geom(f"{side}_ank_roll_link_collision").id for side in ("l", "r")}
        self.lag_mix = 1.0
        self.stance = self.robot.home.copy()
        if calibrated:
            self.apply_calibration()
        self.neutral = self.stance[self.qpos]
        self.limits = self.model.actuator_ctrlrange[self.actuators]
        absolute = self.neutral + self.target
        violating = (absolute < self.limits[:, 0] - 1e-6) | (absolute > self.limits[:, 1] + 1e-6)
        if violating.any():
            frame, joint = np.argwhere(violating)[0]
            raise ReferenceLimitError({
                "joint": TRACKED[joint], "frame": int(frame) + 1,
                "targetRad": float(absolute[frame, joint]),
                "minRad": float(self.limits[joint, 0]), "maxRad": float(self.limits[joint, 1]),
                "framesOutside": int(np.any(violating, axis=1).sum()),
            })
        self.substeps = round(DT / self.model.opt.timestep)
        if not math.isclose(self.substeps * self.model.opt.timestep, DT):
            raise ValueError("scene physics step does not divide the 50 Hz control interval")
        self.action_space = gym.spaces.Box(-1, 1, (18,), dtype=np.float32)
        self.observation_space = gym.spaces.Box(-np.inf, np.inf, (96,), dtype=np.float32)

    def apply_calibration(self):
        sim = PROFILE["simulation"]
        self.stance[2] = PROFILE["robot"]["standHeightM"]
        for name, angle in PROFILE["robot"]["stanceRadOverrides"].items():
            self.stance[self.model.jnt_qposadr[self.model.joint(name).id]] = angle
        for name, actuator in zip(TRACKED, self.actuators):
            ankle_roll = name.endswith("ank_roll")
            kp = sim["kpAnkleRoll"] if ankle_roll else sim["kp"]
            kd = sim["kdAnkleRoll"] if ankle_roll else sim["kd"]
            self.model.actuator_gainprm[actuator, 0] = kp
            self.model.actuator_biasprm[actuator, 1:3] = [-kp, -kd]
            self.model.actuator_forcerange[actuator] = [-sim["effortLimit"], sim["effortLimit"]]
        for geom in range(self.model.ngeom):
            if self.model.geom_contype[geom] or self.model.geom_conaffinity[geom]:
                self.model.geom_condim[geom] = sim["condim"]
                self.model.geom_friction[geom] = sim["friction"]
        self.lag_mix = -math.expm1(-DT / sim["lagSeconds"])

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        mujoco.mj_resetData(self.model, self.data)
        self.data.qpos[:] = self.stance
        self.data.ctrl[self.actuators] = self.neutral
        self.previous = np.zeros(18)
        self.tick = 0
        mujoco.mj_forward(self.model, self.data)
        return self.observe(), {}

    def observe(self):
        frame = min(self.tick, len(self.target) - 1)
        rotation, _ = self.robot.orientation()
        return np.r_[rotation[2], self.data.sensordata[:3] / 4,
                     (self.data.qpos[self.qpos] - self.neutral) / .5,
                     self.data.qvel[self.qvel] / 10,
                     self.target[frame] / .5, self.target_vel[frame] / 10,
                     self.previous].astype(np.float32)

    def step(self, action):
        action = np.asarray(action, dtype=np.float64)
        if action.shape != (18,) or not np.isfinite(action).all():
            raise ValueError("policy output must have 18 finite actions")
        action = np.clip(action, -1, 1)
        desired = self.neutral + self.target[self.tick]
        target = np.clip(desired + 0.16 * action, *self.limits.T)
        control = self.data.ctrl[self.actuators]
        self.data.ctrl[self.actuators] = control + self.lag_mix * (target - control)
        mujoco.mj_step(self.model, self.data, nstep=self.substeps)
        rotation, yaw = self.robot.orientation()
        tilt = math.degrees(math.acos(np.clip(rotation[2, 2], -1, 1)))
        contacts = {c.geom2 if c.geom1 == self.floor else c.geom1 for c in self.data.contact
                    if self.floor in (c.geom1, c.geom2)}
        other_contacts = contacts - self.feet
        tilt_limit = PROFILE["evaluation"]["maxTiltDeg"]
        height = float(self.data.qpos[2])
        height_limit = float(self.stance[2] * .66)
        failure = {}
        if other_contacts:
            failure["nonFootContacts"] = sorted(self.model.geom(geom).name or f"geom_{geom}"
                                                for geom in other_contacts)
        if tilt >= tilt_limit:
            failure["tilt"] = {"actualDeg": tilt, "limitDeg": tilt_limit}
        if height < height_limit:
            failure["height"] = {"actualM": height, "limitM": height_limit}
        failed = bool(failure)
        error = self.data.qpos[self.qpos] - desired
        velocity_error = self.data.qvel[self.qvel] - self.target_vel[self.tick]
        reward = (2 * math.exp(-12 * np.mean(error ** 2)) +
                  .2 * math.exp(-.25 * np.mean(velocity_error ** 2)) -
                  .004 * tilt - .03 * np.mean(action ** 2) - 3 * failed)
        self.tick += 1
        self.previous = action
        complete = self.tick == len(self.target)
        return self.observe(), reward, failed, complete and not failed, {
            "episodeDone": complete or failed,
            "taskSuccess": complete and not failed,
            "failure": failure,
            "tilt": tilt,
            "yaw": math.degrees(yaw),
            "jointAbsError": float(np.mean(np.abs(error))),
            "jointSquaredError": float(np.mean(error ** 2)),
        }


def evaluate(env, policy, ranges=()):
    observations, _ = env.reset()
    frames = [env.data.qpos.copy()]
    errors, squared, tilts, peak = [], [], [], 0
    for _ in env.target:
        observations, _, failed, complete, data = env.step(policy(observations))
        frames.append(env.data.qpos.copy())
        errors.append(data["jointAbsError"])
        squared.append(data["jointSquaredError"])
        tilts.append(data["tilt"])
        peak = max(peak, data["tilt"])
        if failed or complete:
            break
    passed = (not failed and complete and peak < PROFILE["evaluation"]["maxTiltDeg"]
              and abs(data["yaw"]) < PROFILE["evaluation"]["maxAbsFinalYawDeg"])
    sections = []
    for item in ranges:
        start, end = item["from"], item["to"]
        observed = squared[start:end]
        heights = [frame[2] for frame in frames[start:start + len(observed) + 1]]
        sections.append({
            "id": item["id"], "framesExpected": end - start, "framesEvaluated": len(observed),
            "completed": len(observed) == end - start and not (failed and end == len(squared)),
            **({"trackingRmseRad": float(np.sqrt(np.mean(observed))),
                "maxTiltDeg": max(tilts[start:end]),
                "squatDescentM": max(0.0, float(heights[0] - min(heights)))} if observed else {}),
        })
    return {
        "framesExpected": len(env.target),
        "framesEvaluated": len(errors),
        "completed": bool(complete and not failed),
        "firstFailedFrame": len(errors) if failed else None,
        **({"failure": data["failure"]} if failed else {}),
        "trackingMaeRad": float(np.mean(errors)),
        "trackingRmseRad": float(np.sqrt(np.mean(squared))),
        **({"sections": sections} if sections else {}),
        "maxTiltDeg": peak,
        "finalYawDeg": data["yaw"],
        "qualityGatePassed": passed,
    }, frames


def reference_gate(bundle, trajectory):
    env = ReferenceTracking(bundle, trajectory)
    zero = lambda _obs: np.zeros(18)
    calibrated, _ = evaluate(env, zero)
    try:
        original, _ = evaluate(ReferenceTracking(bundle, trajectory, calibrated=False), zero)
        original_evidence = {"existingSceneGate": original}
    except ReferenceLimitError as error:
        original_evidence = {"existingSceneLimitViolation": error.violation}
    return env, {
        "gate": calibrated,
        **original_evidence,
        "calibrationSha256": digest(PROFILE_PATH),
        "actionJoints": TRACKED,
        "controlHz": HZ,
    }


def screen_reference():
    raw = json.load(sys.stdin)
    bundle = Path(os.environ["RDK_ORIGINMAN_DANCE_BUNDLE_DIR"])
    scene_hash = validate_bundle(bundle)["sceneSha256"]
    try:
        _, report = reference_gate(bundle, validate_trajectory(raw))
    except ReferenceLimitError as error:
        print(json.dumps({"invalid": str(error), "violation": error.violation}, allow_nan=False))
        return
    except ValueError as error:
        print(json.dumps({"invalid": str(error)}, allow_nan=False))
        return
    print(json.dumps({**report, "sceneSha256": scene_hash,
                      "trajectorySha256": trajectory_digest(raw)}, allow_nan=False))


def gate_allows_training(evidence):
    return (evidence["completed"] and evidence["framesEvaluated"] == evidence["framesExpected"]
            and evidence["maxTiltDeg"] < PROFILE["evaluation"]["maxTiltDeg"])


def composition_ranges(training, frames):
    source = training.get("originmanReferenceComposition")
    if source is None:
        return []
    ranges = source.get("ranges")
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= 90:
        raise ValueError("invalid reference choreography segments")
    previous = 0
    for item in ranges:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str) or
                type(item.get("from")) is not int or type(item.get("to")) is not int or
                not previous <= item["from"] < item["to"] <= frames):
            raise ValueError("invalid reference choreography frame boundaries")
        previous = item["to"]
    if ranges[0]["from"] != 0 or previous != frames:
        raise ValueError("reference choreography does not cover the intended trajectory")
    return ranges


def train_and_export(bundle, output, trajectory, budget, num_envs, seed, evaluation_env, ranges):
    torch.set_num_threads(1)
    device = resolve_training_device(os.environ.get("RDK_ORIGINMAN_DANCE_DEVICE", "auto"))
    factory = lambda: ReferenceTracking(bundle, trajectory)
    sim = (SubprocVecEnv([factory] * num_envs, start_method="spawn") if num_envs > 1 else factory())
    try:
        learner = PPO("MlpPolicy", sim, seed=seed, device=device, n_steps=ROLLOUT_STEPS // num_envs,
                      batch_size=128, n_epochs=4, learning_rate=3e-4,
                      policy_kwargs={"net_arch": [128, 128], "log_std_init": -2.8})
        checkpoints = []
        progress = WorkerProgress(budget, ROLLOUT_STEPS, engine=ENGINE)
        while learner.num_timesteps < budget:
            learner.learn(total_timesteps=min(CHECKPOINT_STEPS, budget - learner.num_timesteps),
                          reset_num_timesteps=False,
                          callback=progress)
            learner.save(output / "final")
            policy_path = output / "policy.onnx"
            policy_sha = write_onnx(output / "final.zip", policy_path, 96)
            session = ReferenceEvaluator(onnx.load(policy_path))
            parity_error = 0.0

            def predict(observation):
                nonlocal parity_error
                values = session.run(None, {"observation": observation[None]})[0][0]
                if ranges:
                    with torch.no_grad():
                        tensor = torch.from_numpy(observation[None]).to(learner.device)
                        torch_values = learner.policy._predict(tensor, deterministic=True).cpu().numpy()[0]
                    parity_error = max(parity_error, float(np.max(np.abs(values - torch_values))))
                return values

            result, frames = evaluate(evaluation_env, predict, ranges)
            if ranges:
                result["onnxMaxAbsError"] = parity_error
                if parity_error >= 1e-6:
                    raise ValueError("exported ONNX failed the reference policy parity check")
            checkpoints.append({"steps": learner.num_timesteps, "policySha256": policy_sha,
                                **result})
            print(json.dumps({"event": "reference-checkpoint-evaluation", **checkpoints[-1]},
                             allow_nan=False), flush=True)
            if result["qualityGatePassed"] and not ranges:
                break
        device_name = (torch.cuda.get_device_name(learner.device) if learner.device.type == "cuda"
                       else learner.device.type)
        return str(learner.device), device_name, learner.num_timesteps, policy_sha, result, frames, checkpoints
    finally:
        sim.close()


def main():
    request = read_request()
    contract = request["contract"]
    if request.get("taskId") != TASK or (contract.get("id"), contract.get("observationSize"),
        contract.get("actionSize"), contract.get("controlHz")) != (CONTRACT, 96, 18, 50):
        raise ValueError("reference tracking requires its own 96→18, 50 Hz policy contract")
    training = request["training"]
    if training.get("engine") != ENGINE or training.get("algorithm") != "ppo" or training.get("video") is not True:
        raise ValueError("invalid reference-tracking engine or configuration")
    tracks = training["originmanReference"]
    budget, seed, num_envs = tracks["trainingSteps"], tracks["seed"], training["numEnvs"]
    if (type(budget) is not int or not 8192 <= budget <= 2_000_000 or budget % 4096 or
        type(seed) is not int or not 0 <= seed <= 2_147_483_647 or
        type(num_envs) is not int or num_envs not in (1, 2, 4, 8, 16, 32, 64)):
        raise ValueError("invalid budget, seed or parallel environment count")

    trajectory = validate_trajectory(tracks["trajectory"])
    ranges = composition_ranges(training, len(trajectory[0]))
    reference_digest = trajectory_digest(tracks["trajectory"])
    provenance = training.get("originmanReferenceComposition") or {}
    if "trajectoryDigestVersion" in provenance and (
        provenance["trajectoryDigestVersion"] != REFERENCE_DIGEST_VERSION
        or provenance.get("trajectorySha256") != reference_digest
    ):
        raise ValueError("compiled choreography digest does not match the training trajectory")
    output = Path(os.environ["RDK_SIM2REAL_JOB_DIR"])
    result_path = Path(os.environ["RDK_SIM2REAL_RESULT_FILE"])
    bundle = Path(os.environ["RDK_ORIGINMAN_DANCE_BUNDLE_DIR"])
    scene_hash = validate_bundle(bundle)["sceneSha256"]
    reference_path = output / "reference.json"
    reference_path.write_text(json.dumps(tracks["trajectory"], separators=(",", ":"), allow_nan=False))
    env, report = reference_gate(bundle, trajectory)
    (output / "reference-gate.json").write_text(json.dumps(report, allow_nan=False))
    print(json.dumps({"event": "reference-gate", **report}), flush=True)
    if not gate_allows_training(report["gate"]):
        raise ValueError("reference refused by zero-residual simulation gate; see frame count and peak tilt in logs")

    device, device_name, actual_steps, policy_sha, results, frames, checkpoints = train_and_export(
        bundle, output, trajectory, budget, num_envs, seed, env, ranges
    )
    results["checkpointEvaluations"] = len(checkpoints)
    replay_path = output / "reference-replay.npz"
    np.savez_compressed(replay_path, qpos=np.asarray(frames))
    replay_sha = digest(replay_path)
    results.update(referenceSha256=digest(reference_path), trajectorySha256=reference_digest,
                   sceneSha256=scene_hash, replay={"sha256": replay_sha},
                   zeroResidualRmseRad=report["gate"]["trackingRmseRad"],
                   zeroResidualFramesEvaluated=report["gate"]["framesEvaluated"])
    video_path = output / "dance-replay.mp4"
    try:
        subprocess.run([sys.executable, str(ROOT / "engines/originman-dance-ppo/render_replay.py"),
                        "--scene", str(bundle / "model/scene.xml"), "--replay", str(replay_path),
                        "--output", str(video_path)], check=True, timeout=max(300, len(frames) // 10))
    except (OSError, subprocess.SubprocessError) as error:
        print(f"Reference replay rendering failed: {error}", file=sys.stderr, flush=True)
    else:
        video_receipt = json.loads(video_path.with_suffix(".receipt.json").read_text())
        results["video"] = {
            "file": video_path.name, "sha256": digest(video_path), "sizeBytes": video_path.stat().st_size,
            "policySha256": policy_sha, "sourceReplaySha256": replay_sha,
            "fps": video_receipt["fps"], "durationSeconds": video_receipt["durationSeconds"],
        }
    run_id = os.environ["RDK_SIM2REAL_JOB_ID"]
    result = {
        "status": "completed", "engine": ENGINE, "taskId": TASK, "deployable": False,
        "cuda": device.startswith("cuda"),
        "artifact": {"artifactId": f"originman-reference-{run_id}",
                     "artifactRef": f"artifact://{ENGINE}/{run_id}/policy.onnx", "role": "policy",
                     "format": "onnx", "kind": "compiled", "name": "policy.onnx",
                     "runtime": "onnxruntime-cpu", "workload": "humanoid-dance",
                     "sha256": policy_sha, "deployable": False},
        "metrics": {"engine": ENGINE, "contractValid": True, "observationSize": 96, "actionSize": 18,
                    "trainingSteps": actual_steps, "trainingDevice": device, "trainingDeviceName": device_name,
                    "physicsBackend": "cpu-mujoco", "originmanReference": results},
    }
    (output / "evaluation.json").write_text(json.dumps(
        {**report, "checkpoints": checkpoints, "evaluation": results}, allow_nan=False))
    write_manifest(output)
    result_path.write_text(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    multiprocessing.freeze_support()
    if sys.argv[1:] == ["--screen-reference"]:
        screen_reference()
    else:
        main()
