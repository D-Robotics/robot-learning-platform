import importlib.util
from pathlib import Path
import os
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

spec = importlib.util.spec_from_file_location("originman_preflight", Path(__file__).resolve().parents[1] / "preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def test_preflight_missing_scene_and_wrong_task_never_report_ready():
    result = preflight.inspect(task_id="walk", scene="")
    assert result["readyForSmokeTraining"] is False
    assert result["trainingPerformed"] is False and result["hardwareEligible"] is False
    assert {x["id"] for x in result["checks"] if x["status"] == "blocked"} >= {"robot-assets", "task-registry"}


def test_preflight_real_scene_imports_physics_and_onnx_without_creating_runs(monkeypatch):
    monkeypatch.setenv("ORIGINMAN_TRAIN_DEVICE", "cpu")
    import pytest
    scene = os.environ.get("ORIGINMAN_SCENE")
    if not scene:
        pytest.skip("caller-owned scene required")
    result = preflight.inspect(task_id="originman-recovery", scene=scene)
    assert result["readyForSmokeTraining"] is True, result
    assert len(result["checks"]) == 7
    assert result["trainingPerformed"] is False and result["hardwareEligible"] is False
