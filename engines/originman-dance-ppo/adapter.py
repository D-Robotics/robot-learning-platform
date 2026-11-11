#!/usr/bin/env python3
"""Platform file-protocol adapter for the OriginMan dance PPO engine."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import traceback

import mujoco
import numpy as np
import onnx
import torch

from dance_env import ConfigurableChoreography, validate_dance_config
from asset_provenance import verified_sha256, verify_joint_names
from train import train, _json_default

ENGINE_ID = "originman-dance-ppo"


def fail(message):
    print(f"[{ENGINE_ID}] REFUSED: {message}", file=sys.stderr, flush=True)
    raise SystemExit(3)


def read_request():
    path = os.environ.get("RDK_SIM2REAL_REQUEST_FILE")
    if not path:
        fail("RDK_SIM2REAL_REQUEST_FILE is not set")
    try:
        value = json.loads(Path(path).read_text())
    except Exception as exc:
        fail(f"cannot read worker request: {exc}")
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        fail("worker request must be a schemaVersion 1 object")
    return value


def validate_bundle(bundle: Path):
    if not bundle.is_absolute() or bundle.is_symlink() or not bundle.is_dir():
        fail("RDK_ORIGINMAN_DANCE_BUNDLE_DIR must name an absolute, real directory")
    for root, directories, files in os.walk(bundle, followlinks=False):
        for name in directories + files:
            if (Path(root) / name).is_symlink():
                fail("model bundle cannot contain symlinks")
    required = [
        bundle / "model" / "scene.xml",
        bundle / "model" / "model-manifest.json",
        bundle / "model" / "meshes",
        bundle / "reference.npy",
    ]
    missing = [path.relative_to(bundle).as_posix() for path in required if not path.exists()]
    if missing:
        fail("model bundle is incomplete: " + ", ".join(missing))
    try:
        manifest = json.loads(required[1].read_text())
        if not isinstance(manifest, dict) or manifest.get("floatingBase") is not True:
            fail("model manifest must describe a floating-base OriginMan")
        if len(manifest.get("joints", [])) != 20:
            fail("model manifest must list exactly 20 OriginMan joints")
        expected_scene = manifest.get("sceneSha256")
        try:
            actual_scene = verified_sha256(required[0], expected_scene, "scene.xml")
        except (OSError, ValueError) as exc:
            fail(str(exc))
        source_scene = manifest.get("sourceSceneSha256")
        if not isinstance(source_scene, str) or not re.fullmatch(r"[a-f0-9]{64}", source_scene):
            fail("model manifest sourceSceneSha256 is missing or malformed")
        mesh_hashes = manifest.get("meshSha256")
        if not isinstance(mesh_hashes, dict) or len(mesh_hashes) < 20:
            fail("model manifest must contain SHA256 identities for the OriginMan meshes")
        for name, digest in mesh_hashes.items():
            if Path(name).name != name or not re.fullmatch(r"[a-f0-9]{64}", str(digest)):
                fail("model manifest contains an unsafe mesh path or malformed digest")
            mesh = required[2] / name
            if not mesh.is_file() or hashlib.sha256(mesh.read_bytes()).hexdigest() != digest:
                fail(f"mesh integrity check failed for {name}")
        with required[3].open("rb") as stream:
            reference = np.load(stream, allow_pickle=False)
        if reference.size == 0 or not np.isfinite(reference).all():
            fail("reference.npy is empty or contains non-finite values")
        model = mujoco.MjModel.from_xml_path(str(required[0]))
        if model.nu != 20:
            fail(f"MuJoCo scene must expose 20 actuators (found {model.nu})")
        scene_actuator_joints = [
            mujoco.mj_id2name(
                model,
                mujoco.mjtObj.mjOBJ_JOINT,
                int(model.actuator_trnid[index, 0]),
            )
            for index in range(model.nu)
        ]
        try:
            verify_joint_names(manifest["joints"], scene_actuator_joints)
        except ValueError as exc:
            fail(str(exc))
        env = ConfigurableChoreography(bundle, {
            "schemaVersion": 1,
            "title": "bundle-probe",
            "bpm": 110,
            "sections": [
                {"type": "alternating-arms", "beats": 8, "intensity": 0.7},
                {"type": "weight-shift", "beats": 8, "intensity": 0.5},
                {"type": "squat-rise", "beats": 8, "intensity": 0.6},
                {"type": "open-pose", "beats": 8, "intensity": 0.5},
            ],
            "seed": 7,
            "trainingSteps": 8192,
        })
        if env.action_space.shape != (18,) or env.observation_space.shape != (78,):
            fail(
                "dance policy contract changed unexpectedly: expected 78 observations and 18 actions, "
                f"probe returned {env.observation_space.shape[0]} observations and {env.action_space.shape[0]} actions"
            )
        env.close()
    except SystemExit:
        raise
    except Exception as exc:
        fail(f"model bundle probe failed: {type(exc).__name__}: {exc}")
    return {
        "manifest": manifest,
        "sceneSha256": actual_scene,
        "sceneHashMatchesManifest": True,
        "sceneMatchesSourceSceneSha256": actual_scene == source_scene,
        "verifiedMeshCount": len(mesh_hashes),
    }


class OnnxablePolicy(torch.nn.Module):
    def __init__(self, policy):
        super().__init__()
        self.policy = policy

    def forward(self, observation):
        return self.policy._predict(observation, deterministic=True)


def write_onnx(checkpoint: Path, path: Path, observation_size: int):
    from stable_baselines3 import PPO

    model = PPO.load(checkpoint, device="cpu")
    wrapper = OnnxablePolicy(model.policy).eval()
    sample = torch.zeros((1, observation_size), dtype=torch.float32)
    torch.onnx.export(
        wrapper,
        sample,
        path,
        input_names=["observation"],
        output_names=["action"],
        opset_version=17,
        dynamo=False,
    )
    graph = onnx.load(path)
    onnx.checker.check_model(graph)
    input_size = int(graph.graph.input[0].type.tensor_type.shape.dim[-1].dim_value)
    output_size = int(graph.graph.output[0].type.tensor_type.shape.dim[-1].dim_value)
    if (input_size, output_size) != (observation_size, 18):
        fail(f"ONNX contract mismatch: expected {observation_size}->18, got {input_size}->{output_size}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_manifest(directory: Path):
    excluded = {"request.json", "result.json", "SHA256SUMS"}
    entries = []
    for path in sorted(directory.iterdir()):
        if path.name in excluded or not path.is_file() or path.is_symlink():
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        entries.append(f"{digest}  {path.name}")
    if not entries:
        fail("engine generated no artifacts")
    (directory / "SHA256SUMS").write_text("\n".join(entries) + "\n")


def main():
    request = read_request()
    bundle_value = os.environ.get("RDK_ORIGINMAN_DANCE_BUNDLE_DIR", "").strip()
    if not bundle_value:
        fail("OriginMan model bundle is not mounted on this worker")
    bundle = Path(bundle_value)
    model_bundle = validate_bundle(bundle)
    model_manifest = model_bundle["manifest"]
    task = request.get("task")
    if not isinstance(task, dict) or task.get("id") != "originman-dance":
        fail("request.task.id must be originman-dance")
    try:
        dance_config = validate_dance_config(task.get("originmanDance"))
    except Exception as exc:
        fail(str(exc))
    training = request.get("training") if isinstance(request.get("training"), dict) else {}
    num_envs = training.get("numEnvs", 4)
    if isinstance(num_envs, bool) or not isinstance(num_envs, int) or not 1 <= num_envs <= 16:
        fail("training.numEnvs must be an integer from 1 to 16")
    contract = request.get("contract") if isinstance(request.get("contract"), dict) else {}
    expected_observation_size = 78
    if (contract.get("observationSize"), contract.get("actionSize")) != (expected_observation_size, 18):
        fail(
            f"request contract must match this choreography: {expected_observation_size} observations and 18 actions"
        )
    output_value = os.environ.get("RDK_SIM2REAL_JOB_DIR")
    result_value = os.environ.get("RDK_SIM2REAL_RESULT_FILE")
    if not output_value or not result_value:
        fail("worker output paths are not set")
    output = Path(output_value)
    result_path = Path(result_value)
    if not output.is_absolute() or not result_path.is_absolute() or not output.is_dir():
        fail("worker output paths must be absolute and the job directory must exist")

    report = train(bundle=bundle, output=output, dance_config=dance_config, num_envs=num_envs)
    onnx_path = output / "policy.onnx"
    policy_sha = write_onnx(output / "final.zip", onnx_path, expected_observation_size)
    report["policySha256"] = policy_sha
    report["modelBundle"] = {
        "sceneSha256": model_bundle["sceneSha256"],
        "manifestSourceSceneSha256": model_manifest["sourceSceneSha256"],
        "sceneHashMatchesManifest": model_bundle["sceneHashMatchesManifest"],
        "sceneMatchesSourceSceneSha256": model_bundle["sceneMatchesSourceSceneSha256"],
        "verifiedMeshCount": model_bundle["verifiedMeshCount"],
        "hardwareEligible": False,
    }
    (output / "training-summary.json").write_text(
        json.dumps(report, indent=2, allow_nan=False, default=_json_default) + "\n"
    )

    run_id = os.environ.get("RDK_SIM2REAL_JOB_ID", "originman-dance-run")
    quality = report["qualityGate"]
    artifact_ref = f"artifact://{ENGINE_ID}/{run_id}/policy.onnx"
    checkpoint_ref = f"artifact://{ENGINE_ID}/{run_id}/final.zip"
    dance_evaluations = []
    for row in report["evaluations"]:
        sections = []
        for section in row["sectionResults"]:
            measurements = {
                key: value
                for key, value in section.items()
                if key not in {"index", "type", "beats", "clean", "stylePassed", "passed"}
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
            }
            sections.append({
                "type": section["type"],
                "beats": section["beats"],
                "clean": section["clean"],
                "stylePassed": section["stylePassed"],
                "passed": section["passed"],
                "measurements": measurements,
            })
        dance_evaluations.append({
            "bpm": row["bpm"],
            "completed": row["completed"],
            "failed": row["failed"],
            "allSectionsPassed": row["allSectionsPassed"],
            "maxTiltDeg": row["maxTiltDeg"],
            "sections": sections,
        })
    result = {
        "status": "completed",
        "engine": ENGINE_ID,
        "taskId": "originman-dance",
        "physicsBackend": "cpu-mujoco",
        "deployable": False,
        "hardwareEligible": False,
        "cuda": report["trainingDevice"].startswith("cuda"),
        "checkpoint": {
            "checkpointId": f"originman-dance-{run_id}-steps{report['trainedSteps']}",
            "artifactRef": checkpoint_ref,
            "iteration": report["rolloutIterations"],
        },
        "artifact": {
            "artifactId": f"originman-dance-policy-{run_id}",
            "artifactRef": artifact_ref,
            "ref": artifact_ref,
            "version": f"steps-{report['trainedSteps']}",
            "role": "policy",
            "name": "policy.onnx",
            "kind": "compiled",
            "format": "onnx",
            "runtime": "onnxruntime-cpu",
            "workload": "humanoid-dance",
            "threads": 1,
            "sha256": policy_sha,
            "deployable": False,
        },
        "metrics": {
            "contractValid": True,
            "engine": ENGINE_ID,
            "taskId": "originman-dance",
            "observationSize": expected_observation_size,
            "actionSize": 18,
            "iterations": report["rolloutIterations"],
            "trainingSteps": report["trainedSteps"],
            "optimizerSteps": report["optimizerSteps"],
            "trainingSeconds": report["trainingSeconds"],
            "trainingDevice": report["trainingDevice"],
            "trainingDeviceName": report["trainingDeviceName"],
            "runtimeVersions": report["runtimeVersions"],
            "physicsBackend": "cpu-mujoco",
            "qualityGate": quality,
            "originmanDance": {
                "qualityGatePassed": quality["passed"],
                "evaluations": dance_evaluations,
                "replay": report.get("replay"),
                "sceneProvenance": {
                    "sceneSha256": model_bundle["sceneSha256"],
                    "manifestSourceSceneSha256": model_manifest["sourceSceneSha256"],
                    "sceneHashMatchesManifest": model_bundle["sceneHashMatchesManifest"],
                    "sceneMatchesSourceSceneSha256": model_bundle["sceneMatchesSourceSceneSha256"],
                    "verifiedMeshCount": model_bundle["verifiedMeshCount"],
                },
            },
            "danceConfig": dance_config,
            "evaluationBpms": [row["bpm"] for row in report["evaluations"]],
        },
    }
    write_manifest(output)
    result_path.write_text(
        json.dumps(result, indent=2, allow_nan=False, default=_json_default) + "\n"
    )
    print(
        json.dumps(
            {
                "event": "dance-training-finished",
                "trainedSteps": report["trainedSteps"],
                "qualityGatePassed": quality["passed"],
                "deployable": False,
            },
            allow_nan=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[{ENGINE_ID}] ERROR: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1)
