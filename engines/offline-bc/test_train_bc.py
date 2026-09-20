#!/usr/bin/env python3
"""Contract tests for the offline behavior-cloning engine (v2 MLP).

Wired into `npm run verify` via verify:offline-bc. Runs on the development
machine (no ROS, no board, no GPU) and also works under pytest.

What these tests protect:
- the model is a real MLP: on a nonlinear dataset it must beat the
  closed-form LINEAR fit that the v1 engine was — a linear-capable
  implementation cannot pass this;
- the train/validation split is seeded and reproducible, and the saved
  normalization is estimated on the TRAIN split only;
- runs are deterministic: same seed -> bit-identical weights, and a
  different seed -> different weights (the seed actually does something);
- dirty data fails closed (non-numeric, missing action, inconsistent dims,
  empty dataset, NaN) with NO output file written;
- a dataset too small for its validation split is refused unless
  validation is explicitly disabled;
- ONNX export is byte-honest: the file, when written, is verified against
  the NumPy forward pass, and a forced mismatch deletes the file;
- the file-protocol engine mode reports `mock:false`, labels its synthetic
  smoke dataset as synthetic, and carries the full provenance contract
  (source revision, dependency versions, dependency-lock digest).
"""

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ENGINE = os.path.join(HERE, "train_bc.py")
LOCK_PATH = os.path.join(HERE, "requirements.txt")

sys.path.insert(0, HERE)

try:
    import numpy as np  # noqa: F401
except ImportError:
    print("[offline-bc] SKIP — python3 with numpy not found")
    sys.exit(0)

try:
    import onnx  # noqa: F401
    import onnxruntime  # noqa: F401

    ONNX_AVAILABLE = True
except ImportError:
    ONNX_AVAILABLE = False

import train_bc  # noqa: E402  (after the sys.path insert and skip guard)


def nonlinear_dataset(rows=240, obs=6, act=2, seed=0):
    """A dataset no affine map can fit: the engine must model curvature."""
    rng = np.random.default_rng(seed)
    x = rng.uniform(-1.0, 1.0, (rows, obs))
    y = np.column_stack(
        [
            np.sin(3.0 * x[:, 0]) * x[:, 1],
            np.cos(2.0 * x[:, 2]) + 0.5 * x[:, 3] ** 2,
        ]
    )
    return x, y


def linear_val_loss(x, y, train_idx, val_idx, mean, std):
    """Closed-form least squares — exactly the model class v1 was.

    The comparison baseline for "the upgrade is real": if the MLP cannot
    beat this on held-out rows, the engine has regressed to linear.
    """
    normalized = (x - mean) / std
    design = np.c_[normalized[train_idx], np.ones(len(train_idx))]
    weights, _, _, _ = np.linalg.lstsq(design, y[train_idx], rcond=None)
    prediction = np.c_[normalized[val_idx], np.ones(len(val_idx))] @ weights
    return float(np.mean((prediction - y[val_idx]) ** 2))


def write_jsonl(path, rows):
    pathlib.Path(path).write_text(
        "\n".join(json.dumps(row) for row in rows), encoding="utf-8"
    )


class NonlinearFitTest(unittest.TestCase):
    def test_mlp_beats_the_linear_model_v1_was(self):
        x, y = nonlinear_dataset()
        model, report = train_bc.fit(
            x, y, [32, 32], "tanh", epochs=400, lr=3e-3, batch_size=32,
            seed=0, val_fraction=0.2,
        )
        rows = x.shape[0]
        train_idx, val_idx = train_bc.split_dataset(rows, 0.2, 0)
        mean = np.asarray(model["normalization"]["mean"])
        std = np.asarray(model["normalization"]["std"])
        baseline = linear_val_loss(x, y, train_idx, val_idx, mean, std)
        val_loss = report["validation"]["loss"]
        self.assertLess(
            val_loss,
            0.8 * baseline,
            "MLP val loss %.4f did not beat the linear v1 baseline %.4f by a "
            "margin — the engine is not modeling curvature" % (val_loss, baseline),
        )
        self.assertLess(val_loss, 0.05, "val loss %.4f is high for this task" % val_loss)


class SplitAndNormalizationTest(unittest.TestCase):
    def test_split_is_seeded_and_sizes_add_up(self):
        first = train_bc.split_dataset(100, 0.2, 7)
        second = train_bc.split_dataset(100, 0.2, 7)
        self.assertEqual([list(a) for a in first], [list(b) for b in second])
        train_idx, val_idx = first
        self.assertEqual(len(train_idx) + len(val_idx), 100)
        self.assertEqual(len(val_idx), 20)
        self.assertEqual(len(set(train_idx.tolist()) | set(val_idx.tolist())), 100)

    def test_normalization_comes_from_the_train_split_only(self):
        # 20 rows whose first half and second half have very different scales:
        # if validation rows leaked into the statistics, the saved mean would
        # sit between the two clusters instead of on the training one.
        x = np.vstack([np.full((16, 3), -5.0), np.full((24, 3), 5.0)])
        y = np.zeros((40, 1))
        model, _ = train_bc.fit(
            x, y, [4], "tanh", epochs=1, lr=1e-3, batch_size=32,
            seed=0, val_fraction=0.2,
        )
        train_idx, _ = train_bc.split_dataset(40, 0.2, 0)
        train_rows = x[train_idx]
        # Recompute the split the same way the engine does; the saved mean
        # must equal the TRAIN mean exactly, not the all-rows mean.
        expected_mean = train_rows.mean(axis=0)
        expected_std = np.where(
            train_rows.std(axis=0) < 1e-12, 1.0, train_rows.std(axis=0)
        )
        np.testing.assert_allclose(
            model["normalization"]["mean"], expected_mean, atol=1e-12
        )
        np.testing.assert_allclose(model["normalization"]["std"], expected_std, atol=1e-12)

    def test_validation_can_be_disabled_only_explicitly(self):
        x, y = nonlinear_dataset(rows=40)
        model, report = train_bc.fit(
            x, y, [8], "tanh", epochs=2, lr=1e-3, batch_size=32,
            seed=0, val_fraction=0.0,
        )
        self.assertFalse(report["validation"]["enabled"])
        self.assertIsNone(report["validation"]["loss"])
        self.assertEqual(report["samples"]["val"], 0)
        self.assertEqual(report["samples"]["train"], 40)

    def test_dataset_too_small_for_the_split_is_refused(self):
        x, y = nonlinear_dataset(rows=6)
        with self.assertRaises(ValueError) as ctx:
            train_bc.fit(
                x, y, [8], "tanh", epochs=2, lr=1e-3, batch_size=32,
                seed=0, val_fraction=0.2,
            )
        self.assertIn("val-fraction", str(ctx.exception))


class DeterminismTest(unittest.TestCase):
    def test_same_seed_bit_identical(self):
        x, y = nonlinear_dataset(rows=60)
        runs = [
            train_bc.fit(
                x, y, [16], "tanh", epochs=20, lr=1e-3, batch_size=16,
                seed=5, val_fraction=0.2,
            )
            for _ in range(2)
        ]
        self.assertEqual(runs[0][0]["layers"], runs[1][0]["layers"])
        self.assertEqual(runs[0][1]["train_loss"], runs[1][1]["train_loss"])

    def test_different_seed_different_weights(self):
        x, y = nonlinear_dataset(rows=60)
        first, _ = train_bc.fit(
            x, y, [16], "tanh", epochs=5, lr=1e-3, batch_size=16,
            seed=1, val_fraction=0.2,
        )
        second, _ = train_bc.fit(
            x, y, [16], "tanh", epochs=5, lr=1e-3, batch_size=16,
            seed=2, val_fraction=0.2,
        )
        self.assertNotEqual(first["layers"], second["layers"])


class FailClosedTest(unittest.TestCase):
    def _bad_rows(self):
        return {
            "non-numeric": [{"observation": [1, "a"], "action": [0.1]}],
            "missing-action": [{"observation": [1, 2]}],
            "inconsistent-dims": [
                {"observation": [1, 2], "action": [0.1]},
                {"observation": [1, 2, 3], "action": [0.1]},
            ],
            "empty": [],
            "nan": [{"observation": [1, float("nan")], "action": [0.1]}],
        }

    def test_dirty_data_is_rejected_without_writing_output(self):
        with tempfile.TemporaryDirectory(prefix="offline-bc-failclosed-") as workdir:
            out = os.path.join(workdir, "model.json")
            for name, rows in self._bad_rows().items():
                dataset = os.path.join(workdir, "bad.jsonl")
                write_jsonl(dataset, rows)
                with self.assertRaises(ValueError, msg="case %s" % name):
                    train_bc.load_dataset(dataset)
            self.assertFalse(os.path.exists(out))

    def test_cli_failure_leaves_no_model_file(self):
        with tempfile.TemporaryDirectory(prefix="offline-bc-cli-") as workdir:
            dataset = os.path.join(workdir, "bad.jsonl")
            write_jsonl(dataset, [{"observation": [1, "x"], "action": [0.1]}])
            out = os.path.join(workdir, "model.json")
            run = subprocess.run(
                [sys.executable, ENGINE, dataset, "--out", out],
                capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertIn("FAIL", run.stderr)
            self.assertFalse(os.path.exists(out), "failed run wrote a model file")

    def test_cli_missing_dataset_fails_with_a_readable_message(self):
        with tempfile.TemporaryDirectory(prefix="offline-bc-missing-") as workdir:
            out = os.path.join(workdir, "model.json")
            run = subprocess.run(
                [sys.executable, ENGINE, os.path.join(workdir, "nope.jsonl"),
                 "--out", out],
                capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(run.returncode, 2, run.stderr)
            # A missing file must be a clean one-line cause, not a traceback.
            self.assertIn("[offline-bc] FAIL", run.stderr)
            self.assertNotIn("Traceback", run.stderr)
            self.assertFalse(os.path.exists(out))

    def test_hidden_spec_is_validated(self):
        for spec in ("", "0", "x", "-1,4"):
            with self.assertRaises(ValueError, msg="spec %r" % spec):
                train_bc.parse_hidden(spec)


@unittest.skipUnless(ONNX_AVAILABLE, "onnx/onnxruntime not installed")
class OnnxExportTest(unittest.TestCase):
    def test_export_is_verified_against_the_numpy_forward(self):
        x, y = nonlinear_dataset(rows=80)
        model, _ = train_bc.fit(
            x, y, [16, 16], "tanh", epochs=30, lr=3e-3, batch_size=16,
            seed=0, val_fraction=0.2,
        )
        with tempfile.TemporaryDirectory(prefix="offline-bc-onnx-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            report = train_bc.export_onnx(model, target, x)
            self.assertTrue(report["exported"])
            self.assertEqual(report["equivalence"], "verified")
            self.assertLess(report["maxAbsDiff"], train_bc.EQUIVALENCE_ATOL)
            self.assertTrue(os.path.exists(target))

    def test_mismatch_deletes_the_file_and_fails(self):
        x, y = nonlinear_dataset(rows=80)
        model, _ = train_bc.fit(
            x, y, [16, 16], "tanh", epochs=5, lr=3e-3, batch_size=16,
            seed=0, val_fraction=0.2,
        )
        with tempfile.TemporaryDirectory(prefix="offline-bc-mismatch-") as workdir:
            target = os.path.join(workdir, "policy.onnx")
            original = train_bc.EQUIVALENCE_ATOL
            train_bc.EQUIVALENCE_ATOL = -1.0  # every export now "mismatches"
            try:
                with self.assertRaises(ValueError):
                    train_bc.export_onnx(model, target, x)
            finally:
                train_bc.EQUIVALENCE_ATOL = original
            self.assertFalse(
                os.path.exists(target), "an unverified ONNX file was kept"
            )


class ModelFormatTest(unittest.TestCase):
    def test_model_records_format_dims_and_provenance(self):
        x, y = nonlinear_dataset(rows=40)
        model, report = train_bc.fit(
            x, y, [8], "tanh", epochs=2, lr=1e-3, batch_size=16,
            seed=0, val_fraction=0.2,
        )
        payload = dict(model)
        payload["metrics"] = report
        payload.update(
            train_bc.provenance_block({"numpy"})
        )
        self.assertEqual(payload["format"], "rdk-offline-bc-v2")
        self.assertEqual(payload["observation_size"], 6)
        self.assertEqual(payload["action_size"], 2)
        self.assertEqual(len(payload["normalization"]["mean"]), 6)
        self.assertEqual(len(payload["layers"]), 2)  # 6 -> 8 -> 2
        self.assertEqual(len(payload["layers"][0]["weights"]), 6)  # rows = obs
        self.assertEqual(len(payload["layers"][0]["weights"][0]), 8)  # cols = hidden
        source = payload["source"]
        self.assertIn(source.get("known"), (True, False))
        if source.get("known"):
            self.assertRegex(source["commit"], r"^[a-f0-9]{40}$")
            self.assertIsInstance(source["dirty"], (bool, type(None)))
        self.assertIn("numpy", payload["dependencies"])
        self.assertRegex(payload["dependencies"]["numpy"], r"^\d")
        if os.path.exists(LOCK_PATH):
            expected = hashlib.sha256(
                pathlib.Path(LOCK_PATH).read_bytes()
            ).hexdigest()
            self.assertEqual(payload["dependencyLockSha256"], expected)
        else:
            self.assertIsNone(payload["dependencyLockSha256"])


class EngineModeTest(unittest.TestCase):
    """The file protocol the provenance gate drives."""

    def test_smoke_run_is_real_training_on_labeled_synthetic_data(self):
        with tempfile.TemporaryDirectory(prefix="offline-bc-engine-") as workdir:
            request = {
                "schemaVersion": 1,
                "contract": {
                    "id": "offline-bc-smoke",
                    "observationSize": 7,
                    "actionSize": 3,
                },
                "model": {"modelId": "bc-smoke", "version": "0.1.0"},
                "training": {"profile": "smoke", "maxIterations": 3},
            }
            request_path = os.path.join(workdir, "request.json")
            result_path = os.path.join(workdir, "result.json")
            pathlib.Path(request_path).write_text(json.dumps(request))
            run = subprocess.run(
                [sys.executable, ENGINE],
                capture_output=True, text=True, timeout=300, cwd=workdir,
                env={
                    **os.environ,
                    "RDK_SIM2REAL_REQUEST_FILE": request_path,
                    "RDK_SIM2REAL_RESULT_FILE": result_path,
                },
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads(pathlib.Path(result_path).read_text())
            self.assertEqual(result["schemaVersion"], 1)
            self.assertEqual(result["status"], "completed")
            self.assertIs(result["mock"], False)
            self.assertTrue(result["dataset"]["synthetic"])
            self.assertEqual(result["dataset"]["source"], "synthetic-smoke")
            self.assertEqual(result["contract"]["observationSize"], 7)
            self.assertEqual(result["contract"]["actionSize"], 3)
            self.assertTrue(result["metrics"]["validation"]["enabled"])
            self.assertIsInstance(result["metrics"]["validation"]["loss"], float)
            self.assertTrue(
                os.path.exists(os.path.join(workdir, "model.json"))
            )
            source = result["source"]
            self.assertIn(source.get("known"), (True, False))
            self.assertIn("numpy", result["dependencies"])
            if os.path.exists(LOCK_PATH):
                expected = hashlib.sha256(
                    pathlib.Path(LOCK_PATH).read_bytes()
                ).hexdigest()
                self.assertEqual(result["dependencyLockSha256"], expected)


def mono8_row(image, action, observation=None):
    import base64

    row = {
        "image": base64.b64encode(np.asarray(image, dtype=np.uint8).tobytes()).decode(),
        "action": action,
    }
    if observation is not None:
        row["observation"] = observation
    return row


def quadrant_image_dataset(rows=96, size=32, seed=0, with_vector=True):
    """Bright quadrant determines the action — a pixel task no vector-only
    model can see, so a pass proves the conv branch actually runs."""
    rng = np.random.default_rng(seed)
    images = []
    ys = []
    xs = []
    actions = (
        (1.0, 0.0),
        (-1.0, 0.0),
        (0.2, 1.0),
        (0.2, -1.0),
    )
    for i in range(rows):
        img = np.zeros((size, size), dtype=np.uint8)
        quadrant = i % 4
        if quadrant == 0:
            img[: size // 2, :] = 255
        elif quadrant == 1:
            img[size // 2 :, :] = 255
        elif quadrant == 2:
            img[:, : size // 2] = 255
        else:
            img[:, size // 2 :] = 255
        img = np.clip(
            img.astype(np.int64) + rng.integers(0, 12, img.shape), 0, 255
        ).astype(np.uint8)
        images.append(img)
        ys.append(list(actions[quadrant]))
        xs.append([quadrant / 4.0, 0.5] if with_vector else None)
    return (
        np.stack(images).astype(np.float64),
        np.asarray(xs, dtype=np.float64) if with_vector else None,
        np.asarray(ys, dtype=np.float64),
    )


def naive_conv(x, weights, biases, k, stride):
    """Textbook loop conv in (c, kh, kw) weight order — the reference the
    im2col path is proven against."""
    n, c, h, w = x.shape
    f = weights.shape[0]
    oh = (h - k) // stride + 1
    ow = (w - k) // stride + 1
    out = np.zeros((n, f, oh, ow))
    # weights arrive [f, c, k, k]
    for ni in range(n):
        for fi in range(f):
            for yi in range(oh):
                for xi in range(ow):
                    patch = x[ni, :, yi * stride : yi * stride + k, xi * stride : xi * stride + k]
                    out[ni, fi, yi, xi] = np.sum(patch * weights[fi]) + biases[fi]
    return out


class ImageBranchTest(unittest.TestCase):
    def test_parse_image_input_rejects_collapsing_dims(self):
        self.assertEqual(train_bc.parse_image_input("64x64"), (64, 64))
        self.assertEqual(train_bc.parse_image_input("32X24"), (32, 24))
        for bad in ("16x16", "8x8", "0x32", "abc", "64"):
            with self.assertRaises(ValueError):
                train_bc.parse_image_input(bad)

    def test_im2col_conv_matches_a_naive_reference(self):
        rng = np.random.default_rng(1)
        x = rng.uniform(-1.0, 1.0, (2, 3, 9, 9))
        for k, stride in ((3, 1), (3, 2), (4, 2)):
            f = 5
            weights = rng.uniform(-1.0, 1.0, (f, k * k * 3))
            biases = rng.uniform(-1.0, 1.0, f)
            cols, oh, ow = train_bc._im2col(x, k, stride)
            out = (np.matmul(weights, cols) + biases[None, :, None]).reshape(2, f, oh, ow)
            # The engine stores conv rows in (kh, kw, c) order — the same
            # order the ONNX export un-scrambles with its transpose.
            reference = naive_conv(
                x, weights.reshape(f, k, k, 3).transpose(0, 3, 1, 2), biases, k, stride
            )
            np.testing.assert_allclose(
                out, reference, atol=1e-12,
                err_msg="im2col conv (k=%d s=%d) disagrees with the naive loop" % (k, stride),
            )

    def test_backward_gradient_matches_finite_differences(self):
        rng = np.random.default_rng(2)
        x_img, x_vec, _ = quadrant_image_dataset(rows=4, size=32, with_vector=True)
        target = rng.uniform(-1.0, 1.0, (4, 2))
        params = train_bc.init_image_net(32, 32, 2, [16], 2, "tanh", 0)
        pixel_norm = (float(x_img.mean()), max(float(x_img.std()), 1e-12))

        def loss():
            prediction, _ = train_bc.forward_image(params, x_img, x_vec, pixel_norm, "tanh")
            return float(np.sum((prediction - target) ** 2)) / 2.0

        prediction, cache = train_bc.forward_image(params, x_img, x_vec, pixel_norm, "tanh")
        grads = train_bc.backward_image(params, cache, "tanh", prediction - target)
        eps = 1e-5
        checked = 0
        for layer in (0, 1, 3):  # two conv layers + first dense layer
            for slot in (0, 1):
                array = params[layer][slot]
                flat_grad = grads[layer][slot]
                self.assertEqual(flat_grad.shape, array.shape)
                indices = rng.choice(array.size, size=min(12, array.size), replace=False)
                for index in indices:
                    multi = np.unravel_index(index, array.shape)
                    original = array[multi]
                    array[multi] = original + eps
                    up = loss()
                    array[multi] = original - eps
                    down = loss()
                    array[multi] = original
                    numeric = (up - down) / (2 * eps)
                    analytic = flat_grad[multi]
                    scale = max(1.0, abs(numeric), abs(analytic))
                    self.assertLess(
                        abs(numeric - analytic) / scale,
                        1e-4,
                        "gradient mismatch at layer %d slot %d index %s: "
                        "numeric %.8g vs analytic %.8g" % (layer, slot, multi, numeric, analytic),
                    )
                    checked += 1
        self.assertGreaterEqual(checked, 60)

    def test_image_policy_learns_a_pixel_task(self):
        x_img, x_vec, y = quadrant_image_dataset()
        model, report = train_bc.fit_image(
            x_img, x_vec, y, [32], "tanh", epochs=120, lr=3e-3,
            batch_size=16, seed=0, val_fraction=0.25,
        )
        self.assertEqual(model["format"], train_bc.MODEL_FORMAT_IMAGE)
        self.assertEqual(model["modality"], "image+vector")
        self.assertTrue(report["validation"]["enabled"])
        self.assertLess(
            report["validation"]["loss"], 0.01,
            "val loss %.4f on the quadrant task — the conv branch did not learn" % report["validation"]["loss"],
        )

    def test_image_dataset_rules_fail_closed(self):
        import base64

        img = np.zeros((32, 32), dtype=np.uint8)
        good = base64.b64encode(img.tobytes()).decode()
        base = {"image": good, "action": [0.1, 0.2]}
        cases = {
            "not base64": {"image": "!!!", "action": [0.1, 0.2]},
            "wrong byte count": {"image": base64.b64encode(b"\x00" * 99).decode(), "action": [0.1, 0.2]},
            "missing action": {"image": good},
            "non-numeric action": {"image": good, "action": [True, 0.2]},
            "nan action": {"image": good, "action": [float("nan"), 0.2]},
        }
        for label, row in cases.items():
            with self.assertRaises(ValueError, msg=label):
                load_image_dataset_path(row)

        rows = [
            mono8_row(img, [0.1, 0.2], observation=[1.0, 2.0]),
            mono8_row(img, [0.1, 0.2]),
        ]
        with self.assertRaises(ValueError, msg="inconsistent vector presence"):
            load_rows_path(rows)

    def test_inconsistent_vector_dimensions_fail_closed(self):
        img = np.zeros((32, 32), dtype=np.uint8)
        rows = [
            mono8_row(img, [0.1, 0.2], observation=[1.0, 2.0]),
            mono8_row(img, [0.1, 0.2], observation=[1.0, 2.0, 3.0]),
        ]
        with self.assertRaises(ValueError, msg="inconsistent vector dims"):
            load_rows_path(rows)

    def test_inconsistent_action_dimensions_fail_closed(self):
        img = np.zeros((32, 32), dtype=np.uint8)
        rows = [mono8_row(img, [0.1, 0.2]), mono8_row(img, [0.1, 0.2, 0.3])]
        with self.assertRaises(ValueError, msg="inconsistent action dims"):
            load_rows_path(rows)

    def test_image_training_is_deterministic(self):
        x_img, x_vec, y = quadrant_image_dataset(rows=48)
        a, _ = train_bc.fit_image(x_img, x_vec, y, [16], "tanh", epochs=5, lr=1e-3, batch_size=8, seed=3, val_fraction=0)
        b, _ = train_bc.fit_image(x_img, x_vec, y, [16], "tanh", epochs=5, lr=1e-3, batch_size=8, seed=3, val_fraction=0)
        self.assertEqual(a["conv"], b["conv"])
        self.assertEqual(a["dense_layers"], b["dense_layers"])

    @unittest.skipUnless(ONNX_AVAILABLE, "onnx/onnxruntime not installed")
    def test_onnx_export_is_nhwc_and_verified(self):
        import onnx

        x_img, x_vec, y = quadrant_image_dataset(rows=48)
        model, _ = train_bc.fit_image(x_img, x_vec, y, [16], "tanh", epochs=3, lr=1e-3, batch_size=8, seed=0, val_fraction=0)
        out = pathlib.Path(tempfile.gettempdir()) / "bc-image-equivalence.onnx"
        try:
            report = train_bc.export_onnx_image(model, out.as_posix(), x_img, x_vec)
            self.assertEqual(report.get("equivalence"), "verified")
            graph = onnx.load(out.as_posix()).graph
            image_input = next(i for i in graph.input if i.name == "image")
            shape = [d.dim_param or d.dim_value for d in image_input.type.tensor_type.shape.dim]
            self.assertEqual(len(shape), 4, "image input must be rank-4")
            self.assertEqual(shape[3], 1, "platform vision gate expects NHWC with fixed channels")
            self.assertEqual(shape[1], 32)
            self.assertEqual(shape[2], 32)
        finally:
            if out.exists():
                out.unlink()

    def test_cli_image_mode_writes_v3_model(self):
        x_img, x_vec, y = quadrant_image_dataset(rows=64)
        with tempfile.TemporaryDirectory() as tmp:
            ds = pathlib.Path(tmp) / "ds.jsonl"
            write_jsonl(
                ds.as_posix(),
                [mono8_row(x_img[i], y[i].tolist(), observation=x_vec[i].tolist()) for i in range(64)],
            )
            out = pathlib.Path(tmp) / "model.json"
            result = subprocess.run(
                [sys.executable, ENGINE, ds.as_posix(), "--image-input", "32x32",
                 "--out", out.as_posix(), "--epochs", "5", "--hidden", "16",
                 "--batch", "8", "--val-fraction", "0"],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(out.read_text())
            self.assertEqual(payload["format"], train_bc.MODEL_FORMAT_IMAGE)
            self.assertEqual(payload["image_input"]["width"], 32)
            self.assertIn("source", payload)
            self.assertIn("dependencyLockSha256", payload)


def load_image_dataset_path(row):
    """Single-row helper: routes one row dict through the loader rules by
    writing it to a temp file (the loader is file-based)."""
    return load_rows_path([row])


def load_rows_path(rows):
    import tempfile as _tempfile

    with _tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
        handle.write("\n".join(json.dumps(row) for row in rows) + "\n")
        path = handle.name
    try:
        return train_bc.load_image_dataset(path, 32, 32)
    finally:
        os.unlink(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
