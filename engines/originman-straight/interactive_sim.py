"""Owned, bounded MuJoCo simulation subprocess. No network, hardware or file writes."""

import base64
import hashlib
import io
import json
import math
import os
import sys

import mujoco
import numpy as np
from PIL import Image
from env import Config
from residual_env import ResidualStandingGym
from browser_scene import scene_description, visual_sample
from scene_presentation import (
    FRAME_WIDTH,
    FRAME_HEIGHT,
    PRESENTATION_VERSION,
    configure_display,
    default_camera,
    update_display,
)


# Upper-body position targets for the baseline controller's simulation only.
WALKS = {"walk-forward": 1, "walk-backward": -1}
TURNS = {"turn-left": 1, "turn-right": -1}
WALK_PERIOD = 1.2
WALK_DURATION = 3.6

MOTIONS = {
    "look-left": (1.4, {"head_pan": 0.55}),
    "look-right": (1.4, {"head_pan": -0.55}),
    "nod": (1.4, {"head_tilt": 0.32}),
    "wave-left": (2.2, {"l_sho_pitch": -0.45, "l_sho_roll": 0.44, "l_el": -0.65}),
    "wave-right": (2.2, {"r_sho_pitch": -0.45, "r_sho_roll": -0.44, "r_el": 0.65}),
}


class InteractiveSimulation:
    def __init__(self, scene):
        with open(
            os.path.join(
                os.path.dirname(__file__), "experiments/standing-residual.json"
            )
        ) as f:
            config = json.load(f)["environment"]
        # Long interactive episodes; controller, 50 Hz and actuator limits stay frozen.
        config["episode_seconds"] = 60
        self.env = ResidualStandingGym(scene, Config(**config))
        configure_display(self.env.physical.model)
        self.renderer = None
        self.render_mode = "pending"
        self.option = mujoco.MjvOption()
        self.option.geomgroup[3] = False
        self.camera = default_camera()
        self.actor = None
        self.policy_sha = None
        self.scene_sha = hashlib.sha256(open(scene, "rb").read()).hexdigest()
        self.done = False
        self.last_info = {}
        self.observation = None
        physical = self.env.physical
        self.motion_actuators = {}
        for actuator_id in range(physical.model.nu):
            joint = int(physical.model.actuator_trnid[actuator_id, 0])
            name = mujoco.mj_id2name(physical.model, mujoco.mjtObj.mjOBJ_JOINT, joint)
            self.motion_actuators[name] = actuator_id
        self.stance_reference = physical.reference
        self.walk_references = {}
        self.reset()

    def reset(self):
        self.motion = None
        self.held_drive = False
        self.drive_requested = None
        self.drive_gain = 0.0
        self.env.physical.reference = self.stance_reference
        self.observation, _ = self.env.reset(
            seed=100, options={"force": 0, "start": 1.55}
        )
        self.done = False
        self.last_info = {}
        return self.state()

    def walk_reference(self, name):
        key = "turn" if name in TURNS else name
        if key not in self.walk_references:
            physical = self.env.physical
            cfg = physical.config
            saved = cfg.stride, cfg.lift, cfg.sway
            try:
                cfg.stride = 0 if key == "turn" else 0.045 * WALKS[name]
                cfg.lift = 0.012
                cfg.sway = 0.022 if key == "turn" else 0.018
                self.walk_references[key] = physical.make_reference()
            finally:
                cfg.stride, cfg.lift, cfg.sway = saved
        return self.walk_references[key]

    def update_drive(self, requested):
        self.drive_requested = requested
        if requested is None or self.motion is not None or self.actor is not None:
            return
        physical = self.env.physical
        self.walk_reference(requested)
        self.motion = (requested, physical.time, {"heading": physical.orientation()[1]})
        self.held_drive = True

    def apply_motion(self):
        if self.motion is None:
            return
        name, start, initial = self.motion
        physical = self.env.physical
        if name in WALKS or name in TURNS:
            elapsed = physical.time - start
            if self.held_drive:
                dt = physical.config.control_dt
                rate = dt / 0.5 if self.drive_requested == name else -dt / 0.36
                self.drive_gain = float(np.clip(self.drive_gain + rate, 0, 1))
                complete = self.drive_gain == 0
                ramp = self.drive_gain
            else:
                complete = elapsed >= WALK_DURATION
                ramp = min(1, elapsed / 0.5, (WALK_DURATION - elapsed) / 0.5)
            if complete:
                physical.reference = self.stance_reference
                if name in TURNS:
                    physical.data.qfrc_applied[5] = 0
                self.motion = None
                self.held_drive = False
                return
            blend = 0.5 - 0.5 * math.cos(math.pi * ramp)
            if name in TURNS:
                # The model has no leg yaw joint. Apply bounded yaw assistance
                # in MuJoCo while the reference gait steps in place.
                if self.held_drive:
                    if self.drive_requested == name:
                        initial["heading"] += TURNS[name] * math.radians(9) * physical.config.control_dt
                    heading = initial["heading"]
                else:
                    phase = min(1, elapsed / 2.8)
                    heading = initial["heading"] + TURNS[name] * math.radians(30) * (
                        0.5 - 0.5 * math.cos(math.pi * phase)
                    )
                error = heading - physical.orientation()[1]
                error = math.atan2(math.sin(error), math.cos(error))
                torque = 1.8 * error - 0.11 * physical.data.qvel[5]
                physical.data.qfrc_applied[5] = np.clip(torque, -0.3, 0.3) * (
                    blend if self.held_drive else 1
                )
            steps = self.walk_reference(name)
            frame = (elapsed / WALK_PERIOD % 1) * len(steps)
            idx = int(frame)
            gait = steps[idx] * (1 - (frame - idx)) + steps[(idx + 1) % len(steps)] * (frame - idx)
            physical.reference = np.array([self.stance_reference[0] * (1 - blend) + gait * blend])
            return
        duration, offsets = MOTIONS[name]
        progress = min(1, max(0, (physical.time - start) / duration))
        envelope = math.sin(math.pi * progress) ** 2
        for joint, offset in offsets.items():
            index = self.motion_actuators[joint]
            swing = 1.0
            if name.startswith("wave-") and joint.endswith("_el"):
                swing += 0.22 * math.sin(6 * math.pi * progress)
            bounds = physical.model.actuator_ctrlrange[index]
            physical.data.ctrl[index] = np.clip(initial[joint] + envelope * offset * swing, *bounds)
        if progress == 1:
            self.motion = None

    def state(self):
        physical = self.env.physical
        rotation, yaw = physical.orientation()
        tilt = float(np.degrees(np.arccos(np.clip(rotation[2, 2], -1, 1))))
        force = self.last_info.get("externalForceWorldN", [0, 0, 0])
        frame = {}
        if self.render_mode == "jpeg":
            if self.renderer is None:
                self.renderer = mujoco.Renderer(physical.model, height=FRAME_HEIGHT, width=FRAME_WIDTH)
            update_display(self.renderer, physical.model, physical.data, self.camera, self.option, force)
            output = io.BytesIO()
            Image.fromarray(self.renderer.render()).save(output, format="JPEG", quality=78)
            frame["frame"] = base64.b64encode(output.getvalue()).decode()
        elif self.render_mode == "webgl":
            frame["visual"] = visual_sample(self.env, self.last_info)
        return {
            "time": round(physical.time, 6),
            "tiltDegrees": tilt,
            "yawDegrees": math.degrees(yaw),
            "qpos": physical.data.qpos.tolist(),
            "observation": self.observation.tolist(),
            "fallen": bool(self.last_info.get("fallen", False)),
            "settled": bool(self.last_info.get("settled", False)),
            "done": self.done,
            "motion": self.motion[0] if self.motion else None,
            "heldDrive": self.held_drive,
            **frame,
            "policySha256": self.policy_sha,
            "sceneSha256": self.scene_sha,
            "controller": "trained-rl" if self.actor else "baseline-pd",
            "controlHz": 50,
            "presentationVersion": "workshop-webgl-v2" if self.render_mode == "webgl" else PRESENTATION_VERSION,
            "frameSize": [FRAME_WIDTH, FRAME_HEIGHT],
            "externalForceWorldN": list(force),
            "jointCount": 20,
            "hardwareEligible": False,
        }

    def command(self, value):
        command = value.get("command")
        if command == "init":
            self.render_mode = "webgl" if value.get("renderMode") == "webgl" else "jpeg"
            encoded = value.get("policy")
            if encoded:
                import onnxruntime as ort

                policy = base64.b64decode(encoded, validate=True)
                if len(policy) > 2_000_000:
                    raise ValueError("policy_too_large")
                options = ort.SessionOptions()
                options.intra_op_num_threads = 1
                options.inter_op_num_threads = 1
                options.enable_mem_pattern = False
                self.actor = ort.InferenceSession(
                    policy, sess_options=options, providers=["CPUExecutionProvider"]
                )
                inputs, outputs = self.actor.get_inputs(), self.actor.get_outputs()
                if (
                    len(inputs) != 1
                    or inputs[0].shape[-1] != 14
                    or len(outputs) != 1
                    or outputs[0].shape[-1] != 2
                ):
                    raise ValueError("policy_contract_mismatch")
                self.policy_sha = hashlib.sha256(policy).hexdigest()
            state = self.state()
            if self.render_mode == "webgl":
                state["scene"] = scene_description(self.env.physical.model)
            return state
        if command == "reset":
            return self.reset()
        if command == "camera":
            for key, low, high in [
                ("azimuth", -360, 360),
                ("elevation", -80, -5),
                ("distance", 0.4, 2.5),
            ]:
                if key in value:
                    number = value[key]
                    if (
                        type(number) not in (int, float)
                        or not math.isfinite(number)
                        or not low <= number <= high
                    ):
                        raise ValueError("invalid_camera")
                    setattr(self.camera, key, number)
            return self.state()
        if command == "motion":
            name = value.get("name")
            if (
                (name not in MOTIONS and name not in WALKS and name not in TURNS)
                or self.done
                or self.actor is not None
                or self.motion is not None
            ):
                raise ValueError("motion_unavailable")
            physical = self.env.physical
            if name in WALKS or name in TURNS:
                self.walk_reference(name)
                self.motion = (name, physical.time, {"heading": physical.orientation()[1]})
                return self.state()
            initial = {
                joint: float(physical.data.ctrl[self.motion_actuators[joint]])
                for joint in MOTIONS[name][1]
            }
            self.motion = (name, physical.time, initial)
            return self.state()
        if command == "push":
            force = value.get("force")
            if (
                type(force) not in (int, float)
                or not math.isfinite(force)
                or abs(force) > 9
            ):
                raise ValueError("invalid_force")
            if self.done:
                raise ValueError("reset_finished_episode_first")
            physical = self.env.physical
            physical.push_force[:] = [0, force, 0]
            delay = value.get("delay", 0)
            if (
                type(delay) not in (int, float)
                or not math.isfinite(delay)
                or not 0 <= delay <= 5
            ):
                raise ValueError("invalid_delay")
            physical.push_start = physical.time + delay
            return self.state()
        if command == "step":
            steps = value.get("steps", 5)
            if type(steps) is not int or not 1 <= steps <= 10:
                raise ValueError("invalid_steps")
            drive = value.get("drive")
            if drive is not None and (not isinstance(drive, str) or drive not in WALKS and drive not in TURNS):
                raise ValueError("invalid_drive")
            samples = []
            visuals = []
            for _ in range(steps):
                if self.done:
                    break
                self.update_drive(drive)
                active_motion = self.motion[0] if self.motion else None
                self.apply_motion()
                before = self.observation.copy()
                action = np.zeros(2, dtype=np.float32)
                if self.actor:
                    action = self.actor.run(
                        None, {self.actor.get_inputs()[0].name: before.reshape(1, 14)}
                    )[0].reshape(-1)
                if action.shape != (2,) or not np.isfinite(action).all():
                    raise ValueError("invalid_actor_output")
                action = np.clip(action, -1, 1)
                start = self.env.physical.time
                self.observation, reward, terminated, truncated, info = self.env.step(
                    action
                )
                self.last_info = info
                self.done = bool(terminated or truncated)
                if self.done and active_motion in TURNS:
                    self.env.physical.data.qfrc_applied[5] = 0
                if self.render_mode == "webgl":
                    visuals.append(visual_sample(self.env, info))
                samples.append(
                    {
                        "t": start,
                        "tNext": self.env.physical.time,
                        "observation": before.tolist(),
                        "nextObservation": self.observation.tolist(),
                        "action": action.tolist(),
                        "reward": float(reward),
                        "done": self.done,
                        "terminated": bool(terminated),
                        "truncated": bool(truncated),
                        "controlHz": 50,
                        "source": "simulation",
                        **({"interactiveMotion": active_motion} if active_motion else {}),
                        "verified": False,
                        "metrics": {
                            "fallen": bool(info["fallen"]),
                            "tiltDegrees": float(info["tiltDegrees"]),
                        },
                        "qpos": self.env.physical.data.qpos.tolist(),
                        "policySha256": self.policy_sha,
                    }
                )
            return {**self.state(), "samples": samples, **({"visuals": visuals} if self.render_mode == "webgl" else {})}
        raise ValueError("unknown_command")

    def close(self):
        if self.renderer is not None:
            self.renderer.close()


if __name__ == "__main__":
    simulation = None
    try:
        simulation = InteractiveSimulation(sys.argv[1])
        for line in sys.stdin:
            if len(line) > 3_000_000:
                break
            try:
                value = json.loads(line)
                result = simulation.command(value)
                print(json.dumps({"ok": True, **result}, allow_nan=False), flush=True)
            except Exception:
                print(
                    json.dumps({"ok": False, "error": "simulation_command_failed"}),
                    flush=True,
                )
    finally:
        if simulation:
            simulation.close()
