#!/usr/bin/env python3
"""SmolVLA fine-tuning entry — a reference adapter for a bring-your-own-GPU stack.

SmolVLA (HuggingFace / LeRobot, ~450M parameters) is a vision-language-action
model that fine-tunes on a single GPU and reaches 87.3% on the LIBERO
benchmark. This engine is the platform's P2 "SmolVLA fine-tuning entry": like
engines/mjlab-rsl-rl-adapter, it is a REFERENCE ADAPTER — the integration
capability is real, the production compute belongs to the deployment. The
development machine (macOS, no GPU) can never fine-tune a 450M VLA, so this
file's value contract is:

  * the real fine-tuning code path delegates to lerobot's own trainer
    (`python -m lerobot.scripts.lerobot_train`) with this engine providing
    the gates (dependency, CUDA, dataset inspection), the dataset wiring
    (`--dataset.root` = the converted LeRobot directory), the pretrained
    policy (`--policy.path`, default `lerobot/smolvla_base`), honest
    pass-through of the trainer's progress lines, and the platform's
    result.json/artifact contract — not a hand-rolled loop against
    guessed APIs;
  * `--dry-run` validates the complete training plan on a machine with no
    network, no GPU and no weights: LeRobot dataset structure
    (codebase_version, episodes, frames, observation.state/action
    dimensions), hyperparameter and LoRA legality, output writability —
    then prints a one-line JSON plan to stdout and exits 0;
  * when the environment cannot support real training, the engine fails
    CLOSED with a message naming the exact missing package (and its install
    command) or the missing GPU runner — never a silent skip.

Dependency chain (why the training input is a directory): the dataset is a
LeRobot dataset directory produced by the platform's LeRobot converter
import/export path or downloaded from the Hub; the fine-tune itself runs on
a self-provisioned GPU runner that holds the base weights. X5 boards stay
light clients (the openpi-verified GPU-server inference + thin board-client
pattern); SmolVLA training never happens on the board.

Two modes, like engines/act/train_act.py:

  * engine mode (file protocol): with RDK_SIM2REAL_REQUEST_FILE and
    RDK_SIM2REAL_RESULT_FILE set, the worker protocol drives a PLAN round.
    When the training stack is importable, a full result.json is written —
    contract-complete (artifact:// checkpoint/artifact refs, metrics,
    provenance) and honestly labeled as a dry-run plan with a synthetic
    dataset, plus a training-plan.json artifact covered by SHA256SUMS so the
    worker's bundle manifest verification stays meaningful. When the stack
    is NOT importable, this follows the mjlab-rsl-rl-adapter precedent
    exactly: a stderr REFUSED line naming the package and install command,
    exit code 3, and NO result.json — this engine never fabricates a
    completed training run.
  * CLI mode: `python3 engines/smolvla/train_smolvla.py <dataset-dir>
    --out <dir> [--dry-run] ...` (see `--help` for the full surface).

What was executed where (honesty note): the dry-run/plan path, the dataset
inspection, the fail-closed gates and the file-protocol round run and are
tested on the development machine. The delegate path ran into two real
ecosystem facts while being executed on the GPU runner (2026-09-23): the
`lerobot/smolvla_base` checkpoint is a lerobot policy artifact that
`transformers.AutoModel` cannot load (no native `smolvla` in transformers'
CONFIG_MAPPING, no remote code in the repo), and lerobot's own trainer is
the maintained fine-tuning entry — so the real path delegates to it. The
delegate's CLI flags are `lerobot` 0.4.4's documented train pipeline
arguments.

Register with the local worker:

  RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"smolvla":{"executable":"/usr/bin/python3","args":["/abs/path/to/engines/smolvla/train_smolvla.py"]}}'
"""

import argparse
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

try:
    import numpy as np
except ImportError:  # pragma: no cover - dry-run deliberately needs no numpy
    np = None

ENGINE_NAME = "smolvla"
DEFAULT_MODEL_ID = "lerobot/smolvla_base"
# LeRobot dataset format versions this entry understands. v1.0 layouts
# predate the parquet-per-episode structure the loader relies on, so they
# are refused rather than mis-read.
SUPPORTED_CODEBASE_VERSIONS = ("v2.1", "v3.0")
# SmolVLA's published action-chunk length is 50; the loaded model's config
# wins whenever it exposes a chunk size so chunk targets match the
# checkpoint instead of the published default.
DEFAULT_ACTION_CHUNK = 50

# The training stack this engine requires for real fine-tuning, in gate
# order, each with the exact install command the failure message prints.
#
# Evidence note (2026-09-23, executed on the GPU runner): the checkpoint
# `lerobot/smolvla_base` is a lerobot POLICY artifact (config.json +
# safetensors + lerobot pre/post-processor). `transformers` cannot load it —
# transformers 5.17 has no `smolvla` in CONFIG_MAPPING and the repo ships no
# remote code — so the real path delegates to lerobot's own trainer instead
# of an AutoModel/AutoProcessor loop.
TRAINING_STACK = (
    ("torch", "python3 -m pip install torch (on the GPU runner, prefer the CUDA index build)"),
    ("lerobot", "python3 -m pip install lerobot"),
)
LOADER_PACKAGES = (
    ("numpy", "python3 -m pip install numpy"),
    ("pyarrow", "python3 -m pip install pyarrow"),
)
PROVENANCE_PACKAGES = ("numpy", "torch", "lerobot", "pyarrow")


class MissingDependencyError(RuntimeError):
    """Raised when an import the run needs is absent; main() turns this into
    the `[smolvla] FAIL — missing dependency: ...` contract."""


class GpuUnavailableError(RuntimeError):
    """Raised when real training is requested without CUDA; SmolVLA
    fine-tuning belongs on a GPU runner, not on this host."""


# ---------------------------------------------------------------------------
# Provenance (mirrors the runner engines: source, imported versions, lock).
# ---------------------------------------------------------------------------

def source_revision():
    """Exact revision of the training code that produced this artifact.

    Best-effort by design — a checkout without `.git` (a packaged board
    install, a container) yields `known=False` rather than failing the run
    or inventing an identity. `dirty=True` says the recorded commit does not
    fully describe the code that ran.
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
    """SHA-256 of this engine's shipped requirements.txt, or None when the
    lock is not shipped (the main session generates it via lock:engines).

    Best-effort by design: an absent lock is reported as None rather than
    failing the run or inventing a digest."""
    import hashlib

    lock = pathlib.Path(__file__).with_name("requirements.txt")
    try:
        return hashlib.sha256(lock.read_bytes()).hexdigest()
    except OSError:
        return None


def dependency_versions(packages):
    """Versions of the packages that are actually installed, never the
    requested ones — a result stays auditable after the environment moved
    on. Uses importlib.metadata so nothing is imported to be counted."""
    from importlib import metadata

    def version_of(distribution):
        try:
            return metadata.version(distribution)
        except Exception:  # noqa: BLE001 - a missing library is simply absent
            return None

    resolved = {name: version_of(name) for name in packages}
    return {name: version for name, version in resolved.items() if version is not None}


# ---------------------------------------------------------------------------
# Importability gates.
# ---------------------------------------------------------------------------

def _importable(name):
    """True when `name` can be resolved without executing it (find_spec)."""
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, ModuleNotFoundError):
        return False


def missing_training_dependencies(probe=None):
    """Names (in gate order) of the training-stack packages that are absent.

    `probe` lets tests simulate a machine where one package is missing; it
    defaults to the real find_spec check. Presence is checked, not a
    successful import: the import itself happens right after the gate, so a
    broken installation still fails loudly at the import site.
    """
    if probe is None:
        probe = _importable
    return [name for name, _hint in TRAINING_STACK if not probe(name)]


def _missing_dependency_message(missing):
    """The fail-closed message for the first missing package, in the
    platform's exact `missing dependency: X. Install with: Y` shape."""
    name = missing[0]
    for package, hint in TRAINING_STACK:
        if package == name:
            return "missing dependency: {}. Install with: {}".format(name, hint)
    return "missing dependency: {}. Install with: python3 -m pip install {}".format(name, name)


def _module_version(name):
    from importlib import metadata

    try:
        return metadata.version(name)
    except Exception:  # noqa: BLE001 - absent metadata is simply unknown
        return None


def _cuda_available():
    """Real CUDA probe, tolerant of a missing torch (the engine-mode plan
    path only reaches this after the stack gate; tests bypass that gate)."""
    if not _importable("torch"):
        return None
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001 - probe failure is "unknown", not false
        return None


def environment_probe():
    """What this machine could actually run: installed versions of the
    training stack, a CUDA probe, and the gap list. Recorded in every plan
    so an operator can see whether the plan is executable where it was
    made. No model weights are touched and no network is used."""
    stack = {name: _module_version(name) for name, _hint in TRAINING_STACK}
    stack["pyarrow"] = _module_version("pyarrow")
    missing = [name for name, _hint in TRAINING_STACK if not stack[name]]
    return {
        **stack,
        "cuda": _cuda_available(),
        "trainingStackImportable": not missing,
        "missingDependencies": missing,
    }


# ---------------------------------------------------------------------------
# LeRobot dataset inspection (structure level; pyarrow optional).
# ---------------------------------------------------------------------------

def _read_info_json(root):
    """meta/info.json, validated: a JSON object with a supported
    codebase_version. Unsupported versions are refused, not guessed at."""
    info_path = root / "meta" / "info.json"
    if not info_path.is_file():
        raise ValueError(
            "dataset %s has no meta/info.json: not a LeRobot dataset directory "
            "(expected the converter's export layout or a Hub download)" % root
        )
    try:
        info = json.loads(info_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError("meta/info.json is not valid JSON: %s" % error)
    if not isinstance(info, dict):
        raise ValueError("meta/info.json must contain a JSON object")
    codebase = str(info.get("codebase_version", ""))
    if codebase not in SUPPORTED_CODEBASE_VERSIONS:
        raise ValueError(
            "unsupported LeRobot codebase_version %r (supported: %s); v1.0 "
            "layouts predate the parquet-per-episode structure this engine "
            "loads" % (codebase, ", ".join(SUPPORTED_CODEBASE_VERSIONS))
        )
    return info


def _episode_metadata_rows(root):
    """Rows from meta/episodes.jsonl (v2.1) or meta/episodes/*.jsonl
    (v3.0-chunked). Malformed rows fail closed — an unreadable episode
    manifest is a dataset defect, not a skip."""
    candidates = []
    flat = root / "meta" / "episodes.jsonl"
    if flat.is_file():
        candidates.append(flat)
    chunked_dir = root / "meta" / "episodes"
    if chunked_dir.is_dir():
        candidates.extend(sorted(chunked_dir.glob("*.jsonl")))
    rows = []
    for path in candidates:
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError("%s line %d is not valid JSON: %s" % (path, line_no, error))
            if not isinstance(row, dict):
                raise ValueError("%s line %d must be a JSON object" % (path, line_no))
            rows.append(row)
    return rows


def _episode_tasks(root):
    """episode_index -> task string, from the episodes metadata."""
    tasks = {}
    for row in _episode_metadata_rows(root):
        index = row.get("episode_index")
        values = row.get("tasks")
        if isinstance(index, int) and isinstance(values, list) and values:
            if isinstance(values[0], str) and values[0]:
                tasks[index] = values[0]
    return tasks


def _feature_dim(info, key):
    """Dimension declared in meta/info.json features (e.g.
    features["observation.state"]["shape"] == [7]). None when absent."""
    features = info.get("features")
    if not isinstance(features, dict):
        return None
    feature = features.get(key)
    if not isinstance(feature, dict):
        return None
    shape = feature.get("shape")
    if (
        isinstance(shape, (list, tuple))
        and shape
        and isinstance(shape[0], int)
        and not isinstance(shape[0], bool)
    ):
        return int(shape[0])
    return None


def _parquet_facts(parquet_files):
    """(frames, state_dim, action_dim) read through pyarrow.

    One file = one episode in both supported layouts. Column mapping is the
    training contract: a file lacking observation.state or action is
    refused. Dimension consistency across files is enforced — a dataset
    whose episodes disagree about its own width cannot be trained on."""
    import pyarrow.parquet as pq  # noqa: PLC0415 - lazy: dry-run runs without it

    frames = 0
    state_dim = None
    action_dim = None
    for path in parquet_files:
        try:
            handle = pq.ParquetFile(path.as_posix())
        except Exception as error:  # noqa: BLE001 - any parquet decode failure
            raise ValueError(
                "parquet file %s is unreadable (%s): the real training path "
                "loads it, so the plan refuses now instead of failing later"
                % (path, error)
            )
        names = set(handle.schema_arrow.names)
        for column in ("observation.state", "action"):
            if column not in names:
                raise ValueError(
                    "parquet file %s lacks the required column %r (the LeRobot "
                    "state/action mapping)" % (path, column)
                )
        frames += handle.metadata.num_rows
        first = next(handle.iter_batches(batch_size=1, columns=["observation.state", "action"]), None)
        if first is None:
            raise ValueError("parquet file %s has zero rows: an empty episode cannot be trained on" % path)
        state_row = first.column(0)[0].as_py()
        action_row = first.column(1)[0].as_py()
        if not isinstance(state_row, (list, tuple)) or not isinstance(action_row, (list, tuple)):
            raise ValueError(
                "parquet file %s: observation.state/action columns must be "
                "lists (one entry per frame dimension)" % path
            )
        file_state_dim = len(state_row)
        file_action_dim = len(action_row)
        if state_dim is None:
            state_dim, action_dim = file_state_dim, file_action_dim
        elif file_state_dim != state_dim or file_action_dim != action_dim:
            raise ValueError(
                "parquet file %s has dimensions %dx%d but earlier episodes "
                "declared %dx%d: inconsistent dataset" % (path, file_state_dim, file_action_dim, state_dim, action_dim)
            )
    return frames, state_dim, action_dim


def _check_expectation(label, expected, actual, dimension_source):
    """Validate an explicitly expected dimension against what the dataset
    says. Returns a status string for the plan; mismatches raise."""
    if expected is None:
        return "not-set"
    expected = int(expected)
    if actual is None:
        return "unverified-unknown-dim"
    if expected != actual:
        raise ValueError(
            "dataset %s dimension is %d but --expect-%s-dim was %d (dimension "
            "source: %s): a contract mismatch is refused, never tuned away"
            % (label, actual, label, expected, dimension_source or "unknown")
        )
    return "pass"


def inspect_dataset(dataset_dir, expect_state_dim=None, expect_action_dim=None):
    """Structure-level validation of a LeRobot dataset directory.

    Returns the dataset block of the training plan. Fail-closed conditions
    (ValueError): directory missing, info.json missing/invalid,
    unsupported codebase_version, unreadable parquet (when pyarrow is
    present), missing state/action columns, dimension inconsistency,
    expected-dimension mismatch, zero episodes.

    Degradation is honest, never silent: without pyarrow the parquet-level
    facts are skipped and a note says so (dimensions fall back to the
    info.json feature shapes, frames to the episodes metadata lengths); a
    directory with metadata but no parquet files passes the structure check
    with a note, because the dry-run's job is to validate the plan shape.
    """
    root = pathlib.Path(dataset_dir)
    if not root.is_dir():
        raise ValueError(
            "dataset directory %s does not exist (expected a LeRobot dataset "
            "directory: the converter's export output or a Hub download)" % root
        )
    info = _read_info_json(root)
    codebase = str(info.get("codebase_version"))
    notes = []

    episodes_rows = _episode_metadata_rows(root)
    episodes_meta_count = len(episodes_rows)
    lengths = []
    for row in episodes_rows:
        length = row.get("length")
        if isinstance(length, int) and not isinstance(length, bool) and length >= 0:
            lengths.append(length)
    frames_from_meta = sum(lengths) if len(lengths) == episodes_meta_count and episodes_meta_count else None

    data_dir = root / "data"
    parquet_files = sorted(data_dir.rglob("*.parquet")) if data_dir.is_dir() else []

    frames = None
    state_dim = None
    action_dim = None
    dimension_source = None
    parquet_verified = False

    if parquet_files and _importable("pyarrow"):
        frames, state_dim, action_dim = _parquet_facts(parquet_files)
        parquet_verified = True
        dimension_source = "parquet-schema"
    elif parquet_files:
        notes.append(
            "pyarrow is not installed: parquet-level validation skipped "
            "(structure-only plan; install with: python3 -m pip install pyarrow)"
        )
    else:
        notes.append(
            "no parquet files under data/: dataset carries metadata only "
            "(degraded structure check)"
        )

    if state_dim is None:
        fallback_state = _feature_dim(info, "observation.state")
        fallback_action = _feature_dim(info, "action")
        if fallback_state is not None or fallback_action is not None:
            state_dim, action_dim = fallback_state, fallback_action
            dimension_source = "info-json-features"
    if state_dim is None:
        notes.append(
            "observation.state/action dimensions unknown (neither parquet "
            "schema nor info.json features declare them)"
        )

    if frames is None:
        frames = frames_from_meta
        if frames is not None:
            notes.append("frame count from episodes metadata lengths (parquet not read)")

    episodes = len(parquet_files) if parquet_files else episodes_meta_count
    if parquet_files and episodes_meta_count and episodes_meta_count != len(parquet_files):
        notes.append(
            "episodes metadata lists %d episodes but data/ holds %d parquet "
            "files; the plan counts parquet files" % (episodes_meta_count, len(parquet_files))
        )
    if episodes <= 0:
        raise ValueError(
            "dataset %s contains no episodes (neither parquet files nor "
            "episodes metadata): nothing to fine-tune on" % root
        )

    state_check = _check_expectation("state", expect_state_dim, state_dim, dimension_source)
    if state_check == "unverified-unknown-dim":
        notes.append("--expect-state-dim set but state dimension unknown: not verified")
    action_check = _check_expectation("action", expect_action_dim, action_dim, dimension_source)
    if action_check == "unverified-unknown-dim":
        notes.append("--expect-action-dim set but action dimension unknown: not verified")

    return {
        "path": str(root),
        "codebaseVersion": codebase,
        "episodes": int(episodes),
        "frames": int(frames) if frames is not None else None,
        "stateDim": int(state_dim) if state_dim is not None else None,
        "actionDim": int(action_dim) if action_dim is not None else None,
        "dimensionSource": dimension_source,
        "parquetFiles": len(parquet_files),
        "parquetVerified": parquet_verified,
        "episodesMetadataRows": episodes_meta_count,
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Shared helpers: hyperparameter legality, output writability, slugs.
# ---------------------------------------------------------------------------

def validate_hyperparameters(epochs, lr, batch, lora_r):
    """Fail closed on illegal hyperparameters BEFORE any work is budgeted.
    Both the dry-run plan and the real run run this — a plan with epochs=0
    is as dishonest as a training run with it."""
    if not isinstance(epochs, int) or epochs <= 0:
        raise ValueError("epochs must be a positive integer, got %r" % (epochs,))
    if not isinstance(batch, int) or batch <= 0:
        raise ValueError("batch must be a positive integer, got %r" % (batch,))
    if not isinstance(lora_r, int) or lora_r < 0:
        raise ValueError("lora-r must be >= 0 (0 = full fine-tune), got %r" % (lora_r,))
    if not isinstance(lr, (int, float)) or not math.isfinite(float(lr)) or float(lr) <= 0.0:
        raise ValueError("lr must be a positive finite number, got %r" % (lr,))


def ensure_output_writable(out_dir):
    """Create the output directory and PROVE it is writable by writing and
    removing a probe file. os.access lies about ACLs; a real write does not."""
    root = pathlib.Path(out_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe = root / ".smolvla-write-probe"
        probe.write_text("probe", encoding="utf-8")
        probe.unlink()
    except OSError as error:
        raise ValueError("output directory %s is not writable (%s)" % (out_dir, error))


def safe_slug(value, fallback):
    """Filesystem-safe identifier for artifact refs (mirrors the runner
    engines: only [A-Za-z0-9._-], capped, never empty)."""
    slug = "".join(ch if (ch.isalnum() or ch in "._-") else "-" for ch in str(value)).strip("-")
    return slug[:48] or fallback


def write_artifact_manifest(directory):
    """SHA256SUMS covering every file this run produced in `directory`.

    Adapted from the mjlab adapter's bundle contract: a run's outputs travel
    together, so the manifest hashes the produced files as a set and the
    consumer refuses the bundle on any mismatch. The line format is the
    worker's flat-file shape (`<sha256>  <name>`, no subdirectories) —
    request.json is an input and result.json/SHA256SUMS are protocol files,
    so all three are excluded. Raises when there is nothing to record:
    an empty manifest would read as "verified nothing"."""
    import hashlib

    directory = os.path.abspath(directory)
    excluded = {"SHA256SUMS", "result.json", "request.json"}
    lines = []
    for name in sorted(os.listdir(directory)):
        if name in excluded or os.sep in name or name.startswith("."):
            continue
        path = os.path.join(directory, name)
        try:
            if not os.path.isfile(path):
                continue
            digest = hashlib.sha256()
            with open(path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
        except OSError:
            # A file that cannot be read is not listed; inventing an entry
            # would make the manifest unverifiable.
            continue
        lines.append("%s  %s" % (digest.hexdigest(), name))
    if not lines:
        raise RuntimeError("no artifacts to record in SHA256SUMS under %s" % directory)
    target = os.path.join(directory, "SHA256SUMS")
    with open(target, "w") as handle:
        handle.write("\n".join(lines) + "\n")
    return target


def _planned_steps(frames, batch, epochs):
    """Optimizer steps the plan would run, or None when frames are unknown."""
    if not frames:
        return None
    return int(math.ceil(frames / float(batch)) * epochs)


def _finetune_strategy(lora_r):
    return "lora" if lora_r > 0 else "full"


def _model_block(model_id, lora_r):
    return {
        "modelId": model_id,
        "finetuneStrategy": _finetune_strategy(lora_r),
        "loraR": int(lora_r),
    }


def _hyperparameter_block(epochs, lr, batch, seed):
    return {"epochs": int(epochs), "lr": float(lr), "batch": int(batch), "seed": int(seed)}


# ---------------------------------------------------------------------------
# CLI: dry-run plan mode.
# ---------------------------------------------------------------------------

def run_dry_run(args):
    """Validate the full training plan without network, GPU or weights.

    Prints exactly one line to stdout — the JSON plan — and writes
    <out>/result.json with status "completed" and metrics.dryRun true. No
    artifact is produced: the artifact contract (artifact:// weights) only
    applies to a real run."""
    ensure_output_writable(args.out)
    dataset = inspect_dataset(args.dataset, args.expect_state_dim, args.expect_action_dim)
    environment = environment_probe()
    notes = list(dataset["notes"])
    if args.push_to_hub:
        notes.append("--push-to-hub is ignored in dry-run (nothing is uploaded)")

    planned_steps = _planned_steps(dataset["frames"], args.batch, args.epochs)
    if planned_steps is None:
        notes.append("plannedSteps unknown: frame count unavailable in this degraded check")

    plan = {
        "engine": ENGINE_NAME,
        "mode": "dry-run",
        "status": "planned",
        "dataset": dataset,
        "model": _model_block(args.model_id, args.lora_r),
        "hyperparameters": _hyperparameter_block(args.epochs, args.lr, args.batch, args.seed),
        "expectations": {
            "stateDim": args.expect_state_dim,
            "stateDimCheck": (
                "not-set" if args.expect_state_dim is None else
                "pass" if dataset["stateDim"] is not None else
                "unverified-unknown-dim"
            ),
            "actionDim": args.expect_action_dim,
            "actionDimCheck": (
                "not-set" if args.expect_action_dim is None else
                "pass" if dataset["actionDim"] is not None else
                "unverified-unknown-dim"
            ),
        },
        "plannedSteps": planned_steps,
        "environment": environment,
        "notes": notes,
        "outDir": os.path.abspath(args.out),
    }

    result = {
        "schemaVersion": 1,
        "status": "completed",
        "mock": False,
        "engine": ENGINE_NAME,
        "mode": "dry-run",
        "dryRun": True,
        "model": plan["model"],
        "dataset": dataset,
        "hyperparameters": plan["hyperparameters"],
        "metrics": {
            "dryRun": True,
            "engine": ENGINE_NAME,
            "modelId": args.model_id,
            "finetuneStrategy": plan["model"]["finetuneStrategy"],
            "loraR": int(args.lora_r),
            "codebaseVersion": dataset["codebaseVersion"],
            "episodes": dataset["episodes"],
            "frames": dataset["frames"],
            "stateDim": dataset["stateDim"],
            "actionDim": dataset["actionDim"],
            "parquetVerified": dataset["parquetVerified"],
            "epochs": int(args.epochs),
            "lr": float(args.lr),
            "batch": int(args.batch),
            "seed": int(args.seed),
            "plannedSteps": planned_steps,
            "environment": environment,
        },
        "notes": notes,
        "deployable": False,
        "source": source_revision(),
        # Dry-run imports none of the stack; the environment block above
        # reports what IS installed. The lock digest travels regardless.
        "dependencies": {},
        "dependencyLockSha256": dependency_lock_digest(),
    }
    result_path = pathlib.Path(args.out) / "result.json"
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print(json.dumps(plan, ensure_ascii=False), flush=True)


# ---------------------------------------------------------------------------
# CLI: real fine-tuning (GPU runner path).
# ---------------------------------------------------------------------------

def _episode_tasks_or_empty(root):
    try:
        return _episode_tasks(root)
    except ValueError:
        # The structure check already ran in inspect_dataset; a metadata
        # problem surfaces there. Defensive only.
        return {}


def load_lerobot_episodes(dataset_dir):
    """Full LeRobot episode load: parquet -> (states, actions, task).

    One parquet file per episode under data/ (v2.1 and v3.0 agree on this).
    The state/action column mapping is the training contract. Every row is
    checked now that the data is actually read: finite values (no NaN/Inf),
    consistent dimensions, non-empty episodes.
    """
    if np is None:
        raise MissingDependencyError(
            "missing dependency: numpy. Install with: python3 -m pip install numpy"
        )
    import pyarrow.parquet as pq  # noqa: PLC0415 - lazy loader dependency

    root = pathlib.Path(dataset_dir)
    data_dir = root / "data"
    files = sorted(data_dir.rglob("*.parquet")) if data_dir.is_dir() else []
    if not files:
        raise ValueError(
            "no parquet files under %s/data: the real training path has "
            "nothing to load (the dry-run structure check reports this "
            "earlier)" % root
        )
    tasks = _episode_tasks_or_empty(root)
    episodes = []
    state_dim = None
    action_dim = None
    for episode_index, path in enumerate(files):
        try:
            table = pq.read_table(path.as_posix(), columns=["observation.state", "action"])
        except (ValueError, KeyError) as error:
            raise ValueError(
                "parquet file %s could not provide the observation.state/"
                "action columns (%s)" % (path, error)
            )
        states = np.asarray(table.column("observation.state").to_pylist(), dtype=np.float64)
        actions = np.asarray(table.column("action").to_pylist(), dtype=np.float64)
        if states.ndim != 2 or actions.ndim != 2 or states.shape[0] == 0:
            raise ValueError(
                "episode %s is empty or ragged (states %r / actions %r)"
                % (path, states.shape, actions.shape)
            )
        if state_dim is None:
            state_dim, action_dim = states.shape[1], actions.shape[1]
        elif states.shape[1] != state_dim or actions.shape[1] != action_dim:
            raise ValueError(
                "episode %s has dimensions %dx%d but earlier episodes "
                "declared %dx%d: inconsistent dataset"
                % (path, states.shape[1], actions.shape[1], state_dim, action_dim)
            )
        if not np.isfinite(states).all() or not np.isfinite(actions).all():
            raise ValueError(
                "episode %s contains NaN/Inf values: refused at load, not "
                "silently trained on" % path
            )
        episodes.append(
            {
                "index": episode_index,
                "path": str(path),
                "states": states.astype(np.float32),
                "actions": actions.astype(np.float32),
                "task": tasks.get(episode_index, ""),
            }
        )
    return episodes, int(state_dim), int(action_dim)


def _steps_from_epochs(frames, batch, epochs):
    """Optimizer steps the delegate trainer runs for the epoch budget."""
    return max(1, int(math.ceil(frames / float(batch))) * int(epochs))


def _dataset_repo_id(dataset_dir):
    """Synthetic local repo_id for the trainer; the data comes from --root."""
    slug = safe_slug(pathlib.Path(dataset_dir).resolve().name, "local-dataset")
    return "local/%s" % slug


_LOSS_RE = re.compile(r"loss[:=]\s*([0-9.]+(?:[eE][+-]?[0-9]+)?)")


def _run_lerobot_trainer(cmd):
    """Run the lerobot trainer subprocess, streaming its lines verbatim.

    Every trainer line is forwarded with a `[smolvla][trainer]` prefix — the
    trainer's own progress is the honest progress, not a re-derivation. The
    last `loss:`-shaped number is returned when the trainer logs one, else
    None (a missing loss is reported as unknown, never zero).
    """
    process = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    final_loss = None
    try:
        for line in process.stdout:
            line = line.rstrip("\n")
            if line:
                print("[smolvla][trainer] %s" % line, flush=True)
            match = _LOSS_RE.search(line)
            if match:
                final_loss = float(match.group(1))
    finally:
        process.stdout.close()
        returncode = process.wait()
    if returncode != 0:
        raise RuntimeError(
            "the lerobot trainer exited with %d — its lines above are the "
            "authoritative failure record" % returncode
        )
    return final_loss


def _latest_checkpoint(train_dir):
    """The trainer's most recent checkpoint directory, or None.

    lerobot writes output_dir/checkpoints/<step-ident>/pretrained_model; the
    step directories order by their numeric identifier when it parses, else
    by name — the layout is the trainer's, not ours.
    """
    checkpoints = pathlib.Path(train_dir) / "checkpoints"
    if not checkpoints.is_dir():
        return None
    entries = [entry for entry in checkpoints.iterdir() if entry.is_dir()]
    if not entries:
        return None

    def sort_key(entry):
        digits = "".join(char for char in entry.name if char.isdigit())
        return (int(digits) if digits else -1, entry.name)

    latest = max(entries, key=sort_key)
    pretrained = latest / "pretrained_model"
    return pretrained if pretrained.is_dir() else latest


def _policy_chunk(weights_dir):
    """Action-chunk length from the checkpoint's policy config, best effort."""
    try:
        config = json.loads(
            (pathlib.Path(weights_dir) / "config.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None
    value = config.get("chunk_size")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def run_real_training(args):
    """Real fine-tuning: full stack, GPU, weights, artifacts.

    Gate order is the honesty contract: dependency imports (exact install
    command in the failure), CUDA availability (a GPU runner, not this
    host), output writability, dataset inspection, then the full episode
    load. Nothing expensive starts before every gate passes.
    """
    missing = missing_training_dependencies()
    if missing:
        raise MissingDependencyError(_missing_dependency_message(missing))
    for package, hint in LOADER_PACKAGES:
        if not _importable(package):
            raise MissingDependencyError(
                "missing dependency: {}. Install with: {}".format(package, hint)
            )
    import torch

    if not torch.cuda.is_available():
        raise GpuUnavailableError(
            "CUDA is not available (torch.cuda.is_available()=False): "
            "fine-tuning SmolVLA (~450M parameters) runs on a GPU runner, "
            "not on this host. Validate the plan here with --dry-run, then "
            "run this command on the GPU machine with the base weights "
            "reachable."
        )
    if args.lora_r > 0:
        raise ValueError(
            "the delegate path runs the trainer's full fine-tune; LoRA "
            "(--lora-r > 0) is refused rather than silently downgraded to "
            "full fine-tuning"
        )

    ensure_output_writable(args.out)
    dataset = inspect_dataset(args.dataset, args.expect_state_dim, args.expect_action_dim)
    episodes, state_dim, action_dim = load_lerobot_episodes(args.dataset)
    frames = int(sum(len(episode["states"]) for episode in episodes))

    print(
        "[smolvla] engine=smolvla mode=train dataset=%s episodes=%d frames=%d "
        "state=%d action=%d model=%s strategy=%s device=%s"
        % (
            dataset["path"], len(episodes), frames, state_dim, action_dim,
            args.model_id, _finetune_strategy(args.lora_r), "cuda",
        ),
        flush=True,
    )

    steps = _steps_from_epochs(frames, args.batch, args.epochs)
    started = time.time()
    cmd = [
        sys.executable, "-m", "lerobot.scripts.lerobot_train",
        "--dataset.repo_id=%s" % _dataset_repo_id(args.dataset),
        "--dataset.root=%s" % str(pathlib.Path(args.dataset).resolve()),
        "--dataset.video_backend=pyav",
        "--dataset.use_imagenet_stats=false",
        "--policy.push_to_hub=false",
        *(["--rename_map=%s" % args.rename_map] if args.rename_map else []),
        "--policy.path=%s" % args.model_id,
        "--policy.repo_id=%s" % _dataset_repo_id(args.dataset),
        "--output_dir=%s" % (pathlib.Path(args.out) / "train"),
        "--steps=%d" % steps,
        "--batch_size=%d" % int(args.batch),
        "--save_freq=%d" % steps,
        "--num_workers=2",
        "--seed=%d" % int(args.seed),
    ]
    print(
        "[smolvla] delegating to lerobot's trainer: %d optimizer steps "
        "(%d epochs x %d frames / batch %d)" % (steps, args.epochs, frames, args.batch),
        flush=True,
    )
    final_loss = _run_lerobot_trainer(cmd)
    training_seconds = round(time.time() - started, 1)

    train_dir = pathlib.Path(args.out) / "train"
    checkpoint_dir = _latest_checkpoint(train_dir)
    if checkpoint_dir is None:
        raise RuntimeError(
            "the lerobot trainer wrote no checkpoint under %s — refusing to "
            "fabricate a completed run" % (train_dir / "checkpoints")
        )

    out_dir = pathlib.Path(args.out)
    weights_dir = out_dir / "weights"
    weights_dir.mkdir(parents=True, exist_ok=True)
    for item in sorted(checkpoint_dir.iterdir()):
        target = weights_dir / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    write_artifact_manifest(weights_dir.as_posix())
    chunk = _policy_chunk(weights_dir)
    step = steps

    weight_files = sorted(
        name for name in os.listdir(weights_dir)
        if os.path.isfile(weights_dir / name) and name not in ("SHA256SUMS",)
    )
    weights_bytes = sum((weights_dir / name).stat().st_size for name in weight_files)
    print("[smolvla] saved %d weight files (%d bytes) to %s" % (len(weight_files), weights_bytes, weights_dir), flush=True)

    pushed = False
    push_note = None
    if args.push_to_hub:
        push_note = (
            "push_to_hub is not supported by the delegate path; upload %s "
            "with `huggingface-cli upload`" % weights_dir
        )
        print("[smolvla] %s" % push_note, file=sys.stderr, flush=True)

    slug_model = safe_slug(args.model_id, ENGINE_NAME)
    slug_version = safe_slug("0.1.0", "0-1-0")
    dataset_block = dict(dataset)
    dataset_block.update({"episodes": len(episodes), "frames": frames, "stateDim": state_dim, "actionDim": action_dim})
    hyper = _hyperparameter_block(args.epochs, args.lr, args.batch, args.seed)
    result = {
        "schemaVersion": 1,
        "status": "completed",
        "mock": False,
        "engine": ENGINE_NAME,
        "mode": "train",
        "dryRun": False,
        "model": _model_block(args.model_id, args.lora_r),
        "dataset": dataset_block,
        "hyperparameters": hyper,
        "checkpoint": {
            "checkpointId": "smolvla-{}".format(slug_version),
            "artifactRef": "artifact://smolvla/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": int(step),
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://smolvla/{}/{}/weights".format(slug_model, slug_version),
            "kind": "source",
            "format": "safetensors",
            "runtime": "gpu-pytorch",
            "workload": "vla-finetuning",
            "deployable": False,
            "sizeBytes": int(weights_bytes),
            "files": weight_files,
            "loraAdapter": bool(args.lora_r > 0),
            "manifest": "weights/SHA256SUMS",
        },
        "metrics": {
            "dryRun": False,
            "engine": ENGINE_NAME,
            "modelId": args.model_id,
            "finetuneStrategy": _finetune_strategy(args.lora_r),
            "loraR": int(args.lora_r),
            "actionChunk": int(chunk),
            "episodes": len(episodes),
            "frames": frames,
            "stateDim": state_dim,
            "actionDim": action_dim,
            "epochs": int(args.epochs),
            "lr": float(args.lr),
            "batch": int(args.batch),
            "seed": int(args.seed),
            "steps": int(step),
            "finalLoss": final_loss,
            "trainingSeconds": training_seconds,
            "pushedToHub": pushed,
            **({"pushNote": push_note} if push_note else {}),
        },
        "deployable": False,
        "source": source_revision(),
        "dependencies": dependency_versions(PROVENANCE_PACKAGES),
        "dependencyLockSha256": dependency_lock_digest(),
        "cuda": True,
    }
    (out_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"status": "completed", "engine": ENGINE_NAME, "mode": "train", "steps": step, "finalLoss": final_loss}), flush=True)


# ---------------------------------------------------------------------------
# Engine mode (worker file protocol).
# ---------------------------------------------------------------------------

def _synthetic_dataset_plan(observation_size, action_size):
    """Plan dataset sized by the request contract (mirrors act's engine-mode
    smoke sizing). No files are read; the result labels it synthetic."""
    episodes = 8
    steps = 48
    return {
        "source": "engine-plan-synthetic",
        "synthetic": True,
        "codebaseVersion": None,
        "episodes": episodes,
        "frames": episodes * steps,
        "stateDim": int(observation_size),
        "actionDim": int(action_size),
        "dimensionSource": "request-contract",
        "parquetFiles": 0,
        "parquetVerified": False,
        "episodesMetadataRows": 0,
        "notes": [
            "synthetic plan dataset sized by the request contract; no files "
            "were read and no weights were loaded"
        ],
    }


def _clamp_int(value, low, high, fallback):
    """mjlab-style clamping: a request value outside the budget clamps
    instead of silently burning the runner, and the result records what
    actually ran."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, parsed))


def run_engine_mode(request_path=None, result_path=None, workdir=None):
    """Worker file-protocol round: the plan contract, honestly labeled.

    Dependency handling follows the mjlab-rsl-rl-adapter precedent exactly:
    a missing training stack is a REFUSAL — stderr line naming the package
    and its install command, exit code 3, and NO result.json written — so
    the worker marks the job failed and nothing downstream can read a plan
    as a completed training run.

    When the stack IS importable, this writes the complete result contract
    (artifact:// checkpoint/artifact refs, metrics, provenance) for a
    dry-run PLAN: dataset synthetic and labeled, cuda actually probed,
    deployable false, and a training-plan.json artifact in the job dir
    covered by SHA256SUMS so the worker's bundle verification has a real
    file to verify. `request_path`/`result_path`/`workdir` default to the
    protocol env vars and the current directory (the worker's job dir);
    tests pass them explicitly.
    """
    request_path = request_path or os.environ["RDK_SIM2REAL_REQUEST_FILE"]
    result_path = result_path or os.environ["RDK_SIM2REAL_RESULT_FILE"]
    workdir = os.path.abspath(workdir or os.getcwd())

    with open(request_path) as handle:
        request = json.load(handle)
    if request.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")

    missing = missing_training_dependencies()
    if missing:
        message = _missing_dependency_message(missing)
        print(
            "[smolvla] REFUSED — {}. This engine never fabricates a completed "
            "training run.".format(message),
            file=sys.stderr,
            flush=True,
        )
        sys.exit(3)

    contract = request.get("contract") or {}
    model = request.get("model") or {}
    training = request.get("training") or {}
    observation_size = int(contract.get("observationSize", 0) or 0)
    action_size = int(contract.get("actionSize", 0) or 0)
    if observation_size <= 0 or action_size <= 0:
        raise ValueError("request contract must define observationSize and actionSize")

    dataset_request = request.get("dataset") or {}
    dataset_dir = dataset_request.get("path")
    if dataset_dir:
        dataset = inspect_dataset(dataset_dir)
        dataset["source"] = "request-dataset"
        dataset["synthetic"] = False
    else:
        dataset = _synthetic_dataset_plan(observation_size, action_size)

    epochs = _clamp_int(training.get("maxIterations", training.get("epochs")), 1, 1_000_000, 50)
    batch = _clamp_int(training.get("batchSize"), 1, 65_536, 16)
    lora_r = _clamp_int(training.get("loraR"), 0, 1_024, 32)
    seed = _clamp_int(training.get("seed"), 0, 2_000_000, 0)
    lr = training.get("learningRate", training.get("lr", 1e-4))
    try:
        lr = float(lr)
    except (TypeError, ValueError):
        raise ValueError("training.learningRate must be a number, got %r" % (lr,))
    if not math.isfinite(lr) or lr <= 0.0:
        raise ValueError("training.learningRate must be positive and finite, got %r" % (lr,))
    validate_hyperparameters(epochs, lr, batch, lora_r)

    model_id = str(model.get("modelId") or DEFAULT_MODEL_ID)
    version = str(model.get("version") or "0.1.0")
    planned_steps = _planned_steps(dataset.get("frames"), batch, epochs)
    environment = environment_probe()
    cuda = _cuda_available()

    plan = {
        "engine": ENGINE_NAME,
        "mode": "engine-plan",
        "status": "planned",
        "contract": {
            "id": contract.get("id"),
            "observationSize": observation_size,
            "actionSize": action_size,
        },
        "dataset": dataset,
        "model": _model_block(model_id, lora_r),
        "hyperparameters": _hyperparameter_block(epochs, lr, batch, seed),
        "plannedSteps": planned_steps,
        "environment": environment,
        "resultPath": os.path.abspath(result_path),
    }
    plan_path = os.path.join(workdir, "training-plan.json")
    with open(plan_path, "w") as handle:
        json.dump(plan, handle, indent=2)

    # Integrity manifest for the one artifact this round produced, written
    # BEFORE result.json so the worker can verify the bundle it is about to
    # trust (result.json is a protocol file and excluded).
    write_artifact_manifest(workdir)

    slug_model = safe_slug(model_id, ENGINE_NAME)
    slug_version = safe_slug(version, "0-1-0")
    result = {
        "schemaVersion": 1,
        "status": "completed",
        "mock": False,
        "engine": ENGINE_NAME,
        "mode": "engine-plan",
        "dryRun": True,
        "model": _model_block(model_id, lora_r),
        "dataset": dataset,
        "hyperparameters": plan["hyperparameters"],
        "checkpoint": {
            "checkpointId": "smolvla-{}".format(slug_version),
            "artifactRef": "artifact://smolvla/{}/{}/checkpoint".format(slug_model, slug_version),
            "iteration": planned_steps,
            "planned": True,
        },
        "artifact": {
            "artifactId": "{}-policy".format(slug_model),
            "artifactRef": "artifact://smolvla/{}/{}/weights".format(slug_model, slug_version),
            "kind": "source",
            "format": "json",
            "runtime": "none",
            "workload": "vla-finetuning",
            "deployable": False,
            "sizeBytes": os.path.getsize(plan_path),
            "path": "training-plan.json",
            "manifest": "SHA256SUMS",
            "planOnly": True,
            "description": "dry-run training plan; no weights were produced",
        },
        "metrics": {
            "dryRun": True,
            "engine": ENGINE_NAME,
            "mode": "engine-plan",
            "contractValid": True,
            "observationSize": observation_size,
            "actionSize": action_size,
            "modelId": model_id,
            "finetuneStrategy": _finetune_strategy(lora_r),
            "loraR": int(lora_r),
            "datasetSource": dataset.get("source"),
            "synthetic": bool(dataset.get("synthetic")),
            "episodes": dataset.get("episodes"),
            "frames": dataset.get("frames"),
            "stateDim": dataset.get("stateDim"),
            "actionDim": dataset.get("actionDim"),
            "parquetVerified": bool(dataset.get("parquetVerified")),
            "epochs": int(epochs),
            "lr": float(lr),
            "batch": int(batch),
            "seed": int(seed),
            "plannedSteps": planned_steps,
            "environment": environment,
        },
        "deployable": False,
        "source": source_revision(),
        "dependencies": dependency_versions(PROVENANCE_PACKAGES),
        "dependencyLockSha256": dependency_lock_digest(),
        "cuda": cuda,
    }
    with open(result_path, "w") as handle:
        json.dump(result, handle, indent=2)
    print(
        json.dumps(
            {"status": "completed", "engine": ENGINE_NAME, "mode": "engine-plan", "dryRun": True}
        ),
        flush=True,
    )


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------

def _parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="train_smolvla.py",
        description=(
            "SmolVLA fine-tuning entry (reference adapter). Real fine-tuning "
            "runs on a GPU runner with the base weights reachable; --dry-run "
            "validates the full training plan on any machine."
        ),
        epilog=(
            "examples:\n"
            "  python3 engines/smolvla/train_smolvla.py /data/lerobot-dataset \\\n"
            "      --out ./run --dry-run\n"
            "  python3 engines/smolvla/train_smolvla.py /data/lerobot-dataset \\\n"
            "      --out ./run --lora-r 32 --epochs 50 --lr 1e-4 --batch 16\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("dataset", help="LeRobot dataset directory (converter export or Hub download)")
    parser.add_argument("--out", required=True, help="output directory (weights/, result.json)")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="validate the training plan without network, GPU or weights; "
             "prints a one-line JSON plan and writes result.json (no artifact)",
    )
    parser.add_argument(
        "--lora-r", type=int, default=32,
        help="LoRA rank (default 32); 0 selects full fine-tuning",
    )
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--rename-map", default=None,
        help="JSON dict passed to the trainer's --policy.rename_map when the "
             "dataset camera names differ from the policy's expected "
             "observation.images.* keys, e.g. '{\"observation.images.cam_high\": "
             "\"observation.images.camera1\"}'",
    )
    parser.add_argument(
        "--model-id", default=DEFAULT_MODEL_ID,
        help="base model: an HF id (default %s) or a local path" % DEFAULT_MODEL_ID,
    )
    parser.add_argument(
        "--push-to-hub", action="store_true",
        help="push the fine-tuned weights to the Hub after training (real path only)",
    )
    parser.add_argument(
        "--expect-state-dim", type=int, default=None,
        help="fail closed unless observation.state has exactly this width "
             "(default: no expectation, dimensions are reported only)",
    )
    parser.add_argument(
        "--expect-action-dim", type=int, default=None,
        help="fail closed unless action has exactly this width",
    )
    return parser.parse_args(argv)


def main():
    if os.environ.get("RDK_SIM2REAL_REQUEST_FILE") and os.environ.get(
        "RDK_SIM2REAL_RESULT_FILE"
    ):
        run_engine_mode()
        return

    args = _parse_args()
    if not str(args.model_id).strip():
        raise ValueError("model-id must be a non-empty HF id or local path")
    validate_hyperparameters(args.epochs, args.lr, args.batch, args.lora_r)
    if args.dry_run:
        run_dry_run(args)
    else:
        run_real_training(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print("[smolvla] FAIL — %s" % error, file=sys.stderr)
        sys.exit(2)
