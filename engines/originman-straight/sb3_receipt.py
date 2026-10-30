"""Post-training integrity receipt covering SB3 preprocessing and semantic actions."""

import argparse
import json
from pathlib import Path

from monitor import digest, write_json


def seal(out):
    out = Path(out)
    summary = json.loads((out / "training-summary.json").read_text())
    required = [
        "policy.zip",
        "policy.onnx",
        "normalization.pkl",
        "normalization.json",
        "reference.npy",
        "training-summary.json",
        "experiment.json",
        "model/scene.xml",
    ]
    if summary["mode"] in ("feet", "roll"):
        required.append("foot-basis.npy")
    for name in required:
        if not (out / name).is_file() or (out / name).is_symlink():
            raise ValueError(f"missing regular artifact: {name}")
    files = {}
    for p in sorted(out.rglob("*")):
        if p.is_symlink():
            raise ValueError("symbolic links are not allowed in a sealed SB3 run")
        if p.is_file() and p.name != "sb3-evidence.json":
            files[str(p.relative_to(out))] = {
                "sha256": digest(p),
                "bytes": p.stat().st_size,
            }
    write_json(
        out / "sb3-evidence.json",
        {
            "stage": "post-training packaging",
            "scope": "local integrity including normalization, history specification, action basis and model; not hardware attestation",
            "files": files,
        },
    )
    return verify(out)


def verify(out):
    out = Path(out).resolve()
    manifest = json.loads((out / "sb3-evidence.json").read_text())
    bad = []
    for relative, expected in manifest["files"].items():
        p = (out / relative).resolve()
        if (
            not p.is_relative_to(out)
            or not p.is_file()
            or (out / relative).is_symlink()
            or digest(p) != expected["sha256"]
        ):
            bad.append(relative)
    return {"verified": not bad, "mismatches": bad, "checked": len(manifest["files"])}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--seal", action="store_true")
    a = p.parse_args()
    result = seal(a.run) if a.seal else verify(a.run)
    print(json.dumps(result))
    if not result["verified"]:
        raise SystemExit(1)
