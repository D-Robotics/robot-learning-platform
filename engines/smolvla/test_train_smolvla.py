#!/usr/bin/env python3
"""Contract tests for the SmolVLA fine-tuning entry (reference adapter).

Runs on the development machine with zero extra dependencies: the dry-run
plan path, the fail-closed gates and the file-protocol round need nothing
beyond the standard library. Paths that require the GPU training stack
(transformers/accelerate/peft, CUDA) assert the REFUSAL/FAIL behavior that
this machine actually exhibits, and SKIP only when a full GPU stack makes
the cheap assertion impossible.

What these tests protect:
- the dry-run contract: a minimal LeRobot dataset directory yields exit 0,
  exactly one stdout line of JSON plan, and a result.json marked
  status=completed / metrics.dryRun=true with NO artifact and NO weights;
- honest degradation: a metadata-only dataset (no parquet) still passes the
  structure check with notes; a missing pyarrow degrades parquet-level
  validation instead of failing or lying;
- fail-closed: missing dataset directory, missing info.json, unsupported
  codebase_version, illegal hyperparameters, dimension-contract mismatch,
  unwritable output directory — all exit 2 with the [smolvla] FAIL line;
- the real training path refuses to start without the full stack (or,
  with the stack installed, without CUDA), naming the exact missing
  package and its install command;
- engine mode follows the mjlab-rsl-rl-adapter precedent: a missing
  training stack is REFUSED with exit 3 and NO result.json; with the stack
  present (simulated via the importability probe), the full result
  contract is written — artifact:// refs matching the worker's regex,
  dry-run-labeled metrics, a training-plan.json artifact covered by
  SHA256SUMS;
- the plan summary schema: episodes, dimensions, mode, strategy,
  hyperparameters, planned steps.
"""

import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "train_smolvla.py")
LOCK_PATH = os.path.join(HERE, "requirements.txt")

sys.path.insert(0, HERE)

import train_smolvla  # noqa: E402  (after the sys.path insert)

# Mirrors the worker's artifactRef contract regex
# (services/sim2real-web/local-training-worker.mjs resultArtifact): an
# engine-mode result that fails this pattern is treated by the platform as
# a failed run, so the tests assert the same shape.
ARTIFACT_REF_RE = re.compile(
    r"^artifact://[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}"
    r"(?:/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}){0,8}$"
)

try:
    import pyarrow  # noqa: F401

    PYARROW_AVAILABLE = True
except ImportError:
    PYARROW_AVAILABLE = False

TRAINING_STACK_MISSING = train_smolvla.missing_training_dependencies()


def _importable(name):
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, ModuleNotFoundError):
        return False


def _cuda_available():
    if not _importable("torch"):
        return None
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return None


def run_cli(*argv, env=None):
    """Run the engine CLI in a subprocess and return the CompletedProcess."""
    environment = dict(os.environ)
    environment.pop("RDK_SIM2REAL_REQUEST_FILE", None)
    environment.pop("RDK_SIM2REAL_RESULT_FILE", None)
    if env:
        environment.update(env)
    return subprocess.run(
        [sys.executable, ENGINE, *[str(a) for a in argv]],
        capture_output=True,
        text=True,
        timeout=180,
        env=environment,
    )


def build_dataset(
    root,
    episodes=2,
    steps=10,
    state_dim=7,
    action_dim=7,
    codebase_version="v2.1",
    with_parquet=True,
    task="pick up the red cube",
):
    """Minimal LeRobot dataset directory.

    meta/info.json + meta/episodes.jsonl are always real (that is the
    structure contract); the parquet files are real when pyarrow is
    installed, otherwise fake bytes — which the engine never opens without
    pyarrow, exactly the degraded path the tests exercise. On a machine
    WITH pyarrow the same builder writes readable parquet so the deep
    inspection path is covered too.
    """
    root = pathlib.Path(root)
    meta = root / "meta"
    data = root / "data" / "chunk-000"
    meta.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)
    info = {
        "codebase_version": codebase_version,
        "robot_type": "test-arm",
        "total_episodes": episodes,
        "total_frames": episodes * steps,
        "total_tasks": 1,
        "features": {
            "observation.state": {"dtype": "float32", "shape": [state_dim], "names": None},
            "action": {"dtype": "float32", "shape": [action_dim], "names": None},
            "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            "frame_index": {"dtype": "int64", "shape": [1], "names": None},
            "timestamp": {"dtype": "float32", "shape": [1], "names": None},
        },
    }
    (meta / "info.json").write_text(json.dumps(info), encoding="utf-8")
    rows = [
        {"episode_index": index, "tasks": [task], "length": steps}
        for index in range(episodes)
    ]
    (meta / "episodes.jsonl").write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8"
    )
    (meta / "tasks.jsonl").write_text("0\t%s\n" % task, encoding="utf-8")
    if with_parquet:
        for index in range(episodes):
            path = data / ("episode_%06d.parquet" % index)
            if PYARROW_AVAILABLE:
                import pyarrow as pa
                import pyarrow.parquet as pq

                states = [
                    [math.sin(0.1 * (t + 1) + 0.3 * j + index) for j in range(state_dim)]
                    for t in range(steps)
                ]
                actions = [
                    [math.cos(0.1 * (t + 1) + 0.2 * j + index) for j in range(action_dim)]
                    for t in range(steps)
                ]
                table = pa.table(
                    {
                        "observation.state": states,
                        "action": actions,
                        "episode_index": [index] * steps,
                        "frame_index": list(range(steps)),
                        "timestamp": [0.02 * t for t in range(steps)],
                    }
                )
                pq.write_table(table, path.as_posix())
            else:
                path.write_bytes(b"FAKE-PARQUET-FOR-STRUCTURE-CHECK")
    return root


def make_request(path, observation_size=34, action_size=7, dataset_path=None):
    """A worker file-protocol request, in the same shape engines/act reads."""
    request = {
        "schemaVersion": 1,
        "contract": {
            "id": "smolvla-plan-test",
            "observationSize": observation_size,
            "actionSize": action_size,
        },
        "model": {"modelId": "lerobot/smolvla_base", "version": "0.1.0"},
        "training": {"maxIterations": 2, "batchSize": 4, "loraR": 32, "seed": 0},
    }
    if dataset_path is not None:
        request["dataset"] = {"path": str(dataset_path)}
    pathlib.Path(path).write_text(json.dumps(request), encoding="utf-8")
    return path


class ScratchDir:
    """tempfile.TemporaryDirectory that survives permission-bit cleanup."""

    def __enter__(self):
        self._tmp = tempfile.mkdtemp(prefix="smolvla-test-")
        return pathlib.Path(self._tmp)

    def __exit__(self, *_args):
        def onerror(func, path, _info):
            try:
                os.chmod(os.path.dirname(path) if os.path.isfile(path) else path, 0o755)
                func(path)
            except OSError:
                pass

        shutil.rmtree(self._tmp, onerror=onerror if sys.version_info < (3, 12) else False)
        return False


class DryRunCliTest(unittest.TestCase):
    """The dry-run plan contract over the real CLI."""

    def test_cli_dry_run_end_to_end_summary(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", episodes=2, steps=10, state_dim=7, action_dim=7)
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run", "--epochs", 5, "--batch", 4)
            self.assertEqual(process.returncode, 0, process.stderr)
            # Exactly one stdout line, and it is the JSON plan.
            lines = [line for line in process.stdout.splitlines() if line.strip()]
            self.assertEqual(len(lines), 1, "dry-run stdout must be a single JSON line")
            plan = json.loads(lines[0])
            self.assertEqual(plan["engine"], "smolvla")
            self.assertEqual(plan["mode"], "dry-run")
            self.assertEqual(plan["status"], "planned")
            self.assertEqual(plan["dataset"]["codebaseVersion"], "v2.1")
            self.assertEqual(plan["dataset"]["episodes"], 2)
            self.assertEqual(plan["dataset"]["frames"], 20)
            self.assertEqual(plan["dataset"]["stateDim"], 7)
            self.assertEqual(plan["dataset"]["actionDim"], 7)
            self.assertEqual(plan["dataset"]["parquetFiles"], 2)
            self.assertEqual(plan["model"]["modelId"], "lerobot/smolvla_base")
            self.assertEqual(plan["model"]["finetuneStrategy"], "lora")
            self.assertEqual(plan["model"]["loraR"], 32)
            self.assertEqual(plan["hyperparameters"]["epochs"], 5)
            self.assertEqual(plan["hyperparameters"]["batch"], 4)
            self.assertEqual(plan["plannedSteps"], int(math.ceil(20 / 4) * 5))
            # The plan tells the operator whether this machine could run it.
            self.assertIn("environment", plan)
            self.assertIn("cuda", plan["environment"])
            self.assertIn("missingDependencies", plan["environment"])

    def test_cli_dry_run_full_finetune_flag(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run", "--lora-r", 0)
            self.assertEqual(process.returncode, 0, process.stderr)
            plan = json.loads(process.stdout.strip())
            self.assertEqual(plan["model"]["finetuneStrategy"], "full")
            self.assertEqual(plan["model"]["loraR"], 0)

    def test_cli_dry_run_writes_result_json_without_artifact(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", episodes=3, steps=8, state_dim=6, action_dim=5)
            out = tmp / "out"
            process = run_cli(dataset, "--out", out, "--dry-run")
            self.assertEqual(process.returncode, 0, process.stderr)
            result_path = out / "result.json"
            self.assertTrue(result_path.is_file(), "dry-run writes result.json")
            doc = json.loads(result_path.read_text())
            self.assertEqual(doc["status"], "completed")
            self.assertEqual(doc["mode"], "dry-run")
            self.assertTrue(doc["dryRun"])
            self.assertTrue(doc["metrics"]["dryRun"])
            self.assertEqual(doc["metrics"]["episodes"], 3)
            self.assertEqual(doc["metrics"]["frames"], 24)
            self.assertEqual(doc["metrics"]["stateDim"], 6)
            self.assertEqual(doc["metrics"]["actionDim"], 5)
            self.assertNotIn("artifact", doc, "dry-run never writes an artifact block")
            self.assertNotIn("checkpoint", doc, "dry-run never writes a checkpoint block")
            self.assertFalse(doc["deployable"])
            self.assertIn("dependencyLockSha256", doc)
            # No weights: the artifact contract only applies to a real run.
            self.assertFalse((out / "weights").exists())

    def test_cli_dry_run_meta_only_degrades_but_passes(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", episodes=2, steps=10, with_parquet=False)
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run")
            self.assertEqual(process.returncode, 0, process.stderr)
            plan = json.loads(process.stdout.strip())
            self.assertFalse(plan["dataset"]["parquetVerified"])
            self.assertEqual(plan["dataset"]["parquetFiles"], 0)
            self.assertEqual(plan["dataset"]["episodes"], 2)
            self.assertEqual(plan["dataset"]["frames"], 20)
            self.assertEqual(plan["dataset"]["stateDim"], 7)
            self.assertTrue(plan["dataset"]["notes"], "degradation must be noted, never silent")

    def test_cli_dry_run_expect_dims_pass(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", state_dim=7, action_dim=7)
            process = run_cli(
                dataset, "--out", tmp / "out", "--dry-run",
                "--expect-state-dim", 7, "--expect-action-dim", 7,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            plan = json.loads(process.stdout.strip())
            self.assertEqual(plan["expectations"]["stateDimCheck"], "pass")
            self.assertEqual(plan["expectations"]["actionDimCheck"], "pass")

    def test_cli_dry_run_expect_dim_mismatch_fails(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", state_dim=7)
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run", "--expect-state-dim", 8)
            self.assertEqual(process.returncode, 2)
            self.assertIn("[smolvla] FAIL", process.stderr)
            self.assertIn("state dimension", process.stderr)

    def test_cli_dry_run_codebase_v3_accepted(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", codebase_version="v3.0")
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run")
            self.assertEqual(process.returncode, 0, process.stderr)
            plan = json.loads(process.stdout.strip())
            self.assertEqual(plan["dataset"]["codebaseVersion"], "v3.0")

    def test_dry_run_result_records_lock_digest_when_shipped(self):
        # requirements.txt is generated by the main session (lock:engines);
        # assert the digest only when the lock actually ships beside this
        # engine.
        if not os.path.exists(LOCK_PATH):
            self.skipTest("requirements.txt not generated yet (main session owns it)")
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            out = tmp / "out"
            process = run_cli(dataset, "--out", out, "--dry-run")
            self.assertEqual(process.returncode, 0, process.stderr)
            doc = json.loads((out / "result.json").read_text())
            digest = doc["dependencyLockSha256"]
            self.assertIsInstance(digest, str)
            self.assertRegex(digest, r"^[a-f0-9]{64}$")


class FailClosedCliTest(unittest.TestCase):
    """Every illegal input exits 2 with the [smolvla] FAIL line."""

    def _assert_fail(self, process, fragment=None):
        self.assertEqual(process.returncode, 2)
        self.assertIn("[smolvla] FAIL", process.stderr)
        if fragment:
            self.assertIn(fragment, process.stderr)

    def test_dataset_dir_missing(self):
        with ScratchDir() as tmp:
            process = run_cli(tmp / "no-such-dataset", "--out", tmp / "out", "--dry-run")
            self._assert_fail(process, "does not exist")

    def test_info_json_missing(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            (pathlib.Path(dataset) / "meta" / "info.json").unlink()
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run")
            self._assert_fail(process, "meta/info.json")

    def test_codebase_v1_rejected(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", codebase_version="v1.0")
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run")
            self._assert_fail(process, "codebase_version")
            self.assertIn("v1.0", process.stderr)

    def test_epochs_zero_rejected(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run", "--epochs", 0)
            self._assert_fail(process, "epochs")

    def test_lora_r_negative_rejected(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run", "--lora-r", -4)
            self._assert_fail(process, "lora-r")

    def test_batch_zero_rejected(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            process = run_cli(dataset, "--out", tmp / "out", "--dry-run", "--batch", 0)
            self._assert_fail(process, "batch")

    def test_output_dir_not_writable(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            out = tmp / "out"
            out.mkdir()
            os.chmod(out, 0o555)
            try:
                process = run_cli(dataset, "--out", out, "--dry-run")
                self._assert_fail(process, "not writable")
            finally:
                os.chmod(out, 0o755)


class RealPathEnvironmentCheckTest(unittest.TestCase):
    """The real training path fails closed before any expensive work."""

    def test_real_path_fails_closed_without_full_stack_or_gpu(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            process = run_cli(dataset, "--out", tmp / "out")
            if TRAINING_STACK_MISSING:
                self.assertEqual(process.returncode, 2)
                self.assertIn("[smolvla] FAIL", process.stderr)
                first = TRAINING_STACK_MISSING[0]
                self.assertIn(
                    "missing dependency: %s" % first,
                    process.stderr,
                    "the failure must name the exact missing package",
                )
                self.assertIn("pip install", process.stderr)
            elif not _cuda_available():
                self.assertEqual(process.returncode, 2)
                self.assertIn("[smolvla] FAIL", process.stderr)
                self.assertIn("CUDA", process.stderr)
                self.assertIn("GPU", process.stderr)
            else:
                self.skipTest(
                    "full GPU training stack available; real training is not "
                    "exercised in unit tests"
                )


class EngineModeTest(unittest.TestCase):
    """File-protocol round: mjlab-precedent refusal and full plan result."""

    def test_engine_mode_refused_without_training_stack(self):
        # mjlab precedent: REFUSED on stderr, exit 3, and NO result.json —
        # the worker must see a failed job, never a fabricated completion.
        if not TRAINING_STACK_MISSING:
            self.skipTest("training stack fully importable on this machine")
        with ScratchDir() as tmp:
            request = make_request(tmp / "request.json")
            result = tmp / "result.json"
            process = subprocess.run(
                [sys.executable, ENGINE],
                capture_output=True,
                text=True,
                timeout=180,
                env={
                    **os.environ,
                    "RDK_SIM2REAL_REQUEST_FILE": str(request),
                    "RDK_SIM2REAL_RESULT_FILE": str(result),
                },
            )
            self.assertEqual(process.returncode, 3, process.stderr)
            self.assertIn("[smolvla] REFUSED", process.stderr)
            self.assertIn("pip install", process.stderr)
            self.assertIn(
                "never fabricates a completed training run", process.stderr
            )
            self.assertFalse(result.exists(), "refusal writes no result.json")

    def test_engine_mode_writes_full_result_contract(self):
        # With the stack importable (simulated through the probe seam), the
        # full result.json is written: artifact:// refs that satisfy the
        # worker's regex, dry-run-labeled metrics, real provenance, and a
        # training-plan.json artifact covered by SHA256SUMS.
        with ScratchDir() as tmp:
            job = tmp / "job"
            job.mkdir()
            request = make_request(job / "request.json", observation_size=34, action_size=7)
            result = job / "result.json"
            original = train_smolvla.missing_training_dependencies
            train_smolvla.missing_training_dependencies = lambda probe=None: []
            try:
                train_smolvla.run_engine_mode(
                    request_path=str(request), result_path=str(result), workdir=str(job)
                )
            finally:
                train_smolvla.missing_training_dependencies = original
            self.assertTrue(result.is_file())
            doc = json.loads(result.read_text())
            self.assertEqual(doc["status"], "completed")
            self.assertEqual(doc["engine"], "smolvla")
            self.assertEqual(doc["mode"], "engine-plan")
            self.assertTrue(doc["dryRun"])
            self.assertTrue(doc["metrics"]["dryRun"])
            self.assertTrue(doc["metrics"]["contractValid"])
            self.assertTrue(doc["metrics"]["synthetic"])
            self.assertEqual(doc["metrics"]["observationSize"], 34)
            self.assertEqual(doc["metrics"]["actionSize"], 7)
            self.assertEqual(doc["dataset"]["source"], "engine-plan-synthetic")
            self.assertRegex(doc["checkpoint"]["artifactRef"], ARTIFACT_REF_RE)
            self.assertRegex(doc["artifact"]["artifactRef"], ARTIFACT_REF_RE)
            self.assertTrue(doc["artifact"]["planOnly"])
            self.assertFalse(doc["deployable"])
            self.assertIn("cuda", doc)
            self.assertIn("source", doc)
            self.assertIn("dependencyLockSha256", doc)
            self.assertLessEqual(
                set(doc["dependencies"]),
                {"numpy", "torch", "transformers", "accelerate", "peft", "pyarrow"},
                "only really installed packages may be reported",
            )
            # The plan document is a real artifact, manifest-covered.
            plan_path = job / "training-plan.json"
            self.assertTrue(plan_path.is_file())
            self.assertEqual(doc["artifact"]["sizeBytes"], plan_path.stat().st_size)
            manifest = (job / "SHA256SUMS").read_text()
            self.assertIn("training-plan.json", manifest)
            self.assertNotIn("request.json", manifest)
            self.assertNotIn("result.json", manifest)

    def test_engine_mode_inspects_request_dataset(self):
        # A request that carries a real dataset directory plans against the
        # real data (labeled request-dataset, synthetic=false).
        with ScratchDir() as tmp:
            job = tmp / "job"
            job.mkdir()
            dataset = build_dataset(tmp / "ds", episodes=2, steps=10, state_dim=7, action_dim=7)
            request = make_request(job / "request.json", dataset_path=dataset)
            result = job / "result.json"
            original = train_smolvla.missing_training_dependencies
            train_smolvla.missing_training_dependencies = lambda probe=None: []
            try:
                train_smolvla.run_engine_mode(
                    request_path=str(request), result_path=str(result), workdir=str(job)
                )
            finally:
                train_smolvla.missing_training_dependencies = original
            doc = json.loads(result.read_text())
            self.assertEqual(doc["dataset"]["source"], "request-dataset")
            self.assertFalse(doc["dataset"]["synthetic"])
            self.assertEqual(doc["dataset"]["episodes"], 2)
            self.assertEqual(doc["dataset"]["frames"], 20)

    def test_engine_mode_rejects_bad_schema(self):
        with ScratchDir() as tmp:
            request = tmp / "request.json"
            request.write_text(json.dumps({"schemaVersion": 2}))
            with self.assertRaises(ValueError):
                train_smolvla.run_engine_mode(
                    request_path=str(request),
                    result_path=str(tmp / "result.json"),
                    workdir=str(tmp),
                )

    def test_engine_mode_requires_contract_dimensions(self):
        # The contract check runs after the stack gate (mjlab ordering), so
        # simulate an importable stack to reach the validation itself.
        with ScratchDir() as tmp:
            request = tmp / "request.json"
            request.write_text(
                json.dumps({"schemaVersion": 1, "contract": {"observationSize": 0, "actionSize": 7}})
            )
            original = train_smolvla.missing_training_dependencies
            train_smolvla.missing_training_dependencies = lambda probe=None: []
            try:
                with self.assertRaises(ValueError):
                    train_smolvla.run_engine_mode(
                        request_path=str(request),
                        result_path=str(tmp / "result.json"),
                        workdir=str(tmp),
                    )
            finally:
                train_smolvla.missing_training_dependencies = original


class UnitContractTest(unittest.TestCase):
    """Pure-function contracts, no subprocess."""

    def test_hyperparameter_validation_rules(self):
        cases = [
            (0, 1e-4, 16, 32),  # epochs <= 0
            (50, 1e-4, 0, 32),  # batch <= 0
            (50, 1e-4, 16, -1),  # lora-r < 0
            (50, 0.0, 16, 32),  # lr <= 0
            (50, float("nan"), 16, 32),  # lr NaN
        ]
        for epochs, lr, batch, lora_r in cases:
            with self.assertRaises(ValueError):
                train_smolvla.validate_hyperparameters(epochs, lr, batch, lora_r)
        # Legal values pass, including full fine-tuning (lora_r == 0).
        train_smolvla.validate_hyperparameters(50, 1e-4, 16, 0)
        train_smolvla.validate_hyperparameters(1, 1.0, 1, 64)

    def test_missing_dependency_message_matches_platform_contract(self):
        message = train_smolvla._missing_dependency_message(["transformers"])
        self.assertEqual(
            message,
            "missing dependency: transformers. Install with: "
            "python3 -m pip install transformers accelerate peft",
        )

    def test_missing_probe_reports_the_gap(self):
        # Simulate a machine where only transformers is missing.
        missing = train_smolvla.missing_training_dependencies(
            probe=lambda name: name != "transformers"
        )
        self.assertEqual(missing, ["transformers"])
        # And one where the whole family is absent: first gap in gate order.
        missing = train_smolvla.missing_training_dependencies(probe=lambda name: False)
        self.assertEqual(missing, [name for name, _ in train_smolvla.TRAINING_STACK])

    def test_inspect_dataset_rejects_unsupported_codebase(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", codebase_version="v1.0")
            with self.assertRaises(ValueError):
                train_smolvla.inspect_dataset(dataset)

    def test_inspect_dataset_expectation_unknown_when_dims_missing(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", with_parquet=False)
            info_path = pathlib.Path(dataset) / "meta" / "info.json"
            info = json.loads(info_path.read_text())
            del info["features"]
            info_path.write_text(json.dumps(info))
            block = train_smolvla.inspect_dataset(
                dataset, expect_state_dim=7, expect_action_dim=None
            )
            self.assertIsNone(block["stateDim"])
            self.assertIn(
                "--expect-state-dim set but state dimension unknown: not verified",
                block["notes"],
            )


@unittest.skipUnless(PYARROW_AVAILABLE, "pyarrow not installed")
class PyarrowInspectionTest(unittest.TestCase):
    """The deep parquet inspection path (machines with pyarrow)."""

    def test_parquet_facts_verified(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds", episodes=2, steps=10, state_dim=7, action_dim=7)
            block = train_smolvla.inspect_dataset(dataset)
            self.assertTrue(block["parquetVerified"])
            self.assertEqual(block["dimensionSource"], "parquet-schema")
            self.assertEqual(block["frames"], 20)
            self.assertEqual(block["stateDim"], 7)
            self.assertEqual(block["actionDim"], 7)

    def test_unreadable_parquet_fails_closed(self):
        with ScratchDir() as tmp:
            dataset = build_dataset(tmp / "ds")
            for path in (pathlib.Path(dataset) / "data" / "chunk-000").glob("*.parquet"):
                path.write_bytes(b"not actually parquet")
            with self.assertRaises(ValueError):
                train_smolvla.inspect_dataset(dataset)

    def test_missing_required_column_fails_closed(self):
        with ScratchDir() as tmp:
            import pyarrow as pa
            import pyarrow.parquet as pq

            dataset = build_dataset(tmp / "ds", episodes=1, steps=4)
            table = pa.table({"observation.state": [[0.0] * 7 for _ in range(4)]})
            pq.write_table(
                table,
                (pathlib.Path(dataset) / "data" / "chunk-000" / "episode_000000.parquet").as_posix(),
            )
            with self.assertRaises(ValueError):
                train_smolvla.inspect_dataset(dataset)


if __name__ == "__main__":
    unittest.main(verbosity=2)
