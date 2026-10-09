#!/usr/bin/env python3
"""isaac-lab worker adapter — drives an upstream Isaac Lab workspace verbatim.

Runs inside the platform's local training worker: the worker writes
``RDK_SIM2REAL_REQUEST_FILE`` (the validated training request) and expects
``RDK_SIM2REAL_RESULT_FILE`` plus a job-local ``policy.onnx`` when the engine
produced a portable actor. This adapter reimplements no physics and no
training loop: it executes the upstream Isaac Lab pipeline — the same three
steps the RPO locomotion tutorial documents — under the platform contract:

    ./isaaclab.sh -p <train script>   --task=<TASK> --num_envs=<N> --max_iterations=<M>
    ./isaaclab.sh -p <play script>    --task=<TASK> --num_envs=1 --plane --checkpoint=<CKPT>
    ./isaaclab.sh -p <sim2sim script> --load_model=<CKPT>

The train/play/sim2sim script paths and the upstream task id come from the
task pack's ``isaacTask`` declaration, so a new upstream workspace is a task
pack edit, not an adapter edit.

Honesty rules this file follows (they are the platform's, not decoration):

* No Isaac Lab workspace (``RDK_ISAAC_LAB_ROOT`` unset or missing
  ``isaaclab.sh``) -> exit 3. The platform marks the task failed; it never
  reports a fabricated completed run and never falls back to a different
  physics backend.
* ``physicsBackend`` is ``"isaac-lab"`` only when the upstream trainer really
  ran; ``result.cuda`` is true only when the probe saw a CUDA device.
* ``deployable`` stays false. An upstream checkpoint for a robot this platform
  has no board runtime for is training/sim2sim evidence, never a release.
* The replay and sim2sim steps are recorded as first-class evidence (command,
  exit code, log tail) because interface agreement — observation construction
  and joint order mapping — is exactly what they are run to demonstrate. A
  failed sim2sim step fails the run's sim2sim verdict, not silently nothing.

Run it through the worker only:

  RDK_SIM2REAL_TRAIN_EXECUTABLE=<python>
  RDK_SIM2REAL_TRAIN_ARGS_JSON=["<abs>/engines/isaac-lab-adapter/adapter.py"]
  RDK_ISAAC_LAB_ROOT=<abs path to the Isaac Lab workspace>
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

ADAPTER_ID = "isaac-lab"
PHYSICS_BACKEND = "isaac-lab"
EXIT_MISSING_STACK = 3
EXIT_BAD_REQUEST = 2
EXIT_UPSTREAM_FAILURE = 4

MAX_HISTORY_FRAMES = 64


def stdout(line: str) -> None:
    print("[isaac-lab] " + str(line), flush=True)


def stderr(line: str) -> None:
    print("[isaac-lab] " + str(line), file=sys.stderr, flush=True)


def env_path(name: str) -> Path | None:
    raw = (os.environ.get(name) or "").strip()
    return Path(raw).expanduser().resolve() if raw else None


def clamp_int(value: object, low: int, high: int, fallback: int) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, parsed))


def sha256_of(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def find_workspace() -> Path | None:
    """The Isaac Lab workspace root: a directory with a runnable isaaclab.sh."""
    for candidate in (env_path("RDK_ISAAC_LAB_ROOT"), env_path("RDK_ISAAC_LAB_DIR")):
        if candidate and (candidate / "isaaclab.sh").is_file():
            return candidate
    for candidate in (Path.home() / "IsaacLab", Path("/opt/IsaacLab")):
        if (candidate / "isaaclab.sh").is_file():
            return candidate.resolve()
    return None


def isaac_task_of(request: dict) -> dict:
    """The pack's isaacTask declaration, or an empty dict."""
    task = request.get("task") if isinstance(request.get("task"), dict) else {}
    declaration = task.get("isaacTask")
    return declaration if isinstance(declaration, dict) else {}


def upstream_script(root: Path, declaration: dict, key: str) -> Path | None:
    raw = str(declaration.get(key) or "").strip()
    if not raw:
        return None
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = root / candidate
    return candidate.resolve()


def iteration_of(path: Path) -> int:
    match = re.search(r"model_(\d+)\.pt$", path.name)
    return int(match.group(1)) if match else -1


def newest_checkpoint(log_dir: Path) -> Path | None:
    candidates = [path for path in log_dir.rglob("model_*.pt") if path.is_file()]
    if not candidates:
        return None
    return max(candidates, key=iteration_of)


def run_streamed(command: list[str], cwd: Path, tag: str) -> tuple[int, str]:
    """Run one upstream command; return (exit code, full captured output)."""
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
    )
    assert process.stdout is not None
    for line in process.stdout:
        capture.append(line)
        sys.stdout.write(line if line.endswith("\n") else line + "\n")
    process.wait()
    return process.returncode, "".join(capture)


def cuda_available(python: str, cwd: Path) -> tuple[bool, str]:
    probe = subprocess.run(
        [
            python,
            "-c",
            "import torch;print(torch.cuda.is_available());"
            "print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'cpu')",
        ],
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


def parse_curve(output_tail: str) -> list[dict]:
    """Extract rsl_rl iteration blocks from the captured training output.

    Same block format the microduck-rl adapter parses (rsl_rl prints it on
    every revision this platform has run against); kept local so this adapter
    stays dependency-free beyond the upstream workspace itself.
    """
    ansi = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
    header = re.compile(r"Learning iteration\s+(\d+)\s*/\s*(\d+)")
    label = re.compile(r"([A-Za-z][A-Za-z /_-]{2,40}?):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)")
    points: list[dict] = []
    current: dict | None = None
    metrics: dict[str, float] = {}
    for raw_line in output_tail.splitlines():
        line = ansi.sub("", raw_line).strip()
        if not line:
            continue
        match = header.search(line)
        if match:
            if current is not None and "meanReward" in current:
                points.append(current)
            metrics = {}
            current = {
                "iteration": int(match.group(1)),
                "totalIterations": int(match.group(2)),
            }
            continue
        if current is None:
            continue
        for name, value in label.findall(re.sub(r"\s+", " ", line)):
            metrics[name.strip().lower()] = float(value)
        for key, target in (("mean reward", "meanReward"), ("mean total reward", "meanReward"),
                            ("mean episode length", "episodeLengthSteps")):
            if key in metrics and target not in current:
                current[target] = round(metrics[key], 4)
    if current is not None and "meanReward" in current:
        points.append(current)
    return points


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
    pack = request.get("task") if isinstance(request.get("task"), dict) else {}
    adapter_policy = ((pack.get("adapter") or {}).get("policy")) or {}
    observation_size = int(contract.get("observationSize", 0))
    action_size = int(contract.get("actionSize", 0))
    if observation_size <= 0 or action_size <= 0:
        raise ValueError("contract.observationSize and contract.actionSize are required")

    # The declared stacking arithmetic is part of the contract: the upstream
    # policy must consume exactly frames x frameWidth inputs. A mismatch means
    # the pack and the upstream task disagree — refuse instead of training a
    # policy the platform contract cannot describe.
    frame_width = int(adapter_policy.get("observationSize", 0))
    history = adapter_policy.get("observationHistory") or {}
    frames = int(history.get("frames", 1) or 1)
    history_order = str(history.get("order") or "oldest-first")
    if frames < 1 or frames > MAX_HISTORY_FRAMES:
        raise ValueError(
            "adapter policy.observationHistory.frames must be in [1, {}] (got {})".format(
                MAX_HISTORY_FRAMES, frames
            )
        )
    if history_order != "oldest-first":
        raise ValueError(
            "adapter policy.observationHistory.order must be 'oldest-first' (got {!r})".format(
                history_order
            )
        )
    if frame_width > 0 and observation_size != frame_width * frames:
        raise ValueError(
            "contract.observationSize {} != frameWidth {} x frames {}".format(
                observation_size, frame_width, frames
            )
        )

    declaration = isaac_task_of(request)
    upstream_task = str(declaration.get("upstreamTaskId") or "").strip()
    if not upstream_task:
        stderr(
            "[isaac-lab] REFUSED — the task pack declares no isaacTask.upstreamTaskId; "
            "the upstream task registry owns task definitions and this adapter will not "
            "guess one."
        )
        sys.exit(EXIT_BAD_REQUEST)

    workspace = find_workspace()
    isaaclab = workspace / "isaaclab.sh" if workspace else None
    if workspace is None or isaaclab is None:
        stderr(
            "[isaac-lab] REFUSED — Isaac Lab workspace not found "
            "(RDK_ISAAC_LAB_ROOT={}). Deploy it first:\n"
            "  git clone https://github.com/isaac-sim/IsaacLab ~/IsaacLab\n"
            "  cd ~/IsaacLab && ./isaaclab.sh --help   # requires Isaac Sim + CUDA\n"
            "  export RDK_ISAAC_LAB_ROOT=$HOME/IsaacLab\n"
            "This adapter never falls back to another physics backend and never "
            "fabricates a completed training run.".format(
                (os.environ.get("RDK_ISAAC_LAB_ROOT") or "").strip() or "<unset>"
            )
        )
        sys.exit(EXIT_MISSING_STACK)

    train_script = upstream_script(workspace, declaration, "train")
    if train_script is None or not train_script.is_file():
        stderr(
            "[isaac-lab] REFUSED — isaacTask.train ({}) is not a file under {}".format(
                declaration.get("train"), workspace
            )
        )
        sys.exit(EXIT_BAD_REQUEST)

    num_envs = clamp_int(training.get("numEnvs"), 1, 16_384, 64)
    max_iterations = clamp_int(training.get("maxIterations"), 1, 2_000_000, 5)
    profile = str(training.get("profile", "smoke"))
    python = shutil.which("python3") or sys.executable
    has_cuda, device_name = cuda_available(python, workspace)
    if not has_cuda:
        stdout(
            "no CUDA device visible — Isaac Lab training requires one; the run may fail"
        )

    steps: list[dict] = []

    def record_step(name: str, command: list[str], code: int, output: str) -> None:
        steps.append(
            {
                "step": name,
                "command": command,
                "exitCode": code,
                "logTail": output.strip()[-2000:],
            }
        )

    # ---- step 1: upstream training ----------------------------------------
    train_command = [
        str(isaaclab),
        "-p",
        str(train_script),
        "--task={}".format(upstream_task),
        "--num_envs={}".format(num_envs),
        "--max_iterations={}".format(max_iterations),
    ]
    train_code, train_output = run_streamed(train_command, workspace, "train")
    record_step("train", train_command, train_code, train_output)
    if train_code != 0:
        stderr(
            "[isaac-lab] upstream training failed (exit {}); no artifact is reported".format(
                train_code
            )
        )
        write_result(
            result_path,
            {
                "status": "failed",
                "engine": ADAPTER_ID,
                "taskId": upstream_task,
                "physicsBackend": PHYSICS_BACKEND,
                "deployable": False,
                "cuda": has_cuda,
                "metrics": {
                    "contractValid": True,
                    "observationSize": observation_size,
                    "actionSize": action_size,
                    "observationHistory": {"frames": frames, "order": history_order}
                    if frames > 1
                    else None,
                    "physicsBackend": PHYSICS_BACKEND,
                    "engine": ADAPTER_ID,
                    "cuda": has_cuda,
                    "failedStep": "train",
                },
                "steps": steps,
            },
        )
        sys.exit(EXIT_UPSTREAM_FAILURE)

    # ---- checkpoint discovery ---------------------------------------------
    checkpoint = newest_checkpoint(workspace / "logs")
    checkpoint_iteration = iteration_of(checkpoint) if checkpoint else None
    stdout(
        "checkpoint: {}".format(
            "{} (iteration {})".format(checkpoint.name, checkpoint_iteration)
            if checkpoint is not None
            else "none found under {}".format(workspace / "logs")
        )
    )

    # ---- step 2: in-engine replay (the tutorial's play.py) -----------------
    play_script = upstream_script(workspace, declaration, "play")
    if play_script is not None and checkpoint is not None:
        if play_script.is_file():
            play_command = [
                str(isaaclab),
                "-p",
                str(play_script),
                "--task={}".format(upstream_task),
                "--num_envs=1",
                "--plane",
                "--checkpoint={}".format(checkpoint),
            ]
            play_code, play_output = run_streamed(play_command, workspace, "play")
            record_step("play", play_command, play_code, play_output)
            stdout("replay (play.py) exit {}".format(play_code))
        else:
            record_step(
                "play", [str(play_script)], -1,
                "isaacTask.play is not a file under the workspace",
            )
            stdout("declared play script missing; replay evidence recorded as failed")
    else:
        stdout("no play script declared or no checkpoint; replay step skipped")

    # ---- step 3: sim2sim (the tutorial's MuJoCo cross-check) ---------------
    sim2sim_script = upstream_script(workspace, declaration, "sim2sim")
    if sim2sim_script is not None and checkpoint is not None:
        if sim2sim_script.is_file():
            sim2sim_command = [
                str(isaaclab),
                "-p",
                str(sim2sim_script),
                "--load_model={}".format(checkpoint),
            ]
            sim2sim_code, sim2sim_output = run_streamed(sim2sim_command, workspace, "sim2sim")
            record_step("sim2sim", sim2sim_command, sim2sim_code, sim2sim_output)
            stdout("sim2sim (MuJoCo cross-check) exit {}".format(sim2sim_code))
        else:
            record_step(
                "sim2sim", [str(sim2sim_script)], -1,
                "isaacTask.sim2sim is not a file under the workspace",
            )
            stdout("declared sim2sim script missing; cross-check evidence recorded as failed")
    else:
        stdout("no sim2sim script declared or no checkpoint; sim2sim step skipped")

    curve = parse_curve(train_output)
    sim2sim_step = next((step for step in steps if step["step"] == "sim2sim"), None)
    play_step = next((step for step in steps if step["step"] == "play"), None)

    result = {
        "status": "completed",
        "engine": ADAPTER_ID,
        "taskId": upstream_task,
        "physicsBackend": PHYSICS_BACKEND,
        "deployable": False,
        "cuda": has_cuda,
        "metrics": {
            "contractValid": True,
            "observationSize": observation_size,
            "actionSize": action_size,
            **(
                {"observationHistory": {"frames": frames, "order": history_order}}
                if frames > 1
                else {}
            ),
            "reward": curve[-1]["meanReward"] if curve else None,
            "iterations": (
                curve[-1]["iteration"] if curve else checkpoint_iteration
            ),
            "loggedIterations": len(curve),
            "checkpointIteration": checkpoint_iteration,
            "replayRan": bool(play_step),
            "replayExitCode": play_step["exitCode"] if play_step else None,
            "sim2simRan": bool(sim2sim_step),
            "sim2simExitCode": sim2sim_step["exitCode"] if sim2sim_step else None,
            "sim2simPassed": bool(sim2sim_step) and sim2sim_step["exitCode"] == 0,
            "physicsBackend": PHYSICS_BACKEND,
            "engine": ADAPTER_ID,
            "cuda": has_cuda,
        },
        "artifact": {
            "ref": "artifact://isaac-lab/{}/checkpoint".format(upstream_task),
            "artifactId": "isaac-lab-{}-policy".format(upstream_task),
            "version": "iter-{}".format(checkpoint_iteration if checkpoint_iteration is not None else "unknown"),
            "role": "policy",
            "name": checkpoint.name if checkpoint else "checkpoint",
            "kind": "compiled",
            "format": "checkpoint",
            "runtime": "isaac-lab",
            "workload": "locomotion",
        },
    }
    if checkpoint is not None:
        result["checkpoint"] = {
            "checkpointId": "isaac-lab-{}-iter{}".format(
                upstream_task, checkpoint_iteration if checkpoint_iteration is not None else 0
            ),
            "artifactRef": "artifact://isaac-lab/{}/{}".format(upstream_task, checkpoint.name),
            "iteration": checkpoint_iteration if checkpoint_iteration is not None else 0,
        }
        digest = sha256_of(checkpoint)
        if digest:
            result["artifact"]["sha256"] = digest

    summary = {
        "engine": ADAPTER_ID,
        "adapterVersion": "1",
        "physicsBackend": PHYSICS_BACKEND,
        "profile": profile,
        "numEnvs": num_envs,
        "maxIterations": max_iterations,
        "device": "cuda" if has_cuda else "cpu",
        "deviceName": device_name,
        "rewardCurve": curve,
        "observationHistory": {"frames": frames, "order": history_order, "frameSize": frame_width}
        if frames > 1
        else None,
        "upstream": {
            "workspace": str(workspace),
            "taskId": upstream_task,
            "trainScript": str(train_script),
            "playScript": str(play_script) if play_script else None,
            "sim2simScript": str(sim2sim_script) if sim2sim_script else None,
            "checkpoint": str(checkpoint) if checkpoint else None,
        },
        "steps": steps,
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
    with open(job_dir / "training-summary.json", "w") as handle:
        json.dump(summary, handle, indent=2)
    write_result(result_path, result)


if __name__ == "__main__":
    main()
