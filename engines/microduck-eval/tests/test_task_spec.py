"""The shipped task specs must reproduce the built-in tasks exactly.

If a spec and the class it mirrors disagree, one of them is lying about what
"success" means — and the report would carry a threshold nobody is actually
judging against. These tests pin the equivalence, the strictness of the loader,
and the extensibility claim (a new task family with no Python changes).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from microduck_eval.envelope import ENVELOPES, NOMINAL
from microduck_eval.task_spec import (
    KIND_PARAMETERS,
    TaskSpecError,
    load_task_spec,
    parse_task_spec,
    spec_schema,
)
from microduck_eval.tasks import TASKS, BallKickTask, EpisodeTrace, VelocityTask

SPEC_DIR = Path(__file__).resolve().parents[1] / "task-specs"


def _payload(**overrides):
    base = {
        "schemaVersion": 1,
        "id": "spec-task",
        "kind": "hold",
        "parameters": {"maxDriftM": 0.05, "fallHeightM": 0.06, "fallTiltRad": 1.05},
        "envelopes": {"nominal": {"episodes": 5}},
    }
    base.update(overrides)
    return base


def _trace(*, base_z, base_x, steps=200, dt=0.02):
    """`base_z` is a scalar height (held for the episode), `base_x` a position list."""
    trace = EpisodeTrace(dt=dt)
    for step in range(steps):
        trace.base_z.append(base_z)
        x = base_x[step] if step < len(base_x) else base_x[-1]
        trace.base_xy.append((x, 0.0))
        trace.body_pitch.append(0.0)
        trace.body_roll.append(0.0)
        trace.ball_xy.append((0.0, 0.0))
        trace.ball_z.append(0.035)
        trace.ground_contact.append(False)
    return trace


def test_shipped_ball_kick_spec_matches_the_builtin_task():
    task, envelopes = load_task_spec(SPEC_DIR / "ball-kick.json")
    builtin = BallKickTask()
    assert task.task_id == builtin.task_id
    for key, value in builtin.definition.items():
        assert task.definition[key] == pytest.approx(value), f"threshold {key} drifted"
    assert set(envelopes) == {"nominal", "hard"}
    for name, envelope in envelopes.items():
        base = ENVELOPES[name]
        assert envelope.seed == base.seed
        assert envelope.episodes == base.episodes
        assert envelope.initial_state.ball_distance == pytest.approx(
            base.initial_state.ball_distance
        )
        assert envelope.command_dropout == base.command_dropout
        assert envelope.gyro_noise_std == base.gyro_noise_std
        assert envelope.payload_fraction == base.payload_fraction


def test_shipped_walking_spec_matches_the_builtin_task():
    task, envelopes = load_task_spec(SPEC_DIR / "walking-velocity.json")
    builtin = VelocityTask()
    assert task.task_id == builtin.task_id
    for key, value in builtin.definition.items():
        assert task.definition[key] == pytest.approx(value), f"threshold {key} drifted"
    # The walking envelope must ask for the rated forward speed, otherwise
    # "standing still" would be judged as a valid way to pass a walking task.
    assert envelopes["nominal"].command.lin_vel_x == pytest.approx(0.4)
    assert envelopes["hard"].command.lin_vel_x == pytest.approx(0.4)


def test_a_spec_verdict_is_the_same_verdict_as_the_builtin():
    """Same trace, same thresholds ⇒ same boolean, from either entry point."""
    spec_task, envelopes = load_task_spec(SPEC_DIR / "ball-kick.json")
    builtin = BallKickTask()
    envelope = envelopes["nominal"]
    upright = 0.118
    kicked = [0.0] * 60 + [0.05 * index for index in range(140)]
    trace = _trace(base_z=upright, base_x=[0.0] * 200)
    trace.ball_xy = [(value, 0.0) for value in kicked]
    spec_outcome = spec_task.judge(trace, envelope)
    builtin_outcome = builtin.judge(trace, envelopes["nominal"])
    assert spec_outcome.success == builtin_outcome.success is True
    assert spec_outcome.metrics["ballTravelM"] == builtin_outcome.metrics["ballTravelM"]


def test_a_new_task_family_needs_no_python():
    """`hold` is not a built-in class: it exists only as a spec."""
    assert "duck-stand" not in TASKS
    task, envelopes = load_task_spec(SPEC_DIR / "duck-stand.json")
    assert task.kind == "hold"
    assert task.task_id == "duck-stand"
    # Standing still with no drift passes; a 30 cm slide does not.
    envelope = envelopes["nominal"]
    still = _trace(base_z=0.118, base_x=[0.0] * 200)
    assert task.judge(still, envelope).success is True
    sliding = _trace(base_z=0.118, base_x=[0.0015 * index for index in range(200)])
    outcome = task.judge(sliding, envelope)
    assert outcome.success is False
    assert outcome.metrics["driftM"] > envelope.initial_state.base_pos_jitter[0]
    fallen = _trace(base_z=0.03, base_x=[0.0] * 200)
    assert task.judge(fallen, envelope).success is False


@pytest.mark.parametrize(
    "payload,needle",
    [
        (_payload(schemaVersion=99), "schemaVersion"),
        (_payload(id="../escape"), "id"),
        (_payload(kind="basketball"), "unknown task kind"),
        (_payload(parameters={"maxDrift": 0.1}), "unknown key"),
        (
            _payload(parameters={"maxDriftM": 0.05, "fallHeightM": 0.06}),
            "missing required",
        ),
        (_payload(parameters={"maxDriftM": 5.0, "fallHeightM": 0.06, "fallTiltRad": 1.0}), "outside"),
        (_payload(envelopes={"nominal": {"episodeSeconds": 900.0}}), "outside"),
        (_payload(envelopes={"nominal": {"episodes": 0}}), "episodes"),
        (_payload(envelopes={"impossible": {}}), "unknown envelope"),
        (_payload(envelopes={"nominal": {"nopeField": 1}}), "unknown field"),
        (_payload(envelopes={"nominal": {"twist": [0.4]}}), "must be 3 numbers"),
        (_payload(envelopes={"nominal": {"twist": [99.0, 0.0, 0.0]}}), "exceeds"),
        (_payload(envelopes={"nominal": {"notes": 5}}), "notes must be a string"),
        (_payload(envelopes={}), "non-empty"),
    ],
)
def test_specs_fail_closed_on_anything_ambiguous(payload, needle):
    with pytest.raises(TaskSpecError) as error:
        parse_task_spec(payload, source="<test>")
    assert needle in str(error.value)


def test_missing_file_is_an_error_not_a_default():
    with pytest.raises(TaskSpecError):
        load_task_spec(SPEC_DIR / "does-not-exist.json")


def test_invalid_json_reports_the_file():
    bad = SPEC_DIR / ".." / "task-specs" / "ball-kick.json"
    text = bad.read_text(encoding="utf-8")
    broken = Path(bad.parent) / "__broken.json"
    broken.write_text(text[:-5], encoding="utf-8")
    try:
        with pytest.raises(TaskSpecError) as error:
            load_task_spec(broken)
        assert "invalid JSON" in str(error.value)
    finally:
        broken.unlink()


def test_schema_document_covers_every_kind_and_envelope():
    schema = spec_schema()
    assert schema["properties"]["kind"]["enum"] == sorted(KIND_PARAMETERS)
    assert schema["properties"]["envelopes"]["propertyNames"]["enum"] == sorted(ENVELOPES)
    # Every shipped spec validates against its own schema shape (keys at least).
    for path in sorted(SPEC_DIR.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["kind"] in KIND_PARAMETERS, path.name
        assert set(payload["envelopes"]) <= set(ENVELOPES), path.name
        assert NOMINAL.name in ENVELOPES
