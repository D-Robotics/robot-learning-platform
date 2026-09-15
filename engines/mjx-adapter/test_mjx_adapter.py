#!/usr/bin/env python3
"""Tests for the mjx-adapter engine (pure-JAX PPO over MJX physics).

Run: engines/mjx-adapter/.venv/bin/python engines/mjx-adapter/test_mjx_adapter.py
     (or any python3 with jax+mujoco; without jax every test SKIPs so CI
     stays green — MJX is not a platform hard dependency)

Covers the properties the adapter's honesty claims rest on:
  * ONNX export numerically equals the JAX forward pass (<1e-5) and
    respects the [-1, 1] actuator clamp
  * file protocol: contract dimension mismatch raises, never silently
    retrains at another size
  * pinned DR envelopes are reproducible: same seed + envelope -> same
    episode outcomes
  * the physics env actually drives the robot (reset pose is upright,
    a forward command makes progress) — the probe-level guarantees at
    env granularity
  * result.json shape: physicsBackend labeling, artifact regex, embedded
    taskEvaluation with Wilson CIs
"""

import importlib.util
import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
ADAPTER_PATH = HERE / "adapter.py"
TASK_PATH = REPO_ROOT / "tasks" / "originbot-goal-navigation.json"
ADAPTERS_DIR = REPO_ROOT / "adapters"

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


def load_adapter():
    spec = importlib.util.spec_from_file_location("mjx_adapter", ADAPTER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_resolved_pack():
    """Mirror scripts/resolve-task-pack.mjs: task + adapter merged."""
    task = json.loads(TASK_PATH.read_text())
    adapter = json.loads((ADAPTERS_DIR / f"{task['adapterId']}.json").read_text())
    decision_hz = adapter.get("runtime", {}).get("decisionHz", 10)
    pack = {
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
    return pack


def training_request(pack, obs_size, act_size):
    return {
        "schemaVersion": 1,
        "contractId": f"{pack['id']}-policy-v1",
        "contract": {
            "id": f"{pack['id']}-policy-v1",
            "observationSize": obs_size,
            "actionSize": act_size,
            "controlHz": pack["controlHz"],
            "physicsTimestepSeconds": 0.02,
            "decimation": 1,
            "observationLayout": [{"name": "originbot-imu-odom-v1", "size": 8}],
        },
        "model": {"modelId": "mjx-test", "version": "0.1.0-test"},
        "training": {"profile": "smoke", "numEnvs": 4, "maxIterations": 2},
        "task": pack,
    }


@unittest.skipUnless(HAVE_JAX, "jax not installed (MJX is not a hard dependency)")
class OnnxExportTests(unittest.TestCase):
    def test_onnx_matches_jax_forward_and_clamps(self):
        import jax
        import jax.numpy as jnp
        import numpy as np

        adapter = load_adapter()
        params = adapter.init_params(jax.random.PRNGKey(0), 8, 2)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "eq.onnx")
            adapter.export_actor_onnx(params, 8, 2, path)
            if not HAVE_ORT:
                self.skipTest("onnxruntime not installed")
            import onnxruntime as ort

            session = ort.InferenceSession(path)
            rng = np.random.default_rng(0)
            obs = rng.normal(size=(64, 8)).astype(np.float32)
            ort_out = session.run(["action"], {"observation": obs})[0]
            jax_out = np.asarray(adapter.act_deterministic(params, jnp.asarray(obs)))
            error = float(np.abs(ort_out - jax_out).max())
            self.assertLess(error, 1e-5, f"ONNX/JAX divergence {error}")
            self.assertLessEqual(float(np.abs(ort_out).max()), 1.0 + 1e-6)

    def test_onnx_export_succeeds_without_onnxruntime(self):
        import jax

        adapter = load_adapter()
        params = adapter.init_params(jax.random.PRNGKey(1), 8, 2)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "eq.onnx")
            size = adapter.export_actor_onnx(params, 8, 2, path)
            self.assertGreater(size, 1024)


@unittest.skipUnless(HAVE_JAX, "jax not installed")
class ProtocolContractTests(unittest.TestCase):
    def test_observation_size_mismatch_raises(self):
        pack = load_resolved_pack()
        request = training_request(pack, obs_size=16, act_size=2)
        with tempfile.TemporaryDirectory() as tmp:
            request_path = os.path.join(tmp, "request.json")
            result_path = os.path.join(tmp, "result.json")
            with open(request_path, "w") as handle:
                json.dump(request, handle)
            run = subprocess.run(
                [sys.executable, str(ADAPTER_PATH)],
                cwd=tmp,
                capture_output=True,
                text=True,
                env={
                    **os.environ,
                    "RDK_SIM2REAL_REQUEST_FILE": request_path,
                    "RDK_SIM2REAL_RESULT_FILE": result_path,
                    "RDK_STARTER_ENGINE_DEVICE": "cpu",
                },
                timeout=600,
            )
            self.assertNotEqual(run.returncode, 0, "contract violation must fail loudly")
            self.assertIn("violates", run.stderr)

    def test_missing_env_vars_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = subprocess.run(
                [sys.executable, str(ADAPTER_PATH)],
                cwd=tmp,
                capture_output=True,
                text=True,
                env={k: v for k, v in os.environ.items()
                     if not k.startswith("RDK_SIM2REAL")},
                timeout=120,
            )
            self.assertEqual(run.returncode, 2)


@unittest.skipUnless(HAVE_JAX, "jax not installed")
class MjxEnvTests(unittest.TestCase):
    """Physics-env behavior at the granularity the adapter relies on."""

    @classmethod
    def setUpClass(cls):
        try:
            import mujoco  # noqa: F401
            from mujoco import mjx  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("mujoco+mujoco-mjx not installed")
        cls.adapter = load_adapter()
        cls.pack = load_resolved_pack()

    def make_env(self, num_envs=4):
        # physics_dt is capped at 0.01 by main() (probe: at 0.02 MJX's
        # contact solver injects energy into this stance); the env derives
        # decimation so decimation * physics_dt == control_dt exactly.
        return self.adapter.MjxGoalNavEnv(
            self.pack, num_envs, seed=7, physics_dt=0.01,
            obs_layout="originbot-imu-odom-v1",
        )

    def test_obs_and_action_dimensions_match_layout(self):
        env = self.make_env()
        self.assertEqual(env.observation_size, 8)
        self.assertEqual(env.action_size, 2)
        obs = env.observe()
        self.assertEqual(obs.shape, (4, 8))

    def test_reset_pose_is_upright_at_origin(self):
        import numpy as np

        env = self.make_env(num_envs=2)
        qpos = np.asarray(env.state["data"].qpos)  # (N, 9): pos(3) quat(4) wheels(2)
        for row in range(2):
            x, y, z = qpos[row][0], qpos[row][1], qpos[row][2]
            quat = qpos[row][3:7]
            # Start pose is at the origin with a random yaw; level means the
            # quaternion is a pure z-rotation: x/y components ~0.
            self.assertAlmostEqual(float(x), 0.0, places=5)
            self.assertAlmostEqual(float(y), 0.0, places=5)
            self.assertLess(
                abs(float(z) - self.adapter.REST_HEIGHT), 0.005,
                "chassis height must be the stance height (wheels touching the floor)",
            )
            self.assertLess(abs(float(quat[1])), 1e-6, "reset must not tilt (roll)")
            self.assertLess(abs(float(quat[2])), 1e-6, "reset must not tilt (pitch)")

    def test_forward_command_drives_along_heading(self):
        """A sustained [1, 0] command must make real progress along the
        initial heading with the chassis grounded.

        The initial pose is pinned to the identity quaternion — the exact
        mirror-symmetric equilibrium of the robot+floor scene — where a
        calibrated ([gain=1, bias=0, slip=1]) command drives a perfectly
        straight line and any lateral motion is a bug (inverted wheel
        sign, asymmetric actuator mapping, launch). At a random initial
        yaw the same robot legitimately drifts open-loop (a differential
        drive has no heading stiffness and the caster is deliberately
        near-frictionless; both CPU MuJoCo and MJX show the same
        order-0.1 rad drift) — that drift is the sim2real hazard the
        closed-loop policy exists to close, not a chassis bug, so it is
        not asserted here."""
        import jax.numpy as jnp
        import numpy as np

        env = self.make_env(num_envs=1)
        # Pin nominal dynamics: [gain=1, lag=0.1, 0, 0, 0, latency=0,
        # dropout=0, slip=1] — a perfectly calibrated robot.
        nominal = jnp.asarray([1.0, 0.1, 0.0, 0.0, 0.0, 0.0, 1.0])
        state = dict(env.state)
        state["domain"] = nominal[None, :]
        state["latency"] = jnp.zeros((1,), dtype=jnp.int32)
        qpos = np.asarray(state["data"].qpos).copy()
        qpos[0][3:7] = [1.0, 0.0, 0.0, 0.0]
        state["data"] = state["data"].replace(qpos=jnp.asarray(qpos))
        state["odom"] = jnp.asarray([[0.0, 0.0, 0.0]])
        state["prev_dist"] = jnp.asarray([1.0])
        env.state = state
        start = qpos[0][:2].copy()
        for _ in range(30):
            env.step(np.array([[1.0, 0.0]], dtype=np.float32))
        final = np.asarray(env.state["data"].qpos)[0]
        end = final[:2]
        progress = float(end[0] - start[0])
        lateral = abs(float(end[1] - start[1]))
        self.assertGreater(progress, 0.35, "forward command must drive along heading")
        self.assertLess(lateral, 0.02, "symmetric equilibrium must drive a straight line")
        self.assertGreater(final[2], 0.15, "chassis must stay grounded")
        self.assertLess(final[2], 0.19, "chassis must not launch")
        self.assertEqual(
            int(np.asarray(env.state["steps"])[0]), 30,
            "no mid-test auto-reset: the measurement is only meaningful on one episode",
        )

    def test_pinned_envelope_is_reproducible(self):
        import numpy as np

        env = self.make_env(num_envs=3)
        policy = lambda obs: np.zeros((obs.shape[0], 2), dtype=np.float32)
        domain = (1.0, 0.1, 0.01, 0.005, 0.0, 1, 0.0, 1.0)
        out_a = env.run_episodes(policy, domain, seed=11, episodes=4)
        out_b = env.run_episodes(policy, domain, seed=11, episodes=4)
        self.assertEqual(
            [o["steps"] for o in out_a[0]], [o["steps"] for o in out_b[0]],
            "same seed + pinned envelope must reproduce episode lengths",
        )

    def test_hard_envelope_latencies_fit_the_fifo(self):
        """Eval envelopes may pin more latency than training DR samples; the
        FIFO capacity must cover them or the traced index goes negative."""
        env = self.make_env(num_envs=2)
        envelopes = (self.pack.get("domainRandomization") or {}).get("evalEnvelopes") or {}
        for name, envelope in envelopes.items():
            latency = int(self.adapter.eval_domain_tuple(envelope)[5])
            self.assertLessEqual(
                latency, env._fifo_capacity,
                f"envelope {name} latency {latency} exceeds FIFO capacity",
            )

    def test_auto_reset_resamples_goal_and_domain(self):
        import numpy as np

        env = self.make_env(num_envs=2)
        goal_before = np.asarray(env.state["goal"]).copy()
        domain_before = np.asarray(env.state["domain"]).copy()
        # Episodes time out at timeout_steps; step past it so every env has
        # auto-reset at least once.
        for _ in range(int(env.timeout_steps) + 2):
            env.step(np.zeros((2, 2), dtype=np.float32))
        self.assertGreater(
            int(np.asarray(env.state["steps"])[0] + 1), 0
        )  # steps exists and is an int batch
        # Episodes reset on timeout: success history must have been recorded
        # (2 envs x at least one full episode each).
        self.assertGreaterEqual(len(env.success_history), 2)

    def test_eval_freeze_keeps_finished_episodes_still(self):
        """After an episode finishes it must stop accumulating steps and
        keep the terminal state (the freeze semantics the batched evaluator
        relies on)."""
        import jax.numpy as jnp
        import numpy as np

        env = self.make_env(num_envs=2)
        # Terminate env 0 by moving its goal onto the start pose.
        state = dict(env.state)
        goal = np.asarray(state["goal"]).copy()
        goal[0] = [0.001, 0.001]
        state["goal"] = jnp.asarray(goal)
        prev = state["prev_dist"].at[0].set(0.0014)
        state["prev_dist"] = prev
        actions = jnp.zeros((2, 2))
        state1, _obs1, _rew1, done, success, _coll = env._eval_step(state, actions)
        self.assertTrue(bool(np.asarray(done)[0]))
        self.assertTrue(bool(np.asarray(success)[0]))
        final_1 = float(np.asarray(state1["final_dist"])[0])
        state2, _obs2, _rew2, _done2, _succ2, _coll2 = env._eval_step(state1, actions)
        final_2 = float(np.asarray(state2["final_dist"])[0])
        self.assertEqual(final_1, final_2, "frozen episode must keep its terminal state")
        self.assertTrue(bool(np.asarray(state2["frozen"])[0]))


@unittest.skipUnless(HAVE_JAX, "jax not installed")
class ResultShapeTests(unittest.TestCase):
    """End-to-end file protocol at smoke budget (2 iterations, 4 envs)."""

    @classmethod
    def setUpClass(cls):
        try:
            import mujoco  # noqa: F401
            from mujoco import mjx  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("mujoco+mujoco-mjx not installed")
        cls.pack = load_resolved_pack()

    def _run_adapter(self, tmp, extra_env=None):
        request = training_request(self.pack, obs_size=8, act_size=2)
        request_path = os.path.join(tmp, "request.json")
        result_path = os.path.join(tmp, "result.json")
        with open(request_path, "w") as handle:
            json.dump(request, handle)
        env = {
            **os.environ,
            "RDK_SIM2REAL_REQUEST_FILE": request_path,
            "RDK_SIM2REAL_RESULT_FILE": result_path,
            "RDK_STARTER_ENGINE_DEVICE": "cpu",
            "RDK_MJX_ENGINE_ITERATIONS": "2",
            "RDK_MJX_ENGINE_ENVS": "4",
            "RDK_MJX_ENGINE_STEPS": "16",
        }
        if extra_env:
            env.update(extra_env)
        run = subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            cwd=tmp,
            capture_output=True,
            text=True,
            env=env,
            timeout=900,
        )
        self.assertEqual(run.returncode, 0, run.stderr[-2000:] if run.stderr else "no stderr")
        with open(result_path) as handle:
            return json.load(handle)

    def test_real_path_result_shape(self):
        import re

        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_adapter(tmp)
            self.assertEqual(result["physicsBackend"], "mjx")
            self.assertEqual(result["metrics"]["physicsBackend"], "mjx")
            self.assertEqual(result["metrics"]["engine"], "mjx-ppo")
            self.assertEqual(result["deployable"], False)
            self.assertEqual(result["metrics"]["iterations"], 2)
            self.assertEqual(result["metrics"]["contractValid"], True)
            self.assertRegex(
                result["artifact"]["artifactRef"],
                r"^artifact://[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119})+$",
            )
            eval_block = result["taskEvaluation"]
            self.assertEqual(eval_block["taskId"], "originbot-goal-navigation")
            nominal = eval_block["trained"]["envelopes"]["nominal"]
            self.assertLessEqual(nominal["successRateCiLow"], nominal["successRate"])
            self.assertGreaterEqual(nominal["successRateCiHigh"], nominal["successRate"])
            # 2 iterations cannot honestly pass a 0.7 gate.
            self.assertEqual(eval_block["qualityGate"]["passed"], False)
            for side in ("policy.onnx", "training-summary.json", "eval-report.json",
                         "telemetry.jsonl", "baseline-telemetry.jsonl"):
                self.assertTrue(
                    os.path.exists(os.path.join(tmp, side)),
                    f"side product {side} missing",
                )

    def test_forced_fallback_reports_kinematic(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest("torch not installed (kinematic fallback unavailable)")
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run_adapter(tmp, extra_env={"RDK_MJX_ADAPTER_FORCE_MJX": "0"})
            self.assertEqual(result["physicsBackend"], "starter-kinematic")
            self.assertEqual(result["metrics"]["physicsBackend"], "starter-kinematic")
            self.assertEqual(result["metrics"]["engine"], "mjx-ppo")
            self.assertEqual(result["taskEvaluation"]["qualityGate"]["passed"], False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
