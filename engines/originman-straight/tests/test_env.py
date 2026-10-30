import os
import sys
from pathlib import Path

import mujoco
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from env import Config, OriginManEnv
from model import prepare


@pytest.fixture(scope="module")
def scene(tmp_path_factory):
    source = os.environ.get("ORIGINMAN_MODEL_SOURCE")
    if not source:
        pytest.skip("set ORIGINMAN_MODEL_SOURCE to caller-owned model ZIP or package")
    return prepare(Path(source), tmp_path_factory.mktemp("originman-model"))


@pytest.fixture(scope="module")
def env(scene):
    return OriginManEnv(scene)


def test_physical_model_is_unassisted_fullbody(env):
    m = env.model
    assert (m.nq, m.nv, m.nu) == (27, 26, 20)
    assert m.jnt_type[0] == mujoco.mjtJoint.mjJNT_FREE
    assert m.neq == 0
    assert m.body_mass.sum() == pytest.approx(1.9923891)
    assert np.all(env.data.xfrc_applied == 0)
    assert len(env.qa) == 10 and len(set(env.qa)) == 10


def test_reference_actually_steps_with_ground_contacts(env):
    env.reset()
    support = np.zeros(2, int)
    for _ in range(400):
        _, _, done, info = env.step(np.zeros(10))
        support[0] += not info["footContacts"][0] and info["footContacts"][1]
        support[1] += info["footContacts"][0] and not info["footContacts"][1]
        if done:
            break
    assert not info["fallen"]
    assert info["x"] > 0.15
    assert min(support) >= 5


def test_observation_does_not_leak_world_position(env):
    env.reset()
    before = env.observe()
    env.data.qpos[:2] += [2.0, -1.0]
    mujoco.mj_forward(env.model, env.data)
    np.testing.assert_allclose(env.observe(), before, atol=1e-6)
    assert before.shape == (41,)


def test_dynamic_gyro_is_actual_sensor(env):
    env.reset()
    env.data.qvel[3:6] = [0.2, -0.3, 0.4]
    mujoco.mj_forward(env.model, env.data)
    np.testing.assert_allclose(env.observe()[:3], env.data.sensordata[:3], atol=1e-7)
    assert np.linalg.norm(env.observe()[:3]) > 0.4


def test_reset_clears_residual_and_restores_servo_gains(env):
    env.reset(asymmetry=0.2)
    env.step(np.ones(10))
    env.reset(asymmetry=0)
    np.testing.assert_allclose(env.last_action, 0)
    np.testing.assert_allclose(env.model.actuator_gainprm[env.leg_a, 0], env.config.kp)
    np.testing.assert_allclose(env.model.actuator_biasprm[env.leg_a, 1], -env.config.kp)


def test_residual_changes_real_leg_target_not_root_force(env):
    env.reset()
    q = env.data.qpos[env.qa].copy()
    env.step(np.ones(10))
    np.testing.assert_allclose(
        env.data.ctrl[env.leg_a] - env.reference[0], 0.025, atol=1e-6
    )
    assert np.linalg.norm(env.data.qpos[env.qa] - q) > 0.001
    assert np.all(env.data.xfrc_applied == 0)


def test_invalid_action_rejected(env):
    with pytest.raises(ValueError):
        env.step(np.zeros(14))
    with pytest.raises(ValueError):
        env.step(np.full(10, np.nan))


def test_fall_terminates_without_resetting_away_evidence(env):
    env.reset()
    env.data.qpos[2] += 0.1
    env.data.qpos[3:7] = [2**-0.5, 2**-0.5, 0, 0]
    _, _, done, info = env.step(np.zeros(10))
    assert done and info["fallen"]
    assert abs(env.data.xmat[1].reshape(3, 3)[2, 2]) < 0.65


def test_reward_decomposition_matches_executed_transition(env):
    env.reset()
    _, reward, _, info = env.step(np.full(10, 0.5))
    assert sum(info["rewardTerms"].values()) == pytest.approx(reward)
    assert info["rewardTerms"]["residual_penalty"] < 0
    assert info["residualRateLimitedFraction"] == 1


def test_diagnostic_trace_records_actual_targets_and_kinematics(env):
    env.reset()
    env.step(np.full(10, 0.2))
    frame = env.diagnostic_frame()
    np.testing.assert_allclose(frame["jointTarget"], env.data.ctrl[env.leg_a])
    np.testing.assert_allclose(frame["jointPosition"], env.data.qpos[env.qa])
    assert len(frame["bodyPositions"]) == 11
    assert frame["bodyPositions"]["body_link"][2] > 0


def test_convex_foot_retains_inertia_and_ik_frame(scene, env, tmp_path):
    source = Path(os.environ["ORIGINMAN_MODEL_SOURCE"])
    mesh_scene = prepare(source, tmp_path / "mesh-model", foot_collision="convex-mesh")
    mesh_env = OriginManEnv(mesh_scene)
    np.testing.assert_allclose(
        mesh_env.model.body_mass, env.model.body_mass, atol=1e-12
    )
    np.testing.assert_allclose(
        mesh_env.model.body_inertia, env.model.body_inertia, atol=1e-12
    )
    mesh_env.reset()
    env.reset()
    for side in range(2):
        a, ar = env.foot_pose(env.data, side)
        b, br = mesh_env.foot_pose(mesh_env.data, side)
        np.testing.assert_allclose(a[:2], b[:2], atol=1e-7)
        np.testing.assert_allclose(ar, br, atol=1e-7)
        g = mujoco.mj_name2id(
            mesh_env.model,
            mujoco.mjtObj.mjOBJ_GEOM,
            ("l", "r")[side] + "_ank_roll_link_collision",
        )
        assert mesh_env.model.geom_type[g] == mujoco.mjtGeom.mjGEOM_MESH
        mid = mesh_env.model.geom_dataid[g]
        start = mesh_env.model.mesh_vertadr[mid]
        v = mesh_env.model.mesh_vert[start : start + mesh_env.model.mesh_vertnum[mid]]
        world_z = (
            v @ mesh_env.data.geom_xmat[g].reshape(3, 3)[2]
            + mesh_env.data.geom_xpos[g, 2]
        )
        assert world_z.min() >= 0.0009
    np.testing.assert_allclose(mesh_env.reference, env.reference, atol=1e-6)


def test_disturbance_is_finite_lateral_and_logged(scene, env):
    disturbed = OriginManEnv(scene, Config(push_max_force=6), reference=env.reference)
    disturbed.reset(seed=42)
    schedule = (disturbed.push_start, disturbed.push_force.copy())
    disturbed.reset(seed=42)
    assert disturbed.push_start == schedule[0]
    np.testing.assert_allclose(disturbed.push_force, schedule[1])
    disturbed.push_start = 0.04
    disturbed.push_force[:] = [0, 1.0, 0]
    applied = []
    for _ in range(30):
        _, _, _, info = disturbed.step(np.zeros(10))
        applied.append(info["externalForceWorldN"])
    force = np.array(applied)
    np.testing.assert_allclose(force[:, [0, 2]], 0)
    assert 9 <= np.count_nonzero(force[:, 1]) <= 11
    assert np.all(force[20:] == 0)
    assert np.all(disturbed.data.xfrc_applied[1, 3:] == 0)
    disturbed.reset(seed=42)
    assert np.all(disturbed.data.xfrc_applied == 0)


def test_reward_velocity_filter_is_causal_and_resets(scene, env):
    filtered = OriginManEnv(
        scene, Config(velocity_filter_seconds=0.3), reference=env.reference
    )
    previous = 0.0
    alpha = filtered.config.control_dt / (0.3 + filtered.config.control_dt)
    for _ in range(20):
        _, _, _, info = filtered.step(np.zeros(10))
        expected = previous + alpha * (info["forwardVelocity"] - previous)
        assert info["trackingVelocity"] == pytest.approx(expected)
        previous = expected
    filtered.reset()
    assert filtered.filtered_forward_velocity == 0


def test_imu_recovery_gate_preserves_normal_gait_despite_arbitrary_policy(scene, env):
    guarded = OriginManEnv(
        scene, Config(recovery_roll_threshold=0.13), reference=env.reference
    )
    guarded.reset(seed=10)
    env.reset(seed=10)
    rng = np.random.default_rng(84)
    for _ in range(400):
        _, _, _, info = guarded.step(rng.uniform(-1, 1, 10))
        env.step(np.zeros(10))
        assert info["recoveryGate"] == 0
    np.testing.assert_allclose(guarded.data.qpos, env.data.qpos, atol=1e-12)


def test_recovery_gate_responds_to_imu_without_known_push_schedule(scene, env):
    guarded = OriginManEnv(
        scene, Config(recovery_roll_threshold=0.13), reference=env.reference
    )
    guarded.reset()
    guarded.push_start = 100
    guarded.push_force[:] = 0
    guarded.data.qvel[3] = 2.0
    mujoco.mj_forward(guarded.model, guarded.data)
    assert abs(guarded.data.sensordata[0]) > guarded.config.recovery_rate_threshold
    _, _, _, info = guarded.step(np.ones(10))
    assert info["recoveryGate"] > 0
    assert np.linalg.norm(guarded.last_action) > 0
    assert np.all(guarded.data.xfrc_applied == 0)
    guarded.reset()
    assert guarded.recovery_gate == 0 and guarded.recovery_until < 0


def test_focused_disturbance_samples_both_signs_and_declared_limits(scene, env):
    cfg = Config(
        push_min_force=4, push_max_force=6.5, push_start_min=1.2, push_start_max=4.8
    )
    focused = OriginManEnv(scene, cfg, reference=env.reference)
    samples = []
    for seed in range(100):
        focused.reset(seed=seed)
        assert 4 <= abs(focused.push_force[1]) <= 6.5
        assert 1.2 <= focused.push_start <= 4.8
        samples.append(np.sign(focused.push_force[1]))
    assert set(samples) == {-1, 1}
    with pytest.raises(ValueError, match="minimum"):
        Config(push_min_force=7, push_max_force=6)
    with pytest.raises(ValueError, match="fit"):
        Config(push_max_force=6, push_start_max=8)
