#!/usr/bin/env python3
"""Simulated reference tracking on the existing verified OriginMan scene."""
import hashlib
import json
import math
import multiprocessing
import os
from pathlib import Path
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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
        if np.any(absolute < self.limits[:, 0] - 1e-6) or np.any(absolute > self.limits[:, 1] + 1e-6):
            raise ValueError("reference positions plus the stance exceed scene actuator limits")
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
        failed = bool(contacts - self.feet or tilt >= PROFILE["evaluation"]["maxTiltDeg"] or
                      self.data.qpos[2] < self.stance[2] * .66)
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
            "tilt": tilt,
            "yaw": math.degrees(yaw),
            "jointAbsError": float(np.mean(np.abs(error))),
        }


def evaluate(env, policy):
    observations, _ = env.reset()
    frames = [env.data.qpos.copy()]
    errors, peak = [], 0
    for _ in env.target:
        observations, _, failed, complete, data = env.step(policy(observations))
        frames.append(env.data.qpos.copy())
        errors.append(data["jointAbsError"])
        peak = max(peak, data["tilt"])
        if failed or complete:
            break
    passed = (not failed and complete and peak < PROFILE["evaluation"]["maxTiltDeg"]
              and abs(data["yaw"]) < PROFILE["evaluation"]["maxAbsFinalYawDeg"])
    return {
        "framesExpected": len(env.target),
        "framesEvaluated": len(errors),
        "trackingMaeRad": float(np.mean(errors)),
        "maxTiltDeg": peak,
        "finalYawDeg": data["yaw"],
        "qualityGatePassed": passed,
    }, frames


def train_and_export(bundle, output, trajectory, budget, num_envs, seed):
    torch.set_num_threads(1)
    rollout = 4096
    device = resolve_training_device(os.environ.get("RDK_ORIGINMAN_DANCE_DEVICE", "auto"))
    factory = lambda: ReferenceTracking(bundle, trajectory)
    sim = (SubprocVecEnv([factory] * num_envs, start_method="spawn") if num_envs > 1 else factory())
    try:
        learner = PPO("MlpPolicy", sim, seed=seed, device=device, n_steps=rollout // num_envs,
                      batch_size=128, n_epochs=4, learning_rate=3e-4,
                      policy_kwargs={"net_arch": [128, 128], "log_std_init": -2.8})
        learner.learn(total_timesteps=budget, callback=WorkerProgress(budget, rollout, engine=ENGINE))
        learner.save(output / "final")
        return str(learner.device), (torch.cuda.get_device_name(learner.device) if learner.device.type == "cuda"
                                     else learner.device.type)
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
    output = Path(os.environ["RDK_SIM2REAL_JOB_DIR"])
    result_path = Path(os.environ["RDK_SIM2REAL_RESULT_FILE"])
    bundle = Path(os.environ["RDK_ORIGINMAN_DANCE_BUNDLE_DIR"])
    scene_hash = validate_bundle(bundle)["sceneSha256"]
    reference_path = output / "reference.json"
    reference_path.write_text(json.dumps(tracks["trajectory"], separators=(",", ":"), allow_nan=False))
    env = ReferenceTracking(bundle, trajectory)
    zero = lambda _obs: np.zeros(18)
    calibrated, _ = evaluate(env, zero)
    original, _ = evaluate(ReferenceTracking(bundle, trajectory, calibrated=False), zero)
    report = {"gate": calibrated, "existingSceneGate": original, "calibrationSha256": digest(PROFILE_PATH),
              "actionJoints": TRACKED, "controlHz": HZ}
    (output / "reference-gate.json").write_text(json.dumps(report, allow_nan=False))
    print(json.dumps({"event": "reference-gate", **report}), flush=True)
    if calibrated["framesEvaluated"] != calibrated["framesExpected"] or calibrated["maxTiltDeg"] >= PROFILE["evaluation"]["maxTiltDeg"]:
        raise ValueError("reference refused by zero-residual simulation gate; see frame count and peak tilt in logs")

    device, device_name = train_and_export(bundle, output, trajectory, budget, num_envs, seed)
    policy_path = output / "policy.onnx"
    policy_sha = write_onnx(output / "final.zip", policy_path, 96)
    session = ReferenceEvaluator(onnx.load(policy_path))
    results, frames = evaluate(env, lambda obs: session.run(None, {"observation": obs[None]})[0][0])
    replay_path = output / "reference-replay.npz"
    np.savez_compressed(replay_path, qpos=np.asarray(frames))
    replay_sha = digest(replay_path)
    results.update(referenceSha256=digest(reference_path), sceneSha256=scene_hash,
                   replay={"sha256": replay_sha})
    video_path = output / "dance-replay.mp4"
    try:
        subprocess.run([sys.executable, str(ROOT / "engines/originman-dance-ppo/render_replay.py"),
                        "--scene", str(bundle / "model/scene.xml"), "--replay", str(replay_path),
                        "--output", str(video_path)], check=True, timeout=300)
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
                    "trainingSteps": budget, "trainingDevice": device, "trainingDeviceName": device_name,
                    "physicsBackend": "cpu-mujoco", "originmanReference": results},
    }
    (output / "evaluation.json").write_text(json.dumps({**report, "evaluation": results}, allow_nan=False))
    write_manifest(output)
    result_path.write_text(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
