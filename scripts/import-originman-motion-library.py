#!/usr/bin/env python3
"""Prepare a private JSON motion library from a catalog and 50 Hz NPZ or JSON sources."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile

import numpy as np

PROFILE = Path(__file__).resolve().parents[1] / (
    "plugins/rdk-robot-learning-platform/references/originman-reference-calibration.json"
)
ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
ROUNDING_TOLERANCE = 1e-4


def load_trajectory(filename, profile):
    if filename.suffix == ".npz":
        with np.load(filename, allow_pickle=False) as bundle:
            trajectory = {
                "schemaVersion": 1,
                "fps": bundle["fps"].item(),
                "joint_names": bundle["joint_names"].tolist(),
                "joint_pos": bundle["joint_pos"].tolist(),
                "joint_vel": bundle["joint_vel"].tolist(),
            }
    else:
        trajectory = json.loads(filename.read_text())
    if trajectory.get("schemaVersion") != 1 or trajectory.get("fps") != 50 or (
        trajectory.get("joint_names") != profile["robot"]["jointOrder"]
    ):
        raise ValueError("required schemaVersion 1, 50 Hz and the exact 20-joint order")
    pos = np.asarray(trajectory["joint_pos"], dtype=np.float64)
    vel = np.asarray(trajectory["joint_vel"], dtype=np.float64)
    if pos.ndim != 2 or pos.shape[1] != 20 or not 2 <= len(pos) <= 4500 or vel.shape != pos.shape:
        raise ValueError("joint arrays must have the same [2..4500, 20] shape")
    limits = profile["trajectory"]
    speed_limit = limits["maxSpeedRadPerS"]
    velocity_tolerance = ROUNDING_TOLERANCE if filename.suffix == ".npz" else 0
    for values, limit in ((pos, limits["maxAbsRad"]), (vel, speed_limit + velocity_tolerance)):
        if not np.isfinite(values).all() or np.any(np.abs(values) > limit) or np.any(values[:, :2]):
            raise ValueError("trajectory commands the head or exceeds the angle/speed envelope")
    if np.max(np.abs(np.diff(pos, axis=0))) * 50 > speed_limit + ROUNDING_TOLERANCE:
        raise ValueError("trajectory changes position faster than the speed envelope")
    vel = np.clip(vel, -speed_limit, speed_limit)
    return {
        "schemaVersion": 1, "fps": 50, "joint_names": profile["robot"]["jointOrder"],
        "joint_pos": pos.tolist(), "joint_vel": vel.tolist(),
    }


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path, help="Manifest containing motions (id, file, displayName, category, clipped) and presets")
    parser.add_argument("output", type=Path, help="New absolute private directory to serve as RDK_ORIGINMAN_MOTION_DIR")
    args = parser.parse_args()
    source = json.loads(args.catalog.read_text())
    profile = json.loads(PROFILE.read_text())
    if source.get("schemaVersion") != 1 or not args.output.is_absolute() or args.output.exists():
        parser.error("provide a version-1 catalog and a new absolute output directory")
    if not isinstance(source.get("motions"), list) or not isinstance(source.get("presets"), list):
        parser.error("motions and presets must be arrays")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output.parent, prefix=".originman-motion-") as tmp:
        stage = Path(tmp) / "library"
        stage.mkdir(0o700)
        converted = []
        for motion in source["motions"]:
            key = motion["id"]
            filename = motion["file"]
            if not ID.fullmatch(key) or Path(filename).name != filename or Path(filename).suffix not in {".json", ".npz"}:
                raise ValueError("invalid motion id or local filename")
            if (stage / (key + ".json")).exists():
                raise ValueError("duplicate motion id: " + key)
            try:
                trajectory = load_trajectory(args.catalog.parent / filename, profile)
            except (KeyError, ValueError, OSError) as error:
                raise ValueError(f"{key}: {error}") from error
            data = encode(trajectory)
            (stage / (key + ".json")).write_bytes(data)
            converted.append({
                "id": key, "displayName": motion["displayName"], "category": motion["category"],
                "frames": len(trajectory["joint_pos"]), "sha256": hashlib.sha256(data).hexdigest(),
                "clipped": motion.get("clipped", False),
            })
        (stage / "catalog.json").write_bytes(encode({
            "schemaVersion": 1, "motions": converted, "presets": source["presets"],
        }))
        stage.rename(args.output)
    print(f"Validated {len(converted)} motions. Manifest lists {len(source['presets'])} presets.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
