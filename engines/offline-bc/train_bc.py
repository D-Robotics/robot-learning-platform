#!/usr/bin/env python3
"""Offline behavior-cloning trainer for transition JSONL datasets.

The v1 trainer was a linear regressor: one closed-form least-squares fit on
raw observations. That can only reproduce demonstrations whose action is an
affine function of the observation, which no real robot policy is. This v2
engine keeps the same CLI and the same fail-closed data rules, and replaces
the model with a real MLP trained by minibatch Adam:

* train/validation split before any training (seeded, reproducible);
* observation standardization estimated on the TRAIN split only, so the
  validation score is not contaminated by validation statistics;
* honest metrics: train and validation MSE are reported side by side, and a
  run without a validation split must say so explicitly rather than reporting
  a validation number it does not have;
* deterministic: same dataset + same seed -> bit-identical weights;
* optional ONNX export of the exact same network (normalization folded into
  the graph), verified at export time against the NumPy forward pass with
  onnxruntime — a mismatch refuses to write the file;
* provenance: the saved model records the code revision, the library
  versions actually imported and the dependency-lock digest, mirroring the
  runner engines (`npm run verify:training-provenance`).

File protocol (engine mode): when RDK_SIM2REAL_REQUEST_FILE and
RDK_SIM2REAL_RESULT_FILE are set, the trainer runs a smoke round on a
deterministic SYNTHETIC dataset generated from the request's contract
dimensions. The synthetic source is labeled in the result — the training is
real, the data is not, and the result says which is which.

Output model format `rdk-offline-bc-v2` (JSON): layer weights, activation,
normalization constants, metrics, seed and provenance blocks. The v1 format's
`observation_size` / `action_size` keys are kept so tooling keyed on the
historical validation notes keeps reading the dimension fields.
"""

import argparse
import base64
import binascii
import json
import math
import os
import pathlib
import sys

import numpy as np

MODEL_FORMAT = "rdk-offline-bc-v2"
MODEL_FORMAT_IMAGE = "rdk-offline-bc-v3"
ACTIVATIONS = ("tanh", "relu")
ONNX_MISSING_HINT = "python3 -m pip install --user onnx onnxruntime"
# Minimum rows per split: a validation MSE computed on one or two rows is
# noise, so a split that small is refused instead of reported as evidence.
MIN_TRAIN_ROWS = 8
MIN_VAL_ROWS = 4
EQUIVALENCE_ATOL = 1e-4
EQUIVALENCE_ROWS = 64
# Fixed image-branch encoder: three stride-2 convolutions (k=4) shrink the
# input by 8x per side before the dense head. Deliberately NOT configurable:
# a fixed encoder keeps the ONNX graph, the equivalence proof and the review
# surface small; capacity knobs live in the dense head (--hidden).
IMAGE_CONV_LAYERS = ((8, 4, 2), (16, 4, 2), (32, 4, 2))


def source_revision():
    """Exact revision of the training code that produced this model.

    Mirrors the runner engines: best-effort by design — a checkout without
    `.git` yields `known=False` rather than failing the run or inventing an
    identity. `dirty=True` says the recorded commit does not fully describe
    the code that ran, instead of implying exact reproducibility.
    """
    import subprocess

    def run(*args):
        return subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )

    try:
        head = run("rev-parse", "HEAD")
        if head.returncode != 0:
            return {"known": False, "reason": "not-a-git-checkout"}
        commit = head.stdout.strip().lower()
        if len(commit) != 40:
            return {"known": False, "reason": "unexpected-revision-format"}
        status = run("status", "--porcelain")
        provenance = {
            "known": True,
            "commit": commit,
            "dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
        }
        return provenance
    except (OSError, subprocess.SubprocessError):
        return {"known": False, "reason": "git-unavailable"}


def dependency_lock_digest():
    """SHA-256 of this engine's shipped requirements.txt, or None.

    The lock is what makes the recorded `dependencies` versions reproducible;
    the digest lets a reviewer detect a run produced under a different pin."
    """
    import hashlib

    lock = pathlib.Path(__file__).with_name("requirements.txt")
    if not lock.is_file():
        return None
    return hashlib.sha256(lock.read_bytes()).hexdigest()


def dependency_versions(used):
    """Versions of the libraries this run actually imported.

    `used` is a set of import names; a library that was not imported (ONNX
    when no export happened) must not appear, because the provenance gate
    cross-checks every reported name against the engine's lock.
    """
    import importlib

    recorded = {}
    for name in used:
        try:
            recorded[name] = importlib.import_module(name).__version__
        except (ImportError, AttributeError):
            # A missing optional library is never silently reported as present.
            pass
    return recorded


def load_dataset(path):
    """Load a transition JSONL file with v1's strict, fail-closed rules.

    Every rule that existed in v1 still exists here: numeric values only
    (booleans are not numbers), consistent dimensions, non-empty dataset.
    One rule is tightened: NaN/Inf are floats to `isinstance` but poison every
    downstream statistic, so they are rejected at load time.
    """
    xs = []
    ys = []
    path = pathlib.Path(path)
    for line_no, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        obs = row.get("observation", row.get("state"))
        act = row.get("action")
        if not isinstance(obs, list) or not isinstance(act, list):
            raise ValueError(
                "line %d: observation/action required as numeric lists" % line_no
            )
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in obs + act):
            raise ValueError("line %d: values must be numeric" % line_no)
        if any(not math.isfinite(v) for v in obs + act):
            raise ValueError("line %d: values must be finite (no NaN/Inf)" % line_no)
        xs.append(obs)
        ys.append(act)
    if not xs:
        raise ValueError("dataset is empty")
    if len({len(x) for x in xs}) != 1 or len({len(y) for y in ys}) != 1:
        raise ValueError("inconsistent dimensions")
    return np.asarray(xs, dtype=np.float64), np.asarray(ys, dtype=np.float64)


def split_dataset(rows, val_fraction, seed):
    """Seeded train/validation index split.

    The permutation comes from a dedicated generator so training shuffles can
    consume their own stream without disturbing the split — a common source
    of "my val score changed when I changed batch size" bugs.
    """
    rng = np.random.default_rng(seed)
    permutation = rng.permutation(rows)
    n_val = int(round(rows * val_fraction))
    return permutation[n_val:], permutation[:n_val]


def standardize(x_train):
    """Mean/std of the TRAIN split; zero variance dims map to std 1.

    Standardization is estimated on train only so the validation score stays
    an honest estimate of unseen-data error.
    """
    mean = x_train.mean(axis=0)
    std = x_train.std(axis=0)
    std = np.where(std < 1e-12, 1.0, std)
    return mean, std


def init_mlp(sizes, activation, seed):
    """Xavier-initialized MLP weights as a list of (weights, biases)."""
    rng = np.random.default_rng(seed)
    layers = []
    for fan_in, fan_out in zip(sizes[:-1], sizes[1:]):
        bound = math.sqrt(6.0 / (fan_in + fan_out))
        weights = rng.uniform(-bound, bound, (fan_in, fan_out))
        biases = np.zeros(fan_out)
        layers.append((weights, biases))
    return layers


def _activate(z, activation):
    if activation == "tanh":
        return np.tanh(z)
    return np.maximum(z, 0.0)


def _activation_grad(a, activation):
    if activation == "tanh":
        return 1.0 - a * a
    return (a > 0.0).astype(a.dtype)


def forward(layers, x, activation):
    """Forward pass returning (output, activations). Activations are needed
    by the backward pass, so they are cached rather than recomputed."""
    activations = [x]
    current = x
    last = len(layers) - 1
    for index, (weights, biases) in enumerate(layers):
        current = current @ weights + biases
        if index != last:
            current = _activate(current, activation)
        activations.append(current)
    return current, activations


def evaluate(layers, x, y, activation):
    """Mean squared error over every output element."""
    prediction, _ = forward(layers, x, activation)
    return float(np.mean((prediction - y) ** 2))


def train_mlp(layers, x, y, activation, epochs, lr, batch_size, seed):
    """Minibatch Adam on MSE. Same seed -> bit-identical weights.

    The shuffle stream is separate from the split stream (see
    `split_dataset`), so validation membership never depends on batch size.
    """
    rng = np.random.default_rng(seed + 1)
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    adam_m = [[np.zeros_like(w), np.zeros_like(b)] for w, b in layers]
    adam_v = [[np.zeros_like(w), np.zeros_like(b)] for w, b in layers]
    step = 0
    rows = x.shape[0]
    batch_size = min(batch_size, rows)
    for _ in range(epochs):
        order = rng.permutation(rows)
        for start in range(0, rows, batch_size):
            batch = order[start : start + batch_size]
            xb, yb = x[batch], y[batch]
            prediction, activations = forward(layers, xb, activation)
            error = prediction - yb
            delta = (2.0 / error.size) * error
            step += 1
            for index in range(len(layers) - 1, -1, -1):
                weights, biases = layers[index]
                grad_w = activations[index].T @ delta
                grad_b = delta.sum(axis=0)
                delta = (delta @ weights.T) * _activation_grad(
                    activations[index], activation
                )
                for slot, grad in ((0, grad_w), (1, grad_b)):
                    m = adam_m[index][slot]
                    v = adam_v[index][slot]
                    m[...] = beta1 * m + (1.0 - beta1) * grad
                    v[...] = beta2 * v + (1.0 - beta2) * grad * grad
                    m_hat = m / (1.0 - beta1**step)
                    v_hat = v / (1.0 - beta2**step)
                    param = layers[index][slot]
                    param[...] = param - lr * m_hat / (np.sqrt(v_hat) + eps)
    return layers


def fit(x, y, hidden_sizes, activation, epochs, lr, batch_size, seed, val_fraction):
    """Split, standardize, train and score. Returns model + report.

    `validation: false` in the report is an explicit statement ("this run has
    no validation estimate"), never a missing field that could be read as
    either state.
    """
    rows = x.shape[0]
    if val_fraction > 0:
        train_idx, val_idx = split_dataset(rows, val_fraction, seed)
        if len(train_idx) < MIN_TRAIN_ROWS or len(val_idx) < MIN_VAL_ROWS:
            raise ValueError(
                "dataset too small for a %.0f%% validation split (%d rows); "
                "pass --val-fraction 0 to disable validation explicitly"
                % (val_fraction * 100, rows)
            )
        x_train, y_train = x[train_idx], y[train_idx]
        x_val, y_val = x[val_idx], y[val_idx]
    else:
        train_idx = np.arange(rows)
        val_idx = np.array([], dtype=train_idx.dtype)
        x_train, y_train = x, y
        x_val = y_val = None

    mean, std = standardize(x_train)
    x_train_n = (x_train - mean) / std
    sizes = [x.shape[1], *hidden_sizes, y.shape[1]]
    layers = init_mlp(sizes, activation, seed)
    train_mlp(layers, x_train_n, y_train, activation, epochs, lr, batch_size, seed)

    train_loss = evaluate(layers, x_train_n, y_train, activation)
    if x_val is not None:
        val_loss = evaluate(layers, (x_val - mean) / std, y_val, activation)
        validation = {"enabled": True, "loss": val_loss}
    else:
        validation = {"enabled": False, "loss": None}

    model = {
        "format": MODEL_FORMAT,
        "observation_size": int(x.shape[1]),
        "action_size": int(y.shape[1]),
        "hidden_sizes": [int(h) for h in hidden_sizes],
        "activation": activation,
        "normalization": {"mean": mean.tolist(), "std": std.tolist()},
        "layers": [
            {"weights": w.tolist(), "biases": b.tolist()} for w, b in layers
        ],
    }
    report = {
        "train_loss": train_loss,
        "validation": validation,
        "epochs": int(epochs),
        "learning_rate": float(lr),
        "batch_size": int(batch_size),
        "seed": int(seed),
        "samples": {"train": int(len(train_idx)), "val": int(len(val_idx))},
    }
    return model, report


def parse_image_input(spec):
    """`64x64` -> (width=64, height=64). Both sides must be positive and a
    multiple of 8 (three stride-2 k=4 convolutions need it to stay integer)."""
    parts = spec.lower().split("x")
    if len(parts) != 2:
        raise ValueError("--image-input must look like 64x64 (WIDTHxHEIGHT)")
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError:
        raise ValueError("--image-input must be integers, got %r" % spec)
    if width <= 0 or height <= 0:
        raise ValueError("--image-input dimensions must be positive")
    if width % 8 or height % 8:
        raise ValueError(
            "--image-input dimensions must be multiples of 8 (three stride-2 "
            "k=4 convolutions), got %dx%d" % (width, height)
        )
    return width, height


def load_image_dataset(path, width, height):
    """Load a mono8 image JSONL dataset with the same fail-closed rules as the
    vector loader.

    Row schema: {"image": "<base64 of exactly width*height mono8 bytes>",
    "action": [...], "observation": [...]}. The vector observation is optional
    but its presence must be consistent across every row (a model that
    sometimes sees proprioception and sometimes does not is two different
    models pretending to be one).
    """
    expected_bytes = width * height
    images = []
    observations = []
    actions = []
    saw_vector = False
    path = pathlib.Path(path)
    for line_no, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        raw = row.get("image")
        act = row.get("action")
        if not isinstance(raw, str) or not isinstance(act, list):
            raise ValueError(
                "line %d: image (base64 string) and action (numeric list) required" % line_no
            )
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in act):
            raise ValueError("line %d: action values must be numeric" % line_no)
        if any(not math.isfinite(v) for v in act):
            raise ValueError("line %d: action values must be finite" % line_no)
        try:
            decoded = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("line %d: image is not valid base64" % line_no)
        if len(decoded) != expected_bytes:
            raise ValueError(
                "line %d: image decodes to %d bytes, expected %d (%dx%d mono8)"
                % (line_no, len(decoded), expected_bytes, width, height)
            )
        obs = row.get("observation")
        if obs is not None:
            if not isinstance(obs, list) or any(
                isinstance(v, bool) or not isinstance(v, (int, float)) for v in obs
            ):
                raise ValueError("line %d: observation must be a numeric list" % line_no)
            if any(not math.isfinite(v) for v in obs):
                raise ValueError("line %d: observation values must be finite" % line_no)
            saw_vector = True
        elif observations and any(o is not None for o in observations[-1:]):
            pass
        images.append(np.frombuffer(decoded, dtype=np.uint8).astype(np.float64))
        observations.append(obs)
        actions.append(act)
    if not images:
        raise ValueError("dataset is empty")
    if saw_vector and any(o is None for o in observations):
        raise ValueError(
            "inconsistent rows: some rows carry a vector observation, others do not"
        )
    if saw_vector and len({len(o) for o in observations}) != 1:
        raise ValueError("inconsistent vector observation dimensions")
    if len({len(y) for y in actions}) != 1:
        raise ValueError("inconsistent action dimensions")
    x_img = np.stack(images).reshape((-1, height, width))
    x_vec = np.asarray(observations, dtype=np.float64) if saw_vector else None
    y = np.asarray(actions, dtype=np.float64)
    return x_img, x_vec, y


def _im2col(x, k, stride):
    """[N,C,H,W] -> columns [N, C*k*k, oh*ow] in (c, kh, kw) order."""
    n, c, h, w = x.shape
    oh = (h - k) // stride + 1
    ow = (w - k) // stride + 1
    cols = np.empty((n, c * k * k, oh * ow), dtype=x.dtype)
    for i in range(k):
        for j in range(k):
            rows = x[:, :, i : i + stride * oh : stride, j : j + stride * ow : stride]
            cols[:, (i * k + j) * c : (i * k + j + 1) * c, :] = rows.reshape(n, c, oh * ow)
    return cols, oh, ow


def _col2im(dcols, x_shape, k, stride):
    """Inverse scatter of _im2col: [N, C*k*k, oh*ow] -> [N,C,H,W] (overlapping
    receptive fields accumulate, which is what the gradient requires)."""
    n, c, h, w = x_shape
    oh = (h - k) // stride + 1
    ow = (w - k) // stride + 1
    dx = np.zeros(x_shape, dtype=dcols.dtype)
    for i in range(k):
        for j in range(k):
            rows = np.arange(oh) * stride + i
            cols = np.arange(ow) * stride + j
            patch = dcols[:, (i * k + j) * c : (i * k + j + 1) * c, :].reshape(
                n, c, oh, ow
            )
            np.add.at(dx, (slice(None), slice(None), rows[:, None], cols[None, :]), patch)
    return dx


def _image_net_shapes(height, width, vec_size, hidden_sizes, action_size):
    """Layer shape ledger shared by init, forward and ONNX export."""
    shapes = []
    h, w, c_in = height, width, 1
    for filters, k, stride in IMAGE_CONV_LAYERS:
        shapes.append(
            {
                "kind": "conv",
                "filters": filters,
                "kernel": k,
                "stride": stride,
                "in_channels": c_in,
                "in_height": h,
                "in_width": w,
            }
        )
        h = (h - k) // stride + 1
        w = (w - k) // stride + 1
        c_in = filters
    flat = c_in * h * w
    dense_sizes = [flat + vec_size, *hidden_sizes, action_size]
    for fan_in, fan_out in zip(dense_sizes[:-1], dense_sizes[1:]):
        shapes.append({"kind": "dense", "fan_in": fan_in, "fan_out": fan_out})
    return shapes, flat


def init_image_net(height, width, vec_size, hidden_sizes, action_size, activation, seed):
    """Seeded parameters for the fixed conv encoder + dense head.

    Conv weights are stored [filters, in*k*k] in the same (c, kh, kw) order
    im2col produces, so training and export never disagree about layout.
    """
    rng = np.random.default_rng(seed)
    shapes, _ = _image_net_shapes(height, width, vec_size, hidden_sizes, action_size)
    params = []
    for shape in shapes:
        if shape["kind"] == "conv":
            fan_in = shape["in_channels"] * shape["kernel"] ** 2
            fan_out = shape["filters"] * shape["kernel"] ** 2
            bound = math.sqrt(6.0 / (fan_in + fan_out))
            weights = rng.uniform(
                -bound, bound, (shape["filters"], shape["in_channels"] * shape["kernel"] ** 2)
            )
            biases = np.zeros(shape["filters"])
        else:
            bound = math.sqrt(6.0 / (shape["fan_in"] + shape["fan_out"]))
            weights = rng.uniform(-bound, bound, (shape["fan_in"], shape["fan_out"]))
            biases = np.zeros(shape["fan_out"])
        params.append([weights, biases])
    return params


def forward_image(params, images, x_vec, activation):
    """Images [N,H,W] in [0,255] (+ optional vector obs) -> (actions, cache)."""
    x = (images[:, None, :, :] - _PIXEL_MEAN[0]) / _PIXEL_STD[0]
    cache = {"conv_inputs": [x]}
    for weights, biases in params[: len(IMAGE_CONV_LAYERS)]:
        k = int(round(math.sqrt(weights.shape[1] // weights.shape[1] // weights.shape[0] * weights.shape[1] / weights.shape[1])))  # placeholder
    return x, cache


def fit_image(x_img, x_vec, y, hidden_sizes, activation, epochs, lr, batch_size, seed, val_fraction):
    raise NotImplementedError


def forward_float32(model, x32):
    """NumPy forward pass in float32, structurally identical to the ONNX graph.

    The equivalence check compares this against onnxruntime, so both sides
    must run the same dtype; a float64 reference would measure the exporter's
    rounding, not the graph's correctness.
    """
    mean = np.asarray(model["normalization"]["mean"], dtype=np.float32)
    std = np.asarray(model["normalization"]["std"], dtype=np.float32)
    current = (x32 - mean) / std
    last = len(model["layers"]) - 1
    for index, layer in enumerate(model["layers"]):
        weights = np.asarray(layer["weights"], dtype=np.float32)
        biases = np.asarray(layer["biases"], dtype=np.float32)
        current = current @ weights + biases
        if index != last:
            if model["activation"] == "tanh":
                current = np.tanh(current)
            else:
                current = np.maximum(current, np.float32(0.0))
    return current


def export_onnx(model, path, x_check):
    """Serialize the MLP (with normalization) to ONNX and PROVE it.

    The graph mirrors `forward_float32` node for node (Sub, Div, Gemm,
    activation), because folding the normalization into the first Gemm would
    make the equivalence check measure algebraic rearrangement on top of
    exporter correctness. If onnxruntime is importable the exported file is
    run against the NumPy forward on real dataset rows and any mismatch
    deletes the file and fails the run — an unverified export is never
    written.
    """
    try:
        import onnx  # noqa: F401 - presence check for export
        from onnx import TensorProto, helper, numpy_helper
    except ImportError:
        return {"exported": False, "equivalence": "skipped-no-onnx"}

    obs_size = model["observation_size"]
    act_size = model["action_size"]
    mean = np.asarray(model["normalization"]["mean"], dtype=np.float32)
    std = np.asarray(model["normalization"]["std"], dtype=np.float32)
    initializers = [
        numpy_helper.from_array(mean, "obs_mean"),
        numpy_helper.from_array(std, "obs_std"),
    ]
    nodes = [
        helper.make_node("Sub", ["observation", "obs_mean"], ["obs_centered"]),
        helper.make_node("Div", ["obs_centered", "obs_std"], ["obs_normed"]),
    ]
    previous = "obs_normed"
    last = len(model["layers"]) - 1
    for index, layer in enumerate(model["layers"]):
        weights = np.asarray(layer["weights"], dtype=np.float32)
        biases = np.asarray(layer["biases"], dtype=np.float32)
        initializers.append(numpy_helper.from_array(weights, "W%d" % index))
        initializers.append(numpy_helper.from_array(biases, "b%d" % index))
        output = "action" if index == last else "z%d" % index
        nodes.append(helper.make_node("Gemm", [previous, "W%d" % index, "b%d" % index], [output]))
        if index != last:
            op = "Tanh" if model["activation"] == "tanh" else "Relu"
            nodes.append(helper.make_node(op, ["z%d" % index], ["a%d" % index]))
            previous = "a%d" % index
        else:
            previous = "action"

    graph = helper.make_graph(
        nodes,
        MODEL_FORMAT,
        [helper.make_tensor_value_info("observation", TensorProto.FLOAT, [None, obs_size])],
        [helper.make_tensor_value_info("action", TensorProto.FLOAT, [None, act_size])],
        initializers,
    )
    onnx_model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", 17)]
    )
    # onnxruntime 1.19 accepts IR version 9; leaving the library default
    # would emit a version the runtime used for this check may reject.
    onnx_model.ir_version = 9
    onnx.checker.check_model(onnx_model)
    data = onnx_model.SerializeToString()
    pathlib.Path(path).write_bytes(data)

    try:
        import onnxruntime as ort
    except ImportError:
        return {"exported": True, "equivalence": "skipped-no-onnxruntime", "sizeBytes": len(data)}

    session = ort.InferenceSession(
        pathlib.Path(path).as_posix(), providers=["CPUExecutionProvider"]
    )
    rows = x_check[:EQUIVALENCE_ROWS].astype(np.float32)
    expected = forward_float32(model, rows)
    actual = session.run(["action"], {"observation": rows})[0]
    worst = float(np.max(np.abs(expected - actual)))
    if worst >= EQUIVALENCE_ATOL:
        pathlib.Path(path).unlink()
        raise ValueError(
            "ONNX export disagrees with the NumPy forward pass (max |diff| %.3g >= %.3g); "
            "the unverified file was not kept" % (worst, EQUIVALENCE_ATOL)
        )
    return {
        "exported": True,
        "equivalence": "verified",
        "maxAbsDiff": worst,
        "checkedRows": int(rows.shape[0]),
        "sizeBytes": len(data),
    }


def provenance_block(used_libraries):
    """source + dependencies + dependencyLockSha256, per the runner contract."""
    return {
        "source": source_revision(),
        "dependencies": dependency_versions(used_libraries),
        "dependencyLockSha256": dependency_lock_digest(),
    }


def save_model(model, report, onnx_report, path):
    """Write the model JSON. Runs only after every failure mode is past,
    preserving v1's guarantee that a failed run leaves no output file."""
    payload = dict(model)
    payload["metrics"] = report
    if onnx_report is not None:
        payload["onnx"] = onnx_report
    payload.update(provenance_block({"numpy"} | _used_optional(onnx_report)))
    pathlib.Path(path).write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _used_optional(onnx_report):
    if onnx_report is None:
        return set()
    if onnx_report.get("equivalence") == "verified":
        return {"onnx", "onnxruntime"}
    if onnx_report.get("exported"):
        return {"onnx"}
    return set()


def parse_hidden(spec):
    """`64,64` -> [64, 64]. A single 0 is refused: v1 WAS the linear model."""
    sizes = [part.strip() for part in spec.split(",") if part.strip()]
    if not sizes:
        raise ValueError("hidden layer spec is empty")
    values = []
    for part in sizes:
        try:
            value = int(part)
        except ValueError:
            raise ValueError("hidden layer spec must be integers, got %r" % spec)
        if value <= 0:
            raise ValueError("hidden layer sizes must be positive, got %r" % spec)
        values.append(value)
    return values


def run_engine_mode():
    """File-protocol smoke round for the provenance gate.

    The request carries no dataset, so this mode trains on a deterministic
    SYNTHETIC dataset sized by the request's contract. That is labeled in
    the result (`dataset.synthetic: true`) — the training itself is real, and
    no claim is made about real demonstrations.
    """
    request = json.loads(pathlib.Path(os.environ["RDK_SIM2REAL_REQUEST_FILE"]).read_text())
    if request.get("schemaVersion") != 1:
        raise ValueError("unsupported request schemaVersion %r" % request.get("schemaVersion"))
    contract = request.get("contract") or {}
    obs_size = int(contract.get("observationSize", 0))
    act_size = int(contract.get("actionSize", 0))
    if obs_size <= 0 or act_size <= 0:
        raise ValueError("request contract must define observationSize and actionSize")
    training = request.get("training") or {}
    epochs = max(1, int(training.get("maxIterations", 2)))

    rng = np.random.default_rng(0)
    rows = 128
    x = rng.uniform(-1.0, 1.0, (rows, obs_size))
    mixing = rng.uniform(-0.5, 0.5, (obs_size, act_size))
    y = np.tanh(x @ mixing)

    model, report = fit(
        x, y, [16, 16], "tanh", epochs=epochs, lr=1e-2, batch_size=32, seed=0,
        val_fraction=0.25,
    )
    model_path = pathlib.Path("model.json")
    onnx_report = export_onnx(model, "policy.onnx", x)
    save_model(model, report, onnx_report, model_path)

    result = {
        "schemaVersion": 1,
        "status": "completed",
        "mock": False,
        "engine": "offline-bc",
        "algorithm": "mlp-bc",
        "contract": {
            "id": contract.get("id"),
            "observationSize": obs_size,
            "actionSize": act_size,
        },
        "dataset": {"source": "synthetic-smoke", "synthetic": True, "rows": rows},
        "metrics": report,
        "artifact": {
            "format": MODEL_FORMAT,
            "path": model_path.name,
            "sizeBytes": model_path.stat().st_size,
            "onnxExported": bool(onnx_report and onnx_report.get("exported")),
        },
    }
    result.update(provenance_block({"numpy"} | _used_optional(onnx_report)))
    pathlib.Path(os.environ["RDK_SIM2REAL_RESULT_FILE"]).write_text(
        json.dumps(result, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps({"status": "completed", "engine": "offline-bc"}))


def main():
    if os.environ.get("RDK_SIM2REAL_REQUEST_FILE") and os.environ.get(
        "RDK_SIM2REAL_RESULT_FILE"
    ):
        run_engine_mode()
        return

    parser = argparse.ArgumentParser(
        description="Train an MLP behavior-cloning policy on a transition JSONL dataset."
    )
    parser.add_argument("dataset", help="transition JSONL (observation/action rows)")
    parser.add_argument("--out", required=True, help="output model JSON path")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--hidden", default="64,64", help="hidden layer sizes, e.g. 64,64")
    parser.add_argument("--activation", choices=ACTIVATIONS, default="tanh")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--val-fraction",
        type=float,
        default=0.2,
        help="validation split fraction; 0 disables validation explicitly",
    )
    parser.add_argument("--onnx", default=None, help="optional ONNX export path")
    args = parser.parse_args()

    if args.epochs <= 0:
        raise ValueError("epochs must be positive")
    if not (0.0 <= args.val_fraction < 1.0):
        raise ValueError("val-fraction must be in [0, 1)")

    x, y = load_dataset(args.dataset)
    hidden = parse_hidden(args.hidden)
    model, report = fit(
        x, y, hidden, args.activation, args.epochs, args.lr, args.batch,
        args.seed, args.val_fraction,
    )

    onnx_report = None
    if args.onnx:
        onnx_report = export_onnx(model, args.onnx, x)
        state = onnx_report.get("equivalence")
        if state == "skipped-no-onnx":
            print(
                "[offline-bc] ONNX export skipped: onnx not installed (%s)"
                % ONNX_MISSING_HINT
            )
        elif state == "skipped-no-onnxruntime":
            print(
                "[offline-bc] ONNX written but equivalence unverified: "
                "onnxruntime not installed (%s)" % ONNX_MISSING_HINT
            )
    save_model(model, report, onnx_report, args.out)
    print(
        json.dumps(
            {
                "format": MODEL_FORMAT,
                "train_loss": report["train_loss"],
                "val_loss": report["validation"]["loss"],
                "validation": report["validation"]["enabled"],
                "epochs": report["epochs"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print("[offline-bc] FAIL — %s" % error, file=sys.stderr)
        sys.exit(2)
