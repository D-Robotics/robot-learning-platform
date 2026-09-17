#!/usr/bin/env python3
"""Board latency rehearsal: time the deployment artifact on the target board.

## What this fixes

`engines/starter-ppo/runner.py` reports a `controlLatencyMs` measured by timing
a 32-sample median PyTorch forward pass on the *training host*. That number
cannot answer the only question that matters before a motor moves: **does the
exported ONNX graph hold its control period on the board that will run it?**

This probe answers it. It runs on the board, loads the artifact through the
real `board-policy-runtime.py` load path (same provider selection, same input
binding, same dimension/layout validation), repeats the exact `session.run`
call the control loop makes, and writes a receipt:

    /var/lib/rdk-board-agent/runtime/board-latency-receipt.json

`shared/board-rehearsal.ts` validates that receipt. A deployment whose artifact
has no *fresh, board-stage, budget-met* receipt is refused, so host numbers can
never be mistaken for a control-loop budget.

## Fidelity notes (read before trusting a number)

* Inference is measured around the same call the loop makes, with per-sample
  `time.perf_counter`; this is an **in-process** figure, so it includes Python
  and ONNX Runtime dispatch but *not* GIL contention with camera/telemetry
  threads, DDS publish, or kernel scheduling on a loaded CPU.
* The control-step metric adds observation construction, action projection and
  the bookkeeping the loop performs, still without publishing.
* It never commands motion, never touches `/cmd_vel`, and does not require ROS.
  A run with ROS *bound* measures a strictly busier process, so an unbound
  rehearsal is a lower bound on real per-step cost, not an upper one.
* Vision exports are fed a synthesized flat frame of the declared shape: the
  graph and its preprocessing cost are real, the pixels are not.

Usage:
    python3 board-latency-rehearsal.py --model /root/rdk-board-agent/policies/policy.onnx
    python3 board-latency-rehearsal.py --model policy.onnx --decision-hz 50 --iterations 500
    python3 board-latency-rehearsal.py --out - --quiet      # receipt on stdout only
    python3 board-latency-rehearsal.py --self-test          # no board, no onnxruntime needed
"""

import argparse
import importlib.util
import json
import os
import platform
import socket
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME_PATH = os.path.join(HERE, "board-policy-runtime.py")
RECEIPT_SCHEMA_VERSION = 1
TOOL = "board-latency-rehearsal/1"
# Mirrors BOARD_REHEARSAL_MIN_SAMPLES in shared/board-rehearsal.ts: below this
# the gate refuses the receipt, so the probe refuses to write one.
MIN_SAMPLES = 100
DEFAULT_ITERATIONS = 300
DEFAULT_WARMUP = 20
# Fallback when the runtime module cannot be consulted (e.g. --self-test).
FALLBACK_DECISION_HZ = 50.0
# Receipt path matches board_ipc's private runtime dir so the same file can be
# collected by the agent without widening permissions.
DEFAULT_RECEIPT_PATH = "/var/lib/rdk-board-agent/runtime/board-latency-receipt.json"


def _load_runtime_module():
    """Import board-policy-runtime.py, whose hyphenated name is not importable."""
    spec = importlib.util.spec_from_file_location("rdk_board_policy_runtime", RUNTIME_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load %s" % RUNTIME_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _percentile(values, fraction):
    """Nearest-rank percentile; deterministic and assumption-free."""
    if not values:
        return 0.0
    ordered = sorted(values)
    index = int(round(fraction * (len(ordered) - 1)))
    return float(ordered[max(0, min(index, len(ordered) - 1))])


def _metric(name, samples_ms, budget_ms):
    return {
        "name": name,
        "samples": len(samples_ms),
        "medianMs": round(statistics.median(samples_ms), 4),
        "p95Ms": round(_percentile(samples_ms, 0.95), 4),
        "maxMs": round(max(samples_ms), 4),
        "overBudgetRatio": round(
            sum(1 for value in samples_ms if value > budget_ms) / max(1, len(samples_ms)), 4
        ),
        "budgetMs": round(budget_ms, 4),
    }


def _numpy():
    try:
        import numpy  # noqa: PLC0415 - optional dependency, reported not raised
    except ImportError:
        return None
    return numpy


def _synthesize_inputs(np, session_inputs):
    """Feeds for every session input, by rank.

    rank 2 -> observation vector, rank 3 -> recurrent state (h/c), rank 4 ->
    image. The real runtime builds the observation vector from live telemetry;
    a rehearsal cannot, and must not fake sensors on a robot, so it feeds a
    contract-shaped zero observation. A zero vector is a realistic *cost*
    sample: these graphs are dense MLPs/LSTMs whose latency is data-independent
    (no early exit, no dynamic control flow).
    """
    feeds = {}
    vector_name = None
    for item in session_inputs:
        shape = [dim if isinstance(dim, int) else 1 for dim in item.shape]
        if len(shape) == 2:
            feeds[item.name] = np.zeros(shape, dtype=np.float32)
            vector_name = vector_name or item.name
        elif len(shape) == 3:
            feeds[item.name] = np.zeros(shape, dtype=np.float32)
        elif len(shape) == 4:
            feeds[item.name] = np.zeros(shape, dtype=np.float32)
        else:
            feeds[item.name] = np.zeros([1] + shape, dtype=np.float32)
    return feeds, vector_name


def _carry_state(session, feeds, outputs):
    """Carries recurrent state across steps, as the runtime contract requires.

    When a state input (`h_in`/`c_in`) shares its shape with an output
    (`h_out`/`c_out`), the output of this step becomes the input of the next.
    Zero-initialised once, exactly as the deployed contract specifies.
    """
    outputs_by_shape = {}
    for output in outputs:
        value = output if hasattr(output, "shape") else None
        if value is not None:
            outputs_by_shape.setdefault(tuple(value.shape), []).append(value)
    for name, feed in list(feeds.items()):
        if len(feed.shape) < 3:
            continue
        candidates = outputs_by_shape.get(tuple(feed.shape))
        if candidates:
            feeds[name] = candidates.pop(0).astype(feed.dtype, copy=False)


def rehearse(args):
    """Measures the artifact and returns a receipt. Raises on unusable setup."""
    np = _numpy()
    if np is None:
        raise RuntimeError("numpy is required to rehearse on the board")
    try:
        import onnxruntime  # noqa: F401,PLC0415 - presence checked by the runtime load
    except ImportError:
        raise RuntimeError("onnxruntime is not installed on this board")

    runtime = _load_runtime_module()
    if not os.path.isfile(args.model):
        raise RuntimeError("model file not found: %s" % args.model)
    if args.decision_hz is not None:
        decision_hz = float(args.decision_hz)
    else:
        decision_hz = float(getattr(runtime, "DECISION_HZ", FALLBACK_DECISION_HZ))
    if decision_hz <= 0:
        raise RuntimeError("decisionHz must be positive")
    budget_ms = 1000.0 / decision_hz

    # The real load path: provider selection, input binding, dimension and
    # layout validation all run exactly as they do in production.
    policy = runtime.PolicyRuntime()
    loaded = policy.load(os.path.abspath(args.model))
    if not loaded.get("ok"):
        raise RuntimeError(
            "board policy runtime refused the artifact: %s"
            % json.dumps(
                {k: v for k, v in loaded.items() if k in ("error", "detail", "actual", "expected")}
            )
        )
    meta = loaded.get("model") or {}
    if policy._model_kind == "bpu":  # noqa: SLF001 - intentional reuse of the load path
        raise RuntimeError(
            "compiled BPU models are measured through hobot_dnn, not this ONNX rehearsal"
        )
    session = policy._model  # noqa: SLF001
    session_inputs = list(session.get_inputs())
    feeds, vector_name = _synthesize_inputs(np, session_inputs)
    if vector_name is None:
        raise RuntimeError("no rank-2 observation input in this model")

    # Warm-up: the first calls allocate arenas, load weights and fault pages in.
    # Timing them would describe process start-up, not the control period.
    for _ in range(max(0, args.warmup)):
        _carry_state(session, feeds, session.run(None, feeds))

    inference_ms = []
    control_ms = []
    for _ in range(args.iterations):
        step_started = time.perf_counter()
        started = time.perf_counter()
        outputs = session.run(None, feeds)
        inference_ms.append((time.perf_counter() - started) * 1000.0)
        _carry_state(session, feeds, outputs)
        action = [float(value) for value in outputs[0].reshape(-1)]
        policy._project_action(action)  # noqa: SLF001 - same projection the loop applies
        control_ms.append((time.perf_counter() - step_started) * 1000.0)

    metrics = [
        _metric("inference", inference_ms, budget_ms),
        _metric("control-step", control_ms, budget_ms),
    ]
    ros_bound = getattr(policy, "_node", None) is not None
    notes = [
        "in-process measurement: no GIL contention with camera/telemetry threads, no DDS publish",
        "observation is a contract-shaped zero vector; latency of a dense policy is data-independent",
        "decisionHz=%g -> %.4f ms budget per control step" % (decision_hz, budget_ms),
    ]
    if getattr(runtime, "VISION_LAYOUT", False):
        notes.append("vision export: image branch fed a synthesized frame of the declared shape")
    if getattr(runtime, "PROVIDER_REQUESTED", "cpu") != "cpu":
        notes.append("provider requested: %s" % runtime.PROVIDER_REQUESTED)
    if not ros_bound:
        notes.append("ROS was not bound in this process; a bound run measures a busier process")
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tool": TOOL,
        "stage": "board-onnx",
        "device": {
            "host": socket.gethostname(),
            "machine": platform.machine(),
            "boardModel": _board_model(),
        },
        "artifactSha256": str(meta.get("sha256") or ""),
        "artifactBytes": int(meta.get("bytes") or os.path.getsize(args.model)),
        "decisionHz": decision_hz,
        "provider": str(meta.get("provider") or "CPUExecutionProvider"),
        "metrics": metrics,
        "budgetMet": all(
            metric["medianMs"] <= budget_ms and metric["overBudgetRatio"] == 0
            for metric in metrics
        ),
        "rosBound": ros_bound,
        "notes": notes,
    }
    return receipt


def _board_model():
    for path in ("/proc/device-tree/model", "/sys/firmware/devicetree/base/model"):
        try:
            with open(path, "rb") as handle:
                value = handle.read().decode("utf-8", "replace").strip("\x00").strip()
            if value:
                return value[:120]
        except OSError:
            continue
    return ""


def _write_receipt(receipt, destination):
    payload = json.dumps(receipt, indent=2, ensure_ascii=False) + "\n"
    if destination == "-":
        sys.stdout.write(payload)
        return None
    # Atomic, owner-only: a partially written receipt must never be read as a
    # valid one, and this file is deployment evidence.
    directory = os.path.dirname(os.path.abspath(destination))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    temporary = "%s.%d.tmp" % (destination, os.getpid())
    handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return destination


def self_test():
    """Exercises receipt assembly, budget arithmetic and the writer with no board.

    This is the path CI can run: it proves the probe's own verdict logic and
    receipt shape without onnxruntime, a model, or a robot.
    """
    cases = []
    # A comfortably-in-budget distribution.
    good = [_metric("inference", [1.0, 1.2, 1.4, 1.1] * 40, 20.0)]
    cases.append(("in-budget", good, True))
    # A single over-budget sample must flip the verdict: an occasional 60 ms
    # stall is a fall, not a rounding error.
    spike = [1.0] * 199 + [60.0]
    cases.append(("single-spike", [_metric("inference", spike, 20.0)], False))
    # A median over budget fails even when some samples are fast.
    slow = [1.0] * 60 + [40.0] * 140
    cases.append(("median-over-budget", [_metric("inference", slow, 20.0)], False))
    for name, metrics, expected in cases:
        derived = all(
            metric["medianMs"] <= metric["budgetMs"] and metric["overBudgetRatio"] == 0
            for metric in metrics
        )
        if derived != expected:
            print(
                "[board-latency] FAIL — %s: budgetMet=%s expected %s (%s)"
                % (name, derived, expected, json.dumps(metrics)),
                file=sys.stderr,
            )
            return 1
    if _percentile([1.0, 2.0, 3.0, 4.0], 0.95) != 4.0:
        print("[board-latency] FAIL — p95 nearest-rank selection", file=sys.stderr)
        return 1
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tool": TOOL,
        "stage": "board-onnx",
        "device": {"host": "self-test", "machine": platform.machine(), "boardModel": ""},
        "artifactSha256": "0" * 64,
        "artifactBytes": 0,
        "decisionHz": 50.0,
        "provider": "CPUExecutionProvider",
        "metrics": [_metric("inference", [1.0, 1.2, 1.4, 1.1] * 40, 20.0)],
        "budgetMet": True,
        "notes": ["self-test: no board, no model, no onnxruntime"],
    }
    payload = json.dumps(receipt, indent=2, ensure_ascii=False)
    if json.loads(payload)["metrics"][0]["samples"] != 160:
        print("[board-latency] FAIL — receipt round-trip", file=sys.stderr)
        return 1
    print("[board-latency] self-test OK — 3 verdict cases, p95 selection, receipt round-trip")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--model", help="path to the deployment ONNX artifact")
    parser.add_argument(
        "--decision-hz",
        type=float,
        default=None,
        help="control rate under test; defaults to the runtime's DECISION_HZ",
    )
    parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS)
    parser.add_argument("--warmup", type=int, default=DEFAULT_WARMUP)
    parser.add_argument(
        "--out",
        default=DEFAULT_RECEIPT_PATH,
        help="receipt path, or - for stdout (%(default)s)",
    )
    parser.add_argument("--quiet", action="store_true", help="suppress the human summary")
    parser.add_argument("--self-test", action="store_true", help="check verdict logic, no board")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.model:
        parser.error("--model is required (or use --self-test)")
    if args.iterations < MIN_SAMPLES:
        parser.error(
            "--iterations must be at least %d: a shorter sample cannot support a release verdict"
            % MIN_SAMPLES
        )

    try:
        receipt = rehearse(args)
    except Exception as exc:  # noqa: BLE001 - any failure means no receipt, never a fake one
        print("[board-latency] FAIL — %s" % exc, file=sys.stderr)
        return 1
    written = _write_receipt(receipt, args.out)
    if not args.quiet and written:
        judged = next(
            (metric for metric in receipt["metrics"] if metric["name"] == "control-step"),
            receipt["metrics"][0],
        )
        print(
            "[board-latency] %s — %s p50 %.3f ms / p95 %.3f ms, budget %.3f ms (%d samples)"
            % (
                "budget met" if receipt["budgetMet"] else "BUDGET MISSED",
                judged["name"],
                judged["medianMs"],
                judged["p95Ms"],
                judged["budgetMs"],
                judged["samples"],
            )
        )
        print("[board-latency] receipt: %s" % written)
    # Exit code carries the verdict so a CI or field script can gate on it.
    return 0 if receipt["budgetMet"] else 1


if __name__ == "__main__":
    sys.exit(main())
