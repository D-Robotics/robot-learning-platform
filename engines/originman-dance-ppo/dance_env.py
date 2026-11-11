"""Learner-configurable, beat-conditioned OriginMan dance task."""

from __future__ import annotations

import math

import gymnasium as gym
import numpy as np

from body import DT, Dance

SECTION_TYPES = {
    "alternating-arms",
    "weight-shift",
    "squat-rise",
    "open-pose",
}
MAX_SECTIONS = 8

# Learner-tunable reward knobs. Defaults are the validated 2026-11-11 reward
# shaping; overrides must stay inside these safety bounds.
REWARD_TUNING_LIMITS = {
    "weightShiftTargetM": (0.02, 0.06),
    "weightShiftToleranceM": (0.008, 0.04),
    "squatDepthM": (0.02, 0.07),
    "squatToleranceM": (0.008, 0.04),
    "settleStillnessWeight": (1.0, 4.0),
    "workPenalty": (0.2, 1.5),
    "squatWorkPenalty": (0.05, 1.0),
    "tiltPenalty": (1.0, 6.0),
    "armSwingWeight": (1.0, 8.0),
    "armSpeedWeight": (0.2, 4.0),
    "weightShiftWeight": (1.0, 8.0),
    "squatWeight": (1.0, 8.0),
    "settleArmsWeight": (0.2, 6.0),
}
DEFAULT_REWARD_TUNING = {
    "weightShiftTargetM": 0.036,
    "weightShiftToleranceM": 0.016,
    "squatDepthM": 0.042,
    "squatToleranceM": 0.018,
    "settleStillnessWeight": 2.6,
    "workPenalty": 0.8,
    "squatWorkPenalty": 0.35,
    "tiltPenalty": 3.0,
    "armSwingWeight": 4.0,
    "armSpeedWeight": 1.5,
    "weightShiftWeight": 3.4,
    "squatWeight": 3.5,
    "settleArmsWeight": 2.5,
}


def validate_reward_tuning(value):
    """Validate optional learner reward overrides; {} means engine defaults."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("originmanDance.rewardTuning must be an object of reward overrides")
    unknown = set(value) - set(REWARD_TUNING_LIMITS)
    if unknown:
        raise ValueError(
            "originmanDance.rewardTuning contains unsupported fields: " + ", ".join(sorted(unknown))
        )
    overrides = {}
    for key, raw in value.items():
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
            raise ValueError(f"originmanDance.rewardTuning.{key} must be a finite number")
        low, high = REWARD_TUNING_LIMITS[key]
        if not low <= raw <= high:
            raise ValueError(f"originmanDance.rewardTuning.{key} must be in [{low}, {high}]")
        overrides[key] = float(raw)
    return overrides


def alternating_arm_targets(local_beat, intensity):
    """Position extrema land on beats; velocity peaks when arms swap halfway.

    The speed pulse must follow the derivative of the position target. A pulse
    on integer beats rewards speed precisely where the arms should turn around.
    Intensity changes displacement, rather than weakening the learning signal.
    """
    wave = math.cos(math.pi * local_beat)
    pulse = math.sin(math.pi * local_beat) ** 4
    return (0.075 + 0.055 * intensity) * wave, pulse


def validate_dance_config(value: dict) -> dict:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("task.originmanDance must be a schemaVersion 1 object")
    allowed = {"schemaVersion", "title", "bpm", "sections", "seed", "trainingSteps", "totalBeats", "rewardTuning"}
    if set(value) - allowed:
        raise ValueError("task.originmanDance contains unknown fields")
    bpm = value.get("bpm")
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)) or not math.isfinite(bpm) or not 80 <= bpm <= 140:
        raise ValueError("originmanDance.bpm must be finite and in [80, 140]")
    sections = value.get("sections")
    if not isinstance(sections, list) or not 1 <= len(sections) <= 8:
        raise ValueError("originmanDance.sections must contain 1 to 8 sections")
    normalized = []
    for index, section in enumerate(sections):
        if not isinstance(section, dict) or set(section) != {"type", "beats", "intensity"}:
            raise ValueError(f"originmanDance.sections[{index}] has an invalid shape")
        if section["type"] not in SECTION_TYPES:
            raise ValueError(f"originmanDance.sections[{index}].type is unsupported")
        if section["beats"] not in (4, 8, 16):
            raise ValueError(f"originmanDance.sections[{index}].beats must be 4, 8, or 16")
        intensity = section["intensity"]
        if isinstance(intensity, bool) or not isinstance(intensity, (int, float)) or not math.isfinite(intensity) or not 0.25 <= intensity <= 1:
            raise ValueError(f"originmanDance.sections[{index}].intensity must be in [0.25, 1]")
        normalized.append({"type": section["type"], "beats": int(section["beats"]), "intensity": float(intensity)})
    total_beats = sum(section["beats"] for section in normalized)
    if total_beats > 128:
        raise ValueError("originmanDance totalBeats must not exceed 128")
    if "totalBeats" in value and value["totalBeats"] != total_beats:
        raise ValueError("originmanDance.totalBeats must match the configured sections")
    seed = value.get("seed", 7)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**31 - 1:
        raise ValueError("originmanDance.seed must be an integer in [0, 2147483647]")
    # Keep the default aligned with the learner-facing quality experiment.
    # 8192 steps is reserved for explicit adapter/contract smoke runs.
    steps = value.get("trainingSteps", 500_000)
    if isinstance(steps, bool) or not isinstance(steps, int) or not 8192 <= steps <= 2_000_000:
        raise ValueError("originmanDance.trainingSteps must be an integer in [8192, 2000000]")
    reward_overrides = validate_reward_tuning(value.get("rewardTuning"))
    result = {
        "schemaVersion": 1,
        "title": str(value.get("title", "OriginMan dance"))[:80],
        "bpm": float(bpm),
        "sections": normalized,
        "totalBeats": total_beats,
        "seed": seed,
        "trainingSteps": steps,
    }
    if reward_overrides:
        result["rewardTuning"] = reward_overrides
    return result


class ConfigurableChoreography(Dance):
    """The policy follows a student-authored schedule using bounded reward terms."""

    def __init__(self, bundle, dance_config, training=False):
        self.dance_config = validate_dance_config(dance_config)
        self.reward = {**DEFAULT_REWARD_TUNING, **self.dance_config.get("rewardTuning", {})}
        self.sections = self.dance_config["sections"]
        self.starts = np.cumsum([0] + [item["beats"] for item in self.sections[:-1]]).astype(float)
        self.ends = self.starts + np.asarray([item["beats"] for item in self.sections], dtype=float)
        super().__init__(bundle, training=training)
        self.observation_space = gym.spaces.Box(
            -np.inf,
            np.inf,
            (11 + 3 * len(self.names) + MAX_SECTIONS + 5,),
            dtype=np.float32,
        )
        self.hands = [self.model.body(f"{side}_hand_link").id for side in ("l", "r")]
        self.scale[self.arms] = 0.88
        self.scale[self.legs] *= 1.24

    def reset(self, *, seed=None, options=None):
        self.start_beat = 0.0
        self.end_beat = float(self.dance_config["totalBeats"])
        selected_bpm = float((options or {}).get("bpm", self.dance_config["bpm"]))
        super().reset(seed=seed, options={"bpm": selected_bpm})
        if self.training and options is None:
            self.bpm = float(np.clip(self.np_random.normal(self.dance_config["bpm"], 2.0), 80, 140))
        if self.training and len(self.sections) > 1 and self.np_random.random() < 0.5:
            index = int(self.np_random.integers(len(self.sections)))
            self.start_beat = float(self.starts[index])
            self.end_beat = float(self.ends[index])
        return self.observe(), {}

    def condition(self):
        beat = min(self.end_beat - 1e-8, self.start_beat + self.beat())
        index = min(len(self.sections) - 1, int(np.searchsorted(self.ends, beat, side="right")))
        item = self.sections[index]
        local = max(0.0, beat - self.starts[index])
        progress = min(1.0, local / item["beats"])
        return beat, index, local, progress, item

    def observe(self):
        _, index, _, progress, _ = self.condition()
        return np.r_[
            super().observe(),
            np.eye(MAX_SECTIONS, dtype=np.float32)[index],
            math.sin(2 * math.pi * progress),
            math.cos(2 * math.pi * progress),
            math.sin(math.pi * progress),
            math.cos(math.pi * progress),
            float(index == len(self.sections) - 1 and progress >= 0.75),
        ].astype(np.float32)

    def step(self, action):
        _, _, failed, _, info = super().step(action)
        beat, index, local, progress, section = self.condition()
        root = self.data.xpos[self.torso]
        orientation = self.data.xmat[self.torso].reshape(3, 3)
        hand = (self.data.xpos[self.hands] - root) @ orientation
        asymmetry = float(hand[0, 0] - hand[1, 0])
        spread = float(hand[0, 1] - hand[1, 1])
        arm_forward = float(np.mean(hand[:, 0]))
        lateral = float(root[1])
        height = float(root[2])
        speed = float(info["armSpeed"] + info["legSpeed"])
        pulse = float(info["pulse"])
        intensity = section["intensity"]
        accent = (1.9 * pulse - 0.75) * min(info["armSpeed"], 2.0)
        wave = math.cos(math.pi * local)
        slow = math.cos(math.pi * progress)
        if section["type"] == "alternating-arms":
            target, pulse = alternating_arm_targets(local, intensity)
            style = (
                self.reward["armSwingWeight"] * math.exp(-((asymmetry - target) / 0.045) ** 2)
                + self.reward["armSpeedWeight"] * math.exp(-((info["armSpeed"] - (0.15 + 1.8 * pulse)) / 0.65) ** 2)
            )
        elif section["type"] == "weight-shift":
            target = self.reward["weightShiftTargetM"] * slow
            style = intensity * (
                self.reward["weightShiftWeight"] * math.exp(-((lateral - target) / self.reward["weightShiftToleranceM"]) ** 2)
                + 0.8 * np.clip(slow * lateral / self.reward["weightShiftTargetM"], -1, 1)
                + 0.55 * accent
            )
        elif section["type"] == "squat-rise":
            target = self.robot.base_height - 0.009 - self.reward["squatDepthM"] * (0.5 - 0.5 * slow)
            style = intensity * (
                self.reward["squatWeight"] * math.exp(-((height - target) / self.reward["squatToleranceM"]) ** 2)
                + 1.10 * np.clip(-slow * arm_forward / 0.13, -1, 1)
                + 0.4 * accent
            )
        else:
            settle = float(progress >= 0.75)
            open_arms = np.clip((spread - 0.18) / 0.17, 0, 1.4)
            style = intensity * (
                (1 - settle) * (accent + 0.85 * open_arms)
                + settle * (self.reward["settleArmsWeight"] * open_arms + self.reward["settleStillnessWeight"] * math.exp(-2.2 * speed**2))
            )
        tilt = math.radians(info["tiltDeg"])
        work = info["mechanicalWorkJ"] - getattr(self, "previous_work", 0.0) if self.ticks > 1 else info["mechanicalWorkJ"]
        self.previous_work = info["mechanicalWorkJ"]
        work_cost = self.reward["squatWorkPenalty"] if section["type"] == "squat-rise" else self.reward["workPenalty"]
        reward = (
            1.0 + style
            - self.reward["tiltPenalty"] * tilt**2
            - 8.0 * float(root[0])**2
            - 2.0 * lateral**2
            - work_cost * work
            - 13.0 * float(failed)
        )
        complete = self.start_beat + self.beat() >= self.end_beat and not failed
        info.update(
            pulse=pulse,
            section=index,
            sectionType=section["type"],
            sectionBeat=local,
            sectionProgress=progress,
            phraseBeat=beat,
            lateralM=lateral,
            heightM=height,
            handAsymmetryM=asymmetry,
            handSpanM=spread,
            armForwardM=arm_forward,
            direction=wave,
            slow=slow,
            baseHeightM=self.robot.base_height,
            episodeDone=bool(failed or complete),
            taskSuccess=bool(complete),
        )
        return self.observe(), float(reward), bool(failed), bool(complete), info
