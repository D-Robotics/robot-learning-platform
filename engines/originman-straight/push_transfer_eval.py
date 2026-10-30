"""Frozen-controller transfer across assumed physics; no tuning on transfer cases."""

import argparse
import json
from pathlib import Path

import mujoco
import numpy as np
import onnxruntime as ort
from env import Config, OriginManEnv
from evaluation_evidence import capture, finish
from monitor import digest, write_json
from push_eval import TEST_CASES, episode, feedback

PROFILES = [
    {"name": "nominal"},
    {"name": "physics_0.5ms", "dt": 0.0005},
    {"name": "physics_0.25ms", "dt": 0.00025},
    {"name": "kp_6", "kp": 6},
    {"name": "kp_10", "kp": 10},
    {"name": "effort_1Nm", "effort": 1.0},
    {"name": "floor_friction_0.6", "friction": 0.6},
    {"name": "floor_friction_1.0", "friction": 1.0},
    {"name": "box_body_self_collision", "selfCollision": True},
]


class TransferEnv(OriginManEnv):
    def __init__(self, scene, config, profile):
        self.profile = profile
        super().__init__(scene, config)
        if "dt" in profile:
            self.model.opt.timestep = profile["dt"]
        if "friction" in profile:
            self.model.geom_friction[self.model.geom_group == 3, 0] = profile[
                "friction"
            ]
            floor = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_GEOM, "ground")
            self.model.geom_friction[floor, 0] = profile["friction"]
        if profile.get("selfCollision"):
            self.model.geom_conaffinity[self.model.geom_group == 3] |= 1

    def reset(self, **kwargs):
        obs = super().reset(**kwargs)
        if "kp" in self.profile:
            self.model.actuator_gainprm[self.leg_a, 0] = self.profile["kp"]
            self.model.actuator_biasprm[self.leg_a, 1] = -self.profile["kp"]
        if "effort" in self.profile:
            self.model.actuator_forcerange[:] = [
                -self.profile["effort"],
                self.profile["effort"],
            ]
        return obs


def run(scene, policy, feedback_path, out):
    out.mkdir(parents=True, exist_ok=False)
    capture(out, scene)
    cfg = Config(
        **json.loads((policy.parent / "training-summary.json").read_text())["config"]
    )
    identity = json.loads((feedback_path.parent / "identity.json").read_text())
    if identity["sceneSha256"] != digest(scene) or identity["config"] != cfg.__dict__:
        raise ValueError("nominal tuning identity mismatch")
    gains = json.loads(feedback_path.read_text())["coefficients"]
    write_json(
        out / "plan.json",
        {
            "profiles": PROFILES,
            "cases": TEST_CASES,
            "policySha256": digest(policy),
            "feedbackSha256": digest(feedback_path),
            "sceneSha256": digest(scene),
            "sourceSha256": {
                p.name: digest(p)
                for p in [
                    Path(__file__),
                    Path(__file__).with_name("env.py"),
                    Path(__file__).with_name("push_eval.py"),
                ]
            },
            "retraining": False,
            "retuning": False,
            "scope": "assumed one-factor simulation profiles; no measured hardware parameter ranges or independent stochastic success-rate claim",
        },
    )
    session = ort.InferenceSession(str(policy), providers=["CPUExecutionProvider"])
    summary = []
    for profile in PROFILES:
        env = TransferEnv(scene, cfg, profile)
        modes = {
            "reference": lambda obs: np.zeros(10),
            "imu-feedback": lambda obs, current=env: feedback(current, gains),
            "rl": lambda obs: session.run(None, {"obs": obs[None]})[0][0],
        }
        rows = []
        for case in TEST_CASES:
            for name, act in modes.items():
                row = {
                    "profile": profile["name"],
                    "controller": name,
                    **episode(env, case, act),
                }
                rows.append(row)
                with (out / "episodes.jsonl").open("a") as f:
                    f.write(json.dumps(row, allow_nan=False) + "\n")
        for mode in modes:
            rs = [r for r in rows if r["controller"] == mode]
            summary.append(
                {
                    "profile": profile["name"],
                    "controller": mode,
                    "successes": sum(r["walkingSuccess"] for r in rs),
                    "falls": sum(r["fallen"] for r in rs),
                    "meanForwardM": float(np.mean([r["forwardM"] for r in rs])),
                    "cases": len(rs),
                }
            )
        write_json(out / "summary.json", summary)
        print(profile["name"], summary[-3:], flush=True)
    finish(out, scene)
    write_json(
        out / "receipt.json",
        {"completed": True, "episodes": len(PROFILES) * len(TEST_CASES) * 3},
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--policy", type=Path, required=True)
    p.add_argument("--feedback", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    run(a.scene, a.policy, a.feedback, a.out)
