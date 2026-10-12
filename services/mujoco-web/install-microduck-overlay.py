"""Install the RDK Studio overlay into a downloaded MicroDuck static release.

The upstream simulator is intentionally kept as a pinned, unmodified release.
This script only copies our additive overlay assets and inserts one script tag;
it never rewrites the simulator bundle or accepts arbitrary network input.
"""

from __future__ import annotations

import hashlib
import html
import os
import re
import shutil
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


SOURCE_ROOT = Path(__file__).resolve().parent
DEFAULT_TARGET = Path("/opt/microduck-web/current")
ASSETS = ("microduck-community-overlay.js", "community/microduck-wechat.png")
MARKER = "microduck-community-overlay.js"
SCRIPT_SOURCE = re.compile(r'(<script\b[^>]*\bsrc\s*=\s*)(["\'])([^"\']*)(\2)', re.IGNORECASE)


def target_root() -> Path:
    configured = os.environ.get("MICRODUCK_STATIC_ROOT", "").strip()
    return Path(configured) if configured else DEFAULT_TARGET


def script_tag(source: Path) -> str:
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
    return f'<script src="./microduck-community-overlay.js?v={digest}" defer></script>'


def install_script_reference(content: str, source: Path) -> str:
    """Refresh our script's cache key without rewriting upstream script tags."""
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
    matched = False

    def refresh(match: re.Match[str]) -> str:
        nonlocal matched
        parsed = urlsplit(html.unescape(match.group(3)))
        if parsed.scheme or parsed.netloc or parsed.path.rsplit("/", 1)[-1] != MARKER:
            return match.group(0)
        matched = True
        query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != "v"]
        query.append(("v", digest))
        reference = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
        return f'{match.group(1)}{match.group(2)}{html.escape(reference, quote=True)}{match.group(4)}'

    updated = SCRIPT_SOURCE.sub(refresh, content)
    if matched:
        return updated
    if "</body>" not in content:
        raise SystemExit("MicroDuck index has no </body> insertion point")
    return content.replace("</body>", f"  {script_tag(source)}\n</body>", 1)


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
    updated = install_script_reference(content, SOURCE_ROOT / ASSETS[0])
    if updated != content:
        atomic_replace_text(index, updated, index.stat().st_mode & 0o7777)
        print(f"installed or refreshed overlay script in {index}")
    else:
        print(f"overlay script already present in {index}")

    print(f"installed assets under {target}")


if __name__ == "__main__":
    main()
