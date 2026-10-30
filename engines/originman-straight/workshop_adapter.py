"""Native local-worker adapter: separate real training and paired simulation evaluation."""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from monitor import digest, write_json
from residual_evaluate import evaluate
from sb3_receipt import verify
from workshop import prepare

HERE = Path(__file__).resolve().parent


def config(request):
    training = request.get("training", {})
    value = training.get("originmanWorkshop", {})
    if (
        request.get("schemaVersion") != 1
        or request.get("taskId") != "originman-recovery"
        or training.get("engine") != "originman-recovery"
        or training.get("algorithm") != "sac"
        or training.get("numEnvs") != 4
    ):
        raise ValueError("expected OriginMan SAC workshop request")
    contract = request.get("contract", {})
    if contract.get("id") != "custom-policy-originman-recovery-v1" or (
        contract.get("observationSize"),
        contract.get("actionSize"),
    ) != (14, 2):
        raise ValueError("expected dedicated 14D -> 2D recovery contract")
    if any(
        contract.get(k) != v
        for k, v in {
            "jointCount": 20,
            "controlHz": 50,
            "physicsTimestepSeconds": 0.001,
            "decimation": 20,
        }.items()
    ):
        raise ValueError("expected the frozen 50Hz recovery contract")
    if value.get("phase") not in ("train", "evaluate"):
        raise ValueError("invalid workshop phase")
    for key, low, high in [("timesteps", 4096, 1000000), ("seed", 0, 1000000)]:
        if type(value.get(key)) is not int or not low <= value[key] <= high:
            raise ValueError("invalid workshop budget or seed")
    if (
        type(value.get("pushMaxForce")) not in (float, int)
        or not 6.4 <= value["pushMaxForce"] <= 9
    ):
        raise ValueError("invalid training disturbance range")
    return value


def train_session(session):
    # Preserve original stdout and additionally emit the worker's live-progress protocol.
    command = [
        sys.executable,
        str(HERE / "workshop.py"),
        "train",
        "--workspace",
        str(session),
    ]
    child = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    dev_fraction = None
    try:
        for line in child.stdout:
            print(line, end="", flush=True)
            check = re.search(
                r"\[standing-sac-validation\] \d+ steps reference=\d+/9 RL=(\d+)/9",
                line,
            )
            if check:
                dev_fraction = int(check[1]) / 9
            point = re.search(
                r"steps=(\d+)/(\d+) reward=(-?[\d.]+) elapsed=([\d.]+)s", line
            )
            if point and dev_fraction is not None:
                print(
                    f"[originman-workshop] iter {point[1]}/{point[2]} meanReward={point[3]} recentSuccess={dev_fraction:.6f} elapsed={point[4]}s",
                    flush=True,
                )
        if child.wait() != 0:
            raise RuntimeError("workshop training failed; original log retained")
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)


def source_training(job_dir, request, value):
    external = value.get("sourceExternalRunId", "")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}", external):
        raise ValueError("server-resolved source worker run required")
    parent = (job_dir.parent / external).resolve()
    if parent.parent != job_dir.parent.resolve() or parent == job_dir.resolve():
        raise ValueError("invalid source job")
    source_request = json.loads((parent / "request.json").read_text())
    source_job = json.loads((parent / "job.json").read_text())
    source_config = config(source_request)
    if (
        source_job.get("status") != "completed"
        or source_config["phase"] != "train"
        or source_request.get("accountId") != request.get("accountId")
        or source_request.get("model") != request.get("model")
    ):
        raise ValueError(
            "source training is not completed or not owned by this account/model"
        )
    for key in ["seed", "timesteps", "pushMaxForce"]:
        if source_config[key] != value[key]:
            raise ValueError("evaluation must use the source training configuration")
    run = parent / "workshop" / f"standing-residual-seed{value['seed']}"
    if not verify(run)["verified"]:
        raise ValueError("source training receipt mismatch")
    return run


def comparison(run, evaluation, out, value):
    summary = json.loads((evaluation / "summary.json").read_text())
    rows = [
        json.loads(s) for s in (evaluation / "episodes.jsonl").read_text().splitlines()
    ]
    groups = {
        name: [r for r in rows if r["controller"] == name]
        for name in [
            "reference",
            "imu-feedback",
            "untrained",
            "rl",
            "rl-frozen-correction",
        ]
    }
    index = summary["improvementIndices"][0] if summary["improvementIndices"] else 3
    chosen = [
        groups[name][index] for name in ["reference", "imu-feedback", "untrained", "rl"]
    ]
    basis = np.load(run / "foot-basis.npy", allow_pickle=False)[0]
    scale = json.loads((run / "training-summary.json").read_text())["config"][
        "residual_scale"
    ]
    traces = []
    for row in chosen:
        points = []
        for f in row["frames"]:
            modes = np.linalg.lstsq(
                basis, np.asarray(f["residualExecuted"]), rcond=None
            )[0]
            base = np.asarray(f.get("baseFeedback", [0, 0]))
            points.append(
                [
                    f["time"],
                    f["tiltDegrees"],
                    float((modes[0] - base[0]) * scale),
                    float((modes[1] - base[1]) * scale),
                ]
            )
        traces.append({"controller": row["controller"], "frames": points})
    result = {
        "sourceRunId": value["sourceRunId"],
        "baselineRecovered": summary["controllers"]["imu-feedback"][
            "recoverySuccesses"
        ],
        "rlRecovered": summary["controllers"]["rl"]["recoverySuccesses"],
        "clearGain": summary["clearGain"],
        "normalStanding": summary["controllers"]["rl"]["normalStanding"],
        "cases": [
            {
                "index": i,
                "force": a["force"],
                "start": a["start"],
                "baseline": a["recoverySuccess"],
                "initial": groups["untrained"][i]["recoverySuccess"],
                "rl": groups["rl"][i]["recoverySuccess"],
                "frozen": groups["rl-frozen-correction"][i]["recoverySuccess"],
                "fallen": groups["rl"][i]["fallen"],
            }
            for i, a in enumerate(groups["imu-feedback"])
        ],
        "selectedCase": index,
        "traces": traces,
    }
    paired = out / "video-records"
    paired.mkdir()
    (paired / "episodes.jsonl").write_text(
        "\n".join(json.dumps(r) for r in chosen) + "\n"
    )
    # Render in a separate process: an unavailable graphics backend must not destroy numeric evidence.
    try:
        script = "from standing_render import render; import sys; render(sys.argv[1],__import__('pathlib').Path(sys.argv[2]),__import__('pathlib').Path(sys.argv[3]),0,sys.argv[4] or None)"
        args = [
            sys.executable,
            "-c",
            script,
            str(run / "model/scene.xml"),
            str(paired),
            str(out / "comparison.mp4"),
            os.environ.get("ORIGINMAN_RENDER_FONT", ""),
        ]
        subprocess.run(args, cwd=HERE, check=True, timeout=180)
        video = out / "comparison.mp4"
        if not 0 < video.stat().st_size <= 20000000:
            raise ValueError("comparison video exceeds bound")
        result["video"] = {"sha256": digest(video), "bytes": video.stat().st_size}
    except (subprocess.SubprocessError, OSError, ValueError):
        result["videoError"] = "本次物理回放渲染不可用；数值对照和原始轨迹已保留。"
    return result


def main():
    request = json.loads(Path(os.environ["RDK_SIM2REAL_REQUEST_FILE"]).read_text())
    result_file = Path(os.environ["RDK_SIM2REAL_RESULT_FILE"]).resolve()
    out = result_file.parent
    value = config(request)
    if request.get("resumeFrom"):
        raise ValueError("workshop does not support arbitrary resume references")
    if value["phase"] == "train":
        scene = Path(os.environ["ORIGINMAN_SCENE"]).resolve()
        session = out / "workshop"
        prepare(
            session, scene, value["seed"], value["timesteps"], value["pushMaxForce"]
        )
        train_session(session)
        run = session / f"standing-residual-seed{value['seed']}"
    else:
        run = source_training(out, request, value)
    summary = json.loads((run / "training-summary.json").read_text())
    evidence = {
        "schemaVersion": 1,
        "phase": value["phase"],
        "seed": value["seed"],
        "requestedTimesteps": value["timesteps"],
        "actualTimesteps": summary["actualTimesteps"],
        "pushMaxForce": value["pushMaxForce"],
        "policySha256": digest(run / "policy.onnx"),
        "hardwareEligible": False,
    }
    if value["phase"] == "evaluate":
        plan = json.loads((run.parent / "benchmark.json").read_text())
        plan["plannedRuns"] = [run.name]
        write_json(out / "benchmark.json", plan)
        evaluate(run, out / "benchmark.json", out / "evaluation")
        evidence.update(comparison(run, out / "evaluation", out, value))
    shutil.copyfile(run / "policy.onnx", out / "policy.onnx")
    write_json(out / "workshop-result.json", evidence)
    write_json(
        out / "source-evidence.json",
        {
            "trainingReceiptSha256": digest(run / "sb3-evidence.json"),
            "trainingSummarySha256": digest(run / "training-summary.json"),
            "adapterSha256": digest(Path(__file__)),
            "scope": "simulation only; not hardware evidence",
        },
    )
    names = ["policy.onnx", "workshop-result.json", "source-evidence.json"]
    if "video" in evidence:
        names.append("comparison.mp4")
    (out / "SHA256SUMS").write_text("".join(f"{digest(out / n)}  {n}\n" for n in names))
    identity = os.environ["RDK_SIM2REAL_JOB_ID"]
    result = {
        "status": "completed",
        "engine": "originman-recovery",
        "mock": False,
        "cuda": False,
        "deployable": False,
        "hardwareEligible": False,
        "metrics": {
            "contractValid": True,
            "observationSize": 14,
            "actionSize": 2,
            "physicsBackend": "cpu-mujoco",
            "engine": "originman-recovery",
            "iterations": summary["actualTimesteps"],
            "originmanWorkshop": evidence,
        },
        "checkpoint": {
            "checkpointId": identity,
            "artifactRef": f"artifact://originman-recovery/{identity}/policy.onnx",
            "iteration": summary["actualTimesteps"],
        },
        "artifact": {
            "artifactId": identity,
            "ref": f"artifact://originman-recovery/{identity}/policy.onnx",
            "name": "policy.onnx",
            "format": "onnx",
            "role": "calibration",
            "kind": "source",
            "workload": "locomotion",
            "targetPlatforms": [],
            "deployable": False,
            "sizeBytes": (out / "policy.onnx").stat().st_size,
            "sha256": digest(out / "policy.onnx"),
        },
    }
    write_json(result_file, result)


if __name__ == "__main__":
    main()
