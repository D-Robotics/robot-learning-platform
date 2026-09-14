#!/usr/bin/env python3
"""安全的板端 agent IPC 文件辅助函数。

所有板端进程都以 root 身份运行，IPC 文件只应存在于 root 拥有的私有
目录中。这个模块集中处理路径校验、无跟随 symlink 的读写、随机临时文件
和目录 fsync，避免各进程因为实现细节不同而重新引入公共 ``/tmp`` 竞态。

环境变量仍可覆盖单个文件路径（用于现场兼容旧部署），但覆盖路径必须是
绝对路径，父目录必须是当前用户/root 拥有且恰好 0700 的目录；公共目录、
symlink、非普通文件和 group/world 可写路径都会 fail-closed。
"""

import errno
import json
import os
import stat
import tempfile


DEFAULT_RUNTIME_DIR = "/var/lib/rdk-board-agent/runtime"
PRIVATE_DIR_MODE = 0o700
IPC_FILE_MODE = 0o600
DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024
_SYSTEM_SYMLINK_TARGETS = {
    "/var": "/private/var",
    "/tmp": "/private/tmp",
}


class IpcPathError(OSError):
    """Raised when an IPC path is not inside a private, trusted boundary."""


def _raise(message):
    raise IpcPathError(errno.EPERM, message)


def _allowed_system_symlink(path):
    """Allow only the standard macOS /var and /tmp aliases."""

    expected = _SYSTEM_SYMLINK_TARGETS.get(path)
    if expected is None:
        return False
    try:
        return os.path.realpath(path) == expected
    except OSError:
        return False


def _check_ancestor_directory(path, info, *, allow_public_tmp=False):
    """Reject writable ancestor directories that an untrusted user can swap."""

    if not stat.S_ISDIR(info.st_mode):
        _raise(f"IPC path component is not a directory: {path}")
    # The only intentionally public ancestor we traverse is the host's
    # canonical /tmp alias.  A private child below it is still required to be
    # root/current-user owned and exactly 0700.
    if allow_public_tmp and path == "/tmp":
        return
    if info.st_mode & 0o022:
        _raise(f"IPC path component is writable by group/other: {path}")


def _validate_absolute_path(path, label="IPC path"):
    if not isinstance(path, str):
        _raise(f"{label} must be a string")
    value = path.strip()
    if value != path:
        _raise(f"{label} contains leading/trailing whitespace")
    if not value or not os.path.isabs(value) or "\x00" in value:
        _raise(f"{label} must be an absolute path")
    # Reject control characters and ambiguous dot components.  The latter are
    # easy to overlook when auditing an env-file override and can cross a
    # trusted-looking prefix after normalization.
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        _raise(f"{label} contains control characters")
    if any(part in (".", "..") for part in value.split(os.sep)):
        _raise(f"{label} contains dot path components")
    if value == os.sep:
        _raise(f"{label} cannot be the filesystem root")
    return value.rstrip(os.sep)


def ipc_path(env_name, basename, environ=None):
    """Resolve one IPC filename from a direct override or runtime directory.

    A present-but-empty override is considered malformed rather than silently
    falling back to a different location.  This makes a damaged environment
    file fail closed at process startup.
    """

    env = os.environ if environ is None else environ
    if env_name in env:
        direct = env.get(env_name)
        if not isinstance(direct, str) or not direct.strip():
            _raise(f"{env_name} is empty")
        return _validate_absolute_path(direct, env_name)
    runtime = env.get("RDK_BOARD_RUNTIME_DIR", DEFAULT_RUNTIME_DIR)
    if not isinstance(runtime, str) or not runtime.strip():
        _raise("RDK_BOARD_RUNTIME_DIR is empty")
    runtime = _validate_absolute_path(runtime, "RDK_BOARD_RUNTIME_DIR")
    if not isinstance(basename, str) or not basename or os.path.basename(basename) != basename:
        _raise("IPC basename is invalid")
    return os.path.join(runtime, basename)


def _check_component(path, *, allow_missing):
    """Check every existing path component for symlinks.

    The final parent is checked again after creation and immediately before an
    operation.  Runtime directories are root-only, so this closes the practical
    race without relying on a fixed ``.tmp`` filename.
    """

    value = _validate_absolute_path(path)
    parts = value.split(os.sep)
    current = os.sep
    for part in parts[1:]:
        current = os.path.join(current, part)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            if allow_missing:
                continue
            raise
        if stat.S_ISLNK(info.st_mode):
            # macOS exposes /var and /tmp as root-owned system symlinks.  A
            # root-owned, non-user-controlled ancestor is safe to traverse;
            # symlinked runtime components owned by any other account remain
            # a hard failure.  The final target itself is always opened with
            # O_NOFOLLOW and is never accepted as a symlink.
            if info.st_uid != 0 or not _allowed_system_symlink(current):
                _raise(f"IPC path component is a symlink: {current}")
            try:
                followed = os.stat(current)
            except OSError:
                raise
            _check_ancestor_directory(current, followed, allow_public_tmp=current == "/tmp")
        else:
            _check_ancestor_directory(current, info, allow_public_tmp=current == "/tmp")
    return value


def ensure_private_parent(path, *, create=True):
    """Return a trusted parent directory for *path*.

    Missing components are created with 0700. Existing ancestors may be the
    normal read-only system directories (/, /var, /var/lib), but the immediate
    parent must be a regular directory owned by root/current uid with no group
    or world permissions. Thus ``/tmp/foo`` is rejected while a root-owned
    0700 ``/tmp/private/foo`` remains usable for a legacy deployment.
    """

    value = _validate_absolute_path(path)
    parent = os.path.dirname(value)
    if not parent or parent == os.sep:
        _raise("IPC parent must be a private directory")
    parent = _check_component(parent, allow_missing=True)

    # Create missing components one at a time so a symlink inserted between
    # mkdir calls is detected on the next lstat.
    pieces = parent.split(os.sep)
    current = os.sep
    for piece in pieces[1:]:
        current = os.path.join(current, piece)
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            if not create:
                raise
            try:
                os.mkdir(current, PRIVATE_DIR_MODE)
            except FileExistsError:
                pass
            info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode):
            if info.st_uid != 0 or not _allowed_system_symlink(current):
                _raise(f"IPC parent component is a symlink: {current}")
            # Follow only a root-owned system ancestor (for example macOS's
            # /var -> /private/var); the final runtime parent is still checked
            # with lstat below and may never itself be a symlink.
            try:
                followed = os.stat(current)
            except OSError:
                raise
            if not stat.S_ISDIR(followed.st_mode):
                _raise(f"IPC parent is not a directory: {current}")
            _check_ancestor_directory(current, followed, allow_public_tmp=current == "/tmp")
        elif not stat.S_ISDIR(info.st_mode):
            _raise(f"IPC parent is not a directory: {current}")
        else:
            _check_ancestor_directory(current, info, allow_public_tmp=current == "/tmp")

    info = os.lstat(parent)
    owner_ids = {0, os.geteuid()}
    mode = stat.S_IMODE(info.st_mode)
    if not stat.S_ISDIR(info.st_mode):
        _raise(f"IPC parent is not a directory: {parent}")
    if info.st_uid not in owner_ids:
        _raise(f"IPC parent has unexpected owner: {parent}")
    if mode != PRIVATE_DIR_MODE:
        _raise(f"IPC parent must have mode 0700: {parent}")
    return parent


def _target_info(path, *, allow_missing=True):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if allow_missing:
            return None
        raise
    if stat.S_ISLNK(info.st_mode):
        _raise(f"IPC target is a symlink: {path}")
    if not stat.S_ISREG(info.st_mode):
        _raise(f"IPC target is not a regular file: {path}")
    if info.st_uid not in {0, os.geteuid()}:
        _raise(f"IPC target has unexpected owner: {path}")
    # A private parent protects read-only bits, but writable group/other bits
    # still indicate a bad deployment and allow tampering if the file escapes
    # that parent later. Tighten readable legacy files below; reject writes.
    if info.st_mode & 0o022:
        _raise(f"IPC target is group/world writable: {path}")
    return info


def _open_no_follow(path, flags, mode=IPC_FILE_MODE):
    flags |= getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags, mode)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.EMLINK):
            raise IpcPathError(errno.EPERM, f"IPC target is a symlink: {path}") from exc
        raise
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in {0, os.geteuid()}:
        os.close(fd)
        _raise(f"IPC target is not a trusted regular file: {path}")
    if info.st_mode & 0o022:
        os.close(fd)
        _raise(f"IPC target is group/world writable: {path}")
    # Tighten readable legacy files in place so an old 0644 deployment cannot
    # remain exposed after the first access.  If the running account cannot
    # chmod its own trusted file, fail closed instead of silently accepting
    # broad permissions.
    if stat.S_IMODE(info.st_mode) != IPC_FILE_MODE:
        try:
            os.fchmod(fd, IPC_FILE_MODE)
        except OSError as exc:
            os.close(fd)
            raise IpcPathError(errno.EPERM, f"IPC target mode cannot be tightened: {path}") from exc
    return fd


def secure_read_text(path, *, max_bytes=DEFAULT_MAX_READ_BYTES, encoding="utf-8"):
    """Read a bounded text file with O_NOFOLLOW and ownership checks."""

    ensure_private_parent(path, create=False)
    _target_info(path, allow_missing=False)
    fd = _open_no_follow(path, os.O_RDONLY)
    try:
        with os.fdopen(fd, "rb", closefd=True) as handle:
            raw = handle.read(max_bytes + 1)
        if len(raw) > max_bytes:
            _raise(f"IPC file exceeds {max_bytes} bytes: {path}")
        return raw.decode(encoding)
    except UnicodeDecodeError as exc:
        raise IpcPathError(errno.EINVAL, f"IPC file is not valid {encoding}: {path}") from exc


def secure_open_read(path):
    """Open a trusted regular IPC file for bounded/streaming reads.

    The caller owns and must close the returned descriptor.  This is used for
    the potentially large telemetry spool so it is never loaded wholesale
    into memory merely to enforce symlink checks.
    """

    ensure_private_parent(path, create=False)
    _target_info(path, allow_missing=False)
    return _open_no_follow(path, os.O_RDONLY)


def secure_read_json(path, *, max_bytes=DEFAULT_MAX_READ_BYTES):
    return json.loads(secure_read_text(path, max_bytes=max_bytes))


def atomic_write_bytes(path, payload, *, max_bytes=DEFAULT_MAX_READ_BYTES):
    """Atomically replace *path* using a random private temp file.

    ``mkstemp`` plus O_EXCL removes the fixed-suffix symlink race.  The target
    itself is checked before replacement; replacing an existing symlink is
    refused rather than silently unlinking an operator's unexpected file.
    """

    if not isinstance(payload, (bytes, bytearray, memoryview)):
        raise TypeError("payload must be bytes-like")
    payload = bytes(payload)
    if len(payload) > max_bytes:
        _raise(f"IPC payload exceeds {max_bytes} bytes: {path}")
    parent = ensure_private_parent(path, create=True)
    _target_info(path, allow_missing=True)
    fd, temp_path = tempfile.mkstemp(prefix=".ipc-", dir=parent)
    try:
        os.fchmod(fd, IPC_FILE_MODE)
        with os.fdopen(fd, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        # Recheck immediately before rename. If an operator created a symlink
        # while we were writing, fail closed and leave it visible for repair.
        _target_info(path, allow_missing=True)
        os.replace(temp_path, path)
        temp_path = None
        # Ensure the resulting inode retains the reviewed mode and is a
        # regular, non-symlink file before acknowledging the write.
        fd_check = _open_no_follow(path, os.O_RDONLY)
        try:
            os.fchmod(fd_check, IPC_FILE_MODE)
            os.fsync(fd_check)
        finally:
            os.close(fd_check)
        _fsync_parent(parent)
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def atomic_write_text(path, text, *, max_bytes=DEFAULT_MAX_READ_BYTES, encoding="utf-8"):
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    return atomic_write_bytes(path, text.encode(encoding), max_bytes=max_bytes)


def atomic_write_json(path, payload, *, max_bytes=DEFAULT_MAX_READ_BYTES):
    return atomic_write_text(
        path,
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        max_bytes=max_bytes,
    )


def secure_append_text(path, text, *, encoding="utf-8"):
    """Append to a private regular file without following a symlink."""

    if not isinstance(text, str):
        raise TypeError("text must be a string")
    ensure_private_parent(path, create=True)
    try:
        _target_info(path, allow_missing=True)
    except FileNotFoundError:
        pass
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    fd = _open_no_follow(path, flags, IPC_FILE_MODE)
    try:
        os.fchmod(fd, IPC_FILE_MODE)
        data = text.encode(encoding)
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def secure_open_append(path):
    """Open a private append-only file and return its descriptor.

    The descriptor is intended for subprocess stdout/stderr redirection; the
    caller is responsible for closing it.  It shares the exact checks used by
    :func:`secure_append_text`.
    """

    ensure_private_parent(path, create=True)
    _target_info(path, allow_missing=True)
    fd = _open_no_follow(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, IPC_FILE_MODE)
    os.fchmod(fd, IPC_FILE_MODE)
    return fd


def secure_unlink(path, *, missing_ok=True):
    """Unlink an IPC marker only when it is a trusted regular file."""

    ensure_private_parent(path, create=False)
    try:
        _target_info(path, allow_missing=missing_ok)
    except FileNotFoundError:
        if missing_ok:
            return False
        raise
    os.unlink(path)
    return True


def secure_exists(path):
    """Existence check that treats symlinks and unsafe files as errors."""

    ensure_private_parent(path, create=False)
    return _target_info(path, allow_missing=True) is not None


def secure_size(path):
    """Return a trusted IPC file's size, or zero when it is absent."""

    ensure_private_parent(path, create=False)
    info = _target_info(path, allow_missing=True)
    return int(info.st_size) if info is not None else 0


def _fsync_parent(parent):
    fd = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
