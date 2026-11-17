"""Exact-model four-way recorded comparison; no physics rerun or pose editing."""

import argparse
import json
import subprocess
from pathlib import Path

import mujoco
import numpy as np
from PIL import Image, ImageDraw, ImageFont


def render(scene, evaluation, out, case_index, font=None):
    rows = [
        json.loads(s) for s in (evaluation / "episodes.jsonl").read_text().splitlines()
    ]
    rows = rows[case_index * 4 : (case_index + 1) * 4]
    if [r["controller"] for r in rows] != [
        "reference",
        "imu-feedback",
        "untrained",
        "rl",
    ] and not (len(rows) == 4 and all("displayLabel" in r for r in rows)):
        raise ValueError("four paired controllers are required")
    if len({(r["force"], r["start"]) for r in rows}) != 1:
        raise ValueError("disturbance conditions differ")
    model = mujoco.MjModel.from_xml_path(str(scene))
    model.vis.headlight.ambient[:] = 0.3
    model.vis.headlight.diffuse[:] = 0.6
    data = mujoco.MjData(model)
    renderer = mujoco.Renderer(model, height=360, width=640)
    opt = mujoco.MjvOption()
    opt.geomgroup[3] = False
    cam = mujoco.MjvCamera()
    cam.lookat[:] = [0.0, 0, 0.15]
    cam.distance, cam.azimuth, cam.elevation = 0.7, 115, -20
    big = ImageFont.truetype(font, 23) if font else ImageFont.load_default(size=23)
    small = ImageFont.truetype(font, 17) if font else ImageFont.load_default(size=17)
    labels = (
        ["参考站姿", "普通反馈", "训练前", "训练后 RL"]
        if font
        else ["REFERENCE", "PD FEEDBACK", "BEFORE TRAINING", "TRAINED RL"]
    )
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
            "1280x1000",
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
    count = int(np.ceil(max(r["seconds"] for r in rows) * 25 - 1e-9))
    try:
        for frame in range(count):
            playback_time = (frame + 1) / 25
            picture = Image.new("RGB", (1280, 1000), "white")
            draw = ImageDraw.Draw(picture)
            for i, row in enumerate(rows):
                x, y = i % 2 * 640, i // 2 * 480
                index = (
                    np.searchsorted(
                        [f["time"] for f in row["frames"]],
                        playback_time + 1e-8,
                        side="right",
                    )
                    - 1
                )
                f = row["frames"][max(0, index)]
                data.qpos[:] = f["qpos"]
                mujoco.mj_forward(model, data)
                renderer.update_scene(data, camera=cam, scene_option=opt)
                picture.paste(Image.fromarray(renderer.render()), (x, y + 80))
                draw.text(
                    (x + 14, y + 6),
                    row.get("displayLabel", labels[i]),
                    font=big,
                    fill="#18323d",
                )
                draw.text(
                    (x + 14, y + 36),
                    (
                        f"时间 {min(playback_time, row['seconds']):.2f}s   倾角 {f['tiltDegrees']:.1f}°   Y推力 {f['externalForceWorldN'][1]:+.1f}N"
                        if font
                        else f"t={min(playback_time, row['seconds']):.2f}s   tilt={f['tiltDegrees']:.1f} deg   Y push={f['externalForceWorldN'][1]:+.1f}N"
                    ),
                    font=small,
                    fill="black",
                )
                stopped = row["fallen"] and playback_time >= row["seconds"] - 1e-8
                status = (
                    ("跌倒，保持末帧" if font else "FALL: held at last pose")
                    if stopped
                    else ("回放中" if font else "replaying")
                )
                if frame == count - 1 and not stopped:
                    status = (
                        ("最终恢复通过" if font else "SETTLED: PASS")
                        if row["recoverySuccess"]
                        else ("最终恢复未通过" if font else "SETTLED: FAIL")
                    )
                draw.text(
                    (x + 14, y + 449),
                    status,
                    font=small,
                    fill="#ab372f" if stopped else "#1b7166",
                )
            original_index = rows[0].get("originalCaseIndex", case_index)
            footer = (
                f"仅仿真 | 条件 {original_index}：{rows[0]['force']:+g}N，{rows[0]['start']:g}s 开始，持续0.2s | 全部条件另行报告"
                if font
                else f"SIMULATION ONLY | case {case_index}: {rows[0]['force']:+g}N at {rows[0]['start']:g}s for 0.2s | all cases reported"
            )
            draw.text((14, 970), footer, font=small, fill="black")
            if frame in {round((rows[0]["start"] + 0.5) / 0.04), count - 1}:
                picture.save(out.with_name(out.stem + f"-frame{frame:03d}.png"))
            ff.stdin.write(np.asarray(picture).tobytes())
    finally:
        ff.stdin.close()
        code = ff.wait()
        renderer.close()
    if code:
        raise RuntimeError("video encoding failed")
    out.with_suffix(".case.json").write_text(
        json.dumps(
            {
                "caseIndex": case_index,
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
    p.add_argument("--case-index", type=int, required=True)
    p.add_argument("--font")
    a = p.parse_args()
    render(a.scene, a.evaluation, a.out, a.case_index, a.font)
