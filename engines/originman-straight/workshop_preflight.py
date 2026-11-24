"""Read-only OriginMan training environment probe; does not submit a run.

The caller supplies its own adapted scene. Output deliberately excludes paths,
credentials and device details; a passed probe is not a training or safety claim.
"""
import argparse
import importlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def verify_environment(scene, experiment, modules):
    """Reset and step the residual training environment without training."""
    cfg = importlib.import_module("env").Config(**experiment["environment"])
    if cfg.recovery_roll_threshold:
        raise ValueError("training requires continuous feedback")
    env = importlib.import_module("residual_env").ResidualStandingGym(scene, cfg, seed=0)
    try:
        observation, _ = env.reset(seed=0)
        if not env.observation_space.contains(observation):
            raise ValueError("reset observation violates training contract")
        if not modules["numpy"].isfinite(observation).all():
            raise ValueError("reset observation is not finite")
        if env.action_space.shape != (2,):
            raise ValueError("unexpected training action shape")
        action = modules["numpy"].zeros(2, dtype=modules["numpy"].float32)
        observation, reward, terminated, truncated, info = env.step(action)
        if (not env.observation_space.contains(observation)
                or not modules["numpy"].isfinite(observation).all()
                or not modules["numpy"].isfinite(reward)
                or not isinstance(terminated, (bool, modules["numpy"].bool_))
                or not isinstance(truncated, (bool, modules["numpy"].bool_))
                or not isinstance(info, dict)):
            raise ValueError("simulation step violates training contract")
    finally:
        env.close()


def inspect(scene, device):
    checks = []
    modules = {}

    def record(name, status, detail):
        checks.append({"id": name, "status": status, "detail": detail})

    for name in ("numpy", "mujoco", "torch", "stable_baselines3", "gymnasium"):
        try:
            modules[name] = importlib.import_module(name)
            record("dependency-" + name, "passed", "module import succeeded")
        except Exception:
            record("dependency-" + name, "blocked", "module could not be imported")

    if all(name in modules for name in ("numpy", "mujoco", "torch", "stable_baselines3", "gymnasium")):
        try:
            for name in ("residual_env", "standing_sac", "workshop_adapter"):
                importlib.import_module(name)
            if os.environ.get("RDK_ORIGINMAN_PREFLIGHT_ENGINE") == "originman-recovery-reflect":
                name = "equivariant_sac"
                importlib.import_module(name)
            record("training-entrypoint", "passed", "training and evaluation modules import successfully")
        except Exception:
            record("training-entrypoint", "blocked", "training or evaluation modules could not be imported")
    else:
        record("training-entrypoint", "unverified", "training dependencies are unavailable")

    try:
        root = Path(__file__).resolve().parent
        experiment = json.loads((root / "experiments" / "standing-residual.json").read_text())
        benchmark = json.loads((root / "workshop" / "benchmark.json").read_text())
        if not isinstance(experiment.get("environment"), dict) or not isinstance(benchmark, dict):
            raise ValueError("invalid training configuration")
        record("training-config", "passed", "training and benchmark configurations readable")
    except Exception:
        record("training-config", "blocked", "training or benchmark configuration unavailable")

    try:
        if not scene or not os.path.isfile(scene):
            raise ValueError("missing scene")
        mj = modules.get("mujoco")
        if mj is None:
            record("scene-contract", "unverified", "MuJoCo unavailable")
        else:
            model = mj.MjModel.from_xml_path(scene)
            if model.nu != 20 or model.njnt != 21:
                raise ValueError("unexpected model dimensions")
            required = ("l_hip_roll", "l_hip_pitch", "l_knee", "l_ank_pitch", "l_ank_roll", "r_hip_roll", "r_hip_pitch", "r_knee", "r_ank_pitch", "r_ank_roll")
            if any(mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT, name) < 0 for name in required):
                raise ValueError("required joints absent")
            if any(mj.mj_name2id(model, mj.mjtObj.mjOBJ_ACTUATOR, name) < 0 for name in required):
                raise ValueError("required actuators absent")
            for side in ("l", "r"):
                stem = side + "_ank_roll_link"
                if mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY, stem) < 0:
                    raise ValueError("foot body absent")
                if mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE, stem + "_foot_frame") < 0 and mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM, stem + "_collision") < 0:
                    raise ValueError("foot reference absent")
            record("scene-contract", "passed", "20 actuators, 21 joints and required leg names verified")
    except Exception:
        record("scene-contract", "blocked", "scene missing, unreadable, or contract invalid")

    entrypoint = next(c for c in checks if c["id"] == "training-entrypoint")
    config_check = next(c for c in checks if c["id"] == "training-config")
    scene_check = next(c for c in checks if c["id"] == "scene-contract")
    if all(c["status"] == "passed" for c in (entrypoint, config_check, scene_check)):
        try:
            verify_environment(scene, experiment, modules)
            entrypoint["detail"] = "training modules imported and residual environment reset and step verified"
        except Exception:
            entrypoint.update(status="blocked", detail="training environment initialization, reset or step failed")
    elif entrypoint["status"] == "passed":
        entrypoint.update(status="unverified", detail="training environment reset and step not verified")

    torch = modules.get("torch")
    if device == "cpu":
        record("training-device", "passed" if torch else "unverified", "CPU selected" if torch else "PyTorch unavailable")
    elif torch is None:
        record("training-device", "unverified", "PyTorch unavailable")
    else:
        try:
            ready = bool(torch.cuda.is_available() and torch.cuda.device_count() > 0)
            if ready:
                # Exercise the requested device rather than relying on a build flag.
                ready = bool((torch.ones(1, device="cuda") + 1).cpu().item() == 2)
            record("training-device", "passed" if ready else "blocked", "CUDA allocation verified" if ready else "CUDA unavailable")
        except Exception:
            record("training-device", "blocked", "CUDA allocation failed")
    return {"schemaVersion": 1, "engine": os.environ.get("RDK_ORIGINMAN_PREFLIGHT_ENGINE", "originman-recovery-reflect"), "taskId": "originman-recovery", "device": device,
            "checkedAt": datetime.now(timezone.utc).isoformat(), "trainingPerformed": False,
            "readyForSmokeTraining": all(c["status"] == "passed" for c in checks), "checks": checks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene", default=os.environ.get("ORIGINMAN_SCENE", ""))
    parser.add_argument("--device", choices=("cpu", "cuda"), default=os.environ.get("RDK_ORIGINMAN_PREFLIGHT_DEVICE"), required=not bool(os.environ.get("RDK_ORIGINMAN_PREFLIGHT_DEVICE")))
    args = parser.parse_args()
    print(json.dumps(inspect(args.scene, args.device), separators=(",", ":")))


if __name__ == "__main__":
    main()
