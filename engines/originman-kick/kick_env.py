"""Free-base, full-body fixed-ball kick: no chassis force or ball impulse.

The controller generates smooth joint targets from continuous kick trajectory
parameters. Learning those parameters is distinct from learning a 50 Hz
closed-loop full-joint policy; the experiment makes that scope explicit.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np
from scipy.optimize import least_squares

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "originman-straight"))
from env import Config, OriginManEnv


def prepare_scene(source, out):
    source = Path(source)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source.parent / "meshes", out / "meshes", dirs_exist_ok=True)
    shutil.copyfile(source, out / "source-scene.xml")
    root = ET.parse(source).getroot()
    ground = root.find("worldbody/geom[@name='ground']")
    ground.set("contype", "2")
    ground.set("conaffinity", "5")
    for geom in root.findall(".//geom"):
        if geom.get("group") == "3":
            geom.set("contype", "1")
            geom.set("conaffinity", "6")
    ball = ET.SubElement(
        root.find("worldbody"), "body", name="ball", pos=".095 -.045 .026"
    )
    ET.SubElement(ball, "freejoint", name="ball_free")
    ET.SubElement(
        ball,
        "inertial",
        pos="0 0 0",
        mass=".02",
        diaginertia="0.000005 0.000005 0.000005",
    )
    ET.SubElement(
        ball,
        "geom",
        name="ball",
        type="sphere",
        size=".025",
        mass=".02",
        rgba=".9 .2 .1 1",
        contype="4",
        conaffinity="3",
        condim="6",
        priority="1",
        friction=".5 .005 .001",
        solref=".006 1",
    )
    ET.indent(root)
    ET.ElementTree(root).write(out / "scene.xml", encoding="unicode")
    manifest = {
        "task": "originman-fixed-ball-kick",
        "sourceSceneSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "ballRadiusM": 0.025,
        "ballMassKg": 0.02,
        "rollingFrictionM": 0.001,
        "assumptions": "simplified rigid ball and floor; uncalibrated servos and contact; robot self collision remains disabled",
        "rootAssistance": False,
        "ballImpulseInjection": False,
        "hardwareEligible": False,
    }
    (out / "model-manifest.json").write_text(json.dumps(manifest, indent=2))
    return out / "scene.xml"


class KickEnv:
    def __init__(self, source_scene, scene):
        # Reuse original robot topology, validated stance, inertial tensors and IK.
        static = Config(stride=0, lift=0, sway=0, crouch=1.1)
        base = OriginManEnv(source_scene, static)
        self.scene_path = Path(scene)
        self.model = mujoco.MjModel.from_xml_path(str(scene))
        self.data = mujoco.MjData(self.model)
        self.qa = base.qa
        self.va = base.va
        self.leg_a = base.leg_a
        self.home = np.zeros(self.model.nq)
        self.home[:27] = base.home
        self.ball_j = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_JOINT, "ball_free"
        )
        self.ball_q = self.model.jnt_qposadr[self.ball_j]
        self.ball_body = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, "ball")
        self.ball_geom = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_GEOM, "ball")
        self.right_foot = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_GEOM, "r_ank_roll_link_collision"
        )
        self.base_height = base.base_height
        self.ctrl_home = base.home[7:].copy()
        self.home[self.ball_q : self.ball_q + 7] = [0.095, -0.045, 0.0255, 1, 0, 0, 0]
        self.model.actuator_gainprm[self.leg_a, 0] = 8
        self.model.actuator_biasprm[self.leg_a, 1] = -8
        self.model.actuator_biasprm[self.leg_a, 2] = -0.18
        self.ik_model = base.model
        self.ik_base = base
        self.ik_data = mujoco.MjData(base.model)
        self.ik_home = base.home
        self.ik_data.qpos[:] = base.home
        mujoco.mj_forward(base.model, self.ik_data)
        self.gids = [
            mujoco.mj_name2id(
                base.model, mujoco.mjtObj.mjOBJ_GEOM, s + "_ank_roll_link_collision"
            )
            for s in ("l", "r")
        ]
        self.foot_zero = [base.foot_pose(self.ik_data, side)[0] for side in range(2)]
        self.foot_rot = [base.foot_pose(self.ik_data, side)[1] for side in range(2)]
        self.stance = base.home[self.qa].copy()
        self.shift = self.pose(0, 0, 0.035)
        self.back = self.pose(-0.02, 0.012, 0.035)
        self.strokes = np.linspace(0.012, 0.062, 26)
        self.strikes = np.array([self.pose(x, 0.009, 0.035) for x in self.strokes])

    def pose(self, x, z, shift):
        d = self.ik_data
        m = self.ik_model
        q = self.stance.copy()
        for side in range(2):
            target = self.foot_zero[side].copy()
            target[1] -= shift
            if side == 1:
                target[0] += x
                target[2] += z
            qa = self.qa[side * 5 : side * 5 + 5]

            def error(v, qa=qa, target=target, side=side):
                d.qpos[:] = self.ik_home
                d.qpos[qa] = v
                mujoco.mj_forward(m, d)
                position, R = self.ik_base.foot_pose(d, side)
                return np.r_[
                    (position - target) * 20,
                    (R[:, 2] - self.foot_rot[side][:, 2])[:2],
                ]

            q[side * 5 : side * 5 + 5] = least_squares(
                error, q[side * 5 : side * 5 + 5], bounds=(-1.9, 1.9), max_nfev=50
            ).x
        return q

    def strike(self, x):
        f = np.interp(x, self.strokes, np.arange(len(self.strokes)))
        i = min(int(f), len(self.strokes) - 2)
        a = f - i
        return (1 - a) * self.strikes[i] + a * self.strikes[i + 1]

    @staticmethod
    def parameters(action):
        action = np.clip(np.asarray(action), -1, 1)
        if action.shape != (2,) or not np.isfinite(action).all():
            raise ValueError("finite 2D stroke/duration parameters required")
        return {
            "stroke": float(0.031 + 0.019 * action[0]),
            "duration": float(0.28 + 0.20 * action[1]),
        }

    def rollout(
        self,
        action,
        friction=0.001,
        ball_offset=(0.0, 0.0),
        trace=False,
        seconds=6.0,
        command_delay_steps=0,
    ):
        p = self.parameters(action)
        m = self.model
        d = self.data
        substeps = round(0.02 / m.opt.timestep)
        if substeps < 1 or not np.isclose(substeps * m.opt.timestep, 0.02):
            raise ValueError("physics timestep must divide the 20ms control period")
        if not isinstance(command_delay_steps, int) or command_delay_steps < 0:
            raise ValueError("command_delay_steps must be a nonnegative integer")
        mujoco.mj_resetData(m, d)
        d.qpos[:] = self.home
        d.qpos[self.ball_q : self.ball_q + 2] += ball_offset
        m.geom_friction[self.ball_geom, 2] = friction
        d.ctrl[:] = self.ctrl_home
        mujoco.mj_forward(m, d)
        start = d.qpos[self.ball_q : self.ball_q + 3].copy()
        peak_tilt = 0.0
        contact = False
        robot_hit = False
        fall = False
        frames = []
        touches = 0
        settled = 0
        termination = "timeout"
        strike = self.strike(p["stroke"])
        times = [
            0,
            0.65,
            0.95,
            0.95 + p["duration"],
            1.35 + p["duration"],
            1.95 + p["duration"],
        ]
        poses = [self.stance, self.shift, self.back, strike, self.shift, self.stance]
        pending = [self.stance.copy() for _ in range(command_delay_steps)]
        for step in range(round(seconds / 0.02)):
            t = step * 0.02
            if t >= times[-1]:
                target = self.stance
            else:
                i = max(
                    0, min(np.searchsorted(times, t, side="right") - 1, len(times) - 2)
                )
                a = (t - times[i]) / (times[i + 1] - times[i])
                a = a * a * (3 - 2 * a)
                target = poses[i] * (1 - a) + poses[i + 1] * a
            pending.append(target.copy())
            executed_target = pending.pop(0)
            d.ctrl[self.leg_a] = executed_target
            for _ in range(substeps):
                mujoco.mj_step(m, d)
                for c in d.contact:
                    ids = (c.geom1, c.geom2)
                    if self.ball_geom in ids:
                        other = ids[1] if ids[0] == self.ball_geom else ids[0]
                        if other == self.right_foot:
                            contact = True
                            touches += 1
                        elif m.geom_bodyid[other] != 0:
                            robot_hit = True
            upright = float(d.xmat[1].reshape(3, 3)[2, 2])
            tilt = float(np.arccos(np.clip(upright, -1, 1)))
            peak_tilt = max(peak_tilt, tilt)
            fall = fall or upright < 0.65 or d.qpos[2] < self.base_height * 0.65
            velocity = d.qvel[m.jnt_dofadr[self.ball_j] : m.jnt_dofadr[self.ball_j] + 3]
            if (
                t > 3.0
                and np.linalg.norm(velocity) < 0.005
                and np.linalg.norm(d.qvel[:6]) < 0.02
            ):
                settled += 1
            else:
                settled = 0
            if trace and step % 2 == 0:
                frames.append(
                    {
                        "time": t + 0.02,
                        "qpos": d.qpos.tolist(),
                        "ballPosition": d.qpos[self.ball_q : self.ball_q + 3].tolist(),
                        "jointTarget": executed_target.tolist(),
                        "requestedJointTarget": target.tolist(),
                        "jointPosition": d.qpos[self.qa].tolist(),
                        "tilt": tilt,
                    }
                )
            if fall:
                termination = "fall"
                break
            if settled >= 25:
                termination = "settled"
                break
        ball = d.qpos[self.ball_q : self.ball_q + 3]
        # This is ball displacement measured from physics, never a commanded distance.
        report = {
            "parameters": p,
            "elapsedSeconds": t + 0.02,
            "termination": termination,
            "ballForwardM": float(ball[0] - start[0]),
            "ballLateralM": float(ball[1] - start[1]),
            "ballSpeedMps": float(
                np.linalg.norm(
                    d.qvel[m.jnt_dofadr[self.ball_j] : m.jnt_dofadr[self.ball_j] + 3]
                )
            ),
            "footBallContact": contact,
            "otherRobotBallContact": robot_hit,
            "contactSubsteps": touches,
            "fallen": bool(fall),
            "peakTiltDegrees": float(np.degrees(peak_tilt)),
            "robotTranslationM": float(np.linalg.norm(d.qpos[:2] - self.home[:2])),
            "friction": friction,
            "ballOffset": list(ball_offset),
            "finalTiltDegrees": float(
                np.degrees(np.arccos(np.clip(d.xmat[1].reshape(3, 3)[2, 2], -1, 1)))
            ),
            "simulationOnly": True,
            "physicsTimestepSeconds": float(m.opt.timestep),
            "commandDelaySteps": command_delay_steps,
        }
        if trace:
            report["frames"] = frames
        return report
