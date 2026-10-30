"""OriginMan free-base contact dynamics with continuous leg residuals.

Actor observations contain ideal simulated attitude/rate, joint states,
reference phase and previous residual. World XY is reward/evaluation only.
Locomotion is produced by joint actuators and ground reaction forces.
An optional, logged lateral torso disturbance is disabled by default.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import mujoco
import numpy as np
from model import LEGS
from scipy.optimize import least_squares


@dataclass
class Config:
    period: float = 1.2
    stride: float = 0.035
    lift: float = 0.012
    sway: float = 0.018
    crouch: float = 0.5
    lean: float = 0.0
    residual_scale: float = 0.10
    episode_seconds: float = 8.0
    control_dt: float = 0.02
    kp: float = 8.0
    kv: float = 0.18
    effort: float = 1.5
    velocity_width: float = 0.1
    heading_weight: float = 3.0
    lateral_weight: float = 10.0
    progress_weight: float = 0.0
    push_max_force: float = 0.0
    push_duration: float = 0.2
    push_min_force: float = 0.0
    push_start_min: float = 1.2
    push_start_max: float = 2.4
    velocity_filter_seconds: float = 0.0
    residual_weight: float = 0.03
    recovery_roll_threshold: float = 0.0
    recovery_rate_threshold: float = 1.3
    recovery_hold_seconds: float = 0.4

    def __post_init__(self):
        bounds = {
            "period": (0.2, 5),
            "stride": (0, 0.08),
            "lift": (0, 0.05),
            "sway": (0, 0.04),
            "crouch": (0.1, 1.2),
            "lean": (-0.04, 0.04),
            "residual_scale": (0, 0.3),
            "episode_seconds": (1, 60),
            "control_dt": (0.004, 0.05),
            "kp": (1, 40),
            "kv": (0, 2),
            "effort": (0.2, 4),
            "velocity_width": (0.005, 1),
            "heading_weight": (0, 500),
            "lateral_weight": (0, 500),
            "progress_weight": (0, 100),
            "push_max_force": (0, 10),
            "push_duration": (0.02, 0.5),
            "push_min_force": (0, 10),
            "push_start_min": (0, 59),
            "push_start_max": (0, 59),
            "velocity_filter_seconds": (0, 1),
            "residual_weight": (0, 3),
            "recovery_roll_threshold": (0, 0.5),
            "recovery_rate_threshold": (0.2, 10),
            "recovery_hold_seconds": (0.1, 2),
        }
        for key, (lo, hi) in bounds.items():
            value = getattr(self, key)
            if (
                isinstance(value, bool)
                or not isinstance(value, (float, int))
                or not lo <= value <= hi
            ):
                raise ValueError(f"{key} must be finite and in [{lo}, {hi}]")
        if abs(self.control_dt / 0.002 - round(self.control_dt / 0.002)) > 1e-6:
            raise ValueError("control_dt must be a multiple of the 2ms physics step")
        if (
            self.push_min_force > self.push_max_force
            or self.push_start_min > self.push_start_max
        ):
            raise ValueError("disturbance minimum must not exceed maximum")
        if (
            self.push_max_force
            and self.push_start_max + self.push_duration > self.episode_seconds
        ):
            raise ValueError("disturbance must fit inside the configured episode")


class OriginManEnv:
    obs_dim = 41
    action_dim = 10

    def __init__(self, scene, config=None, seed=0, reference=None):
        self.config = config or Config()
        self.model = mujoco.MjModel.from_xml_path(str(scene))
        self.data = mujoco.MjData(self.model)
        self.rng = np.random.default_rng(seed)
        self.leg_a = np.array(
            [
                mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, n)
                for n in LEGS
            ]
        )
        self.leg_j = np.array(
            [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, n) for n in LEGS]
        )
        self.qa = self.model.jnt_qposadr[self.leg_j]
        self.va = self.model.jnt_dofadr[self.leg_j]
        self.home = np.zeros(self.model.nq)
        self.home[3] = 1
        for j in range(1, self.model.njnt):
            n = mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_JOINT, j)
            v = 0.0
            if n.endswith(("hip_pitch", "ank_pitch")):
                v = -self.config.crouch / 2
            if n.endswith("knee"):
                v = self.config.crouch
            if n == "l_sho_roll":
                v = 1.4
            if n == "r_sho_roll":
                v = -1.4
            self.home[self.model.jnt_qposadr[j]] = v
        self.home[0] = 0
        self.home[1] = 0
        self.data.qpos[:] = self.home
        mujoco.mj_forward(self.model, self.data)
        bottom = 0.0
        for i in range(self.model.ngeom):
            if self.model.geom_group[i] != 3:
                continue
            R = self.data.geom_xmat[i].reshape(3, 3)
            if self.model.geom_type[i] == mujoco.mjtGeom.mjGEOM_MESH:
                mesh = self.model.geom_dataid[i]
                start = self.model.mesh_vertadr[mesh]
                vertices = self.model.mesh_vert[
                    start : start + self.model.mesh_vertnum[mesh]
                ]
                z = self.data.geom_xpos[i, 2] + np.min(vertices @ R[2])
            else:
                z = self.data.geom_xpos[i, 2] - np.sum(
                    abs(R[2]) * self.model.geom_size[i]
                )
            bottom = min(bottom, z)
        self.home[2] = -bottom + 0.001
        self.base_height = self.home[2]
        self.reference = reference if reference is not None else self.make_reference()
        self.model.actuator_gainprm[self.leg_a, 0] = self.config.kp
        self.model.actuator_biasprm[self.leg_a, 1] = -self.config.kp
        self.model.actuator_biasprm[self.leg_a, 2] = -self.config.kv
        self.model.actuator_forcerange[:] = [-self.config.effort, self.config.effort]
        self.reset()

    def foot_pose(self, data, side):
        name = ("l", "r")[side] + "_ank_roll_link"
        site = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_SITE, name + "_foot_frame"
        )
        if site >= 0:
            return data.site_xpos[site].copy(), data.site_xmat[site].reshape(
                3, 3
            ).copy()
        geom = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_GEOM, name + "_collision"
        )
        return data.geom_xpos[geom].copy(), data.geom_xmat[geom].reshape(3, 3).copy()

    def make_reference(self, count=120):
        # Solve 5D leg IK against original link transforms, not a proxy chassis.
        m = self.model
        d = mujoco.MjData(m)
        d.qpos[:] = self.home
        mujoco.mj_forward(m, d)
        poses = [self.foot_pose(d, side) for side in range(2)]
        targets = [p[0] for p in poses]
        orientations = [p[1] for p in poses]
        ref = []
        for k in range(count):
            phase = 2 * np.pi * k / count
            q = self.home[self.qa].copy()
            for side in range(2):
                # Left swing first half; right swing second. Cosine horizontal
                # motion has zero endpoint speed; stance slides rearward.
                t = (k / count + (0.5 if side else 0)) % 1
                target = targets[side].copy()
                if t < 0.5:
                    u = t * 2
                    target[0] += self.config.stride * (
                        -0.5 + 0.5 * (1 - np.cos(np.pi * u))
                    )
                    target[2] += self.config.lift * np.sin(np.pi * u)
                else:
                    u = (t - 0.5) * 2
                    target[0] += self.config.stride * (0.5 - u)
                # Body sways toward stance foot before lifting the other.
                target[1] += self.config.sway * np.sin(phase)
                target[0] += self.config.lean
                idx = slice(side * 5, side * 5 + 5)
                qa = self.qa[idx]

                def error(x, qa=qa, side=side, target=target):
                    d.qpos[:] = self.home
                    d.qpos[qa] = x
                    mujoco.mj_forward(m, d)
                    position, R = self.foot_pose(d, side)
                    wanted = orientations[side]
                    # Three position coordinates plus sole normal (roll/pitch).
                    return np.r_[
                        (position - target) * 20,
                        (R[:, 2] - wanted[:, 2])[:2],
                    ]

                fit = least_squares(
                    error,
                    q[idx],
                    bounds=(-1.6, 1.6),
                    max_nfev=35,
                    ftol=1e-6,
                    xtol=1e-6,
                    gtol=1e-6,
                )
                q[idx] = fit.x
            ref.append(q)
        return np.array(ref)

    def target(self):
        f = (self.time / self.config.period) % 1 * len(self.reference)
        i = int(f)
        return self.reference[i] * (1 - (f - i)) + self.reference[
            (i + 1) % len(self.reference)
        ] * (f - i)

    def reset(self, seed=None, asymmetry=0.0, initial_yaw=0.0):
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        mujoco.mj_resetData(self.model, self.data)
        self.data.qpos[:] = self.home
        self.data.qpos[3:7] = [np.cos(initial_yaw / 2), 0, 0, np.sin(initial_yaw / 2)]
        self.time = 0.0
        self.last_action = np.zeros(10)
        self.steps = 0
        self.filtered_forward_velocity = 0.0
        self.recovery_until = -1.0
        self.recovery_until_step = -1
        self.recovery_gate = 0.0 if self.config.recovery_roll_threshold else 1.0
        self.push_start = 0.0
        self.push_force = np.zeros(3)
        if self.config.push_max_force > 0:
            self.push_start = float(
                self.rng.uniform(self.config.push_start_min, self.config.push_start_max)
            )
            self.push_force[1] = float(
                self.rng.uniform(
                    -self.config.push_max_force, self.config.push_max_force
                )
                if self.config.push_min_force == 0
                else self.rng.choice([-1, 1])
                * self.rng.uniform(
                    self.config.push_min_force, self.config.push_max_force
                )
            )
        self.asymmetry = float(asymmetry)
        # Per-episode left/right servo gain variation. No world force bias.
        gain = (
            self.config.kp * np.r_[np.full(5, 1 + asymmetry), np.full(5, 1 - asymmetry)]
        )
        self.model.actuator_gainprm[self.leg_a, 0] = gain
        self.model.actuator_biasprm[self.leg_a, 1] = -gain
        self.data.ctrl[:] = self.home[7:]
        self.data.ctrl[self.leg_a] = self.target()
        mujoco.mj_forward(self.model, self.data)
        self.start = self.data.qpos[:2].copy()
        self.initial_yaw = initial_yaw
        return self.observe()

    def orientation(self):
        w, x, y, z = self.data.qpos[3:7]
        yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
        return self.data.xmat[1].reshape(3, 3), yaw

    def observe(self):
        R, yaw = self.orientation()
        phase = 2 * np.pi * self.time / self.config.period
        gyro = self.data.sensordata[:3].copy()
        heading = yaw  # goal heading is world +X; no world-position input
        return np.r_[
            gyro,
            R.T @ np.array([0, 0, -1]),
            np.sin(heading),
            np.cos(heading),
            self.data.qpos[self.qa] - self.home[self.qa],
            self.data.qvel[self.va] * 0.1,
            self.last_action,
            np.sin(phase),
            np.cos(phase),
            self.config.stride / self.config.period,
        ].astype(np.float32)

    def diagnostic_frame(self):
        names = ["body_link"] + [
            s + "_" + j + "_link"
            for s in ("l", "r")
            for j in ("hip_roll", "hip_pitch", "knee", "ank_pitch", "ank_roll")
        ]
        return {
            "jointNames": LEGS,
            "jointPosition": self.data.qpos[self.qa].tolist(),
            "jointVelocity": self.data.qvel[self.va].tolist(),
            "jointTarget": self.data.ctrl[self.leg_a].tolist(),
            "residualExecuted": self.last_action.tolist(),
            "qpos": self.data.qpos.tolist(),
            "bodyPositions": {
                name: self.data.xpos[
                    mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, name)
                ].tolist()
                for name in names
            },
        }

    def step(self, action):
        a = np.asarray(action, dtype=float)
        if a.shape != (10,) or not np.isfinite(a).all():
            raise ValueError("expected finite 10D leg residual")
        a = np.clip(a, -1, 1)
        if self.config.recovery_roll_threshold:
            rotation, _ = self.orientation()
            roll = float(np.arctan2(rotation[2, 1], rotation[2, 2]))
            if (
                abs(roll) >= self.config.recovery_roll_threshold
                or abs(self.data.sensordata[0]) >= self.config.recovery_rate_threshold
            ):
                self.recovery_until_step = self.steps + math.ceil(
                    self.config.recovery_hold_seconds / self.config.control_dt - 1e-9
                )
                self.recovery_until = self.recovery_until_step * self.config.control_dt
            desired_gate = float(self.steps < self.recovery_until_step)
            self.recovery_gate += np.clip(
                desired_gate - self.recovery_gate,
                -self.config.control_dt / 0.1,
                self.config.control_dt / 0.1,
            )
            a *= self.recovery_gate
        prev = self.last_action.copy()
        gated_request = a.copy()
        a = np.clip(a, prev - 0.25, prev + 0.25)
        oldx = self.data.qpos[0]
        self.data.ctrl[self.leg_a] = np.clip(
            self.target() + self.config.residual_scale * a, -1.6, 1.6
        )
        # A finite external disturbance at torso COM, never forward propulsion.
        # No disturbance is enabled in the default straight-walking task.
        physics_dt = self.model.opt.timestep
        substeps = round(self.config.control_dt / physics_dt)
        if substeps < 1 or not math.isclose(
            substeps * physics_dt, self.config.control_dt, abs_tol=1e-10
        ):
            raise ValueError("physics timestep must divide the control period")
        first_push_tick = math.ceil(self.push_start / physics_dt - 1e-9)
        end_push_tick = math.ceil(
            (self.push_start + self.config.push_duration) / physics_dt - 1e-9
        )
        base_tick = self.steps * substeps
        active_ticks = max(
            0,
            min(base_tick + substeps, end_push_tick) - max(base_tick, first_push_tick),
        )
        has_force = bool(np.any(self.push_force))
        if not has_force:
            active_ticks = 0
        self.data.xfrc_applied[:] = 0
        if active_ticks == substeps:
            self.data.xfrc_applied[1, :3] = self.push_force
        for substep in range(substeps):
            if 0 < active_ticks < substeps:
                tick = base_tick + substep
                self.data.xfrc_applied[1, :3] = (
                    self.push_force if first_push_tick <= tick < end_push_tick else 0
                )
            mujoco.mj_step(self.model, self.data)
        impulse = self.push_force * (active_ticks * physics_dt)
        force_window = (
            [
                max(base_tick, first_push_tick) * physics_dt,
                min(base_tick + substeps, end_push_tick) * physics_dt,
            ]
            if active_ticks
            else None
        )
        self.time += self.config.control_dt
        self.steps += 1
        self.last_action = a
        R, yaw = self.orientation()
        height = self.data.qpos[2]
        fallen = bool(
            height < self.base_height * 0.65
            or R[2, 2] < 0.65
            or not np.isfinite(self.data.qpos).all()
        )
        timeout = self.steps >= round(
            self.config.episode_seconds / self.config.control_dt
        )
        vx = (self.data.qpos[0] - oldx) / self.config.control_dt
        alpha = self.config.control_dt / (
            self.config.velocity_filter_seconds + self.config.control_dt
        )
        self.filtered_forward_velocity += alpha * (vx - self.filtered_forward_velocity)
        lateral = float(self.data.qpos[1])
        desired = self.config.stride / self.config.period
        reward_terms = {
            "alive": 1.0,
            "velocity_tracking": float(
                2
                * np.exp(
                    -(
                        (
                            (self.filtered_forward_velocity - desired)
                            / self.config.velocity_width
                        )
                        ** 2
                    )
                )
            ),
            "upright": float(0.5 * R[2, 2]),
            "heading_penalty": float(-self.config.heading_weight * yaw * yaw),
            "lateral_penalty": float(-self.config.lateral_weight * lateral * lateral),
            "forward_progress": float(self.config.progress_weight * vx),
            "residual_penalty": float(-self.config.residual_weight * np.sum(a * a)),
            "action_rate_penalty": float(-0.03 * np.sum((a - prev) ** 2)),
            "fall_penalty": -10.0 if fallen else 0.0,
        }
        reward = sum(reward_terms.values())
        contacts = []
        for side in ("l", "r"):
            gid = mujoco.mj_name2id(
                self.model, mujoco.mjtObj.mjOBJ_GEOM, side + "_ank_roll_link_collision"
            )
            contacts.append(
                any(
                    gid in (self.data.contact[i].geom1, self.data.contact[i].geom2)
                    for i in range(self.data.ncon)
                )
            )
        info = {
            "time": self.time,
            "x": float(self.data.qpos[0]),
            "y": lateral,
            "yaw": yaw,
            "height": float(height),
            "fallen": fallen,
            "timeout": timeout,
            "footContacts": contacts,
            "reward": float(reward),
            "rewardTerms": reward_terms,
            "forwardVelocity": float(vx),
            "trackingVelocity": float(self.filtered_forward_velocity),
            "phase": float((self.time / self.config.period) % 1),
            "externalForceWorldN": (impulse / self.config.control_dt).tolist(),
            "externalImpulseWorldNs": impulse.tolist(),
            "externalForceWindowSeconds": force_window,
            "pushStartSeconds": self.push_start,
            "recoveryGate": float(self.recovery_gate),
            "residualRateLimitedFraction": float(
                np.mean(abs(a - gated_request) > 1e-8)
            ),
        }
        return self.observe(), float(reward), fallen or timeout, info
