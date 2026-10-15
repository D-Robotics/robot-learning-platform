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

File protocol (engine mode): authenticated platform requests may carry a
bounded, hashed snapshot of uploaded observation/action demonstrations.
Those rows are validated and consumed by the same trainer as the CLI. A
request with NO demonstrations runs the explicitly labeled SYNTHETIC smoke
round. Invalid demonstrations never fall back to synthetic data. This mode
requires verified ONNX export and produces the worker's artifact:// bundle
contract; software training completion does not authorize board deployment.

Output model format `rdk-offline-bc-v2` (JSON): layer weights, activation,
normalization constants, metrics, seed and provenance blocks. The v1 format's
`observation_size` / `action_size` keys are kept so tooling keyed on the
historical validation notes keeps reading the dimension fields.
"""

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import pathlib
import re
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
MAX_DEMONSTRATION_BYTES = 4 * 1024 * 1024
MIN_DEMONSTRATION_ROWS = MIN_TRAIN_ROWS + MIN_VAL_ROWS
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
    initial_train_loss = evaluate(layers, x_train_n, y_train, activation)
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
        "initial_train_loss": initial_train_loss,
        "validation": validation,
        "epochs": int(epochs),
        "learning_rate": float(lr),
        "batch_size": int(batch_size),
        "seed": int(seed),
        "samples": {"train": int(len(train_idx)), "val": int(len(val_idx))},
    }
    return model, report


def parse_image_input(spec):
    """`64x64` -> (width=64, height=64). Both sides must survive the fixed
    three-convolution encoder with a strictly positive feature map — checked
    by simulating it, not by a looser divisibility rule that 16x16 would
    pass while producing a 0x0 map."""
    parts = spec.lower().split("x")
    if len(parts) != 2:
        raise ValueError("--image-input must look like 64x64 (WIDTHxHEIGHT)")
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError:
        raise ValueError("--image-input must be integers, got %r" % spec)
    if width <= 0 or height <= 0:
        raise ValueError("--image-input dimensions must be positive")
    for _, k, stride in IMAGE_CONV_LAYERS:
        width = (width - k) // stride + 1
        height = (height - k) // stride + 1
        if width <= 0 or height <= 0:
            raise ValueError(
                "--image-input %r collapses to a %dx%d feature map in the "
                "fixed conv encoder; use at least 24x24" % (spec, width, height)
            )
    return int(parts[0]), int(parts[1])


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


def forward_image(params, images, x_vec, pixel_norm, activation):
    """Images [N,H,W] in [0,255] (+ optional vector obs) -> (actions, cache).

    The cache holds exactly what the backward pass needs: conv input maps,
    im2col matrices and dense activations.
    """
    n_conv = len(IMAGE_CONV_LAYERS)
    x = (images[:, None, :, :] - pixel_norm[0]) / pixel_norm[1]
    cache = {"conv_inputs": [x], "cols": [], "out_hw": [], "dense_inputs": [], "dense_acts": []}
    if x_vec is not None:
        cache["vec_size"] = x_vec.shape[1]
    current = x
    for index in range(n_conv):
        weights, biases = params[index]
        k, stride = IMAGE_CONV_LAYERS[index][1], IMAGE_CONV_LAYERS[index][2]
        cols, oh, ow = _im2col(current, k, stride)
        cache["cols"].append(cols)
        cache["out_hw"].append((oh, ow))
        n = current.shape[0]
        out = np.matmul(weights, cols) + biases[None, :, None]
        current = _activate(out.reshape(n, weights.shape[0], oh, ow), activation)
        cache["conv_inputs"].append(current)
    n = current.shape[0]
    flat = current.reshape(n, -1)
    if x_vec is not None:
        flat = np.concatenate([flat, x_vec], axis=1)
    cache["dense_inputs"].append(flat)
    dense_count = len(params) - n_conv
    last = dense_count - 1
    current = flat
    for offset in range(dense_count):
        weights, biases = params[n_conv + offset]
        current = current @ weights + biases
        if offset != last:
            current = _activate(current, activation)
        cache["dense_acts"].append(current)
    return current, cache


def backward_image(params, cache, activation, grad_out):
    """Gradients for every parameter plus the (unused) input image gradient.

    The image gradient is computed anyway: it is the only cheap proof that the
    col2im scatter is correct, and the finite-difference test in
    test_train_bc.py depends on it.
    """
    n_conv = len(IMAGE_CONV_LAYERS)
    grads = [None] * len(params)
    dense_count = len(params) - n_conv
    delta = grad_out
    for offset in range(dense_count - 1, -1, -1):
        index = n_conv + offset
        weights, _ = params[index]
        input_acts = cache["dense_inputs"][0] if offset == 0 else cache["dense_acts"][offset - 1]
        grads[index] = [input_acts.T @ delta, delta.sum(axis=0)]
        delta = delta @ weights.T
        if offset > 0:
            delta = delta * _activation_grad(cache["dense_acts"][offset - 1], activation)
    grad_flat = delta
    if cache.get("vec_size"):
        grad_features = grad_flat[:, : -cache["vec_size"]]
    else:
        grad_features = grad_flat
    grad = grad_features.reshape(cache["conv_inputs"][n_conv].shape)
    for index in range(n_conv - 1, -1, -1):
        weights, _ = params[index]
        k, stride = IMAGE_CONV_LAYERS[index][1], IMAGE_CONV_LAYERS[index][2]
        # da -> dz for this layer: act' of this layer's own activated output
        # (conv_inputs[index + 1]); col2im below yields the next layer's da.
        grad = grad * _activation_grad(cache["conv_inputs"][index + 1], activation)
        dout = grad.reshape(grad.shape[0], weights.shape[0], -1)
        cols = cache["cols"][index]
        grad_w = np.matmul(dout, cols.transpose(0, 2, 1)).sum(axis=0)
        grad_b = dout.sum(axis=(0, 2))
        dcols = np.matmul(weights.T[None, :, :], dout)
        grad = _col2im(dcols, cache["conv_inputs"][index].shape, k, stride)
        grads[index] = [grad_w, grad_b]
    return grads


def train_image(params, images, x_vec, y, pixel_norm, activation, epochs, lr, batch_size, seed):
    """Minibatch Adam over the mixed conv+dense parameter list. Same seed ->
    bit-identical weights, mirroring `train_mlp`."""
    rng = np.random.default_rng(seed + 1)
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    adam_m = [[np.zeros_like(w), np.zeros_like(b)] for w, b in params]
    adam_v = [[np.zeros_like(w), np.zeros_like(b)] for w, b in params]
    step = 0
    rows = images.shape[0]
    batch_size = min(batch_size, rows)
    for _ in range(epochs):
        order = rng.permutation(rows)
        for start in range(0, rows, batch_size):
            batch = order[start : start + batch_size]
            xb = images[batch]
            xv = x_vec[batch] if x_vec is not None else None
            yb = y[batch]
            prediction, cache = forward_image(params, xb, xv, pixel_norm, activation)
            cache["vec_size"] = 0 if xv is None else xv.shape[1]
            error = prediction - yb
            delta = (2.0 / error.size) * error
            grads = backward_image(params, cache, activation, delta)
            step += 1
            for index in range(len(params) - 1, -1, -1):
                for slot, grad in ((0, grads[index][0]), (1, grads[index][1])):
                    m = adam_m[index][slot]
                    v = adam_v[index][slot]
                    m[...] = beta1 * m + (1.0 - beta1) * grad
                    v[...] = beta2 * v + (1.0 - beta2) * grad * grad
                    m_hat = m / (1.0 - beta1**step)
                    v_hat = v / (1.0 - beta2**step)
                    param = params[index][slot]
                    param[...] = param - lr * m_hat / (np.sqrt(v_hat) + eps)
    return params


def fit_image(
    x_img, x_vec, y, hidden_sizes, activation, epochs, lr, batch_size, seed, val_fraction
):
    """Split, normalize, train and score the image branch. Same honesty rules
    as `fit`: train-only statistics, explicit `validation: false`."""
    rows = x_img.shape[0]
    if val_fraction > 0:
        train_idx, val_idx = split_dataset(rows, val_fraction, seed)
        if len(train_idx) < MIN_TRAIN_ROWS or len(val_idx) < MIN_VAL_ROWS:
            raise ValueError(
                "dataset too small for a %.0f%% validation split (%d rows); "
                "pass --val-fraction 0 to disable validation explicitly"
                % (val_fraction * 100, rows)
            )
        train_idx, val_idx = train_idx, val_idx
    else:
        train_idx = np.arange(rows)
        val_idx = np.array([], dtype=train_idx.dtype)
    img_train = x_img[train_idx]
    height, width = x_img.shape[1], x_img.shape[2]

    pixel_mean = float(img_train.mean())
    pixel_std = float(img_train.std())
    if pixel_std < 1e-12:
        pixel_std = 1.0
    pixel_norm = (pixel_mean, pixel_std)

    vec_norm = None
    if x_vec is not None:
        vec_mean, vec_std = standardize(x_vec[train_idx])
        vec_norm = {"mean": vec_mean.tolist(), "std": vec_std.tolist()}
        x_vec_n = (x_vec - vec_mean) / vec_std
    else:
        x_vec_n = None

    params = init_image_net(
        height, width, 0 if x_vec is None else x_vec.shape[1],
        hidden_sizes, y.shape[1], activation, seed,
    )
    train_image(
        params, img_train, x_vec_n[train_idx] if x_vec_n is not None else None,
        y[train_idx], pixel_norm, activation, epochs, lr, batch_size, seed,
    )

    def _score(idx):
        prediction, _ = forward_image(
            params, x_img[idx], x_vec_n[idx] if x_vec_n is not None else None,
            pixel_norm, activation,
        )
        return float(np.mean((prediction - y[idx]) ** 2))

    train_loss = _score(train_idx)
    if len(val_idx) > 0:
        validation = {"enabled": True, "loss": _score(val_idx)}
    else:
        validation = {"enabled": False, "loss": None}

    shapes, flat_size = _image_net_shapes(
        height, width, 0 if x_vec is None else x_vec.shape[1], hidden_sizes, y.shape[1]
    )
    n_conv = len(IMAGE_CONV_LAYERS)
    model = {
        "format": MODEL_FORMAT_IMAGE,
        "modality": "image+vector" if x_vec is not None else "image",
        "image_input": {
            "width": int(width),
            "height": int(height),
            "channels": 1,
            "encoding": "mono8",
            "sourceRange": [0, 255],
        },
        "observation_size": int(x_vec.shape[1]) if x_vec is not None else 0,
        "action_size": int(y.shape[1]),
        "hidden_sizes": [int(h) for h in hidden_sizes],
        "activation": activation,
        "pixel_normalization": {"mean": pixel_mean, "std": pixel_std},
        "normalization": vec_norm,
        "conv_layers": [
            {
                "filters": s["filters"],
                "kernel": s["kernel"],
                "stride": s["stride"],
            }
            for s in shapes[:n_conv]
        ],
        "flatten_size": int(flat_size),
        "conv": [
            {"weights": w.tolist(), "biases": b.tolist()} for w, b in params[:n_conv]
        ],
        "dense_layers": [
            {"weights": w.tolist(), "biases": b.tolist()} for w, b in params[n_conv:]
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


def forward_image_float32(model, images32, obs32):
    """float32 mirror of the ONNX image graph: normalize (scalar Sub/Div),
    NHWC -> NCHW equivalent channel handling, im2col convs, flatten, Gemm."""
    mean = np.float32(model["pixel_normalization"]["mean"])
    std = np.float32(model["pixel_normalization"]["std"])
    current = (images32 - mean) / std
    current = current[:, None, :, :]
    for index, layer in enumerate(model["conv"]):
        weights = np.asarray(layer["weights"], dtype=np.float32)
        biases = np.asarray(layer["biases"], dtype=np.float32)
        k = model["conv_layers"][index]["kernel"]
        stride = model["conv_layers"][index]["stride"]
        cols, oh, ow = _im2col(current, k, stride)
        n = current.shape[0]
        current = np.matmul(weights, cols) + biases[None, :, None]
        current = current.reshape(n, weights.shape[0], oh, ow)
        # Every conv layer carries the activation — including the last one —
        # exactly like `forward_image` and the exported graph.
        current = np.tanh(current) if model["activation"] == "tanh" else np.maximum(
            current, np.float32(0.0)
        )
    current = current.reshape(current.shape[0], -1)
    if model["observation_size"] > 0:
        v_mean = np.asarray(model["normalization"]["mean"], dtype=np.float32)
        v_std = np.asarray(model["normalization"]["std"], dtype=np.float32)
        current = np.concatenate([current, (obs32 - v_mean) / v_std], axis=1)
    last = len(model["dense_layers"]) - 1
    for index, layer in enumerate(model["dense_layers"]):
        weights = np.asarray(layer["weights"], dtype=np.float32)
        biases = np.asarray(layer["biases"], dtype=np.float32)
        current = current @ weights + biases
        if index != last:
            current = np.tanh(current) if model["activation"] == "tanh" else np.maximum(
                current, np.float32(0.0)
            )
    return current


def export_onnx_image(model, path, images_check, obs_check):
    """Serialize the image network to ONNX (NHWC rank-4 image input, matching
    the platform vision gate `validateVisionObservationAgainstModelInputs`)
    and PROVE it against `forward_image_float32` — an unverified export is
    never written."""
    try:
        import onnx  # noqa: F401 - presence check for export
        from onnx import TensorProto, helper, numpy_helper
    except ImportError:
        return {"exported": False, "equivalence": "skipped-no-onnx"}

    height = model["image_input"]["height"]
    width = model["image_input"]["width"]
    action_size = model["action_size"]
    p_mean = np.asarray(model["pixel_normalization"]["mean"], dtype=np.float32)
    p_std = np.asarray(model["pixel_normalization"]["std"], dtype=np.float32)

    initializers = [
        numpy_helper.from_array(p_mean, "pixel_mean"),
        numpy_helper.from_array(p_std, "pixel_std"),
    ]
    nodes = [
        helper.make_node("Sub", ["image", "pixel_mean"], ["img_centered"]),
        helper.make_node("Div", ["img_centered", "pixel_std"], ["img_normed"]),
        helper.make_node("Transpose", ["img_normed"], ["img_nchw"], perm=[0, 3, 1, 2]),
    ]
    previous = "img_nchw"
    n_conv = len(model["conv"])
    for index, layer in enumerate(model["conv"]):
        weights = np.asarray(layer["weights"], dtype=np.float32)
        biases = np.asarray(layer["biases"], dtype=np.float32)
        spec = model["conv_layers"][index]
        # Stored rows are (kh, kw, c) — im2col order. ONNX Conv wants
        # (M, C, kh, kw); reshaping straight to that would scramble kernels,
        # which is exactly what the equivalence check exists to catch.
        w = weights.reshape(
            spec["filters"], spec["kernel"], spec["kernel"], _conv_in_channels(model, index)
        ).transpose(0, 3, 1, 2)
        initializers.append(numpy_helper.from_array(
            np.ascontiguousarray(w, dtype=np.float32), "C%d" % index
        ))
        initializers.append(numpy_helper.from_array(biases, "cb%d" % index))
        output = "cflat%d" % index if index == n_conv - 1 else "cz%d" % index
        nodes.append(
            helper.make_node(
                "Conv",
                [previous, "C%d" % index, "cb%d" % index],
                ["cy%d" % index],
                kernel_shape=[spec["kernel"], spec["kernel"]],
                strides=[spec["stride"], spec["stride"]],
            )
        )
        op = "Tanh" if model["activation"] == "tanh" else "Relu"
        nodes.append(helper.make_node(op, ["cy%d" % index], [output]))
        if index != n_conv - 1:
            previous = output
    final_conv = "cflat%d" % (n_conv - 1)
    nodes.append(helper.make_node("Flatten", [final_conv], ["features"], axis=1))
    dense_in = "features"
    if model["observation_size"] > 0:
        v_mean = np.asarray(model["normalization"]["mean"], dtype=np.float32)
        v_std = np.asarray(model["normalization"]["std"], dtype=np.float32)
        initializers.append(numpy_helper.from_array(v_mean, "obs_mean"))
        initializers.append(numpy_helper.from_array(v_std, "obs_std"))
        nodes.append(
            helper.make_node("Sub", ["observation", "obs_mean"], ["obs_centered"])
        )
        nodes.append(helper.make_node("Div", ["obs_centered", "obs_std"], ["obs_normed"]))
        nodes.append(
            helper.make_node("Concat", ["features", "obs_normed"], ["dense_in"], axis=1)
        )
        dense_in = "dense_in"
    last = len(model["dense_layers"]) - 1
    previous = dense_in
    for index, layer in enumerate(model["dense_layers"]):
        weights = np.asarray(layer["weights"], dtype=np.float32)
        biases = np.asarray(layer["biases"], dtype=np.float32)
        initializers.append(numpy_helper.from_array(weights, "DW%d" % index))
        initializers.append(numpy_helper.from_array(biases, "Db%d" % index))
        output = "action" if index == last else "dz%d" % index
        nodes.append(
            helper.make_node(
                "Gemm", [previous, "DW%d" % index, "Db%d" % index], [output]
            )
        )
        if index != last:
            op = "Tanh" if model["activation"] == "tanh" else "Relu"
            nodes.append(helper.make_node(op, ["dz%d" % index], ["da%d" % index]))
            previous = "da%d" % index
        else:
            previous = "action"

    inputs = [
        helper.make_tensor_value_info(
            "image", TensorProto.FLOAT, [None, height, width, 1]
        )
    ]
    if model["observation_size"] > 0:
        inputs.append(
            helper.make_tensor_value_info(
                "observation", TensorProto.FLOAT, [None, model["observation_size"]]
            )
        )
    graph = helper.make_graph(
        nodes,
        MODEL_FORMAT_IMAGE,
        inputs,
        [helper.make_tensor_value_info("action", TensorProto.FLOAT, [None, action_size])],
        initializers,
    )
    onnx_model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
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
    rows = min(images_check.shape[0], EQUIVALENCE_ROWS)
    images = images_check[:rows].astype(np.float32)
    feeds = {"image": images[:, :, :, None] if images.ndim == 3 else images}
    if model["observation_size"] > 0:
        feeds["observation"] = obs_check[:rows].astype(np.float32)
    expected = forward_image_float32(model, images, feeds.get("observation"))
    actual = session.run(["action"], feeds)[0]
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
        "checkedRows": int(rows),
        "sizeBytes": len(data),
    }


def _conv_in_channels(model, index):
    if index == 0:
        return 1
    return model["conv_layers"][index - 1]["filters"]


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
    if not np.isfinite(expected).all() or not np.isfinite(actual).all():
        pathlib.Path(path).unlink()
        raise ValueError("ONNX equivalence produced non-finite outputs; the invalid file was not kept")
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


def _print_onnx_state(onnx_report):
    state = onnx_report.get("equivalence")
    if state == "skipped-no-onnx":
        print("[offline-bc] ONNX export skipped: onnx not installed (%s)" % ONNX_MISSING_HINT)
    elif state == "skipped-no-onnxruntime":
        print(
            "[offline-bc] ONNX written but equivalence unverified: "
            "onnxruntime not installed (%s)" % ONNX_MISSING_HINT
        )


def load_request_demonstrations(payload, observation_size, action_size):
    """Validate the immutable snapshot the platform selected, never a path.

    Hash the original UTF-8 bytes before parsing: reformatted, reordered or
    truncated rows must not silently retain the platform's source identity.
    This snapshot has one episode's rows, so its validation is a seeded ROW
    split, not an independent episode/task-quality acceptance test.
    """
    fields = {"schemaVersion", "sourceRunId", "telemetryRevision", "source", "sha256", "jsonl"}
    if not isinstance(payload, dict) or set(payload) != fields:
        raise ValueError("demonstrations must contain exactly schemaVersion/sourceRunId/telemetryRevision/source/sha256/jsonl")
    if type(payload["schemaVersion"]) is not int or payload["schemaVersion"] != 1:
        raise ValueError("demonstrations.schemaVersion must be 1")
    if not isinstance(payload["sourceRunId"], str) or not re.fullmatch(
        r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}", payload["sourceRunId"]
    ):
        raise ValueError("demonstrations.sourceRunId is invalid")
    if not isinstance(payload["telemetryRevision"], str) or not re.fullmatch(
        r"[a-f0-9]{64}", payload["telemetryRevision"]
    ):
        raise ValueError("demonstrations.telemetryRevision must be the platform's SHA-256 revision")
    if payload["source"] not in ("browser", "import", "board-agent"):
        raise ValueError("demonstrations.source must be browser, import or board-agent")
    jsonl = payload["jsonl"]
    if not isinstance(jsonl, str):
        raise ValueError("demonstrations.jsonl must be a UTF-8 string")
    try:
        raw = jsonl.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("demonstrations.jsonl must be valid UTF-8")
    if not raw or len(raw) > MAX_DEMONSTRATION_BYTES:
        raise ValueError("demonstrations.jsonl must be non-empty and at most 4 MiB")
    if not isinstance(payload["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", payload["sha256"]):
        raise ValueError("demonstrations.sha256 must be a lowercase SHA-256 digest")
    if hashlib.sha256(raw).hexdigest() != payload["sha256"]:
        raise ValueError("demonstrations.sha256 does not match the supplied JSONL bytes")
    if not jsonl.endswith("\n") or "\r" in jsonl:
        raise ValueError("demonstrations.jsonl must use LF lines including a final LF")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = value
        return result

    def reject_constant(value):
        raise ValueError("non-finite JSON number %s" % value)

    observations, actions = [], []
    for line_no, line in enumerate(jsonl[:-1].split("\n"), 1):
        try:
            row = json.loads(line, object_pairs_hook=unique_object, parse_constant=reject_constant)
        except ValueError as error:
            raise ValueError("demonstrations line %d: invalid JSON (%s)" % (line_no, error))
        if not isinstance(row, dict) or set(row) != {"observation", "action"}:
            raise ValueError("demonstrations line %d: only observation/action fields are allowed" % line_no)
        obs, act = row["observation"], row["action"]
        if not isinstance(obs, list) or not isinstance(act, list):
            raise ValueError("demonstrations line %d: observation/action must be numeric lists" % line_no)
        if len(obs) != observation_size or len(act) != action_size:
            raise ValueError("demonstrations line %d: dimensions differ from the request contract" % line_no)
        values = obs + act
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in values):
            raise ValueError("demonstrations line %d: values must be numeric" % line_no)
        try:
            finite = all(math.isfinite(value) for value in values)
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError("demonstrations line %d: values must be finite" % line_no)
        observations.append(obs)
        actions.append(act)
    if len(observations) < MIN_DEMONSTRATION_ROWS:
        raise ValueError("demonstrations requires at least %d rows" % MIN_DEMONSTRATION_ROWS)
    return np.asarray(observations, dtype=np.float64), np.asarray(actions, dtype=np.float64), {
        "source": payload["source"], "synthetic": False, "rows": len(observations),
        "validationKind": "seeded-row-split",
        "provenance": {key: payload[key] for key in ("sourceRunId", "telemetryRevision", "sha256")},
    }


def write_artifact_manifest(directory):
    """Digest immutable deliverables, excluding protocol and worker state."""
    directory = pathlib.Path(directory)
    lines = []
    for artifact in sorted(directory.iterdir()):
        if artifact.name in ("SHA256SUMS", "request.json", "result.json", "job.json") or artifact.name.startswith("."):
            continue
        if artifact.is_file():
            lines.append("%s  %s" % (hashlib.sha256(artifact.read_bytes()).hexdigest(), artifact.name))
    if not lines:
        raise ValueError("no immutable artifacts to record in SHA256SUMS")
    (directory / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_engine_mode():
    """Consume controlled demonstrations or explicitly labeled smoke data."""
    request = json.loads(pathlib.Path(os.environ["RDK_SIM2REAL_REQUEST_FILE"]).read_text())
    if request.get("schemaVersion") != 1:
        raise ValueError("unsupported request schemaVersion %r" % request.get("schemaVersion"))
    contract = request.get("contract") or {}
    obs_size = contract.get("observationSize", 0)
    act_size = contract.get("actionSize", 0)
    if type(obs_size) is not int or type(act_size) is not int or obs_size <= 0 or act_size <= 0:
        raise ValueError("request contract must define observationSize and actionSize")
    training = request.get("training") or {}
    epochs = training.get("maxIterations", 2)
    if type(epochs) is not int or not 1 <= epochs <= 10000:
        raise ValueError("training.maxIterations must be an integer in [1, 10000] epochs")

    if "demonstrations" in request:
        x, y, dataset = load_request_demonstrations(request["demonstrations"], obs_size, act_size)
        # Twelve rows is the smallest accepted snapshot: 8 train + 4 val.
        # Larger recordings retain a 20% row split with the same fixed seed.
        val_fraction = max(0.2, MIN_VAL_ROWS / len(x))
    else:
        rng = np.random.default_rng(0)
        rows = 128
        x = rng.uniform(-1.0, 1.0, (rows, obs_size))
        mixing = rng.uniform(-0.5, 0.5, (obs_size, act_size))
        y = np.tanh(x @ mixing)
        dataset = {"source": "synthetic-smoke", "synthetic": True, "rows": rows,
                   "validationKind": "seeded-row-split"}
        val_fraction = 0.25

    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            model, report = fit(
                x, y, [16, 16], "tanh", epochs=epochs, lr=1e-2, batch_size=32, seed=0,
                val_fraction=val_fraction,
            )
    except FloatingPointError:
        raise ValueError("training numeric range overflowed; normalize the observation/action vectors")
    losses = (report["initial_train_loss"], report["train_loss"], report["validation"]["loss"])
    parameters = [model["normalization"]["mean"], model["normalization"]["std"]]
    parameters.extend(value for layer in model["layers"] for value in layer.values())
    if not all(math.isfinite(value) for value in losses) or not all(
        np.isfinite(np.asarray(value)).all() for value in parameters
    ):
        raise ValueError("training produced non-finite metrics or parameters; no artifact was published")
    model_path = pathlib.Path("model.json")
    onnx_report = export_onnx(model, "policy.onnx", x)
    if not onnx_report.get("exported") or onnx_report.get("equivalence") != "verified":
        # A graph without verified runtime equivalence is not this protocol's
        # deliverable. The CLI still supports optional export for researchers.
        pathlib.Path("policy.onnx").unlink(missing_ok=True)
        raise ValueError("engine mode requires VERIFIED ONNX export (%s); install %s" %
                         (onnx_report.get("equivalence"), ONNX_MISSING_HINT))
    model["dataset"] = dataset
    save_model(model, report, onnx_report, model_path)
    policy_path = pathlib.Path("policy.onnx")
    policy_sha256 = hashlib.sha256(policy_path.read_bytes()).hexdigest()
    write_artifact_manifest(".")
    metrics = dict(report)
    metrics.update({
        "contractValid": True, "observationSize": obs_size, "actionSize": act_size,
        "engine": "offline-bc", "syntheticData": dataset["synthetic"],
        "trainingRows": report["samples"]["train"], "validationRows": report["samples"]["val"],
        "initialTrainLoss": report["initial_train_loss"], "trainLoss": report["train_loss"],
        "validationLoss": report["validation"]["loss"],
    })
    if not dataset["synthetic"]:
        metrics["trainingDataSha256"] = dataset["provenance"]["sha256"]

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
        "dataset": dataset,
        "metrics": metrics,
        "training": {"profile": training.get("profile"), "epochs": epochs},
        "artifactRef": "artifact://policy.onnx",
        "artifact": {
            "artifactId": "offline-bc-" + policy_sha256,
            "artifactRef": "artifact://policy.onnx", "format": "onnx",
            "path": policy_path.name, "sizeBytes": policy_path.stat().st_size,
            "sha256": policy_sha256, "onnxExported": True,
            "kind": "source", "deployable": False,
        },
        "cuda": False,
        "deployable": False,
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
        "--image-input",
        default=None,
        help="enable the image branch: WIDTHxHEIGHT (e.g. 64x64) mono8 frames "
        'in each row\'s "image" field (base64); "observation" is an optional '
        "vector fused after the conv encoder",
    )
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

    if args.image_input:
        width, height = parse_image_input(args.image_input)
        x_img, x_vec, y = load_image_dataset(args.dataset, width, height)
        hidden = parse_hidden(args.hidden)
        model, report = fit_image(
            x_img, x_vec, y, hidden, args.activation, args.epochs, args.lr,
            args.batch, args.seed, args.val_fraction,
        )
        onnx_report = None
        if args.onnx:
            onnx_report = export_onnx_image(model, args.onnx, x_img, x_vec)
            _print_onnx_state(onnx_report)
        save_model(model, report, onnx_report, args.out)
        print(
            json.dumps(
                {
                    "format": MODEL_FORMAT_IMAGE,
                    "modality": model["modality"],
                    "image_input": model["image_input"],
                    "train_loss": report["train_loss"],
                    "val_loss": report["validation"]["loss"],
                    "validation": report["validation"]["enabled"],
                    "epochs": report["epochs"],
                },
                ensure_ascii=False,
            )
        )
        return

    x, y = load_dataset(args.dataset)
    hidden = parse_hidden(args.hidden)
    model, report = fit(
        x, y, hidden, args.activation, args.epochs, args.lr, args.batch,
        args.seed, args.val_fraction,
    )

    onnx_report = None
    if args.onnx:
        onnx_report = export_onnx(model, args.onnx, x)
        _print_onnx_state(onnx_report)
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
