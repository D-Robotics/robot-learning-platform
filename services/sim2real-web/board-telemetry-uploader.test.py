#!/usr/bin/env python3
"""Small deterministic tests for board telemetry credential selection."""

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
