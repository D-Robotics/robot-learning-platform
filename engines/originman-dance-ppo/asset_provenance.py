"""Strict local asset identity checks for the OriginMan dance worker."""

from __future__ import annotations

import hashlib
from pathlib import Path
import re


def verified_sha256(path: Path, expected: str, label: str) -> str:
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError(f"{label} expected SHA-256 is missing or malformed")
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError(f"{label} SHA-256 does not match the mounted model manifest")
    return actual


def verify_joint_names(manifest_joints: list, scene_actuator_joints: list) -> None:
    if (
        len(manifest_joints) != 20
        or len(scene_actuator_joints) != 20
        or any(not isinstance(name, str) or not name for name in manifest_joints)
        or any(not isinstance(name, str) or not name for name in scene_actuator_joints)
        or len(set(manifest_joints)) != 20
        or len(set(scene_actuator_joints)) != 20
        or set(manifest_joints) != set(scene_actuator_joints)
    ):
        raise ValueError("scene actuator joints do not match the 20-joint model manifest")
