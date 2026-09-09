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

Optional: RDK_SIM2REAL_TELEMETRY_TOKEN (sent as Bearer), spool/checkpoint
paths, model/contract ids, and batch size.
"""

import hashlib
import json
import os
import time
import urllib.error
import urllib.request


URL = os.environ.get("RDK_SIM2REAL_TELEMETRY_URL", "").strip()
RUN_ID = os.environ.get("RDK_SIM2REAL_RUN_ID", "").strip()
MODEL_ID = os.environ.get("RDK_SIM2REAL_MODEL_ID", "").strip()
DEVICE_ID = os.environ.get("RDK_SIM2REAL_DEVICE_ID", "").strip()
CONTRACT_ID = os.environ.get("RDK_SIM2REAL_CONTRACT_ID", "").strip()
TOKEN = os.environ.get("RDK_SIM2REAL_TELEMETRY_TOKEN", "").strip()
SPOOL = os.environ.get("RDK_BOARD_TELEMETRY_SPOOL", "/var/lib/rdk-board-agent/telemetry/policy.jsonl")
CHECKPOINT = os.environ.get("RDK_BOARD_TELEMETRY_CHECKPOINT", SPOOL + ".offset")
BATCH_SIZE = max(1, min(5000, int(os.environ.get("RDK_BOARD_TELEMETRY_BATCH_SIZE", "200"))))
MAX_BACKOFF = 60.0


def _offset():
    try:
        with open(CHECKPOINT, "r", encoding="ascii") as fh:
            value = int(fh.read().strip() or "0")
            return max(0, value)
    except (OSError, ValueError):
        return 0


def _save_offset(value):
    directory = os.path.dirname(CHECKPOINT)
    if directory:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    tmp = CHECKPOINT + ".tmp"
    with open(tmp, "w", encoding="ascii") as fh:
        fh.write(str(value))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, CHECKPOINT)


def _read_batch(start):
    rows = []
    end = start
    try:
        with open(SPOOL, "rb") as fh:
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
            **({"authorization": "Bearer " + TOKEN} if TOKEN else {}),
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
