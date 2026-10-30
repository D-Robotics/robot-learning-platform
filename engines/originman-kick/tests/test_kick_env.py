import os
import sys
from pathlib import Path

import mujoco
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from experiment import TEST_TARGETS, TRAIN_TARGETS, score, valid
from kick_env import KickEnv, prepare_scene


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    source = os.environ.get("ORIGINMAN_SCENE")
    if not source:
        pytest.skip("ORIGINMAN_SCENE must name caller-owned adapted robot scene")
    out = tmp_path_factory.mktemp("originman-kick")
    scene = prepare_scene(source, out)
    return KickEnv(out / "source-scene.xml", scene)


def test_full_robot_and_free_ball_are_physical(env):
    m = env.model
    assert (m.nq, m.nv, m.nu) == (34, 32, 20)
    assert m.jnt_type[0] == mujoco.mjtJoint.mjJNT_FREE
    assert m.jnt_type[env.ball_j] == mujoco.mjtJoint.mjJNT_FREE
    assert m.neq == 0 and m.body_mass.sum() == pytest.approx(2.0123891)
    assert np.all(env.data.xfrc_applied == 0)


def test_missed_kick_does_not_inject_ball_motion(env):
    r = env.rollout([-1, 0])
    assert not r["footBallContact"]
    assert abs(r["ballForwardM"]) < 1e-6 and abs(r["ballLateralM"]) < 1e-6
    assert r["ballSpeedMps"] < 1e-6


def test_slow_kick_moves_ball_and_recovers(env):
    r = env.rollout([1 / 3, 1], trace=True)
    assert r["footBallContact"] and not r["otherRobotBallContact"]
    assert 0.08 < r["ballForwardM"] < 0.15
    assert valid(r) and not r["fallen"]
    assert r["frames"][0]["qpos"][env.ball_q] == pytest.approx(0.095)
    assert np.all(env.data.xfrc_applied == 0)


def test_fall_invalidates_otherwise_contacting_kick(env):
    r = env.rollout([(0.037 - 0.031) / 0.019, -1])
    assert r["footBallContact"] and r["fallen"]
    assert r["termination"] == "fall"
    assert not valid(r)
    reward, terms = score(r, r["ballForwardM"])
    assert terms["fallPenalty"] == -8 and reward < 0


def test_reset_and_parameter_variation_are_reproducible(env):
    a = env.rollout([0, 1])
    env.rollout([1, 1], friction=0.0012, ball_offset=(0.003, 0))
    b = env.rollout([0, 1])
    for k in ["ballForwardM", "ballLateralM", "finalTiltDegrees"]:
        assert a[k] == pytest.approx(b[k], abs=1e-9)


def test_invalid_action_and_data_split(env):
    with pytest.raises(ValueError):
        env.rollout([np.nan, 0])
    with pytest.raises(ValueError):
        env.rollout([0])
    assert not set(TRAIN_TARGETS) & set(TEST_TARGETS)


def test_timestep_change_preserves_control_clock(env):
    original = env.model.opt.timestep
    try:
        for dt in [0.002, 0.001, 0.0005]:
            env.model.opt.timestep = dt
            r = env.rollout([0, 1], seconds=0.4, trace=True)
            assert env.data.time == pytest.approx(0.4, abs=1e-10)
            assert r["elapsedSeconds"] == pytest.approx(0.4)
            assert r["frames"][-1]["time"] == pytest.approx(0.38)
        env.model.opt.timestep = 0.003
        with pytest.raises(ValueError, match="divide"):
            env.rollout([0, 1])
    finally:
        env.model.opt.timestep = original


def test_command_delay_is_applied_to_targets(env):
    immediate = env.rollout([0, 1], seconds=0.4, trace=True)
    delayed = env.rollout([0, 1], seconds=0.4, trace=True, command_delay_steps=2)
    assert delayed["frames"][1]["jointTarget"] == immediate["frames"][0]["jointTarget"]
    assert delayed["frames"][2]["jointTarget"] == immediate["frames"][1]["jointTarget"]
    assert (
        delayed["frames"][1]["requestedJointTarget"]
        == immediate["frames"][1]["jointTarget"]
    )
    with pytest.raises(ValueError, match="nonnegative"):
        env.rollout([0, 1], command_delay_steps=-1)
