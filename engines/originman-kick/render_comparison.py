"""Fixed first training seed, first/last preregistered test targets."""

import argparse
import json
import subprocess
from pathlib import Path

import mujoco
import numpy as np
import onnxruntime as ort
from experiment import lookup, valid
from kick_env import KickEnv
from PIL import Image, ImageDraw


def render(root):
    root = Path(root)
    anchors = json.loads((root / "calibration.json").read_text())["anchors"]
    session = ort.InferenceSession(
        str(root / "seed-7/policy.onnx"), providers=["CPUExecutionProvider"]
    )
    env = KickEnv(root / "model/source-scene.xml", root / "model/scene.xml")
    env.model.vis.headlight.ambient[:] = 0.6
    env.model.vis.headlight.diffuse[:] = 0.6
    renderer = mujoco.Renderer(env.model, width=600, height=420)
    camera = mujoco.MjvCamera()
    camera.lookat[:] = [0.09, 0, 0.15]
    camera.distance = 0.85
    camera.azimuth = 100
    camera.elevation = -17
    options = mujoco.MjvOption()
    options.geomgroup[3] = False
    ff = subprocess.Popen(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            "1800x510",
            "-r",
            "25",
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(root / "kick-comparison.mp4"),
        ],
        stdin=subprocess.PIPE,
    )
    summaries = []
    for target in [0.07, 0.19]:
        action = session.run(
            None, {"target": np.array([[(target - 0.11) / 0.08]], dtype=np.float32)}
        )[0][0]
        actions = [lookup(0.11, anchors), lookup(target, anchors), action]
        rows = [env.rollout(a, trace=True) for a in actions]
        summaries.append(
            {
                "targetM": target,
                "controllers": [
                    {k: v for k, v in row.items() if k != "frames"} for row in rows
                ],
            }
        )
        for frame in range(max(len(r["frames"]) for r in rows) + 15):
            canvas = Image.new("RGB", (1800, 510), "white")
            draw = ImageDraw.Draw(canvas)
            for i, (name, row) in enumerate(
                zip(
                    ["FIXED KICK", "CALIBRATED INTERPOLATION", "PPO SEED 7"],
                    rows,
                    strict=True,
                )
            ):
                state = row["frames"][min(frame, len(row["frames"]) - 1)]
                env.data.qpos[:] = state["qpos"]
                mujoco.mj_forward(env.model, env.data)
                renderer.update_scene(env.data, camera=camera, scene_option=options)
                # Visual-only target zone: never participates in collision.
                g = renderer.scene.geoms[renderer.scene.ngeom]
                mujoco.mjv_initGeom(
                    g,
                    mujoco.mjtGeom.mjGEOM_BOX,
                    np.array([0.025, 0.05, 0.0003]),
                    np.array([0.095 + target, -0.045, 0.0005]),
                    np.eye(3).ravel(),
                    np.array([0.95, 0.6, 0.1, 0.5], dtype=np.float32),
                )
                renderer.scene.ngeom += 1
                canvas.paste(Image.fromarray(renderer.render()), (600 * i, 90))
                x = float(state["ballPosition"][0] - 0.095)
                draw.text((600 * i + 15, 8), name, fill="black", font_size=21)
                draw.text(
                    (600 * i + 15, 36),
                    f"Target {target * 100:.0f} cm | ball moved {x * 100:.1f} cm",
                    fill="black",
                    font_size=19,
                )
                draw.text(
                    (600 * i + 15, 61),
                    f"Final error {abs(row['ballForwardM'] - target) * 100:.2f} cm | "
                    + ("STABLE" if valid(row) else "INVALID"),
                    fill="black",
                    font_size=17,
                )
            if frame == 40:
                canvas.save(root / f"kick-target-{round(target * 100):02d}cm.png")
            ff.stdin.write(np.asarray(canvas).tobytes())
    ff.stdin.close()
    code = ff.wait()
    renderer.close()
    if code:
        raise RuntimeError("video encoding failed")
    (root / "video-cases.json").write_text(
        json.dumps(
            {
                "selection": "first training seed; first and last preregistered held-out target",
                "cases": summaries,
            },
            indent=2,
        )
    )
    print(root / "kick-comparison.mp4")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    a = p.parse_args()
    render(a.root)
