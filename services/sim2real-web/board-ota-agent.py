#!/usr/bin/env python3
"""Fail-closed OTA adapter contract for an RDK board.

This module validates a signed artifact manifest and compatibility before a
deployment executor is injected. It intentionally refuses to perform SSH,
shell, motor, or boot-slot operations by itself.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class BoardIdentity:
    device_id: str
    board: str
    firmware: str
    contract_id: str


class OtaBlocked(RuntimeError):
    pass


def verify_manifest(manifest: dict[str, Any], secret: bytes, board: BoardIdentity) -> None:
    if manifest.get("immutable") is not True:
        raise OtaBlocked("artifact is not immutable")
    if manifest.get("lineage", {}).get("targetBoard") not in (None, board.board):
        raise OtaBlocked("artifact target board mismatch")
    if manifest.get("lineage", {}).get("contractId") not in (None, board.contract_id):
        raise OtaBlocked("policy contract mismatch")
    signature = str(manifest.get("signature", ""))
    unsigned = dict(manifest)
    unsigned.pop("signature", None)
    expected = hmac.new(secret, json.dumps(unsigned, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise OtaBlocked("artifact signature invalid")


def plan_deployment(manifest: dict[str, Any], secret: bytes, board: BoardIdentity) -> dict[str, Any]:
    """Return a reviewable plan; execution must be supplied by a trusted agent."""
    verify_manifest(manifest, secret, board)
    return {
        "status": "planned",
        "artifactId": manifest.get("artifactId"),
        "deviceId": board.device_id,
        "board": board.board,
        "requires": ["trusted_board_agent", "operator_approval", "estop_link", "rollback_slot"],
        "execution": "blocked_until_agent_injected",
    }
