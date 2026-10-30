"""Read-only viewer for the gated and continuous-feedback ablation runs."""

import argparse
import re
from http.server import ThreadingHTTPServer
from pathlib import Path

from standing_dashboard import Handler, Workspace


class AblationWorkspace(Workspace):
    def run(self, name):
        if not re.fullmatch(r"standing-(roll|free|sac|linear|residual)-seed\d+", name):
            raise ValueError("invalid run")
        path = (self.root / name).resolve()
        if not path.is_relative_to(self.root) or not path.is_dir():
            raise ValueError("unknown run")
        return path

    def state(self, name):
        result = super().state(name)
        result["runs"] = sorted(
            p.name
            for p in self.root.iterdir()
            if p.is_dir()
            and re.fullmatch(
                r"standing-(roll|free|sac|linear|residual)-seed\d+", p.name
            )
        )
        family = name.split("-")[1]
        prefix = (
            "standing-final-seed"
            if family == "roll"
            else f"standing-final-{family}-seed"
        )
        result["final"] = self.read(
            self.root / (prefix + name.rsplit("seed", 1)[1]) / "summary.json"
        )
        return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--port", type=int, default=0)
    a = p.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    server.workspace = AblationWorkspace(a.root)
    print(f"http://127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()
