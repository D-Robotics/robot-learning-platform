"""Produce an eval report in the shape the platform gate already reads.

The top-level keys (``taskId`` / ``adapterId`` / ``trained`` / ``baseline`` /
``qualityGate`` / ``seed`` / ``controlLatencyMs``) are exactly the ones
``shared/task-evaluation.ts`` normalizes, so a report from here flows into the
existing fail-closed quality gate with no new plumbing. MicroDuck needs a few
extra facts before a rate means anything, and those live under
``dynamicsFacts`` — see ``docs/eval-report-contract.md``.
"""

from __future__ import annotations

import argparse
import json
import platform
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np

from .envelope import ENVELOPES, EvalEnvelope
from .metrics import EnvelopeResult, EpisodeResult, aggregate, harness_qualification
from .sim import CONTROL_HZ, MicroDuckSim, find_scene, rollout, servo_order_matches
from .tasks import TASKS, Task

SCHEMA_VERSION = 1


class ZeroPolicy:
    """Constant zero action = hold the default pose. The honest floor a learned
    policy must beat, and the check that the harness can report a failure."""

    path = "builtin:zero-action"
    sha256 = "0" * 64
    observation_size = 61
    action_size = 14

    def act(self, observation: np.ndarray) -> np.ndarray:  # noqa: ARG002
        return np.zeros(14, dtype=np.float32)

    def reset(self) -> None:
        """Feed-forward by construction: nothing to reset."""

    def facts(self) -> dict[str, object]:
        return {"recurrent": False, "stateInputs": [], "stateOutputs": []}


def _evaluate_envelope(
    *,
    task: Task,
    envelope: EvalEnvelope,
    policy,
    model_root: str,
    action_scale: float,
    with_ball: bool,
    command: np.ndarray,
    actuator_model: str,
    kp: float | None,
    force_ceiling: float | None,
    scene: "SceneSpec | None" = None,
) -> EnvelopeResult:
    spec = scene or find_scene(model_root, with_ball=with_ball)
    # One sim per envelope, not per episode: rollout() resets data (and the
    # payload mass) itself, so recompiling the MJCF 50 times for a 60 s
    # endurance envelope would only add compile time to the measurement.
    sim = MicroDuckSim(
        spec,
        action_scale=action_scale,
        actuator_model=actuator_model,
        kp=kp,
        force_ceiling=force_ceiling,
    )
    result = EnvelopeResult(envelope=envelope)
    for episode_index in range(envelope.episodes):
        trace = rollout(sim, policy, envelope, command, episode_index=episode_index)
        outcome = task.judge(trace, envelope)
        result.episodes.append(
            EpisodeResult(
                index=episode_index,
                outcome=outcome,
                seed=envelope.seed + episode_index * 7919,
            )
        )
    return result


def _q(value: str) -> str:
    return value.strip().strip("'\"")


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    # A task spec lets an author define thresholds and envelopes in JSON; the
    # built-in tasks stay available so the specs can be regression-checked
    # against them (see tests/test_task_spec.py).
    spec_envelopes: dict[str, EvalEnvelope] | None = None
    spec_source: str | None = None
    if getattr(args, "task_spec", None):
        from .task_spec import load_task_spec

        try:
            task, spec_envelopes = load_task_spec(args.task_spec)
        except ValueError as error:
            raise SystemExit(str(error)) from error
        spec_source = str(args.task_spec)
    else:
        if args.task not in TASKS:
            raise SystemExit(f"unknown task {args.task!r}; known: {', '.join(sorted(TASKS))}")
        task = TASKS[args.task]
    with_ball = task.task_id == "ball-kick"

    if args.policy:
        from .policy import load_policy

        policy = load_policy(args.policy)
        policy_path, policy_sha = policy.path, policy.sha256
    else:
        policy = ZeroPolicy()
        policy_path, policy_sha = policy.path, policy.sha256

    # The baseline column: the zero-action floor by default (the harness
    # qualification reads it), or a reference policy — the previous release,
    # an upstream checkpoint, a community export — so "better than what" is a
    # number in the report instead of a claim in the README.
    if args.baseline_policy:
        from .policy import load_policy

        baseline_policy = load_policy(args.baseline_policy)
        baseline_policy_facts = {
            "path": baseline_policy.path,
            "sha256": baseline_policy.sha256,
            **baseline_policy.facts(),
        }
    else:
        baseline_policy = ZeroPolicy()
        baseline_policy_facts = {
            "path": baseline_policy.path,
            "sha256": baseline_policy.sha256,
            **baseline_policy.facts(),
        }

    catalogue = spec_envelopes if spec_envelopes is not None else ENVELOPES
    if getattr(args, "task_spec", None) and args.envelopes == "nominal,hard":
        envelope_names = list(catalogue)
    else:
        envelope_names = [name.strip() for name in args.envelopes.split(",") if name.strip()]
    unknown = [name for name in envelope_names if name not in catalogue]
    if unknown:
        raise SystemExit(f"unknown envelope(s) {unknown}; known: {', '.join(sorted(catalogue))}")

    per_envelope_episodes = args.episodes
    started = time.time()
    trained_results: list[EnvelopeResult] = []
    baseline_results: list[EnvelopeResult] = []
    latencies: list[float] = []

    for name in envelope_names:
        envelope = catalogue[name]
        if per_envelope_episodes:
            envelope = replace(envelope, episodes=per_envelope_episodes)
        command = np.asarray(envelope.command.as_vector(), dtype=np.float32)
        trained_results.append(
            _evaluate_envelope(
                task=task,
                envelope=envelope,
                policy=policy,
                model_root=args.model_root,
                action_scale=args.action_scale,
                with_ball=with_ball,
                command=command,
                actuator_model=args.actuator_model,
                kp=args.kp,
                force_ceiling=args.force_ceiling,
            )
        )
        if not args.no_baseline:
            baseline_results.append(
                _evaluate_envelope(
                    task=task,
                    envelope=envelope,
                    policy=baseline_policy,
                    model_root=args.model_root,
                    action_scale=args.action_scale,
                    with_ball=with_ball,
                    command=command,
                    actuator_model=args.actuator_model,
                    kp=args.kp,
                    force_ceiling=args.force_ceiling,
                )
            )
        latencies.append(time.time() - started)

    confidence = args.confidence
    trained = aggregate(trained_results, confidence)
    baseline = aggregate(baseline_results, confidence) if baseline_results else None

    nominal = trained["envelopes"].get("nominal") or next(iter(trained["envelopes"].values()))
    criteria = {
        "minSuccessRate": args.min_success_rate,
        "maxCollisionRate": args.max_collision_rate,
        "gateOn": args.gate_on,
    }
    gate_value = (
        nominal.get("successRateCiLow", 0.0)
        if args.gate_on == "ciLowerBound"
        else nominal.get("successRate", 0.0)
    )
    errors: list[str] = []
    if gate_value < args.min_success_rate:
        errors.append(
            f"success rate {gate_value:.4f} ({args.gate_on}) is below the required "
            f"{args.min_success_rate:.4f}"
        )
    if nominal.get("collisionRate", 0.0) > args.max_collision_rate:
        errors.append(
            f"collision rate {nominal['collisionRate']:.4f} exceeds the allowed "
            f"{args.max_collision_rate:.4f}"
        )
    if not trained["envelopes"]:
        errors.append("no evaluation envelope produced metrics")
    qualification = harness_qualification(
        baseline_results,
        trained_results if args.trusted_policy else None,
    )
    if not qualification["passed"]:
        # Fail closed: an unqualified harness cannot certify anything, no matter
        # how good the trained numbers look.
        errors.extend(f"harness unqualified: {reason}" for reason in qualification["reasons"])

    spec = find_scene(args.model_root, with_ball=with_ball)
    probe = MicroDuckSim(
        spec, actuator_model=args.actuator_model, kp=args.kp, force_ceiling=args.force_ceiling
    )
    order_ok = servo_order_matches(probe)
    report: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "taskId": task.task_id,
        "adapterId": args.adapter_id,
        "observationAdapterId": args.observation_adapter_id,
        "trained": trained,
        **({"baseline": baseline} if baseline else {}),
        "qualityGate": {
            "passed": not errors,
            "errors": errors,
            "criteria": criteria,
        },
        "seed": catalogue[envelope_names[0]].seed,
        "controlLatencyMs": round(1000.0 * sum(latencies) / max(1, len(latencies)), 3),
        # This is a simulated CPU step, not an inference figure; the stage keeps
        # it from being read as a control-loop budget on hardware.
        "measurementStage": "sim-step",
        "harnessQualification": qualification,
        "dynamicsFacts": {
            "dynamics": "cpu-mujoco",
            "actuator": "mjcf-position" if args.actuator_model == "mjcf" else "bam-voltage-port",
            "actuatorFacts": probe.actuator_facts,
            "bamAvailable": args.actuator_model == "bam",
            "simulator": f"mujoco-{_mujoco_version()}",
            "python": platform.python_version(),
            "scene": spec.xml.name,
            "sceneSha256": _file_sha256(spec.xml),
            "policy": policy_path,
            "policySha256": policy_sha,
            "policyFacts": policy.facts(),
            "baselinePolicy": baseline_policy_facts,
            "actionScale": args.action_scale,
            "controlHz": CONTROL_HZ,
            "jointOrderVerified": order_ok,
            "taskDefinition": task.as_dict(),
            **({"taskSpec": spec_source} if spec_source else {}),
            "envelopeNames": envelope_names,
            "parallelEnvs": 1,
            "notes": (
                "CPU single-environment MuJoCo rollout with the MJCF position actuators. "
                "The upstream trainer uses mjlab/MuJoCo Warp with the BAM servo model; "
                "rates from the two dynamics are not interchangeable."
            ),
        },
    }
    return report


def _mujoco_version() -> str:
    import mujoco

    return getattr(mujoco, "__version__", "unknown")


def _file_sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MicroDuck task-level evaluation (CPU MuJoCo)")
    parser.add_argument("--task", default="ball-kick", choices=sorted(TASKS))
    parser.add_argument(
        "--task-spec",
        default=None,
        help="JSON task spec (see docs/task-specs.md); overrides --task and its envelopes",
    )
    parser.add_argument("--policy", default=None, help="exported ONNX policy; omit for the zero-action baseline")
    parser.add_argument(
        "--baseline-policy",
        dest="baseline_policy",
        default=None,
        help="reference ONNX for the baseline column (default: zero-action floor)",
    )
    parser.add_argument("--model-root", required=True, help="path to a microduck_rl checkout")
    parser.add_argument("--out", default="-", help="output path for eval-report.json ('-' = stdout)")
    parser.add_argument("--envelopes", default="nominal,hard")
    parser.add_argument("--episodes", type=int, default=0, help="override episodes per envelope")
    parser.add_argument("--action-scale", type=float, default=1.0)
    parser.add_argument("--confidence", type=float, default=0.95)
    parser.add_argument("--min-success-rate", type=float, default=0.70)
    parser.add_argument("--max-collision-rate", type=float, default=0.10)
    parser.add_argument("--gate-on", choices=["point", "ciLowerBound"], default="ciLowerBound")
    parser.add_argument("--adapter-id", default="microduck-cpu-eval")
    parser.add_argument("--observation-adapter-id", dest="observation_adapter_id",
                        default="microduck-61d-v1")
    parser.add_argument("--no-baseline", action="store_true")
    parser.add_argument(
        "--trusted-policy",
        action="store_true",
        help="the evaluated ONNX is a real training artifact, so a unanimous failure "
        "is evidence about the harness rather than the policy",
    )
    parser.add_argument(
        "--actuator-model",
        choices=["mjcf", "bam"],
        default="mjcf",
        help="mjcf = calibrated position actuator (default); bam = XL330 voltage-control port",
    )
    parser.add_argument("--kp", type=float, default=None,
                        help="override the calibrated position stiffness (mjcf model only)")
    parser.add_argument("--force-ceiling", type=float, default=None,
                        help="override the torque ceiling in N.m (mjcf model only)")
    parser.add_argument("--json-indent", type=int, default=2)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_report(args)
    payload = json.dumps(report, ensure_ascii=False, indent=args.json_indent, sort_keys=False)
    if args.out == "-":
        print(payload)
    else:
        Path(args.out).write_text(payload + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
