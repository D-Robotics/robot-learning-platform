#!/usr/bin/env python3
"""Contract test: policy runtime provider selection + declared layouts.

Exercises the REAL board-policy-runtime module against a real onnxruntime
session (a tiny exported model), asserting:

1. provider fail-closed: requesting BPU on a build without a BPU provider
   refuses the load with `bpu-provider-unavailable` and never silently
   trains... runs inference on CPU instead;
2. CPU loads succeed and the model meta honestly reports provider,
   providerRequested and the onnxruntime providersAvailable list;
3. the adapter-declared observation layout drives assembly: the 8D native
   layout needs a goal; an unknown layout refuses `start` instead of
   assembling a guessed observation.

Run:  python3 scripts/verify-policy-provider-layout.py
Skip: exit 0 with SKIP when onnxruntime/torch are not installed (CI boxes).
"""

import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME_PATH = os.path.join(HERE, "..", "services", "sim2real-web", "board-policy-runtime.py")


def _have_deps():
    try:
        import onnxruntime  # noqa: F401
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


def _export_tiny_onnx(path, in_dim, out_dim):
    import torch

    torch.manual_seed(11)
    model = torch.nn.Linear(in_dim, out_dim, bias=False)
    dummy = torch.zeros(1, in_dim)
    torch.onnx.export(model, dummy, path, input_names=["obs"], output_names=["act"])


def _load_runtime(env):
    spec = importlib.util.spec_from_file_location(
        "board_policy_runtime_under_test", RUNTIME_PATH
    )
    module = importlib.util.module_from_spec(spec)
    old = {name: os.environ.get(name) for name in env}
    try:
        for name, value in env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        spec.loader.exec_module(module)
    finally:
        for name, value in old.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    return module


def main():
    if not _have_deps():
        print("SKIP: onnxruntime/torch not installed; provider/layout contract untested here")
        return 0

    tmp = tempfile.mkdtemp(prefix="policy-provider-")
    model_8 = os.path.join(tmp, "native8.onnx")
    _export_tiny_onnx(model_8, 8, 2)

    state = os.path.join(tmp, "state.json")
    base_env = {
        "RDK_BOARD_POLICY_STATE": state,
        "RDK_BOARD_TELEMETRY_SPOOL": os.path.join(tmp, "spool.jsonl"),
        "RDK_SIM2REAL_POLICY_OBS_DIM": "8",
        "RDK_SIM2REAL_POLICY_ACTION_DIM": "2",
        "RDK_BOARD_POLICY_PROVIDER": None,
        "RDK_SIM2REAL_OBSERVATION_LAYOUT": None,
        "RDK_SIM2REAL_ADAPTER_CONFIG": "",
    }

    # 1) BPU request on a build without BPU providers must fail closed.
    runtime = _load_runtime({**base_env, "RDK_BOARD_POLICY_PROVIDER": "bpu"})
    res = runtime.PolicyRuntime().load(model_8)
    assert not res.get("ok"), "bpu request must not succeed without a bpu provider"
    assert res.get("error") == "bpu-provider-unavailable", res
    assert "CPUExecutionProvider" in str(res.get("detail")), res
    print("provider fail-closed: bpu-provider-unavailable + honest detail OK")

    # 2) CPU load reports provider meta honestly.
    runtime = _load_runtime({**base_env, "RDK_BOARD_POLICY_PROVIDER": "cpu"})
    rt_obj = runtime.PolicyRuntime()
    res = rt_obj.load(model_8)
    assert res.get("ok"), res
    meta = res["model"]
    assert meta["provider"] == "CPUExecutionProvider", meta
    assert meta["providerRequested"] == "cpu", meta
    assert isinstance(meta["providersAvailable"], list) and meta["providersAvailable"], meta
    snap = rt_obj.snapshot()
    assert snap["providerRequested"] == "cpu", snap
    assert snap["observationLayout"] == "auto", snap
    print("provider honest reporting: meta + snapshot carry provider fields OK")

    # 3) adapter-declared native layout drives observation assembly.
    adapter_path = os.path.join(tmp, "adapter.json")
    with open(adapter_path, "w", encoding="utf-8") as fh:
        json.dump({"id": "test-native", "runtime": {"observationLayout": "originbot-imu-odom-v1"},
                   "policy": {"observationSize": 8, "actionSize": 2}}, fh)
    runtime = _load_runtime({**base_env, "RDK_SIM2REAL_ADAPTER_CONFIG": adapter_path})
    rt_obj = runtime.PolicyRuntime()
    assert runtime.OBSERVATION_LAYOUT == "originbot-imu-odom-v1", runtime.OBSERVATION_LAYOUT
    res = rt_obj.load(model_8)
    assert res.get("ok"), res
    # Layout + model agree (8D) so start proceeds to the goal requirement,
    # which fails closed without a goal — proving the declared layout picked
    # the 8D assembly (the contract-head assembly has no goal requirement).
    start = rt_obj.start(0.5)
    assert not start.get("ok") and start.get("error") == "originbot-goal-required", start
    start = rt_obj.start(0.5, 1.0, 1.0)
    assert start.get("ok") and start.get("state") == "running", start
    rt_obj.stop("test")
    print("declared layout: originbot-imu-odom-v1 drives 8D assembly (goal required) OK")

    # 4) declared layout contradicting the model refuses the load.
    adapter_mismatch = os.path.join(tmp, "adapter-mismatch.json")
    with open(adapter_mismatch, "w", encoding="utf-8") as fh:
        json.dump({"id": "test-mismatch", "runtime": {"observationLayout": "originbot-imu-odom-v1"},
                   "policy": {"observationSize": 61, "actionSize": 14}}, fh)
    runtime = _load_runtime({**base_env, "RDK_SIM2REAL_ADAPTER_CONFIG": adapter_mismatch,
                             "RDK_SIM2REAL_POLICY_OBS_DIM": "61",
                             "RDK_SIM2REAL_POLICY_ACTION_DIM": "14"})
    res = runtime.PolicyRuntime().load(model_8)
    # 8D model against a 61D contract is itself rejected; either error is an
    # honest refusal, never a silent cross-layout assembly.
    assert not res.get("ok") and res.get("error") in (
        "policy-input-dimension-mismatch", "layout-model-mismatch"), res
    print("layout/model contradiction refused: %s OK" % res.get("error"))

    # 5) unknown declared layout refuses start.
    adapter_unknown = os.path.join(tmp, "adapter-unknown.json")
    with open(adapter_unknown, "w", encoding="utf-8") as fh:
        json.dump({"id": "test-unknown", "runtime": {"observationLayout": "vision-transformer-v9"},
                   "policy": {"observationSize": 8, "actionSize": 2}}, fh)
    runtime = _load_runtime({**base_env, "RDK_SIM2REAL_ADAPTER_CONFIG": adapter_unknown})
    rt_obj = runtime.PolicyRuntime()
    res = rt_obj.load(model_8)
    assert res.get("ok"), res
    start = rt_obj.start(0.5, 1.0, 1.0)
    assert not start.get("ok") and start.get("error") == "observation-layout-unknown", start
    assert "vision-transformer-v9" in str(start.get("detail")), start
    print("unknown layout fail-closed: observation-layout-unknown OK")

    print("PASS: policy provider selection + declared observation layout")
    return 0


if __name__ == "__main__":
    sys.exit(main())
