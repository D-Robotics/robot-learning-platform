#!/usr/bin/env python3
"""Render a short, deterministic single-duck football demonstration."""

from __future__ import annotations

import argparse
import subprocess
import sys

import mujoco
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from football_env import BALL_RADIUS, FootballConfig, GOAL_X, MicroDuckFootballEnv


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="microduck-football-demo.mp4")
    parser.add_argument("--seconds", type=float, default=10.0)
    args = parser.parse_args()
    env = MicroDuckFootballEnv(FootballConfig(task="single-goal-kick", episode_seconds=args.seconds))
    env.reset(seed=20260920)
    # Fixed centre-lane start makes the demonstration show the complete
    # chase -> contact -> goal sequence on every machine.
    ball_qadr = env.model.jnt_qposadr[env.ball_joint]
    env.data.qpos[ball_qadr : ball_qadr + 3] = (-0.15, 0.0, BALL_RADIUS + 0.02)
    duck_qadr = env.model.jnt_qposadr[env.duck_joints[0]]
    env.data.qpos[duck_qadr : duck_qadr + 3] = (-1.45, 0.0, 0.22)
    mujoco.mj_forward(env.model, env.data)
    renderer = mujoco.Renderer(env.model, height=540, width=960)
    ffmpeg = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "960x540", "-r", "25", "-i", "-", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", args.out],
        stdin=subprocess.PIPE,
    )
    assert ffmpeg.stdin is not None
    font = ImageFont.load_default()
    total = int(args.seconds * 25)
    for frame in range(total):
        delta = env._ball_xy() - env._duck_xy(0)
        action = np.array([np.clip(delta[0] * 3.0, -1, 1), np.clip(delta[1] * 3.0, -1, 1), 0.0, 1.0 if np.linalg.norm(delta) < 0.42 else 0.0], dtype=np.float32)
        _, _, done, info = env.step(action)
        renderer.update_scene(env.data, camera="overview")
        image = Image.fromarray(renderer.render())
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((18, 16, 470, 78), radius=10, fill=(15, 20, 28, 210))
        state = "GOAL!" if info["goal"] else ("KICK" if action[3] > 0.35 else "CHASE")
        draw.text((34, 28), "MicroDuck Football · single-goal-kick", fill=(255, 255, 255), font=font)
        draw.text((34, 50), f"state={state}  ball_x={info['ballX']:.2f} m  goal_x={GOAL_X:.1f} m", fill=(255, 220, 120), font=font)
        ffmpeg.stdin.write(np.asarray(image, dtype=np.uint8).tobytes())
        if done and not info["goal"]:
            break
        if info["goal"]:
            # Hold the goal frame for a moment so the result is visible.
            for _ in range(75):
                ffmpeg.stdin.write(np.asarray(image, dtype=np.uint8).tobytes())
            break
    ffmpeg.stdin.close()
    code = ffmpeg.wait()
    if code:
        raise SystemExit(code)
    print(args.out)


if __name__ == "__main__":
    main()
