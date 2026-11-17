"""Gymnasium bridge and kinematically defined two-mode residual actions.

The physical model, reference gait, termination and success criteria are unchanged.
Mode actions move both foot frames laterally or roll their normals; joint signs
come from the source model Jacobians, never from a hand-assumed symmetry.
"""

from dataclasses import asdict
from typing import ClassVar

import gymnasium as gym
import mujoco
import numpy as np
from env import Config, OriginManEnv


class FootModes:
    scales = np.array([0.02, 0.15])  # meters and radians

    def __init__(self, env):
        self.env = env
        model = env.model
        data = mujoco.MjData(model)
        self.basis = np.zeros((len(env.reference), 10, 2))
        self.min_singular_value = float("inf")
        for k, reference in enumerate(env.reference):
            data.qpos[:] = env.home
            data.qpos[env.qa] = reference
            mujoco.mj_forward(model, data)
            for side in range(2):
                name = ("l", "r")[side] + "_ank_roll_link_foot_frame"
                site = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE, name)
                if site < 0:
                    raise ValueError("semantic foot-frame sites are required")
                jp, jr = np.zeros((3, model.nv)), np.zeros((3, model.nv))
                mujoco.mj_jacSite(model, data, jp, jr, site)
                indices = env.va[side * 5 : side * 5 + 5]
                normal = data.site_xmat[site].reshape(3, 3)[:, 2]
                dn = np.cross(jr[:, indices].T, normal).T
                jac = np.vstack([jp[:, indices] * 20, dn[:2]])
                singular = np.linalg.svd(jac, compute_uv=False)
                self.min_singular_value = min(
                    self.min_singular_value, float(singular[-1])
                )
                desired = np.zeros((5, 2))
                desired[1, 0] = 20  # +world Y foot translation
                desired[3:, 1] = np.cross([1, 0, 0], normal)[:2]
                self.basis[k, side * 5 : side * 5 + 5] = np.linalg.solve(
                    jac.T @ jac + np.eye(5) * 1e-8, jac.T @ desired
                )
        if self.min_singular_value < 1e-5 or not np.isfinite(self.basis).all():
            raise ValueError("ill-conditioned semantic action basis")

    def matrix(self):
        phase = self.env.time / self.env.config.period % 1 * len(self.basis)
        i = int(phase)
        return self.basis[i] * (1 - phase + i) + self.basis[
            (i + 1) % len(self.basis)
        ] * (phase - i)

    def residual(self, action):
        action = np.asarray(action, dtype=float)
        if action.shape != (2,) or not np.isfinite(action).all():
            raise ValueError("expected finite 2D semantic residual")
        delta = self.matrix() @ (np.clip(action, -1, 1) * self.scales)
        return np.clip(delta / self.env.config.residual_scale, -1, 1)


class OriginManGym(gym.Env):
    metadata: ClassVar[dict] = {"render_modes": []}

    def __init__(
        self, scene, config=None, mode="joints", seed=0, reference=None, basis=None
    ):
        super().__init__()
        if mode not in ("joints", "feet"):
            raise ValueError("mode must be joints or feet")
        self.mode = mode
        self.physical = OriginManEnv(
            scene, config or Config(), seed=seed, reference=reference
        )
        self.modes = FootModes(self.physical) if mode == "feet" else None
        if basis is not None and self.modes:
            self.modes.basis = np.asarray(basis).copy()
        self.action_space = gym.spaces.Box(
            -1, 1, shape=(2 if mode == "feet" else 10,), dtype=np.float32
        )
        self.observation_space = gym.spaces.Box(
            -np.inf, np.inf, shape=(41,), dtype=np.float32
        )
        self.experiment_config = asdict(self.physical.config)

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        options = options or {}
        unknown = set(options) - {"force", "start", "asymmetry", "initial_yaw"}
        if unknown:
            raise ValueError("unknown reset options")
        obs = self.physical.reset(
            seed=seed,
            asymmetry=options.get("asymmetry", 0),
            initial_yaw=options.get("initial_yaw", 0),
        )
        if "force" in options:
            self.physical.push_force[:] = [0, options["force"], 0]
        if "start" in options:
            self.physical.push_start = options["start"]
        return obs, {}

    def step(self, action):
        residual = self.modes.residual(action) if self.modes else action
        obs, reward, _, info = self.physical.step(residual)
        return (
            obs,
            reward,
            info["fallen"],
            bool(info["timeout"] and not info["fallen"]),
            info,
        )


def axis_correct_feedback(env, coefficients):
    """PD residuals with roll axes expressed consistently in physical coordinates."""
    rotation, _ = env.orientation()
    roll = np.arctan2(rotation[2, 1], rotation[2, 2])
    rate = env.data.sensordata[0]
    residual = np.zeros(10)
    for indices, gains in [([4, 9], coefficients[:2]), ([0, 5], coefficients[2:])]:
        value = gains[0] * roll + gains[1] * rate
        for i in indices:
            axis_x = env.model.jnt_axis[env.leg_j[i], 0]
            if abs(axis_x) < 0.9:
                raise ValueError("roll joint axis is not predominantly local X")
            residual[i] = value / axis_x / env.config.residual_scale
    return np.clip(residual, -1, 1)
