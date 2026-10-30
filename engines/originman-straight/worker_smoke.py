"""Owned local-worker rehearsal; isolated ledger and no board connection."""

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--node", default="node")
    a = p.parse_args()
    root = Path(__file__).resolve().parents[2]
    out = a.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    token = secrets.token_urlsafe(36)
    env = {
        **os.environ,
        "RDK_SIM2REAL_LOCAL_WORKER_PORT": str(port),
        "RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR": str(out / "ledger"),
        "RDK_SIM2REAL_LOCAL_RUNNER_TOKEN": token,
        "ORIGINMAN_SCENE": str(a.scene.resolve()),
        "RDK_SIM2REAL_TRAIN_ENGINES_JSON": json.dumps(
            {
                "originman-straight": {
                    "executable": sys.executable,
                    "args": [
                        str(Path(__file__).parent.resolve() / "platform_adapter.py")
                    ],
                }
            }
        ),
    }
    log = (out / "worker.log").open("w")
    proc = subprocess.Popen(
        [a.node, str(root / "services/sim2real-web/local-training-worker.mjs")],
        cwd=root,
        env=env,
        stdout=log,
        stderr=log,
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}" + path,
            data=body,
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
                "X-Sim2Real-Account": "originman-offline-rehearsal",
            },
        )
        with opener.open(request, timeout=10) as r:
            return json.load(r)

    try:
        ready = False
        for _ in range(100):
            try:
                call("/healthz")
                ready = True
                break
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                time.sleep(0.1)
        if not ready:
            raise RuntimeError("owned worker not ready")
        request = {
            "schemaVersion": 1,
            "accountId": "originman-offline-rehearsal",
            "idempotencyKey": "originman-physical-smoke",
            "contractId": "originman-straight-v1",
            "contract": {
                "id": "originman-straight-v1",
                "observationSize": 41,
                "actionSize": 10,
            },
            "model": {"modelId": "originman-simulation", "version": "local-model-1"},
            "taskId": "originman-straight-residual",
            "training": {
                "engine": "originman-straight",
                "algorithm": "ppo",
                "profile": "smoke",
                "numEnvs": 2,
                "maxIterations": 2,
                "video": False,
            },
        }
        (out / "request.json").write_text(json.dumps(request, indent=2))
        job = call("/train", request)
        runid = job["runId"]
        deadline = time.monotonic() + 120
        while (
            job["status"] not in ("completed", "failed") and time.monotonic() < deadline
        ):
            time.sleep(0.5)
            job = call("/runs/" + runid)
        (out / "worker-receipt.json").write_text(json.dumps(job, indent=2))
        assert job["status"] == "completed", job
        assert job.get("progress"), "worker should parse engine progress"
        assert job["deployable"] is False
        assert job["artifactVerification"]["verified"] is True
        assert job["metrics"]["simulationOnly"] is True
        print(
            "Existing local worker: completed; artifact manifest verified; deployable=false",
            flush=True,
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        log.close()


if __name__ == "__main__":
    main()
