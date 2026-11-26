#!/usr/bin/env python3
"""Prepare a private JSON motion library from a catalog and 50 Hz NPZ or JSON sources."""
import argparse
import hashlib
import io
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
MAX_REFERENCE_FRAMES = 12_000


def load_trajectory(data, suffix, profile, *, source_exact=False):
    if suffix == ".npz":
        with np.load(io.BytesIO(data), allow_pickle=False) as bundle:
            trajectory = {
                "schemaVersion": 1,
                "fps": bundle["fps"].item(),
                "joint_names": bundle["joint_names"].tolist(),
                "joint_pos": bundle["joint_pos"].tolist(),
                "joint_vel": bundle["joint_vel"].tolist(),
            }
    else:
        trajectory = json.loads(data)
    if trajectory.get("schemaVersion") != 1 or trajectory.get("fps") != 50 or (
        trajectory.get("joint_names") != profile["robot"]["jointOrder"]
    ):
        raise ValueError("required schemaVersion 1, 50 Hz and the exact 20-joint order")
    pos = np.asarray(trajectory["joint_pos"], dtype=np.float64)
    vel = np.asarray(trajectory["joint_vel"], dtype=np.float64)
    minimum_frames = 50 if source_exact else 2
    if pos.ndim != 2 or pos.shape[1] != 20 or not minimum_frames <= len(pos) <= MAX_REFERENCE_FRAMES or vel.shape != pos.shape:
        raise ValueError(f"joint arrays must have the same [{minimum_frames}..{MAX_REFERENCE_FRAMES}, 20] shape")
    limits = profile["trajectory"]
    speed_limit = limits["maxSpeedRadPerS"]
    velocity_tolerance = ROUNDING_TOLERANCE if suffix == ".npz" and not source_exact else 0
    for values, limit in ((pos, limits["maxAbsRad"]), (vel, speed_limit + velocity_tolerance)):
        if not np.isfinite(values).all() or np.any(np.abs(values) > limit) or np.any(values[:, :2]):
            raise ValueError("trajectory commands the head or exceeds the angle/speed envelope")
    if np.max(np.abs(np.diff(pos, axis=0))) * 50 > speed_limit + ROUNDING_TOLERANCE:
        raise ValueError("trajectory changes position faster than the speed envelope")
    if source_exact:
        if np.max(np.abs(pos - pos[:1])) < 0.05:
            raise ValueError("source preset must move at least 0.05 radians relative to its first frame")
    else:
        vel = np.clip(vel, -speed_limit, speed_limit)
    return {
        "schemaVersion": 1, "fps": 50, "joint_names": profile["robot"]["jointOrder"],
        "joint_pos": pos.tolist(), "joint_vel": vel.tolist(),
    }


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def import_preset(preset, source_directory, stage, profile):
    if "reference" not in preset:
        return preset
    key, reference = preset["id"], preset["reference"]
    if not isinstance(key, str) or not ID.fullmatch(key) or not isinstance(reference, dict):
        raise ValueError("invalid source-exact preset id or reference")
    if "transitionSeconds" in preset or reference.keys() - {
        "file", "frames", "sha256", "sourceSha256", "adapted", "stanceProfile",
    }:
        raise ValueError(f"{key}: source-exact presets use their recorded transition timing")
    stance_profile = reference.get("stanceProfile")
    if "stanceProfile" in reference and stance_profile != "source-neutral-v1":
        raise ValueError(f"{key}: unsupported reference stance profile")
    filename = reference["file"]
    if not isinstance(filename, str) or Path(filename).name != filename or Path(filename).suffix not in {".npz", ".json"}:
        raise ValueError(f"{key}: invalid source trajectory filename")
    raw = (source_directory / filename).read_bytes()
    raw_sha256 = hashlib.sha256(raw).hexdigest()
    adapted = reference.get("adapted", False)
    source_sha256 = reference.get("sourceSha256", raw_sha256)
    if type(adapted) is not bool or (
        adapted and not re.fullmatch(r"[a-f0-9]{64}", str(reference.get("sourceSha256")))
    ):
        raise ValueError(f"{key}: adapted preset must identify its original trajectory SHA-256")
    if reference.get("sha256", raw_sha256) != raw_sha256 or (
        not adapted and source_sha256 != raw_sha256
    ):
        raise ValueError(f"{key}: source trajectory SHA-256 does not match the catalog")
    trajectory = load_trajectory(raw, Path(filename).suffix, profile, source_exact=True)
    frames = len(trajectory["joint_pos"])
    if reference.get("frames", frames) != frames:
        raise ValueError(f"{key}: source trajectory frame count does not match the catalog")
    data = encode(trajectory)
    file = "reference-" + hashlib.sha256(key.encode("ascii")).hexdigest()[:32] + ".json"
    with (stage / file).open("xb") as output:
        output.write(data)
    return {
        **preset,
        "reference": {
            "file": file,
            "frames": frames,
            "sha256": hashlib.sha256(data).hexdigest(),
            "sourceSha256": source_sha256,
            **({"adapted": True} if adapted else {}),
            **({"stanceProfile": stance_profile} if stance_profile else {}),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path, help="Manifest containing motions and presets, with optional preset reference files and source SHA-256")
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
                source_file = args.catalog.parent / filename
                trajectory = load_trajectory(source_file.read_bytes(), source_file.suffix, profile)
            except (KeyError, ValueError, OSError) as error:
                raise ValueError(f"{key}: {error}") from error
            data = encode(trajectory)
            (stage / (key + ".json")).write_bytes(data)
            positions = np.asarray(trajectory["joint_pos"])
            pose_only = not np.any(positions != positions[0])
            converted.append({
                "id": key, "displayName": motion["displayName"], "category": motion["category"],
                "frames": len(trajectory["joint_pos"]), "sha256": hashlib.sha256(data).hexdigest(),
                "clipped": motion.get("clipped", False),
                **({"poseOnly": True} if pose_only else {}),
            })
        (stage / "catalog.json").write_bytes(encode({
            "schemaVersion": 1,
            "motions": converted,
            "presets": [
                import_preset(preset, args.catalog.parent, stage, profile)
                for preset in source["presets"]
            ],
        }))
        stage.rename(args.output)
    print(f"Validated {len(converted)} motions. Manifest lists {len(source['presets'])} presets.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
