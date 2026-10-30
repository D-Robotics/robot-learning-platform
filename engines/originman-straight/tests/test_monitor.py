import json
import sys
from dataclasses import asdict
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard import Workspace
from env import Config
from monitor import (
    LearnerConfig,
    RunRecorder,
    config_diff,
    digest,
    parse_experiment,
    seal_run,
    verify_run,
)


def test_config_rejects_unknown_and_nonfinite_parameters():
    for data in [
        {"environment": {"typo": 1}},
        {"training": {"learning_rate": float("nan")}},
        {"training": {"iterations": True}},
        {"environment": {"control_dt": 0.019}},
        {"training": {"shell": "anything"}},
        {"environment": {"residual_scale": -1}},
    ]:
        with pytest.raises((ValueError, TypeError)):
            parse_experiment(data)
    env, learner, budget = parse_experiment(
        {"environment": {"lateral_weight": 20}, "training": {"iterations": 2}}
    )
    assert (
        env.lateral_weight == 20
        and budget["iterations"] == 2
        and learner.learning_rate > 0
    )


def test_run_is_immutable_and_evidence_detects_tampering(tmp_path):
    scene = tmp_path / "scene.xml"
    scene.write_text("<mujoco/>")
    out = tmp_path / "run"
    exp = {"environment": asdict(Config()), "training": asdict(LearnerConfig())}
    rec = RunRecorder(out, scene, exp)
    rec.trace(1, [{"x": 0.1, "jointPosition": [0] * 10}])
    rec.status("completed")
    rec.close()
    seal_run(out)
    assert verify_run(out)["verified"]
    identity = json.loads((out / "experiment.json").read_text())
    assert identity["sourceSha256"]["env.py"] == digest(out / "sources/env.py")
    with pytest.raises(FileExistsError):
        RunRecorder(out, scene, exp)
    (out / "traces/iter-00001.json").write_text("{}")
    assert verify_run(out)["mismatches"] == ["traces/iter-00001.json"]


def test_diff_keeps_parent_configuration_unchanged():
    before = {"environment": {"lateral_weight": 10}, "training": {"seed": 7}}
    after = {"environment": {"lateral_weight": 20}, "training": {"seed": 7}}
    assert config_diff(before, after) == [
        {"field": "environment.lateral_weight", "before": 10, "after": 20}
    ]
    assert before["environment"]["lateral_weight"] == 10


def test_workspace_rejects_paths_and_invalid_forks_before_launch(tmp_path):
    scene = tmp_path / "scene.xml"
    scene.write_text("<mujoco/>")
    w = Workspace(tmp_path / "runs", scene)
    for name in ["../escape", "a/b", "..", ""]:
        with pytest.raises(ValueError):
            w.path(name)
    for payload in [
        {"experiment": {"training": {"iterations": 0}}},
        {"experiment": {}, "scene": "/arbitrary/file"},
        {"experiment": {}, "checkpoint": "final"},
    ]:
        with pytest.raises((ValueError, TypeError)):
            w.fork(payload)
    assert not w.children
