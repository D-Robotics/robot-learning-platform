#!/usr/bin/env python3
"""Post-export gate for the adapter's ONNX artifact: prove it is a policy.

"export exited 0" is not "the platform received a policy". A mis-wired export
(wrong input slot, stale graph, normalizer applied twice) produces a file that
hashes fine and runs fine and is not the trained behavior — and the platform
would sha256 it, stage it and hand it to the browser and the board. This gate
runs the exported graph on a few probe observations and checks the four
properties that hold for any real MicroDuck actor:

1. **contract** — exactly one 61D observation input, one 14D action output,
   and if there is recurrent state, it appears on both sides in pairs;
2. **finiteness** — probe actions (and state outputs) are all finite;
3. **determinism** — the same observation yields the same action;
4. **sensitivity** — different observations yield different actions; a graph
   that answers every observation with the same constant is worthless and
   must not ship as a policy.

What this gate deliberately does **not** claim: parity with the checkpoint.
That comparison needs the upstream network reconstructed in torch — the
adapter would be re-implementing the exporter to check the exporter, and the
result would be pinned to one mjlab revision. Graph-level parity belongs to
``engines/microduck-eval``, which pins ``policySha256`` in its report.

Verdicts:

* ``passed``  — ship the artifact.
* ``failed``  — withhold the artifact (the adapter renames it to
  ``policy.onnx.rejected`` so the worker finds nothing to hash); the training
  run itself still completes and the reasons land in training-summary.json.
* ``skipped`` — onnxruntime is not importable in this interpreter. The export
  itself succeeded, so the artifact ships with the skip recorded honestly.
  Installing onnxruntime in the upstream venv turns the gate on.

Importable without onnxruntime and without numpy-at-scale: the pure verdict
logic is what ``adapter_probe.py`` pins; the session checks run only where the
artifact actually exists.
"""

from __future__ import annotations

import re
from pathlib import Path

OBSERVATION_SIZE = 61
ACTION_SIZE = 14

#: Probe budget: enough observations to see variation, few enough to stay
#: sub-second even on a busy GPU box.
PROBE_OBSERVATIONS = 8
#: Two actions closer than this count as "the graph ignored the input".
SENSITIVITY_MIN_DIFF = 1e-6
#: Same input twice must agree to this tolerance (threaded kernels may reorder
#: floating-point sums; a nondeterministic *policy* is orders of magnitude
#: noisier than that).
DETERMINISM_ATOL = 1e-7

VERDICT_PASSED = "passed"
VERDICT_FAILED = "failed"
VERDICT_SKIPPED = "skipped"


class _IO:
    """Minimal stand-in for onnxruntime IO metadata (name + shape list)."""

    def __init__(self, name: str, shape: list) -> None:
        self.name = name
        self.shape = shape


def _dim_of(shape: list) -> int | None:
    """Product of non-batch dims; symbolic dims make the size unknown."""
    total = 1
    for dim in shape[1:]:
        try:
            total *= int(dim)
        except (TypeError, ValueError):
            return None
    return total


def _describe(entries) -> str:
    return ", ".join(
        "{}{}".format(getattr(entry, "name", "?"), list(getattr(entry, "shape", [])))
        for entry in entries
    )


def pair_state(inputs: list, outputs: list) -> list[tuple[str, str]]:
    """Pair state inputs with the state outputs that feed them.

    Name-based first (``h_in``/``h_out``, ``initial_h``/``h``), then by unique
    size. Ambiguity is an error: guessing feeds the wrong tensor as history.
    Mirrors ``microduck-eval/policy.py`` so the two loaders accept the same
    export vocabulary, but is kept self-contained — the adapter deploys to a
    GPU box that has no microduck-eval checkout.
    """
    pairs: list[tuple[str, str]] = []
    consumed_inputs: list = []
    unmatched = [out for out in outputs]
    for state_in in inputs:
        name_in = state_in.name
        candidates = [
            out
            for out in unmatched
            if out.name == name_in
            or re.sub(r"(_out|initial_|_in|s)$", "", out.name) == re.sub(r"(_in|initial_|s)$", "", name_in)
        ]
        if len(candidates) > 1:
            raise ValueError(
                "state input {!r} matches multiple outputs: {}".format(name_in, _describe(candidates))
            )
        if candidates:
            pairs.append((name_in, candidates[0].name))
            unmatched.remove(candidates[0])
            consumed_inputs.append(state_in)
    # Size-based fallback only over inputs that name pairing did not consume.
    # An already-paired input must not claim a second output (a graph with
    # "h_in/h_out" plus a stray same-size "mystery" output is ambiguous, and
    # feeding one state input into two slots is exactly the silent corruption
    # this gate exists to stop).
    for out in list(unmatched):
        size = _dim_of(out.shape)
        same_size = [
            item for item in inputs if item not in consumed_inputs and _dim_of(item.shape) == size
        ]
        if len(same_size) != 1:
            raise ValueError(
                "cannot pair state output {!r} with an input (candidates: {})".format(
                    out.name, _describe(same_size)
                )
            )
        pairs.append((same_size[0].name, out.name))
        consumed_inputs.append(same_size[0])
        unmatched.remove(out)
    return pairs


def classify_graph(inputs: list, outputs: list) -> dict:
    """Split graph IO into obs/action/state. Pure; raises on ambiguity."""
    if not inputs or not outputs:
        raise ValueError("graph has no inputs or no outputs")
    obs_inputs = [item for item in inputs if _dim_of(item.shape) == OBSERVATION_SIZE]
    if len(obs_inputs) != 1:
        raise ValueError(
            "expected exactly one {}-dim input, got {}: {}".format(
                OBSERVATION_SIZE, len(obs_inputs), _describe(inputs)
            )
        )
    action_outputs = [item for item in outputs if _dim_of(item.shape) == ACTION_SIZE]
    if len(action_outputs) != 1:
        raise ValueError(
            "expected exactly one {}-dim output, got {}: {}".format(
                ACTION_SIZE, len(action_outputs), _describe(outputs)
            )
        )
    state_inputs = [item for item in inputs if item is not obs_inputs[0]]
    state_outputs = [item for item in outputs if item is not action_outputs[0]]
    pairs: list[tuple[str, str]] = []
    if state_inputs or state_outputs:
        if not (state_inputs and state_outputs):
            raise ValueError(
                "state on only one side (inputs: {}, outputs: {})".format(
                    _describe(state_inputs), _describe(state_outputs)
                )
            )
        pairs = pair_state(state_inputs, state_outputs)
    return {
        "input_name": obs_inputs[0].name,
        "output_name": action_outputs[0].name,
        "state_pairs": [list(pair) for pair in pairs],
        "recurrent": bool(pairs),
    }


def _state_feed_shapes(state_inputs: list) -> list[tuple[int, ...]]:
    """Declared state shapes with symbolic dims as 1 (evaluation runs batch=1)."""
    shapes = []
    for item in state_inputs:
        dims = []
        for dim in item.shape:
            try:
                dims.append(int(dim))
            except (TypeError, ValueError):
                dims.append(1)
        shapes.append(tuple(dims))
    return shapes


def assemble_verdict(checks: dict) -> dict:
    """Turn individual check outcomes into the gate's verdict. Pure.

    ``checks`` maps check name -> ``{"ok": bool, "reason": str | None}`` for
    the checks that ran; a check that could not run at all (missing runtime)
    is simply absent. One failed check fails the gate; no failed checks and
    at least the contract check present means passed.
    """
    ran = {name: outcome for name, outcome in checks.items()}
    failures = [
        "{}: {}".format(name, outcome.get("reason") or "failed")
        for name, outcome in ran.items()
        if not outcome.get("ok")
    ]
    if failures:
        return {
            "verdict": VERDICT_FAILED,
            "checks": {name: bool(outcome.get("ok")) for name, outcome in ran.items()},
            "reasons": failures,
        }
    if "contract" not in ran:
        return {
            "verdict": VERDICT_SKIPPED,
            "checks": {},
            "reasons": ["onnxruntime is not importable in this interpreter; the export "
                        "itself succeeded, so the artifact ships ungated"],
        }
    return {"verdict": VERDICT_PASSED, "checks": {name: True for name in ran}, "reasons": []}


def run_gate(onnx_path: Path) -> dict:
    """Run the four checks against the exported file. Returns the verdict dict."""
    try:
        import onnxruntime as ort  # noqa: PLC0415
    except ImportError:
        return assemble_verdict({})

    import numpy as np  # noqa: PLC0415

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    inputs = [_IO(item.name, list(item.shape)) for item in session.get_inputs()]
    outputs = [_IO(item.name, list(item.shape)) for item in session.get_outputs()]

    checks: dict = {}
    try:
        fields = classify_graph(inputs, outputs)
        state_in_names = [pair[0] for pair in fields["state_pairs"]]
        state_out_names = [pair[1] for pair in fields["state_pairs"]]
        state_shapes = _state_feed_shapes(
            [item for item in inputs if item.name in state_in_names]
        )
        checks["contract"] = {
            "ok": True,
            "reason": None,
            "recurrent": fields["recurrent"],
            "statePairs": fields["state_pairs"],
        }
    except ValueError as error:
        checks["contract"] = {"ok": False, "reason": str(error)}
        return assemble_verdict(checks)

    rng = np.random.default_rng(20260916)
    observations = [
        rng.normal(0.0, 0.5, OBSERVATION_SIZE).astype(np.float32)
        for _ in range(PROBE_OBSERVATIONS)
    ]
    wanted = [fields["output_name"], *state_out_names]

    def run(observation):
        feeds = {fields["input_name"]: observation.reshape(1, -1)}
        for name, shape in zip(state_in_names, state_shapes):
            feeds[name] = np.zeros(shape, dtype=np.float32)
        results = session.run(wanted, feeds)
        return results

    # Finiteness over the probe batch.
    finite = True
    reason = None
    for observation in observations:
        results = run(observation)
        for index, tensor in enumerate(results):
            if not np.all(np.isfinite(tensor)):
                finite = False
                reason = "output {!r} is non-finite on a probe observation".format(
                    wanted[index] if index < len(wanted) else index
                )
                break
        if not finite:
            break
    checks["finiteness"] = {"ok": finite, "reason": reason}

    # Determinism: the same observation twice must agree.
    first = run(observations[0])[0]
    second = run(observations[0])[0]
    deterministic = bool(np.allclose(first, second, atol=DETERMINISM_ATOL))
    checks["determinism"] = {
        "ok": deterministic,
        "reason": None
        if deterministic
        else "same observation produced different actions "
             "(max diff {:.2e})".format(float(np.max(np.abs(first - second)))),
    }

    # Sensitivity: across the probe batch, at least two actions must differ
    # meaningfully — a constant graph has ignored its input.
    actions = [run(observation)[0].reshape(-1) for observation in observations]
    best_diff = 0.0
    for index in range(len(actions)):
        for other in range(index + 1, len(actions)):
            diff = float(np.max(np.abs(actions[index] - actions[other])))
            best_diff = max(best_diff, diff)
    sensitive = best_diff > SENSITIVITY_MIN_DIFF
    checks["sensitivity"] = {
        "ok": sensitive,
        "reason": None
        if sensitive
        else "all {} probe actions are identical within {:.1e} — the graph "
             "ignores its input".format(PROBE_OBSERVATIONS, SENSITIVITY_MIN_DIFF),
    }
    checks["sensitivity"]["maxActionDiff"] = round(best_diff, 8)

    verdict = assemble_verdict(checks)
    verdict["probes"] = PROBE_OBSERVATIONS
    return verdict


def main(argv: list[str] | None = None) -> int:
    import json
    import sys

    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1:
        print("usage: onnx_export_gate.py <policy.onnx>", file=sys.stderr)
        return 2
    path = Path(args[0])
    if not path.is_file():
        print("policy not found: {}".format(path), file=sys.stderr)
        return 2
    print(json.dumps(run_gate(path), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
