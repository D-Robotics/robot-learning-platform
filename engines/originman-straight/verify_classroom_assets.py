"""Verify the scene and instructor media before using a classroom asset set."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve(strict=True)
lock = json.loads(Path(__file__).with_name('classroom-assets.sha256.json').read_text())
for relative, expected in lock.items():
    source = root / relative
    if not source.is_file() or source.resolve(strict=True) != source:
        raise SystemExit(f'classroom asset missing or linked: {relative}')
    if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
        raise SystemExit(f'classroom asset digest mismatch: {relative}')
print(f'classroom assets: {len(lock)} SHA-256 checks passed')
