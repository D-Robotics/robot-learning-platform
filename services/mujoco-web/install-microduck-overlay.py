"""Install the RDK Studio overlay into a downloaded MicroDuck static release.

The upstream simulator is intentionally kept as a pinned, unmodified release.
This script only copies our additive overlay assets and inserts one script tag;
it never rewrites the simulator bundle or accepts arbitrary network input.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import time
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parent
DEFAULT_TARGET = Path("/opt/microduck-web/current")
ASSETS = ("microduck-community-overlay.js", "community/microduck-wechat.png")
MARKER = "microduck-community-overlay.js"


def target_root() -> Path:
    configured = os.environ.get("MICRODUCK_STATIC_ROOT", "").strip()
    return Path(configured) if configured else DEFAULT_TARGET


def script_tag(source: Path) -> str:
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
    return f'<script src="./microduck-community-overlay.js?v={digest}" defer></script>'


def atomic_replace_text(target: Path, content: str, mode: int) -> None:
    """Replace a release file atomically and preserve its mode."""
    temporary = target.with_name(
        f".{target.name}.codex-overlay-{os.getpid()}-{time.time_ns()}.tmp"
    )
    descriptor = -1
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if descriptor != -1:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> None:
    target = target_root()
    index = target / "index.html"
    if not index.is_file():
        raise SystemExit(f"MicroDuck index not found: {index}")

    for relative in ASSETS:
        source = SOURCE_ROOT / relative
        destination = target / relative
        if not source.is_file():
            raise SystemExit(f"overlay asset not found: {source}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    content = index.read_text(encoding="utf-8")
    if MARKER not in content:
        tag = script_tag(SOURCE_ROOT / ASSETS[0])
        if "</body>" not in content:
            raise SystemExit("MicroDuck index has no </body> insertion point")
        content = content.replace("</body>", f"  {tag}\n</body>", 1)
        atomic_replace_text(index, content, index.stat().st_mode & 0o7777)
        print(f"installed overlay script into {index}")
    else:
        print(f"overlay script already present in {index}")

    print(f"installed assets under {target}")


if __name__ == "__main__":
    main()
