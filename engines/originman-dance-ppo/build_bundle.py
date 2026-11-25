"""Build a local dance bundle from a caller-owned, converted OriginMan model."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

import numpy as np

from adapter import validate_bundle
from env import Config, OriginManEnv


def build(model, destination):
    model = model.absolute()
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Choose a new output directory")
    if model.is_symlink() or any(p.is_symlink() for p in model.rglob("*")):
        raise ValueError("Source model must contain only real files")
    manifest = json.loads((model / "model-manifest.json").read_text())
    scene = model / "scene.xml"
    digest = hashlib.sha256(scene.read_bytes()).hexdigest()
    if manifest.get("sceneSha256", digest) != digest:
        raise ValueError("Source scene differs from its recorded digest")
    manifest.setdefault("sourceSceneSha256", digest)
    manifest["sceneSha256"] = digest
    with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
        bundle = Path(staging) / "bundle"
        target = bundle / "model"
        target.mkdir(parents=True)
        shutil.copyfile(scene, target / "scene.xml")
        shutil.copytree(model / "meshes", target / "meshes")
        (target / "model-manifest.json").write_text(json.dumps(manifest, indent=2))
        robot = OriginManEnv(target / "scene.xml", Config(stride=0, lift=0, sway=0))
        np.save(bundle / "reference.npy", robot.reference, allow_pickle=False)
        validate_bundle(bundle)
        bundle.rename(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    build(args.model, args.out)
    print(args.out.absolute())
