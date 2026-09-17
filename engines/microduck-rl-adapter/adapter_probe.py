#!/usr/bin/env python3
"""Deterministic probe for engines/microduck-rl-adapter/adapter.py.

Runs the adapter's pure contract surfaces (task mapping, the stdout reward
parser, the result payload builder, the missing-stack refusal) with no GPU, no
upstream checkout and no network, then prints one JSON document on stdout for
``scripts/verify-microduck-rl-adapter.mjs`` to assert against. Kept next to the
adapter because it imports it by path (the file is a worker script, not a
package module).
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADAPTER_PATH = HERE / "adapter.py"
GATE_PATH = HERE / "onnx_export_gate.py"

CONTRACT = {
    "id": "microduck-policy-v1",
    "robotId": "microduck",
    "jointCount": 14,
    "observationSize": 61,
    "actionSize": 14,
    "controlHz": 50,
    "physicsTimestepSeconds": 0.005,
    "decimation": 4,
}


def load_adapter(alias: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(alias, ADAPTER_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module


def load_gate():
    import importlib.util

    spec = importlib.util.spec_from_file_location("microduck_rl_onnx_export_gate_probe", GATE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IO:
    """Stand-in for onnxruntime IO metadata: only name + shape are read."""

    def __init__(self, name: str, shape: list):
        self.name = name
        self.shape = shape


def gate_pure_contract() -> dict:
    """Pin the gate's pure surfaces: classification, pairing, verdict assembly."""
    gate = load_gate()
    feedforward = gate.classify_graph(
        [IO("obs", ["batch", 61])], [IO("actions", ["batch", 14])]
    )
    lstm = gate.classify_graph(
        [IO("obs", [1, 61]), IO("h_in", [1, 1, 256]), IO("c_in", [1, 1, 256])],
        [IO("actions", [1, 14]), IO("h_out", [1, 1, 256]), IO("c_out", [1, 1, 256])],
    )
    initial_style = gate.classify_graph(
        [IO("obs", [1, 61]), IO("initial_h", [1, 1, 32])],
        [IO("actions", [1, 14]), IO("h", [1, 1, 32])],
    )
    rejections = {}
    for label, inputs, outputs in (
        (
            "twoObs",
            [IO("obs", [1, 61]), IO("obs2", [1, 61])],
            [IO("actions", [1, 14])],
        ),
        (
            "stateOneSide",
            [IO("obs", [1, 61]), IO("h_in", [1, 256])],
            [IO("actions", [1, 14])],
        ),
        (
            "ambiguousPair",
            [IO("obs", [1, 61]), IO("h_in", [1, 8])],
            [IO("actions", [1, 14]), IO("h_out", [1, 8]), IO("mystery", [1, 8])],
        ),
    ):
        try:
            gate.classify_graph(inputs, outputs)
            rejections[label] = "accepted"
        except ValueError as error:
            rejections[label] = str(error)[:60]
    verdicts = {
        "passed": gate.assemble_verdict(
            {"contract": {"ok": True}, "finiteness": {"ok": True}}
        ),
        "oneFailureFails": gate.assemble_verdict(
            {"contract": {"ok": True}, "sensitivity": {"ok": False, "reason": "constant graph"}}
        ),
        "noRuntimeSkips": gate.assemble_verdict({}),
    }
    return {
        "feedforward": feedforward,
        "lstm": lstm,
        "initialStyle": initial_style,
        "rejections": rejections,
        "verdicts": verdicts,
    }


def iteration_block(iteration: int, total: int, reward: float | None, length: float | None) -> str:
    """One rsl-rl 2.2.3 stdout block, ANSI escapes and padding included."""
    lines = [
        "#" * 80,
        # rich terminates the header with CRLF and the field labels with a
        # trailing CR, even when stdout is a pipe. The fixture reproduces that
        # byte-for-byte because it is exactly what broke the first parser.
        " \x1b[1m Learning iteration {}/{} \x1b[0m \r".format(iteration, total).center(80, " "),
        "",
        "{:>26} {:.0f} steps/s (collection: 0.910s, learning 0.331s)".format("Computation:", 41000.0),
        "{:>26} {:.4f}".format("Value function loss:", 0.1234),
        "{:>26} {:.4f}".format("Surrogate loss:", -0.0021),
        "{:>26} {:.2f}".format("Mean action noise std:", 1.00),
    ]
    if reward is not None:
        # mjlab 1.3.0 prints "Mean reward"; rsl-rl prints "Mean total reward".
        # The fixture uses the one this deployment actually emits.
        lines.append("{:>26} {:.2f}\r".format("Mean reward:", reward))
        lines.append("{:>26} {:.2f}\r".format("Mean episode length:", length or 0.0))
        lines.append("{:>26} {:.4f}\r".format("Episode_Termination/fell_over:", 2.3333))
    lines.append("{:>26} {:.4f}\r".format("Episode_Termination/fell_over:", 2.3333))
    lines += [
        "{:>26} {}".format("Total timesteps:", 819200),
        "{:>26} {:.2f}s".format("Iteration time:", 1.52),
        "{:>26} {:.2f}s".format("Total time:", 1.5 * iteration),
        "{:>26} {:.1f}s".format("ETA:", (total - iteration) * 1.5),
    ]
    # Every line ends CRLF, exactly like the real run's rich-rendered stdout.
    return "\r\n".join(lines) + "\r\n"


def parse_curve(module) -> dict:
    stream = "".join(
        iteration_block(iteration, 5, None if iteration == 0 else 3.1 * iteration,
                        None if iteration == 0 else 240.0 + 10.0 * iteration)
        for iteration in range(0, 6)
    )
    parser = module.StreamParser()
    captured = io.StringIO()
    with redirect_stdout(captured):
        # Chunk boundaries are deliberately hostile: they cut mid-line and
        # mid-ANSI-sequence, which is what the worker's pipes actually do.
        for offset in range(0, len(stream), 41):
            parser.feed(stream[offset : offset + 41])
        parser.flush()
    emitted = [line for line in captured.getvalue().splitlines() if "iter " in line]
    return {
        "points": parser.points,
        "episodeMetrics": parser.episode_metrics,
        "iterations": [point["iteration"] for point in parser.points],
        "lastReward": parser.last_reward,
        "lastEpisodeLength": parser.last_episode_length,
        "firstIterationWithoutReward": all(point["iteration"] != 0 for point in parser.points),
        "emittedLines": emitted,
    }


def build_payload(module, episode_metrics: dict | None = None) -> dict:
    request = {
        "schemaVersion": 1,
        "contractId": "microduck-policy-v1",
        "model": {"modelId": "microduck-official", "version": "upstream-browser"},
        "robot": {"id": "microduck", "variant": "legs"},
        "contract": CONTRACT,
        "taskId": "walk",
        "training": {"profile": "smoke", "numEnvs": 64, "maxIterations": 5, "video": False},
    }
    curve = [
        {
            "iteration": iteration,
            "totalIterations": 5,
            "meanReward": 3.1 * iteration,
            "episodeLengthSteps": 240.0 + 10.0 * iteration,
            "elapsedSeconds": 1.5 * iteration,
        }
        for iteration in range(1, 6)
    ]
    checkpoint = Path("logs/rsl_rl/velocity/2026-09-16_10-00-00_platform-smoke/model_1500.pt")
    gate_verdict = {
        "verdict": "passed",
        "checks": {"contract": True, "finiteness": True, "determinism": True, "sensitivity": True},
        "reasons": [],
    }
    result, summary = module.build_result(
        request=request,
        contract=CONTRACT,
        model=request["model"],
        profile="smoke",
        task_id="Mjlab-Velocity-Flat-MicroDuck",
        run_name="platform-smoke",
        num_envs=64,
        max_iterations=5,
        video=False,
        repo=Path("/root/microduck_rl"),
        experiment=checkpoint.parent,
        checkpoint=checkpoint,
        curve=curve,
        points=len(curve),
        episode_metrics=episode_metrics or {},
        has_cuda=True,
        device_name="NVIDIA GeForce RTX 5090",
        training_seconds=12.5,
        onnx_exported=True,
        onnx_bytes=123456,
        onnx_seconds=8.0,
        onnx_sha256="a" * 64,
        onnx_gate=gate_verdict,
        command=["uv", "run", "train", "Mjlab-Velocity-Flat-MicroDuck"],
    )
    return result, summary


def experiment_selection(module) -> dict:
    """Pin the before/after directory diff that keeps concurrent jobs apart."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "logs" / "rsl_rl" / "velocity"
        root.mkdir(parents=True)
        stale = root / "2026-09-16_09-00-00_other-job"
        stale.mkdir()
        (stale / "params").mkdir()
        (stale / "params" / "agent.yaml").write_text("logger: tensorboard\n")
        (stale / "model_0.pt").write_text("")
        os.utime(stale, (1_700_000_000, 1_700_000_000))
        # Snapshot exactly what a running job would snapshot before training.
        before = {str(path) for path in module.experiment_marker_dirs(root)}

        fresh = root / "2026-09-16_10-00-00_platform-smoke"
        (fresh / "params").mkdir(parents=True)
        (fresh / "params" / "agent.yaml").write_text("logger: tensorboard\n")
        # mjlab writes model_0.pt before the first step and then honours
        # save_interval, so "newest" must mean highest iteration, not newest mtime.
        (fresh / "model_0.pt").write_text("")
        (fresh / "model_4.pt").write_text("")
        os.utime(fresh, (1_800_000_000, 1_800_000_000))

        # A directory with no checkpoint at all (a crashed run) must report
        # "no checkpoint" rather than falling back to a sibling job's file.
        barren = root / "2026-09-16_10-30-00_crashed-job"
        barren.mkdir()

        selected = module.new_experiment_dir(root, before)
        checkpoint = module.newest_checkpoint(fresh)
        return {
            "markerDirs": len(module.experiment_marker_dirs(root)),
            "selectedFresh": selected is not None and selected.name == fresh.name,
            "selectedStaleWhenNothingNew": (
                module.new_experiment_dir(root, set()).name == fresh.name
            ),
            "checkpoint": checkpoint.name if checkpoint else None,
            "checkpointIteration": module.iteration_of(checkpoint) if checkpoint else None,
            "emptyDirHasNoCheckpoint": module.newest_checkpoint(barren) is None,
        }


def missing_stack_exit_code() -> tuple[int, bool]:
    """Run the real adapter with no upstream repo and no result file."""
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        request_path = work / "request.json"
        result_path = work / "result.json"
        request_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "contract": CONTRACT,
                    "taskId": "walk",
                    "training": {"profile": "smoke", "numEnvs": 64, "maxIterations": 5},
                }
            )
        )
        environment = {
            "PATH": "/nonexistent-bin",
            "HOME": str(work),
            "RDK_SIM2REAL_REQUEST_FILE": str(request_path),
            "RDK_SIM2REAL_RESULT_FILE": str(result_path),
            "RDK_SIM2REAL_JOB_DIR": str(work),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        completed = subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            env=environment,
            capture_output=True,
            text=True,
        )
        return completed.returncode, result_path.exists()


def main() -> None:
    module = load_adapter("microduck_rl_adapter_probe")
    curve = parse_curve(module)
    result, summary = build_payload(module, curve["episodeMetrics"])
    exit_code, wrote_result = missing_stack_exit_code()
    json.dump(
        {
            "taskIds": {
                "walk": module.resolve_task_id({"taskId": "walk"}),
                "kick": module.resolve_task_id({"taskId": "kick"}),
                "roughSit": module.resolve_task_id(
                    {"taskId": "sit", "training": {"terrain": "rough"}}
                ),
                "explicit": module.resolve_task_id(
                    {"taskId": "walk", "training": {"taskId": "Mjlab-Spin-Flat-MicroDuck"}}
                ),
                "unknown": module.resolve_task_id({"taskId": "teleport"}),
            },
            "progressLines": curve["emittedLines"],
            "progressIterations": curve["iterations"],
            "firstIterationWithoutReward": curve["firstIterationWithoutReward"],
            "lastReward": curve["lastReward"],
            "lastEpisodeLength": curve["lastEpisodeLength"],
            "result": result,
            "summary": summary,
            "experiments": experiment_selection(module),
            "exportCommand": module.export_command(
                "/usr/local/bin/uv",
                "Mjlab-Velocity-Flat-MicroDuck",
                Path("/repo/logs/rsl_rl/velocity/run/model_1500.pt"),
                Path("/job/policy.onnx"),
            ),
            "missingStackExitCode": exit_code,
            "missingStackWroteResult": wrote_result,
            "exportGate": gate_pure_contract(),
            "hasUv": bool(shutil.which("uv") or os.environ.get("RDK_MICRODUCK_RL_UV")),
            "ansiStripped": not re.search(r"\x1b", json.dumps(curve["emittedLines"])),
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
