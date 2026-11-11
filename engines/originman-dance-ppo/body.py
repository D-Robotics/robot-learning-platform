"""No-reference, beat-conditioned OriginMan PPO in free-base MuJoCo."""
import argparse
import json
import math
from pathlib import Path
import time

import gymnasium as gym
import mujoco
import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import SubprocVecEnv

from env import Config, OriginManEnv

DT = .02
BEATS = 8


class Dance(gym.Env):
    def __init__(self, bundle, training=False):
        self.robot = OriginManEnv(bundle / "model/scene.xml", Config(stride=0, lift=0, sway=0),
                                  reference=np.load(bundle / "reference.npy"))
        self.model, self.data = self.robot.model, self.robot.data
        self.actuators = np.array([i for i in range(self.model.nu)
                                  if not self.model.actuator(i).name.startswith("head_")])
        self.names = [self.model.actuator(int(i)).name for i in self.actuators]
        joints = self.model.actuator_trnid[self.actuators, 0]
        self.qa = self.model.jnt_qposadr[joints]
        self.va = self.model.jnt_dofadr[joints]
        self.legs = np.array([i for i, name in enumerate(self.names)
                              if any(part in name for part in ("hip_", "knee", "ank_"))])
        self.arms = np.array([i for i, name in enumerate(self.names) if i not in self.legs])
        self.scale = np.array([.22 if "hip_roll" in name or "ank_roll" in name else
                               .34 if i in self.legs else .62 for i, name in enumerate(self.names)])
        self.floor = self.model.geom("ground").id
        self.feet = {self.model.geom(f"{side}_ank_roll_link_collision").id for side in ("l", "r")}
        self.action_space = gym.spaces.Box(-1, 1, (len(joints),), dtype=np.float32)
        self.observation_space = gym.spaces.Box(-np.inf, np.inf, (11 + 3 * len(joints),), dtype=np.float32)
        self.training = training
        self.torso = self.model.body("body_link").id
        self.previous = np.zeros(len(joints))
        self.nominal_friction = self.model.geom_friction[:, 0].copy()

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        rng = self.np_random
        self.bpm = float(options["bpm"]) if options else (float(rng.uniform(100, 132)) if self.training else 116.)
        friction = rng.uniform(.93, 1.07) if self.training else 1.
        self.model.geom_friction[:, 0] = self.nominal_friction * friction
        self.robot.reset()
        self.data.ctrl[self.actuators] = self.robot.home[self.qa]
        self.previous[:] = 0
        self.ticks = 0
        self.last_beat_pose = self.data.qpos[self.qa].copy()
        self.phrase_pose = self.last_beat_pose.copy()
        self.beat_index = 0
        self.mechanical_work = 0.
        return self.observe(), {}

    def beat(self):
        return self.ticks * DT * self.bpm / 60

    def observe(self):
        rotation, _ = self.robot.orientation()
        beat = self.beat()
        phase = 2 * np.pi * beat
        phrase = phase / BEATS
        return np.r_[rotation[2], self.data.sensordata[:3] / 4,
                     np.sin(phase), np.cos(phase), np.sin(phrase), np.cos(phrase), (self.bpm - 116.) / 16,
                     (self.data.qpos[self.qa] - self.robot.home[self.qa]) / .5,
                     self.data.qvel[self.va] / 10, self.previous].astype(np.float32)

    def step(self, action):
        old = self.previous
        command = old + np.clip(np.clip(action, -1, 1) - old, -.20, .20)
        target = self.robot.home[self.qa] + command * self.scale
        self.data.ctrl[self.actuators] = np.clip(target, *self.model.actuator_ctrlrange[self.actuators].T)
        mujoco.mj_step(self.model, self.data, nstep=20)
        self.ticks += 1
        self.previous = command
        beat = self.beat()
        rotation, yaw = self.robot.orientation()
        tilt = math.acos(np.clip(rotation[2, 2], -1, 1))
        contacts = {c.geom2 if c.geom1 == self.floor else c.geom1
                    for c in self.data.contact if self.floor in (c.geom1, c.geom2)}
        height = self.data.qpos[2] / self.robot.base_height
        travel = np.linalg.norm(self.data.qpos[:2])
        failed = bool(contacts - self.feet or height < .72 or tilt > .58 or travel > .24)
        phase = beat % 1
        pulse = (0.5 + 0.5 * math.cos(2 * math.pi * (phase - .94))) ** 2
        velocities = self.data.qvel[self.va]
        arm_speed = float(np.linalg.norm(velocities[self.arms]) / math.sqrt(len(self.arms)))
        leg_speed = float(np.linalg.norm(velocities[self.legs]) / math.sqrt(len(self.legs)))
        arm_target, leg_target = .20 + 2.1 * pulse, .12 + .9 * pulse
        arm_rhythm = math.exp(-1.3 * (arm_speed - arm_target) ** 2)
        leg_rhythm = math.exp(-2.0 * (leg_speed - leg_target) ** 2)
        position = self.data.qpos[self.qa].copy()
        change = 0.
        if int(beat) > self.beat_index:
            delta = abs(position - self.last_beat_pose)
            change = (min(1., float(np.mean(delta[self.arms])) / .32)
                      + min(1., float(np.mean(delta[self.legs])) / .095))
            self.last_beat_pose = position
            self.beat_index = int(beat)
        pose_delta = position - self.robot.home[self.qa]
        arm_range = min(float(np.linalg.norm(pose_delta[self.arms])), 1.05)
        work = float(np.sum(abs(self.data.actuator_force[self.actuators] * velocities)))
        self.mechanical_work += DT * work
        reward = (1.15 + 1.15 * arm_rhythm + 1.0 * leg_rhythm + .24 * arm_range
                  + 1.8 * change - 2.3 * tilt**2 - 9 * travel**2 - .25 * yaw**2
                  - .10 * np.sum((command - old)**2) - .025 * work
                  - 10. * failed)
        info = {"beats": beat, "pulse": pulse, "armSpeed": arm_speed, "legSpeed": leg_speed,
                "tiltDeg": math.degrees(tilt), "travelM": float(travel), "mechanicalWorkJ": self.mechanical_work,
                "fallContacts": [self.model.geom(int(i)).name for i in sorted(contacts - self.feet)]}
        return self.observe(), float(reward), failed, beat >= BEATS and not failed, info


def episode(env, actor, bpm, trace=False):
    obs, _ = env.reset(options={"bpm": bpm})
    rows = []
    frames = [env.data.qpos.tolist()]
    total = 0.
    while True:
        obs, reward, failed, complete, info = env.step(actor(obs))
        total += reward
        rows.append(info)
        if trace:
            frames.append(env.data.qpos.tolist())
        if complete or failed:
            break
    arm, leg, pulse = (np.array([r[k] for r in rows]) for k in ("armSpeed", "legSpeed", "pulse"))
    def correlation(values):
        return float(np.corrcoef(values, pulse)[0, 1]) if len(values) > 2 and np.std(values) > 1e-8 else None
    out = dict(bpm=bpm, complete=complete, beats=info["beats"], reward=total,
               armBeatCorrelation=correlation(arm), legBeatCorrelation=correlation(leg),
               armRmsSpeed=float(np.sqrt(np.mean(arm**2))), legRmsSpeed=float(np.sqrt(np.mean(leg**2))),
               maxTiltDeg=max(r["tiltDeg"] for r in rows), travelM=info["travelM"],
               fallContacts=info["fallContacts"], mechanicalWorkJ=info["mechanicalWorkJ"])
    if trace:
        out.update(qpos=frames, frameMetrics=rows)
    return out


class Checkpoints(BaseCallback):
    def __init__(self, env, out):
        super().__init__()
        self.env, self.out, self.last = env, out, 0
        self.start = time.monotonic()

    def _on_step(self):
        return True

    def _on_rollout_start(self):
        if self.num_timesteps == 0 or self.num_timesteps - self.last >= 32768:
            self.last = self.num_timesteps
            name = f"step-{self.last:08d}"
            self.model.save(self.out / name)
            rows = [episode(self.env, lambda obs: self.model.predict(obs, deterministic=True)[0], bpm)
                    for bpm in (104., 116., 128.)]
            (self.out / f"{name}.json").write_text(json.dumps(rows,indent=2))
            print(name, round(time.monotonic()-self.start,1), rows, flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bundle", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--steps", type=int, default=393216)
    p.add_argument("--seed", type=int, default=33)
    args = p.parse_args()
    args.out.mkdir()
    torch.set_num_threads(1)
    env = Dance(args.bundle)
    (args.out / "config.json").write_text(json.dumps({
        "algorithm":"PPO","seed":args.seed,"initialization":"random",
        "referenceDance":None,"demonstrations":0,"beatCount":BEATS,"trainingBpmRange":[100,132],
        "controlDt":DT,"actionJoints":env.names,"hardwareEligible":False,
    },indent=2))
    vec = SubprocVecEnv([lambda: Dance(args.bundle, True) for _ in range(8)], start_method="fork")
    try:
        model = PPO("MlpPolicy", vec, device="cpu", seed=args.seed, n_steps=512, batch_size=256,
                    n_epochs=5, learning_rate=3e-4, gamma=.99, ent_coef=.001,
                    policy_kwargs={"net_arch":[128,128],"log_std_init":-1.1})
        model.learn(total_timesteps=args.steps, callback=Checkpoints(env,args.out))
        model.save(args.out / "final")
        rows = [episode(env, lambda obs: model.predict(obs, deterministic=True)[0], bpm)
                for bpm in (104.,116.,128.)]
        (args.out/"final.json").write_text(json.dumps(rows,indent=2))
        print("final",rows,flush=True)
    finally:
        vec.close()


if __name__ == "__main__":
    main()
