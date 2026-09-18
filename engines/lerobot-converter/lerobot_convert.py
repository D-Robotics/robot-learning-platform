#!/usr/bin/env python3
"""LeRobot v3.0 dataset converter — the platform's ecosystem on-ramp.

This is a CLI data tool, not a training engine: it never registers into the
worker's engine list. It answers the two directions the platform needs to
participate in the LeRobot ecosystem instead of orbiting it:

* **export** — platform trajectory JSONL -> LeRobot v3.0 dataset directory
  (push recordings back to the Hub, or hand them to any LeRobot tooling);
* **import** — LeRobot v2.1/v3.0 dataset directory -> platform trajectory
  JSONL that `engines/act/train_act.py` consumes directly, which turns the
  thousands of demonstration datasets already on the Hub into local BC/ACT
  training sources.

The input side of export must tolerate every shape the platform actually
emits today (the price of being the format bridge):

* bare step rows `{"t": 0.02, "observation": [...], "action": [...]}` with
  `done` markers and EOF closing episodes;
* the browser recorder format `microduck-trajectory-v1`: a header row plus
  `{"type": "step", ...}` rows;
* server telemetry shards: a single envelope row `{"runId": ...,
  "samples": [step, step, ...]}`.

`type: "event"` rows are lifecycle markers, not frames — they are dropped.
Episode boundaries are `done: true` plus end-of-file. Every rule the sibling
engines enforce is kept: numeric lists only (booleans are not numbers),
finite values, consistent dimensions across ALL inputs, all-or-none optional
fields (reward, cameraFrame), and fail-closed ValueError messages carrying
`line %d` (envelope samples add `sample %d`).

Output format (verified against the official `lerobot` source at
CODEBASE_VERSION "v3.0" — `DatasetInfo`, `DEFAULT_FEATURES`,
`DEFAULT_CHUNK_SIZE` and the writer's frame bookkeeping):

* `meta/info.json` — codebase_version "v3.0", robot_type, totals,
  chunks_size (1000), path templates, fps, splits `{"train": "0:N"}`, and a
  features table. `observation.state`/`action` are `float32` of shape `[N]`
  (the Hub convention; the official writer types scalar-pair features
  float32, and the timestamp default feature is float32). Shape-(1,)
  features serialize as SCALAR parquet columns, shape-(N,) as list columns —
  exactly the official writer's rule.
* `meta/episodes.jsonl` — one `{"episode_index", "tasks", "length"}` row
  per episode.
* `meta/tasks.jsonl` — `{"task_index", "task"}` rows.
* `data/chunk-XXX/episode_XXXXXX.parquet` — one file per episode with the
  official DEFAULT_FEATURES columns (index, episode_index, task_index,
  frame_index, timestamp) plus the data features. `timestamp` follows the
  official writer: it is COMPUTED as `frame_index / fps` — recorded `t`
  values are uniformized to the dataset grid, which is the documented
  fidelity cost of the format (video frames are inherently uniformized by
  mp4 encoding anyway).
* `videos/chunk-XXX/<video_key>/episode_XXXXXX.mp4` — camera frames piped
  raw into ffmpeg. mono8 sources are encoded as monochrome H.264 at qp 0 —
  lossless, so `import --with-video` recovers the exact bytes; color sources
  are encoded as yuv420p (visually lossless; RGB->YUV is inherently lossy).
  A dataset without `cameraFrame` rows is legal tabular-only (total_videos
  0, no video features).

Honest deviations from the current `main` branch of lerobot, all marked in
docs/engines/lerobot-converter.md: this tool writes the episode-per-file v3.0
layout (the task's contract, and what the published v3.0 spec and every v2.1
dataset use — current main aggregates many episodes per `file-XXX` shard and
moved tasks/episodes metadata to parquet); `total_videos`/`total_chunks` are
v2.1-era fields current main's DatasetInfo no longer declares, but loaders
treat unknown keys as optional; video features omit the `info` sub-block of
per-video encoding stats. IMPORT reads all three layouts (episode-per-file
v2.1/v3.0, file-sharded current-main v3.0), so Hub datasets keep working
either way. v1.0 datasets predate the chunk layout and are refused with a
migration pointer.

Failure contract (same as every sibling engine): fail closed on bad data,
leave NO partial output (a failed export removes the directory it was
building), print nothing but the one-line JSON summary on success, and exit
2 with `[lerobot-converter] FAIL — <reason>` on stderr for ValueError /
OSError / RuntimeError. pyarrow is required for both directions (parquet is
the physical format); ffmpeg is required only when camera frames exist.
"""

import argparse
import base64
import json
import math
import pathlib
import shutil
import subprocess
import sys

try:
    import numpy as np
except ImportError:  # pragma: no cover - exercised on machines without numpy
    np = None

try:
    import pyarrow
    import pyarrow.parquet as pq
except ImportError:  # pragma: no cover - exercised on machines without pyarrow
    pyarrow = None
    pq = None

ENGINE_NAME = "lerobot-converter"
TOOL_TAG = "[lerobot-converter]"

CODEBASE_VERSION = "v3.0"
SUPPORTED_IMPORT_VERSIONS = ("v2.1", "v3.0")
# Official DEFAULT_CHUNK_SIZE in lerobot/datasets/utils.py: max number of
# files per chunk directory.
DEFAULT_CHUNK_SIZE = 1000
DEFAULT_FPS = 50
ROBOT_TYPE = "rdk"
DEFAULT_TASK = "converted from RDK trajectory"
TRAJECTORY_FORMAT = "microduck-trajectory-v1"
IMPORT_SOURCE = "lerobot-import"

# Episode-per-file v3.0 path templates (the published v3.0 spec; identical
# shape to v2.1's, with chunk_index naming). Current lerobot main uses
# file-{file_index:03d} shards instead — import accepts both.
DATA_PATH_TEMPLATE = "data/chunk-{chunk_index:03d}/episode_{episode_index:06d}.parquet"
VIDEO_PATH_TEMPLATE = "videos/chunk-{chunk_index:03d}/{video_key}/episode_{episode_index:06d}.mp4"

OBSERVATION_FEATURE = "observation.state"
ACTION_FEATURE = "action"
REWARD_FEATURE = "reward"
VIDEO_FEATURE_KEY = "observation.images.camera_frame"

# Time field aliases tolerated on step rows, in priority order.
TIME_KEYS = ("t", "time", "timestamp")
CAMERA_ENCODINGS = {"rgb8": 3, "bgr8": 3, "mono8": 1}
PYARROW_INSTALL_HINT = "python3 -m pip install --user pyarrow"
NUMPY_INSTALL_HINT = "python3 -m pip install --user numpy"
FFMPEG_INSTALL_HINT = (
    "install ffmpeg (macOS: brew install ffmpeg; Debian/Ubuntu: "
    "apt-get install ffmpeg) and make sure it is on PATH"
)


# ---------------------------------------------------------------------------
# Input parsing: trajectory JSONL (three shapes) -> episodes.
# ---------------------------------------------------------------------------

class TrajectoryDataset:
    """Parsed platform trajectory data: episodes of validated steps.

    Attributes:
        episodes: list of episodes, each a list of step dicts with keys
            ``observation``/``action`` (python float lists), ``t`` (float or
            None), ``reward`` (float or None) and ``camera`` (raw pixel
            bytes or None).
        obs_dim / act_dim: vector widths, fixed by the first step and
            enforced on every later row across ALL input files.
        has_reward / has_camera: presence flags — the optional fields must
            be present on every step or on none (a partial column would
            make a silently-wrong dataset).
        camera_spec: the single tolerated cameraFrame configuration
            (encoding/width/height/channels) or None.
        sample_hz: the set of header-declared rates (``--fps`` overrides).
    """

    def __init__(self):
        self.episodes = []
        self.obs_dim = None
        self.act_dim = None
        self.has_reward = False
        self.has_camera = False
        self.camera_spec = None
        self.sample_hz = set()
        self.total_steps = 0
        self._current = []

    @property
    def total_frames(self):
        """Total step count across episodes."""
        return self.total_steps

    def _append(self, obs, act, t, reward, camera, done):
        """Validate optional-field consistency, then buffer the step."""
        if self.total_steps == 0:
            self.has_reward = reward is not None
            self.has_camera = camera is not None
        else:
            if (reward is not None) != self.has_reward:
                raise ValueError(
                    "reward must be present on every step or on none "
                    "(earlier rows differ)"
                )
            if (camera is not None) != self.has_camera:
                raise ValueError(
                    "cameraFrame must be present on every step or on none "
                    "(earlier rows differ)"
                )
        self.total_steps += 1
        self._current.append(
            {"observation": obs, "action": act, "t": t,
             "reward": reward, "camera": camera}
        )
        if done:
            self.episodes.append(self._current)
            self._current = []

    def close_episode(self):
        """Close the open episode at end-of-file (the implicit boundary)."""
        if self._current:
            self.episodes.append(self._current)
            self._current = []


def _is_number(value):
    """True for real JSON numbers — booleans are not numbers."""
    return not isinstance(value, bool) and isinstance(value, (int, float))


def parse_camera_frame(value, location):
    """Validate one cameraFrame object -> (spec dict, raw pixel bytes).

    The payload is STANDARD base64 over RAW pixel bytes (not JPEG):
    exactly width * height * channel bytes in the row-major layout implied
    by the encoding. Any mismatch — unknown encoding, non-integer geometry,
    channels inconsistent with the encoding, non-base64 data, wrong payload
    length — fails closed with the row location.
    """
    if not isinstance(value, dict):
        raise ValueError("%s: cameraFrame must be a JSON object" % location)
    encoding = value.get("encoding")
    if encoding not in CAMERA_ENCODINGS:
        raise ValueError(
            "%s: cameraFrame encoding must be one of %s, got %r"
            % (location, sorted(CAMERA_ENCODINGS), encoding)
        )
    geometry = {}
    for name in ("width", "height", "channels"):
        dimension = value.get(name)
        if not isinstance(dimension, int) or isinstance(dimension, bool) or dimension <= 0:
            raise ValueError(
                "%s: cameraFrame %s must be a positive integer, got %r"
                % (location, name, dimension)
            )
        geometry[name] = dimension
    expected_channels = CAMERA_ENCODINGS[encoding]
    if geometry["channels"] != expected_channels:
        raise ValueError(
            "%s: cameraFrame channels %d does not match encoding %r (expected %d)"
            % (location, geometry["channels"], encoding, expected_channels)
        )
    data = value.get("data")
    if not isinstance(data, str):
        raise ValueError("%s: cameraFrame data must be a base64 string" % location)
    try:
        raw = base64.b64decode(data, validate=True)
    except ValueError:
        raise ValueError("%s: cameraFrame data must be standard base64" % location)
    expected_bytes = geometry["width"] * geometry["height"] * geometry["channels"]
    if len(raw) != expected_bytes:
        raise ValueError(
            "%s: cameraFrame payload is %d bytes, expected %d (%dx%d, %d channels)"
            % (location, len(raw), expected_bytes, geometry["width"],
               geometry["height"], geometry["channels"])
        )
    spec = dict(geometry)
    spec["encoding"] = encoding
    return spec, raw


def _consume_step(dataset, row, location):
    """Validate one step row against the dataset contract and buffer it."""
    obs = row.get("observation", row.get("state"))
    act = row.get("action")
    if not isinstance(obs, list) or not isinstance(act, list):
        raise ValueError(
            "%s: observation/action required as numeric lists "
            "('observation' may appear as 'state')" % location
        )
    if not obs or not act:
        raise ValueError("%s: observation/action must be non-empty" % location)
    for values, name in ((obs, "observation"), (act, "action")):
        if any(not _is_number(v) for v in values):
            raise ValueError("%s: %s values must be numeric" % (location, name))
        if any(not math.isfinite(v) for v in values):
            raise ValueError("%s: %s values must be finite (no NaN/Inf)" % (location, name))
    done = row.get("done", False)
    if not isinstance(done, bool):
        raise ValueError("%s: done must be a boolean" % location)
    if dataset.obs_dim is None:
        dataset.obs_dim, dataset.act_dim = len(obs), len(act)
    if len(obs) != dataset.obs_dim or len(act) != dataset.act_dim:
        raise ValueError(
            "%s: inconsistent dimensions (observation %d, action %d; "
            "expected %d and %d)"
            % (location, len(obs), len(act), dataset.obs_dim, dataset.act_dim)
        )

    t = None
    for key in TIME_KEYS:
        if key in row:
            value = row[key]
            if not _is_number(value) or not math.isfinite(value):
                raise ValueError("%s: time field %r must be a finite number" % (location, key))
            t = float(value)
            break

    reward = None
    if "reward" in row:
        value = row["reward"]
        if not _is_number(value) or not math.isfinite(value):
            raise ValueError("%s: reward must be a finite number" % location)
        reward = float(value)

    camera = None
    if "cameraFrame" in row:
        spec, raw = parse_camera_frame(row["cameraFrame"], location)
        if dataset.camera_spec is None:
            dataset.camera_spec = spec
        elif dataset.camera_spec != spec:
            raise ValueError(
                "%s: cameraFrame configuration %r differs from earlier rows "
                "%r — mixed resolutions or encodings are not supported"
                % (location, spec, dataset.camera_spec)
            )
        camera = raw

    dataset._append(obs, act, t, reward, camera, done)


def _consume_record(dataset, row, location):
    """Route one parsed JSON row: header, event, step, or refusal."""
    row_type = row.get("type")
    if row_type == "event":
        return  # lifecycle marker, not a frame
    if row_type == "header":
        hz = row.get("sampleHz")
        if hz is None:
            return
        if not _is_number(hz) or not math.isfinite(hz) or hz <= 0:
            raise ValueError(
                "%s: header sampleHz must be a positive number, got %r"
                % (location, hz)
            )
        dataset.sample_hz.add(hz)
        return
    if row_type not in (None, "step"):
        raise ValueError(
            "%s: unknown row type %r (expected 'header', 'step' or 'event')"
            % (location, row_type)
        )
    _consume_step(dataset, row, location)


def load_trajectory_dataset(paths):
    """Parse trajectory JSONL file(s) into a TrajectoryDataset.

    Three row shapes are accepted (see the module docstring): bare step
    rows, recorder-format header/step rows, and server telemetry envelopes
    carrying ``samples``. Multiple input files concatenate in order; each
    file's EOF closes its open episode (a file is a source of whole
    episodes, never a source of half of one). Validation is dataset-global:
    dimensions, reward presence and cameraFrame presence must agree across
    every input file, and a cameraFrame configuration must be unique.
    An input set with no step rows at all is refused as empty.
    """
    dataset = TrajectoryDataset()
    for path in paths:
        file_path = pathlib.Path(path)
        text = file_path.read_text(encoding="utf-8")
        for line_no, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError as error:
                raise ValueError("line %d: invalid JSON (%s)" % (line_no, error))
            if not isinstance(row, dict):
                raise ValueError("line %d: each row must be a JSON object" % line_no)
            if "samples" in row:
                samples = row["samples"]
                if not isinstance(samples, list):
                    raise ValueError(
                        "line %d: telemetry envelope 'samples' must be a list"
                        % line_no
                    )
                for index, sample in enumerate(samples):
                    location = "line %d sample %d" % (line_no, index)
                    if not isinstance(sample, dict):
                        raise ValueError(
                            "%s: each sample must be a JSON object" % location
                        )
                    _consume_record(dataset, sample, location)
                continue
            _consume_record(dataset, row, "line %d" % line_no)
        dataset.close_episode()
    if not dataset.episodes:
        raise ValueError(
            "dataset is empty: no step rows found in %s"
            % ", ".join(str(path) for path in paths)
        )
    return dataset


def resolve_fps(requested, dataset):
    """Choose the dataset fps: --fps wins, then header sampleHz, then 50.

    Headers that disagree are refused unless --fps pins the rate, and a
    fractional rate is refused (the official fps field is an integer).
    """
    if requested is not None:
        if requested <= 0:
            raise ValueError("fps must be positive, got %d" % requested)
        return int(requested)
    values = dataset.sample_hz
    if not values:
        return DEFAULT_FPS
    if len(values) > 1:
        raise ValueError(
            "input headers declare conflicting sampleHz values %s — pass "
            "--fps to choose one" % sorted(values)
        )
    (value,) = values
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(
            "header sampleHz %r is fractional and LeRobot fps is integral — "
            "pass --fps to choose the rate" % value
        )
    return int(value)


# ---------------------------------------------------------------------------
# Metadata builders (pure dicts — testable without pyarrow).
# ---------------------------------------------------------------------------

def build_tasks_lines(task):
    """meta/tasks.jsonl rows: one {"task_index", "task"} per line."""
    return [{"task_index": 0, "task": task}]


def build_episode_lines(dataset, task):
    """meta/episodes.jsonl rows: {"episode_index", "tasks", "length"}."""
    return [
        {"episode_index": index, "tasks": [task], "length": len(episode)}
        for index, episode in enumerate(dataset.episodes)
    ]


def build_info_json(dataset, fps, task, chunks_size=DEFAULT_CHUNK_SIZE):
    """meta/info.json content as an in-memory dict.

    Fields follow the official v3.0 DatasetInfo (codebase_version, fps,
    features, totals, chunks_size, data_path/video_path, splits,
    robot_type) with the v2.1-era ``total_videos``/``total_chunks`` kept
    (current-main loaders treat them as optional). Feature dtypes: data
    vectors are float32 of shape [N] (Hub convention), the official
    DEFAULT_FEATURES scalars are appended, and shape-(1,) features mean
    scalar parquet columns. ``video_path`` is null for a tabular-only
    dataset, matching the official writer's use_videos=False path.
    """
    del task  # single task -> total_tasks is constant 1; kept for signature clarity
    features = {
        OBSERVATION_FEATURE: {
            "dtype": "float32", "shape": [dataset.obs_dim], "names": None,
        },
        ACTION_FEATURE: {
            "dtype": "float32", "shape": [dataset.act_dim], "names": None,
        },
    }
    if dataset.has_reward:
        features[REWARD_FEATURE] = {"dtype": "float32", "shape": [1], "names": None}
    if dataset.camera_spec:
        features[VIDEO_FEATURE_KEY] = {
            "dtype": "video",
            # LeRobot visual features are channels-first: (C, H, W).
            "shape": [
                dataset.camera_spec["channels"],
                dataset.camera_spec["height"],
                dataset.camera_spec["width"],
            ],
            "names": None,
        }
    # Official DEFAULT_FEATURES (lerobot/utils/constants.py), same order.
    features["timestamp"] = {"dtype": "float32", "shape": [1], "names": None}
    features["frame_index"] = {"dtype": "int64", "shape": [1], "names": None}
    features["episode_index"] = {"dtype": "int64", "shape": [1], "names": None}
    features["index"] = {"dtype": "int64", "shape": [1], "names": None}
    features["task_index"] = {"dtype": "int64", "shape": [1], "names": None}

    total_episodes = len(dataset.episodes)
    return {
        "codebase_version": CODEBASE_VERSION,
        "robot_type": ROBOT_TYPE,
        "total_episodes": total_episodes,
        "total_frames": dataset.total_frames,
        "total_tasks": 1,
        "total_videos": total_episodes if dataset.camera_spec else 0,
        "total_chunks": (total_episodes + chunks_size - 1) // chunks_size,
        "chunks_size": chunks_size,
        "data_path": DATA_PATH_TEMPLATE,
        "video_path": VIDEO_PATH_TEMPLATE if dataset.camera_spec else None,
        "fps": int(fps),
        "splits": {"train": "0:%d" % total_episodes},
        "features": features,
    }


# ---------------------------------------------------------------------------
# Dependency gates (fail closed with the exact install hint).
# ---------------------------------------------------------------------------

def _require_pyarrow():
    """Refuse to run either direction without the parquet engine."""
    if pyarrow is None:
        raise ValueError(
            "pyarrow is not installed (%s) — parquet is the physical format "
            "of every LeRobot dataset, both export and import need it"
            % PYARROW_INSTALL_HINT
        )


def _require_numpy():
    if np is None:
        raise ValueError(
            "numpy is not installed (%s) — required for the bgr8 channel "
            "flip during video export" % NUMPY_INSTALL_HINT
        )


def _require_ffmpeg():
    """Locate ffmpeg or fail closed with the install hint."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise ValueError(
            "ffmpeg is required for video export/import, but no ffmpeg "
            "executable was found on PATH (%s); tabular conversion without "
            "cameraFrame needs no ffmpeg" % FFMPEG_INSTALL_HINT
        )
    return ffmpeg


# ---------------------------------------------------------------------------
# Export: episodes -> parquet shards, mp4 videos, meta files.
# ---------------------------------------------------------------------------

def _camera_frame_to_rgb(raw, spec):
    """cameraFrame bytes -> the layout ffmpeg consumes.

    rgb8 and mono8 bytes pass through unchanged; bgr8 is flipped to RGB
    (numpy, row-major HxWx3) because the rawvideo pipe is declared rgb24.
    """
    if spec["encoding"] == "bgr8":
        _require_numpy()
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(
            spec["height"], spec["width"], 3
        )
        return np.ascontiguousarray(frame[:, :, ::-1]).tobytes()
    return raw


def episode_table(episode, episode_index, frame_offset, task_index, fps, has_reward):
    """Build the pyarrow table for one episode.

    Columns are the official DEFAULT_FEATURES scalars plus the data
    features: shape-(1,) features become scalar columns, shape-(N,) become
    list<float32> columns. ``timestamp`` is COMPUTED as frame_index / fps
    per the official writer (see the module docstring for the uniformizing
    contract); ``index`` is the global frame counter, ``frame_index`` the
    0-based position within the episode.
    """
    length = len(episode)
    data = {
        OBSERVATION_FEATURE: pyarrow.array(
            [step["observation"] for step in episode],
            type=pyarrow.list_(pyarrow.float32()),
        ),
        ACTION_FEATURE: pyarrow.array(
            [step["action"] for step in episode],
            type=pyarrow.list_(pyarrow.float32()),
        ),
    }
    if has_reward:
        data[REWARD_FEATURE] = pyarrow.array(
            [step["reward"] for step in episode], type=pyarrow.float32()
        )
    data["timestamp"] = pyarrow.array(
        [i / fps for i in range(length)], type=pyarrow.float32()
    )
    data["frame_index"] = pyarrow.array(
        list(range(length)), type=pyarrow.int64()
    )
    data["episode_index"] = pyarrow.array(
        [episode_index] * length, type=pyarrow.int64()
    )
    data["index"] = pyarrow.array(
        list(range(frame_offset, frame_offset + length)), type=pyarrow.int64()
    )
    data["task_index"] = pyarrow.array(
        [task_index] * length, type=pyarrow.int64()
    )
    return pyarrow.table(data)


def encode_video(out_path, frame_bytes, spec, fps):
    """Pipe raw frames into ffmpeg and write one episode's mp4.

    mono8 is encoded as monochrome H.264 at qp 0 — mathematically lossless,
    which is what makes the byte-exact cameraFrame round-trip contract of
    `import --with-video` hold. Color is encoded as yuv420p at crf 18
    (visually lossless; RGB->YUV conversion is inherently lossy, documented
    as such). Any ffmpeg failure fails closed with its stderr excerpt.
    """
    ffmpeg = _require_ffmpeg()
    input_pix = "gray" if spec["channels"] == 1 else "rgb24"
    if spec["channels"] == 1:
        output = ["-pix_fmt", "gray", "-c:v", "libx264", "-qp", "0"]
    else:
        output = ["-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "18"]
    command = [
        ffmpeg, "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", input_pix,
        "-s", "%dx%d" % (spec["width"], spec["height"]),
        "-framerate", str(int(fps)), "-i", "pipe:0",
        *output, str(out_path),
    ]
    run = subprocess.run(command, input=b"".join(frame_bytes), capture_output=True)
    if run.returncode != 0:
        raise ValueError(
            "ffmpeg video encode failed (exit %d): %s"
            % (run.returncode, run.stderr.decode("utf-8", "replace").strip()[:400])
        )
    if not out_path.is_file() or out_path.stat().st_size == 0:
        raise ValueError("ffmpeg produced no output at %s" % out_path)


def _write_jsonl(path, rows):
    """Write JSONL deterministically (fixed separators, trailing newline)."""
    text = "".join(
        json.dumps(row, ensure_ascii=False) + "\n" for row in rows
    )
    path.write_text(text, encoding="utf-8")


def _cleanup_output(out, created):
    """Remove a half-written dataset so a failed export leaves no output."""
    if created:
        shutil.rmtree(out, ignore_errors=True)
    else:
        for name in ("meta", "data", "videos"):
            shutil.rmtree(out / name, ignore_errors=True)


def _write_dataset(dataset, out, fps, task, chunks_size):
    """Write shards, then videos, then meta — inside an already-prepared dir."""
    frame_offset = 0
    for episode_index, episode in enumerate(dataset.episodes):
        chunk = episode_index // chunks_size
        parquet_path = out / DATA_PATH_TEMPLATE.format(
            chunk_index=chunk, episode_index=episode_index
        )
        parquet_path.parent.mkdir(parents=True, exist_ok=True)
        table = episode_table(
            episode, episode_index, frame_offset, 0, fps, dataset.has_reward
        )
        pq.write_table(table, parquet_path)
        if dataset.camera_spec is not None:
            video_path = out / VIDEO_PATH_TEMPLATE.format(
                chunk_index=chunk, video_key=VIDEO_FEATURE_KEY,
                episode_index=episode_index,
            )
            video_path.parent.mkdir(parents=True, exist_ok=True)
            frames = [
                _camera_frame_to_rgb(step["camera"], dataset.camera_spec)
                for step in episode
            ]
            encode_video(video_path, frames, dataset.camera_spec, fps)
        frame_offset += len(episode)
    meta = out / "meta"
    meta.mkdir(parents=True, exist_ok=True)
    _write_jsonl(meta / "tasks.jsonl", build_tasks_lines(task))
    _write_jsonl(meta / "episodes.jsonl", build_episode_lines(dataset, task))
    (meta / "info.json").write_text(
        json.dumps(build_info_json(dataset, fps, task, chunks_size),
                   ensure_ascii=False),
        encoding="utf-8",
    )


def run_export(input_paths, out_dir, fps=None, task=DEFAULT_TASK,
               chunks_size=DEFAULT_CHUNK_SIZE):
    """Export trajectory JSONL file(s) as a LeRobot v3.0 dataset directory.

    Contract: the whole input set is parsed and validated BEFORE anything is
    written; the output directory must not exist or must be empty (refusing
    to clobber is part of fail-closed); any failure mid-write removes what
    was written, so a failed export leaves no partial dataset. Determinism:
    the same inputs produce byte-identical meta files (and byte-identical
    parquet for the same pyarrow build). Returns the CLI summary dict.
    """
    dataset = load_trajectory_dataset(input_paths)
    resolved_fps = resolve_fps(fps, dataset)
    _require_pyarrow()
    if dataset.camera_spec is not None:
        _require_ffmpeg()
        if dataset.camera_spec["encoding"] == "bgr8":
            _require_numpy()

    out = pathlib.Path(out_dir)
    created = not out.exists()
    if not created:
        if not out.is_dir():
            raise ValueError("output path %s exists and is not a directory" % out)
        if any(out.iterdir()):
            raise ValueError(
                "output directory %s exists and is not empty — refusing to "
                "overwrite" % out
            )
    else:
        out.mkdir(parents=True)
    try:
        _write_dataset(dataset, out, resolved_fps, task, chunks_size)
    except Exception:
        _cleanup_output(out, created)
        raise
    return {
        "command": "export",
        "episodes": len(dataset.episodes),
        "frames": dataset.total_frames,
        "obsDim": dataset.obs_dim,
        "actDim": dataset.act_dim,
        "videos": len(dataset.episodes) if dataset.camera_spec else 0,
        "fps": resolved_fps,
        "task": task,
        "output": str(out),
    }


# ---------------------------------------------------------------------------
# Import: LeRobot dataset directory -> trainable trajectory JSONL.
# ---------------------------------------------------------------------------

def _read_info(root):
    """Read and version-gate meta/info.json (v2.1 and v3.0 accepted).

    v1.0 predates the chunk-directory layout and is refused with a pointer
    to the official migration script; a directory without meta/info.json is
    not a LeRobot dataset.
    """
    info_path = root / "meta" / "info.json"
    if not info_path.is_file():
        if (root / "meta" / "meta.json").is_file():
            raise ValueError(
                "LeRobot dataset v1.0 is not supported: v1.0 (meta/meta.json) "
                "predates the chunk-directory layout this tool reads. Migrate "
                "first: install lerobot and run "
                "`python -m lerobot.scripts.convert_dataset_v1_to_v2 "
                "--repo-id <org/name>`, then import the v2.1 result"
            )
        raise ValueError(
            "%s is not a LeRobot dataset directory (meta/info.json not found)"
            % root
        )
    info = json.loads(info_path.read_text(encoding="utf-8"))
    if not isinstance(info, dict):
        raise ValueError("meta/info.json must contain a JSON object")
    version = info.get("codebase_version")
    if version not in SUPPORTED_IMPORT_VERSIONS:
        raise ValueError(
            "unsupported LeRobot codebase_version %r (supported: %s); v1.0 "
            "datasets must be migrated to v2.1 first "
            "(python -m lerobot.scripts.convert_dataset_v1_to_v2)"
            % (version, list(SUPPORTED_IMPORT_VERSIONS))
        )
    return info


def _read_tasks(root):
    """Task strings by index from meta/tasks.jsonl or meta/tasks.parquet.

    tasks.jsonl carries either {"task_index", "task"} objects (v3.0) or one
    plain task string per line (v2.1, index = line order); tasks.parquet is
    the current-main layout with a ``task`` column (and ``task_index`` when
    the writer stored it).
    """
    tasks = {}
    jsonl = root / "meta" / "tasks.jsonl"
    if jsonl.is_file():
        for line_no, line in enumerate(jsonl.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if isinstance(value, str):
                tasks[len(tasks)] = value
            elif isinstance(value, dict) and isinstance(value.get("task"), str):
                index = value.get("task_index", len(tasks))
                if not isinstance(index, int) or isinstance(index, bool):
                    raise ValueError(
                        "meta/tasks.jsonl line %d: task_index must be an integer"
                        % line_no
                    )
                tasks[index] = value["task"]
            else:
                raise ValueError(
                    "meta/tasks.jsonl line %d: each line must be a task string "
                    "or a {\"task_index\", \"task\"} object" % line_no
                )
        return tasks
    parquet = root / "meta" / "tasks.parquet"
    if parquet.is_file():
        table = pq.read_table(parquet)
        if "task" not in table.column_names:
            raise ValueError("meta/tasks.parquet has no 'task' column")
        names = table.column("task").to_pylist()
        if "task_index" in table.column_names:
            indices = table.column("task_index").to_pylist()
        else:
            indices = list(range(len(names)))
        for index, name in zip(indices, names):
            if not isinstance(name, str):
                raise ValueError("meta/tasks.parquet 'task' column must be strings")
            tasks[int(index)] = name
    return tasks


def _read_episode_records(root):
    """Per-episode metadata {episode_index: {"tasks", "length"}} if declared.

    v2.1/early-v3 write meta/episodes.jsonl; current main writes chunked
    parquet under meta/episodes/. An absent/empty metadata block simply
    means episode structure is derived from the parquet episode_index
    column instead.
    """
    records = {}
    jsonl = root / "meta" / "episodes.jsonl"
    if jsonl.is_file():
        for line_no, line in enumerate(jsonl.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(
                    "meta/episodes.jsonl line %d: each line must be a JSON object"
                    % line_no
                )
            index = row.get("episode_index")
            length = row.get("length")
            if not isinstance(index, int) or isinstance(index, bool):
                raise ValueError(
                    "meta/episodes.jsonl line %d: episode_index must be an integer"
                    % line_no
                )
            if not isinstance(length, int) or isinstance(length, bool):
                raise ValueError(
                    "meta/episodes.jsonl line %d: length must be an integer"
                    % line_no
                )
            tasks = row.get("tasks") or []
            if not isinstance(tasks, list):
                raise ValueError(
                    "meta/episodes.jsonl line %d: tasks must be a list" % line_no
                )
            records[index] = {"tasks": tasks, "length": length}
        return records
    episodes_dir = root / "meta" / "episodes"
    if episodes_dir.is_dir():
        for path in sorted(episodes_dir.glob("chunk-*/*.parquet")):
            table = pq.read_table(path)
            if "episode_index" not in table.column_names or "length" not in table.column_names:
                raise ValueError(
                    "meta/episodes parquet %s lacks episode_index/length columns"
                    % path
                )
            indices = table.column("episode_index").to_pylist()
            lengths = table.column("length").to_pylist()
            task_lists = (
                table.column("tasks").to_pylist()
                if "tasks" in table.column_names
                else [None] * len(indices)
            )
            for index, length, tasks in zip(indices, lengths, task_lists):
                records[int(index)] = {"tasks": tasks or [], "length": int(length)}
    return records


def _load_data_table(root):
    """Concatenate data parquet shards in canonical order.

    Works for every layout: episode-per-file shards (v2.1 and this tool's
    v3.0) and file-per-many-episodes shards (current main). Rows are sorted
    by the global ``index`` column when present.
    """
    _require_pyarrow()
    data_dir = root / "data"
    if not data_dir.is_dir():
        raise ValueError("%s has no data/ directory" % root)
    paths = sorted(data_dir.glob("chunk-*/*.parquet"))
    if not paths:
        raise ValueError("%s/data contains no parquet shards" % root)
    tables = [pq.read_table(path) for path in paths]
    table = tables[0] if len(tables) == 1 else pyarrow.concat_tables(tables)
    if "index" in table.column_names:
        table = table.sort_by([("index", "ascending")])
    return table


def _as_scalar(value):
    """Unwrap the 1-element lists some v2.1 writers emit for shape-(1,) features."""
    if isinstance(value, list) and len(value) == 1:
        return value[0]
    return value


def _finite_float(value, context):
    """Coerce one parquet value to a finite python float, or fail closed."""
    value = _as_scalar(value)
    if not _is_number(value):
        raise ValueError("%s: value %r is not numeric" % (context, value))
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("%s: non-finite value (NaN/Inf) is refused" % context)
    return value


def _finite_vector(values, context):
    """Coerce one parquet list column cell to a list of finite floats."""
    if not isinstance(values, list):
        raise ValueError("%s: expected a list value, got %r" % (context, values))
    if not values:
        raise ValueError("%s: empty vector is refused" % context)
    return [_finite_float(v, context) for v in values]


def _video_spec(feature, key):
    """Video feature descriptor -> cameraFrame spec (encoding/geometry).

    LeRobot visual features are channels-first (C, H, W); a (H, W, C) shape
    is tolerated for legacy datasets. The import decodes back to rgb8 or
    mono8 raw pixels, matching what export wrote.
    """
    shape = feature.get("shape")
    if not isinstance(shape, list) or len(shape) != 3:
        raise ValueError(
            "video feature %s has unsupported shape %r (expected [C, H, W])"
            % (key, shape)
        )
    if shape[0] in (1, 3):
        channels, height, width = shape
    elif shape[2] in (1, 3):
        height, width, channels = shape
    else:
        raise ValueError(
            "video feature %s shape %r has no channel dimension of 1 or 3"
            % (key, shape)
        )
    return {
        "encoding": "mono8" if channels == 1 else "rgb8",
        "width": int(width),
        "height": int(height),
        "channels": int(channels),
    }


def _decode_video_file(path, spec):
    """Decode one mp4 to raw frames (rgb24/gray) with ffmpeg.

    Returns a list of frame byte strings. A decode failure or a byte
    stream that is not a whole number of frames fails closed.
    """
    ffmpeg = _require_ffmpeg()
    pix_fmt = "gray" if spec["channels"] == 1 else "rgb24"
    command = [
        ffmpeg, "-loglevel", "error", "-i", str(path),
        "-f", "rawvideo", "-pix_fmt", pix_fmt, "-",
    ]
    run = subprocess.run(command, capture_output=True)
    if run.returncode != 0:
        raise ValueError(
            "ffmpeg video decode failed for %s (exit %d): %s"
            % (path, run.returncode, run.stderr.decode("utf-8", "replace").strip()[:400])
        )
    frame_size = spec["width"] * spec["height"] * spec["channels"]
    raw = run.stdout
    if len(raw) % frame_size != 0:
        raise ValueError(
            "decoded %d bytes from %s — not a whole number of %dx%d frames"
            % (len(raw), path, spec["width"], spec["height"])
        )
    return [raw[offset:offset + frame_size]
            for offset in range(0, len(raw), frame_size)]


def _video_frames_for_episodes(root, video_key, spec, lengths):
    """All frames of one video key, split per episode.

    Every mp4 shard of the key is decoded in sorted path order (episode_
    and file_ sharding both work), the decoded frames are concatenated and
    sliced by episode lengths — the frame count must match the parquet
    rows, per episode and in total, or the dataset is inconsistent.
    """
    pattern = "videos/chunk-*/%s/*.mp4" % video_key
    paths = sorted(root.glob(pattern))
    if not paths:
        raise ValueError(
            "video feature %s is declared but %s matches no mp4 file"
            % (video_key, pattern)
        )
    frames = []
    for path in paths:
        frames.extend(_decode_video_file(path, spec))
    cursor = 0
    per_episode = []
    for episode_index, length in enumerate(lengths):
        if cursor + length > len(frames):
            raise ValueError(
                "video %s has %d frames but episode %d alone needs %d more "
                "than available (parquet rows and video frames disagree)"
                % (video_key, len(frames), episode_index, cursor + length)
            )
        per_episode.append(frames[cursor:cursor + length])
        cursor += length
    if cursor != len(frames):
        raise ValueError(
            "video %s decoded %d frames but parquet has %d rows"
            % (video_key, len(frames), cursor)
        )
    return per_episode


def run_import(dataset_dir, out_path, with_video=False):
    """Import a LeRobot v2.1/v3.0 dataset as a platform trajectory JSONL.

    The output is what `engines/act/train_act.py` trains on: a
    microduck-trajectory-v1 header (sampleHz = dataset fps) plus
    `{"type": "step", "t", "observation", "action", "done"}` rows, episodes
    closed by done:true on the last row of each episode. t comes from the
    official timestamp column, synthesized as position/fps when absent.
    Numbers are coerced to python floats; NaN/Inf/null are refused.

    Video columns are tabular-refused unless --with-video is passed AND
    ffmpeg exists; then frames are decoded to cameraFrame base64 raw
    pixels with a per-episode frame-count check against the parquet rows.
    The file is written only after every episode validates (no partial
    output). Returns the CLI summary dict.
    """
    root = pathlib.Path(dataset_dir)
    info = _read_info(root)
    fps = _as_scalar(info.get("fps"))
    if not _is_number(fps) or fps <= 0:
        raise ValueError("meta/info.json fps must be a positive number, got %r" % info.get("fps"))
    fps = int(fps)
    features = info.get("features") or {}
    if not isinstance(features, dict):
        raise ValueError("meta/info.json 'features' must be a JSON object")
    video_keys = sorted(
        key for key, feature in features.items()
        if isinstance(feature, dict) and feature.get("dtype") == "video"
    )
    image_keys = sorted(
        key for key, feature in features.items()
        if isinstance(feature, dict) and feature.get("dtype") == "image"
    )
    if image_keys:
        raise ValueError(
            "image feature(s) %s store frame files outside parquet — this "
            "converter only handles video features (via --with-video)" % image_keys
        )
    if video_keys and not with_video:
        raise ValueError(
            "video feature(s) %s exist but import runs in tabular mode — "
            "video decoding import requires --with-video (and ffmpeg); "
            "re-run with --with-video to decode them" % video_keys
        )
    _require_pyarrow()

    tasks = _read_tasks(root)
    episode_records = _read_episode_records(root)
    table = _load_data_table(root)
    columns = table.column_names
    if OBSERVATION_FEATURE not in columns or ACTION_FEATURE not in columns:
        raise ValueError(
            "dataset parquet has no %s/%s columns (found %s) — nothing "
            "trainable for the platform observation/action contract"
            % (OBSERVATION_FEATURE, ACTION_FEATURE, columns)
        )
    if "episode_index" not in columns:
        raise ValueError("dataset parquet has no episode_index column — cannot split episodes")

    obs_cells = table.column(OBSERVATION_FEATURE).to_pylist()
    act_cells = table.column(ACTION_FEATURE).to_pylist()
    reward_cells = (
        table.column(REWARD_FEATURE).to_pylist() if REWARD_FEATURE in columns else None
    )
    timestamps = (
        [_as_scalar(v) for v in table.column("timestamp").to_pylist()]
        if "timestamp" in columns else None
    )
    frame_indices = (
        [_as_scalar(v) for v in table.column("frame_index").to_pylist()]
        if "frame_index" in columns else None
    )
    episode_values = [_as_scalar(v) for v in table.column("episode_index").to_pylist()]

    # Group rows into episodes by the episode_index column (the authoritative
    # boundary source); episodes.jsonl lengths and the declared totals
    # cross-check it. A parquet with zero rows is an empty dataset.
    groups = []
    for row_index, value in enumerate(episode_values):
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(
                "parquet row %d: episode_index must be an integer, got %r"
                % (row_index, value)
            )
        if not groups or groups[-1]["index"] != value:
            groups.append({"index": value, "rows": []})
        groups[-1]["rows"].append(row_index)
    if not groups:
        raise ValueError("dataset parquet has no rows — empty dataset is refused")
    lengths = [len(group["rows"]) for group in groups]
    if episode_records and len(episode_records) != len(groups):
        raise ValueError(
            "episode metadata declares %d episodes but parquet carries %d"
            % (len(episode_records), len(groups))
        )
    declared_total = _as_scalar(info.get("total_episodes"))
    if _is_number(declared_total) and int(declared_total) != len(groups):
        raise ValueError(
            "meta/info.json total_episodes is %d but parquet carries %d episodes"
            % (int(declared_total), len(groups))
        )
    for group in groups:
        record = episode_records.get(group["index"])
        if record is not None and record["length"] != len(group["rows"]):
            raise ValueError(
                "episode %d length mismatch: episodes metadata says %d, "
                "parquet has %d rows"
                % (group["index"], record["length"], len(group["rows"]))
            )

    # Videos: decode once per key, split per episode, attach cameraFrame.
    per_episode_frames = {}
    if with_video:
        if not video_keys:
            raise ValueError(
                "--with-video was passed but the dataset declares no video "
                "features; run without it"
            )
        if len(video_keys) > 1:
            raise ValueError(
                "the platform trajectory format carries a single cameraFrame "
                "per step; dataset has %d video features %s" % (len(video_keys), video_keys)
            )
        spec = _video_spec(features[video_keys[0]], video_keys[0])
        per_episode_frames[video_keys[0]] = _video_frames_for_episodes(
            root, video_keys[0], spec, lengths
        )

    obs_dim = act_dim = None
    steps_per_episode = []
    for group in groups:
        steps = []
        for position, row_index in enumerate(group["rows"]):
            context = "parquet row %d (episode %d)" % (row_index, group["index"])
            obs = _finite_vector(obs_cells[row_index], "%s observation.state" % context)
            act = _finite_vector(act_cells[row_index], "%s action" % context)
            if obs_dim is None:
                obs_dim, act_dim = len(obs), len(act)
            if len(obs) != obs_dim or len(act) != act_dim:
                raise ValueError("%s: inconsistent dimensions" % context)
            if timestamps is not None:
                t = _finite_float(timestamps[row_index], "%s timestamp" % context)
            elif frame_indices is not None:
                t = float(frame_indices[row_index]) / fps
            else:
                t = position / fps
            step = {
                "type": "step", "t": t, "observation": obs, "action": act,
                "done": position == len(group["rows"]) - 1,
            }
            if reward_cells is not None:
                step["reward"] = _finite_float(
                    reward_cells[row_index], "%s reward" % context
                )
            if with_video:
                key = video_keys[0]
                frame = per_episode_frames[key][len(steps_per_episode)][position]
                step["cameraFrame"] = {
                    "encoding": spec["encoding"],
                    "width": spec["width"],
                    "height": spec["height"],
                    "channels": spec["channels"],
                    "data": base64.b64encode(frame).decode("ascii"),
                }
            steps.append(step)
        steps_per_episode.append(steps)

    task_names = [tasks[index] for index in sorted(tasks)]
    note = "converted from LeRobot dataset %s, tasks: %s" % (
        info.get("codebase_version"),
        "; ".join(task_names) if task_names else "(none declared)",
    )
    header = {
        "type": "header",
        "format": TRAJECTORY_FORMAT,
        "source": IMPORT_SOURCE,
        "sampleHz": fps,
        "note": note,
    }
    out = pathlib.Path(out_path)
    if out.parent and not out.parent.exists():
        out.parent.mkdir(parents=True)
    lines = [json.dumps(header, ensure_ascii=False)]
    for steps in steps_per_episode:
        lines.extend(json.dumps(step, ensure_ascii=False) for step in steps)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    return {
        "command": "import",
        "episodes": len(steps_per_episode),
        "frames": len(obs_cells),
        "obsDim": obs_dim,
        "actDim": act_dim,
        "fps": fps,
        "videos": len(video_keys) if with_video else 0,
        "output": str(out),
    }


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        prog="lerobot_convert.py",
        description="Convert between platform trajectory JSONL and LeRobot "
                    "v2.1/v3.0 dataset directories (ecosystem on-ramp).",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    export = commands.add_parser(
        "export", help="trajectory JSONL -> LeRobot v3.0 dataset directory"
    )
    export.add_argument(
        "inputs", nargs="+",
        help="trajectory JSONL files; episodes concatenate in input order",
    )
    export.add_argument(
        "--out", required=True,
        help="output dataset directory (must not exist, or be empty)",
    )
    export.add_argument(
        "--fps", type=int, default=None,
        help="dataset fps override (default: header sampleHz, else 50)",
    )
    export.add_argument(
        "--task", default=DEFAULT_TASK,
        help="task description recorded in meta/tasks.jsonl",
    )

    importer = commands.add_parser(
        "import", help="LeRobot dataset directory -> trainable trajectory JSONL"
    )
    importer.add_argument("dataset", help="LeRobot dataset root (meta/info.json)")
    importer.add_argument("--out", required=True, help="output NDJSON path")
    importer.add_argument(
        "--with-video", action="store_true",
        help="decode observation.images.* videos into cameraFrame rows "
             "(requires ffmpeg; default off = tabular import, video "
             "datasets are refused)",
    )
    args = parser.parse_args()

    if args.command == "export":
        summary = run_export(args.inputs, args.out, fps=args.fps, task=args.task)
    else:
        summary = run_import(args.dataset, args.out, with_video=args.with_video)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print("%s FAIL — %s" % (TOOL_TAG, error), file=sys.stderr)
        sys.exit(2)
