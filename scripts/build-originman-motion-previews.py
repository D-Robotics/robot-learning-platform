#!/usr/bin/env python3
"""Bake authenticated catalog previews from compiled OriginMan trajectories."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import importlib.util
import hashlib
import json
from pathlib import Path

import mujoco
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
STRIDE = 4


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False))


def bake(task):
    compiled, catalog, bundle, output, scene_hash, item = task
    engine = load(ROOT / "engines/originman-reference-ppo/adapter.py", "reference_preview_engine")
    browser = load(ROOT / "engines/originman-straight/browser_scene.py", "reference_browser_scene")
    kind, entry = item
    motion_id = entry["id"]
    if kind == "motion" and entry.get("poseOnly"):
        source = (catalog / (motion_id + ".json")).read_bytes()
        if hashlib.sha256(source).hexdigest() != entry["sha256"]:
            raise ValueError(f"Motion source hash mismatch: {motion_id}")
        raw = json.loads(source)
        model = engine.ReferenceTracking(
            bundle, (np.asarray(raw["joint_pos"])[:, 2:], np.asarray(raw["joint_vel"])[:, 2:]),
        )
        qpos = model.stance.copy()
        qpos[model.qpos] += np.asarray(raw["joint_pos"][-1][2:])
        playback = [qpos]
        source_sha = entry["sha256"]
        method = "pose"
        result = None
    else:
        job = json.loads((compiled / f"{kind}--{motion_id}.json").read_text())
        raw, provenance = job["trajectory"], job["provenance"]
        if engine.trajectory_digest(raw) != provenance["trajectorySha256"]:
            raise ValueError(f"Compiled trajectory hash mismatch: {motion_id}")
        if kind == "motion" and any(
            block["id"] != motion_id or block["sha256"] != entry["sha256"]
            for block in provenance["blocks"]
        ):
            raise ValueError(f"Compiled motion source changed: {motion_id}")
        trajectory = engine.validate_trajectory(raw)
        model, result = engine.reference_gate(
            bundle, trajectory, provenance.get("stanceProfile"), bpm=provenance["bpm"],
        )
        evaluation, qpos = engine.evaluate(model, lambda _: np.zeros(18))
        playback = qpos[1:]
        result = {key: evaluation[key] for key in ("completed", "framesEvaluated", "framesExpected", "maxTiltDeg")}
        source_sha = entry["sha256"] if kind == "motion" else provenance["trajectorySha256"]
        method = "reference-control"
    if not playback:
        raise ValueError(f"No poses for {motion_id}")
    count = len(playback)
    indices = list(range(0, count, STRIDE))
    if indices[-1] != count - 1:
        indices.append(count - 1)
    samples = []
    for index in indices:
        model.data.qpos[:] = playback[index]
        mujoco.mj_kinematics(model.model, model.data)
        samples.append(np.column_stack((model.data.xpos, model.data.xquat)))
    save(output / kind / (motion_id + ".json"), {
        "schemaVersion": 1, "sourceSha256": source_sha, "sceneSha256": scene_hash,
        "method": method, "fps": 50, "frames": count, "stride": STRIDE,
        "bodyCount": model.model.nbody, "samples": browser.packed(samples, "<f4"),
        "evaluation": result,
    })
    return kind, motion_id, count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--compiled", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    engine = load(ROOT / "engines/originman-reference-ppo/adapter.py", "reference_preview_engine")
    browser = load(ROOT / "engines/originman-straight/browser_scene.py", "reference_browser_scene")
    scene_sha = engine.validate_bundle(args.bundle)["sceneSha256"]
    catalog = json.loads((args.catalog / "catalog.json").read_text())
    items = [(kind, row) for kind in ("preset", "motion") for row in catalog[kind + "s"]]
    args.out.mkdir()
    for kind in ("preset", "motion"):
        (args.out / kind).mkdir()
    model = mujoco.MjModel.from_xml_path(str(args.bundle / "model/scene.xml"))
    save(args.out / "scene.json", {"sceneSha256": scene_sha, "scene": browser.scene_description(model)})
    tasks = [(args.compiled, args.catalog, args.bundle, args.out, scene_sha, item) for item in items]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for kind, motion_id, count in pool.map(bake, tasks):
            print(f"{kind}/{motion_id}: {count} frames", flush=True)


if __name__ == "__main__":
    main()
