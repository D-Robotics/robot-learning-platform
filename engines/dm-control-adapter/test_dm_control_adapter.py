#!/usr/bin/env python3
"""dm_control adapter tests: task semantics, dm_env contract, honest labels.

The suite mirrors the sibling engines' coverage: scene source (shared MJCF),
Task hook contract (probed against the installed dm_control 1.x wheel),
observation/reward/termination semantics against hand-computed numbers, the
ONNX export numerics, and the worker file protocol end-to-end at smoke
budget. Optional dependencies gate their own tests so CI stays green.
"""

import json
import math
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ADAPTER_DIR = os.path.join(REPO_ROOT, "engines", "dm-control-adapter")
if ADAPTER_DIR not in sys.path:
    sys.path.insert(0, ADAPTER_DIR)

MJX_VENV_PYTHON = os.path.join(REPO_ROOT, "engines", "mjx-adapter", ".venv", "bin", "python")

try:
    import numpy as np
    HAVE_NUMPY = True
except ImportError:
    HAVE_NUMPY = False

try:
    import dm_env
    from dm_control.rl import control as dm_control_rl  # noqa: F401
    HAVE_DM_CONTROL = True
except ImportError:
    HAVE_DM_CONTROL = False

try:
    import mujoco
    HAVE_MUJOCO = True
except ImportError:
    HAVE_MUJOCO = False

try:
    import jax
    import jax.numpy as jnp  # noqa: F401
    HAVE_JAX = True
except ImportError:
    HAVE_JAX = False

try:
    import onnxruntime as ort
    HAVE_ORT = True
except ImportError:
    HAVE_ORT = False


def _probe(imports):
    if not HAVE_NUMPY:
        return False
    code = "import " + ", ".join(imports)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True)
    return out.returncode == 0


HAVE_ONNX = _probe(["onnx"])
HAVE_FULL_STACK = HAVE_DM_CONTROL and HAVE_MUJOCO and HAVE_JAX and HAVE_NUMPY


def smoke_pack():
    """The platform's own goal-navigation semantics at smoke budget."""
    return {
        "id": "originbot-goal-navigation-smoke",
        "controlHz": 10,
        "seed": 7,
        "termination": {"goalDistance": 0.15, "timeoutSteps": 60},
        "adapter": {
            "id": "originbot-goal-navigation-policy-v1",
            "safety": {"maxLinear": 0.3, "maxAngular": 1.0},
            "policy": {"observationAdapterId": "originbot-imu-odom-v1",
                       "observationSize": 8, "actionSize": 2},
        },
        "workspace": {"bound": 2.0, "obstacles": {"count": 2, "radius": 0.15}},
        "reward": {"progress": 5.0, "goal": 10.0, "collision": -5.0,
                   "dwell": 0.5, "actionPenalty": -0.02},
        "domainRandomization": {
            "motorGain": [0.9, 1.1], "lagTauSeconds": [0.05, 0.1],
            "gyroNoiseStd": [0.0, 0.02], "odomNoiseStd": [0.0, 0.01],
            "evalEnvelopes": {
                "nominal": [1.0, 0.05, 0.0, 0.0, 0.0, 0, 0.0, 1.0],
                "hard": [0.8, 0.15, 0.05, 0.05, 0.1, 3, 0.2, 0.7],
            },
        },
        "evaluationConfig": {"episodesPerEnvelope": 3, "confidenceLevel": 0.95},
        "qualityGate": {"minSuccessRate": 0.7, "maxCollisionRate": 0.2,
                        "requireBetterThanBaseline": True},
    }


@unittest.skipUnless(HAVE_FULL_STACK, "dm_control + mujoco + jax stack required")
class SceneSourceTests(unittest.TestCase):
    """The dm_control env compiles the SAME MJCF the mjx/visual engines do."""

    def test_shared_scene_has_walls_camera_free_markers(self):
        import adapter
        xml = adapter._load_mjx_builder()(0.005, 2.0, 2)
        model = mujoco.MjModel.from_xml_string(xml)
        self.assertEqual(model.nq, 9, "free joint (7) + 2 wheel hinges")
        self.assertEqual(model.nu, 2, "two wheel velocity servos")
        self.assertEqual(model.nmocap, 2, "obstacle mocap bodies")
        # Walls exist: bound=2.0 -> the wall plane geoms are present.
        geom_names = {mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i)
                      for i in range(model.ngeom)}
        self.assertTrue(any(name and name.startswith("wall") for name in geom_names),
                        "workspace walls must be compiled into the shared scene")
        # Calibration is the single source (no re-typed constants).
        calib = json.load(open(os.path.join(REPO_ROOT, "assets/originbot/calibration.json")))
        self.assertAlmostEqual(adapter._WHEEL_RADIUS, calib["wheels"]["radius"], places=9)
        self.assertAlmostEqual(adapter._TRACK_WIDTH, calib["wheels"]["trackWidth"], places=9)

    def test_physics_step_moves_robot(self):
        import adapter
        xml = adapter._load_mjx_builder()(0.005, 2.0, 0)
        model = mujoco.MjModel.from_xml_string(xml)
        data = mujoco.MjData(model)
        mujoco.mj_resetData(model, data)
        data.qpos[2] = 0.17
        data.qpos[3:7] = [1.0, 0.0, 0.0, 0.0]
        mujoco.mj_forward(model, data)
        data.ctrl[:] = [3.333, 3.333]
        x0 = float(data.qpos[0])
        for _ in range(600):  # 3 s at 0.005
            mujoco.mj_step(model, data)
        self.assertGreater(float(data.qpos[0]) - x0, 0.5, "wheels must actually drive the chassis")

    def test_walls_block_the_robot(self):
        import adapter
        xml = adapter._load_mjx_builder()(0.005, 1.2, 0)
        model = mujoco.MjModel.from_xml_string(xml)
        data = mujoco.MjData(model)
        mujoco.mj_resetData(model, data)
        data.qpos[2] = 0.17
        data.qpos[3:7] = [1.0, 0.0, 0.0, 0.0]
        mujoco.mj_forward(model, data)
        data.ctrl[:] = [3.333, 3.333]
        max_x = 0.0
        for _ in range(2000):  # 10 s
            mujoco.mj_step(model, data)
            max_x = max(max_x, float(data.qpos[0]))
        # The chassis half-length (~0.22 m) stops the CENTER well short of
        # the wall plane; the contact is physical, not a hard clamp.
        self.assertLess(max_x, 1.2, "wall must stop the chassis inside the bound")
        self.assertGreater(max_x, 0.9, "robot must press against the wall (center within a half-chassis of it)")


@unittest.skipUnless(HAVE_FULL_STACK, "dm_control + mujoco + jax stack required")
class DmEnvContractTests(unittest.TestCase):
    """The Task satisfies the dm_control 1.x Environment contract exactly."""

    def _env(self, pack=None, seed=7):
        import adapter
        envs = adapter.DmControlVecEnvs(pack or smoke_pack(), 1, seed, 0.005)
        self.addCleanup(envs.close)
        return envs

    def test_action_and_observation_specs(self):
        import adapter
        envs = self._env()
        env = envs._environments[0]
        task = envs._tasks[0]
        action_spec = task.action_spec(env.physics)
        obs_spec = task.observation_spec(env.physics)
        self.assertEqual(tuple(action_spec.shape), (2,))
        self.assertEqual(action_spec.minimum, -1.0)
        self.assertEqual(action_spec.maximum, 1.0)
        self.assertEqual(tuple(obs_spec.shape), (8,))
        self.assertEqual(action_spec.dtype, np.float32)
        self.assertEqual(obs_spec.dtype, np.float32)
        # The Environment itself owns decimation: control_timestep=0.1 with
        # model timestep 0.005 -> 20 physics steps per control step.
        self.assertEqual(env._n_sub_steps, 20)

    def test_reset_returns_first_timestep_with_observation(self):
        envs = self._env()
        env = envs._environments[0]
        timestep = env.reset()
        self.assertEqual(timestep.step_type, dm_env.StepType.FIRST)
        self.assertIsNone(timestep.reward)
        self.assertEqual(timestep.observation.shape, (8,))

    def test_mid_and_last_timesteps(self):
        envs = self._env(smoke_pack())
        env = envs._environments[0]
        env.reset()
        # Spin in place for the full timeout: the LAST timestep must arrive
        # exactly at timeout_steps (dm_control's termination, not its own
        # time_limit — time_limit is inf here).
        pack = smoke_pack()
        for step in range(pack["termination"]["timeoutSteps"]):
            timestep = env.step(np.array([0.0, 1.0], dtype=np.float32))
            if step < pack["termination"]["timeoutSteps"] - 1:
                self.assertEqual(timestep.step_type, dm_env.StepType.MID)
        self.assertEqual(timestep.step_type, dm_env.StepType.LAST)

    def test_goal_reach_terminates_with_success(self):
        pack = smoke_pack()
        pack["domainRandomization"]["gyroNoiseStd"] = [0.0, 0.0]
        pack["domainRandomization"]["odomNoiseStd"] = [0.0, 0.0]
        pack["termination"]["timeoutSteps"] = 300
        envs = self._env(pack)
        env = envs._environments[0]
        task = envs._tasks[0]
        env.reset()
        goal = task.goal.copy()
        terminated_at = None
        for step in range(300):
            q = env.physics.data.qpos
            x, y = float(q[0]), float(q[1])
            yaw_q = q[3:7]
            yaw = math.atan2(2 * (yaw_q[0] * yaw_q[3] + yaw_q[1] * yaw_q[2]),
                             1 - 2 * (yaw_q[2] ** 2 + yaw_q[3] ** 2))
            err = (math.atan2(goal[1] - y, goal[0] - x) - yaw + math.pi) % (2 * math.pi) - math.pi
            action = np.array([0.3 if abs(err) < 0.6 else 0.05,
                               float(np.clip(2.0 * err, -1, 1))], dtype=np.float32)
            timestep = env.step(action)
            if timestep.step_type == dm_env.StepType.LAST:
                terminated_at = step
                break
        self.assertIsNotNone(terminated_at, "P-controller must reach the goal")
        self.assertTrue(task._success, "termination must be a goal-reach, not timeout")
        distance = math.hypot(goal[0] - float(env.physics.data.qpos[0]),
                              goal[1] - float(env.physics.data.qpos[1]))
        self.assertLess(distance, 0.15, "final distance must be inside the goal radius")

    def test_reward_uses_true_pose_progress(self):
        pack = smoke_pack()
        envs = self._env(pack)
        env = envs._environments[0]
        task = envs._tasks[0]
        env.reset()
        # Place the goal dead ahead: the first straight step's progress term
        # is progress * (prev_distance - now) measured on the TRUE pose, plus
        # the action penalty scaled by mean(|action|). Far from the goal
        # (1.5 m) the goal/dwell bonuses are provably out of range, so the
        # closed form is exact up to the sub-step physics integration.
        task.goal = np.array([1.5, 0.0])
        task.prev_distance = 1.5
        task.odom_noise = 0.0
        task.gyro_noise = 0.0
        q = env.physics.data.qpos
        q[3:7] = [1.0, 0.0, 0.0, 0.0]  # face +x
        task.odom[2] = 0.0
        mujoco.mj_forward(env.physics.model._model, env.physics.data._data)
        reward_cfg = pack["reward"]
        # Two consecutive straight steps; check each against the closed form.
        # actionPenalty scales with mean(|[1,0]|) = 0.5 (starter semantics).
        prev = 1.5
        for _ in range(2):
            timestep = env.step(np.array([1.0, 0.0], dtype=np.float32))
            x = float(env.physics.data.qpos[0])
            distance = abs(1.5 - x)
            expected = reward_cfg["progress"] * (prev - distance) + reward_cfg["actionPenalty"] * 0.5
            self.assertGreater(distance, 0.225, "still far: goal/dwell must not fire")
            self.assertAlmostEqual(timestep.reward, expected, places=3,
                                   msg="reward = progress*(dprev-d) + penalty*mean(|a|) on the true pose")
            prev = distance
        # Spinning after the straight run: residual v_lag keeps the chassis
        # moving (first-order lag decays, never snaps), so the exact spin
        # reward is not a clean closed form — but the progress signal must
        # collapse toward the penalty-only floor as the lag decays.
        spin_rewards = []
        for _ in range(3):
            spin = env.step(np.array([0.0, 0.5], dtype=np.float32))
            x = float(env.physics.data.qpos[0])
            distance = abs(1.5 - x)
            spin_expected = (reward_cfg["progress"] * (prev - distance)
                             + reward_cfg["actionPenalty"] * 0.25)
            self.assertAlmostEqual(float(spin.reward), spin_expected, places=3,
                                   msg="spin step also follows the closed form (residual lag)")
            spin_rewards.append(float(spin.reward))
            prev = distance
        self.assertLess(abs(spin_rewards[-1]), abs(spin_rewards[0]),
                        "progress signal decays as the lag bleeds off")

    def test_latent_fifo_delays_command(self):
        pack = smoke_pack()
        pack["domainRandomization"]["actionLatencySteps"] = [2, 2]
        envs = self._env(pack)
        env = envs._environments[0]
        task = envs._tasks[0]
        env.reset()
        # Latency 2: with the zero-prefix FIFO the first two steps issue zero
        # wheel commands; the third step finally executes step-0's order.
        env.step(np.array([1.0, 0.0], dtype=np.float32))
        self.assertEqual(float(env.physics.data.ctrl[0]), 0.0,
                         "step 0 executes the zero prefix, not the command")
        env.step(np.array([1.0, 0.0], dtype=np.float32))
        self.assertEqual(float(env.physics.data.ctrl[0]), 0.0,
                         "step 1 still zero (latency=2)")
        env.step(np.array([1.0, 0.0], dtype=np.float32))
        self.assertGreater(float(env.physics.data.ctrl[0]), 0.5,
                           "step 2 finally executes the step-0 command")


@unittest.skipUnless(HAVE_FULL_STACK, "dm_control + mujoco + jax stack required")
class ObservationSemanticsTests(unittest.TestCase):
    """The 8D observation layout matches the board's native layout."""

    def test_layout_slots(self):
        import adapter
        envs = adapter.DmControlVecEnvs(smoke_pack(), 1, 3, 0.005)
        self.addCleanup(envs.close)
        env = envs._environments[0]
        task = envs._tasks[0]
        env.reset()
        task.odom = np.array([0.4, -0.2, 1.0])
        task.v_lag = 0.25
        task.w_lag = -0.4
        task.odom_noise = 0.0
        task.gyro_noise = 0.0
        task.goal = np.array([1.0, 0.5])
        obs = task.get_observation(env.physics)
        self.assertAlmostEqual(obs[0], 0.4, places=6)      # x (odom belief)
        self.assertAlmostEqual(obs[1], -0.2, places=6)     # y
        self.assertAlmostEqual(obs[2], math.sin(1.0), places=6)
        self.assertAlmostEqual(obs[3], math.cos(1.0), places=6)
        self.assertAlmostEqual(obs[4], 1.0 - 0.4, places=6)  # dx (goal - belief)
        self.assertAlmostEqual(obs[5], 0.5 - (-0.2), places=6)
        self.assertAlmostEqual(obs[6], 0.25, places=6)     # v_lag
        self.assertAlmostEqual(obs[7], -0.4, places=6)     # w_lag (+gyro noise 0)

    def test_noisy_odom_drifts_from_true_pose(self):
        import adapter
        envs = adapter.DmControlVecEnvs(smoke_pack(), 1, 5, 0.005)
        self.addCleanup(envs.close)
        env = envs._environments[0]
        task = envs._tasks[0]
        env.reset()
        task.odom_noise = 0.0  # pin the noise; bias comes from the DR sample
        # Pin a veer: with _pinned_bias set (eval semantics) the true chassis
        # rotates faster than the odometry believes.
        task._pinned_bias = 0.5
        x_true_start = float(env.physics.data.qpos[0])
        for _ in range(20):
            env.step(np.array([0.0, 0.5], dtype=np.float32))
        yaw_true = env.physics.data.qpos[3:7]
        yaw_true = math.atan2(2 * (yaw_true[0] * yaw_true[3] + yaw_true[1] * yaw_true[2]),
                              1 - 2 * (yaw_true[2] ** 2 + yaw_true[3] ** 2))
        self.assertGreater(abs(yaw_true - task.odom[2]), 0.3,
                           "pinned bias must veer the true chassis away from the odom belief")


@unittest.skipUnless(HAVE_FULL_STACK and HAVE_ONNX and HAVE_ORT, "onnx + onnxruntime required")
class OnnxExportTests(unittest.TestCase):
    """The exported ONNX graph is numerically the trained JAX mean action."""

    def test_onnx_matches_jax_forward(self):
        import adapter
        key = jax.random.PRNGKey(11)
        params = adapter.init_params(key, adapter._OBS_SIZE, adapter._ACTION_SIZE)
        path = os.path.join(tempfile.mkdtemp(prefix="dmc-onnx-"), "policy.onnx")
        size = adapter.export_actor_onnx(params, adapter._OBS_SIZE, adapter._ACTION_SIZE, path)
        self.assertGreater(size, 1024)
        session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        rng = np.random.default_rng(7)
        samples = rng.uniform(-1.5, 1.5, size=(9, adapter._OBS_SIZE)).astype(np.float32)
        onnx_out = session.run(["action"], {"observation": samples})[0]
        jax_out = np.asarray(adapter.act_deterministic(params, jnp.asarray(samples)))
        np.testing.assert_allclose(onnx_out, jax_out, atol=1e-5)
        # Clamp contract: inputs far outside the actuator range saturate.
        big = np.full((1, adapter._OBS_SIZE), 25.0, dtype=np.float32)
        clamped = session.run(["action"], {"observation": big})[0]
        self.assertTrue(np.all(clamped >= -1.0) and np.all(clamped <= 1.0))

    def test_graph_ops_and_contract(self):
        import adapter
        import onnx
        key = jax.random.PRNGKey(13)
        params = adapter.init_params(key, adapter._OBS_SIZE, adapter._ACTION_SIZE)
        path = os.path.join(tempfile.mkdtemp(prefix="dmc-onnx-"), "policy.onnx")
        adapter.export_actor_onnx(params, adapter._OBS_SIZE, adapter._ACTION_SIZE, path)
        model = onnx.load(path)
        ops = {node.op_type for node in model.graph.node}
        self.assertIn("Gemm", ops)
        self.assertIn("Tanh", ops)
        self.assertIn("Clip", ops)
        self.assertEqual(model.opset_import[0].version, 13)
        self.assertEqual(model.ir_version, 8)
        inputs = {vi.name for vi in model.graph.input}
        outputs = {vo.name for vo in model.graph.output}
        self.assertEqual(inputs, {"observation"})
        self.assertEqual(outputs, {"action"})


@unittest.skipUnless(HAVE_FULL_STACK, "dm_control + mujoco + jax stack required")
class WorkerProtocolTests(unittest.TestCase):
    """The worker file protocol end-to-end at smoke budget — honest labels."""

    def _python(self):
        return MJX_VENV_PYTHON if os.path.exists(MJX_VENV_PYTHON) else sys.executable

    def test_contract_mismatch_refuses_without_result(self):
        scratch = tempfile.mkdtemp(prefix="dmc-protocol-")
        request = {
            "contract": {"observationSize": 42, "actionSize": 2, "controlHz": 10},
            "model": {"modelId": "dmc-mismatch", "version": "0.1.0"},
            "training": {"profile": "smoke"},
            "task": smoke_pack(),
        }
        request_path = os.path.join(scratch, "request.json")
        with open(request_path, "w") as handle:
            json.dump(request, handle)
        result_path = os.path.join(scratch, "result.json")
        env = dict(os.environ,
                   RDK_SIM2REAL_REQUEST_FILE=request_path,
                   RDK_SIM2REAL_RESULT_FILE=result_path)
        run = subprocess.run([self._python(), os.path.join(ADAPTER_DIR, "adapter.py")],
                             capture_output=True, text=True, env=env, cwd=scratch, timeout=120)
        self.assertNotEqual(run.returncode, 0, "a contract violation must fail the run")
        self.assertFalse(os.path.exists(result_path), "no result.json for a refused run")

    def test_smoke_run_full_protocol(self):
        scratch = tempfile.mkdtemp(prefix="dmc-protocol-")
        request = {
            "contract": {"observationSize": 8, "actionSize": 2, "controlHz": 10,
                         "physicsTimestepSeconds": 0.005, "decimation": 20},
            "model": {"modelId": "dmc-gate", "version": "0.1.0-gate"},
            "training": {"profile": "smoke", "numEnvs": 4, "maxIterations": 2},
            "task": smoke_pack(),
        }
        request_path = os.path.join(scratch, "request.json")
        with open(request_path, "w") as handle:
            json.dump(request, handle)
        result_path = os.path.join(scratch, "result.json")
        env = dict(os.environ,
                   RDK_SIM2REAL_REQUEST_FILE=request_path,
                   RDK_SIM2REAL_RESULT_FILE=result_path,
                   RDK_DMC_ENGINE_ITERATIONS="2", RDK_DMC_ENGINE_ENVS="4",
                   RDK_DMC_ENGINE_STEPS="16")
        run = subprocess.run([self._python(), os.path.join(ADAPTER_DIR, "adapter.py")],
                             capture_output=True, text=True, env=env, cwd=scratch, timeout=900)
        self.assertEqual(run.returncode, 0, run.stderr[-800:])
        with open(result_path) as handle:
            result = json.load(handle)
        self.assertEqual(result["physicsBackend"], "dm-control-mujoco")
        self.assertEqual(result["metrics"]["physicsBackend"], "dm-control-mujoco")
        self.assertEqual(result["metrics"]["engine"], "dm-control-ppo")
        self.assertEqual(result["deployable"], False)
        self.assertEqual(result["artifact"]["deployable"], False)
        self.assertEqual(result["artifact"]["format"], "onnx")
        self.assertGreater(result["artifact"]["sizeBytes"], 1024)
        self.assertEqual(result["metrics"]["iterations"], 2, "budget reported honestly")
        self.assertTrue(os.path.exists(os.path.join(scratch, "SHA256SUMS")))
        self.assertTrue(os.path.exists(os.path.join(scratch, "training-summary.json")))
        summary = json.load(open(os.path.join(scratch, "training-summary.json")))
        self.assertEqual(summary["physicsBackend"], "dm-control-mujoco")
        self.assertIn("dmControlVersion", summary)
        self.assertEqual(summary["taskKind"], "goal-navigation")
        # 2 iterations at 16 steps must fail the 0.7 gate honestly.
        self.assertEqual(result["taskEvaluation"]["qualityGate"]["passed"], False)
        # Wilson CI must bracket the measured nominal rate.
        nominal = result["taskEvaluation"]["trained"]["envelopes"]["nominal"]
        self.assertLessEqual(nominal["successRateCiLow"], nominal["successRate"])
        self.assertGreaterEqual(nominal["successRateCiHigh"], nominal["successRate"])
        # The manifest covers every artifact file it produced.
        listed = {line.split("  ", 1)[1].strip()
                  for line in open(os.path.join(scratch, "SHA256SUMS")) if line.strip()}
        self.assertIn("policy.onnx", listed)
        self.assertIn("training-summary.json", listed)
        self.assertNotIn("result.json", listed, "the manifest never lists the protocol files")


if __name__ == "__main__":
    unittest.main()
