"""Explicit policy training device selection; never silently falls back from CUDA."""
import torch


def resolve_training_device(requested="cuda"):
    if requested not in ("cuda", "cpu"):
        raise ValueError("training device must be cuda or cpu")
    result = {"requestedDevice": requested, "resolvedDevice": requested,
              "torchVersion": torch.__version__, "cudaRuntime": torch.version.cuda,
              "physicsBackend": "cpu-mujoco"}
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable; select CPU explicitly or repair GPU Worker")
        # Verify execution, not just driver discovery.
        value = torch.ones(1, device="cuda") * 2
        torch.cuda.synchronize()
        if value.item() != 2:
            raise RuntimeError("CUDA execution probe failed")
        result["gpuName"] = torch.cuda.get_device_name(torch.cuda.current_device())
    return result
