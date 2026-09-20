#!/usr/bin/env python3
"""Render the real 61D -> 14D MicroDuck actor in a football scene.

The scene and actor are supplied by the upstream ``microduck_rl`` checkout.
This script deliberately reuses ``microduck_eval.sim.MicroDuckSim`` so the
observation assembly, calibrated actuator model, 50 Hz cadence, and servo
ordering are identical to the platform evaluator.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path
import subprocess

import mujoco
import numpy as np
from PIL import Image, ImageDraw, ImageFont


def _scene_with_goal(source: Path) -> Path:
    text = source.read_text()
    insertion = """
        <geom name="football-goal" type="box" pos="2.4 0 0.32" size="0.04 0.55 0.32" rgba="0.1 0.3 0.95 0.60"/>
        <geom name="football-goal-left-post" type="cylinder" pos="2.36 -0.58 0.32" size="0.035 0.32" rgba="0.1 0.3 0.95 1"/>
        <geom name="football-goal-right-post" type="cylinder" pos="2.36 0.58 0.32" size="0.035 0.32" rgba="0.1 0.3 0.95 1"/>
    """
    with tempfile.NamedTemporaryFile("w", suffix="-football-scene.xml", dir=source.parent, delete=False) as handle:
        handle.write(text.replace("</worldbody>", insertion + "</worldbody>"))
        return Path(handle.name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--out", default="microduck-real-14d-football.mp4")
    parser.add_argument("--seconds", type=float, default=8.0)
    args = parser.parse_args()

    eval_dir = Path(__file__).resolve().parents[1] / "microduck-eval"
    sys.path.insert(0, str(eval_dir))
    from microduck_eval.policy import load_policy
    from microduck_eval.sim import MicroDuckSim, SceneSpec

    root = Path(args.model_root).resolve()
    source_scene = root / "src" / "mjlab_microduck" / "robot" / "microduck" / "scene_ball.xml"
    if not source_scene.is_file():
        raise SystemExit(f"scene not found: {source_scene}")
    scene = _scene_with_goal(source_scene)
    sim = MicroDuckSim(SceneSpec(xml=scene, has_ball=True), actuator_model="bam-ctrl", physics="mjlab", collisions="full")
    policy = load_policy(args.policy)
    if policy.observation_size != 61 or policy.action_size != 14:
        raise SystemExit("policy does not satisfy the MicroDuck 61D -> 14D contract")
    sim.reset(base_xy=(-0.55, 0.0), base_yaw=0.0, ball_distance=0.30, payload_fraction=0.0)
    ball_qpos = sim.ball_qpos
    assert ball_qpos is not None
    sim.data.qpos[ball_qpos : ball_qpos + 7] = (-0.25, 0.0, 0.035, 1, 0, 0, 0)
    mujoco.mj_forward(sim.model, sim.data)

    renderer = mujoco.Renderer(sim.model, height=480, width=640)
    camera = mujoco.MjvCamera()
    camera.type = mujoco.mjtCamera.mjCAMERA_FREE
    camera.distance = 4.2
    camera.azimuth = 90
    camera.elevation = -24
    ffmpeg = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "640x480", "-r", "50", "-i", "-", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", args.out], stdin=subprocess.PIPE)
    assert ffmpeg.stdin is not None
    font = ImageFont.load_default()
    last_action = np.zeros(14, dtype=np.float32)
    goal = False
    for _ in range(int(args.seconds * 50)):
        # 3D twist + 4D head pose + 6D body pose = the full 13D command
        # tail used by the upstream 61D actor contract.
        command = np.zeros(13, dtype=np.float32)
        observation = sim.observation(command, last_action)
        action = policy.act(observation)
        sim.apply_action(action)
        sim.advance()
        last_action = action.astype(np.float32)
        ball_x, ball_y = sim.ball_xy()
        goal = goal or (ball_x >= 2.2 and abs(ball_y) < 0.58)
        camera.lookat[:] = (0.8, 0.0, 0.2)
        renderer.update_scene(sim.data, camera=camera)
        image = Image.fromarray(renderer.render())
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((12, 12, 430, 66), radius=8, fill=(8, 12, 20, 220))
        draw.text((24, 22), "MicroDuck real actor · 61D → 14D", fill="white", font=font)
        draw.text((24, 42), f"actuator=bam-ctrl  ball=({ball_x:.2f}, {ball_y:.2f})  {'GOAL' if goal else 'RUN'}", fill=(255, 220, 120), font=font)
        ffmpeg.stdin.write(np.asarray(image, dtype=np.uint8).tobytes())
        if goal:
            for _ in range(50):
                ffmpeg.stdin.write(np.asarray(image, dtype=np.uint8).tobytes())
            break
    ffmpeg.stdin.close()
    code = ffmpeg.wait()
    scene.unlink(missing_ok=True)
    if code:
        raise SystemExit(code)
    print(f"{args.out} goal={goal} policy={args.policy}")


if __name__ == "__main__":
    main()
