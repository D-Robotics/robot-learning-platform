"""Signed bridge requests and cross-account simulator session regressions."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as playground
import task_simulation as tasks
import simulation_auth as authentication


SECRET = "test-simulation-secret-at-least-32-bytes"
AUTH_ENV_KEYS = (
    "RDK_SIM2REAL_SIMULATION_SECRET", "RDK_SIM2REAL_DEPLOYMENT",
    "RDK_STUDIO_DEPLOYMENT_PROFILE", "RDK_SIM2REAL_SSO_REQUIRED", "SSO_REQUIRED",
    "RDK_SIM2REAL_AUTH_MODE",
)


def signed_headers(owner: str, method: str, path: str, body: bytes = b"", timestamp: int | None = None):
    encoded = base64.urlsafe_b64encode(owner.encode("utf-8")).decode("ascii").rstrip("=")
    stamp = str(int(time.time()) if timestamp is None else timestamp)
    canonical = f"v1\n{stamp}\n{encoded}\n{method.upper()}\n{path}\n{hashlib.sha256(body).hexdigest()}"
    signature = hmac.new(SECRET.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "x-rdk-simulation-owner": encoded,
        "x-rdk-simulation-timestamp": stamp,
        "x-rdk-simulation-signature": signature,
        **({"content-type": "application/json"} if body else {}),
    }


class SimulationAuthTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {})
        self.environment.start()
        for key in AUTH_ENV_KEYS:
            os.environ.pop(key, None)
        os.environ["RDK_SIM2REAL_SIMULATION_SECRET"] = SECRET
        os.environ["RDK_SIM2REAL_DEPLOYMENT"] = "web-cloud"
        tasks.close_task_sessions()
        with playground._sessions_lock:
            playground._close_all_sessions()
        self.alice = TestClient(playground.app)
        self.bob = TestClient(playground.app)

    def tearDown(self):
        self.alice.close()
        self.bob.close()
        tasks.close_task_sessions()
        with playground._sessions_lock:
            playground._close_all_sessions()
        self.environment.stop()

    def request(self, owner: str, method: str, path: str, payload=None, client=None):
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return (client or self.alice).request(method, path, content=body, headers=signed_headers(owner, method, path, body))

    def create_task(self, owner="alice"):
        response = self.request(owner, "POST", "/api/task-sessions", {"taskId": "balance-stilts"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def create_originbot(self, owner="alice"):
        response = self.request(owner, "POST", "/api/sessions", {"model": "originbot"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_task_session_rejects_cross_account_reads_and_all_mutations_without_losing_owner_state(self):
        state = self.create_task()
        endpoint = f"/api/task-sessions/{state['sessionId']}"
        recorded = self.request("alice", "POST", endpoint + "/step", {"action": [.2] * 14}).json()
        for method, suffix, payload in (
            ("GET", "/state", None), ("POST", "/step", {"action": [0] * 14}),
            ("POST", "/reset", {}), ("POST", "/replay", recorded["replay"]), ("DELETE", "", None),
        ):
            with self.subTest(method=method, path=suffix):
                denied = self.request("bob", method, endpoint + suffix, payload, self.bob)
                self.assertEqual(denied.status_code, 404, denied.text)
        own = self.request("alice", "GET", endpoint + "/state")
        self.assertEqual(own.status_code, 200, own.text)
        self.assertEqual(own.json()["replay"], recorded["replay"])
        self.assertEqual(self.request("alice", "POST", endpoint + "/reset", {}).status_code, 200)
        restored = self.request("alice", "POST", endpoint + "/replay", recorded["replay"])
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["qpos"], recorded["qpos"])
        self.assertEqual(self.request("alice", "DELETE", endpoint).status_code, 200)
        self.assertEqual(self.request("alice", "DELETE", endpoint).status_code, 200)

    def test_originbot_checks_owner_before_state_images_and_every_control_operation(self):
        state = self.create_originbot()
        endpoint = f"/api/sessions/{state['id']}"
        recorded = self.request("alice", "POST", endpoint + "/cmd_vel", {"linear": .2, "angular": .1}).json()
        for method, suffix, payload in (
            ("GET", "/state", None), ("GET", "/frame.jpg", None),
            ("GET", "/depth.jpg", None), ("GET", "/depth.png", None),
            ("POST", "/step", {"controls": [0, 0]}), ("POST", "/cmd_vel", {"linear": 0}),
            ("POST", "/reset", {}), ("POST", "/replay", recorded["replay"]), ("DELETE", "", None),
        ):
            with self.subTest(method=method, path=suffix):
                denied = self.request("bob", method, endpoint + suffix, payload, self.bob)
                self.assertEqual(denied.status_code, 404, denied.text)
        own = self.request("alice", "GET", endpoint + "/state")
        self.assertEqual(own.status_code, 200, own.text)
        self.assertEqual(own.json()["replay"], recorded["replay"])
        with patch.object(playground, "_render", return_value=b"test-jpeg"):
            image = self.request("alice", "GET", endpoint + "/frame.jpg")
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.content, b"test-jpeg")
        self.assertEqual(self.request("alice", "POST", endpoint + "/reset", {}).status_code, 200)
        self.assertEqual(self.request("alice", "POST", endpoint + "/replay", recorded["replay"]).status_code, 200)
        self.assertEqual(self.request("alice", "DELETE", endpoint).status_code, 200)

    def test_anonymous_forged_owner_headers_expired_signatures_and_body_path_method_tampering_fail_closed(self):
        state = self.create_task("账号甲")
        endpoint = f"/api/task-sessions/{state['sessionId']}/state"
        self.assertEqual(self.alice.get(endpoint).status_code, 401)
        forged_owner = signed_headers("账号甲", "GET", endpoint)
        forged_owner["x-rdk-simulation-owner"] = signed_headers("bob", "GET", endpoint)["x-rdk-simulation-owner"]
        owner_only = {"x-rdk-simulation-owner": forged_owner["x-rdk-simulation-owner"]}
        for headers in (
            owner_only, forged_owner,
            signed_headers("账号甲", "GET", endpoint, timestamp=int(time.time()) - 61),
            signed_headers("账号甲", "GET", endpoint, timestamp=int(time.time()) + 61),
            signed_headers("账号甲", "DELETE", endpoint),
            signed_headers("账号甲", "GET", endpoint + "?frame=2"),
        ):
            self.assertEqual(self.alice.get(endpoint, headers=headers).status_code, 401)
        body = b'{"action":[0,0]}'
        signature = signed_headers("账号甲", "POST", endpoint.removesuffix("/state") + "/step", body)
        tampered = self.alice.post(endpoint.removesuffix("/state") + "/step", content=b'{"action":[1,1]}', headers=signature)
        self.assertEqual(tampered.status_code, 401)
        self.assertEqual(self.request("账号甲", "GET", endpoint + "?frame=2").status_code, 200)
        self.assertEqual(self.request("账号甲", "GET", endpoint).json()["stepCount"], 0)

    def test_shared_mode_without_a_valid_secret_blocks_sessions_but_keeps_catalog_health_public(self):
        for secret in (None, "short"):
            with self.subTest(secret=secret):
                if secret is None:
                    os.environ.pop("RDK_SIM2REAL_SIMULATION_SECRET", None)
                else:
                    os.environ["RDK_SIM2REAL_SIMULATION_SECRET"] = secret
                self.assertEqual(self.alice.post("/api/task-sessions", json={"taskId": "balance-stilts"}).status_code, 503)
                self.assertEqual(self.alice.post("/api/sessions", json={"model": "originbot"}).status_code, 503)
                self.assertEqual(self.alice.get("/api/task-scenes").status_code, 200)
                self.assertEqual(self.alice.get("/healthz").status_code, 200)

    def test_signature_window_is_inclusive_and_owner_encoding_and_duplicate_headers_are_strict(self):
        state = self.create_task()
        endpoint = f"/api/task-sessions/{state['sessionId']}/state"
        with patch.object(authentication.time, "time", return_value=2000.8):
            for stamp in (1940, 2060):
                accepted = self.alice.get(endpoint, headers=signed_headers("alice", "GET", endpoint, timestamp=stamp))
                self.assertEqual(accepted.status_code, 200, accepted.text)
            for stamp in (1939, 2061, "02000", "+2000"):
                rejected = self.alice.get(endpoint, headers=signed_headers("alice", "GET", endpoint, timestamp=stamp))
                self.assertEqual(rejected.status_code, 401)
        for owner in ("", "bad/owner", "bad\nowner", "x" * 161):
            self.assertEqual(self.alice.get(endpoint, headers=signed_headers(owner, "GET", endpoint)).status_code, 401)
        headers = list(signed_headers("alice", "GET", endpoint).items())
        headers.append(("x-rdk-simulation-owner", "Ym9i"))
        self.assertEqual(self.alice.get(endpoint, headers=headers).status_code, 401)

    def test_root_path_mount_does_not_bypass_session_authentication(self):
        with patch.object(playground.app, "root_path", "/lab"):
            endpoint = "/lab/api/task-sessions"
            self.assertEqual(self.alice.post(endpoint, json={"taskId": "balance-stilts"}).status_code, 401)
            signed = self.request("alice", "POST", endpoint, {"taskId": "balance-stilts"})
            self.assertEqual(signed.status_code, 200, signed.text)

    def test_parallel_requests_keep_each_authenticated_owner_context_separate(self):
        def create(owner):
            client = self.alice if owner == "alice" else self.bob
            response = self.request(owner, "POST", "/api/task-sessions", {"taskId": "balance-stilts"}, client)
            self.assertEqual(response.status_code, 200, response.text)
            return owner, response.json()["sessionId"]

        with ThreadPoolExecutor(max_workers=4) as pool:
            created = list(pool.map(create, ["alice", "bob", "alice", "bob"]))
        for owner, session_id in created:
            self.assertEqual(tasks._sessions[session_id].owner, owner)
            self.assertEqual(self.request(owner, "GET", f"/api/task-sessions/{session_id}/state").status_code, 200)
            other = "bob" if owner == "alice" else "alice"
            self.assertEqual(self.request(other, "GET", f"/api/task-sessions/{session_id}/state").status_code, 404)

    def test_local_unsigned_compatibility_never_uses_unverified_owner_headers(self):
        os.environ.pop("RDK_SIM2REAL_SIMULATION_SECRET", None)
        os.environ.pop("RDK_SIM2REAL_DEPLOYMENT", None)
        created = self.alice.post("/api/task-sessions", json={"taskId": "balance-stilts"}, headers={"x-rdk-simulation-owner": "Ym9i"})
        self.assertEqual(created.status_code, 200, created.text)
        session_id = created.json()["sessionId"]
        self.assertEqual(tasks._sessions[session_id].owner, "local-single-user")
        self.assertEqual(self.bob.get(f"/api/task-sessions/{session_id}/state").status_code, 200)

    def test_account_quota_is_shared_across_simulator_types_and_released_by_delete_and_ttl(self):
        first = self.create_task()
        self.create_task()
        self.create_originbot()
        self.create_originbot()
        denied = self.request("alice", "POST", "/api/task-sessions", {"taskId": "balance-stilts"})
        self.assertEqual(denied.status_code, 429, denied.text)
        self.assertEqual(self.request("bob", "POST", "/api/task-sessions", {"taskId": "balance-stilts"}).status_code, 200)
        self.assertEqual(self.request("alice", "DELETE", f"/api/task-sessions/{first['sessionId']}").status_code, 200)
        replacement = self.create_task()
        tasks._sessions[replacement["sessionId"]].last_seen -= tasks.TASK_SESSION_TTL_SECONDS + 1
        tasks.cleanup_task_sessions()
        originbot = self.create_originbot()
        playground._sessions[originbot["id"]].last_seen -= playground.SESSION_TTL_SECONDS + 1
        with playground._sessions_lock:
            playground._cleanup_sessions(time.monotonic())
        self.create_task()

    def test_global_session_capacity_is_bounded_across_accounts(self):
        for owner in range(8):
            for _ in range(4):
                self.create_task(f"owner-{owner}")
        denied = self.request("new-owner", "POST", "/api/sessions", {"model": "originbot"})
        self.assertEqual(denied.status_code, 429, denied.text)
        self.assertEqual(len(tasks._sessions), 32)

    def test_failed_session_creation_does_not_consume_an_account_reservation(self):
        for _ in range(5):
            rejected = self.request("alice", "POST", "/api/task-sessions", {"taskId": "missing-task"})
            self.assertEqual(rejected.status_code, 404, rejected.text)
        for _ in range(4):
            self.create_task()

    def test_signed_request_body_is_bounded_before_the_handler(self):
        endpoint = "/api/task-sessions"
        oversized = b"x" * (authentication.MAX_SIGNED_BODY_BYTES + 1)
        response = self.alice.post(endpoint, content=oversized, headers=signed_headers("alice", "POST", endpoint, oversized))
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertEqual(len(tasks._sessions), 0)


if __name__ == "__main__":
    unittest.main()
