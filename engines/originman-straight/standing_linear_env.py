"""Minimal IMU-only observation for an interpretable learned roll controller."""

import gymnasium as gym
import numpy as np
from standing_env import StandingGym


class RollRateGym(StandingGym):
    scales = np.array(
        [0.2, 2.0]
    )  # radians, radians/second; fixed, not learned statistics

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.observation_space = gym.spaces.Box(
            -np.inf, np.inf, shape=(2,), dtype=np.float32
        )

    def observation(self):
        rotation, _ = self.physical.orientation()
        roll = np.arctan2(rotation[2, 1], rotation[2, 2])
        return (
            np.array([roll, self.physical.data.sensordata[0]]) / self.scales
        ).astype(np.float32)

    def reset(self, *, seed=None, options=None):
        _, info = super().reset(seed=seed, options=options)
        return self.observation(), info

    def step(self, action):
        _, reward, terminated, truncated, info = super().step(action)
        obs = self.observation()
        info["policyObservation"] = obs.tolist()
        return obs, reward, terminated, truncated, info
