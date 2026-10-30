"""Replay recorded first held-out case, including failures; no episode selection."""

import argparse
import json
import subprocess
from pathlib import Path

import mujoco
import numpy as np
from PIL import Image, ImageDraw


def render(scene, evaluation, out, case_index=0):
    cases = [
        json.loads(s) for s in (evaluation / "episodes.jsonl").read_text().splitlines()
    ]
    rows = cases[case_index * 3 : case_index * 3 + 3]
    if [r["controller"] for r in rows] != ["reference", "imu-feedback", "rl"]:
        raise ValueError("expected paired reference, feedback, RL trace order")
    if len({(r["force"], r["start"]) for r in rows}) != 1:
        raise ValueError("comparison traces have different disturbances")
    model = mujoco.MjModel.from_xml_path(str(scene))
    data = mujoco.MjData(model)
    renderer = mujoco.Renderer(model, height=360, width=480)
    opt = mujoco.MjvOption()
    opt.geomgroup[3] = False
    cam = mujoco.MjvCamera()
    cam.lookat[:] = [0.12, 0, 0.15]
    cam.distance = 0.85
    cam.azimuth = 115
    cam.elevation = -20
    out.parent.mkdir(parents=True, exist_ok=True)
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
            "1440x470",
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
    try:
        for frame in range(max(len(r["frames"]) for r in rows)):
            image = Image.new("RGB", (1440, 470), "white")
            draw = ImageDraw.Draw(image)
            for i, row in enumerate(rows):
                f = row["frames"][min(frame, len(row["frames"]) - 1)]
                data.qpos[:] = f["qpos"]
                mujoco.mj_forward(model, data)
                renderer.update_scene(data, camera=cam, scene_option=opt)
                image.paste(Image.fromarray(renderer.render()), (i * 480, 80))
                stopped = frame >= len(row["frames"]) - 1 and row["fallen"]
                draw.text(
                    (i * 480 + 12, 8),
                    row["controller"].upper(),
                    fill="black",
                    font_size=21,
                )
                draw.text(
                    (i * 480 + 12, 36),
                    f"t={f['time']:.2f}s forward={f['x'] * 100:.1f}cm",
                    fill="black",
                    font_size=17,
                )
                force = f["externalForceWorldN"][1]
                draw.text(
                    (i * 480 + 12, 58),
                    "STOP: FALL" if stopped else f"lateral push={force:.1f}N",
                    fill="red" if force or stopped else "black",
                    font_size=17,
                )
            draw.text(
                (12, 446),
                f"SIMULATION ONLY | case {case_index} | failures held at final recorded pose | full dataset reported separately",
                fill="black",
                font_size=16,
            )
            if frame == min(100, max(len(r["frames"]) for r in rows) - 1):
                image.save(out.with_suffix(".png"))
            ff.stdin.write(np.asarray(image).tobytes())
    finally:
        ff.stdin.close()
        code = ff.wait()
        renderer.close()
    if code:
        raise RuntimeError("ffmpeg failed")
    out.with_suffix(".case.json").write_text(
        json.dumps(
            {
                "caseIndex": case_index,
                "forceN": rows[0]["force"],
                "startSeconds": rows[0]["start"],
                "controllers": [
                    {k: v for k, v in r.items() if k != "frames"} for r in rows
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=Path, required=True)
    p.add_argument("--evaluation", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--case-index", type=int, default=0)
    a = p.parse_args()
    render(a.scene, a.evaluation, a.out, a.case_index)
