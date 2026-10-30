import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workshop import HERE, prepare, report, session


def test_classroom_configuration_is_frozen_and_runs_cannot_be_overwritten(tmp_path):
    scene = tmp_path / "scene.xml"
    scene.write_text("caller-owned scene placeholder for configuration test")
    out = tmp_path / "group-a"
    prepare(out, scene, steps=100000)
    with pytest.raises(FileExistsError):
        prepare(out, scene)
    config = json.loads((out / "experiment.json").read_text())
    config["environment"]["push_max_force"] = 7.5
    (out / "experiment.json").write_text(json.dumps(config))
    with pytest.raises(ValueError, match="configuration changed"):
        session(out)


def test_invalid_training_force_is_rejected_before_creating_workspace(tmp_path):
    scene = tmp_path / "scene.xml"
    scene.write_text("placeholder")
    for value in [float("nan"), float("inf"), 6.3, 9.1]:
        with pytest.raises(ValueError):
            prepare(tmp_path / "invalid", scene, push_max_force=value)
        assert not (tmp_path / "invalid").exists()


def test_report_keeps_unsuccessful_learning_and_rejects_false_gain(tmp_path):
    evaluation = tmp_path / "evaluation"
    evaluation.mkdir()
    plan = json.loads((HERE / "workshop/benchmark.json").read_text())
    (evaluation / "plan.json").write_text(json.dumps(plan))
    (evaluation / "evaluation-runtime.json").write_text("{}")
    modes = ["imu-feedback", "untrained", "rl", "rl-frozen-correction"]
    rows = [
        dict(
            case,
            controller=mode,
            recoverySuccess=case["force"] == 0,
            fallen=case["force"] != 0,
        )
        for case in plan["cases"]
        for mode in modes
    ]
    (evaluation / "episodes.jsonl").write_text(
        "\n".join(json.dumps(row) for row in rows)
    )
    summary = {
        "controllers": {mode: {"recoverySuccesses": 1, "falls": 30} for mode in modes},
        "improvementIndices": [],
        "regressionIndices": [],
        "clearGain": False,
    }
    (evaluation / "summary.json").write_text(json.dumps(summary))
    report(evaluation, tmp_path / "report")
    assert "未达到明显收益判据" in (tmp_path / "report/index.html").read_text()
    assert "<td>跌倒</td>" in (tmp_path / "report/index.html").read_text()
    summary["clearGain"] = True
    (evaluation / "summary.json").write_text(json.dumps(summary))
    with pytest.raises(ValueError, match="claimed learning gain"):
        report(evaluation, tmp_path / "false-report")
    assert not (tmp_path / "false-report").exists()
