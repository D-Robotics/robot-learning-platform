"""Frozen exported SB3 policy vs reference and corrected physical-axis feedback."""

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from env import Config
from evaluation_evidence import capture, finish
from gym_bridge import OriginManGym, axis_correct_feedback
from monitor import digest, write_json
from push_eval import episode


class ArtifactPolicy:
    def __init__(self, run):
        self.spec = json.loads((run / "normalization.json").read_text())
        self.session = ort.InferenceSession(
            str(run / "policy.onnx"), providers=["CPUExecutionProvider"]
        )
        self.history = np.zeros(
            (self.spec["frames"], self.spec["rawObservationSize"]), dtype=np.float32
        )

    def reset(self):
        self.history[:] = 0

    def __call__(self, obs):
        normal = (obs - np.asarray(self.spec["mean"])) / np.sqrt(
            np.asarray(self.spec["variance"]) + self.spec["epsilon"]
        )
        normal = np.clip(
            normal, -self.spec["clipObservation"], self.spec["clipObservation"]
        ).astype(np.float32)
        self.history[:-1] = self.history[1:].copy()
        self.history[-1] = normal
        return self.session.run(
            None, {"normalized_history": self.history.reshape(1, -1)}
        )[0][0]


def evaluate(run, feedback_path, plan_path, out):
    out.mkdir(parents=True, exist_ok=False)
    scene = run / "model/scene.xml"
    capture(out, scene)
    config = json.loads((run / "training-summary.json").read_text())
    cfg = Config(**config["config"])
    mode = config["mode"]
    plan = json.loads(plan_path.read_text())
    if run.name not in plan["plannedRuns"]:
        raise ValueError("unplanned run")
    feedback = json.loads(feedback_path.read_text())["coefficients"]
    bridge = OriginManGym(scene, cfg, mode=mode)
    if mode == "feet":
        bridge.modes.basis = np.load(run / "foot-basis.npy", allow_pickle=False)
    policy = ArtifactPolicy(run)
    write_json(
        out / "plan.json",
        {
            "cases": plan["cases"],
            "feedbackImplementation": "physical-axis-correct PD",
            "feedbackSha256": digest(feedback_path),
            "policySha256": digest(run / "policy.onnx"),
            "normalizationSha256": digest(run / "normalization.json"),
            "finalPlanSha256": digest(plan_path),
            "rawObservationSize": 41,
            "normalizedHistorySize": 164,
            "mode": mode,
            "scope": "deterministic simulation coverage, no hardware claim; frozen final policy and tuning-only baseline",
        },
    )
    rows = []
    for index, case in enumerate(plan["cases"]):
        for controller in ["reference", "imu-feedback", "rl"]:
            policy.reset()

            def act(obs, controller=controller):
                if controller == "reference":
                    return np.zeros(10)
                if controller == "imu-feedback":
                    return axis_correct_feedback(bridge.physical, feedback)
                action = policy(obs)
                return bridge.modes.residual(action) if bridge.modes else action

            row = {
                "controller": controller,
                **episode(bridge.physical, case, act, trace=True),
            }
            rows.append(row)
            with (out / "episodes.jsonl").open("a") as f:
                f.write(json.dumps(row, allow_nan=False) + "\n")
        print(f"evaluated {index + 1}/{len(plan['cases'])}", flush=True)
    summary = {}
    for controller in ["reference", "imu-feedback", "rl"]:
        cases = [r for r in rows if r["controller"] == controller]
        summary[controller] = {
            "walkingSuccesses": sum(r["walkingSuccess"] for r in cases),
            "falls": sum(r["fallen"] for r in cases),
            "meanForwardM": float(np.mean([r["forwardM"] for r in cases])),
            "cases": len(cases),
        }
    write_json(out / "summary.json", summary)
    finish(out, scene)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--feedback", type=Path, required=True)
    p.add_argument("--plan", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    evaluate(a.run, a.feedback, a.plan, a.out)
