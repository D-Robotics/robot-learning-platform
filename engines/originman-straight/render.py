"""Render a predetermined evaluation case, never the best episode."""

import argparse
import json
import subprocess
from pathlib import Path

import mujoco
import numpy as np
from env import Config, OriginManEnv
from PIL import Image, ImageDraw


def render(scene, policy, out, case_index=0, report=None):
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    summary = json.loads((Path(policy).parent / "training-summary.json").read_text())
    cfg = Config(**summary["config"])
    case = {"seed": 1000, "asymmetry": -0.18, "initial_yaw": 0.025}
    if report:
        rows = json.loads(Path(report).read_text())["cases"]
        case = {
            k: rows[case_index * 2][k] for k in ["seed", "asymmetry", "initial_yaw"]
        }
    left = OriginManEnv(scene, cfg)
    right = OriginManEnv(scene, cfg, reference=left.reference)
    obs = [e.reset(**case) for e in [left, right]]
    ort = __import__("onnxruntime").InferenceSession(
        str(policy), providers=["CPUExecutionProvider"]
    )
    renderer = mujoco.Renderer(left.model, height=480, width=640)
    opt = mujoco.MjvOption()
    opt.geomgroup[3] = False
    cam = mujoco.MjvCamera()
    cam.lookat[:] = [0.12, 0, 0.16]
    cam.distance = 0.8
    cam.azimuth = 115
    cam.elevation = -20
    ff = subprocess.Popen(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-vcodec",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            "1280x540",
            "-r",
            "25",
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(out),
        ],
        stdin=subprocess.PIPE,
    )
    frames = round(cfg.episode_seconds / 0.04)
    lastinfo = [None, None]
    for frame in range(frames):
        for half in range(2):
            for k, e in enumerate([left, right]):
                a = (
                    np.zeros(10)
                    if k == 0
                    else ort.run(None, {"obs": obs[k][None]})[0][0]
                )
                obs[k], _, _, lastinfo[k] = e.step(a)
        canvas = Image.new("RGB", (1280, 540), "white")
        draw = ImageDraw.Draw(canvas)
        for k, e in enumerate([left, right]):
            renderer.update_scene(e.data, camera=cam, scene_option=opt)
            canvas.paste(Image.fromarray(renderer.render()), (640 * k, 60))
            info = lastinfo[k]
            draw.text(
                (640 * k + 15, 10),
                ("REFERENCE ONLY" if k == 0 else "REFERENCE + PPO RESIDUAL"),
                fill="black",
                font_size=22,
            )
            draw.text(
                (640 * k + 15, 36),
                f"t={info['time']:.1f}s x={info['x']:.3f}m y={info['y']:.3f}m yaw={np.degrees(info['yaw']):.1f}deg",
                fill="black",
                font_size=17,
            )
        if frame == frames // 2:
            canvas.save(out.with_suffix(".png"))
        ff.stdin.write(np.asarray(canvas).tobytes())
    ff.stdin.close()
    code = ff.wait()
    renderer.close()
    if code:
        raise RuntimeError("ffmpeg failed")
    out.with_suffix(".case.json").write_text(json.dumps(case, indent=2))
    print(out)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", required=True)
    p.add_argument("--policy", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--report")
    a = p.parse_args()
    render(a.scene, a.policy, a.out, report=a.report)
