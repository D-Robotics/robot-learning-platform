from __future__ import annotations
import argparse, json, os
from .client import RDKClient

def main() -> None:
    p = argparse.ArgumentParser(prog="rdk-lab")
    p.add_argument("--url", default=os.getenv("RDK_SIM2REAL_URL", "http://127.0.0.1:18102"))
    p.add_argument("--token", default=os.getenv("RDK_SIM2REAL_TOKEN"))
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("health"); sub.add_parser("overview")
    s = sub.add_parser("train"); s.add_argument("model"); s.add_argument("--profile", default="smoke"); s.add_argument("--backend", default="local")
    r = sub.add_parser("run"); r.add_argument("run_id")
    a = p.parse_args(); c = RDKClient(a.url, a.token)
    if a.command == "health": out = c.health()
    elif a.command == "overview": out = c.overview()
    elif a.command == "train": out = c.submit_training(a.model, a.profile, a.backend)
    else: out = c.run(a.run_id)
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == "__main__": main()
