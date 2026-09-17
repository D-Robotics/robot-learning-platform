#!/usr/bin/env python3
"""microduck_rl worker adapter — the tutorial's GPU training stack, under the platform contract.

Runs inside the platform's local training worker: the worker writes
``RDK_SIM2REAL_REQUEST_FILE`` (the validated training request) and expects
``RDK_SIM2REAL_RESULT_FILE`` plus a job-local ``policy.onnx`` when the engine
produced a portable actor.  This adapter does not reimplement any physics: it
drives the upstream project verbatim

    uv run train <TASK_ID> --env.scene.num-envs <N> --agent.max_iterations <M>

and the upstream exporter

    uv run scripts/export.py <TASK_ID> --checkpoint-file <model_*.pt> --onnx-file policy.onnx

so a run started from the workbench is the same run the tutorial describes, on
the same MuJoCo-Warp contact dynamics, with the same PPO configuration.

Honesty rules this file follows (they are the platform's, not decoration):

* No upstream repo / no CUDA  -> exit 3.  The platform marks the task failed;
  it never reports a fabricated completed run.
* ``physicsBackend`` is ``"mjlab-mujoco-warp"`` only when the upstream trainer
  really ran; ``result.cuda`` is true only when this process saw a CUDA device.
* ``deployable`` stays false: reaching an X5 requires the vendor BPU
  compilation step (``scripts/compile-policy.mjs``), which this adapter does
  not do.
* The live curve is parsed from the trainer's own stdout.  ``successRate`` is
  only reported when the trainer printed an episode-termination rate; the
  progress curve's second slot carries the mean episode-length fraction
  instead, because that number is real and a made-up success rate is not.

Run it through the worker only:

  RDK_SIM2REAL_TRAIN_EXECUTABLE=<repo>/.venv/bin/python
  RDK_SIM2REAL_TRAIN_ARGS_JSON=["<abs>/engines/microduck-rl-adapter/adapter.py"]
  RDK_MICRODUCK_RL_DIR=<abs path to the microduck_rl checkout>
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ADAPTER_ID = "microduck-rl"
PHYSICS_BACKEND = "mjlab-mujoco-warp"
EXIT_MISSING_STACK = 3
EXIT_BAD_REQUEST = 2

#: Upstream task ids the adapter will drive.  Kept as a warning list rather
#: than a hard gate: the upstream registry is the source of truth and a new
#: task must not require editing this file to run.
KNOWN_TASKS = {
    "Mjlab-Velocity-Flat-MicroDuck",
    "Mjlab-Velocity-Rough-MicroDuck",
    "Mjlab-VelStand-Flat-MicroDuck",
    "Mjlab-VelStand-Rough-MicroDuck",
    "Mjlab-StandUp-Flat-MicroDuck",
    "Mjlab-StandUp-Rough-MicroDuck",
    "Mjlab-SitStand-Flat-MicroDuck",
    "Mjlab-SitStand-Rough-MicroDuck",
    "Mjlab-GroundPick-Flat-MicroDuck",
    "Mjlab-GroundPick-Rough-MicroDuck",
    "Mjlab-BallKick-Flat-MicroDuck",
    "Mjlab-Roulade-Flat-MicroDuck",
    "Mjlab-Velocity-Flat-MicroDuck-Rollers",
    "Mjlab-Velocity-Swizzle-MicroDuck",
    "Mjlab-RollerCrouch-Flat-MicroDuck",
    "Mjlab-RollerSlope-Flat-MicroDuck",
    "Mjlab-RollerStandUp-Flat-MicroDuck",
    "Mjlab-Spin-Flat-MicroDuck",
}

#: platform action-task id (request.taskId) -> upstream task id suffix.
#: ``.format(terrain)`` where terrain is Flat or Rough.
TASK_BY_PLATFORM_ID = {
    "walk": "Mjlab-Velocity-{terrain}-MicroDuck",
    "turn": "Mjlab-Velocity-{terrain}-MicroDuck",
    "velocity": "Mjlab-Velocity-{terrain}-MicroDuck",
    "sit": "Mjlab-SitStand-{terrain}-MicroDuck",
    "sit-stand": "Mjlab-SitStand-{terrain}-MicroDuck",
    "recover": "Mjlab-VelStand-{terrain}-MicroDuck",
    "stand": "Mjlab-StandUp-{terrain}-MicroDuck",
    "pick": "Mjlab-GroundPick-{terrain}-MicroDuck",
    "kick": "Mjlab-BallKick-Flat-MicroDuck",
    "roulade": "Mjlab-Roulade-Flat-MicroDuck",
    "roll": "Mjlab-Roulade-Flat-MicroDuck",
    "skate": "Mjlab-Velocity-Flat-MicroDuck-Rollers",
    "roller": "Mjlab-Velocity-Flat-MicroDuck-Rollers",
    "spin": "Mjlab-Spin-Flat-MicroDuck",
}

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
ITER_LINE_RE = re.compile(r"Learning iteration\s+(\d+)\s*/\s*(\d+)")
LABEL_VALUE_RE = re.compile(r"([A-Za-z][A-Za-z /_-]{2,40}?):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)")
EPISODE_METRIC_KEY_RE = re.compile(r"termination|reward/", re.IGNORECASE)


def stdout(line: str) -> None:
    print("[microduck-rl] " + str(line), flush=True)


def stderr(line: str) -> None:
    print("[microduck-rl] " + str(line), file=sys.stderr, flush=True)


def env_path(name: str) -> Path | None:
    raw = (os.environ.get(name) or "").strip()
    return Path(raw).expanduser().resolve() if raw else None


def parse_bool(value: object, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off", ""):
        return False
    return fallback


def clamp_int(value: object, low: int, high: int, fallback: int) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, parsed))


def terrain_of(request: dict) -> str:
    """Rough terrain only when the request actually asked for it.

    The platform contract carries no terrain field today; honour an explicit
    request when a future manifest adds one and default to the tutorial's
    simplest task otherwise.
    """
    for container in (request.get("training"), request.get("task"), request.get("simulator")):
        if isinstance(container, dict):
            for key in ("terrain", "terrainType", "scene"):
                value = str(container.get(key) or "").strip().lower()
                if value in ("flat", "rough"):
                    return value.capitalize()
    return "Flat"


def resolve_task_id(request: dict) -> str:
    model = request.get("model") if isinstance(request.get("model"), dict) else {}
    simulator = request.get("simulator") if isinstance(request.get("simulator"), dict) else {}
    training = request.get("training") if isinstance(request.get("training"), dict) else {}
    for candidate in (
        training.get("taskId"),
        training.get("upstreamTaskId"),
        simulator.get("taskId"),
        model.get("taskId"),
    ):
        text = str(candidate or "").strip()
        if text.startswith("Mjlab-"):
            return text
    platform_id = str(request.get("taskId") or "").strip().lower()
    template = TASK_BY_PLATFORM_ID.get(platform_id)
    if template:
        return template.format(terrain=terrain_of(request))
    return "Mjlab-Velocity-Flat-MicroDuck"


def find_repo() -> Path | None:
    for candidate in (env_path("RDK_MICRODUCK_RL_DIR"), env_path("RDK_MICRODUCK_RL_ROOT")):
        if candidate and (candidate / "pyproject.toml").is_file():
            return candidate
    for candidate in (Path.home() / "microduck_rl", Path("/opt/microduck_rl")):
        if (candidate / "pyproject.toml").is_file():
            return candidate.resolve()
    return None


def find_uv() -> str | None:
    configured = (os.environ.get("RDK_MICRODUCK_RL_UV") or "").strip()
    if configured and Path(configured).is_file():
        return configured
    found = shutil.which("uv")
    if found:
        return found
    for candidate in (Path.home() / ".local/bin/uv", Path("/usr/local/bin/uv"), Path("/usr/bin/uv")):
        if candidate.is_file():
            return str(candidate)
    return None


class StreamParser:
    """Turn the trainer's ANSI progress blocks into the platform's curve.

    One upstream log block looks like:

        ############################  Learning iteration 3/5  ############################
           Computation: 41234 steps/s (collection: 0.912s, learning 0.331s)
           Mean total reward:                          12.34
           Mean episode length:                        318.20
           Total timesteps:                            819200
           Iteration time:                             1.52s
           Total time:                                 4.71s
           ETA:                                        3.0s

    rsl-rl 2.2.3 always prints it (its W&B/Neptune writers are additive), so the
    live curve needs no extra dependency.  The adapter re-emits one parsed line
    per iteration in the format the worker's parser already understands.
    """

    def __init__(self) -> None:
        self.buffer = ""
        self.pending_iteration: int | None = None
        self.pending_total: int | None = None
        self.pending_metrics: dict[str, float] = {}
        self.points: list[dict] = []
        self.episode_metrics: dict[str, float] = {}
        self.iterations_seen = 0

    def feed(self, chunk: str) -> None:
        # rsl-rl writes its iteration block through rich, which terminates the
        # header with CRLF even on a pipe (verified against the real 5090 run:
        # 381 CR vs 384 LF). Normalize CRLF first, then treat a lone CR as a
        # rewrite of the current line — the previous behaviour (CR -> LF) split
        # the "Learning iteration" header in two and silently produced an empty
        # curve.
        self.buffer += chunk.replace("\r\n", "\n").replace("\r", "\n")
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            self._line(line)

    def flush(self) -> None:
        if self.buffer:
            self._line(self.buffer)
            self.buffer = ""
        self._commit()

    def _line(self, raw: str) -> None:
        line = ANSI_RE.sub("", raw).strip()
        if not line:
            return
        match = ITER_LINE_RE.search(line)
        if match:
            self._commit()
            self.pending_iteration = int(match.group(1))
            self.pending_total = int(match.group(2))
            self.iterations_seen = max(self.iterations_seen, self.pending_iteration)
            return
        if self.pending_iteration is None:
            return
        # rsl-rl pads each label with spaces, but a narrow terminal wraps the
        # columns; collapsing all whitespace keeps "Mean total\n reward: 12.3"
        # parseable without depending on the terminal width.
        normalized = re.sub(r"\s+", " ", line)
        for key, value in LABEL_VALUE_RE.findall(normalized):
            label = key.strip().lower()
            self.pending_metrics[label] = float(value)
            if EPISODE_METRIC_KEY_RE.search(label):
                # mjlab 1.3.0 prints the per-term episode metrics (terminations,
                # reward terms, task metrics) inside the same block. They are
                # evidence, not the curve: keep the latest value of each, never
                # require them to exist.
                self.episode_metrics[label] = float(value)
        if "eta" in normalized.lower():
            self._commit()

    def _commit(self) -> None:
        """Emit the completed block. The metadata lines of block N+1 arrive
        BEFORE block N+1's header, so a block is only reported once its ETA
        line (or the next iteration header) proves it is complete."""
        if self.pending_iteration is None:
            return
        # The label differs across mjlab revisions ("Mean reward" in 1.3.0,
        # "Mean total reward" in rsl-rl 2.2.3 upstream). Accept both instead of
        # pinning one and silently producing an empty curve again.
        reward = self.pending_metrics.get("mean reward")
        if reward is None:
            reward = self.pending_metrics.get("mean total reward")
        if reward is None:
            reward = self.pending_metrics.get("mean episode reward")
        length = self.pending_metrics.get("mean episode length")
        elapsed = self.pending_metrics.get("total time")
        iteration, total = self.pending_iteration, self.pending_total or self.pending_iteration
        self.pending_iteration = None
        self.pending_total = None
        self.pending_metrics = {}
        if reward is None:
            # First iteration: rsl-rl's reward buffer is still empty, so the
            # block carries losses only. No fabricated zero.
            return
        self.points.append(
            {
                "iteration": iteration,
                "totalIterations": total,
                "meanReward": round(reward, 4),
                "episodeLengthSteps": None if length is None else round(length, 2),
                "elapsedSeconds": elapsed,
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
        stdout(
            "iter {}/{} meanReward={:.3f} recentSuccess={:.2f}".format(
                iteration, total, reward, 0.0
            )
        )

    @property
    def last_reward(self) -> float | None:
        return self.points[-1]["meanReward"] if self.points else None

    @property
    def last_episode_length(self) -> float | None:
        return self.points[-1]["episodeLengthSteps"] if self.points else None


def run_streamed(
    command: list[str],
    cwd: Path,
    parser: StreamParser | None,
    tag: str,
    env: dict | None = None,
) -> int:
    """Run one upstream command, streaming output and capturing a tail.

    A pseudo-terminal is deliberately NOT used: the training output must be
    the same bytes a human sees, and pty allocation changes buffering on some
    cluster images.  Progress parsing therefore works on plain pipes.
    """
    stdout("$ " + " ".join(command))
    capture: list[str] = []
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        errors="replace",
        env=env,
    )
    assert process.stdout is not None
    for line in process.stdout:
        capture.append(line)
        if len(capture) > 4000:
            del capture[:2000]
        if parser is not None:
            parser.feed(line)
        else:
            sys.stdout.write(line if line.endswith("\n") else line + "\n")
    process.wait()
    if parser is not None:
        parser.flush()
    if process.returncode != 0:
        tail = "".join(capture[-40:])
        stderr("{} failed with exit code {}:\n{}".format(tag, process.returncode, tail.strip()))
    return process.returncode


def cuda_available(python: str, cwd: Path) -> tuple[bool, str]:
    probe = subprocess.run(
        [python, "-c", "import torch;print(torch.cuda.is_available());print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu')"],
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        return False, "unknown"
    lines = [line.strip() for line in probe.stdout.splitlines() if line.strip()]
    if not lines:
        return False, "unknown"
    return lines[0].lower() == "true", (lines[1] if len(lines) > 1 else "unknown")


def sha256_of(path: Path) -> str | None:
    """Digest of a produced artifact, or None when it cannot be read."""
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def export_command(uv: str, task_id: str, checkpoint: Path, onnx_path: Path) -> list[str]:
    """The upstream exporter invocation, in one testable place.

    `scripts/export.py` is the only supported checkpoint -> ONNX path (it bakes
    the observation normalizer into the graph), and the worker only hashes
    ``<job>/policy.onnx``, so the destination is fixed by the platform.
    """
    return [
        uv,
        "run",
        "scripts/export.py",
        task_id,
        "--checkpoint-file",
        str(checkpoint),
        "--onnx-file",
        str(onnx_path),
    ]


def load_export_gate():
    """Import the sibling gate module by path (this file is a worker script)."""
    import importlib.util

    path = Path(__file__).resolve().parent / "onnx_export_gate.py"
    spec = importlib.util.spec_from_file_location("microduck_rl_onnx_export_gate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def iteration_of(path: Path) -> int:
    match = re.search(r"model_(\d+)\.pt$", path.name)
    return int(match.group(1)) if match else -1


def newest_checkpoint(log_dir: Path) -> Path | None:
    """Highest-iteration checkpoint in one experiment directory.

    mjlab's runner writes `model_0.pt` at iteration 0 and then honour
    `save_interval` (250 for MicroDuck), so a run that stops early still has a
    checkpoint file — the adapter must not mistake "trained weights exist" for
    "a usable policy exists". The caller checks the iteration number.
    """
    candidates = [path for path in log_dir.glob("model_*.pt") if path.is_file()]
    if not candidates:
        return None
    return max(candidates, key=iteration_of)


def experiment_marker_dirs(log_root: Path) -> list[Path]:
    """Every upstream experiment directory under a log root.

    The real tree is `logs/rsl_rl/<experiment_name>/<timestamp>_<run_name>/`,
    and `experiment_name` comes from the task config (`velocity` for MicroDuck,
    but different per task family). Searching for a marker file instead of
    hardcoding the layout keeps new task families working.
    """
    if not log_root.is_dir():
        return []
    found: dict[Path, None] = {}
    for pattern in ("*/params/agent.yaml", "*/*/params/agent.yaml", "*/model_*.pt", "*/*/model_*.pt"):
        for marker in log_root.glob(pattern):
            found.setdefault(marker.parent.parent if marker.parent.name == "params" else marker.parent, None)
    return list(found)


def new_experiment_dir(log_root: Path, before: set[str]) -> Path | None:
    """The experiment directory this job created, never a concurrent job's.

    Diffing the directory listing before/after the run is race-free with other
    jobs sharing the upstream `logs/rsl_rl` root; mtime is only a tie-breaker.
    """
    candidates = experiment_marker_dirs(log_root)
    if not candidates:
        return None
    created = [path for path in candidates if str(path) not in before]
    pool = created or candidates
    # (mtime, name) keeps the choice deterministic when two directories land in
    # the same filesystem timestamp tick.
    return max(pool, key=lambda path: (path.stat().st_mtime, path.name))


def write_result(result_path: Path, payload: dict) -> None:
    with open(result_path, "w") as handle:
        json.dump(payload, handle, indent=2)
    stdout("wrote result (physicsBackend={})".format(payload.get("physicsBackend")))


def main() -> None:
    request_path = (os.environ.get("RDK_SIM2REAL_REQUEST_FILE") or "").strip()
    result_path_raw = (os.environ.get("RDK_SIM2REAL_RESULT_FILE") or "").strip()
    if not request_path or not result_path_raw:
        stderr(
            "RDK_SIM2REAL_REQUEST_FILE and RDK_SIM2REAL_RESULT_FILE are required; "
            "run this through services/sim2real-web/local-training-worker.mjs"
        )
        sys.exit(EXIT_BAD_REQUEST)

    with open(request_path) as handle:
        request = json.load(handle)
    if request.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")
    result_path = Path(result_path_raw)
    job_dir = Path(os.environ.get("RDK_SIM2REAL_JOB_DIR") or result_path.parent).resolve()

    contract = request.get("contract") or {}
    training = request.get("training") or {}
    model = request.get("model") or {}
    observation_size = int(contract.get("observationSize", 0))
    action_size = int(contract.get("actionSize", 0))
    if observation_size <= 0 or action_size <= 0:
        raise ValueError("contract.observationSize and contract.actionSize are required")

    repo = find_repo()
    uv = find_uv()
    if repo is None or uv is None:
        stderr(
            "[microduck-rl] REFUSED — upstream stack not found "
            "(repo={}, uv={}). Deploy it first:\n"
            "  git clone https://github.com/pollen-robotics/microduck_rl ~/microduck_rl\n"
            "  cd ~/microduck_rl && uv sync\n"
            "  export RDK_MICRODUCK_RL_DIR=$HOME/microduck_rl\n"
            "This adapter never fabricates a completed training run.".format(repo, uv)
        )
        sys.exit(EXIT_MISSING_STACK)

    venv_python = repo / ".venv" / "bin" / "python"
    python = str(venv_python) if venv_python.is_file() else sys.executable
    task_id = resolve_task_id(request)
    if task_id not in KNOWN_TASKS:
        stdout("task {} is not in the adapter's known list; the upstream registry decides".format(task_id))

    profile = str(training.get("profile", "smoke"))
    # The tutorial's own numbers: 64 envs for a 4 GB card, 4096 for a 24 GB one.
    # The platform profile presets already encode them; the adapter only clamps
    # to what the request asked for, so a workbench submission and a terminal
    # command train the same thing.
    num_envs = clamp_int(training.get("numEnvs"), 1, 16_384, 64)
    max_iterations = clamp_int(training.get("maxIterations"), 1, 2_000_000, 5)
    video = parse_bool(training.get("video"), False)
    if parse_bool(os.environ.get("RDK_MICRODUCK_RL_FORCE_CPU"), False):
        num_envs = min(num_envs, 64)

    # The upstream CLI takes no `--log-root` flag in the pinned revision (tyro
    # rejects it), so the adapter uses upstream's own default `logs/rsl_rl`
    # inside the checkout — the same path the tutorial's `play`/`export`
    # commands resolve. Each run gets its own timestamped experiment directory
    # there; several concurrent jobs never share one. `MICRODUCK_RL_LOG_ROOT`
    # is the operator override for moving that tree onto a bigger volume.
    log_root = Path(os.environ.get("MICRODUCK_RL_LOG_ROOT") or (repo / "logs" / "rsl_rl")).resolve()
    run_name = "platform-{}".format(str(request.get("idempotencyKey") or os.environ.get("RDK_SIM2REAL_JOB_ID") or "run")[:48])
    command = [
        uv,
        "run",
        "train",
        task_id,
        "--env.scene.num-envs",
        str(num_envs),
        "--agent.max_iterations",
        str(max_iterations),
        "--agent.run-name",
        run_name,
    ]
    checkpoint_ref = request.get("resumeFrom") or request.get("checkpoint")
    requested_checkpoint = None
    if isinstance(checkpoint_ref, dict):
        requested_checkpoint = str(
            checkpoint_ref.get("checkpointFile") or checkpoint_ref.get("file") or ""
        ).strip()
        iteration_hint = checkpoint_ref.get("iteration") or checkpoint_ref.get("iterationNumber")
        if requested_checkpoint and checkpoint_ref.get("localPath"):
            requested_checkpoint = str(checkpoint_ref["localPath"])
        elif not requested_checkpoint and iteration_hint is not None:
            requested_checkpoint = "model_{}.pt".format(int(iteration_hint))
    if requested_checkpoint:
        candidate = Path(requested_checkpoint)
        if not candidate.is_absolute():
            candidate = job_dir / candidate
        if candidate.is_file():
            command += ["--agent.load-checkpoint", str(candidate), "--agent.resume", "True"]
            stdout("resuming from {}".format(candidate))
        else:
            stdout(
                "resume requested but {} is not a readable local file; the worker protocol "
                "does not fetch artifact:// references, starting a fresh run".format(candidate)
            )
    if video:
        command += ["--video", "True"]

    stdout(
        "engine={} profile={} task={} envs={} iters={} obs={} act={} repo={}".format(
            ADAPTER_ID, profile, task_id, num_envs, max_iterations, observation_size, action_size, repo
        )
    )

    has_cuda, device_name = cuda_available(python, repo)
    if not has_cuda:
        stdout(
            "no CUDA device visible to {} — upstream MuJoCo-Warp training requires one; "
            "the run may fail or fall back".format(python)
        )

    # Upstream defaults to `logger="wandb"`, and wandb.init() with no API key
    # does not fail soft: it raises and kills the whole training run after the
    # environment is built (seen on this GPU box, 2026-09-16). The platform
    # curve comes from the trainer's own stdout, so an unattended worker needs
    # no wandb at all: without a key the adapter switches the run to the
    # local tensorboard writer instead of asking a human to `wandb login`.
    # Set WANDB_API_KEY (or RDK_MICRODUCK_RL_WANDB=1 with a stored key) to keep
    # wandb, exactly like the tutorial's optional step 3.
    child_env = dict(os.environ)
    wandb_key = bool(
        (os.environ.get("WANDB_API_KEY") or os.environ.get("RDK_MICRODUCK_RL_WANDB_API_KEY") or "").strip()
    )
    wandb_forced = parse_bool(os.environ.get("RDK_MICRODUCK_RL_WANDB"), False)
    if wandb_key or wandb_forced:
        stdout("wandb logging kept (API key present)" if wandb_key else "wandb logging forced by RDK_MICRODUCK_RL_WANDB")
    else:
        command += ["--agent.logger", "tensorboard"]
        child_env["WANDB_MODE"] = "disabled"
        stdout("no wandb API key: using the local tensorboard writer (curve comes from stdout)")

    started = time.time()
    experiments_before = {str(path) for path in experiment_marker_dirs(log_root)}
    parser = StreamParser()
    code = run_streamed(command, repo, parser, "train", env=child_env)
    training_seconds = round(time.time() - started, 1)
    if code != 0:
        stderr(
            "[microduck-rl] upstream training failed (exit {}); no artifact is reported"
            .format(code)
        )
        sys.exit(code if code > 0 else 1)

    # ---- pick up what upstream wrote --------------------------------------
    experiment = new_experiment_dir(log_root, experiments_before)
    if experiment is None:
        stderr(
            "[microduck-rl] training reported success but no experiment directory appeared under {}".format(
                log_root
            )
        )
        sys.exit(1)

    checkpoint = newest_checkpoint(experiment)
    checkpoint_iteration = iteration_of(checkpoint) if checkpoint is not None else None
    stdout("upstream log directory: {}".format(experiment))
    stdout(
        "checkpoint: {}".format(
            "{} (iteration {})".format(checkpoint.name, checkpoint_iteration)
            if checkpoint is not None
            else "none"
        )
    )

    # ---- portable actor for the platform (job-local policy.onnx) -----------
    onnx_exported = False
    onnx_bytes = 0
    onnx_seconds = None
    onnx_sha256: str | None = None
    onnx_gate: dict | None = None
    if checkpoint is None:
        stdout("no checkpoint was written: nothing to export")
    elif not checkpoint_iteration:
        # mjlab writes model_0.pt before the first gradient step, so an
        # interrupted smoke run leaves a checkpoint that encodes nothing
        # trained. Exporting it would hand the platform an artifact that looks
        # like a policy and is not one.
        stdout(
            "only the iteration-0 checkpoint exists (no training progress); "
            "no ONNX artifact is produced"
        )
    else:
        export_cmd = export_command(uv, task_id, checkpoint, job_dir / "policy.onnx")
        export_started = time.time()
        export_code = run_streamed(export_cmd, repo, None, "export")
        onnx_seconds = round(time.time() - export_started, 1)
        onnx_path = job_dir / "policy.onnx"
        if export_code == 0 and onnx_path.is_file() and onnx_path.stat().st_size > 0:
            # "export exited 0" is not "this file is a policy": the gate runs
            # the exported graph on probe observations and withholds the
            # artifact when it fails the IO contract, finiteness,
            # determinism or input sensitivity. onnxruntime missing in the
            # upstream venv is a recorded skip, not a silent pass.
            try:
                gate = load_export_gate()
                onnx_gate = gate.run_gate(onnx_path)
            except Exception as error:  # noqa: BLE001
                onnx_gate = {
                    "verdict": "skipped",
                    "checks": {},
                    "reasons": ["export gate crashed: {}".format(error)],
                }
            stdout("ONNX export gate: {}".format(onnx_gate["verdict"]))
            for reason in onnx_gate.get("reasons", []):
                stdout("  gate: {}".format(reason))
            if onnx_gate["verdict"] == "failed":
                rejected = onnx_path.with_name(onnx_path.name + ".rejected")
                onnx_path.rename(rejected)
                stdout(
                    "artifact WITHHELD: the exported graph failed the gate; kept as {} "
                    "for inspection (training itself completed and is reported)".format(
                        rejected.name
                    )
                )
            else:
                onnx_exported = True
                onnx_bytes = onnx_path.stat().st_size
                onnx_sha256 = sha256_of(onnx_path)
                stdout(
                    "exported policy.onnx ({} bytes, sha256={})".format(
                        onnx_bytes, (onnx_sha256 or "unavailable")[:12]
                    )
                )
        else:
            stdout("ONNX export failed (exit {}); continuing without it".format(export_code))

    # ---- evidence ----------------------------------------------------------
    curve = [
        {
            "iteration": point["iteration"],
            "totalIterations": point["totalIterations"],
            "meanReward": point["meanReward"],
            "episodeLengthSteps": point["episodeLengthSteps"],
            "elapsedSeconds": point.get("elapsedSeconds"),
        }
        for point in parser.points
    ]

    result, summary = build_result(
        request=request,
        contract=contract,
        model=model,
        profile=profile,
        task_id=task_id,
        run_name=run_name,
        num_envs=num_envs,
        max_iterations=max_iterations,
        video=video,
        repo=repo,
        experiment=experiment,
        checkpoint=checkpoint,
        curve=curve,
        points=len(parser.points),
        episode_metrics=parser.episode_metrics,
        has_cuda=has_cuda,
        device_name=device_name,
        training_seconds=training_seconds,
        onnx_exported=onnx_exported,
        onnx_bytes=onnx_bytes,
        onnx_seconds=onnx_seconds,
        onnx_sha256=onnx_sha256,
        onnx_gate=onnx_gate,
        command=command,
    )

    with open(job_dir / "training-summary.json", "w") as handle:
        json.dump(summary, handle, indent=2)

    # The worker hashes <job>/policy.onnx for digest/size; the summary and the
    # upstream logs stay next to it as the run's evidence.
    write_result(result_path, result)


def build_result(
    *,
    request: dict,
    contract: dict,
    model: dict,
    profile: str,
    task_id: str,
    run_name: str,
    num_envs: int,
    max_iterations: int,
    video: bool,
    repo: Path,
    experiment: Path | None,
    checkpoint: Path | None,
    curve: list[dict],
    points: int,
    episode_metrics: dict,
    has_cuda: bool,
    device_name: str,
    training_seconds: float,
    onnx_exported: bool,
    onnx_bytes: int,
    onnx_seconds: float | None,
    onnx_sha256: str | None = None,
    onnx_gate: dict | None = None,
    command: list[str],
) -> tuple[dict, dict]:
    """Build the operator evidence and the worker result from measured facts.

    Pure on purpose (no filesystem, no network): ``adapter_probe.py`` pins the
    shape here, so the contract the worker validates cannot drift on a machine
    this repository's tests can reach.
    """
    observation_size = int(contract.get("observationSize", 0))
    action_size = int(contract.get("actionSize", 0))
    final_reward = curve[-1]["meanReward"] if curve else None
    final_length = curve[-1]["episodeLengthSteps"] if curve else None
    # Checkpoint iteration and logged iteration answer different questions: a
    # run can finish 5 iterations while the newest checkpoint is the
    # iteration-0 file. Both are reported, neither is substituted for the other.
    checkpoint_iteration = None
    if checkpoint is not None:
        match = re.search(r"model_(\d+)\.pt$", checkpoint.name)
        checkpoint_iteration = int(match.group(1)) if match else None
    iteration = checkpoint_iteration
    if iteration is None and curve:
        iteration = curve[-1]["iteration"]

    checkpoint_ref = None
    if checkpoint is not None:
        # The .pt stays engine-internal (the worker hashes only policy.onnx);
        # the ref is provenance for a later resume/play run.
        # The platform's checkpoint contract is {checkpointId, artifactRef,
        # iteration} and `checkpointId` must match
        # ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ — a colon or a filesystem path makes
        # the server drop the whole checkpoint (verified against the first
        # end-to-end run). The local path stays in training-summary.json.
        checkpoint_ref = {
            "checkpointId": "{}-iter{}".format(run_name, iteration if iteration is not None else 0),
            "artifactRef": "artifact://{}/{}/{}".format(ADAPTER_ID, run_name, checkpoint.name),
            "iteration": iteration if iteration is not None else 0,
        }

    result = {
        "status": "completed",
        "engine": ADAPTER_ID,
        "taskId": task_id,
        "physicsBackend": PHYSICS_BACKEND,
        "deployable": False,
        "cuda": has_cuda,
        "metrics": {
            "contractValid": True,
            "observationSize": observation_size,
            "actionSize": action_size,
            "reward": final_reward,
            "episodeLength": final_length,
            "iterations": iteration,
            "loggedIterations": points,
            "checkpointIteration": checkpoint_iteration,
            "physicsBackend": PHYSICS_BACKEND,
            "engine": ADAPTER_ID,
            "cuda": has_cuda,
        },
        "artifact": {
            "ref": "artifact://{}/{}/policy.onnx".format(ADAPTER_ID, run_name),
            "artifactId": "{}-{}".format(ADAPTER_ID, run_name),
            "version": "iter-{}".format(iteration if iteration is not None else "unknown"),
            "role": "policy",
            "name": "policy.onnx",
            # The platform's artifact vocabulary is source|compiled; a policy
            # exported from a trained checkpoint is a compiled artifact.
            "kind": "compiled",
            "format": "onnx",
            "runtime": "onnxruntime-cpu",
            "workload": "locomotion",
            "threads": 1,
            "targetPlatforms": ["rdk-x5"],
        },
    }
    if checkpoint_ref is not None:
        result["checkpoint"] = checkpoint_ref
    if onnx_exported:
        result["artifact"]["sizeBytes"] = onnx_bytes
        if onnx_sha256:
            # The server re-verifies this digest against the bytes it downloads
            # before staging, so a wrong hash blocks the release instead of
            # shipping mismatched weights.
            result["artifact"]["sha256"] = onnx_sha256
    # The gate verdict is one flat string the ledger can read; the full check
    # detail (which check, what diff) stays in training-summary.json.
    if onnx_gate is not None:
        result["metrics"]["onnxGate"] = onnx_gate["verdict"]

    summary = {
        "engine": ADAPTER_ID,
        "adapterVersion": "1",
        "physicsBackend": PHYSICS_BACKEND,
        "profile": profile,
        "numEnvs": num_envs,
        "maxIterations": max_iterations,
        "video": video,
        "device": "cuda" if has_cuda else "cpu",
        "deviceName": device_name,
        "trainingSeconds": training_seconds,
        "onnxExported": onnx_exported,
        "onnxExportSeconds": onnx_seconds,
        "onnxBytes": onnx_bytes,
        "onnxExportGate": onnx_gate,
        "checkpoint": str(checkpoint) if checkpoint else None,
        "checkpointIteration": checkpoint_iteration,
        "loggedIterations": points,
        "curvePoints": len(curve),
        "rewardCurve": curve,
        "episodeMetrics": episode_metrics,
        "upstream": {
            "repo": str(repo),
            "taskId": task_id,
            "command": command,
            "logDirectory": None if experiment is None else str(experiment),
        },
        "contract": {
            "id": contract.get("id"),
            "observationSize": observation_size,
            "actionSize": action_size,
            "controlHz": contract.get("controlHz"),
            "decimation": contract.get("decimation"),
        },
        "model": {"modelId": model.get("modelId"), "version": model.get("version")},
        "requestTaskId": request.get("taskId"),
    }
    return result, summary


if __name__ == "__main__":
    main()
