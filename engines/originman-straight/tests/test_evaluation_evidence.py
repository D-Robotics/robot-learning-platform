"""Evaluation snapshots must expose source mutations independently of training."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluation_evidence import capture, finish


def test_evaluation_keeps_source_snapshot_and_rejects_mid_run_change(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    code = source / "env.py"
    code.write_text("original = True\n")
    scene = tmp_path / "scene.xml"
    scene.write_text("<mujoco/>")
    out = tmp_path / "evaluation"
    out.mkdir()
    capture(out, scene, source)
    finish(out, scene, source)
    assert (out / "runtime-sources/env.py").read_text() == "original = True\n"
    code.write_text("changed = True\n")
    with pytest.raises(RuntimeError, match="changed"):
        finish(out, scene, source)
    result = json.loads((out / "evaluation-runtime.json").read_text())
    assert result["changedSources"] == ["env.py"]
    assert not result["modelChangedDuringEvaluation"]
