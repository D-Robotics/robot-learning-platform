"""Capture evaluation code separately from training code, including fidelity fixes."""

import json
import platform
import shutil
from datetime import UTC, datetime
from pathlib import Path

import mujoco
import numpy as np
import onnxruntime as ort
from monitor import digest, write_json


def capture(out, scene, source=None):
    source = Path(source) if source else Path(__file__).parent
    out, scene = Path(out), Path(scene)
    snapshots = out / "runtime-sources"
    snapshots.mkdir(exist_ok=False)
    for path in source.glob("*.py"):
        shutil.copyfile(path, snapshots / path.name)
    payload = {
        "captureMode": "before evaluation execution",
        "capturedAt": datetime.now(UTC).isoformat(),
        "sourceSha256": {p.name: digest(p) for p in snapshots.glob("*.py")},
        "sceneSha256": digest(scene),
        "meshSha256": {
            p.name: digest(p) for p in (scene.parent / "meshes").glob("*.STL")
        },
        "runtime": {
            "python": platform.python_version(),
            "mujoco": mujoco.__version__,
            "numpy": np.__version__,
            "onnxruntime": ort.__version__,
        },
        "scope": "local reproducibility and integrity record; not hardware evidence or third-party attestation",
    }
    write_json(out / "evaluation-runtime.json", payload)


def finish(out, scene, source=None):
    source = Path(source) if source else Path(__file__).parent
    out, scene = Path(out), Path(scene)
    payload = json.loads((out / "evaluation-runtime.json").read_text())
    changed = [
        name
        for name, value in payload["sourceSha256"].items()
        if not (source / name).exists() or digest(source / name) != value
    ]
    scene_changed = digest(scene) != payload["sceneSha256"]
    meshes = {p.name: digest(p) for p in (scene.parent / "meshes").glob("*.STL")}
    payload.update(
        completedAt=datetime.now(UTC).isoformat(),
        sourceChangedDuringEvaluation=bool(changed),
        changedSources=changed,
        modelChangedDuringEvaluation=scene_changed or meshes != payload["meshSha256"],
    )
    write_json(out / "evaluation-runtime.json", payload)
    if changed or payload["modelChangedDuringEvaluation"]:
        raise RuntimeError("evaluation code or model changed during execution")
