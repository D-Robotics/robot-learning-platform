"""Declarative task specs: add an evaluation task by writing JSON, not Python.

The engine ships three task kinds (``ball-kick``, ``velocity``, ``hold``). Their
thresholds are physical constants a task author should be able to review and
change without touching code — and a new *task family* (basketball balancing,
a second ball, a goal shot) should start life as a spec file plus whatever the
simulator needs, not as a fork of this package.

A spec is validated strictly and fails closed: unknown kinds, unknown envelope
names, out-of-range thresholds and mistyped fields are errors, never silently
defaulted. Every value the spec sets ends up in the report's ``taskDefinition``
so a reader can check the units and the numbers the verdict was computed from.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .envelope import ENVELOPES, EvalEnvelope, InitialState, CommandProfile
from .tasks import BallKickTask, EpisodeOutcome, EpisodeTrace, VelocityTask

SPEC_SCHEMA_VERSION = 1

#: Fields a spec may override per envelope. Anything else is a typo and errors.
ENVELOPE_FIELDS = {
    "seed",
    "episodes",
    "episodeSeconds",
    "basePosJitter",
    "baseYawJitter",
    "ballDistance",
    "ballDistanceJitter",
    "ballLateralJitter",
    "commandDropout",
    "gyroNoiseStd",
    "payloadFraction",
    "twist",
    "headPose",
    "bodyPose",
    "notes",
}


class TaskSpecError(ValueError):
    """A spec that cannot be trusted to define a verdict."""


def _require(mapping: dict[str, Any], key: str, kind: type, where: str) -> Any:
    if key not in mapping:
        raise TaskSpecError(f"{where}: missing required field {key!r}")
    value = mapping[key]
    if kind is float and isinstance(value, int):
        value = float(value)
    if not isinstance(value, kind) or isinstance(value, bool) and kind is not bool:
        raise TaskSpecError(
            f"{where}: field {key!r} must be {kind.__name__}, got {type(value).__name__}"
        )
    return value


def _optional_number(mapping: dict[str, Any], key: str, where: str) -> float | None:
    if key not in mapping:
        return None
    value = mapping[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TaskSpecError(f"{where}: field {key!r} must be a number")
    return float(value)


def _bounded(value: float, low: float, high: float, name: str, where: str) -> float:
    if not low <= value <= high:
        raise TaskSpecError(f"{where}: {name} {value} is outside [{low}, {high}]")
    return value


@dataclass
class DeclarativeTask:
    """A task defined by a spec file rather than a class."""

    task_id: str
    kind: str
    display_name: str
    parameters: dict[str, float] = field(default_factory=dict)
    source: str = ""
    _judge: Any = None
    _definition: dict[str, Any] = field(default_factory=dict)

    @property
    def definition(self) -> dict[str, Any]:
        return self._definition

    def as_dict(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "displayName": self.display_name,
            "kind": self.kind,
            "source": self.source,
            **self._definition,
        }

    def judge(self, trace: EpisodeTrace, envelope: EvalEnvelope) -> EpisodeOutcome:
        if self._judge is None:  # pragma: no cover - build() always sets it
            raise TaskSpecError(f"task {self.task_id!r} has no judge")
        return self._judge(trace, envelope)


def _build_judge(kind: str, params: dict[str, float], where: str):
    if kind == "ball-kick":
        task = BallKickTask(
            min_ball_travel=params["minBallTravelM"],
            min_peak_ball_speed=params["minPeakBallSpeedMps"],
            fall_height=params["fallHeightM"],
            fall_tilt=params["fallTiltRad"],
        )
        return task.judge, task.definition
    if kind == "velocity":
        task = VelocityTask(
            speed_tolerance=params["speedToleranceMps"],
            min_forward=params["minForwardM"],
            fall_height=params["fallHeightM"],
            fall_tilt=params["fallTiltRad"],
            steady_window_start=params["steadyWindowStartS"],
        )
        return task.judge, task.definition
    if kind == "hold":
        fall_height = params["fallHeightM"]
        fall_tilt = params["fallTiltRad"]
        max_drift = params["maxDriftM"]

        def judge_hold(trace: EpisodeTrace, envelope: EvalEnvelope) -> EpisodeOutcome:
            """Hold position: the duck must neither fall nor wander.

            This is the honest reading of "standing" — it is what the runtime
            does between behaviours, and a policy that stands while sliding
            across the floor is not standing.
            """
            min_z = min(trace.base_z) if trace.base_z else 0.0
            tilt = max(
                [abs(value) for value in trace.body_pitch]
                + [abs(value) for value in trace.body_roll]
            ) if trace.body_pitch else 0.0
            start = trace.base_xy[0] if trace.base_xy else (0.0, 0.0)
            end = trace.base_xy[-1] if trace.base_xy else start
            drift = ((end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2) ** 0.5
            fell = min_z < fall_height or tilt > fall_tilt
            success = (not fell) and drift <= max_drift
            return EpisodeOutcome(
                success=success,
                fall=fell,
                collision=any(trace.ground_contact),
                reward=0.0,
                length_seconds=len(trace.base_z) * trace.dt,
                metrics={
                    "driftM": round(drift, 4),
                    "minBaseHeightM": round(min_z, 4),
                    "maxTiltRad": round(tilt, 4),
                },
            )

        return judge_hold, {
            "maxDriftM": max_drift,
            "fallHeightM": fall_height,
            "fallTiltRad": fall_tilt,
        }
    raise TaskSpecError(
        f"{where}: unknown task kind {kind!r}; known: ball-kick, velocity, hold"
    )


#: Required numeric parameters per kind, with the range each must fall inside.
KIND_PARAMETERS: dict[str, dict[str, tuple[float, float]]] = {
    "ball-kick": {
        "minBallTravelM": (0.0, 5.0),
        "minPeakBallSpeedMps": (0.0, 10.0),
        "fallHeightM": (0.0, 0.3),
        "fallTiltRad": (0.1, 3.14),
    },
    "velocity": {
        "speedToleranceMps": (0.0, 2.0),
        "minForwardM": (0.0, 10.0),
        "fallHeightM": (0.0, 0.3),
        "fallTiltRad": (0.1, 3.14),
        "steadyWindowStartS": (0.0, 60.0),
    },
    "hold": {
        "maxDriftM": (0.0, 2.0),
        "fallHeightM": (0.0, 0.3),
        "fallTiltRad": (0.1, 3.14),
    },
}


def parse_task_spec(payload: Any, *, source: str = "<memory>") -> tuple[DeclarativeTask, dict[str, EvalEnvelope]]:
    """Validate a spec and build the task plus its envelopes."""
    if not isinstance(payload, dict):
        raise TaskSpecError(f"{source}: spec must be a JSON object")
    where = source
    schema_version = payload.get("schemaVersion", SPEC_SCHEMA_VERSION)
    if schema_version != SPEC_SCHEMA_VERSION:
        raise TaskSpecError(
            f"{where}: schemaVersion {schema_version!r} is not supported "
            f"(this engine writes {SPEC_SCHEMA_VERSION})"
        )
    task_id = _require(payload, "id", str, where)
    if not task_id or len(task_id) > 64 or not all(c.isalnum() or c in "-_" for c in task_id):
        raise TaskSpecError(f"{where}: id {task_id!r} must be alphanumeric/underscore/hyphen")
    kind = _require(payload, "kind", str, where)
    if kind not in KIND_PARAMETERS:
        raise TaskSpecError(
            f"{where}: unknown task kind {kind!r}; known: {', '.join(sorted(KIND_PARAMETERS))}"
        )
    display_name = payload.get("displayName", task_id)
    if not isinstance(display_name, str):
        raise TaskSpecError(f"{where}: displayName must be a string")

    raw_params = payload.get("parameters", {})
    if not isinstance(raw_params, dict):
        raise TaskSpecError(f"{where}: parameters must be an object")
    expected = KIND_PARAMETERS[kind]
    unknown = sorted(set(raw_params) - set(expected))
    if unknown:
        raise TaskSpecError(
            f"{where}: parameters for kind {kind!r} got unknown key(s) {unknown}; "
            f"expected only {sorted(expected)}"
        )
    parameters: dict[str, float] = {}
    for name, (low, high) in expected.items():
        value = _optional_number(raw_params, name, f"{where}.parameters")
        if value is None:
            raise TaskSpecError(f"{where}.parameters: missing required {name!r} for kind {kind!r}")
        parameters[name] = _bounded(value, low, high, name, f"{where}.parameters")

    raw_envelopes = payload.get("envelopes")
    if not isinstance(raw_envelopes, dict) or not raw_envelopes:
        raise TaskSpecError(f"{where}: envelopes must be a non-empty object")
    envelopes: dict[str, EvalEnvelope] = {}
    for name, override in raw_envelopes.items():
        if name not in ENVELOPES:
            raise TaskSpecError(
                f"{where}: unknown envelope {name!r}; this engine ships {sorted(ENVELOPES)}"
            )
        envelopes[name] = _build_envelope(name, override, where)

    judge, definition = _build_judge(kind, parameters, where)
    task = DeclarativeTask(
        task_id=task_id,
        kind=kind,
        display_name=display_name,
        parameters=parameters,
        source=source,
        _judge=judge,
        _definition=definition,
    )
    return task, envelopes


def _build_envelope(name: str, override: Any, where: str) -> EvalEnvelope:
    base = ENVELOPES[name]
    if override is None:
        return base
    if not isinstance(override, dict):
        raise TaskSpecError(f"{where}.envelopes.{name}: must be an object")
    unknown = sorted(set(override) - ENVELOPE_FIELDS)
    if unknown:
        raise TaskSpecError(
            f"{where}.envelopes.{name}: unknown field(s) {unknown}; "
            f"expected only {sorted(ENVELOPE_FIELDS)}"
        )
    state = base.initial_state
    command = base.command

    def number(key: str, current: float, low: float, high: float) -> float:
        value = _optional_number(override, key, f"{where}.envelopes.{name}")
        if value is None:
            return current
        return _bounded(value, low, high, key, f"{where}.envelopes.{name}")

    base_pos_jitter = state.base_pos_jitter
    if "basePosJitter" in override:
        jitter = override["basePosJitter"]
        if (
            not isinstance(jitter, (list, tuple))
            or len(jitter) != 3
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in jitter)
        ):
            raise TaskSpecError(f"{where}.envelopes.{name}: basePosJitter must be 3 numbers")
        base_pos_jitter = (float(jitter[0]), float(jitter[1]), float(jitter[2]))
        if any(abs(v) > 1.0 for v in base_pos_jitter):
            raise TaskSpecError(f"{where}.envelopes.{name}: basePosJitter entries exceed ±1 m")

    def vector(key: str, current: tuple[float, ...], limit: float) -> tuple[float, ...]:
        if key not in override:
            return current
        values = override[key]
        if not isinstance(values, (list, tuple)) or len(values) != len(current):
            raise TaskSpecError(
                f"{where}.envelopes.{name}: {key} must be {len(current)} numbers"
            )
        out = []
        for value in values:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TaskSpecError(f"{where}.envelopes.{name}: {key} entries must be numbers")
            if abs(float(value)) > limit:
                raise TaskSpecError(
                    f"{where}.envelopes.{name}: {key} entry {value} exceeds ±{limit}"
                )
            out.append(float(value))
        return tuple(out)

    twist = vector("twist", (command.lin_vel_x, command.lin_vel_y, command.ang_vel_z), 5.0)
    new_state = InitialState(
        base_pos=state.base_pos,
        base_yaw=state.base_yaw,
        base_pos_jitter=base_pos_jitter,
        base_yaw_jitter=number("baseYawJitter", state.base_yaw_jitter, 0.0, 1.0),
        ball_distance=(
            None if state.ball_distance is None
            else number("ballDistance", state.ball_distance, 0.0, 5.0)
        ),
        ball_distance_jitter=number(
            "ballDistanceJitter", state.ball_distance_jitter, 0.0, 1.0
        ),
        ball_lateral_jitter=number("ballLateralJitter", state.ball_lateral_jitter, 0.0, 1.0),
    )
    notes = override.get("notes", base.notes)
    if not isinstance(notes, str):
        raise TaskSpecError(f"{where}.envelopes.{name}: notes must be a string")
    episodes = override.get("episodes", base.episodes)
    if isinstance(episodes, bool) or not isinstance(episodes, int) or not 1 <= episodes <= 100_000:
        raise TaskSpecError(
            f"{where}.envelopes.{name}: episodes must be an integer in [1, 100000]"
        )
    seed = override.get("seed", base.seed)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2_147_483_647:
        raise TaskSpecError(f"{where}.envelopes.{name}: seed must be a non-negative integer")
    return EvalEnvelope(
        name=name,
        seed=seed,
        episodes=episodes,
        episode_seconds=number("episodeSeconds", base.episode_seconds, 0.05, 600.0),
        initial_state=new_state,
        command=CommandProfile(
            lin_vel_x=twist[0],
            lin_vel_y=twist[1],
            ang_vel_z=twist[2],
            head_pose=vector("headPose", command.head_pose, 3.2),
            body_pose=vector("bodyPose", command.body_pose, 1.0),
        ),
        command_dropout=number("commandDropout", base.command_dropout, 0.0, 1.0),
        gyro_noise_std=number("gyroNoiseStd", base.gyro_noise_std, 0.0, 5.0),
        payload_fraction=number("payloadFraction", base.payload_fraction, 0.0, 1.0),
        notes=notes,
    )


def load_task_spec(path: str | Path) -> tuple[DeclarativeTask, dict[str, EvalEnvelope]]:
    spec_path = Path(path)
    if not spec_path.is_file():
        raise TaskSpecError(f"task spec not found: {spec_path}")
    try:
        payload = json.loads(spec_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise TaskSpecError(f"{spec_path}: invalid JSON: {error}") from error
    return parse_task_spec(payload, source=str(spec_path))


def spec_schema() -> dict[str, Any]:
    """A JSON Schema for editors and reviewers (the loader is the authority)."""
    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "MicroDuck evaluation task spec",
        "type": "object",
        "required": ["id", "kind", "parameters", "envelopes"],
        "additionalProperties": False,
        "properties": {
            "schemaVersion": {"const": SPEC_SCHEMA_VERSION},
            "id": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
            "kind": {"enum": sorted(KIND_PARAMETERS)},
            "displayName": {"type": "string", "maxLength": 120},
            "parameters": {
                "type": "object",
                "description": "Required numeric thresholds; see docs/task-specs.md",
            },
            "envelopes": {
                "type": "object",
                "minProperties": 1,
                "propertyNames": {"enum": sorted(ENVELOPES)},
                "additionalProperties": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {key: {} for key in sorted(ENVELOPE_FIELDS)},
                },
            },
        },
    }
