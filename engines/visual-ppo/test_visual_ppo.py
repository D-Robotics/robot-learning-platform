#!/usr/bin/env python3
"""Tests for the visual-ppo engine (camera-pixel observations + JAX PPO).

Run: engines/mjx-adapter/.venv/bin/python engines/visual-ppo/test_visual_ppo.py
     (any python3 with mujoco+jax; without them every test SKIPs so CI stays
     green — vision training is not a platform hard dependency)

Covers the honesty claims this engine makes:
  * the observation REALLY is pixels: frames change when the world changes
    (robot moves / goal marker moves), and the frame is not constant-black
    (a broken camera orientation renders black and must be caught)
  * the physical scene is the shared single source: the compiled model has
    the mjx-adapter's wall geoms, wheel joints and force-limited actuators
    (no hand-rolled second robot drifting from calibration)
  * ONNX export numerically equals the JAX forward pass (<1e-5) and keeps
    the [-1, 1] actuator clamp with Conv ops intact
  * file protocol: a contract dimension mismatch raises (never silently
    trains another size); a full smoke run through RDK_SIM2REAL_* files
    produces a result.json labeled physicsBackend=cpu-mujoco-vision with
    deployable=false and a SHA256SUMS manifest
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
ADAPTER_PATH = HERE / "adapter.py"
MJX_VENV_PYTHON = REPO_ROOT / "engines" / "mjx-adapter" / ".venv" / "bin" / "python"
TASK_PATH = REPO_ROOT / "tasks" / "originbot-goal-navigation.json"
ADAPTERS_DIR = REPO_ROOT / "adapters"

try:
    import mujoco  # noqa: F401
    HAVE_MUJOCO = True
except ImportError:
    HAVE_MUJOCO = False

try:
    import jax  # noqa: F401
    HAVE_JAX = True
except ImportError:
    HAVE_JAX = False

try:
    import onnxruntime  # noqa: F401
    HAVE_ORT = True
except ImportError:
    HAVE_ORT = False

GATE = HAVE_MUJOCO and HAVE_JAX


def load_adapter():
    spec = importlib.util.spec_from_file_location("visual_ppo_adapter", ADAPTER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_resolved_pack():
    """Mirror scripts/resolve-task-pack.mjs: task + adapter merged."""
    task = json.loads(TASK_PATH.read_text())
    adapter = json.loads((ADAPTERS_DIR / f"{task['adapterId']}.json").read_text())
    decision_hz = adapter.get("runtime", {}).get("decisionHz", 10)
    return {
        "schemaVersion": 1,
        "kind": "goal-navigation",
        "id": task["id"],
        "adapter": adapter,
        "reward": task["reward"],
        "termination": task["termination"],
        "workspace": task["workspace"],
        "curriculum": task["curriculum"],
        "domainRandomization": task["domainRandomization"],
        "evaluationConfig": task.get("evaluationConfig"),
        "qualityGate": task["qualityGate"],
        "controlHz": decision_hz,
        "seed": 7,
    }


def training_request(pack):
    return {
        "schemaVersion": 1,
        "contractId": "visual-goalnav-policy-v1",
        "contract": {
            "id": "visual-goalnav-policy-v1",
            "observationSize": 48 * 48 + 4,
            "actionSize": 2,
            "controlHz": pack["controlHz"],
            "physicsTimestepSeconds": 0.01,
            "decimation": 2,
            "observationLayout": [
                {"name": "camera-ceiling-48x48-gray-v1", "size": 48 * 48},
                {"name": "originbot-proprio-v1", "size": 4},
            ],
        },
        "model": {"modelId": "visual-pp-test", "version": "0.1.0-test"},
        "training": {"profile": "smoke", "numEnvs": 2, "maxIterations": 2},
        "task": pack,
    }


@unittest.skipUnless(GATE, "mujoco+jax not installed (vision training is not a hard dependency)")
class SceneSourceTests(unittest.TestCase):
    """The vision scene must be the shared single source + camera extras."""

    def test_compiled_model_has_shared_scene_and_camera(self):
        import mujoco

        adapter = load_adapter()
        model = adapter._build_vision_model(0.005, 2.0, 2)
        wall = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "wall_x+")
        self.assertNotEqual(wall, -1, "shared wall geoms missing from vision scene")
        camera = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_CAMERA, "ceiling")
        self.assertNotEqual(camera, -1)
        disc = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "goal_disc")
        self.assertNotEqual(disc, -1)
        # mocap: 2 obstacles + 1 goal marker; nu=2 velocity servos; nq=9 free joint + 2 hinges
        self.assertEqual(model.nmocap, 3)
        self.assertEqual(model.nu, 2)
        self.assertEqual(model.nq, 9)
        # force-limited servos (shared calibration: stall torque caps)
        self.assertTrue(all(model.actuator_forcelimited))

    def test_no_second_robot_drift(self):
        """Wheel radius/track/actuator kv come from calibration, not copies."""
        adapter = load_adapter()
        calib = json.loads(
            (REPO_ROOT / "assets" / "originbot" / "calibration.json").read_text()
        )
        self.assertAlmostEqual(adapter._WHEEL_RADIUS, float(calib["wheels"]["radius"]))
        self.assertAlmostEqual(adapter._TRACK_WIDTH, float(calib["wheels"]["trackWidth"]))
        self.assertAlmostEqual(adapter._MAX_WHEEL_SPEED, float(calib["wheels"]["maxWheelSpeed"]))
        self.assertAlmostEqual(adapter._MAX_WHEEL_SPEED, 8.0)


@unittest.skipUnless(GATE, "mujoco+jax not installed")
class PixelObservationTests(unittest.TestCase):
    """The observation must really be rendered pixels, not a constant."""

    def _make_env(self, num_envs=2):
        adapter = load_adapter()
        pack = load_resolved_pack()
        return adapter, adapter.VisualGoalNavEnv(pack, num_envs, 7, 0.005)

    def test_pixels_are_not_black(self):
        adapter, env = self._make_env()
        try:
            obs = env.observe()
            pixels = obs[:, : adapter.CAMERA_WH[0] * adapter.CAMERA_WH[1]]
            # floor renders ~0.8 brightness; a black frame means the camera
            # faces the wrong way (the exact failure mode this guards).
            self.assertGreater(float(pixels.mean()), 0.2)
            self.assertGreater(float(pixels.std()), 0.01)
        finally:
            env.close()

    def test_pixels_change_when_world_changes(self):
        adapter, env = self._make_env()
        try:
            import numpy as np

            before = env.observe()[0].copy()
            # Drive forward one step: robot position changes -> frame changes.
            after, _rew, _done, _succ = env.step(
                np.asarray([[1.0, 0.0]] * env.num_envs)
            )
            pixel_slice = adapter.CAMERA_WH[0] * adapter.CAMERA_WH[1]
            delta = float(np.abs(after[0, :pixel_slice] - before[:pixel_slice]).mean())
            self.assertGreater(delta, 1e-4, "pixels did not change after a full-throttle step")
        finally:
            env.close()

    def test_goal_marker_moves_pixels(self):
        """Moving the goal marker to the image center must change the frame."""
        adapter, env = self._make_env(num_envs=1)
        try:
            import mujoco
            import numpy as np

            env._spawn(0)
            baseline = env.observe()[0].copy()
            data = env._datas[0]
            marker_idx = env._models[0].nmocap - 1
            data.mocap_pos[marker_idx][0] = 1.2  # well away from spawn goal
            mujoco.mj_forward(env._models[0], data)
            moved = env.observe()[0]
            pixel_slice = adapter.CAMERA_WH[0] * adapter.CAMERA_WH[1]
            delta = float(np.abs(moved[:pixel_slice] - baseline[:pixel_slice]).mean())
            self.assertGreater(delta, 1e-4, "goal marker invisible or not rendered")
        finally:
            env.close()


@unittest.skipUnless(GATE, "mujoco+jax not installed")
class OnnxExportTests(unittest.TestCase):
    def test_onnx_matches_jax_forward_and_clamps(self):
        import jax
        import jax.numpy as jnp
        import numpy as np

        adapter = load_adapter()
        params = adapter.init_params(jax.random.PRNGKey(0))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "eq.onnx")
            adapter.export_actor_onnx(params, path)
            if not HAVE_ORT:
                self.skipTest("onnxruntime not installed")
            import onnxruntime as ort

            session = ort.InferenceSession(path)
            rng = np.random.default_rng(0)
            obs = rng.normal(size=(64, adapter._OBS_SIZE)).astype(np.float32)
            ort_out = session.run(["action"], {"observation": obs})[0]
            jax_out = np.asarray(adapter.act_deterministic(params, jnp.asarray(obs)))
            self.assertEqual(ort_out.shape, jax_out.shape)
            self.assertLess(float(np.abs(ort_out - jax_out).max()), 1e-5)
            self.assertTrue(np.all(ort_out >= -1.0 - 1e-6) and np.all(ort_out <= 1.0 + 1e-6))

    def test_onnx_graph_contains_convs(self):
        import onnx

        adapter = load_adapter()
        import jax

        params = adapter.init_params(jax.random.PRNGKey(0))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "g.onnx")
            adapter.export_actor_onnx(params, path)
            model = onnx.load(path)
            ops = {node.op_type for node in model.graph.node}
            self.assertIn("Conv", ops)
            self.assertIn("Clip", ops)


@unittest.skipUnless(GATE and MJX_VENV_PYTHON.exists(), "needs mujoco+jax and the mjx venv")
class WorkerProtocolTests(unittest.TestCase):
    def test_contract_mismatch_raises(self):
        pack = load_resolved_pack()
        request = training_request(pack)
        request["contract"]["observationSize"] = 8  # state-obs size, not pixels
        with tempfile.TemporaryDirectory() as tmp:
            request_path = os.path.join(tmp, "request.json")
            result_path = os.path.join(tmp, "result.json")
            with open(request_path, "w") as handle:
                json.dump(request, handle)
            env = {
                **os.environ,
                "RDK_SIM2REAL_REQUEST_FILE": request_path,
                "RDK_SIM2REAL_RESULT_FILE": result_path,
            }
            proc = subprocess.run(
                [str(MJX_VENV_PYTHON), str(ADAPTER_PATH)],
                capture_output=True, text=True, env=env, timeout=120,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertFalse(os.path.exists(result_path), "mismatch must not produce a result")

    def test_smoke_run_protocol_result(self):
        pack = load_resolved_pack()
        request = training_request(pack)
        request["training"] = {"profile": "smoke", "numEnvs": 2, "maxIterations": 2}
        with tempfile.TemporaryDirectory() as tmp:
            request_path = os.path.join(tmp, "request.json")
            result_path = os.path.join(tmp, "result.json")
            with open(request_path, "w") as handle:
                json.dump(request, handle)
            env = {
                **os.environ,
                "RDK_SIM2REAL_REQUEST_FILE": request_path,
                "RDK_SIM2REAL_RESULT_FILE": result_path,
                "RDK_VISUAL_ENGINE_ENVS": "2",
                "RDK_VISUAL_ENGINE_ITERATIONS": "2",
                "RDK_VISUAL_ENGINE_STEPS": "6",
            }
            proc = subprocess.run(
                [str(MJX_VENV_PYTHON), str(ADAPTER_PATH)],
                capture_output=True, text=True, env=env, cwd=tmp, timeout=1200,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            with open(result_path) as handle:
                result = json.load(handle)
            self.assertEqual(result["metrics"]["physicsBackend"], "cpu-mujoco-vision")
            self.assertEqual(result["metrics"]["engine"], "visual-ppo")
            self.assertFalse(result["deployable"])
            self.assertIn("successRate", result["metrics"])
            self.assertIn("policy.onnx", result["artifact"]["artifactRef"])
            summary_path = os.path.join(tmp, "training-summary.json")
            self.assertTrue(os.path.exists(summary_path))
            with open(summary_path) as handle:
                summary = json.load(handle)
            self.assertEqual(summary["camera"]["width"], 48)
            self.assertEqual(summary["physicsBackend"], "cpu-mujoco-vision")
            manifest = os.path.join(tmp, "SHA256SUMS")
            self.assertTrue(os.path.exists(manifest), "artifact manifest missing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
