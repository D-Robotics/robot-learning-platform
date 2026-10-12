"""Authenticate the private Node-to-Python simulation bridge and scope sessions.

The browser never receives the bridge secret. Public catalogs stay readable;
all session routes require a signed owner whenever a secret is configured.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import threading
import time
from contextvars import ContextVar

from fastapi import HTTPException
from starlette.responses import JSONResponse


LOCAL_OWNER = "local-single-user"
MAX_SIMULATION_SESSIONS = 32
MAX_OWNER_SIMULATION_SESSIONS = 4
MAX_SIGNED_BODY_BYTES = 2 * 1024 * 1024
SIGNATURE_MAX_AGE_SECONDS = 60
_owner = ContextVar("rdk_simulation_owner", default=LOCAL_OWNER)
_quota_lock = threading.RLock()
_session_owners: dict[tuple[str, str], str] = {}
_protected_route = re.compile(r"^/api/(?:task-)?sessions?(?:/|$)")
_header_names = (
    b"x-rdk-simulation-owner", b"x-rdk-simulation-timestamp", b"x-rdk-simulation-signature",
)


def current_owner() -> str:
    return _owner.get()


def reserve_session(kind: str, session_id: str, owner: str) -> None:
    """Both simulator types share one bounded pool and one account quota."""
    with _quota_lock:
        if len(_session_owners) >= MAX_SIMULATION_SESSIONS:
            raise HTTPException(429, "Simulation session capacity reached; close an idle session")
        if sum(existing == owner for existing in _session_owners.values()) >= MAX_OWNER_SIMULATION_SESSIONS:
            raise HTTPException(429, "Simulation account session capacity reached; close an idle session")
        _session_owners[(kind, session_id)] = owner


def release_session(kind: str, session_id: str) -> None:
    with _quota_lock:
        _session_owners.pop((kind, session_id), None)


def shared_mode() -> bool:
    return (
        any(os.environ.get(key, "").strip() == "web-cloud"
            for key in ("RDK_SIM2REAL_DEPLOYMENT", "RDK_STUDIO_DEPLOYMENT_PROFILE"))
        or any(os.environ.get(key, "").strip() == "1"
               for key in ("RDK_SIM2REAL_SSO_REQUIRED", "SSO_REQUIRED"))
        or os.environ.get("RDK_SIM2REAL_AUTH_MODE", "").strip().lower()
        in ("studio-cookie", "trusted-proxy", "user-center")
    )


def _signed_owner(scope, secret: bytes, body: bytes) -> str | None:
    values = {}
    for name in _header_names:
        matching = [value for key, value in scope.get("headers", []) if key.lower() == name]
        if len(matching) != 1:
            return None
        try:
            values[name] = matching[0].decode("ascii")
        except UnicodeDecodeError:
            return None
    encoded, stamp, signature = (values[name] for name in _header_names)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,856}", encoded):
        return None
    if not re.fullmatch(r"(?:0|[1-9][0-9]{0,12})", stamp):
        return None
    if abs(int(time.time()) - int(stamp)) > SIGNATURE_MAX_AGE_SECONDS:
        return None
    if not re.fullmatch(r"[0-9a-f]{64}", signature):
        return None
    try:
        raw_path = scope.get("raw_path", scope["path"].encode("utf-8")).decode("ascii")
        query = scope.get("query_string", b"").decode("ascii")
        target = raw_path + ("?" + query if query else "")
        canonical = f"v1\n{stamp}\n{encoded}\n{scope['method'].upper()}\n{target}\n{hashlib.sha256(body).hexdigest()}"
        expected = hmac.new(secret, canonical.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        owner_bytes = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
        owner = owner_bytes.decode("utf-8")
        if base64.urlsafe_b64encode(owner_bytes).decode("ascii").rstrip("=") != encoded:
            return None
        if not owner or len(owner) > 160 or re.search(r"[\x00-\x1f\x7f/]", owner):
            return None
        return owner
    except (UnicodeError, ValueError):
        return None


class SimulationAuthMiddleware:
    """Pure ASGI middleware replays the exact body for older Starlette versions."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        root = scope.get("root_path", "")
        route_path = path[len(root):] if root and path.startswith(root + "/") else path
        if scope["type"] != "http" or not _protected_route.match(route_path):
            await self.app(scope, receive, send)
            return
        configured = os.environ.get("RDK_SIM2REAL_SIMULATION_SECRET", "")
        secret = configured.encode("utf-8")
        if (configured and len(secret) < 32) or (not configured and shared_mode()):
            response = JSONResponse({"ok": False, "error": "SIMULATION_AUTH_UNAVAILABLE",
                                     "message": "Simulation authentication is not configured"}, status_code=503,
                                    headers={"Cache-Control": "no-store"})
            await response(scope, receive, send)
            return
        if not configured:
            token = _owner.set(LOCAL_OWNER)
            try:
                await self.app(scope, receive, send)
            finally:
                _owner.reset(token)
            return

        body_parts, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > MAX_SIGNED_BODY_BYTES:
                response = JSONResponse({"ok": False, "error": "SIMULATION_BODY_TOO_LARGE",
                                         "message": "Simulation request exceeds the body limit"}, status_code=413,
                                        headers={"Cache-Control": "no-store"})
                await response(scope, receive, send)
                return
            body_parts.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(body_parts)
        owner = _signed_owner(scope, secret, body)
        if owner is None:
            response = JSONResponse({"ok": False, "error": "SIMULATION_AUTH_INVALID",
                                     "message": "A valid signed simulation request is required"}, status_code=401,
                                    headers={"Cache-Control": "no-store"})
            await response(scope, receive, send)
            return
        sent = False

        async def replay_receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        token = _owner.set(owner)
        try:
            await self.app(scope, replay_receive, send)
        finally:
            _owner.reset(token)
