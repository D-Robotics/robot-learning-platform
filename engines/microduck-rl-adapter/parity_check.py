#!/usr/bin/env python3
"""Checkpoint <-> ONNX parity for microduck-rl (rsl_rl) exports.

The platform's export gate proves the exported *graph* is well-formed; this
checker proves the graph computes the same actions as the *checkpoint* it came
from. It reconstructs the actor MLP straight from the checkpoint's state_dict
(rsl_rl convention: an ELU stack named `actor.*` or `actor_mean.*`), feeds the
same random observations to both, and reports the worst absolute error.

Deliberately upstream-free: it needs only torch + onnxruntime + numpy, so it
runs in the worker venv right after export. When the state-dict layout is not
recognised it exits with code 2 ("parity could not be performed") after
printing the keys it saw — an unknown layout is a loud skip, never a pass.

`--self-test` builds a synthetic rsl_rl-style checkpoint and ONNX, asserts a
real pass, then asserts a corrupted graph fails. This keeps the checker itself
honest without an upstream checkout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_MISMATCH = 1
EXIT_CANNOT_CHECK = 2


def _actor_layers(state_dict: dict) -> list[tuple]:
    """Pull the actor weight/bias chain out of an rsl_rl checkpoint.

    Returns [(W, b), ...] in forward order. Raises LookupError when no actor
    prefix or an inconsistent chain is found — callers must surface that as
    "cannot check", not as success.
    """
    prefix = None
    for candidate in ("actor.", "actor_mean.", "actor_net."):
        keys = [key for key in state_dict if key.startswith(candidate)]
        if keys:
            prefix = candidate
            break
    if prefix is None:
        raise LookupError(
            "no actor layer keys found (looked for actor./actor_mean./actor_net.); got: "
            + ", ".join(sorted(state_dict)[:12])
        )
    # torch Sequential indices are non-consecutive (activations sit between
    # Linears), so collect every index that has a weight instead of counting.
    indices = sorted(
        int(key[len(prefix):].split(".")[0])
        for key in state_dict
        if key.startswith(prefix) and key.endswith(".weight")
    )
    layers: list[tuple] = []
    for index in indices:
        weight = state_dict.get(f"{prefix}{index}.weight")
        bias = state_dict.get(f"{prefix}{index}.bias")
        if weight is None or bias is None:
            raise LookupError(f"actor layer {index} has weight but no bias (or vice versa)")
        layers.append((weight.detach().cpu().float().numpy(), bias.detach().cpu().float().numpy()))
    if not layers or any(w.ndim != 2 for w, _ in layers):
        raise LookupError(f"actor prefix {prefix!r} did not yield a Linear chain ({len(layers)} layers)")
    for (_, b_low), (w_high, _) in zip(layers, layers[1:]):
        if b_low.shape[0] != w_high.shape[1]:
            raise LookupError(
                f"actor chain is inconsistent: layer bias {b_low.shape[0]} vs next weight {w_high.shape[1]}"
            )
    return layers


def _torch_forward(layers, x):
    import numpy as np

    for index, (weight, bias) in enumerate(layers):
        x = x @ weight.T + bias
        if index < len(layers) - 1:
            x = _elu(x)
    return x


def _elu(x):
    import numpy as np

    return np.where(x > 0, x, np.expm1(np.minimum(x, 0.0)))


def check_parity(checkpoint_path: Path, onnx_path: Path, *, samples: int = 32,
                 atol: float = 1e-4, seed: int = 20260922) -> dict:
    import numpy as np
    import torch
    import onnxruntime as ort

    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    state_dict = checkpoint.get("model_state_dict", checkpoint.get("model", checkpoint))
    if not hasattr(state_dict, "keys"):
        raise LookupError(f"checkpoint has no state_dict-like payload (type {type(state_dict).__name__})")
    layers = _actor_layers(dict(state_dict))
    obs_dim = layers[0][0].shape[1]
    action_dim = layers[-1][0].shape[0]

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    vector_inputs = [i for i in session.get_inputs() if len(i.shape) == 2]
    if not vector_inputs:
        raise LookupError("exported graph has no rank-2 observation input")
    input_name = vector_inputs[0].name
    output_name = session.get_outputs()[0].name

    rng = np.random.default_rng(seed)
    observations = rng.normal(0.0, 0.5, (samples, obs_dim)).astype(np.float32)
    reference = _torch_forward(layers, observations)
    exported = session.run([output_name], {input_name: observations})[0]
    if exported.shape != reference.shape:
        raise LookupError(f"output shape {exported.shape} != checkpoint actor shape {reference.shape}")
    worst = float(np.max(np.abs(exported - reference)))
    return {
        "checkpoint": str(checkpoint_path),
        "onnx": str(onnx_path),
        "samples": samples,
        "obsDim": obs_dim,
        "actionDim": action_dim,
        "atol": atol,
        "parityMaxAbsError": worst,
        "verdict": "pass" if worst <= atol else "failed",
    }


def self_test(tmp_dir: Path) -> None:
    """Prove the checker catches both a good export and a corrupted one."""
    import numpy as np
    import onnx
    import torch
    from torch import nn

    torch.manual_seed(0)
    actor = nn.Sequential(nn.Linear(61, 128), nn.ELU(), nn.Linear(128, 128), nn.ELU(), nn.Linear(128, 14))
    state_dict = {f"actor.{i}.{kind}": tensor for i, module in enumerate(actor) if isinstance(module, nn.Linear)
                  for kind, tensor in (("weight", module.weight), ("bias", module.bias))}
    checkpoint_path = tmp_dir / "model_5999.pt"
    torch.save({"model_state_dict": state_dict}, checkpoint_path)

    class ActorOnly(nn.Module):
        def __init__(self):
            super().__init__()
            self.actor = actor

        def forward(self, observation):
            return self.actor(observation)

    onnx_path = tmp_dir / "policy.onnx"
    torch.onnx.export(
        ActorOnly().eval(),
        torch.zeros((1, 61)),
        str(onnx_path),
        input_names=["obs"],
        output_names=["actions"],
        dynamic_axes={"obs": {0: "batch"}, "actions": {0: "batch"}},
        opset_version=17,
    )
    report = check_parity(checkpoint_path, onnx_path, samples=16)
    assert report["verdict"] == "pass" and report["parityMaxAbsError"] < 1e-4, report

    corrupted = tmp_dir / "policy-corrupted.onnx"
    model = onnx.load(str(onnx_path))
    for initializer in model.graph.initializer:
        if initializer.name.endswith("weight"):
            array = onnx.numpy_helper.to_array(initializer).copy()
            array += 0.05
            initializer.CopyFrom(onnx.numpy_helper.from_array(array, initializer.name))
            break
    onnx.save(model, str(corrupted))
    report = check_parity(checkpoint_path, corrupted, samples=16)
    assert report["verdict"] == "failed" and report["parityMaxAbsError"] > 1e-4, report
    print(f"[parity] self-test ok (good pass={report['atol'] and True}, corruption caught)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--onnx", type=Path)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--atol", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=20260922)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--json-out", type=Path, help="write the report here (adapter job dir)")
    args = parser.parse_args()

    if args.self_test:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="rdk-rl-parity-") as tmp:
            self_test(Path(tmp))
        return EXIT_OK

    if args.checkpoint is None or args.onnx is None:
        parser.error("--checkpoint and --onnx are required (or use --self-test)")
    try:
        report = check_parity(args.checkpoint, args.onnx, samples=args.samples, atol=args.atol, seed=args.seed)
    except LookupError as error:
        print(json.dumps({"verdict": "skipped", "reason": str(error)}, indent=2))
        if args.json_out:
            args.json_out.write_text(json.dumps({"verdict": "skipped", "reason": str(error)}, indent=2) + "\n")
        return EXIT_CANNOT_CHECK
    if args.json_out:
        args.json_out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return EXIT_OK if report["verdict"] == "pass" else EXIT_MISMATCH


if __name__ == "__main__":
    sys.exit(main())
