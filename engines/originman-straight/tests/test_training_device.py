import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from training_device import resolve_training_device


def test_default_cuda_refuses_cpu_fallback(monkeypatch):
    monkeypatch.setattr("torch.cuda.is_available", lambda: False)
    with pytest.raises(RuntimeError, match="CUDA requested but unavailable"):
        resolve_training_device()


def test_cpu_is_explicit_and_does_not_require_cuda(monkeypatch):
    monkeypatch.setattr("torch.cuda.is_available", lambda: False)
    assert resolve_training_device("cpu")["resolvedDevice"] == "cpu"
    with pytest.raises(ValueError):
        resolve_training_device("auto")
