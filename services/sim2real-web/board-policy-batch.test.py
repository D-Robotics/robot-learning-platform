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

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODULE_PATH = os.path.join(ROOT, "services", "sim2real-web", "board-policy-runtime.py")
_test_runtime = tempfile.TemporaryDirectory(prefix="rdk-policy-batch-")
os.environ["RDK_BOARD_RUNTIME_DIR"] = _test_runtime.name
_spec = importlib.util.spec_from_file_location("board_policy_runtime", MODULE_PATH)
_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_mod)


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


if __name__ == "__main__":
    unittest.main()
