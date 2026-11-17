"""Immutable run identity, validated experiments, bounded trace snapshots."""

from __future__ import annotations

import hashlib
import inspect
import json
import platform
import shutil
import sys
import time
import traceback
from dataclasses import dataclass, fields
from datetime import UTC, datetime
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False))
    tmp.replace(path)


@dataclass
class LearnerConfig:
    learning_rate: float = 0.0003
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip: float = 0.2
    update_epochs: int = 4
    minibatch: int = 256
    entropy_weight: float = 0.001
    value_weight: float = 0.5
    max_grad_norm: float = 0.5
    checkpoint_every: int = 20
    trace_every: int = 20
    validation_seconds: float = 4.0
    reward_scale: float = 1.0
    target_kl: float = 0.0
    value_network: str = "shared"
    reset_asymmetry_range: float = 0.2
    reset_yaw_range: float = 0.08

    def __post_init__(self):
        bounds = {
            "learning_rate": (1e-6, 0.01),
            "gamma": (0.8, 0.9999),
            "gae_lambda": (0.5, 1),
            "clip": (0.01, 0.5),
            "update_epochs": (1, 20),
            "minibatch": (8, 4096),
            "entropy_weight": (0, 0.1),
            "value_weight": (0, 2),
            "max_grad_norm": (0.01, 10),
            "checkpoint_every": (1, 500),
            "trace_every": (1, 500),
            "validation_seconds": (1, 20),
            "reward_scale": (0.001, 1),
            "target_kl": (0, 0.2),
            "reset_asymmetry_range": (0, 0.5),
            "reset_yaw_range": (0, 0.3),
        }
        integers = {"update_epochs", "minibatch", "checkpoint_every", "trace_every"}
        if self.value_network not in ("shared", "separate"):
            raise ValueError("value_network must be shared or separate")
        for key, (lo, hi) in bounds.items():
            v = getattr(self, key)
            if (
                isinstance(v, bool)
                or not isinstance(v, (float, int))
                or not lo <= v <= hi
            ):
                raise ValueError(f"{key} must be in [{lo}, {hi}]")
            if key in integers and not isinstance(v, int):
                raise ValueError(f"{key} must be an integer")


def parse_experiment(value):
    from env import Config

    if not isinstance(value, dict) or set(value) - {"environment", "training"}:
        raise ValueError("expected environment/training experiment object")
    env = value.get("environment", {})
    training = value.get("training", {})
    if not isinstance(env, dict) or not isinstance(training, dict):
        raise TypeError("environment and training must be objects")
    names = {f.name for f in fields(LearnerConfig)}
    if set(training) - names - {"iterations", "num_envs", "steps", "seed"}:
        raise ValueError("unknown training configuration field")
    learner = LearnerConfig(**{k: v for k, v in training.items() if k in names})
    budget = {
        k: training.get(k, v)
        for k, v in {"iterations": 120, "num_envs": 8, "steps": 128, "seed": 7}.items()
    }
    for k, lo, hi in [
        ("iterations", 1, 5000),
        ("num_envs", 1, 32),
        ("steps", 8, 512),
        ("seed", 0, 2**31 - 1),
    ]:
        v = budget[k]
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise ValueError(f"{k} must be integer in [{lo}, {hi}]")
    return Config(**env), learner, budget


class RunRecorder:
    def __init__(self, out, scene, experiment, parent=None, warm_start=None):
        self.out = Path(out)
        self.out.mkdir(parents=True, exist_ok=True)
        for name in (
            "experiment.json",
            "training-summary.json",
            "telemetry.jsonl",
            "policy.pt",
        ):
            if (self.out / name).exists():
                raise FileExistsError(
                    "run already contains training evidence; use a new output directory"
                )
        self.start = time.monotonic()
        self.experiment = experiment
        source = Path(__file__).parent
        snapshots = self.out / "sources"
        snapshots.mkdir()
        hashes = {}
        for p in sorted(source.glob("*.py")):
            shutil.copyfile(p, snapshots / p.name)
            hashes[p.name] = digest(p)
        reused = source.parent / "microduck-football/train_football.py"
        shutil.copyfile(reused, snapshots / "reused-actor.py")
        hashes["reused-actor.py"] = digest(reused)
        manifest = Path(scene).parent / "model-manifest.json"
        model = json.loads(manifest.read_text()) if manifest.exists() else {}
        # Source/assets are fingerprinted before any environment or update runs.
        mesh_hashes = {
            p.name: digest(p)
            for p in sorted((Path(scene).parent / "meshes").glob("*.STL"))
        }
        model_snapshot = self.out / "model"
        model_snapshot.mkdir()
        shutil.copyfile(scene, model_snapshot / "scene.xml")
        if manifest.exists():
            shutil.copyfile(manifest, model_snapshot / "model-manifest.json")
        if (Path(scene).parent / "meshes").exists():
            shutil.copytree(Path(scene).parent / "meshes", model_snapshot / "meshes")
        self.scene = model_snapshot / "scene.xml"
        source_locations = {}
        from env import OriginManEnv

        lines, base = inspect.getsourcelines(OriginManEnv.step)
        for offset, line in enumerate(lines):
            if "reward_terms =" in line:
                source_locations["reward"] = {"file": "env.py", "line": base + offset}
        fork = (
            json.loads((self.out / "fork.json").read_text())
            if (self.out / "fork.json").exists()
            else None
        )
        self.identity = {
            "schemaVersion": 2,
            "runId": self.out.name,
            "startedAt": datetime.now(UTC).isoformat(),
            "experiment": experiment,
            "experimentSha256": hashlib.sha256(
                json.dumps(experiment, sort_keys=True).encode()
            ).hexdigest(),
            "sourceSha256": hashes,
            "sourceLocations": source_locations,
            "sceneSha256": digest(scene),
            "meshSha256": mesh_hashes,
            "sourceModelSha256": model.get("sourceZipSha256"),
            "parent": parent,
            "fork": fork,
            "warmStartSha256": digest(warm_start) if warm_start else None,
            "warmStartMode": "weights-only new optimization run"
            if warm_start
            else None,
            "runtime": {
                "python": sys.version.split()[0],
                "platform": platform.system(),
            },
            "simulationOnly": True,
            "hardwareEligible": False,
        }
        write_json(self.out / "experiment.json", self.identity)
        (self.out / "traces").mkdir()
        (self.out / "checkpoints").mkdir()
        self.events = (self.out / "events.jsonl").open("a")
        self.emit("created", {"configSha256": self.identity["experimentSha256"]})
        self.status("preparing", iteration=0)

    def emit(self, kind, data):
        self.events.write(
            json.dumps(
                {
                    "event": kind,
                    "elapsedSeconds": time.monotonic() - self.start,
                    **data,
                },
                allow_nan=False,
            )
            + "\n"
        )
        self.events.flush()

    def status(self, state, **data):
        write_json(
            self.out / "status.json",
            {
                "state": state,
                "updatedAt": datetime.now(UTC).isoformat(),
                "elapsedSeconds": time.monotonic() - self.start,
                **data,
            },
        )

    def trace(self, iteration, frames):
        write_json(
            self.out / "traces" / f"iter-{iteration:05d}.json",
            {
                "iteration": iteration,
                "environment": 0,
                "scope": "sampled training environment, not held-out evaluation",
                "frames": frames,
            },
        )

    def checkpoint(self, iteration, payload):
        import torch

        path = self.out / "checkpoints" / f"iter-{iteration:05d}.pt"
        if path.exists():
            raise FileExistsError("checkpoint iteration already exists")
        torch.save(payload, path)
        self.emit(
            "checkpoint",
            {
                "iteration": iteration,
                "file": str(path.relative_to(self.out)),
                "sha256": digest(path),
            },
        )
        return path

    def fail(self):
        write_json(self.out / "failure.json", {"traceback": traceback.format_exc()})
        self.status("failed", message=str(sys.exception()))
        self.emit("failed", {"message": str(sys.exception())})

    def close(self):
        self.events.close()


def config_diff(before, after, prefix=""):
    changes = []
    for key in sorted(set(before) | set(after)):
        path = f"{prefix}.{key}" if prefix else key
        a, b = before.get(key), after.get(key)
        if isinstance(a, dict) and isinstance(b, dict):
            changes.extend(config_diff(a, b, path))
        elif a != b:
            changes.append({"field": path, "before": a, "after": b})
    return changes


def seal_run(out, stage="training"):
    out = Path(out)
    root_names = {
        "experiment.json",
        "status.json",
        "failure.json",
        "telemetry.jsonl",
        "episodes.jsonl",
        "events.jsonl",
        "policy.pt",
        "policy.onnx",
        "training-summary.json",
        "eval-report.json",
        "trajectories.json",
        "fork.json",
        "pipeline-status.json",
    }
    files = {}
    for p in sorted(out.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        relative = p.relative_to(out)
        if (len(relative.parts) == 1 and p.name in root_names) or relative.parts[0] in {
            "sources",
            "traces",
            "checkpoints",
            "validation",
        }:
            files[str(relative)] = {"sha256": digest(p), "bytes": p.stat().st_size}
    write_json(out / f"{stage}-evidence.json", {"stage": stage, "files": files})


def verify_run(out):
    out = Path(out).resolve()
    path = out / "evaluation-evidence.json"
    if not path.exists():
        path = out / "training-evidence.json"
    if not path.exists():
        return {
            "verified": False,
            "reason": "no sealed evidence manifest",
            "checked": 0,
        }
    manifest = json.loads(path.read_text())
    bad = []
    for relative, expected in manifest["files"].items():
        p = (out / relative).resolve()
        if (
            not p.is_relative_to(out)
            or not p.is_file()
            or p.is_symlink()
            or digest(p) != expected["sha256"]
        ):
            bad.append(relative)
    return {
        "verified": not bad,
        "mismatches": bad,
        "checked": len(manifest["files"]),
        "stage": manifest["stage"],
        "scope": "local evidence integrity, not independent attestation",
    }
