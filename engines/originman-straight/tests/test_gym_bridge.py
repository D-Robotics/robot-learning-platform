import os
import sys
from pathlib import Path

import mujoco
import numpy as np
import pytest

pytest.importorskip("gymnasium")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from env import Config
from gym_bridge import OriginManGym, axis_correct_feedback


@pytest.fixture(scope="module")
def bridge():
    scene = os.environ.get("ORIGINMAN_SCENE")
    if not scene:
        pytest.skip("caller-owned model with semantic foot frame required")
    return OriginManGym(scene, Config(), mode="feet")


def test_foot_modes_match_actual_kinematics_and_not_assumed_joint_signs(bridge):
    env = bridge.physical
    data = mujoco.MjData(env.model)
    for k in [0, 30, 60, 90]:
        data.qpos[:] = env.home
        data.qpos[env.qa] = env.reference[k]
        mujoco.mj_forward(env.model, data)
        before = [env.foot_pose(data, side)[0] for side in range(2)]
        data.qpos[env.qa] += bridge.modes.basis[k, :, 0] * 1e-5
        mujoco.mj_forward(env.model, data)
        for side in range(2):
            delta = env.foot_pose(data, side)[0] - before[side]
            np.testing.assert_allclose(delta, [0, 1e-5, 0], atol=2e-8)
    np.testing.assert_allclose(bridge.modes.residual(np.zeros(2)), 0)


def test_feedback_hip_axes_produce_same_physical_rotation(bridge):
    env = bridge.physical
    env.reset()
    env.data.qpos[3:7] = [np.cos(0.05), np.sin(0.05), 0, 0]
    mujoco.mj_forward(env.model, env.data)
    action = axis_correct_feedback(env, [0, 0, 0.5, 0])
    actual = (
        action[[0, 5]]
        * env.config.residual_scale
        * env.model.jnt_axis[env.leg_j[[0, 5]], 0]
    )
    np.testing.assert_allclose(actual, [0.05, 0.05], atol=1e-8)
    assert action[0] * action[5] < 0


def test_gym_timeout_is_truncation_and_fall_is_termination(bridge):
    scene = (
        bridge.physical.scene
        if hasattr(bridge.physical, "scene")
        else os.environ["ORIGINMAN_SCENE"]
    )
    short = OriginManGym(scene, Config(episode_seconds=1), mode="joints")
    short.reset(seed=8)
    for _ in range(50):
        _, _, terminated, truncated, _ = short.step(np.zeros(10))
    assert truncated and not terminated
    short.reset(seed=8)
    short.physical.data.qpos[2] += 0.1
    short.physical.data.qpos[3:7] = [2**-0.5, 2**-0.5, 0, 0]
    _, _, terminated, truncated, _ = short.step(np.zeros(10))
    assert terminated and not truncated
