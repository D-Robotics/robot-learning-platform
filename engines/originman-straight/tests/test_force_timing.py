"""Disturbance timing must follow physics ticks, independently of control rate."""

import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from env import Config, OriginManEnv


def make_env(period, duration=0.2):
    scene = os.environ.get("ORIGINMAN_SCENE")
    if not scene:
        pytest.skip("ORIGINMAN_SCENE must name caller-owned adapted robot scene")
    return OriginManEnv(scene, Config(control_dt=period, push_duration=duration))


@pytest.mark.parametrize("period", [0.02, 0.04])
def test_aligned_force_does_not_shift_a_whole_control_period(period):
    env = make_env(period)
    env.push_start = 4.6
    env.push_force[:] = [0, 1, 0]
    first = None
    impulse = 0.0
    for _ in range(round(5 / period)):
        _, _, _, info = env.step(np.zeros(10))
        force = info["externalForceWorldN"][1]
        if force and first is None:
            first = info["time"] - period
        impulse += force * period
    assert first == pytest.approx(4.6, abs=1e-9)
    assert impulse == pytest.approx(0.2, abs=1e-10)


@pytest.mark.parametrize("period", [0.02, 0.04])
def test_non_aligned_force_has_physics_accurate_impulse(period):
    env = make_env(period, duration=0.215)
    env.model.opt.timestep = 0.001
    env.push_start = 1.31
    env.push_force[:] = [0, 1, 0]
    impulse = 0.0
    for _ in range(round(1.8 / period)):
        _, _, _, info = env.step(np.zeros(10))
        impulse += info["externalForceWorldN"][1] * period
    assert impulse == pytest.approx(0.215, abs=1e-10)
