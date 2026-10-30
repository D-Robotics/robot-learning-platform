"""Loopback-only read-only training monitor with recorded development replays."""

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ASSET = Path(__file__).parent / "dashboard/standing.html"


class Workspace:
    def __init__(self, root):
        self.root = root.resolve()
        self.cache = {}

    def run(self, name):
        if not re.fullmatch(r"standing-roll-seed\d+", name):
            raise ValueError("invalid run")
        path = (self.root / name).resolve()
        if not path.is_relative_to(self.root) or not path.is_dir():
            raise ValueError("unknown run")
        return path

    def read(self, path, default=None):
        if not path.is_file():
            return default
        stamp = (path.stat().st_mtime_ns, path.stat().st_size)
        if self.cache.get(path, (None, None))[0] != stamp:
            self.cache[path] = (stamp, json.loads(path.read_text()))
        return self.cache[path][1]

    def state(self, name):
        path = self.run(name)
        curves = []
        if (path / "telemetry.jsonl").exists():
            for line in (path / "telemetry.jsonl").read_text().splitlines():
                try:
                    curves.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        validations = []
        for p in sorted((path / "validation").glob("standing-*.json")):
            d = self.read(p)
            validations.append(
                {
                    "step": d["timesteps"],
                    "file": p.stem,
                    "reference": d["referenceSuccesses"],
                    "rl": d["rlSuccesses"],
                    "learnedFeedback": d.get("learnedFeedback"),
                }
            )
        identity = self.read(path / "experiment.json", {})
        return {
            "run": name,
            "runs": sorted(
                p.name for p in self.root.glob("standing-roll-seed*") if p.is_dir()
            ),
            "status": self.read(path / "status.json", {}),
            "curve": curves,
            "validations": validations,
            "experiment": identity.get("experiment", {}),
            "criteria": self.read(path / "standing-criteria.json", {}),
            "sources": identity.get("sourceSha256", {}),
            "final": self.read(
                self.root
                / f"standing-final-seed{name.rsplit('seed', 1)[1]}"
                / "summary.json"
            ),
        }

    def replay(self, name, step, index):
        path = self.run(name)
        if not re.fullmatch(r"standing-\d{8}", step) or not 0 <= index < 9:
            raise ValueError("invalid replay selection")
        d = self.read(path / "validation" / (step + ".json"))
        if not d:
            raise ValueError("replay not yet available")
        return {
            "step": d["timesteps"],
            "reference": d["reference"][index],
            "rl": d["rl"][index],
        }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        try:
            request = urlparse(self.path)
            query = parse_qs(request.query)
            if request.path == "/":
                data, kind = ASSET.read_bytes(), "text/html; charset=utf-8"
            elif request.path == "/api/state":
                data = json.dumps(
                    self.server.workspace.state(
                        query.get("run", ["standing-roll-seed7"])[0]
                    ),
                    allow_nan=False,
                ).encode()
                kind = "application/json"
            elif request.path == "/api/replay":
                data = json.dumps(
                    self.server.workspace.replay(
                        query["run"][0], query["step"][0], int(query["case"][0])
                    ),
                    allow_nan=False,
                ).encode()
                kind = "application/json"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)
        except (ValueError, KeyError, OSError) as exc:
            self.send_error(400, str(exc))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--port", type=int, default=0)
    a = p.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    server.workspace = Workspace(a.root)
    print(f"http://127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()
