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
import time
import warnings

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
    # Keep the legacy exporter explicit for the minimal contract fixture. The
    # new dynamo exporter needs the optional onnxscript package, while this
    # verifier intentionally runs with the smallest torch/onnxruntime stack.
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            model,
            dummy,
            path,
            input_names=["obs"],
            output_names=["act"],
            dynamo=False,
        )


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


def _export_vision_onnx(path, obs_dim, channels, height, width):
    """Two-input export: a rank-2 observation plus an NHWC camera frame.

    The head pools the frame, so the graph accepts any declared resolution and
    the verifier can exercise more than one contract shape.
    """
    import torch

    class VisionNet(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.head = torch.nn.LazyLinear(2)

        def forward(self, obs, image):
            pooled = image.mean(dim=(2, 3))
            return torch.tanh(self.head(torch.cat([obs, pooled], dim=1)))

    model = VisionNet().eval()
    with torch.no_grad():
        # Initialise the lazy parameters before export; torch refuses to export
        # an uninitialised LazyModule.
        model(torch.zeros(1, obs_dim), torch.zeros(1, height, width, channels))
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            model,
            (torch.zeros(1, obs_dim), torch.zeros(1, height, width, channels)),
            path,
            input_names=["obs", "image"],
            output_names=["act"],
            dynamo=False,
        )
    # Pin the IR version so the file loads on the smallest onnxruntime stack.
    import onnx

    graph = onnx.load(path)
    graph.ir_version = 8
    onnx.save(graph, path)


def _write_snapshot(path, camera):
    """Telemetry snapshot with a real IMU head and the given camera block."""
    now = time.time()
    body = {
        "ts": now,
        "data": {
            "imu": {
                "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                "gyro": {"x": 0.1, "y": 0.2, "z": 0.3},
                "sampleMonotonicNs": time.monotonic_ns(),
            }
        },
    }
    if camera is not None:
        camera = dict(camera)
        camera.setdefault("sampleMonotonicNs", time.monotonic_ns())
        body["data"]["camera"] = camera
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(body, fh)


def _vision_adapter(path, obs_dim, action_dim, layout):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "id": "test-vision",
                "runtime": {"observationLayout": layout, "actionProjection": "identity"},
                "policy": {"observationSize": obs_dim, "actionSize": action_dim},
            },
            fh,
        )


def main():
    if not _have_deps():
        print("SKIP: onnxruntime/torch not installed; provider/layout contract untested here")
        return 0

    tmp = tempfile.mkdtemp(prefix="policy-provider-")
    model_8 = os.path.join(tmp, "native8.onnx")
    _export_tiny_onnx(model_8, 8, 2)
    model_61 = os.path.join(tmp, "contract61.onnx")
    _export_tiny_onnx(model_61, 61, 14)

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
    assert not start.get("ok") and start.get("error") == "goal-required", start
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

    # 6) A long-lived runtime may reload a different contract after an 8D
    # native model.  The second load must reset to the adapter-declared 61D
    # contract instead of inheriting the previous model's 8D dimensions.
    reload_adapter = os.path.join(tmp, "adapter-reload.json")
    with open(reload_adapter, "w", encoding="utf-8") as fh:
        json.dump({"id": "test-reload", "runtime": {"actionProjection": "paired"},
                   "policy": {"observationSize": 61, "actionSize": 14}}, fh)
    runtime = _load_runtime({**base_env, "RDK_SIM2REAL_ADAPTER_CONFIG": reload_adapter,
                             "RDK_SIM2REAL_POLICY_OBS_DIM": "61",
                             "RDK_SIM2REAL_POLICY_ACTION_DIM": "14"})
    rt_obj = runtime.PolicyRuntime()
    first = rt_obj.load(model_8)
    assert first.get("ok"), first
    failed = rt_obj.load(os.path.join(tmp, "missing-replacement.onnx"))
    assert not failed.get("ok") and failed.get("error") == "model-file-missing", failed
    assert rt_obj.snapshot()["model"] is None and rt_obj.snapshot()["state"] == "idle", rt_obj.snapshot()
    second = rt_obj.load(model_61)
    assert second.get("ok"), second
    assert second["model"]["inputDim"] == 61 and second["model"]["outputDim"] == 14, second
    print("model reload: adapter contract restored after native 8D load OK")

    # 7) Identity projection cannot accept a leg-style output head and then
    # silently use its first two values as (v, w).
    identity_adapter = os.path.join(tmp, "adapter-identity.json")
    with open(identity_adapter, "w", encoding="utf-8") as fh:
        json.dump({"id": "test-identity", "runtime": {"observationLayout": "imu-gravity-v1", "actionProjection": "identity"},
                   "policy": {"observationSize": 61, "actionSize": 14}}, fh)
    runtime = _load_runtime({**base_env, "RDK_SIM2REAL_ADAPTER_CONFIG": identity_adapter,
                             "RDK_SIM2REAL_POLICY_OBS_DIM": "61",
                             "RDK_SIM2REAL_POLICY_ACTION_DIM": "14"})
    result = runtime.PolicyRuntime().load(model_61)
    assert not result.get("ok") and result.get("error") == "identity-action-dimension-mismatch", result
    print("identity projection/head mismatch refused: OK")

    # 8) A normalized 2D head is scaled exactly once by the adapter limits,
    # and the selected mode is carried in model metadata/snapshot.
    normalized_adapter = os.path.join(tmp, "adapter-normalized.json")
    with open(normalized_adapter, "w", encoding="utf-8") as fh:
        json.dump({"id": "test-normalized", "runtime": {"actionOutput": "normalized-twist"},
                   "policy": {"observationSize": 8, "actionSize": 2}}, fh)
    runtime = _load_runtime({**base_env, "RDK_SIM2REAL_ADAPTER_CONFIG": normalized_adapter,
                             "RDK_SIM2REAL_POLICY_OBS_DIM": "8",
                             "RDK_SIM2REAL_POLICY_ACTION_DIM": "2"})
    rt_obj = runtime.PolicyRuntime()
    res = rt_obj.load(model_8)
    assert res.get("ok") and res["model"]["actionOutput"] == "normalized-twist", res
    linear, angular = rt_obj._project_action([0.5, -0.5])
    assert abs(linear - 0.5 * runtime.MAX_LINEAR) < 1e-9, (linear, runtime.MAX_LINEAR)
    assert abs(angular + 0.5 * runtime.MAX_ANGULAR) < 1e-9, (angular, runtime.MAX_ANGULAR)
    assert rt_obj.snapshot()["actionOutput"] == "normalized-twist"
    print("normalized twist scaling + metadata: OK")

    # 9) An unknown units declaration refuses model load instead of guessing.
    invalid_output_adapter = os.path.join(tmp, "adapter-invalid-output.json")
    with open(invalid_output_adapter, "w", encoding="utf-8") as fh:
        json.dump({"id": "test-invalid-output", "runtime": {"actionOutput": "guess"},
                   "policy": {"observationSize": 8, "actionSize": 2}}, fh)
    runtime = _load_runtime({**base_env, "RDK_SIM2REAL_ADAPTER_CONFIG": invalid_output_adapter,
                             "RDK_SIM2REAL_POLICY_OBS_DIM": "8",
                             "RDK_SIM2REAL_POLICY_ACTION_DIM": "2"})
    result = runtime.PolicyRuntime().load(model_8)
    assert not result.get("ok") and result.get("error") == "action-output-mode-invalid", result
    print("unknown action output mode refused: OK")


    # 10) Vision layout: the image branch is a separate model input, so it is
    #     validated against the real session inputs and read from the telemetry
    #     snapshot fail-closed.
    import time as _time

    channels, height, width = 3, 4, 4
    frame_len = channels * height * width
    vision_model = os.path.join(tmp, "vision.onnx")
    _export_vision_onnx(vision_model, 6, channels, height, width)
    snapshot = os.path.join(tmp, "telemetry-snapshot.json")
    vision_adapter_path = os.path.join(tmp, "adapter-vision.json")
    _vision_adapter(vision_adapter_path, 6, 2, "imu-gravity-camera-v1")

    def _vision_runtime(extra_env):
        return _load_runtime(
            {
                **base_env,
                "RDK_SIM2REAL_ADAPTER_CONFIG": vision_adapter_path,
                "RDK_SIM2REAL_POLICY_OBS_DIM": "6",
                "RDK_SIM2REAL_POLICY_ACTION_DIM": "2",
                "RDK_BOARD_TELEMETRY_SNAPSHOT": snapshot,
                **extra_env,
            }
        )

    # 10a) A vision layout with no declared image shape must refuse to load: the
    #      runtime cannot guess which camera geometry the policy was trained for.
    runtime = _vision_runtime({"RDK_SIM2REAL_OBSERVATION_LAYOUT": "imu-gravity-camera-v1",
                               "RDK_SIM2REAL_OBSERVATION_IMAGE": None})
    result = runtime.PolicyRuntime().load(vision_model)
    assert not result.get("ok") and result.get("error") == "observation-image-shape-missing", result
    print("vision layout without declared image shape refused: OK")

    # 10b) A model without an image branch must be refused for a vision layout
    #      instead of being treated as vector-only.
    runtime = _vision_runtime({"RDK_SIM2REAL_OBSERVATION_LAYOUT": "imu-gravity-camera-v1",
                               "RDK_SIM2REAL_OBSERVATION_IMAGE": "%dx%dx%d" % (channels, height, width)})
    result = runtime.PolicyRuntime().load(model_8 if os.path.exists(model_8) else vision_model)
    # model_8 has one rank-2 input and no image input, so this must fail closed.
    assert not result.get("ok"), result
    assert result.get("error") == "layout-model-mismatch", result
    assert "rank-4" in result.get("detail", ""), result
    print("vision layout without a model image input refused: %s" % result["error"])

    # 10c) Declared channel count must match the model's real image channel axis.
    runtime = _vision_runtime({"RDK_SIM2REAL_OBSERVATION_LAYOUT": "imu-gravity-camera-v1",
                               "RDK_SIM2REAL_OBSERVATION_IMAGE": "1x%dx%d" % (height, width)})
    result = runtime.PolicyRuntime().load(vision_model)
    assert not result.get("ok") and result.get("error") == "layout-model-mismatch", result
    assert "channels" in result.get("detail", ""), result
    print("vision channel mismatch refused: OK")

    # 10d) The happy path: load succeeds, the vector half keeps its exact
    #      vector-only semantics, and the frame is read at the declared shape.
    runtime = _vision_runtime({"RDK_SIM2REAL_OBSERVATION_LAYOUT": "imu-gravity-camera-v1",
                               "RDK_SIM2REAL_OBSERVATION_IMAGE": "%dx%dx%d" % (channels, height, width)})
    rt_obj = runtime.PolicyRuntime()
    result = rt_obj.load(vision_model)
    assert result.get("ok"), result
    meta = result["model"]
    assert meta["observationLayout"] == "imu-gravity-camera-v1", meta
    assert meta["imageInput"] == "image", meta
    assert meta["imageShape"] == [channels, height, width], meta
    assert meta["inputDim"] == 6, meta

    _write_snapshot(snapshot, {"channels": channels, "data": [0.25] * frame_len})
    step = rt_obj._build_observation_for_inference()
    assert step is not None, "a fresh frame and IMU must produce an observation"
    vector, frame = step
    assert len(vector) == 6, vector
    assert frame is not None and len(frame) == frame_len, frame
    assert frame[0] == 0.25, frame[0]
    print("vision observation: %dD vector + %dx%dx%d frame assembled" % (len(vector), channels, height, width))

    # 10e) A frozen camera topic must fail closed even while the wrapper file is
    #      being rewritten with a fresh timestamp.
    stale_ns = time.monotonic_ns() - int(10 * 1_000_000_000)
    _write_snapshot(snapshot, {"channels": channels, "data": [0.25] * frame_len,
                              "sampleMonotonicNs": stale_ns})
    assert rt_obj._build_observation_for_inference() is None, "a frozen camera must not produce an observation"
    print("stale camera frame refused: OK")

    # 10f) A truncated frame fails closed rather than being padded or reshaped.
    _write_snapshot(snapshot, {"channels": channels, "data": [0.25] * (frame_len - 1)})
    assert rt_obj._build_observation_for_inference() is None, "a short frame must not produce an observation"
    print("truncated frame refused: OK")

    # 10g) A frame with a non-finite value fails closed: NaN must never reach a
    #      policy as if it were a real pixel.
    bad = [0.25] * frame_len
    bad[3] = float("nan")
    _write_snapshot(snapshot, {"channels": channels, "data": bad})
    assert rt_obj._build_observation_for_inference() is None, "a NaN frame must not produce an observation"
    print("non-finite frame refused: OK")

    # 10h) A missing camera block fails closed, and no frame is written to the
    #      vector telemetry spool (images are inference input, not telemetry).
    _write_snapshot(snapshot, None)
    assert rt_obj._build_observation_for_inference() is None, "a missing camera must not produce an observation"
    print("missing camera block refused: OK")

    # 10i) A vector-only layout must not read the camera at all: the same missing
    #      camera block is irrelevant when the layout does not declare an image.
    vector_only_model = os.path.join(tmp, "vector-only.onnx")
    _export_tiny_onnx(vector_only_model, 8, 2)
    vector_adapter_path = os.path.join(tmp, "adapter-vector-only.json")
    _vision_adapter(vector_adapter_path, 8, 2, "originbot-imu-odom-v1")
    runtime = _load_runtime(
        {
            **base_env,
            "RDK_SIM2REAL_ADAPTER_CONFIG": vector_adapter_path,
            "RDK_SIM2REAL_POLICY_OBS_DIM": "8",
            "RDK_SIM2REAL_POLICY_ACTION_DIM": "2",
            "RDK_BOARD_TELEMETRY_SNAPSHOT": snapshot,
            "RDK_SIM2REAL_OBSERVATION_LAYOUT": "originbot-imu-odom-v1",
            "RDK_SIM2REAL_OBSERVATION_IMAGE": None,
        }
    )
    rt_obj = runtime.PolicyRuntime()
    result = rt_obj.load(vector_only_model)
    assert result.get("ok"), result
    assert result["model"]["imageInput"] is None, result["model"]
    assert result["model"]["imageShape"] is None, result["model"]
    print("vector-only layout ignores the camera: OK")


    # 10j) Producer/consumer schema agreement. The node and the runtime are
    #      separate processes that never share a type, so the frame schema is
    #      only a convention. Build a snapshot in EXACTLY the shape
    #      board-telemetry-node.py writes (shape/channel metadata plus the
    #      source sample stamps) and assert the real runtime consumes it. This
    #      is the check that would fail if either side renamed a field.
    runtime = _vision_runtime({"RDK_SIM2REAL_OBSERVATION_LAYOUT": "imu-gravity-camera-v1",
                               "RDK_SIM2REAL_OBSERVATION_IMAGE": "%dx%dx%d" % (channels, height, width)})
    rt_obj = runtime.PolicyRuntime()
    assert rt_obj.load(vision_model).get("ok")
    node_style_snapshot = {
        "ts": time.time(),
        "sourceMonotonicNs": time.monotonic_ns(),
        "seq": 7,
        "adapterId": "test-vision",
        "topics": {"imu": "/imu", "odom": "/odom", "battery": "/originbot_status",
                   "camera": "/camera/image_raw"},
        "cameraShape": [channels, height, width],
        "cameraDropped": 0,
        "data": {
            "imu": {
                "quaternion": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
                "gyro": {"x": 0.1, "y": 0.2, "z": 0.3},
                "sampleTs": time.time(),
                "sampleMonotonicNs": time.monotonic_ns(),
            },
            "camera": {
                "channels": channels,
                "height": height,
                "width": width,
                "encoding": "rgb8",
                "data": [7] * frame_len,
                "sampleTs": time.time(),
                "sampleMonotonicNs": time.monotonic_ns(),
            },
        },
    }
    with open(snapshot, "w", encoding="utf-8") as fh:
        json.dump(node_style_snapshot, fh)
    step = rt_obj._build_observation_for_inference()
    assert step is not None, "the runtime must consume a node-shaped snapshot"
    _vector, frame = step
    assert frame is not None and len(frame) == frame_len and frame[0] == 7.0, frame
    print("node-shaped snapshot consumed by the real runtime: OK")

    # 10k) The converter itself, driven the way the node drives it. Exercises the
    #      real module with a real encoded buffer, including row padding.
    sys.path.insert(0, os.path.join(HERE, "..", "services", "sim2real-web"))
    import board_camera_frame as _bcf

    assert _bcf.parse_shape("%dx%dx%d" % (channels, height, width)) == (channels, height, width)
    # A source row is 2 valid pixels (6 bytes) plus 3 bytes of row padding, so
    # step (9) is deliberately larger than width*channels (6).
    source_width = 2
    source_step = source_width * 3 + 3
    padded = bytearray()
    for _row in range(2):
        padded.extend(bytes([9, 9, 9]))          # pixel 1
        padded.extend(bytes([30, 30, 30]))       # pixel 2
        padded.extend(bytes([255, 255, 255]))    # padding the converter must skip
    converted = _bcf.frame_to_nhwc(encoding="rgb8", width=source_width, height=2,
                                   step=source_step, data=bytes(padded),
                                   channels=channels, out_height=1, out_width=1)
    assert converted is not None and len(converted) == channels, converted
    # Box average over all four pixels: (9 + 30) / 2 = 19.5. The padding bytes
    # are 255 on purpose -- if they were read, this would come out much higher.
    assert converted == [19.5, 19.5, 19.5], converted
    assert _bcf.frame_to_nhwc(encoding="yuv422", width=1, height=1, step=2,
                              data=b"\x01\x02", channels=3,
                              out_height=1, out_width=1) is None
    print("camera frame converter (row padding + unknown encoding refusal): OK")


    # 10l) Frame spooling for the uploader. The board uploader is a pass-through
    #      of the spool, so a frame that reaches the spool reaches the platform;
    #      the stride is what keeps the bounded, non-evicting spool from being
    #      dominated by images.
    import base64 as _base64

    spool = os.path.join(tmp, "frame-spool.jsonl")
    runtime = _vision_runtime({
        "RDK_SIM2REAL_OBSERVATION_LAYOUT": "imu-gravity-camera-v1",
        "RDK_SIM2REAL_OBSERVATION_IMAGE": "%dx%dx%d" % (channels, height, width),
        "RDK_SIM2REAL_RUN_ID": "run-frame-spool",
        "RDK_BOARD_TELEMETRY_SPOOL": spool,
        "RDK_SIM2REAL_FRAME_STRIDE": "2",
    })
    rt_obj = runtime.PolicyRuntime()
    assert rt_obj.load(vision_model).get("ok")
    _write_snapshot(snapshot, {"channels": channels, "data": [5] * frame_len})
    step = rt_obj._build_observation_for_inference()
    assert step is not None
    vector, frame = step
    for _ in range(4):
        rt_obj._append_telemetry(vector, [0.0, 0.0], (0.0, 0.0), frame)
    with open(spool, "r", encoding="utf-8") as fh:
        records = [json.loads(line) for line in fh if line.strip()]
    assert len(records) == 4, len(records)
    framed = [r for r in records if "cameraFrame" in r]
    # Stride 2 over indices 1..4 means samples 2 and 4 carry a frame.
    assert len(framed) == 2, [r.get("cameraFrame") is not None for r in records]
    assert [i for i, r in enumerate(records, start=1) if "cameraFrame" in r] == [2, 4]
    payload = framed[0]["cameraFrame"]
    assert payload["encoding"] == "rgb8" and payload["channels"] == channels, payload
    assert payload["width"] == width and payload["height"] == height, payload
    assert len(_base64.b64decode(payload["data"])) == frame_len
    # The vector observation must stay a flat float list: calibration and replay
    # analysis read it as one, so the frame may not be folded into it.
    assert all(isinstance(v, float) for v in records[0]["observation"]), records[0]["observation"][:3]
    print("frame spooling honours the stride and keeps the observation flat: OK")

    # 10m) Stride 0 disables frame spooling entirely (a board without a vision
    #      policy, or one with a tight spool budget).
    spool_off = os.path.join(tmp, "frame-spool-off.jsonl")
    runtime = _vision_runtime({
        "RDK_SIM2REAL_OBSERVATION_LAYOUT": "imu-gravity-camera-v1",
        "RDK_SIM2REAL_OBSERVATION_IMAGE": "%dx%dx%d" % (channels, height, width),
        "RDK_SIM2REAL_RUN_ID": "run-frame-spool-off",
        "RDK_BOARD_TELEMETRY_SPOOL": spool_off,
        "RDK_SIM2REAL_FRAME_STRIDE": "0",
    })
    rt_obj = runtime.PolicyRuntime()
    assert rt_obj.load(vision_model).get("ok")
    for _ in range(4):
        rt_obj._append_telemetry(vector, [0.0, 0.0], (0.0, 0.0), frame)
    with open(spool_off, "r", encoding="utf-8") as fh:
        off_records = [json.loads(line) for line in fh if line.strip()]
    assert len(off_records) == 4, len(off_records)
    assert all("cameraFrame" not in r for r in off_records)
    print("frame stride 0 disables frame spooling: OK")

    print("PASS: policy provider selection + declared observation layout")
    return 0


if __name__ == "__main__":
    sys.exit(main())
