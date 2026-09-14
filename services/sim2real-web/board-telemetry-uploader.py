#!/usr/bin/env python3
"""Durable board telemetry uploader for the Sim2Real ingest API.

The policy runtime only appends local JSONL (no network or blocking work in
the control loop). This process batches that spool, retries with exponential
backoff, and advances a checkpoint only after the server acknowledges the
chunk. Replaying a chunk is safe because the request carries an idempotency
key derived from its byte range and content.

Required environment:
  RDK_SIM2REAL_TELEMETRY_URL   e.g. https://studio.example/api/sim2real/runs/<id>/telemetry
  RDK_SIM2REAL_DEVICE_ID

Optional: RDK_SIM2REAL_TELEMETRY_ATTESTATION_TOKEN (a short-lived, server-issued
HMAC Bearer token), spool/checkpoint paths, model/contract ids, and batch size.
`RDK_SIM2REAL_TELEMETRY_TOKEN` remains a backwards-compatible alias for older
images; when it contains a static/legacy value the server intentionally keeps
the upload review-only. Never copy the server signing secret to the board.
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)
from board_ipc import (
    atomic_write_text,
    ipc_path,
    secure_open_read,
    secure_read_text,
)


URL = os.environ.get("RDK_SIM2REAL_TELEMETRY_URL", "").strip()
RUN_ID = os.environ.get("RDK_SIM2REAL_RUN_ID", "").strip()
MODEL_ID = os.environ.get("RDK_SIM2REAL_MODEL_ID", "").strip()
DEVICE_ID = os.environ.get("RDK_SIM2REAL_DEVICE_ID", "").strip()
CONTRACT_ID = os.environ.get("RDK_SIM2REAL_CONTRACT_ID", "").strip()


def _select_token(environ=None):
    """Return the preferred Bearer token and the variable that supplied it.

    The canonical variable is deliberately distinct from the server-side
    ``RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET``. A board receives only a
    scoped, expiring token minted by a trusted issuer; it must never receive
    the HMAC key itself.
    """
    env = os.environ if environ is None else environ
    canonical = str(env.get("RDK_SIM2REAL_TELEMETRY_ATTESTATION_TOKEN", "")).strip()
    if canonical:
        return canonical, "RDK_SIM2REAL_TELEMETRY_ATTESTATION_TOKEN"
    legacy = str(env.get("RDK_SIM2REAL_TELEMETRY_TOKEN", "")).strip()
    if legacy:
        return legacy, "RDK_SIM2REAL_TELEMETRY_TOKEN"
    return "", None


TOKEN, TOKEN_ENV = _select_token()


def _configured_path(env_name, default_path):
    """Keep legacy file overrides while applying board_ipc validation."""

    if env_name in os.environ:
        return ipc_path(env_name, os.path.basename(default_path))
    return default_path


SPOOL = _configured_path(
    "RDK_BOARD_TELEMETRY_SPOOL", "/var/lib/rdk-board-agent/telemetry/policy.jsonl"
)
CHECKPOINT = _configured_path(
    "RDK_BOARD_TELEMETRY_CHECKPOINT", SPOOL + ".offset"
)
BATCH_SIZE = max(1, min(5000, int(os.environ.get("RDK_BOARD_TELEMETRY_BATCH_SIZE", "200"))))
MAX_BACKOFF = 60.0


def _authorization_headers():
    """Return transport headers without ever sending the server signing key."""
    return {"authorization": "Bearer " + TOKEN} if TOKEN else {}


def _offset():
    try:
        value = int(secure_read_text(CHECKPOINT, max_bytes=128, encoding="ascii").strip() or "0")
        return max(0, value)
    except (OSError, ValueError):
        return 0


def _save_offset(value):
    atomic_write_text(CHECKPOINT, str(value), max_bytes=128, encoding="ascii")


def _read_batch(start):
    rows = []
    end = start
    handle = None
    try:
        handle = secure_open_read(SPOOL)
        with os.fdopen(handle, "rb", closefd=True) as fh:
            handle = None
            fh.seek(start)
            while len(rows) < BATCH_SIZE:
                raw = fh.readline()
                if not raw:
                    break
                end += len(raw)
                try:
                    item = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    # A torn final line is retried once the writer completes;
                    # malformed complete lines are skipped and counted.
                    if not raw.endswith(b"\n"):
                        end -= len(raw)
                        break
                    continue
                if isinstance(item, dict):
                    rows.append(item)
    except OSError:
        return [], start
    finally:
        if handle is not None:
            try:
                os.close(handle)
            except OSError:
                pass
    return rows, end


def _post(samples, start, end):
    content_hash = hashlib.sha256(
        json.dumps(samples, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    body = {
        "runId": RUN_ID,
        "modelId": MODEL_ID,
        "deviceId": DEVICE_ID,
        "contractId": CONTRACT_ID,
        "source": "board-agent",
        "sequence": start,
        "samples": samples,
    }
    request = urllib.request.Request(
        URL,
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "idempotency-key": "board-%s-%s-%s" % (DEVICE_ID, start, content_hash[:16]),
            **_authorization_headers(),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status < 200 or response.status >= 300:
                return False
            response.read(1024)
            return True
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def main():
    if not URL or not RUN_ID or not DEVICE_ID:
        raise SystemExit("RDK_SIM2REAL_TELEMETRY_URL, RDK_SIM2REAL_RUN_ID and RDK_SIM2REAL_DEVICE_ID are required")
    if TOKEN_ENV == "RDK_SIM2REAL_TELEMETRY_TOKEN":
        print(
            "[telemetry-uploader] using legacy token variable; only a server-issued "
            "short-lived HMAC token can produce attested evidence (otherwise review-only)",
            flush=True,
        )
    elif not TOKEN:
        print(
            "[telemetry-uploader] no Bearer attestation token configured; uploads remain review-only",
            flush=True,
        )
    offset = _offset()
    backoff = 1.0
    while True:
        samples, end = _read_batch(offset)
        if not samples:
            time.sleep(1.0)
            continue
        if _post(samples, offset, end):
            offset = end
            _save_offset(offset)
            backoff = 1.0
        else:
            time.sleep(backoff)
            backoff = min(MAX_BACKOFF, backoff * 2.0)


if __name__ == "__main__":
    main()
