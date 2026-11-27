#!/usr/bin/env python3
"""Verify and distribute OriginMan environment archives without executing their contents."""

import argparse
from contextlib import contextmanager
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

PACKAGE = "originman-env"
RECEIVE_COMMAND = "originman-environment-v1"
SHA256 = re.compile(r"[a-f0-9]{64}")
VERSION = re.compile(r"[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}")
MAX_ARCHIVE = 64 * 1024**2
MAX_UNPACKED = 256 * 1024**2
MAX_FILES = 2048


def file_digest(file):
    with file.open("rb") as source:
        digest = sha256()
        for chunk in iter(lambda: source.read(1024**2), b""):
            digest.update(chunk)
        return digest.hexdigest()


def copy_archive(source, destination):
    size = 0
    with destination.open("xb") as output:
        while chunk := source.read(1024**2):
            size += len(chunk)
            if size > MAX_ARCHIVE:
                raise ValueError("Environment archive exceeds the upload size limit")
            output.write(chunk)
    if not size:
        raise ValueError("Environment archive is empty")


def package_files(archive):
    members = {}
    total = 0
    seen = set()
    for info in archive.infolist():
        name = info.filename.rstrip("/")
        path = PurePosixPath(name)
        kind = stat.S_IFMT(info.external_attr >> 16)
        canonical = name.casefold()
        if (
            not path.parts
            or path.parts[0] != PACKAGE
            or path.as_posix() != name
            or ".." in path.parts
            or "\\" in name
            or any(ord(char) < 32 or ord(char) == 127 for char in name)
            or canonical in seen
            or kind not in (0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG)
        ):
            raise ValueError(f"Invalid archive member {name!r}")
        seen.add(canonical)
        if info.is_dir():
            continue
        total += info.file_size
        if len(path.parts) < 2 or len(members) >= MAX_FILES or total > MAX_UNPACKED:
            raise ValueError("Invalid package layout or uncompressed size")
        members[path.relative_to(PACKAGE).as_posix()] = info
    return members


def unpack(archive_path, destination):
    with zipfile.ZipFile(archive_path) as archive:
        members = package_files(archive)
        required = {"VERSION", "MANIFEST.sha256", "env/spec.json", "env/config/calib.json",
                    "env/model/originman_ground.xml"}
        if not required <= members.keys():
            raise ValueError("OriginMan environment manifest, model or calibration is missing")
        expected = {}
        for line in archive.read(members["MANIFEST.sha256"]).decode("utf-8").splitlines():
            digest, name = line.split(maxsplit=1)
            name = name.removeprefix("*").removeprefix("./")
            if not SHA256.fullmatch(digest) or name in expected:
                raise ValueError("Invalid or repeated digest in the package manifest")
            expected[name] = digest
        if set(expected) != members.keys() - {"MANIFEST.sha256"}:
            raise ValueError("Package manifest does not cover the archive exactly")
        for name, member in members.items():
            file = destination / name
            file.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, file.open("xb") as output:
                shutil.copyfileobj(source, output, 1024**2)
            if name in expected and file_digest(file) != expected[name]:
                raise ValueError(f"Checksum mismatch for {name}")
    return expected


@contextmanager
def stage(root, source, expected_digest=None):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / ".publication.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        releases = root / "releases"
        releases.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=releases) as temporary:
            candidate = Path(temporary) / "release"
            candidate.mkdir()
            archive = candidate / "package.zip"
            copy_archive(source, archive)
            digest = file_digest(archive)
            if expected_digest is not None and digest != expected_digest:
                raise ValueError("Transferred archive checksum differs from the expected fingerprint")
            contents = candidate / PACKAGE
            expected = unpack(archive, contents)
            version = (contents / "VERSION").read_text(encoding="utf-8").strip()
            spec = json.loads((contents / "env/spec.json").read_text(encoding="utf-8"))
            if not VERSION.fullmatch(version) or spec.get("version") != version or (
                spec.get("name") != "originman-mjlab-env"
            ):
                raise ValueError("Archive version and OriginMan environment specification disagree")
            receipt = {
                "version": version,
                "archiveSha256": digest,
                "sceneSha256": expected["env/model/originman_ground.xml"],
                "calibrationSha256": expected["env/config/calib.json"],
                "verifiedFiles": len(expected),
            }
            (candidate / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
            release = releases / f"{version}-{digest}"
            if not release.exists():
                candidate.rename(release)
            else:
                verify_release(release, candidate, expected, digest, receipt)
            yield release, receipt


def verify_release(release, candidate, expected, digest, receipt):
    if release.is_symlink() or file_digest(release / "package.zip") != digest:
        raise ValueError("Retained archive differs from the verified release")
    manifest = Path(PACKAGE) / "MANIFEST.sha256"
    if file_digest(release / manifest) != file_digest(candidate / manifest):
        raise ValueError("Retained package manifest differs from the verified release")
    if json.loads((release / "receipt.json").read_text(encoding="utf-8")) != receipt:
        raise ValueError("Retained verification receipt differs from the verified release")
    for path, checksum in expected.items():
        if file_digest(release / PACKAGE / path) != checksum:
            raise ValueError(f"Retained package asset differs from the verified release: {path}")


def select_package(root, release):
    # This selector is only for staged assets; the training runtime has its own admission.
    with tempfile.TemporaryDirectory(dir=root) as temporary:
        selector = Path(temporary) / "current-package"
        selector.symlink_to(release.relative_to(root))
        selector.replace(root / "current-package")


def sync(config, target, release, receipt):
    with (release / "package.zip").open("rb") as source:
        result = subprocess.run(
            [
                "ssh", "-F", str(config), "-o", "BatchMode=yes", target,
                RECEIVE_COMMAND + " " + receipt["archiveSha256"],
            ],
            stdin=source, stdout=subprocess.PIPE, timeout=180, check=True,
        )
    if json.loads(result.stdout) != receipt:
        raise ValueError("Worker verification receipt differs from the publication")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    subcommands = parser.add_subparsers(dest="action", required=True)
    subcommands.add_parser("receive", help="Receive a package using a restricted SSH key")
    publish = subcommands.add_parser("publish", help="Verify a package locally and transfer it to the Worker")
    publish.add_argument("archive", type=Path)
    publish.add_argument("--ssh-config", required=True, type=Path)
    publish.add_argument("--target", default="originman-worker")
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        if args.action == "receive":
            command = os.environ.get("SSH_ORIGINAL_COMMAND", "").split()
            if len(command) != 2 or command[0] != RECEIVE_COMMAND or not SHA256.fullmatch(command[1]):
                raise ValueError("This connection accepts only verified OriginMan environment uploads")
            with stage(root, sys.stdin.buffer, command[1]) as (release, receipt):
                select_package(root, release)
        else:
            with args.archive.open("rb") as source, stage(root, source) as (release, receipt):
                sync(args.ssh_config, args.target, release, receipt)
                select_package(root, release)
        print(json.dumps(receipt))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
