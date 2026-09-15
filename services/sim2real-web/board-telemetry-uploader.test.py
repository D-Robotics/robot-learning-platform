#!/usr/bin/env python3
"""Small deterministic tests for board telemetry credential selection."""

import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "board_telemetry_uploader", HERE / "board-telemetry-uploader.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class TelemetryUploaderCredentialTests(unittest.TestCase):
    def test_canonical_token_wins_over_legacy_alias(self):
        token, source = MODULE._select_token(
            {
                "RDK_SIM2REAL_TELEMETRY_ATTESTATION_TOKEN": "signed-token",
                "RDK_SIM2REAL_TELEMETRY_TOKEN": "legacy-token",
            }
        )
        self.assertEqual((token, source), ("signed-token", "RDK_SIM2REAL_TELEMETRY_ATTESTATION_TOKEN"))

    def test_legacy_alias_remains_usable_during_rollout(self):
        token, source = MODULE._select_token(
            {"RDK_SIM2REAL_TELEMETRY_TOKEN": "legacy-token"}
        )
        self.assertEqual((token, source), ("legacy-token", "RDK_SIM2REAL_TELEMETRY_TOKEN"))

    def test_empty_credentials_do_not_emit_authorization_header(self):
        token, source = MODULE._select_token({})
        self.assertEqual((token, source), ("", None))
        previous = MODULE.TOKEN
        try:
            MODULE.TOKEN = ""
            self.assertEqual(MODULE._authorization_headers(), {})
        finally:
            MODULE.TOKEN = previous


class TelemetryUploaderFileSecurityTests(unittest.TestCase):
    def setUp(self):
        self.workdir = tempfile.mkdtemp(prefix="telemetry-uploader-test-")
        self.spool = os.path.join(self.workdir, "policy.jsonl")
        self.checkpoint = os.path.join(self.workdir, "policy.offset")
        self.previous_spool = MODULE.SPOOL
        self.previous_checkpoint = MODULE.CHECKPOINT
        MODULE.SPOOL = self.spool
        MODULE.CHECKPOINT = self.checkpoint

    def tearDown(self):
        MODULE.SPOOL = self.previous_spool
        MODULE.CHECKPOINT = self.previous_checkpoint

    def test_checkpoint_ignores_legacy_tmp_symlink_and_is_private(self):
        outside = os.path.join(self.workdir, "outside")
        with open(outside, "w") as handle:
            handle.write("sentinel")
        os.symlink(outside, self.checkpoint + ".tmp")
        MODULE._save_offset(42)
        self.assertEqual(MODULE._offset(), 42)
        self.assertEqual(stat.S_IMODE(os.stat(self.checkpoint).st_mode), 0o600)
        with open(outside) as handle:
            self.assertEqual(handle.read(), "sentinel")

    def test_spool_symlink_is_not_read(self):
        outside = os.path.join(self.workdir, "outside.jsonl")
        with open(outside, "w") as handle:
            handle.write('{"secret":true}\n')
        os.symlink(outside, self.spool)
        self.assertEqual(MODULE._read_batch(0), ([], 0))

    def test_batch_closes_at_session_boundary(self):
        # The runtime resets t at each session; a batch that crosses the
        # boundary is rejected whole by the ingest API's non-decreasing-t
        # rule, so the reader must stop before the first decreasing t.
        rows = [
            {"t": 0.0, "observation": [0.1], "action": [0.2]},
            {"t": 0.1, "observation": [0.1], "action": [0.2]},
            {"t": 0.2, "observation": [0.1], "action": [0.2]},
            {"t": 0.002, "observation": [0.1], "action": [0.2]},
            {"t": 0.1, "observation": [0.1], "action": [0.2]},
        ]
        with open(self.spool, "w") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")
        batch, end = MODULE._read_batch(0)
        self.assertEqual([item["t"] for item in batch], [0.0, 0.1, 0.2])
        self.assertEqual(end, sum(len(json.dumps(row) + "\n") for row in rows[:3]))

    def test_batch_continues_across_event_markers(self):
        # Event rows ride the same spool with their own session-relative t;
        # only a decreasing t on a control sample closes the batch.
        rows = [
            {"t": 1.0, "observation": [0.1], "action": [0.2]},
            {"t": 1.5, "event": {"kind": "session-stopped"}},
            {"t": 1.6, "observation": [0.1], "action": [0.2]},
        ]
        with open(self.spool, "w") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")
        batch, end = MODULE._read_batch(0)
        self.assertEqual(len(batch), 3)
        self.assertEqual(end, sum(len(json.dumps(row) + "\n") for row in rows))


if __name__ == "__main__":
    unittest.main()
