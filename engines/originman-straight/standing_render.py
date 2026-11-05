"""Exact-pose classroom comparison: style and playback timing only, no dynamics rerun."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import mujoco
import numpy as np
from PIL import Image, ImageDraw, ImageFont, __version__ as pillow_version

from replay_presentation import (
    FPS,
    camera_for,
    decorate,
    force_windows,
    frame_at,
    phase,
    playback_schedule,
    style_model,
)

WIDTH, HEIGHT = 1600, 1000
TILE_W, VIEW_H = 768, 310
BG, PANEL, TEXT, MUTED = "#101d29", "#182936", "#eef4f6", "#a4b7c2"
ORANGE, GREEN, RED = "#ffae64", "#77ddba", "#ff9298"


def paired_rows(evaluation, case_index):
    if case_index < 0:
        raise ValueError("case index must be nonnegative")
    rows = [
        json.loads(s) for s in (evaluation / "episodes.jsonl").read_text().splitlines()
    ]
    rows = rows[case_index * 4 : (case_index + 1) * 4]
    if len(rows) != 4 or (
        [r["controller"] for r in rows]
        != ["reference", "imu-feedback", "untrained", "rl"]
        and not all("displayLabel" in r for r in rows)
    ):
        raise ValueError("four paired controllers are required")
    if len({(r["force"], r["start"]) for r in rows}) != 1:
        raise ValueError("disturbance conditions differ")
    for row in rows:
        times = [f["time"] for f in row["frames"]]
        if (
            not times
            or times[0] < 0
            or not all(np.isfinite(times))
            or any(b <= a for a, b in zip(times, times[1:]))
        ):
            raise ValueError("finite increasing recorded frame times required")
        if (
            row["seconds"] <= 0
            or not np.isfinite(row["seconds"])
            or abs(times[-1] - row["seconds"]) > 1e-6
        ):
            raise ValueError("recorded duration must match terminal frame")
    for row in rows:
        if any(
            len(f["externalForceWorldN"]) != 3
            or not np.isfinite(f["externalForceWorldN"]).all()
            or not np.isfinite(f["tiltDegrees"])
            for f in row["frames"]
        ):
            raise ValueError("finite force vector and tilt required")
    return rows


def render(scene, evaluation, out, case_index, font=None):
    scene, evaluation, out = Path(scene), Path(evaluation), Path(out)
    rows = paired_rows(evaluation, case_index)
    model = mujoco.MjModel.from_xml_path(str(scene))
    if any(
        len(f["qpos"]) != model.nq or not np.isfinite(f["qpos"]).all()
        for r in rows
        for f in r["frames"]
    ):
        raise ValueError("recorded qpos must be finite and match scene")
    style_model(model)
    data = mujoco.MjData(model)
    model.vis.global_.offwidth = max(model.vis.global_.offwidth, TILE_W)
    model.vis.global_.offheight = max(model.vis.global_.offheight, VIEW_H)
    renderer = mujoco.Renderer(model, height=VIEW_H, width=TILE_W)
    opt = mujoco.MjvOption()
    opt.geomgroup[3] = False
    camera = camera_for(rows)
    sizes = (28, 22, 18, 15)
    fonts = [
        ImageFont.truetype(font, size) if font else ImageFont.load_default(size=size)
        for size in sizes
    ]
    big, medium, small, tiny = fonts
    zh = bool(font)
    labels = (
        {
            "reference": "参考站姿",
            "imu-feedback": "原始反馈",
            "tuned-feedback": "调优反馈",
            "untrained": "训练前",
            "rl-frozen-correction": "冻结 RL 输出",
            "rl": "本次训练策略",
        }
        if zh
        else {}
    )
    status_copy = {
        "before": ("扰动前 · 观察站姿", "BEFORE PUSH"),
        "push": ("正在施加推力", "PUSH ACTIVE"),
        "observe": ("恢复观察中", "OBSERVING RECOVERY"),
        "fallen": ("已记录跌倒 · 保持末帧", "RECORDED FALL / FINAL POSE HELD"),
        "passed": ("最终恢复通过", "RECOVERY PASSED"),
        "failed": ("最终恢复未通过", "RECOVERY NOT PASSED"),
    }
    schedule = playback_schedule(rows)
    windows = force_windows(rows[0])
    end = max(r["seconds"] for r in rows)
    out.parent.mkdir(parents=True, exist_ok=True)
    ff = None
    try:
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
                f"{WIDTH}x{HEIGHT}",
                "-r",
                str(FPS),
                "-i",
                "-",
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(out),
            ],
            stdin=subprocess.PIPE,
        )
        saved = set()
        for frame_number, (t, rate) in enumerate(schedule):
            picture = Image.new("RGB", (WIDTH, HEIGHT), BG)
            draw = ImageDraw.Draw(picture)
            draw.text(
                (24, 17),
                "ORIGINMAN / " + ("受扰恢复实验" if zh else "DISTURBANCE & RECOVERY"),
                font=big,
                fill=TEXT,
            )
            draw.text(
                (24, 55),
                (
                    "相同扰动 · 相同镜头 · 真实记录姿态"
                    if zh
                    else "SAME PUSH / SAME CAMERA / RECORDED POSES"
                ),
                font=tiny,
                fill=MUTED,
            )
            rate_label = (
                ("末帧停留" if zh else "FINAL HOLD")
                if rate == 0
                else (
                    ("0.5× 慢放" if zh else "0.5x SLOW MOTION")
                    if rate == 0.5
                    else ("1× 回放" if zh else "1x REPLAY")
                )
            )
            draw.text(
                (1110, 24),
                f"{rate_label}  |  t = {t:05.2f} s",
                font=medium,
                fill=ORANGE if rate == 0.5 else TEXT,
            )
            for i, row in enumerate(rows):
                x, y = 24 + i % 2 * 784, 92 + i // 2 * 410
                f = frame_at(row, t)
                data.qpos[:] = f["qpos"]
                mujoco.mj_forward(model, data)
                renderer.update_scene(data, camera=camera, scene_option=opt)
                decorate(renderer.scene, f)
                view = Image.fromarray(renderer.render())
                draw.rounded_rectangle(
                    (x, y, x + TILE_W, y + 396), radius=12, fill=PANEL
                )
                draw.text(
                    (x + 14, y + 10),
                    f"{i + 1:02d}  "
                    + labels.get(
                        row["controller"],
                        row.get("displayLabel", row["controller"].upper()),
                    ),
                    font=medium,
                    fill=TEXT,
                )
                draw.text(
                    (x + 548, y + 13),
                    ("倾角" if zh else "TILT") + f"  {f['tiltDegrees']:.1f}°",
                    font=small,
                    fill=MUTED,
                )
                picture.paste(view, (x, y + 46))
                p = phase(row, f, t)
                color = (
                    RED
                    if p in ("fallen", "failed")
                    else GREEN if p == "passed" else ORANGE if p == "push" else MUTED
                )
                draw.text(
                    (x + 14, y + 365),
                    status_copy[p][0 if zh else 1],
                    font=small,
                    fill=color,
                )
                force = np.linalg.norm(f["externalForceWorldN"])
                draw.text(
                    (x + 550, y + 366),
                    ("推力" if zh else "FORCE") + f" {force:.1f} N",
                    font=tiny,
                    fill=ORANGE if force else MUTED,
                )
            # Global ruler and playhead use physical time, including slow motion and holds.
            left, right, top = 28, WIDTH - 28, 934
            draw.line((left, top, right, top), fill="#425b6a", width=4)
            for a, b in windows:
                draw.line(
                    (
                        left + a / end * (right - left),
                        top,
                        left + b / end * (right - left),
                        top,
                    ),
                    fill=ORANGE,
                    width=8,
                )
            cursor = left + t / end * (right - left)
            draw.ellipse((cursor - 5, top - 5, cursor + 5, top + 5), fill=TEXT)
            caption = (
                f"仅仿真 · 条件 {rows[0].get('originalCaseIndex', case_index)} · Y方向 {rows[0]['force']:+g} N · 网格 10 cm · 单个条件不代表总体效果"
                if zh
                else f"SIMULATION ONLY / CASE {rows[0].get('originalCaseIndex', case_index)} / Y PUSH {rows[0]['force']:+g} N / GRID 10 cm / ONE CASE IS NOT AGGREGATE QUALITY"
            )
            draw.text((28, 960), caption, font=tiny, fill=MUTED)
            mark = (
                "push"
                if any(
                    np.linalg.norm(frame_at(r, t)["externalForceWorldN"]) > 1e-8
                    for r in rows
                )
                else "final" if rate == 0 else None
            )
            if mark and mark not in saved:
                picture.save(out.with_name(out.stem + f"-{mark}.png"))
                saved.add(mark)
            ff.stdin.write(np.asarray(picture).tobytes())
    finally:
        if ff is not None:
            try:
                ff.stdin.close()
            except BrokenPipeError:
                pass
            finally:
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
                "presentation": {
                    "version": "workshop-v1",
                    "sourceTraceSha256": hashlib.sha256(
                        (evaluation / "episodes.jsonl").read_bytes()
                    ).hexdigest(),
                    "sceneSha256": hashlib.sha256(scene.read_bytes()).hexdigest(),
                    "fps": FPS,
                    "videoFrames": len(schedule),
                    "physicalDurationSeconds": end,
                    "videoDurationSeconds": len(schedule) / FPS,
                    "forceWindowsSeconds": windows,
                    "forceWindowBasis": "recorded-sample-support; not exact substep boundaries",
                    "runtime": {
                        "mujoco": mujoco.__version__,
                        "numpy": np.__version__,
                        "pillow": pillow_version,
                    },
                    "rendererSourceSha256": {
                        name: hashlib.sha256(
                            Path(__file__).with_name(name).read_bytes()
                        ).hexdigest()
                        for name in ("standing_render.py", "replay_presentation.py")
                    },
                    "slowMotionRate": 0.5,
                    "finalHoldSeconds": 1,
                    "camera": {
                        "lookat": camera.lookat.tolist(),
                        "distance": camera.distance,
                        "azimuth": camera.azimuth,
                        "elevation": camera.elevation,
                    },
                    "dynamicsRerun": False,
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scene", type=Path, required=True)
    parser.add_argument("--evaluation", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--case-index", type=int, required=True)
    parser.add_argument("--font")
    args = parser.parse_args()
    render(args.scene, args.evaluation, args.out, args.case_index, args.font)
