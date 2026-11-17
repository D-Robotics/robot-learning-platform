"""Stationary disturbance recovery using the same free robot and actuator limits."""

from collections import deque

import gymnasium as gym
import numpy as np
from gym_bridge import OriginManGym

CRITERIA = {
    "windowSeconds": 1.0,
    "minimumSettledFraction": 0.9,
    "maximumTiltDegrees": 5.0,
    "maximumAngularSpeedRadS": 0.3,
    "maximumPlanarSpeedMS": 0.05,
    "minimumHeightFraction": 0.85,
    "maximumPlanarDisplacementM": 0.12,
}


class RollModes:
    """Physical +X ankle/hip rotations; model axes determine raw joint signs."""

    def __init__(self, env):
        self.env = env
        self.basis = np.zeros((len(env.reference), 10, 2))
        for column, indices in enumerate([[4, 9], [0, 5]]):
            for i in indices:
                axis = env.model.jnt_axis[env.leg_j[i], 0]
                if abs(axis) < 0.9:
                    raise ValueError("expected roll joints along local X")
                self.basis[:, i, column] = 1 / axis

    def residual(self, action):
        action = np.asarray(action)
        if action.shape != (2,) or not np.isfinite(action).all():
            raise ValueError("expected finite two-dimensional roll action")
        return np.clip(self.basis[0] @ np.clip(action, -1, 1), -1, 1)


class StandingGym(OriginManGym):
    def __init__(self, scene, config, mode="roll", seed=0, reference=None):
        if mode != "roll" or any(
            [config.stride, config.lift, config.sway, config.lean]
        ):
            raise ValueError("standing requires zero reference motion and roll mode")
        if not config.residual_scale:
            raise ValueError("standing residual scale must be positive")
        super().__init__(scene, config, mode="joints", seed=seed, reference=reference)
        self.mode = mode
        self.modes = RollModes(self.physical)
        self.action_space = gym.spaces.Box(-1, 1, shape=(2,), dtype=np.float32)
        self.window = deque(maxlen=round(CRITERIA["windowSeconds"] / config.control_dt))
        self.previous_position = np.zeros(2)

    def reset(self, *, seed=None, options=None):
        obs, info = super().reset(seed=seed, options=options)
        self.window.clear()
        self.previous_position = self.physical.data.qpos[:2].copy()
        # No-force retention episodes are declared as part of the training distribution.
        if options is None and self.physical.rng.random() < 0.2:
            self.physical.push_force[:] = 0
        return obs, info

    def step(self, action):
        previous = self.physical.last_action.copy()
        obs, _, terminated, truncated, info = super().step(action)
        env = self.physical
        rotation, _ = env.orientation()
        tilt = float(np.arccos(np.clip(rotation[2, 2], -1, 1)))
        angular = float(np.linalg.norm(env.data.sensordata[:3]))
        planar_velocity = (
            env.data.qpos[:2] - self.previous_position
        ) / env.config.control_dt
        self.previous_position = env.data.qpos[:2].copy()
        speed = float(np.linalg.norm(planar_velocity))
        displacement = float(np.linalg.norm(env.data.qpos[:2]))
        height_fraction = float(env.data.qpos[2] / env.base_height)
        settled = bool(
            np.degrees(tilt) <= CRITERIA["maximumTiltDegrees"]
            and angular <= CRITERIA["maximumAngularSpeedRadS"]
            and speed <= CRITERIA["maximumPlanarSpeedMS"]
            and height_fraction >= CRITERIA["minimumHeightFraction"]
            and displacement <= CRITERIA["maximumPlanarDisplacementM"]
            and all(info["footContacts"])
        )
        self.window.append(settled)
        terms = {
            "alive": 1.0,
            "upright": float(2 * np.exp(-8 * tilt * tilt)),
            "calm": float(np.exp(-0.5 * angular * angular)),
            "height": float(0.5 * np.exp(-20 * (height_fraction - 1) ** 2)),
            "velocity_penalty": float(-2 * speed * speed),
            "displacement_penalty": float(-displacement * displacement),
            "residual_penalty": float(-0.01 * np.sum(env.last_action**2)),
            "action_rate_penalty": float(
                -0.03 * np.sum((env.last_action - previous) ** 2)
            ),
            "fall_penalty": -30.0 if terminated else 0.0,
        }
        reward = sum(terms.values())
        fraction = float(np.mean(self.window))
        recovered = bool(
            truncated
            and not terminated
            and len(self.window) == self.window.maxlen
            and fraction >= CRITERIA["minimumSettledFraction"]
        )
        info.update(
            reward=reward,
            rewardTerms=terms,
            tiltDegrees=float(np.degrees(tilt)),
            angularSpeed=angular,
            planarSpeed=speed,
            planarDisplacement=displacement,
            settled=settled,
            settledFraction=fraction,
            recoverySuccess=recovered,
        )
        return obs, reward, terminated, truncated, info


def feedback(bridge, gains):
    env = bridge.physical
    rotation, _ = env.orientation()
    roll = np.arctan2(rotation[2, 1], rotation[2, 2])
    rate = env.data.sensordata[0]
    return np.clip(
        np.array(
            [
                gains[0] * roll + gains[1] * rate,
                gains[2] * roll + gains[3] * rate,
            ]
        )
        / env.config.residual_scale,
        -1,
        1,
    )


def episode(bridge, case, actor, trace=False):
    obs, _ = bridge.reset(
        seed=100, options={"force": case["force"], "start": case["start"]}
    )
    frames, total, peak = [], 0.0, 0.0
    for step in range(
        round(
            bridge.physical.config.episode_seconds / bridge.physical.config.control_dt
        )
    ):
        obs, reward, done, timeout, info = bridge.step(actor(obs))
        total += reward
        peak = max(peak, info["tiltDegrees"])
        if trace and (step % 2 == 0 or done or timeout):
            frames.append({**info, **bridge.physical.diagnostic_frame()})
        if done or timeout:
            break
    result = {
        **case,
        "recoverySuccess": info["recoverySuccess"],
        "fallen": info["fallen"],
        "seconds": info["time"],
        "return": total,
        "peakTiltDegrees": peak,
        "finalTiltDegrees": info["tiltDegrees"],
        "settledFraction": info["settledFraction"],
        "forwardM": info["x"],
        "lateralM": info["y"],
        "finalAngularSpeed": info["angularSpeed"],
        "finalPlanarSpeed": info["planarSpeed"],
        "finalHeightFraction": info["height"] / bridge.physical.base_height,
    }
    if trace:
        result["frames"] = frames
    return result
