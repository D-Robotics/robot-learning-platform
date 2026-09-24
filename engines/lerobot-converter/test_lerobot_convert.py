#!/usr/bin/env python3
"""Contract tests for the LeRobot v3.0 dataset converter.

Runs on the development machine (no ROS, no board, no lerobot install) with
`python3 engines/lerobot-converter/test_lerobot_convert.py` (also works
under pytest). numpy missing -> print SKIP and exit 0 (the sibling engines'
convention); pyarrow/ffmpeg missing -> the tests that need them skipUnless,
everything else (row parsing, episode splitting, meta structures, fail-closed
gates) still runs for real.

What these tests protect:
- the three accepted input shapes (bare step rows, microduck-trajectory-v1
  recorder rows, telemetry sample envelopes) parse to the same episodes, with
  time-field aliases, event-row dropping, and done/EOF episode boundaries;
- the fail-closed family: inconsistent dimensions, non-numeric/NaN values,
  empty dataset, unknown row types, non-boolean done, partial optional
  fields (reward / cameraFrame), malformed or mixed camera frames, v1.0
  datasets, video datasets without --with-video, non-empty output dirs —
  each refused with a `line %d`-carrying message and NO partial output;
- the meta layer matches the official v3.0 field names and conventions
  (codebase_version, path templates, splits format, DEFAULT_FEATURES dtypes,
  float32 data features, channels-first video shapes, v2.1-era totals);
- the round trip export -> import -> export preserves episode structure and
  obs/act values (rtol 1e-6), and the import output satisfies the ACT
  engine's dataset loader semantics (re-implemented minimally here — the act
  module itself is deliberately not imported);
- determinism: the same input exported twice writes byte-identical
  info.json / episodes.jsonl / tasks.jsonl;
- video: mono8 cameraFrame survives export -> import --with-video
  byte-for-byte (lossless monochrome H.264);
- import reads all three on-disk layouts: this tool's v3.0 (episode-per-file),
  v2.1 Hub datasets, and current-main file-sharded v3.0 with parquet metadata.
"""

import base64
import json
import math
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ENGINE = os.path.join(HERE, "lerobot_convert.py")

sys.path.insert(0, HERE)

try:
    import numpy as np
except ImportError:
    print("[lerobot-converter] SKIP — python3 with numpy not found")
    sys.exit(0)

try:
    import pyarrow  # noqa: F401

    PYARROW_AVAILABLE = True
except ImportError:
    PYARROW_AVAILABLE = False

FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None

import lerobot_convert  # noqa: E402  (after the sys.path insert and skip guards)


# ---------------------------------------------------------------------------
# Deterministic synthetic data.
# ---------------------------------------------------------------------------

def make_episode(steps, obs=3, act=2, offset=0.0, reward=False):
    """Deterministic episode values chosen to survive a float32 round trip
    (small rationals) — the round-trip test compares with rtol=1e-6."""
    observations, actions, rewards = [], [], []
    for i in range(steps):
        observations.append(
            [float((i + offset) % 7) * 0.25 + 0.5 * j for j in range(obs)]
        )
        actions.append(
            [float((i + offset) % 5) * 0.2 - 0.1 * j for j in range(act)]
        )
        if reward:
            rewards.append(float(i) * 0.5)
    return observations, actions, rewards


def recorder_rows(episodes, reward=False):
    """Serialize episodes the way the browser recorder does: header, then
    step rows, with done=true closing each episode."""
    rows = [
        {
            "type": "header",
            "format": "microduck-trajectory-v1",
            "source": "test",
            "sampleHz": 50,
            "note": "episodes",
        }
    ]
    for observations, actions, rewards in episodes:
        for t in range(len(observations)):
            row = {
                "type": "step",
                "t": 0.02 * t,
                "observation": observations[t],
                "action": actions[t],
                "done": t == len(observations) - 1,
            }
            if reward:
                row["reward"] = rewards[t]
            rows.append(row)
    return rows


def write_jsonl(path, rows):
    pathlib.Path(path).write_text(
        "\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8"
    )


def mono_frame(width, height, fill):
    """A deterministic mono8 frame (row-major raw bytes)."""
    return bytes((fill + 7 * i) % 256 for i in range(width * height))


def camera_field(encoding, width, height, raw):
    channels = 1 if encoding == "mono8" else 3
    return {
        "encoding": encoding,
        "width": width,
        "height": height,
        "channels": channels,
        "data": base64.b64encode(raw).decode("ascii"),
    }


def write_episode_parquet(path, observations, actions, episode_index,
                          start_index, timestamps):
    """Write one episode-shaped parquet shard with the official column set
    (used to fabricate v2.1 / v3.0 fixtures and to corrupt exports)."""
    import pyarrow
    import pyarrow.parquet as pq

    length = len(observations)
    data = {
        "observation.state": pyarrow.array(
            observations, type=pyarrow.list_(pyarrow.float32())
        ),
        "action": pyarrow.array(actions, type=pyarrow.list_(pyarrow.float32())),
        "timestamp": pyarrow.array(timestamps, type=pyarrow.float32()),
        "frame_index": pyarrow.array(list(range(length)), type=pyarrow.int64()),
        "episode_index": pyarrow.array(
            [episode_index] * length, type=pyarrow.int64()
        ),
        "index": pyarrow.array(
            list(range(start_index, start_index + length)), type=pyarrow.int64()
        ),
        "task_index": pyarrow.array([0] * length, type=pyarrow.int64()),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pyarrow.table(data), path)


def act_load_dataset_equivalent(path):
    """Minimal copy of engines/act/train_act.py load_dataset semantics.

    The converter must NOT import the act engine (it is a data tool, not
    part of the training stack), so trainability is asserted by replicating
    the loader's rules: header/step types only, numeric finite lists,
    consistent dimensions, boolean done, done/EOF episode boundaries,
    non-empty dataset. Raises ValueError on any rule the import output
    would break.
    """
    episodes = []
    current_obs, current_act = [], []
    obs_size = act_size = None
    for line_no, line in enumerate(
        pathlib.Path(path).read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict):
            raise ValueError("line %d: each row must be a JSON object" % line_no)
        row_type = row.get("type")
        if row_type is not None and row_type not in ("header", "step"):
            raise ValueError("line %d: unknown row type %r" % (line_no, row_type))
        if row_type == "header":
            continue
        obs = row.get("observation")
        act = row.get("action")
        if not isinstance(obs, list) or not isinstance(act, list):
            raise ValueError("line %d: observation/action required" % line_no)
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in obs + act):
            raise ValueError("line %d: values must be numeric" % line_no)
        if any(not math.isfinite(v) for v in obs + act):
            raise ValueError("line %d: values must be finite" % line_no)
        if obs_size is None:
            obs_size, act_size = len(obs), len(act)
        if len(obs) != obs_size or len(act) != act_size:
            raise ValueError("line %d: inconsistent dimensions" % line_no)
        done = row.get("done", False)
        if not isinstance(done, bool):
            raise ValueError("line %d: done must be a boolean" % line_no)
        current_obs.append(obs)
        current_act.append(act)
        if done:
            episodes.append((current_obs, current_act))
            current_obs, current_act = [], []
    if current_obs:
        episodes.append((current_obs, current_act))
    if not episodes:
        raise ValueError("dataset is empty")
    return episodes, obs_size, act_size


# ---------------------------------------------------------------------------
# Row parsing (pure logic — no pyarrow).
# ---------------------------------------------------------------------------

class RowParsingTest(unittest.TestCase):
    def test_bare_step_rows_with_done_and_eof(self):
        rows = [
            {"t": 0.0, "observation": [1.0, 2.0, 3.0], "action": [0.1], "done": True},
            {"t": 0.02, "observation": [4.0, 5.0, 6.0], "action": [0.2]},
        ]
        with tempfile.TemporaryDirectory(prefix="lc-bare-") as workdir:
            path = os.path.join(workdir, "bare.jsonl")
            write_jsonl(path, rows)
            dataset = lerobot_convert.load_trajectory_dataset([path])
        self.assertEqual(len(dataset.episodes), 2)
        self.assertEqual([len(ep) for ep in dataset.episodes], [1, 1])
        self.assertEqual(dataset.obs_dim, 3)
        self.assertEqual(dataset.act_dim, 1)
        self.assertEqual(dataset.episodes[0][0]["t"], 0.0)

    def test_recorder_format_header_steps_and_events(self):
        episodes = [make_episode(4), make_episode(3, offset=2.0)]
        rows = recorder_rows(episodes)
        rows.insert(1, {"type": "event", "event": "episode_start"})
        rows.insert(6, {"type": "event", "event": "recording_paused"})
        with tempfile.TemporaryDirectory(prefix="lc-rec-") as workdir:
            path = os.path.join(workdir, "rec.jsonl")
            write_jsonl(path, rows)
            dataset = lerobot_convert.load_trajectory_dataset([path])
        self.assertEqual(len(dataset.episodes), 2)
        self.assertEqual([len(ep) for ep in dataset.episodes], [4, 3])
        self.assertEqual(dataset.sample_hz, {50})
        # Events are dropped, not frames.
        self.assertEqual(
            dataset.episodes[0][1]["observation"], episodes[0][0][1]
        )

    def test_telemetry_envelope_samples(self):
        envelope = {
            "runId": "run-17",
            "samples": [
                {"type": "step", "t": 0.0, "observation": [0.0, 0.1], "action": [0.5]},
                {"t": 0.02, "observation": [0.2, 0.3], "action": [0.4], "done": True},
            ],
        }
        with tempfile.TemporaryDirectory(prefix="lc-env-") as workdir:
            path = os.path.join(workdir, "shard.jsonl")
            write_jsonl(path, [envelope, envelope])
            dataset = lerobot_convert.load_trajectory_dataset([path])
        self.assertEqual(len(dataset.episodes), 2)
        self.assertEqual(dataset.episodes[1][0]["observation"], [0.0, 0.1])
        self.assertEqual(dataset.obs_dim, 2)

    def test_time_field_aliases(self):
        with tempfile.TemporaryDirectory(prefix="lc-time-") as workdir:
            path = os.path.join(workdir, "aliases.jsonl")
            write_jsonl(
                path,
                [
                    {"time": 1.0, "observation": [0.0], "action": [0.0], "done": True},
                    {"timestamp": 2.5, "observation": [0.0], "action": [0.0], "done": True},
                    {"t": 4.0, "observation": [0.0], "action": [0.0]},
                ],
            )
            dataset = lerobot_convert.load_trajectory_dataset([path])
        self.assertEqual(
            [step["t"] for episode in dataset.episodes for step in episode],
            [1.0, 2.5, 4.0],
        )

    def test_state_alias_for_observation(self):
        with tempfile.TemporaryDirectory(prefix="lc-state-") as workdir:
            path = os.path.join(workdir, "state.jsonl")
            write_jsonl(
                path,
                [{"state": [7.0, 8.0], "action": [1.0], "done": True}],
            )
            dataset = lerobot_convert.load_trajectory_dataset([path])
        self.assertEqual(dataset.episodes[0][0]["observation"], [7.0, 8.0])
        self.assertEqual(dataset.obs_dim, 2)

    def test_multiple_input_files_concatenate_as_episode_sources(self):
        episodes = [make_episode(3), make_episode(2, offset=1.0)]
        with tempfile.TemporaryDirectory(prefix="lc-multi-") as workdir:
            first = os.path.join(workdir, "a.jsonl")
            second = os.path.join(workdir, "b.jsonl")
            write_jsonl(first, recorder_rows([episodes[0]]))
            # No done on the last row: EOF closes the episode.
            write_jsonl(
                second,
                [
                    {"observation": episodes[1][0][0], "action": episodes[1][1][0]},
                    {"observation": episodes[1][0][1], "action": episodes[1][1][1]},
                ],
            )
            dataset = lerobot_convert.load_trajectory_dataset([first, second])
        self.assertEqual([len(ep) for ep in dataset.episodes], [3, 2])
        self.assertEqual(dataset.episodes[1][0]["observation"], episodes[1][0][0])

    def test_eof_closes_open_episode_per_file(self):
        rows = recorder_rows([make_episode(2)])
        rows.pop()  # drop the done row: file must still close the episode
        with tempfile.TemporaryDirectory(prefix="lc-eof-") as workdir:
            path = os.path.join(workdir, "eof.jsonl")
            write_jsonl(path, rows)
            dataset = lerobot_convert.load_trajectory_dataset([path])
        self.assertEqual([len(ep) for ep in dataset.episodes], [1])

    def test_reward_and_camera_collected(self):
        raw = mono_frame(4, 2, 3)
        with tempfile.TemporaryDirectory(prefix="lc-opt-") as workdir:
            path = os.path.join(workdir, "opt.jsonl")
            write_jsonl(
                path,
                [
                    {
                        "type": "step",
                        "observation": [0.0],
                        "action": [0.0],
                        "reward": 1.5,
                        "cameraFrame": camera_field("mono8", 4, 2, raw),
                    },
                    {
                        "type": "step",
                        "observation": [0.1],
                        "action": [0.1],
                        "reward": 0.5,
                        "cameraFrame": camera_field("mono8", 4, 2, raw),
                        "done": True,
                    },
                ],
            )
            dataset = lerobot_convert.load_trajectory_dataset([path])
        self.assertTrue(dataset.has_reward)
        self.assertEqual(dataset.camera_spec["width"], 4)
        self.assertEqual(dataset.episodes[0][0]["camera"], raw)


# ---------------------------------------------------------------------------
# Fail-closed parsing (pure logic — no pyarrow).
# ---------------------------------------------------------------------------

class FailClosedParsingTest(unittest.TestCase):
    def _dataset_from_rows(self, rows):
        with tempfile.TemporaryDirectory(prefix="lc-bad-") as workdir:
            path = os.path.join(workdir, "bad.jsonl")
            write_jsonl(path, rows)
            return lerobot_convert.load_trajectory_dataset([path])

    def test_inconsistent_dimensions(self):
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [
                    {"observation": [1, 2], "action": [0.1], "done": True},
                    {"observation": [1, 2, 3], "action": [0.1], "done": True},
                ]
            )
        self.assertIn("line 2", str(ctx.exception))
        self.assertIn("inconsistent dimensions", str(ctx.exception))

    def test_non_numeric_values(self):
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [{"observation": [1, "a"], "action": [0.1], "done": True}]
            )
        self.assertIn("line 1", str(ctx.exception))
        self.assertIn("numeric", str(ctx.exception))

    def test_boolean_values_are_not_numbers(self):
        with self.assertRaises(ValueError):
            self._dataset_from_rows(
                [{"observation": [True], "action": [0.1], "done": True}]
            )

    def test_nan_values(self):
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [{"observation": [1, float("nan")], "action": [0.1], "done": True}]
            )
        self.assertIn("finite", str(ctx.exception))

    def test_empty_dataset(self):
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows([{"type": "header", "format": "microduck-trajectory-v1"}])
        self.assertIn("empty", str(ctx.exception))

    def test_unknown_row_type(self):
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [{"type": "weird", "observation": [1, 2], "action": [0.1]}]
            )
        self.assertIn("line 1", str(ctx.exception))
        self.assertIn("unknown row type", str(ctx.exception))

    def test_non_bool_done(self):
        with self.assertRaises(ValueError):
            self._dataset_from_rows(
                [{"observation": [1, 2], "action": [0.1], "done": "yes"}]
            )

    def test_missing_action(self):
        with self.assertRaises(ValueError):
            self._dataset_from_rows(
                [{"type": "step", "observation": [1, 2], "done": True}]
            )

    def test_envelope_sample_error_carries_line_and_sample(self):
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [
                    {
                        "runId": "r",
                        "samples": [
                            {"type": "step", "observation": [1, "x"], "action": [0.0]}
                        ],
                    }
                ]
            )
        self.assertIn("line 1 sample 0", str(ctx.exception))

    def test_partial_reward_presence(self):
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [
                    {"observation": [1.0], "action": [0.1]},
                    {"observation": [1.0], "action": [0.1], "reward": 1.0, "done": True},
                ]
            )
        self.assertIn("reward", str(ctx.exception))

    def test_partial_cameraframe_presence(self):
        raw = mono_frame(2, 2, 0)
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [
                    {"observation": [1.0], "action": [0.1], "done": True},
                    {
                        "observation": [1.0],
                        "action": [0.1],
                        "cameraFrame": camera_field("mono8", 2, 2, raw),
                        "done": True,
                    },
                ]
            )
        self.assertIn("cameraFrame", str(ctx.exception))

    def test_cameraframe_wrong_channels(self):
        raw = mono_frame(2, 2, 0)
        # Payload length is consistent with channels=3 so the CHANNEL check
        # (not the payload check) must fire.
        field = {
            "encoding": "mono8", "width": 2, "height": 2, "channels": 3,
            "data": base64.b64encode(raw * 3).decode("ascii"),
        }
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [
                    {
                        "observation": [1.0],
                        "action": [0.1],
                        "cameraFrame": field,
                        "done": True,
                    }
                ]
            )
        self.assertIn("channels", str(ctx.exception))

    def test_cameraframe_bad_payload_length(self):
        field = {
            "encoding": "mono8", "width": 4, "height": 2, "channels": 1,
            "data": base64.b64encode(b"\x00" * 5).decode("ascii"),
        }
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [{"observation": [1.0], "action": [0.1], "cameraFrame": field, "done": True}]
            )
        self.assertIn("payload", str(ctx.exception))

    def test_cameraframe_unknown_encoding(self):
        field = {"encoding": "yuv422", "width": 2, "height": 2, "channels": 1, "data": ""}
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [{"observation": [1.0], "action": [0.1], "cameraFrame": field, "done": True}]
            )
        self.assertIn("encoding", str(ctx.exception))

    def test_cameraframe_mixed_resolutions(self):
        small = mono_frame(2, 2, 0)
        large = mono_frame(4, 4, 0)
        with self.assertRaises(ValueError) as ctx:
            self._dataset_from_rows(
                [
                    {
                        "observation": [1.0], "action": [0.1],
                        "cameraFrame": camera_field("mono8", 2, 2, small),
                    },
                    {
                        "observation": [1.0], "action": [0.1],
                        "cameraFrame": camera_field("mono8", 4, 4, large),
                        "done": True,
                    },
                ]
            )
        self.assertIn("differs", str(ctx.exception))

    def test_conflicting_sample_hz_without_fps_flag(self):
        rows = [
            {"type": "header", "sampleHz": 50},
            {"observation": [1.0], "action": [0.1], "done": True},
            {"type": "header", "sampleHz": 30},
            {"observation": [1.0], "action": [0.1], "done": True},
        ]
        dataset = self._dataset_from_rows(rows)
        with self.assertRaises(ValueError) as ctx:
            lerobot_convert.resolve_fps(None, dataset)
        self.assertIn("conflicting", str(ctx.exception))
        # --fps overrides the conflict.
        self.assertEqual(lerobot_convert.resolve_fps(25, dataset), 25)


# ---------------------------------------------------------------------------
# Meta structures (in-memory dicts — no pyarrow).
# ---------------------------------------------------------------------------

class MetaStructureTest(unittest.TestCase):
    def _dataset(self, episodes=None, reward=False):
        rows = recorder_rows(episodes or [make_episode(3)], reward=reward)
        with tempfile.TemporaryDirectory(prefix="lc-meta-") as workdir:
            path = os.path.join(workdir, "meta.jsonl")
            write_jsonl(path, rows)
            return lerobot_convert.load_trajectory_dataset([path])

    def test_info_json_structure(self):
        dataset = self._dataset([make_episode(4), make_episode(2, offset=1.0)])
        info = lerobot_convert.build_info_json(dataset, fps=50, task="pick the cube")
        self.assertEqual(info["codebase_version"], "v3.0")
        self.assertEqual(info["robot_type"], "rdk")
        self.assertEqual(info["total_episodes"], 2)
        self.assertEqual(info["total_frames"], 6)
        self.assertEqual(info["total_tasks"], 1)
        self.assertEqual(info["total_videos"], 0)
        self.assertEqual(info["total_chunks"], 1)
        self.assertEqual(info["chunks_size"], 1000)
        self.assertEqual(
            info["data_path"],
            "data/chunk-{chunk_index:03d}/episode_{episode_index:06d}.parquet",
        )
        self.assertIsNone(info["video_path"])  # tabular-only: official use_videos=False
        self.assertEqual(info["fps"], 50)
        self.assertEqual(info["splits"], {"train": "0:2"})
        self.assertEqual(info["features"]["observation.state"]["dtype"], "float32")
        self.assertEqual(info["features"]["observation.state"]["shape"], [3])
        self.assertEqual(info["features"]["action"]["dtype"], "float32")
        self.assertEqual(info["features"]["action"]["shape"], [2])
        # Official DEFAULT_FEATURES, exact dtypes and shapes.
        self.assertEqual(info["features"]["timestamp"], {"dtype": "float32", "shape": [1], "names": None})
        self.assertEqual(info["features"]["frame_index"], {"dtype": "int64", "shape": [1], "names": None})
        self.assertEqual(info["features"]["episode_index"], {"dtype": "int64", "shape": [1], "names": None})
        self.assertEqual(info["features"]["index"], {"dtype": "int64", "shape": [1], "names": None})
        self.assertEqual(info["features"]["task_index"], {"dtype": "int64", "shape": [1], "names": None})
        self.assertNotIn("reward", info["features"])

    def test_info_json_chunk_math(self):
        info = lerobot_convert.build_info_json(
            self._dataset(), fps=50, task="t", chunks_size=2
        )
        # A dataset with one episode at chunks_size 2 still lands in chunk 0.
        self.assertEqual(info["total_chunks"], 1)

    def test_info_json_with_reward(self):
        dataset = self._dataset([make_episode(3, reward=True)], reward=True)
        info = lerobot_convert.build_info_json(dataset, fps=50, task="t")
        self.assertEqual(
            info["features"]["reward"],
            {"dtype": "float32", "shape": [1], "names": None},
        )

    def test_info_json_with_camera(self):
        camera = {"encoding": "mono8", "width": 8, "height": 6, "channels": 1}
        dataset = self._dataset([make_episode(2)])
        dataset.has_camera = True
        dataset.camera_spec = camera
        info = lerobot_convert.build_info_json(dataset, fps=50, task="t")
        video = info["features"]["observation.images.camera_frame"]
        self.assertEqual(video["dtype"], "video")
        self.assertEqual(video["shape"], [1, 6, 8])  # channels-first (C, H, W)
        self.assertEqual(info["total_videos"], 1)
        self.assertEqual(
            info["video_path"],
            "videos/chunk-{chunk_index:03d}/{video_key}/episode_{episode_index:06d}.mp4",
        )

    def test_episodes_and_tasks_lines(self):
        dataset = self._dataset([make_episode(4), make_episode(2, offset=1.0)])
        episodes = lerobot_convert.build_episode_lines(dataset, "stack rings")
        self.assertEqual(
            episodes,
            [
                {"episode_index": 0, "tasks": ["stack rings"], "length": 4},
                {"episode_index": 1, "tasks": ["stack rings"], "length": 2},
            ],
        )
        tasks = lerobot_convert.build_tasks_lines("stack rings")
        self.assertEqual(tasks, [{"task_index": 0, "task": "stack rings"}])


# ---------------------------------------------------------------------------
# Export gates and CLI fail-closed (no pyarrow required).
# ---------------------------------------------------------------------------

class ExportGateTest(unittest.TestCase):
    def test_pyarrow_missing_fails_closed_without_output(self):
        rows = recorder_rows([make_episode(2)])
        with tempfile.TemporaryDirectory(prefix="lc-noarrow-") as workdir:
            path = os.path.join(workdir, "in.jsonl")
            out = os.path.join(workdir, "dataset")
            write_jsonl(path, rows)
            import unittest.mock

            with unittest.mock.patch.object(lerobot_convert, "pyarrow", None), \
                    unittest.mock.patch.object(lerobot_convert, "pq", None):
                with self.assertRaises(ValueError) as ctx:
                    lerobot_convert.run_export([path], out)
            self.assertIn("pyarrow", str(ctx.exception))
            self.assertFalse(os.path.exists(out))

    def test_nonempty_output_directory_is_refused(self):
        rows = recorder_rows([make_episode(2)])
        with tempfile.TemporaryDirectory(prefix="lc-clash-") as workdir:
            path = os.path.join(workdir, "in.jsonl")
            out = os.path.join(workdir, "out")
            os.makedirs(os.path.join(out, "keep"))
            write_jsonl(path, rows)
            if not PYARROW_AVAILABLE:
                self.skipTest("pyarrow not installed")
            with self.assertRaises(ValueError) as ctx:
                lerobot_convert.run_export([path], out)
            self.assertIn("not empty", str(ctx.exception))
            self.assertTrue(os.path.exists(os.path.join(out, "keep")))

    def test_cli_failure_exits_2_with_fail_prefix_and_no_output(self):
        rows = [
            {"type": "step", "observation": [1, "x"], "action": [0.1], "done": True}
        ]
        with tempfile.TemporaryDirectory(prefix="lc-cli-fail-") as workdir:
            path = os.path.join(workdir, "bad.jsonl")
            out = os.path.join(workdir, "dataset")
            write_jsonl(path, rows)
            run = subprocess.run(
                [sys.executable, ENGINE, "export", path, "--out", out],
                capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(run.returncode, 2, run.stderr)
            self.assertIn("[lerobot-converter] FAIL —", run.stderr)
            self.assertIn("line 1", run.stderr)
            self.assertNotIn("Traceback", run.stderr)
            self.assertFalse(os.path.exists(out))


# ---------------------------------------------------------------------------
# Import gates (no pyarrow required — rejections happen before parquet).
# ---------------------------------------------------------------------------

class ImportGateTest(unittest.TestCase):
    def _info(self, version="v3.0", video=False):
        features = {
            "observation.state": {"dtype": "float32", "shape": [3], "names": None},
            "action": {"dtype": "float32", "shape": [2], "names": None},
        }
        if video:
            features["observation.images.front"] = {
                "dtype": "video", "shape": [3, 240, 320], "names": None,
            }
        return {
            "codebase_version": version,
            "robot_type": "rdk",
            "total_episodes": 1,
            "total_frames": 2,
            "total_tasks": 1,
            "total_videos": 1 if video else 0,
            "total_chunks": 1,
            "chunks_size": 1000,
            "data_path": "data/chunk-{chunk_index:03d}/episode_{episode_index:06d}.parquet",
            "video_path": "videos/chunk-{chunk_index:03d}/{video_key}/episode_{episode_index:06d}.mp4",
            "fps": 50,
            "splits": {"train": "0:1"},
            "features": features,
        }

    def _dataset_dir(self, info):
        workdir = tempfile.mkdtemp(prefix="lc-gate-")
        self.addCleanup(shutil.rmtree, workdir, ignore_errors=True)
        root = pathlib.Path(workdir) / "dataset"
        (root / "meta").mkdir(parents=True)
        (root / "meta" / "info.json").write_text(json.dumps(info))
        return root

    def test_v1_0_dataset_rejected_with_migration_advice(self):
        workdir = tempfile.mkdtemp(prefix="lc-v1-")
        self.addCleanup(shutil.rmtree, workdir, ignore_errors=True)
        root = pathlib.Path(workdir) / "old"
        (root / "meta").mkdir(parents=True)
        (root / "meta" / "meta.json").write_text('{"codebase_version": "v1.0"}')
        with self.assertRaises(ValueError) as ctx:
            lerobot_convert.run_import(root, os.path.join(workdir, "out.jsonl"))
        message = str(ctx.exception)
        self.assertIn("v1.0", message)
        self.assertIn("convert_dataset_v1_to_v2", message)

    def test_unsupported_version_rejected(self):
        root = self._dataset_dir(self._info(version="v2.0"))
        with self.assertRaises(ValueError) as ctx:
            lerobot_convert.run_import(root, os.path.join(str(root.parent), "out.jsonl"))
        self.assertIn("codebase_version", str(ctx.exception))

    def test_video_dataset_without_with_video_rejected(self):
        root = self._dataset_dir(self._info(video=True))
        with self.assertRaises(ValueError) as ctx:
            lerobot_convert.run_import(root, os.path.join(str(root.parent), "out.jsonl"))
        self.assertIn("tabular mode", str(ctx.exception))
        self.assertIn("--with-video", str(ctx.exception))

    def test_missing_info_json_rejected(self):
        workdir = tempfile.mkdtemp(prefix="lc-none-")
        self.addCleanup(shutil.rmtree, workdir, ignore_errors=True)
        root = pathlib.Path(workdir) / "empty"
        root.mkdir()
        with self.assertRaises(ValueError) as ctx:
            lerobot_convert.run_import(root, os.path.join(workdir, "out.jsonl"))
        self.assertIn("not a LeRobot dataset", str(ctx.exception))


# ---------------------------------------------------------------------------
# Round trip, determinism, CLI (need pyarrow).
# ---------------------------------------------------------------------------

@unittest.skipUnless(PYARROW_AVAILABLE, "pyarrow not installed")
class RoundTripTest(unittest.TestCase):
    def test_export_import_export_round_trip(self):
        episodes = [
            make_episode(5, offset=0.0, reward=True),
            make_episode(4, offset=2.0, reward=True),
            make_episode(6, offset=4.0, reward=True),
        ]
        with tempfile.TemporaryDirectory(prefix="lc-round-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            first_dir = os.path.join(workdir, "ds1")
            back = os.path.join(workdir, "back.jsonl")
            second_dir = os.path.join(workdir, "ds2")
            write_jsonl(source, recorder_rows(episodes, reward=True))

            first = lerobot_convert.run_export([source], first_dir, task="round trip")
            self.assertEqual(first["episodes"], 3)
            self.assertEqual(first["frames"], 15)
            self.assertEqual(first["obsDim"], 3)
            self.assertEqual(first["actDim"], 2)
            self.assertEqual(first["videos"], 0)

            imported = lerobot_convert.run_import(first_dir, back)
            self.assertEqual(imported["episodes"], 3)
            self.assertEqual(imported["frames"], 15)
            self.assertEqual(imported["fps"], 50)

            roundtripped = lerobot_convert.load_trajectory_dataset([back])
            self.assertEqual([len(ep) for ep in roundtripped.episodes], [5, 4, 6])
            for index, (observations, actions, _) in enumerate(episodes):
                for t, observation in enumerate(observations):
                    np.testing.assert_allclose(
                        roundtripped.episodes[index][t]["observation"],
                        observation, rtol=1e-6,
                    )
                    np.testing.assert_allclose(
                        roundtripped.episodes[index][t]["action"],
                        actions[t], rtol=1e-6,
                    )
            self.assertTrue(roundtripped.has_reward)

            second = lerobot_convert.run_export([back], second_dir, task="round trip")
            self.assertEqual(second["episodes"], first["episodes"])
            self.assertEqual(second["frames"], first["frames"])
            self.assertEqual(second["videos"], first["videos"])
            self.assertEqual(
                lerobot_convert.load_trajectory_dataset([back]).total_steps, 15
            )

    def test_import_output_satisfies_act_loader_semantics(self):
        episodes = [make_episode(3), make_episode(2, offset=1.0)]
        with tempfile.TemporaryDirectory(prefix="lc-act-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            dataset_dir = os.path.join(workdir, "ds")
            back = os.path.join(workdir, "back.jsonl")
            write_jsonl(source, recorder_rows(episodes))
            lerobot_convert.run_export([source], dataset_dir)
            lerobot_convert.run_import(dataset_dir, back)
            # Minimal re-implementation of engines/act load_dataset rules —
            # if this raises, the ACT engine would refuse the file.
            loaded, obs_size, act_size = act_load_dataset_equivalent(back)
        self.assertEqual(obs_size, 3)
        self.assertEqual(act_size, 2)
        self.assertEqual([len(obs) for obs, _ in loaded], [3, 2])
        np.testing.assert_allclose(loaded[0][0][0], episodes[0][0][0], rtol=1e-6)

    def test_export_import_cli_end_to_end(self):
        episodes = [make_episode(4), make_episode(3, offset=3.0)]
        with tempfile.TemporaryDirectory(prefix="lc-cli-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            dataset_dir = os.path.join(workdir, "ds")
            back = os.path.join(workdir, "back.jsonl")
            write_jsonl(source, recorder_rows(episodes))
            run = subprocess.run(
                [sys.executable, ENGINE, "export", source, "--out", dataset_dir,
                 "--fps", "25", "--task", "cli round trip"],
                capture_output=True, text=True, timeout=300,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            summary = json.loads(run.stdout.strip().splitlines()[-1])
            self.assertEqual(summary["command"], "export")
            self.assertEqual(summary["episodes"], 2)
            self.assertEqual(summary["frames"], 7)
            self.assertEqual(summary["fps"], 25)
            self.assertEqual(summary["task"], "cli round trip")
            self.assertEqual(summary["output"], dataset_dir)
            for relative in (
                "meta/info.json", "meta/episodes.jsonl", "meta/tasks.jsonl",
                "data/chunk-000/episode_000000.parquet",
                "data/chunk-000/episode_000001.parquet",
            ):
                self.assertTrue(
                    os.path.exists(os.path.join(dataset_dir, relative)), relative
                )

            run = subprocess.run(
                [sys.executable, ENGINE, "import", dataset_dir, "--out", back],
                capture_output=True, text=True, timeout=300,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            summary = json.loads(run.stdout.strip().splitlines()[-1])
            self.assertEqual(summary["command"], "import")
            self.assertEqual(summary["episodes"], 2)
            self.assertEqual(summary["frames"], 7)
            self.assertEqual(summary["fps"], 25)
            header = json.loads(pathlib.Path(back).read_text().splitlines()[0])
            self.assertEqual(header["type"], "header")
            self.assertEqual(header["format"], "microduck-trajectory-v1")
            self.assertEqual(header["source"], "lerobot-import")
            self.assertEqual(header["sampleHz"], 25)
            self.assertIn("converted from LeRobot dataset v3.0", header["note"])


@unittest.skipUnless(PYARROW_AVAILABLE, "pyarrow not installed")
class DeterminismTest(unittest.TestCase):
    def test_same_input_twice_identical_meta_bytes(self):
        episodes = [make_episode(4), make_episode(2, offset=1.0)]
        with tempfile.TemporaryDirectory(prefix="lc-det-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            write_jsonl(source, recorder_rows(episodes))
            first = os.path.join(workdir, "ds1")
            second = os.path.join(workdir, "ds2")
            lerobot_convert.run_export([source], first)
            lerobot_convert.run_export([source], second)
            for relative in (
                "meta/info.json", "meta/episodes.jsonl", "meta/tasks.jsonl",
            ):
                self.assertEqual(
                    pathlib.Path(first, relative).read_bytes(),
                    pathlib.Path(second, relative).read_bytes(),
                    "%s must be byte-identical across runs" % relative,
                )

    def test_chunk_splitting_follows_chunks_size(self):
        episodes = [make_episode(2), make_episode(2, offset=1.0)]
        with tempfile.TemporaryDirectory(prefix="lc-chunk-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            out = os.path.join(workdir, "ds")
            write_jsonl(source, recorder_rows(episodes))
            lerobot_convert.run_export([source], out, chunks_size=1)
            self.assertTrue(
                os.path.exists(os.path.join(out, "data/chunk-000/episode_000000.parquet"))
            )
            self.assertTrue(
                os.path.exists(os.path.join(out, "data/chunk-001/episode_000001.parquet"))
            )
            info = json.loads(pathlib.Path(out, "meta/info.json").read_text())
            self.assertEqual(info["total_chunks"], 2)


# ---------------------------------------------------------------------------
# Video round trip (needs pyarrow AND ffmpeg).
# ---------------------------------------------------------------------------

@unittest.skipUnless(PYARROW_AVAILABLE and FFMPEG_AVAILABLE,
                     "pyarrow and ffmpeg not installed")
class VideoRoundTripTest(unittest.TestCase):
    def test_mono8_cameraframe_round_trip_byte_exact(self):
        width, height = 8, 6
        frames = [mono_frame(width, height, 0), mono_frame(width, height, 128)]
        rows = [
            {
                "type": "header", "format": "microduck-trajectory-v1",
                "source": "test", "sampleHz": 10,
            },
            {
                "type": "step", "t": 0.0, "observation": [0.25, 0.5],
                "action": [0.1, 0.2],
                "cameraFrame": camera_field("mono8", width, height, frames[0]),
            },
            {
                "type": "step", "t": 0.1, "observation": [0.75, 1.0],
                "action": [0.3, 0.4], "done": True,
                "cameraFrame": camera_field("mono8", width, height, frames[1]),
            },
        ]
        with tempfile.TemporaryDirectory(prefix="lc-video-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            dataset_dir = os.path.join(workdir, "ds")
            back = os.path.join(workdir, "back.jsonl")
            write_jsonl(source, rows)

            summary = lerobot_convert.run_export([source], dataset_dir)
            self.assertEqual(summary["videos"], 1)
            video_path = os.path.join(
                dataset_dir, "videos/chunk-000/observation.images.camera_frame/episode_000000.mp4"
            )
            self.assertTrue(os.path.exists(video_path))
            info = json.loads(pathlib.Path(dataset_dir, "meta/info.json").read_text())
            self.assertEqual(info["total_videos"], 1)
            self.assertEqual(info["features"]["observation.images.camera_frame"]["shape"], [1, 6, 8])

            imported = lerobot_convert.run_import(dataset_dir, back, with_video=True)
            self.assertEqual(imported["videos"], 1)
            lines = pathlib.Path(back).read_text().splitlines()
            steps = [json.loads(line) for line in lines[1:]]
            self.assertEqual(len(steps), 2)
            for step, original in zip(steps, frames):
                field = step["cameraFrame"]
                self.assertEqual(field["encoding"], "mono8")
                self.assertEqual(field["width"], width)
                self.assertEqual(field["height"], height)
                self.assertEqual(field["channels"], 1)
                # The loss contract: mono8 is byte-exact through lossless
                # monochrome H.264.
                self.assertEqual(
                    base64.b64decode(field["data"]), original,
                    "cameraFrame must survive export -> import byte-for-byte",
                )

    def test_video_frame_count_mismatch_fails_closed(self):
        width, height = 8, 6
        frame = mono_frame(width, height, 7)
        rows = [
            {"type": "step", "observation": [0.25], "action": [0.1],
             "cameraFrame": camera_field("mono8", width, height, frame)},
            {"type": "step", "observation": [0.5], "action": [0.2], "done": True,
             "cameraFrame": camera_field("mono8", width, height, frame)},
        ]
        with tempfile.TemporaryDirectory(prefix="lc-vidmis-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            dataset_dir = os.path.join(workdir, "ds")
            write_jsonl(source, rows)
            lerobot_convert.run_export([source], dataset_dir)
            # Grow the parquet to 3 rows (and the declared length with it) so
            # the video has fewer frames than the tabular side claims — the
            # video/parquet frame-count contract must refuse this.
            write_episode_parquet(
                pathlib.Path(dataset_dir, "data/chunk-000/episode_000000.parquet"),
                [[0.25, 0.5], [0.75, 1.0], [1.25, 1.5]],
                [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]],
                0, 0, [0.0, 0.1, 0.2],
            )
            episodes_path = pathlib.Path(dataset_dir, "meta/episodes.jsonl")
            episodes_path.write_text(
                json.dumps({"episode_index": 0, "tasks": ["t"], "length": 3}) + "\n"
            )
            info_path = pathlib.Path(dataset_dir, "meta/info.json")
            info = json.loads(info_path.read_text())
            info["total_frames"] = 3
            info_path.write_text(json.dumps(info))
            with self.assertRaises(ValueError) as ctx:
                lerobot_convert.run_import(
                    dataset_dir, os.path.join(workdir, "back.jsonl"), with_video=True
                )
            message = str(ctx.exception)
            self.assertTrue(
                "frames" in message or "episode 0" in message,
                "the video frame-count check must name the mismatch: %s" % message,
            )
            self.assertFalse(os.path.exists(os.path.join(workdir, "back.jsonl")))


# ---------------------------------------------------------------------------
# Multi-camera selection (--video-key): explicit choice, never silent.
# ---------------------------------------------------------------------------

@unittest.skipUnless(PYARROW_AVAILABLE and FFMPEG_AVAILABLE,
                     "pyarrow and ffmpeg not installed")
class MultiCameraSelectionTest(unittest.TestCase):
    """The platform trajectory format carries one cameraFrame per step, so a
    multi-camera Hub dataset must name the camera to decode. Selection
    contract: refuse to pick silently, honor the named key, refuse unknown
    keys, and never pretend a tabular dataset has a camera."""

    def _export_mono_dataset(self, workdir):
        """One-episode mono8 camera dataset plus a FAKE second video feature
        injected into info.json (a second mp4 is never needed: every refusal
        fires before any decoding, and the success path decodes only the
        selected camera)."""
        width, height = 8, 6
        frames = [mono_frame(width, height, 0), mono_frame(width, height, 128)]
        rows = [
            {"type": "header", "format": "microduck-trajectory-v1",
             "source": "test", "sampleHz": 10},
            {"type": "step", "t": 0.0, "observation": [0.25, 0.5],
             "action": [0.1, 0.2],
             "cameraFrame": camera_field("mono8", width, height, frames[0])},
            {"type": "step", "t": 0.1, "observation": [0.75, 1.0],
             "action": [0.3, 0.4], "done": True,
             "cameraFrame": camera_field("mono8", width, height, frames[1])},
        ]
        source = os.path.join(workdir, "traj.jsonl")
        dataset_dir = os.path.join(workdir, "ds")
        write_jsonl(source, rows)
        lerobot_convert.run_export([source], dataset_dir)
        info_path = pathlib.Path(dataset_dir, "meta/info.json")
        info = json.loads(info_path.read_text())
        info["features"]["observation.images.wrist"] = {
            "dtype": "video", "shape": [1, height, width], "names": None,
        }
        info["total_videos"] = 2
        info_path.write_text(json.dumps(info))
        return dataset_dir, frames

    def test_multi_camera_without_explicit_key_is_refused(self):
        with tempfile.TemporaryDirectory(prefix="lc-multicam-") as workdir:
            dataset_dir, _ = self._export_mono_dataset(workdir)
            out = os.path.join(workdir, "back.jsonl")
            with self.assertRaises(ValueError) as ctx:
                lerobot_convert.run_import(dataset_dir, out, with_video=True)
            message = str(ctx.exception)
            self.assertIn("--video-key", message)
            for key in ("observation.images.camera_frame",
                        "observation.images.wrist"):
                self.assertIn(key, message)
            # Tabular mode must also point at --video-key as the way out.
            with self.assertRaises(ValueError) as ctx:
                lerobot_convert.run_import(dataset_dir, out)
            self.assertIn("--video-key", str(ctx.exception))
            self.assertFalse(os.path.exists(out))

    def test_video_key_selects_one_camera(self):
        with tempfile.TemporaryDirectory(prefix="lc-multisel-") as workdir:
            dataset_dir, frames = self._export_mono_dataset(workdir)
            back = os.path.join(workdir, "back.jsonl")
            summary = lerobot_convert.run_import(
                dataset_dir, back,
                video_key="observation.images.camera_frame",
            )
            self.assertEqual(summary["videos"], 1)
            self.assertEqual(summary["videoKey"],
                             "observation.images.camera_frame")
            lines = pathlib.Path(back).read_text().splitlines()
            header = json.loads(lines[0])
            self.assertIn(
                "camera observation.images.camera_frame selected", header["note"]
            )
            self.assertIn("observation.images.wrist", header["note"])
            steps = [json.loads(line) for line in lines[1:]]
            for step, original in zip(steps, frames):
                self.assertEqual(
                    base64.b64decode(step["cameraFrame"]["data"]), original,
                    "the selected camera's frames must decode byte-exactly",
                )

    def test_unknown_video_key_is_refused(self):
        with tempfile.TemporaryDirectory(prefix="lc-multibad-") as workdir:
            dataset_dir, _ = self._export_mono_dataset(workdir)
            with self.assertRaises(ValueError) as ctx:
                lerobot_convert.run_import(
                    dataset_dir, os.path.join(workdir, "back.jsonl"),
                    video_key="observation.images.nonexistent",
                )
            message = str(ctx.exception)
            self.assertIn("observation.images.nonexistent", message)
            self.assertIn("observation.images.camera_frame", message)
            self.assertFalse(os.path.exists(os.path.join(workdir, "back.jsonl")))

    def test_video_key_on_tabular_dataset_is_refused(self):
        rows = [
            {"type": "step", "observation": [0.25, 0.5], "action": [0.1, 0.2]},
            {"type": "step", "observation": [0.75, 1.0], "action": [0.3, 0.4],
             "done": True},
        ]
        with tempfile.TemporaryDirectory(prefix="lc-multitab-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            dataset_dir = os.path.join(workdir, "ds")
            write_jsonl(source, rows)
            lerobot_convert.run_export([source], dataset_dir)
            with self.assertRaises(ValueError) as ctx:
                lerobot_convert.run_import(
                    dataset_dir, os.path.join(workdir, "back.jsonl"),
                    video_key="observation.images.camera_frame",
                )
            self.assertIn("tabular-only", str(ctx.exception))
            self.assertFalse(os.path.exists(os.path.join(workdir, "back.jsonl")))


    def test_tabular_import_of_video_dataset_records_ignored_cameras(self):
        with tempfile.TemporaryDirectory(prefix="lc-tabvid-") as workdir:
            dataset_dir, _ = self._export_mono_dataset(workdir)
            back = os.path.join(workdir, "back.jsonl")
            summary = lerobot_convert.run_import(dataset_dir, back, tabular=True)
            self.assertEqual(summary["videos"], 0)
            self.assertIsNone(summary["videoKey"])
            lines = pathlib.Path(back).read_text().splitlines()
            header = json.loads(lines[0])
            self.assertIn("explicit tabular import", header["note"])
            self.assertIn("observation.images.camera_frame", header["note"])
            self.assertIn("observation.images.wrist", header["note"])
            steps = [json.loads(line) for line in lines[1:]]
            self.assertTrue(steps)
            for step in steps:
                self.assertNotIn(
                    "cameraFrame", step,
                    "tabular import must carry no camera rows at all",
                )
            episodes, _, _ = act_load_dataset_equivalent(back)

    def test_tabular_mode_is_mutually_exclusive(self):
        rows = [
            {"type": "step", "observation": [0.25], "action": [0.1]},
            {"type": "step", "observation": [0.75], "action": [0.3], "done": True},
        ]
        with tempfile.TemporaryDirectory(prefix="lc-tabmut-") as workdir:
            source = os.path.join(workdir, "traj.jsonl")
            dataset_dir = os.path.join(workdir, "ds")
            write_jsonl(source, rows)
            lerobot_convert.run_export([source], dataset_dir)
            out = os.path.join(workdir, "back.jsonl")
            with self.assertRaises(ValueError):
                lerobot_convert.run_import(
                    dataset_dir, out, with_video=True, tabular=True
                )
            with self.assertRaises(ValueError):
                lerobot_convert.run_import(
                    dataset_dir, out,
                    video_key="observation.images.camera_frame", tabular=True,
                )
            self.assertFalse(os.path.exists(out))


# ---------------------------------------------------------------------------
# Import layouts: v2.1 Hub datasets and file-sharded v3.0 (need pyarrow).
# ---------------------------------------------------------------------------

@unittest.skipUnless(PYARROW_AVAILABLE, "pyarrow not installed")
class ImportLayoutsTest(unittest.TestCase):
    def test_v2_1_hub_layout_with_plain_string_tasks(self):
        episodes = [make_episode(3), make_episode(2, offset=2.0)]
        with tempfile.TemporaryDirectory(prefix="lc-v21-") as workdir:
            root = pathlib.Path(workdir) / "hub"
            offset = 0
            for index, (observations, actions, _) in enumerate(episodes):
                write_episode_parquet(
                    root / ("data/chunk-000/episode_%06d.parquet" % index),
                    observations, actions, index, offset,
                    [t / 20.0 for t in range(len(observations))],
                )
                offset += len(observations)
            (root / "meta").mkdir(parents=True, exist_ok=True)
            (root / "meta" / "tasks.jsonl").write_text(
                '"pick the black cube"\n' * 1
            )
            (root / "meta" / "episodes.jsonl").write_text(
                json.dumps({"episode_index": 0, "tasks": ["pick the black cube"], "length": 3})
                + "\n"
                + json.dumps({"episode_index": 1, "tasks": ["pick the black cube"], "length": 2})
                + "\n"
            )
            (root / "meta" / "info.json").write_text(
                json.dumps(
                    {
                        "codebase_version": "v2.1",
                        "robot_type": "so101",
                        "total_episodes": 2,
                        "total_frames": 5,
                        "total_tasks": 1,
                        "total_videos": 0,
                        "total_chunks": 1,
                        "chunks_size": 1000,
                        "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
                        "video_path": None,
                        "fps": 20,
                        "splits": {"train": "0:2"},
                        "features": {
                            "observation.state": {"dtype": "float32", "shape": [3], "names": None},
                            "action": {"dtype": "float32", "shape": [2], "names": None},
                            "timestamp": {"dtype": "float32", "shape": [1], "names": None},
                            "frame_index": {"dtype": "int64", "shape": [1], "names": None},
                            "episode_index": {"dtype": "int64", "shape": [1], "names": None},
                            "index": {"dtype": "int64", "shape": [1], "names": None},
                            "task_index": {"dtype": "int64", "shape": [1], "names": None},
                        },
                    }
                )
            )
            out = os.path.join(workdir, "back.jsonl")
            summary = lerobot_convert.run_import(root, out)
            self.assertEqual(summary["command"], "import")
            self.assertEqual(summary["episodes"], 2)
            self.assertEqual(summary["frames"], 5)
            self.assertEqual(summary["fps"], 20)
            self.assertEqual(summary["videos"], 0)
            lines = pathlib.Path(out).read_text().splitlines()
            header = json.loads(lines[0])
            self.assertEqual(header["sampleHz"], 20)
            self.assertIn("v2.1", header["note"])
            self.assertIn("pick the black cube", header["note"])
            steps = [json.loads(line) for line in lines[1:]]
            self.assertEqual([step["done"] for step in steps], [False, False, True, False, True])
            np.testing.assert_allclose(steps[0]["observation"], episodes[0][0][0], rtol=1e-6)
            # t comes from the official timestamp column (seconds).
            self.assertAlmostEqual(steps[0]["t"], 0.0, places=6)
            self.assertAlmostEqual(steps[1]["t"], 0.05, places=6)

    def test_file_sharded_v3_layout_with_parquet_metadata(self):
        import pyarrow
        import pyarrow.parquet as pq

        episodes = [make_episode(2), make_episode(2, offset=3.0)]
        with tempfile.TemporaryDirectory(prefix="lc-v3file-") as workdir:
            root = pathlib.Path(workdir) / "hub"
            rows_obs, rows_act, rows_ts = [], [], []
            for index, (observations, actions, _) in enumerate(episodes):
                rows_obs.extend(observations)
                rows_act.extend(actions)
                rows_ts.extend([t / 10.0 for t in range(len(observations))])
            write_episode_parquet(
                root / "data/chunk-000/file-000.parquet",
                rows_obs, rows_act, 0, 0, rows_ts,
            )
            # Fix the episode_index column: two episodes in one file.
            import pyarrow.parquet as pq_

            table = pq_.read_table(root / "data/chunk-000/file-000.parquet")
            table = table.set_column(
                table.schema.get_field_index("episode_index"),
                "episode_index",
                pyarrow.array([0, 0, 1, 1], type=pyarrow.int64()),
            )
            table = table.set_column(
                table.schema.get_field_index("frame_index"),
                "frame_index",
                pyarrow.array([0, 1, 0, 1], type=pyarrow.int64()),
            )
            pq_.write_table(table, root / "data/chunk-000/file-000.parquet")

            (root / "meta").mkdir(parents=True, exist_ok=True)
            (root / "meta" / "tasks.parquet").parent.mkdir(parents=True, exist_ok=True)
            pq.write_table(
                pyarrow.table(
                    {
                        "task": pyarrow.array(["wave the hand"], type=pyarrow.string()),
                        "task_index": pyarrow.array([0], type=pyarrow.int64()),
                    }
                ),
                root / "meta" / "tasks.parquet",
            )
            episodes_dir = root / "meta" / "episodes" / "chunk-000"
            episodes_dir.mkdir(parents=True, exist_ok=True)
            pq.write_table(
                pyarrow.table(
                    {
                        "episode_index": pyarrow.array([0, 1], type=pyarrow.int64()),
                        "length": pyarrow.array([2, 2], type=pyarrow.int64()),
                        "tasks": pyarrow.array(
                            [["wave the hand"], ["wave the hand"]],
                            type=pyarrow.list_(pyarrow.string()),
                        ),
                    }
                ),
                episodes_dir / "file-000.parquet",
            )
            (root / "meta" / "info.json").write_text(
                json.dumps(
                    {
                        "codebase_version": "v3.0",
                        "fps": 10,
                        "total_episodes": 2,
                        "total_frames": 4,
                        "total_tasks": 1,
                        "chunks_size": 1000,
                        "data_path": "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
                        "video_path": None,
                        "splits": {"train": "0:2"},
                        "features": {
                            "observation.state": {"dtype": "float32", "shape": [3], "names": None},
                            "action": {"dtype": "float32", "shape": [2], "names": None},
                        },
                    }
                )
            )
            out = os.path.join(workdir, "back.jsonl")
            summary = lerobot_convert.run_import(root, out)
            self.assertEqual(summary["episodes"], 2)
            self.assertEqual(summary["frames"], 4)
            lines = pathlib.Path(out).read_text().splitlines()
            steps = [json.loads(line) for line in lines[1:]]
            self.assertEqual([step["done"] for step in steps], [False, True, False, True])
            np.testing.assert_allclose(steps[0]["observation"], episodes[0][0][0], rtol=1e-6)

    def test_tasks_parquet_with_pandas_index_column(self):
        """Real Hub datasets write tasks.parquet through pandas: the task
        string sits in the saved index column __index_level_0__, not a
        'task' column. Regression: importing such a dataset must read the
        task strings instead of refusing."""
        import pyarrow
        import pyarrow.parquet as pq

        episodes = [make_episode(2), make_episode(2, offset=1.0)]
        with tempfile.TemporaryDirectory(prefix="lc-taskidx-") as workdir:
            root = pathlib.Path(workdir) / "hub"
            offset = 0
            for index, (observations, actions, _) in enumerate(episodes):
                write_episode_parquet(
                    root / ("data/chunk-000/episode_%06d.parquet" % index),
                    observations, actions, index, offset,
                    [t / 10.0 for t in range(len(observations))],
                )
                offset += len(observations)
            (root / "meta").mkdir(parents=True, exist_ok=True)
            pq.write_table(
                pyarrow.table(
                    {
                        "task_index": pyarrow.array([0], type=pyarrow.int64()),
                        "__index_level_0__": pyarrow.array(
                            ["Place the battery into the slot."],
                            type=pyarrow.string(),
                        ),
                    }
                ),
                root / "meta" / "tasks.parquet",
            )
            (root / "meta" / "info.json").write_text(
                json.dumps(
                    {
                        "codebase_version": "v3.0",
                        "fps": 10,
                        "total_episodes": 2,
                        "total_frames": 4,
                        "total_tasks": 1,
                        "chunks_size": 1000,
                        "data_path": "data/chunk-{chunk_index:03d}/episode_{episode_index:06d}.parquet",
                        "video_path": None,
                        "splits": {"train": "0:2"},
                        "features": {
                            "observation.state": {"dtype": "float32", "shape": [3], "names": None},
                            "action": {"dtype": "float32", "shape": [2], "names": None},
                        },
                    }
                )
            )
            out = os.path.join(workdir, "back.jsonl")
            summary = lerobot_convert.run_import(root, out)
            self.assertEqual(summary["episodes"], 2)
            header = json.loads(pathlib.Path(out).read_text().splitlines()[0])
            self.assertIn("Place the battery into the slot.", header["note"])

    def test_timestamp_missing_synthesizes_from_fps(self):
        import pyarrow
        import pyarrow.parquet as pq

        observations = [[0.25, 0.5, 0.75], [1.0, 0.0, 0.25]]
        with tempfile.TemporaryDirectory(prefix="lc-nots-") as workdir:
            root = pathlib.Path(workdir) / "hub"
            data = {
                "observation.state": pyarrow.array(observations, type=pyarrow.list_(pyarrow.float32())),
                "action": pyarrow.array([[0.1, 0.2], [0.3, 0.4]], type=pyarrow.list_(pyarrow.float32())),
                "episode_index": pyarrow.array([0, 0], type=pyarrow.int64()),
                "index": pyarrow.array([0, 1], type=pyarrow.int64()),
                "task_index": pyarrow.array([0, 0], type=pyarrow.int64()),
            }
            (root / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)
            pq.write_table(
                pyarrow.table(data), root / "data" / "chunk-000" / "episode_000000.parquet"
            )
            (root / "meta").mkdir(parents=True, exist_ok=True)
            (root / "meta" / "info.json").write_text(
                json.dumps(
                    {
                        "codebase_version": "v3.0", "fps": 10,
                        "total_episodes": 1, "total_frames": 2,
                        "features": {
                            "observation.state": {"dtype": "float32", "shape": [3], "names": None},
                            "action": {"dtype": "float32", "shape": [2], "names": None},
                        },
                    }
                )
            )
            out = os.path.join(workdir, "back.jsonl")
            lerobot_convert.run_import(root, out)
            steps = [json.loads(line) for line in pathlib.Path(out).read_text().splitlines()[1:]]
            self.assertAlmostEqual(steps[0]["t"], 0.0, places=9)
            self.assertAlmostEqual(steps[1]["t"], 0.1, places=9)

    def test_nonfinite_parquet_value_fails_closed(self):
        import pyarrow
        import pyarrow.parquet as pq

        with tempfile.TemporaryDirectory(prefix="lc-nan-") as workdir:
            root = pathlib.Path(workdir) / "hub"
            data = {
                "observation.state": pyarrow.array(
                    [[float("nan"), 0.5, 0.75]], type=pyarrow.list_(pyarrow.float32())
                ),
                "action": pyarrow.array([[0.1, 0.2]], type=pyarrow.list_(pyarrow.float32())),
                "episode_index": pyarrow.array([0], type=pyarrow.int64()),
                "index": pyarrow.array([0], type=pyarrow.int64()),
                "task_index": pyarrow.array([0], type=pyarrow.int64()),
            }
            (root / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)
            pq.write_table(
                pyarrow.table(data), root / "data" / "chunk-000" / "episode_000000.parquet"
            )
            (root / "meta").mkdir(parents=True, exist_ok=True)
            (root / "meta" / "info.json").write_text(
                json.dumps(
                    {
                        "codebase_version": "v3.0", "fps": 10,
                        "total_episodes": 1, "total_frames": 1,
                        "features": {
                            "observation.state": {"dtype": "float32", "shape": [3], "names": None},
                            "action": {"dtype": "float32", "shape": [2], "names": None},
                        },
                    }
                )
            )
            out = os.path.join(workdir, "back.jsonl")
            with self.assertRaises(ValueError) as ctx:
                lerobot_convert.run_import(root, out)
            self.assertIn("non-finite", str(ctx.exception))
            self.assertFalse(os.path.exists(out))


if __name__ == "__main__":
    unittest.main(verbosity=2)
