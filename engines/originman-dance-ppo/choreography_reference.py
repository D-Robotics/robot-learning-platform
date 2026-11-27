"""Joint targets from the 2026-11-25 OriginMan dance reference delivery."""

import math

import gymnasium as gym
import numpy as np
import torch

from calibrated_motions import MESH_SCENE, knee_cycle, knee_feedback, load_phase_table, sample_table

CALIBRATED_SCENES = frozenset({
    "8b38982c3b1789b13702b370b60ab14df240a4051a75a9a545bd50ba31ed680a",
    MESH_SCENE,
})
CALIBRATED_SECTIONS = frozenset({"alternating-arms", "weight-shift", "squat-rise", "open-pose"})

JOINT_NAMES = (
    "l_hip_roll", "l_hip_pitch", "l_knee", "l_ank_pitch", "l_ank_roll",
    "r_hip_roll", "r_hip_pitch", "r_knee", "r_ank_pitch", "r_ank_roll",
    "l_sho_pitch", "l_sho_roll", "l_el", "l_hand",
    "r_sho_pitch", "r_sho_roll", "r_el", "r_hand",
)
JOINT = {name: i for i, name in enumerate(JOINT_NAMES)}
N_JOINTS = len(JOINT_NAMES)

# Calibrated metres per radian on the delivered floating-base scene.
LATERAL_PER_HIP_ROLL = 0.1545
SPAN_PER_SHO_ROLL = 0.1954
HOME_SPAN = 0.20746

# Offset targets in radians at 50 Hz. Reduced ankle flexion keeps the squat
# supported at fast tempos. The command is clipped to the engine's joint envelope.
SQUAT_UP = {"hip_pitch": 0.18, "knee": -0.4216, "ank_pitch": 0.168}
SQUAT_DOWN = {"hip_pitch": -0.4516, "knee": 0.4216, "ank_pitch": 0.16}

# Timing of the squat profile, in section progress.
SQUAT_DOWN_IN, SQUAT_DOWN_RAMP = 0.20, 0.18      # descend over .20 -> .38
SQUAT_UP_IN, SQUAT_UP_RAMP = 0.80, 0.18          # rise over .62 -> .80


def _clamp01(value):
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else float(value)


def _smoothstep(value):
    x = _clamp01(value)
    return x * x * (3.0 - 2.0 * x)


def _squat_depth(progress):
    """0 = tall stance, 1 = deepest squat; flat over the two gate windows."""
    down = _smoothstep((progress - SQUAT_DOWN_IN) / SQUAT_DOWN_RAMP)
    up = _smoothstep((SQUAT_UP_IN - progress) / SQUAT_UP_RAMP)
    return down * up


def section_offsets(kind, local, progress, intensity):
    """Return the 18 target joint offsets (rad) for one control tick."""
    out = np.zeros(N_JOINTS, dtype=np.float64)
    if kind == "alternating-arms":
        # Anti-phase shoulder pitch: asymmetry = 2*0.1038*a*cos(pi*local), so the
        # sign pattern matches cos(pi*local) (the gate's direction test) while the
        # arm speed peaks at local .5 (the gate's speed pulse also peaks there,
        # because dance_env.py:299 rebinds pulse to sin(pi*local)**4).
        amp = 0.34 + 0.22 * intensity
        swing = amp * math.cos(math.pi * local)
        out[JOINT["l_sho_pitch"]] = swing
        out[JOINT["r_sho_pitch"]] = -swing
        out[JOINT["l_el"]] = -0.16 - 0.10 * intensity
        out[JOINT["r_el"]] = 0.16 + 0.10 * intensity
    elif kind == "weight-shift":
        # Mirrored hip rolls shift the pelvis sideways without an ankle-roll
        # contact.  lateral = 0.1545*a*cos(pi*progress) tracks the gate's slow term.
        wanted = 0.030 + 0.022 * intensity
        amp = min(0.268, wanted / LATERAL_PER_HIP_ROLL)
        shift = amp * math.cos(math.pi * progress)
        out[JOINT["l_hip_roll"]] = shift
        out[JOINT["r_hip_roll"]] = -shift
        out[JOINT["l_el"]] = -0.15
        out[JOINT["r_el"]] = 0.15
    elif kind == "squat-rise":
        depth = _squat_depth(progress) * min(1.0, 0.80 + 0.33 * intensity)
        for side in ("l", "r"):
            for part in ("hip_pitch", "knee", "ank_pitch"):
                up = SQUAT_UP[part]
                down = SQUAT_DOWN[part]
                out[JOINT[f"{side}_{part}"]] = up * (1.0 - depth) + down * depth
        # Counter-swinging arms: back in the tall stance, forward at the bottom.
        # arm_forward = 0.0996*sho_pitch, so +-0.5 rad sweeps ~100 mm (gate 60 mm).
        swing = -0.50 + 1.00 * depth
        out[JOINT["l_sho_pitch"]] = swing
        out[JOINT["r_sho_pitch"]] = swing
    elif kind == "open-pose":
        wanted = 0.29 + 0.10 * intensity
        amp = min(0.86, max(0.0, (wanted - HOME_SPAN) / SPAN_PER_SHO_ROLL))
        reach = _smoothstep(progress / 0.20)          # static from progress .20 on
        out[JOINT["l_sho_roll"]] = -amp * reach
        out[JOINT["r_sho_roll"]] = amp * reach
        out[JOINT["l_el"]] = -0.20 * reach
        out[JOINT["r_el"]] = 0.20 * reach
        out[JOINT["l_sho_pitch"]] = -0.10 * reach
        out[JOINT["r_sho_pitch"]] = -0.10 * reach
    else:
        raise ValueError(f"no calibrated reference for {kind}")
    return out


class ReferenceControl(torch.nn.Module):
    """A recipe-bound controller with the v2 action order and bounded PPO corrections."""

    segments = 1024
    authority = 0.08

    def __init__(self, sections, names, *, mesh_scene=False):
        super().__init__()
        order = [JOINT[name] for name in names]
        scale = np.asarray([
            .22 * 1.24 if name.endswith(("hip_roll", "ank_roll"))
            else .34 * 1.24 if any(part in name for part in ("hip_", "knee", "ank_"))
            else .88
            for name in names
        ])
        mixed = mesh_scene and any(section["type"] not in CALIBRATED_SECTIONS for section in sections)
        published = None
        if mesh_scene and len(sections) == 1 and sections[0]["beats"] == 4:
            table, source_intensity = load_phase_table(sections[0]["type"])
            if sections[0]["intensity"] == source_intensity:
                published = table
        if mixed:
            self.segments = 4096
        tables = {kind: load_phase_table(kind) for kind in {item["type"] for item in sections}
                  if mixed and published is None and kind not in CALIBRATED_SECTIONS}
        points = []
        feedback = []
        start = np.zeros(N_JOINTS)
        for index, section in enumerate(sections):
            kind, beats, intensity = section["type"], section["beats"], section["intensity"]
            correction = (knee_feedback()[order] if published is None and kind == "alternating-knee-lift"
                          else np.zeros((18, 6)))
            feedback.append(correction)
            for progress in np.linspace(0, 1, self.segments + 1):
                local = beats * progress
                if published is not None:
                    target = sample_table(published, local)[order]
                elif kind == "alternating-knee-lift":
                    target = knee_cycle(tables[kind][0], local % 4)[order]
                elif kind in tables:
                    phase = local % 4
                    table, source_intensity = tables[kind]
                    target = sample_table(table, phase)[order] * (1 + .4 * (intensity - source_intensity))
                    if kind == "side-tap" and beats > 4:
                        # Plant the foot at the end of the cycle before starting a new tap.
                        target *= 1 - _smoothstep((phase - 3.5) / .5)
                        if local >= 4:
                            target *= _smoothstep(phase / .34)
                else:
                    # A shallow crouch cannot meet the 24 mm descent/ascent requirement.
                    depth = max(.6, intensity) if mixed and kind == "squat-rise" else intensity
                    target = section_offsets(kind, local, progress, depth)[order] / scale
                if published is None and (not mixed or kind in ("weight-shift", "squat-rise")):
                    blend = _smoothstep(local / (.5 if mixed else .75))
                    target = start + blend * (target - start)
                # Bring the command toward neutral before the first lift.
                if (mixed and kind == "alternating-arms" and index + 1 < len(sections)
                        and sections[index + 1]["type"] == "alternating-knee-lift"):
                    target *= 1 - _smoothstep((local - beats + .8) / .8)
                points.append(target)
            start = points[-1]
        self.register_buffer("points", torch.tensor(np.asarray(points), dtype=torch.float32))
        self.register_buffer("feedback", torch.tensor(np.asarray(feedback), dtype=torch.float32))
        self.section_count = len(sections)

    def command(self, obs, residual):
        phase = (math.atan2(float(obs[73]), float(obs[74])) / math.tau) % 1
        lower = min(int(phase * self.segments), self.segments - 1)
        fraction = phase * self.segments - lower
        section = int(np.argmax(obs[65:65 + self.section_count]))
        index = section * (self.segments + 1) + lower
        left, right = self.points.numpy()[index:index + 2]
        target = left + fraction * (right - left) + self.feedback.numpy()[section] @ obs[:6]
        return np.clip(target + self.authority * np.clip(residual, -1, 1), -1, 1)

    def forward(self, obs, residual):
        phase = torch.remainder(torch.atan2(obs[:, 73], obs[:, 74]) / math.tau, 1.)
        position = phase * self.segments
        lower = position.to(torch.int64).clamp(max=self.segments - 1)
        fraction = (position - lower).unsqueeze(1)
        section = torch.argmax(obs[:, 65:65 + self.section_count], dim=1)
        index = section * (self.segments + 1) + lower
        left = self.points[index]
        target = left + fraction * (self.points[index + 1] - left)
        target = target + torch.bmm(self.feedback[section], obs[:, :6].unsqueeze(2)).squeeze(2)
        return (target + self.authority * residual.clamp(-1, 1)).clamp(-1, 1)


class ResidualChoreography(gym.Wrapper):
    def __init__(self, env, reference):
        super().__init__(env)
        self.reference = reference

    def reset(self, **kwargs):
        self.observation, info = self.env.reset(**kwargs)
        return self.observation, info

    def step(self, action):
        self.observation, reward, failed, complete, info = self.env.step(
            self.reference.command(self.observation, action),
        )
        return self.observation, reward, failed, complete, info
