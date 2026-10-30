"""Local, owned simulation dashboard. Never connects to a robot or edits code."""

from __future__ import annotations

import argparse
import json
import re
import signal
import subprocess
import sys
import threading
from dataclasses import asdict
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import uuid4

from env import Config
from monitor import LearnerConfig, config_diff, parse_experiment, verify_run, write_json

ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$")
ASSETS = Path(__file__).parent / "dashboard"


def read_json(path, default=None):
    if not path.exists():
        return default
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("artifact too large for dashboard")
    return json.loads(path.read_text())


def read_lines(path):
    if not path.exists():
        return []
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("log too large for dashboard")
    result = []
    for line in path.read_text().splitlines():
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # writer may still be appending last row
    return result


class Workspace:
    def __init__(self, root, scene):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.scene = Path(scene).resolve()
        self.lock = threading.Lock()
        self.children = {}
        self.logs = {}

    def path(self, runid):
        if not ID.fullmatch(runid):
            raise ValueError("invalid run identifier")
        path = (self.root / runid).resolve()
        if not path.is_relative_to(self.root) or path == self.root:
            raise ValueError("run outside workspace")
        return path

    def runs(self):
        items = []
        for path in self.root.iterdir():
            if not path.is_dir() or not ID.fullmatch(path.name):
                continue
            if not (
                (path / "experiment.json").exists()
                or (path / "training-summary.json").exists()
                or (path / "requested-experiment.json").exists()
            ):
                continue
            state = (
                read_json(path / "pipeline-status.json")
                or read_json(path / "status.json")
                or {"state": "legacy-completed"}
            )
            items.append(
                {
                    "id": path.name,
                    "state": state.get("state"),
                    "legacy": not (path / "experiment.json").exists(),
                    "modified": path.stat().st_mtime,
                }
            )
        return sorted(items, key=lambda x: x["modified"], reverse=True)

    def data(self, runid):
        path = self.path(runid)
        identity = read_json(path / "experiment.json")
        summary = read_json(path / "training-summary.json", {})
        experiment = (
            identity["experiment"]
            if identity
            else {
                "environment": summary.get("config", asdict(Config())),
                "training": {
                    "iterations": summary.get("iterations", 60),
                    "num_envs": summary.get("numEnvs", 4),
                    "steps": summary.get("stepsPerEnv", 128),
                    "seed": summary.get("seed", 7),
                    **asdict(LearnerConfig()),
                },
            }
        )
        return {
            "id": runid,
            "identity": identity,
            "experiment": experiment,
            "status": read_json(path / "status.json", {}),
            "pipeline": read_json(path / "pipeline-status.json"),
            "curve": read_lines(path / "telemetry.jsonl"),
            "events": read_lines(path / "events.jsonl"),
            "episodes": read_lines(path / "episodes.jsonl")[-100:],
            "traces": [p.stem for p in sorted((path / "traces").glob("*.json"))],
            "checkpoints": [
                p.stem for p in sorted((path / "checkpoints").glob("*.pt"))
            ],
            "validation": [
                p.stem for p in sorted((path / "validation").glob("*.json"))
            ],
            "evaluation": read_json(path / "eval-report.json"),
            "failure": read_json(path / "failure.json"),
        }

    def fork(self, body):
        allowed = {"parent", "experiment", "checkpoint"}
        if not isinstance(body, dict) or set(body) - allowed:
            raise ValueError("invalid fork payload")
        cfg, learner, budget = parse_experiment(body.get("experiment"))
        effective = {
            "environment": asdict(cfg),
            "training": {**budget, **asdict(learner)},
        }
        parent = body.get("parent")
        base = None
        warm = None
        if parent:
            base = self.data(parent)
            checkpoint = body.get("checkpoint")
            if checkpoint:
                if checkpoint == "final":
                    warm = self.path(parent) / "policy.pt"
                elif re.fullmatch(r"iter-\d{5}", checkpoint):
                    warm = self.path(parent) / "checkpoints" / (checkpoint + ".pt")
                else:
                    raise ValueError("invalid checkpoint")
                if not warm.is_file():
                    raise ValueError("checkpoint does not exist")
        elif body.get("checkpoint"):
            raise ValueError("checkpoint requires parent")
        with self.lock:
            if any(p.poll() is None for p in self.children.values()):
                raise RuntimeError("another dashboard training is active")
            runid = datetime.now(UTC).strftime("obs-%Y%m%d-%H%M%S-") + uuid4().hex[:6]
            out = self.path(runid)
            out.mkdir()
            write_json(out / "requested-experiment.json", effective)
            write_json(
                out / "fork.json",
                {
                    "parent": parent,
                    "checkpoint": body.get("checkpoint"),
                    "changes": config_diff(base["experiment"], effective)
                    if base
                    else [],
                    "mode": "weights-only warm start"
                    if warm
                    else "new seed initialization",
                },
            )
            args = [
                sys.executable,
                str(Path(__file__).parent / "run_experiment.py"),
                "--scene",
                str(self.scene),
                "--out",
                str(out),
                "--experiment",
                str(out / "requested-experiment.json"),
            ]
            if parent:
                args += ["--parent-run", parent]
            if warm:
                args += ["--warm-start", str(warm)]
            log = (out / "launcher.log").open("w")
            try:
                process = subprocess.Popen(
                    args,
                    stdout=log,
                    stderr=log,
                    cwd=Path(__file__).resolve().parents[2],
                )
            except OSError:
                log.close()
                raise
            self.children[runid] = process
            self.logs[runid] = log
        return {"id": runid, "experiment": effective}

    def stop(self, runid):
        with self.lock:
            process = self.children.get(runid)
            if process is None or process.poll() is not None:
                raise ValueError("no owned active training for this run")
            process.send_signal(signal.SIGINT)
        return {"stopping": runid}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, value, kind="application/json; charset=utf-8"):
        content = (
            json.dumps(value, allow_nan=False).encode()
            if kind.startswith("application/json")
            else value
        )
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        try:
            path = unquote(urlparse(self.path).path)
            if path in ["/", "/app.js", "/app.css"]:
                name = {"/": "index.html", "/app.js": "app.js", "/app.css": "app.css"}[
                    path
                ]
                kind = {
                    "/": "text/html; charset=utf-8",
                    "/app.js": "text/javascript; charset=utf-8",
                    "/app.css": "text/css; charset=utf-8",
                }[path]
                return self.send(200, (ASSETS / name).read_bytes(), kind)
            if path == "/api/runs":
                return self.send(200, self.server.workspace.runs())
            parts = path.strip("/").split("/")
            if len(parts) >= 3 and parts[:2] == ["api", "run"]:
                runid = parts[2]
                root = self.server.workspace.path(runid)
                if len(parts) == 3:
                    return self.send(200, self.server.workspace.data(runid))
                if len(parts) == 4 and parts[3] == "verify":
                    return self.send(200, verify_run(root))
                if (
                    len(parts) == 5
                    and parts[3] in ["traces", "validation"]
                    and re.fullmatch(r"iter-\d{5}", parts[4])
                ):
                    return self.send(
                        200, read_json(root / parts[3] / (parts[4] + ".json"))
                    )
                if (
                    len(parts) == 5
                    and parts[3] == "source"
                    and re.fullmatch(r"[a-zA-Z0-9_-]+\.py", parts[4])
                ):
                    file = root / "sources" / parts[4]
                    return self.send(200, {"name": parts[4], "text": file.read_text()})
            return self.send(404, {"error": "not found"})
        except (ValueError, TypeError, FileNotFoundError) as exc:
            self.send(400, {"error": str(exc)})

    def do_POST(self):
        expected = f"http://127.0.0.1:{self.server.server_port}"
        if (
            self.headers.get("Origin") != expected
            or self.headers.get("X-OriginMan-Request") != "dashboard"
        ):
            return self.send(403, {"error": "same-origin dashboard request required"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 256000:
                raise ValueError("invalid request size")
            body = json.loads(self.rfile.read(length))
            path = urlparse(self.path).path
            if path == "/api/fork":
                return self.send(201, self.server.workspace.fork(body))
            if path == "/api/stop":
                return self.send(200, self.server.workspace.stop(body.get("id", "")))
            self.send(404, {"error": "not found"})
        except RuntimeError as exc:
            self.send(409, {"error": str(exc)})
        except (ValueError, TypeError, OSError) as exc:
            self.send(400, {"error": str(exc)})


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--port", type=int, default=0)
    a = p.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    server.workspace = Workspace(a.root, a.scene)
    url = f"http://127.0.0.1:{server.server_port}"
    write_json(a.root / "dashboard-server.json", {"url": url})
    print(url, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        for proc in server.workspace.children.values():
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
        for log in server.workspace.logs.values():
            log.close()
