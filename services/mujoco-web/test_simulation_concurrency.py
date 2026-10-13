"""Mixed-engine concurrency regressions against the real authenticated ASGI app.

No renderer, fake engine, external service, or production identity is used.
Only expiry timestamps and the janitor interval are adjusted for the TTL case.
"""
from __future__ import annotations

import json
import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as playground
import simulation_auth as authentication
import task_simulation as tasks
from test_simulation_auth import AUTH_ENV_KEYS, SECRET, signed_headers


class SimulationConcurrencyTests(unittest.TestCase):
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
        self.assertEqual(authentication._session_owners, {})

    def tearDown(self):
        tasks.close_task_sessions()
        with playground._sessions_lock:
            playground._close_all_sessions()
        self.assertEqual(authentication._session_owners, {})
        self.environment.stop()

    def request(self, owner, method, path, payload=None):
        body = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        client = TestClient(playground.app)
        try:
            return client.request(method, path, content=body,
                                  headers=signed_headers(owner, method, path, body))
        finally:
            client.close()

    def create(self, owner, task, seed=7):
        root = "/api/task-sessions" if task else "/api/sessions"
        payload = {"taskId": "balance-stilts", "seed": seed} if task else {"model": "originbot", "seed": seed}
        response = self.request(owner, "POST", root, payload)
        return response, root

    def endpoint(self, state, root):
        return root + "/" + (state["sessionId"] if root.endswith("task-sessions") else state["id"])

    def parallel(self, operations, workers=None):
        """Release a whole batch together; collect every exception, never fire-and-forget."""
        start = threading.Event()

        def issue(operation):
            if not start.wait(5):
                raise AssertionError("Concurrent request batch did not start")
            return operation()

        with ThreadPoolExecutor(max_workers=workers or len(operations)) as pool:
            futures = [pool.submit(issue, operation) for operation in operations]
            start.set()
            return [future.result(timeout=20) for future in futures]

    def test_mixed_creation_race_cannot_exceed_an_account_quota_or_charge_another_owner(self):
        operations = [lambda task=index % 2 == 0: self.create("alice", task) for index in range(12)]
        results = self.parallel(operations)
        self.assertEqual(sorted(response.status_code for response, _ in results), [200] * 4 + [429] * 8)
        successful = [(response.json(), root) for response, root in results if response.status_code == 200]
        self.assertEqual(len(tasks._sessions) + len(playground._sessions), 4)
        self.assertEqual(list(authentication._session_owners.values()), ["alice"] * 4)
        bob = self.parallel([lambda task=index % 2 == 0: self.create("bob", task) for index in range(4)])
        self.assertTrue(all(response.status_code == 200 for response, _ in bob))
        deleted = self.parallel([lambda state=state, root=root: self.request("alice", "DELETE", self.endpoint(state, root))
                                 for state, root in successful])
        self.assertTrue(all(response.status_code == 200 for response in deleted))
        replacement = self.parallel(operations)
        self.assertEqual(sorted(response.status_code for response, _ in replacement), [200] * 4 + [429] * 8)
        self.assertEqual(sum(owner == "bob" for owner in authentication._session_owners.values()), 4)

    def test_multi_owner_parallel_steps_match_exact_serial_physics_and_foreign_mutations_do_not_apply(self):
        identities = [(f"account-{index}", task) for index in range(3) for task in (True, False)]
        created = self.parallel([lambda owner=owner, task=task: self.create(owner, task, 23)
                                 for owner, task in identities])
        sessions = []
        for index, ((owner, task), (response, root)) in enumerate(zip(identities, created)):
            self.assertEqual(response.status_code, 200, response.text)
            initial = response.json()
            endpoint = self.endpoint(initial, root)
            action = {"action": [0.05 * (index + 1)] * 14} if task else {"controls": [0.4 + index / 10, 0.2 + index / 10]}
            for _ in range(4):
                serial = self.request(owner, "POST", endpoint + "/step", action)
                self.assertEqual(serial.status_code, 200, serial.text)
            expected = serial.json()["replay"]
            reset = self.request(owner, "POST", endpoint + "/reset", {"seed": 23})
            self.assertEqual(reset.status_code, 200, reset.text)
            sessions.append((owner, endpoint, action, expected, initial["replay"]))

        operations = []
        for owner, endpoint, action, _, initial in sessions:
            for _ in range(4):
                operations.append(lambda owner=owner, endpoint=endpoint, action=action:
                                  self.request(owner, "POST", endpoint + "/step", action))
            for method, suffix, payload in (("GET", "/state", None), ("POST", "/reset", {}),
                                            ("POST", "/step", action), ("POST", "/replay", initial),
                                            ("DELETE", "", None)):
                operations.append(lambda method=method, endpoint=endpoint, suffix=suffix, payload=payload:
                                  self.request("intruder", method, endpoint + suffix, payload))
        responses = self.parallel(operations, workers=24)
        self.assertEqual(sorted(response.status_code for response in responses), [200] * 24 + [404] * 30)
        for owner, endpoint, _, expected, _ in sessions:
            state = self.request(owner, "GET", endpoint + "/state")
            self.assertEqual(state.status_code, 200, state.text)
            self.assertEqual(state.json()["replay"], expected, endpoint)
            self.assertGreater(state.json()["time"], 0)
        deleted = self.parallel([lambda owner=owner, endpoint=endpoint: self.request(owner, "DELETE", endpoint)
                                 for owner, endpoint, *_ in sessions])
        self.assertTrue(all(response.status_code == 200 for response in deleted))
        self.assertEqual(authentication._session_owners, {})

    def test_global_capacity_remains_atomic_for_mixed_simulators_across_many_accounts(self):
        operations = [lambda owner=f"account-{index // 4}", task=index % 2 == 0: self.create(owner, task)
                      for index in range(40)]
        responses = self.parallel(operations, workers=20)
        self.assertEqual(sorted(response.status_code for response, _ in responses), [200] * 32 + [429] * 8)
        self.assertEqual(len(tasks._sessions) + len(playground._sessions), 32)
        self.assertEqual(len(authentication._session_owners), 32)
        for owner in set(authentication._session_owners.values()):
            self.assertLessEqual(sum(value == owner for value in authentication._session_owners.values()), 4)
        self.assertEqual(self.create("new-account", True)[0].status_code, 429)
        self.assertEqual(self.create("new-account", False)[0].status_code, 429)

    def test_foreign_requests_cannot_refresh_idle_sessions_and_janitor_releases_both_quotas(self):
        alice, bob = [], []
        for owner, destination in (("alice", alice), ("bob", bob)):
            for task in (True, True, False, False):
                response, root = self.create(owner, task)
                self.assertEqual(response.status_code, 200, response.text)
                state = response.json()
                endpoint = self.endpoint(state, root)
                collection = tasks._sessions if task else playground._sessions
                session = collection[state["sessionId"] if task else state["id"]]
                destination.append((endpoint, session, task))
        for endpoint, session, task in alice:
            ttl = tasks.TASK_SESSION_TTL_SECONDS if task else playground.SESSION_TTL_SECONDS
            session.last_seen = time.monotonic() - ttl + 10
            previous = session.last_seen
            self.assertEqual(self.request("bob", "GET", endpoint + "/state").status_code, 404)
            self.assertEqual(session.last_seen, previous)
            session.last_seen -= 11
        for endpoint, _, _ in bob:
            self.assertEqual(self.request("bob", "GET", endpoint + "/state").status_code, 200)
        stop = threading.Event()
        with patch.object(playground, "SESSION_CLEANUP_INTERVAL_SECONDS", 0.01):
            janitor = threading.Thread(target=playground._session_cleanup_loop, args=(stop,), daemon=True)
            janitor.start()
            try:
                deadline = time.monotonic() + 3
                while "alice" in authentication._session_owners.values() and time.monotonic() < deadline:
                    stop.wait(0.01)
                self.assertNotIn("alice", authentication._session_owners.values())
            finally:
                stop.set()
                janitor.join(timeout=3)
        self.assertFalse(janitor.is_alive())
        self.assertEqual(list(authentication._session_owners.values()), ["bob"] * 4)
        for endpoint, _, _ in alice:
            self.assertEqual(self.request("alice", "GET", endpoint + "/state").status_code, 404)
        replenished = self.parallel([lambda task=index % 2 == 0: self.create("alice", task) for index in range(4)])
        self.assertTrue(all(response.status_code == 200 for response, _ in replenished))
        for endpoint, _, _ in bob:
            self.assertEqual(self.request("bob", "GET", endpoint + "/state").status_code, 200)


if __name__ == "__main__":
    unittest.main()
