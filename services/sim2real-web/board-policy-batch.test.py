#!/usr/bin/env python3
"""Contract tests for PolicyRuntime.infer_batch (multi-instance batch serving).

Runs on the development machine (no ROS, no board): imports
board-policy-runtime.py with a private scratch runtime dir, then exercises the
batch-serving op against stub ONNX sessions. Wired into `npm run verify` via
verify:board-policy-batch.

What these tests protect:
- batch serving refuses without a ready model (fail closed);
- request validation names the offending sample instead of truncating;
- a fixed-batch-1 export is served sample-by-sample with row-order preserved
  (a nine-duck formation must never receive another duck's action);
- a dynamic-batch export is served in a single run;
- a non-finite action row rejects the whole request;
- vision exports are refused: batching them would silently change the
  frame-observation pairing;
- the livestream shape [9, 61] is served as-is.
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODULE_PATH = os.path.join(ROOT, "services", "sim2real-web", "board-policy-runtime.py")
_test_runtime = tempfile.TemporaryDirectory(prefix="rdk-policy-batch-")
os.environ["RDK_BOARD_RUNTIME_DIR"] = _test_runtime.name
_spec = importlib.util.spec_from_file_location("board_policy_runtime", MODULE_PATH)
_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_mod)
with mock.patch.dict(os.environ, {"RDK_SIM2REAL_ADAPTER_CONFIG": os.path.join(ROOT, "adapters", "microduck-leg.json")}):
    _joint_spec = importlib.util.spec_from_file_location("board_joint_policy_runtime", os.path.join(ROOT, "services", "sim2real-web", "board-joint-policy-runtime.py"))
    _joint_mod = importlib.util.module_from_spec(_joint_spec)
    assert _joint_spec.loader is not None
    _joint_spec.loader.exec_module(_joint_mod)


class _FakeInput:
    def __init__(self, name, shape):
        self.name = name
        self.shape = shape


class _FixedBatchSession:
    """Stands in for an ONNX session exported with batch==1."""

    def __init__(self, obs_dim=61, action_dim=14):
        self.obs_dim = obs_dim
        self.action_dim = action_dim
        self.calls = []

    def get_inputs(self):
        return [_FakeInput("obs", [1, self.obs_dim])]

    def _derive(self, rows):
        # Row-identity check: action row i must be derived from observation
        # row i (reversed halves), so cross-row mixing cannot pass silently.
        out = np.concatenate([rows[:, self.obs_dim // 2:], rows[:, : self.obs_dim // 2]], axis=1)
        return out[:, : self.action_dim]

    def run(self, _outputs, feeds):
        rows = feeds["obs"]
        self.calls.append(rows.shape[0])
        return [self._derive(rows)]


class _DynamicBatchSession(_FixedBatchSession):
    def get_inputs(self):
        return [_FakeInput("obs", ["batch", self.obs_dim])]


def _ready_runtime(session, obs_dim=61, action_dim=14, image_input_name=None):
    runtime = _mod.PolicyRuntime()
    _mod.EXPECTED_OBS_DIM = obs_dim
    _mod.EXPECTED_ACTION_DIM = action_dim
    runtime._model = session
    runtime._model_kind = "onnx"
    runtime._model_meta = {"path": "stub"}
    runtime._vector_input_name = "obs"
    runtime._image_input_name = image_input_name
    runtime._state = "ready"
    return runtime


class InferBatchTest(unittest.TestCase):
    def test_refuses_without_ready_model(self):
        runtime = _mod.PolicyRuntime()
        result = runtime.infer_batch([[0.0] * 61])
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "model-not-ready")

    def test_refuses_non_2d_and_wrong_width(self):
        runtime = _ready_runtime(_FixedBatchSession())
        self.assertEqual(runtime.infer_batch([0.0] * 61)["error"], "observations-not-2d")
        result = runtime.infer_batch([[0.0] * 8])
        self.assertEqual(result["error"], "observation-dimension-mismatch")
        self.assertEqual(result["expected"], 61)
        self.assertEqual(result["actual"], 8)

    def test_refuses_out_of_range_count(self):
        runtime = _ready_runtime(_FixedBatchSession())
        result = runtime.infer_batch(np.zeros((65, 61), dtype=np.float32))
        self.assertEqual(result["error"], "observations-count-out-of-range")
        self.assertEqual(result["max"], 64)

    def test_refuses_non_finite_input_with_sample_index(self):
        runtime = _ready_runtime(_FixedBatchSession())
        rows = np.zeros((4, 61), dtype=np.float32)
        rows[2, 7] = float("nan")
        result = runtime.infer_batch(rows)
        self.assertEqual(result["error"], "observations-non-finite")
        self.assertEqual(result["sample"], 2)

    def test_fixed_batch_one_session_served_per_sample_in_order(self):
        session = _FixedBatchSession()
        runtime = _ready_runtime(session)
        rng = np.random.default_rng(7)
        rows = rng.normal(0, 0.5, (5, 61)).astype(np.float32)
        result = runtime.infer_batch(rows)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["path"], "per-sample")
        self.assertEqual(result["count"], 5)
        self.assertEqual(session.calls, [1, 1, 1, 1, 1])
        expected = np.concatenate([rows[:, 30:], rows[:, :30]], axis=1)[:, :14]
        np.testing.assert_allclose(np.asarray(result["actions"]), expected, atol=1e-6)

    def test_dynamic_batch_session_served_in_one_run(self):
        session = _DynamicBatchSession()
        runtime = _ready_runtime(session)
        rows = np.ones((9, 61), dtype=np.float32)
        result = runtime.infer_batch(rows)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["path"], "dynamic-batch")
        self.assertEqual(session.calls, [9])

    def test_livestream_nine_duck_shape_served(self):
        runtime = _ready_runtime(_FixedBatchSession())
        result = runtime.infer_batch(np.zeros((9, 61), dtype=np.float32))
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["actions"]), 9)
        self.assertEqual(len(result["actions"][0]), 14)

    def test_non_finite_action_row_rejects_whole_request(self):
        class _DivergingSession(_FixedBatchSession):
            def __init__(self):
                super().__init__()
                self.diverge_at_call = 2  # per-sample path: call i serves sample i

            def run(self, _outputs, feeds):
                self.calls.append(feeds["obs"].shape[0])
                out = super()._derive(feeds["obs"]).copy()
                if len(self.calls) == self.diverge_at_call:
                    out[0, 0] = float("inf")
                return [out]

        runtime = _ready_runtime(_DivergingSession())
        result = runtime.infer_batch(np.zeros((3, 61), dtype=np.float32))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "action-non-finite")
        self.assertEqual(result["sample"], 1)

    def test_vision_model_refused(self):
        runtime = _ready_runtime(_FixedBatchSession(), image_input_name="image")
        result = runtime.infer_batch(np.zeros((2, 61), dtype=np.float32))
        self.assertEqual(result["error"], "vision-model-batch-unsupported")

    def test_op_registered_in_file_protocol(self):
        import inspect

        source = inspect.getsource(_mod._serve_file_protocol)
        self.assertIn('"infer_batch"', source)


class JointInferBatchTest(unittest.TestCase):
    def _ready(self, session=None):
        runtime = _joint_mod.JointPolicyRuntime()
        runtime._model = session or _FixedBatchSession()
        runtime._input_name = "obs"
        runtime._state = "ready"
        runtime._publish_target = mock.Mock(side_effect=AssertionError("actuation forbidden"))
        runtime.bind_ros = mock.Mock(side_effect=AssertionError("ROS forbidden"))
        runtime._spin_once = mock.Mock(side_effect=AssertionError("ROS forbidden"))
        return runtime

    def test_refuses_unready_and_live_motion_states(self):
        runtime = _joint_mod.JointPolicyRuntime()
        self.assertEqual(runtime.infer_batch([[0.0] * 61])["error"], "model-not-ready")
        runtime = self._ready()
        runtime._state = "running"
        self.assertEqual(runtime.infer_batch([[0.0] * 61])["error"], "model-not-ready")

    def test_fixed_rows_remain_independent_and_in_order_without_actuation(self):
        session = _FixedBatchSession()
        runtime = self._ready(session)
        rows = np.random.default_rng(42).normal(size=(16, 61)).astype(np.float32)
        result = runtime.infer_batch(rows)
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["path"], "per-sample")
        self.assertEqual(session.calls, [1] * 16)
        np.testing.assert_array_equal(result["actions"], session._derive(rows))
        self.assertEqual(runtime._published, 0)
        self.assertIsNone(runtime._session_id)
        self.assertIsNone(runtime._last_target)
        runtime._publish_target.assert_not_called()
        runtime.bind_ros.assert_not_called()
        runtime._spin_once.assert_not_called()

    def test_dynamic_batch_runs_once(self):
        session = _DynamicBatchSession()
        result = self._ready(session).infer_batch(np.zeros((9, 61), dtype=np.float32))
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["path"], "dynamic-batch")
        self.assertEqual(session.calls, [9])

    def test_rejects_bad_counts_widths_and_non_finite_inputs(self):
        runtime = self._ready()
        for rows, code in (([0.0] * 61, "observations-not-2d"),
                           (np.zeros((65, 61)), "observations-count-out-of-range"),
                           (np.zeros((1, 60)), "observation-dimension-mismatch"),
                           ([[float("nan")] * 61], "observations-non-finite")):
            self.assertEqual(runtime.infer_batch(rows).get("error"), code)

    def test_rejects_wrong_action_width_instead_of_truncating(self):
        result = self._ready(_FixedBatchSession(action_dim=15)).infer_batch([[0.0] * 61])
        self.assertEqual(result.get("error"), "model-output-dim-mismatch")

    def test_rejects_entire_batch_on_non_finite_action(self):
        session = _FixedBatchSession()
        session.run = lambda _outputs, feeds: [np.full((1, 14), float("inf"), dtype=np.float32)]
        self.assertEqual(self._ready(session).infer_batch([[0.0] * 61]).get("error"), "action-non-finite")

    def test_history_rows_are_caller_composed_and_do_not_mutate_live_history(self):
        runtime = self._ready(_FixedBatchSession(obs_dim=183))
        with mock.patch.object(_joint_mod, "OBS_HISTORY_FRAMES", 3):
            self.assertEqual(runtime.infer_batch([[0.0] * 61]).get("error"), "observation-dimension-mismatch")
            self.assertTrue(runtime.infer_batch([[0.0] * 183]).get("ok"))
        self.assertIsNone(runtime._obs_history)

    def test_ipc_reply_carries_actions_and_template_start_remains_refused(self):
        runtime = self._ready()
        request = {"op": "infer_batch", "seq": 7, "observations": [[0.0] * 61]}
        result = _joint_mod.apply_request(runtime, request)
        self.assertTrue(result.get("ok"), result)
        runtime._record_op("infer_batch", request, result)
        self.assertEqual(runtime.snapshot()["lastOp"]["actions"], [[0.0] * 14])
        self.assertEqual(runtime.snapshot()["lastOp"]["seq"], 7)
        self.assertEqual(runtime.start(0).get("error"), "joint-profile-not-calibrated")
        self.assertEqual(runtime._published, 0)


if __name__ == "__main__":
    unittest.main()
