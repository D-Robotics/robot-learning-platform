import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("gymnasium")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workshop_adapter import config, source_training


def request():
    return {
        "schemaVersion": 1,
        "taskId": "originman-recovery",
        "accountId": "alice",
        "model": {"modelId": "originman", "version": "v1"},
        "contract": {
            "id": "custom-policy-originman-recovery-v1",
            "observationSize": 14,
            "actionSize": 2,
            "jointCount": 20,
            "controlHz": 50,
            "physicsTimestepSeconds": 0.001,
            "decimation": 20,
        },
        "training": {
            "engine": "originman-recovery",
            "algorithm": "sac",
            "numEnvs": 4,
            "originmanWorkshop": {
                "phase": "train",
                "timesteps": 500000,
                "seed": 7,
                "pushMaxForce": 8.1,
            },
        },
    }


def test_old_contract_and_changed_control_timing_are_rejected():
    value = request()
    assert config(value)["timesteps"] == 500000
    value["contract"]["observationSize"] = 41
    with pytest.raises(ValueError, match="dedicated"):
        config(value)
    value = request()
    value["contract"].update(controlHz=100, physicsTimestepSeconds=0.0005)
    with pytest.raises(ValueError, match="50Hz"):
        config(value)


def test_source_cannot_escape_job_root_or_reuse_another_account(tmp_path):
    target = tmp_path / "new-job"
    target.mkdir()
    value = request()
    options = dict(
        config(value),
        phase="evaluate",
        sourceRunId="source-run",
        sourceExternalRunId="../other-job",
    )
    with pytest.raises(ValueError):
        source_training(target, value, options)
    parent = tmp_path / "other-job"
    parent.mkdir()
    other = request()
    other["accountId"] = "bob"
    (parent / "request.json").write_text(json.dumps(other))
    (parent / "job.json").write_text(json.dumps({"status": "completed"}))
    options["sourceExternalRunId"] = "other-job"
    with pytest.raises(ValueError, match="not owned"):
        source_training(target, value, options)
