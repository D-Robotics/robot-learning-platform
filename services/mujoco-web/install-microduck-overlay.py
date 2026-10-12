"""Install the RDK Studio overlay into a downloaded MicroDuck static release.

The upstream simulator is intentionally kept as a pinned, unmodified release.
This script only copies our additive overlay and network-boundary assets;
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
ASSETS = (
    "microduck-community-overlay.js",
    "community/microduck-wechat.png",
    "microduck-network-boundary.js",
)
MARKER = "microduck-community-overlay.js"
NETWORK_MARKER = "microduck-network-boundary.js"
NETWORK_POLICY_ID = "rdk-microduck-network-policy"
NETWORK_POLICY = (
    '<meta id="rdk-microduck-network-policy" http-equiv="Content-Security-Policy" '
    'content="connect-src \'self\'" />'
)
SCRIPT_SOURCE = re.compile(r'(<script\b[^>]*\bsrc\s*=\s*)(["\'])([^"\']*)(\2)', re.IGNORECASE)
SCRIPT_TAG = re.compile(r'<script\b[^>]*\bsrc\s*=\s*(["\'])([^"\']*)\1[^>]*>\s*</script>', re.IGNORECASE)
NETWORK_META = re.compile(
    rf'<meta\b[^>]*\bid\s*=\s*(["\']){NETWORK_POLICY_ID}\1[^>]*>', re.IGNORECASE
)


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


def network_script_tag(source: Path) -> str:
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
    # Classic and synchronous: defer/module/async would leave a peer-start gap.
    return f'<script src="./{NETWORK_MARKER}?v={digest}"></script>'


def install_network_boundary(content: str, source: Path) -> str:
    """Put the network policy and blocking bootstrap first inside the head."""
    chunk = f"\n    {NETWORK_POLICY}\n    {network_script_tag(source)}"
    head = re.search(r"<head\b[^>]*>", content, re.IGNORECASE)
    if head is None:
        raise SystemExit("MicroDuck index has no <head> network-boundary insertion point")
    if content[head.end():].startswith(chunk):
        return content

    def remove_script(match: re.Match[str]) -> str:
        parsed = urlsplit(html.unescape(match.group(2)))
        if parsed.scheme or parsed.netloc or parsed.path.rsplit("/", 1)[-1] != NETWORK_MARKER:
            return match.group(0)
        return ""

    # Refresh only our additions; upstream scripts and their attributes stay intact.
    previous = re.compile(
        rf"\n {{4}}{re.escape(NETWORK_POLICY)}\n {{4}}<script src=\"\./{NETWORK_MARKER}\?v=[a-f0-9]{{12}}\"></script>"
    )
    content = previous.sub("", content)
    content = NETWORK_META.sub("", SCRIPT_TAG.sub(remove_script, content))
    head = re.search(r"<head\b[^>]*>", content, re.IGNORECASE)
    return content[:head.end()] + chunk + content[head.end():]


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
    updated = install_network_boundary(content, SOURCE_ROOT / NETWORK_MARKER)
    updated = install_script_reference(updated, SOURCE_ROOT / ASSETS[0])
    if updated != content:
        atomic_replace_text(index, updated, index.stat().st_mode & 0o7777)
        print(f"installed or refreshed overlay script in {index}")
    else:
        print(f"overlay script already present in {index}")

    print(f"installed assets under {target}")


if __name__ == "__main__":
    main()
