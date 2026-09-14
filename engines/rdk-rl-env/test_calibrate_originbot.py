#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

from calibrate_originbot import estimate, load_rows


class CalibrationTest(unittest.TestCase):
    def test_fixture_stays_blocked_and_real_samples_are_eligible(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace.jsonl"
            rows = []
            for index in range(40):
                t = index * 0.1
                rows.append({"t": t, "source": "board-agent", "action": [0.2, 0.1], "actionOutput": "physical-twist",
                             "telemetry": {"odom": {"x": 0.02 * index, "y": 0.0, "yaw": 0.01 * index}}})
            path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
            report = estimate(load_rows(path))
            self.assertEqual(report["provenance"]["kind"], "real")
            self.assertEqual(report["recommendation"]["status"], "ready-for-review")

            for row in rows:
                row["source"] = "originbot-sim"
            path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
            report = estimate(load_rows(path))
            self.assertEqual(report["recommendation"]["status"], "blocked")

    def test_prefers_physical_cmd_vel_and_preserves_reverse_sign(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "board-trace.jsonl"
            rows = []
            # A reverse command should produce a negative signed body-frame
            # velocity. The policy action is intentionally unrelated and must
            # not be used for calibration when cmd_vel is present.
            for index in range(40):
                t = index * 0.1
                rows.append({
                    "t": t,
                    "source": "board-agent",
                    "action": [0.9, 0.9],
                    "cmd_vel": {"linear": -0.2, "angular": 0.0},
                    "odom": {"x": -0.02 * index, "y": 0.0, "yaw": 0.0},
                })
            path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
            report = estimate(load_rows(path))
            self.assertAlmostEqual(report["drive"]["linearGain"], 1.0, places=6)

    def test_expands_board_agent_record_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "uploaded-shard.jsonl"
            samples = []
            for index in range(40):
                samples.append({
                    "t": index * 0.1,
                    "telemetry": {
                        "odom": {"x": 0.02 * index, "y": 0.0, "yaw": 0.01 * index},
                    },
                    "cmd_vel": {"linear": 0.2, "angular": 0.1},
                })
            path.write_text(json.dumps({"source": "board-agent", "samples": samples}), encoding="utf-8")
            loaded = load_rows(path)
            self.assertEqual(len(loaded), 40)
            report = estimate(loaded)
            self.assertEqual(report["provenance"]["boardAgentSamples"], 40)
            self.assertEqual(report["recommendation"]["status"], "ready-for-review")


if __name__ == "__main__":
    unittest.main()
