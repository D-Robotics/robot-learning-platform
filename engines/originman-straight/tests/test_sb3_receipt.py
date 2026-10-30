import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sb3_receipt import seal, verify


def test_preprocessing_and_action_basis_tampering_is_detected(tmp_path):
    (tmp_path / "model").mkdir()
    for name in [
        "policy.zip",
        "policy.onnx",
        "normalization.pkl",
        "normalization.json",
        "reference.npy",
        "experiment.json",
        "model/scene.xml",
        "foot-basis.npy",
    ]:
        (tmp_path / name).write_bytes(b"original")
    (tmp_path / "training-summary.json").write_text(json.dumps({"mode": "feet"}))
    assert seal(tmp_path)["verified"]
    for name in ["normalization.json", "foot-basis.npy", "model/scene.xml"]:
        (tmp_path / name).write_bytes(b"tampered")
    result = verify(tmp_path)
    assert not result["verified"]
    assert set(result["mismatches"]) == {
        "normalization.json",
        "foot-basis.npy",
        "model/scene.xml",
    }


def test_missing_preprocessing_cannot_be_sealed(tmp_path):
    (tmp_path / "training-summary.json").write_text(json.dumps({"mode": "joints"}))
    (tmp_path / "policy.zip").write_bytes(b"present")
    (tmp_path / "policy.onnx").write_bytes(b"present")
    with pytest.raises(ValueError, match="normalization.pkl"):
        seal(tmp_path)
