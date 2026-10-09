#!/usr/bin/env python3
"""Observation-history stacking gate: engine contract, board runtime, refusal paths.

Covers the full stacking chain without any GPU:

1. Contract: the stacked task pack resolves into a frames x frameWidth
   contract (invokes the repo's resolver through node, so the JS source of
   truth is exercised, not a copy).
2. Engine: a real (smoke-budget) starter-ppo run on the stacked pack exports
   an ONNX whose input is exactly frames x frameWidth wide, carries the
   observationHistory provenance, and keeps telemetry rows at single-frame
   width. The legacy pack must stay byte-for-byte on the old contract shape.
3. Board runtime: the stacked model loads against the stacked adapter, a
   single-frame model is refused under it, batch serving expects pre-stacked
   rows, and the rolling history push produces the oldest-first order.
4. Refusals: single-frame runtimes (native BPU path, joint runtime) and a
   malformed stacking declaration fail closed.

Machines without numpy/torch/onnx (step 2) or onnxruntime (step 3) SKIP the
corresponding section and exit 0, so `npm run verify` stays green on lean
CI runners — the same policy as the other engine gates.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAILURES = []

# Imports the repo resolver as a module and builds the full training request.
# process.argv is replaced before the import because the resolver's own CLI
# block keys on argv[2] and would otherwise print the raw pack into stdout.
_RESOLVER_SNIPPET = (
    "const {pathToFileURL} = require('url');"
    "const [, resolver, taskId, contextFile] = process.argv;"
    "process.argv = [process.argv[0], '', ''];"
    "import(pathToFileURL(resolver).href).then(({resolveTaskPack, trainingRequestFor}) => {"
    "const context = contextFile ? JSON.parse(require('fs').readFileSync(contextFile, 'utf8')) : {};"
    "process.stdout.write(JSON.stringify(trainingRequestFor(resolveTaskPack(taskId, context), context)));"
    "});"
)


def check(name, condition, detail=""):
    text = detail if isinstance(detail, str) else repr(detail)
    print(("PASS " if condition else "FAIL ") + name + (" | " + text if text and not condition else ""))
    if not condition:
        FAILURES.append(name)


def module_from(path):
    name = "vh_" + str(abs(hash(path)))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolve field annotations through sys.modules[cls.__module__];
    # an unregistered module crashes on Python 3.9 at class creation time.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run(cmd, env=None, cwd=None, timeout=600):
    return subprocess.run(
        cmd, env=env, cwd=cwd or REPO, capture_output=True, text=True, timeout=timeout
    )


def node_request(task_id, context=None):
    """Build a training request through the repo's own resolver."""
    context_path = None
    args = ["node", "-e", _RESOLVER_SNIPPET, os.path.join(REPO, "scripts", "resolve-task-pack.mjs"), task_id]
    if context:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(context, handle)
        handle.close()
        context_path = handle.name
        args.append(context_path)
    try:
        result = run(args)
        if result.returncode != 0:
            raise RuntimeError("resolver failed for {}: {}".format(task_id, result.stderr))
        return json.loads(result.stdout)
    finally:
        if context_path:
            os.unlink(context_path)


def deps_available():
    try:
        import numpy  # noqa: F401
        import torch  # noqa: F401
        import onnx  # noqa: F401

        return True
    except ImportError:
        return False


def onnxruntime_available():
    try:
        import onnxruntime  # noqa: F401

        return True
    except ImportError:
        return False


def train_smoke(request, job_dir):
    request_path = os.path.join(job_dir, "request.json")
    with open(request_path, "w") as handle:
        json.dump(request, handle)
    env = dict(os.environ)
    env.update(
        {
            "RDK_SIM2REAL_REQUEST_FILE": request_path,
            "RDK_SIM2REAL_RESULT_FILE": os.path.join(job_dir, "result.json"),
            "RDK_STARTER_ENGINE_ITERATIONS": "2",
            "RDK_STARTER_ENGINE_ENVS": "4",
            "RDK_STARTER_ENGINE_STEPS": "16",
            "RDK_STARTER_ENGINE_DEVICE": "cpu",
        }
    )
    result = run(
        [sys.executable, os.path.join(REPO, "engines", "starter-ppo", "runner.py")],
        env=env,
        cwd=job_dir,
    )
    if result.returncode != 0:
        raise RuntimeError("starter-ppo smoke failed:\n{}\n{}".format(result.stdout, result.stderr))
    with open(os.path.join(job_dir, "result.json")) as handle:
        return json.load(handle)


def onnx_input_width(path):
    import onnx

    model = onnx.load(path)
    return int(model.graph.input[0].type.tensor_type.shape.dim[1].dim_value)


def main():
    scratch = tempfile.mkdtemp(prefix="rdk-obs-history-")
    try:
        # The board runtimes hash model bytes through board_ipc.secure_size,
        # which requires the model's parent directory to be 0700 — the same
        # hardening a real job directory has on the board.
        os.chmod(scratch, 0o700)
        _main(scratch)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _main(scratch):
    # ---- 1. contract resolution -------------------------------------------
    stacked_request = node_request(
        "originbot-goal-navigation-history", {"profile": "smoke", "modelId": "vh-stacked", "version": "0.0.0-gate"}
    )
    legacy_request = node_request(
        "originbot-goal-navigation", {"profile": "smoke", "modelId": "vh-legacy", "version": "0.0.0-gate"}
    )
    contract = stacked_request["contract"]
    check("stacked contract flat width", contract["observationSize"] == 24, contract["observationSize"])
    check(
        "stacked layout is one entry per frame, oldest first",
        [item["name"] for item in contract["observationLayout"]]
        == ["originbot-imu-odom-v1@t-2", "originbot-imu-odom-v1@t-1", "originbot-imu-odom-v1@t-0"],
        contract["observationLayout"],
    )
    check(
        "stacked contract history block",
        contract.get("observationHistory") == {"frames": 3, "order": "oldest-first"},
        contract.get("observationHistory"),
    )
    check("legacy contract keeps 8D", legacy_request["contract"]["observationSize"] == 8)
    check("legacy contract has no history block", "observationHistory" not in legacy_request["contract"])

    # ---- 2. engine smoke (real training, honest SKIP) ----------------------
    stacked_model = legacy_model = None
    if deps_available():
        for sub in ("stacked", "legacy"):
            path = os.path.join(scratch, sub)
            os.makedirs(path, exist_ok=True)
            os.chmod(path, 0o700)
        stacked_result = train_smoke(stacked_request, os.path.join(scratch, "stacked"))
        legacy_result = train_smoke(legacy_request, os.path.join(scratch, "legacy"))
        stacked_model = os.path.join(scratch, "stacked", "policy.onnx")
        legacy_model = os.path.join(scratch, "legacy", "policy.onnx")
        check("stacked ONNX input = 24", onnx_input_width(stacked_model) == 24)
        check("legacy ONNX input = 8", onnx_input_width(legacy_model) == 8)
        metrics = stacked_result["metrics"]
        check(
            "stacked metrics carry observationHistory",
            metrics.get("observationHistory", {}).get("frames") == 3
            and metrics.get("observationHistory", {}).get("modelObservationSize") == 24,
            metrics.get("observationHistory"),
        )
        check("stacked metrics observationSize = 24", metrics.get("observationSize") == 24)
        check(
            "legacy metrics stay single-frame",
            legacy_result["metrics"].get("observationSize") == 8
            and "observationHistory" not in legacy_result["metrics"],
        )
        with open(os.path.join(scratch, "stacked", "telemetry.jsonl")) as handle:
            row = json.loads(handle.readline())
        check("telemetry rows stay single-frame (8)", len(row["observation"]) == 8, len(row["observation"]))
        eval_report = json.load(open(os.path.join(scratch, "stacked", "eval-report.json")))
        check(
            "eval-report carries stacking provenance",
            eval_report.get("observationHistory", {}).get("frames") == 3,
            eval_report.get("observationHistory"),
        )
    else:
        print("SKIP engine smoke — numpy/torch/onnx not available")

    # ---- 3+4. board runtime -------------------------------------------------
    if onnxruntime_available():
        os.environ["RDK_SIM2REAL_ADAPTER_CONFIG"] = os.path.join(REPO, "adapters/rdk-originbot-history3.json")
        for key in ("RDK_SIM2REAL_OBS_HISTORY_FRAMES",):
            os.environ.pop(key, None)
        bpr = module_from(os.path.join(REPO, "services/sim2real-web/board-policy-runtime.py"))
        check("adapter frames parsed", bpr.OBS_HISTORY_FRAMES == 3, bpr.OBS_HISTORY_FRAMES)
        check("declaration accepted", bpr.observation_history_error() is None)

        if stacked_model:
            runtime = bpr.PolicyRuntime()
            loaded = runtime.load(stacked_model)
            check("stacked model loads", loaded.get("ok") is True, loaded)
            check(
                "load meta carries history",
                loaded.get("model", {}).get("observationHistory", {}).get("frames") == 3,
                loaded.get("model"),
            )
            import numpy as np

            served = runtime.infer_batch(np.zeros((2, 24), dtype=np.float32))
            check("batch serves pre-stacked rows", served.get("ok") is True, served)
            refused = runtime.infer_batch(np.zeros((2, 8), dtype=np.float32))
            check(
                "batch refuses frame-width rows",
                refused.get("ok") is False and refused.get("error") == "observation-dimension-mismatch",
                refused,
            )
            single_runtime = bpr.PolicyRuntime()
            single_load = single_runtime.load(legacy_model)
            check(
                "single-frame model refused under stacked adapter",
                single_load.get("ok") is False
                and single_load.get("error") == "policy-input-dimension-mismatch"
                and "3 x 8 = 24" in str(single_load.get("detail", "")),
                single_load,
            )

            # Rolling history order: oldest first, zero-initialized.
            history_runtime = bpr.PolicyRuntime()
            history_runtime._obs_history = np.zeros((3, 8), dtype=np.float32)
            first = history_runtime._push_history(np.full(8, 1.0, dtype=np.float32))
            check(
                "history push: zeros before the first frame",
                first[:8].tolist() == [0.0] * 8 and first[16:].tolist() == [1.0] * 8,
            )
            history_runtime._push_history(np.full(8, 2.0, dtype=np.float32))
            third = history_runtime._push_history(np.full(8, 3.0, dtype=np.float32))
            check(
                "history push: oldest-first rolling order",
                third[:8].tolist() == [1.0] * 8 and third[8:16].tolist() == [2.0] * 8 and third[16:].tolist() == [3.0] * 8,
                third,
            )

        # Env override + malformed declaration fail closed.
        os.environ["RDK_SIM2REAL_ADAPTER_CONFIG"] = os.path.join(REPO, "adapters/rdk-originbot.json")
        os.environ["RDK_SIM2REAL_OBS_HISTORY_FRAMES"] = "abc"
        bad_override = module_from(os.path.join(REPO, "services/sim2real-web/board-policy-runtime.py"))
        check("bad override reported", bad_override.observation_history_error() is not None)
        if stacked_model:
            runtime = bad_override.PolicyRuntime()
            refused = runtime.load(stacked_model)
            check(
                "bad override refuses load",
                refused.get("ok") is False and refused.get("error") == "observation-history-invalid",
                refused,
            )

        # Joint runtime: a malformed declaration fails closed at import time.
        # The declaration resolves from the adapter file when the module loads,
        # so the negative case needs its own (bad) adapter file.
        os.environ.pop("RDK_SIM2REAL_OBS_HISTORY_FRAMES", None)
        bad_adapter_path = os.path.join(scratch, "microduck-leg-bad-order.json")
        with open(os.path.join(REPO, "adapters/microduck-leg.json")) as handle:
            bad_adapter = json.load(handle)
        bad_adapter.setdefault("policy", {})["observationHistory"] = {
            "frames": 3,
            "order": "newest-first",
        }
        with open(bad_adapter_path, "w") as handle:
            json.dump(bad_adapter, handle)
        os.environ["RDK_SIM2REAL_ADAPTER_CONFIG"] = bad_adapter_path
        joint = module_from(os.path.join(REPO, "services/sim2real-web/board-joint-policy-runtime.py"))
        joint_runtime = joint.JointPolicyRuntime.__new__(joint.JointPolicyRuntime)
        joint_runtime._lock = threading.RLock()
        refusal = joint_runtime.load(stacked_model or "/nonexistent.onnx")
        check(
            "joint runtime refuses an unimplemented concat order",
            refusal.get("ok") is False and refusal.get("error") == "observation-history-invalid",
            refusal,
        )
    else:
        print("SKIP board runtime — onnxruntime not available")

    # ---- 5. joint (61D) chain: train -> eval harness -> board runtime -------
    joint_stack_ok = False
    if deps_available() and onnxruntime_available():
        joint_scratch = os.path.join(scratch, "joint")
        os.makedirs(joint_scratch, exist_ok=True)
        os.chmod(joint_scratch, 0o700)
        env = dict(os.environ)
        env.update({"RDK_SIM2REAL_OBS_HISTORY_FRAMES": "", "RDK_SIM2REAL_ADAPTER_CONFIG": ""})

        def train_joint(frames, export_name):
            export_path = os.path.join(joint_scratch, export_name)
            summary_path = os.path.join(joint_scratch, f"summary-{export_name}.json")
            result = run(
                [
                    sys.executable,
                    os.path.join(REPO, "engines", "microduck-recurrent", "train_recurrent.py"),
                    "--env", "basketball",
                    "--obs-history-frames", str(frames),
                    "--num-envs", "2",
                    "--iterations", "1",
                    "--steps-per-env", "8",
                    "--export", export_path,
                    "--out", summary_path,
                ],
                env=env,
            )
            if result.returncode != 0:
                raise RuntimeError("microduck-recurrent smoke failed:\n{}".format(result.stderr[-2000:]))
            with open(summary_path) as handle:
                return export_path, json.load(handle)

        try:
            joint_stacked, stacked_summary = train_joint(3, "joint-stacked.onnx")
            joint_single, single_summary = train_joint(1, "joint-single.onnx")
        except (RuntimeError, OSError) as error:
            check("joint 61D chain trains", False, error)
        else:
            joint_stack_ok = True
            check("joint stacked ONNX input = 183", onnx_input_width(joint_stacked) == 183)
            check("joint single ONNX input = 61", onnx_input_width(joint_single) == 61)
            check(
                "joint trainer records stacking provenance",
                stacked_summary.get("observationHistory")
                == {"frames": 3, "order": "oldest-first", "modelObservationSize": 183}
                and "observationHistory" not in single_summary,
                stacked_summary.get("observationHistory"),
            )

            # Eval harness policy layer: rolling history + declaration checks.
            sys.path.insert(0, os.path.join(REPO, "engines", "microduck-eval"))
            eval_policy = module_from(
                os.path.join(REPO, "engines", "microduck-eval", "microduck_eval", "policy.py")
            )
            stacked = eval_policy.load_policy(joint_stacked, history_frames=3)
            import numpy as np

            frame = np.full(61, 0.5, dtype=np.float32)
            action = stacked.act(frame)
            check(
                "eval stacked policy acts on 61D frames",
                action.shape == (14,) and bool(np.all(np.isfinite(action))),
                action,
            )
            facts = stacked.facts()
            check(
                "eval facts record the stacking contract",
                facts.get("observationHistory")
                == {"frames": 3, "order": "oldest-first", "frameSize": 61, "modelInputWidth": 183},
                facts,
            )
            stacked.reset()
            fed = stacked.act(frame)
            check(
                "eval reset() zeroes the frame history",
                stacked.history[0].tolist() == [0.0] * 61 and stacked.history[1].tolist() == [0.0] * 61,
            )
            del fed
            try:
                eval_policy.load_policy(joint_stacked)
                mismatch_ok = False
            except eval_policy.PolicyContractError:
                mismatch_ok = True
            check(
                "eval refuses a stacked graph without the declared depth",
                mismatch_ok,
            )
            try:
                eval_policy.load_policy(joint_single, history_frames=3)
                wrong_depth_ok = False
            except eval_policy.PolicyContractError:
                wrong_depth_ok = True
            check(
                "eval refuses a single-frame graph under a stacked declaration",
                wrong_depth_ok,
            )

            # Board joint runtime: it serves single-input feed-forward graphs
            # only (the recurrent trainer artifact is the eval harness's
            # pairing), so the stacked-input plumbing is exercised with a
            # feed-forward 183->14 graph and its 61->14 single-frame twin.
            import torch

            class _FF(torch.nn.Module):
                def __init__(self, width):
                    super().__init__()
                    self.layer = torch.nn.Linear(width, 14)

                def forward(self, obs):
                    return torch.tanh(self.layer(obs))

            ff_stacked = os.path.join(joint_scratch, "ff-183.onnx")
            ff_single = os.path.join(joint_scratch, "ff-61.onnx")
            torch.onnx.export(_FF(183).eval(), (torch.zeros((1, 183)),), ff_stacked,
                              input_names=["obs"], output_names=["actions"], opset_version=13)
            torch.onnx.export(_FF(61).eval(), (torch.zeros((1, 61)),), ff_single,
                              input_names=["obs"], output_names=["actions"], opset_version=13)

            os.environ["RDK_SIM2REAL_ADAPTER_CONFIG"] = os.path.join(
                REPO, "adapters/microduck-leg-history3.json"
            )
            os.environ.pop("RDK_SIM2REAL_OBS_HISTORY_FRAMES", None)
            joint_mod = module_from(
                os.path.join(REPO, "services/sim2real-web/board-joint-policy-runtime.py")
            )
            check("joint adapter frames parsed", joint_mod.OBS_HISTORY_FRAMES == 3)
            board_joint = joint_mod.JointPolicyRuntime()
            loaded = board_joint.load(ff_stacked)
            check(
                "joint board runtime loads the stacked graph",
                loaded.get("ok") is True
                and loaded.get("model", {}).get("inputDim") == 183
                and loaded.get("model", {}).get("observationHistory", {}).get("frames") == 3,
                loaded,
            )
            refused = board_joint.load(ff_single)
            check(
                "joint board runtime refuses a single-frame graph",
                refused.get("ok") is False and refused.get("error") == "model-input-dim-mismatch"
                and "3 x 61 = 183" in str(refused.get("detail", "")),
                refused,
            )
            history_runtime = joint_mod.JointPolicyRuntime()
            history_runtime._obs_history = np.zeros((3, 61), dtype=np.float32)
            first = history_runtime._push_history(np.full(61, 1.0, dtype=np.float32))
            check(
                "joint history push: zeros before the first frame",
                first[:61].tolist() == [0.0] * 61 and first[122:].tolist() == [1.0] * 61,
            )
        finally:
            sys.path.remove(os.path.join(REPO, "engines", "microduck-eval")) if os.path.join(
                REPO, "engines", "microduck-eval"
            ) in sys.path else None
    else:
        print("SKIP joint 61D chain — numpy/torch/onnx/onnxruntime not available")

    # ---- 6. mjx physics engine (real MJX smoke when the venv exists) --------
    mjx_python = os.path.join(REPO, "engines", "mjx-adapter", ".venv", "bin", "python")
    if not os.path.isfile(mjx_python):
        mjx_python = shutil.which("python3") or "python3"
    if run([mjx_python, "-c", "import jax, mujoco"]).returncode == 0:
        mjx_dir = os.path.join(scratch, "mjx")
        os.makedirs(mjx_dir, exist_ok=True)
        request_path = os.path.join(mjx_dir, "request.json")
        with open(request_path, "w") as handle:
            json.dump(stacked_request, handle)
        env = dict(os.environ)
        env.update(
            {
                "RDK_SIM2REAL_REQUEST_FILE": request_path,
                "RDK_SIM2REAL_RESULT_FILE": os.path.join(mjx_dir, "result.json"),
                "RDK_MJX_ENGINE_ITERATIONS": "2",
                "RDK_MJX_ENGINE_ENVS": "4",
                "RDK_MJX_ENGINE_STEPS": "16",
            }
        )
        result = run([mjx_python, os.path.join(REPO, "engines", "mjx-adapter", "adapter.py")],
                     env=env, cwd=mjx_dir)
        if result.returncode != 0:
            check("mjx stacked smoke trains", False, result.stderr[-1500:])
        else:
            mjx_result = json.load(open(os.path.join(mjx_dir, "result.json")))
            metrics = mjx_result["metrics"]
            check("mjx stacked metrics observationSize = 24", metrics.get("observationSize") == 24, metrics)
            check(
                "mjx metrics carry observationHistory",
                metrics.get("observationHistory", {}).get("frames") == 3,
                metrics.get("observationHistory"),
            )
            check("mjx stacked ONNX input = 24", onnx_input_width(os.path.join(mjx_dir, "policy.onnx")) == 24)
            with open(os.path.join(mjx_dir, "telemetry.jsonl")) as handle:
                row = json.loads(handle.readline())
            check("mjx telemetry rows stay single-frame (8)", len(row["observation"]) == 8, len(row["observation"]))
            check(
                "mjx physicsBackend stays honest",
                metrics.get("physicsBackend") == "mjx",
                metrics.get("physicsBackend"),
            )
    else:
        print("SKIP mjx smoke — engines/mjx-adapter venv with jax+mujoco not available")

    print()
    if FAILURES:
        print("FAILURES:", FAILURES)
        sys.exit(1)
    print("[observation-history] PASS — stacking contract, engine, board runtime and refusals verified")


if __name__ == "__main__":
    main()
