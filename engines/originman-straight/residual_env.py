"""Frozen ankle PD plus a bounded, per-control-step hip/ankle RL correction."""

import gymnasium as gym
import numpy as np
from standing_env import StandingGym, feedback

CONTROLLER = {
    "baselineGains": [2.5, 0.225, 0.0, 0.0],
    "correctionRadians": [0.12, 0.20],
    "actionOrder": ["ankle physical roll correction", "hip physical roll correction"],
    "observation": "roll/.2, gyroX/2, pitch/.2, gyroY/2, physical hip/ankle offsets/.3 (Lhip,Lank,Rhip,Rank), velocities/3, previous requested correction (2)",
    "observationSize": 14,
    "composition": "clip(frozen PD normalized target + correctionRadians * actorAction / residual_scale); original joint amplitude, slew and actuator limits apply",
    "hardwareEligible": False,
}


class ResidualStandingGym(StandingGym):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.gains = np.asarray(CONTROLLER["baselineGains"], dtype=float)
        self.correction_radians = np.asarray(
            CONTROLLER["correctionRadians"], dtype=float
        )
        self.previous_correction = np.zeros(2)
        self.observation_space = gym.spaces.Box(
            -np.inf, np.inf, shape=(14,), dtype=np.float32
        )

    def observation(self):
        env = self.physical
        rotation, _ = env.orientation()
        roll = np.arctan2(rotation[2, 1], rotation[2, 2])
        pitch = np.arcsin(np.clip(-rotation[2, 0], -1, 1))
        index = np.array([0, 4, 5, 9])
        axes = env.model.jnt_axis[env.leg_j[index], 0]
        offset = (env.data.qpos[env.qa[index]] - env.home[env.qa[index]]) * axes
        velocity = env.data.qvel[env.va[index]] * axes
        return np.r_[
            roll / 0.2,
            env.data.sensordata[0] / 2,
            pitch / 0.2,
            env.data.sensordata[1] / 2,
            offset / 0.3,
            velocity / 3,
            self.previous_correction,
        ].astype(np.float32)

    def reset(self, *, seed=None, options=None):
        _, info = super().reset(seed=seed, options=options)
        self.previous_correction[:] = 0
        return self.observation(), info

    def step(self, action):
        action = np.asarray(action, dtype=float)
        if action.shape != (2,) or not np.isfinite(action).all():
            raise ValueError("expected finite ankle/hip correction")
        requested = np.clip(action, -1, 1)
        base = feedback(self, self.gains)
        previous_executed = self.physical.last_action.copy()
        baseline_joint_request = self.modes.residual(base)
        baseline_same_state_target = np.clip(
            baseline_joint_request, previous_executed - 0.25, previous_executed + 0.25
        )
        correction = (
            requested * self.correction_radians / self.physical.config.residual_scale
        )
        _, reward, terminated, truncated, info = super().step(
            np.clip(base + correction, -1, 1)
        )
        self.previous_correction[:] = requested
        extra_target = self.physical.last_action - baseline_same_state_target
        axes = self.physical.model.jnt_axis[self.physical.leg_j[[4, 0]], 0]
        # A quiet recovered state is the target; do not substitute survival for settling.
        terms = dict(info["rewardTerms"])
        terms["settled_bonus"] = 2.0 if info["settled"] else 0.0
        terms["learned_correction_penalty"] = float(-0.02 * np.sum(requested**2))
        terms["terminal_recovery_bonus"] = 50.0 if info["recoverySuccess"] else 0.0
        reward += sum(
            terms[k]
            for k in [
                "settled_bonus",
                "learned_correction_penalty",
                "terminal_recovery_bonus",
            ]
        )
        observation = self.observation()
        info.update(
            reward=reward,
            rewardTerms=terms,
            baseFeedback=base.tolist(),
            learningCorrectionRequested=requested.tolist(),
            learningCorrectionRadians=(requested * self.correction_radians).tolist(),
            combinedRequest=np.clip(base + correction, -1, 1).tolist(),
            executedExtraTargetRadians=(
                extra_target[[4, 0]] * axes * self.physical.config.residual_scale
            ).tolist(),
            policyObservation=observation.tolist(),
        )
        return observation, reward, terminated, truncated, info
