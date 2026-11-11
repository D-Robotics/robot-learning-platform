"""Render an existing simulation trajectory; never runs or controls a robot."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

os.environ.setdefault('MUJOCO_GL', 'egl')
import mujoco
import numpy as np


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scene', type=Path, required=True)
    parser.add_argument('--replay', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('output already exists')
    executable = shutil.which('ffmpeg')
    if not executable:
        raise ValueError('ffmpeg is required to render a replay')
    model = mujoco.MjModel.from_xml_path(str(args.scene))
    data = mujoco.MjData(model)
    with np.load(args.replay, allow_pickle=False) as archive:
        frames = archive['qpos']
        if frames.ndim != 2 or frames.shape[1] != model.nq or not 2 <= len(frames) <= 100000 or not np.isfinite(frames).all():
            raise ValueError('replay does not match scene qpos contract')
    camera = mujoco.MjvCamera()
    camera.lookat[:] = (0, 0, 0.32)
    camera.distance = 1.25
    camera.azimuth = 135
    camera.elevation = -12
    model.vis.global_.offwidth = 640
    model.vis.global_.offheight = 480
    model.vis.headlight.ambient[:] = (0.4, 0.4, 0.4)
    model.vis.headlight.diffuse[:] = (0.8, 0.8, 0.8)
    renderer = mujoco.Renderer(model, height=480, width=640)
    writer = subprocess.Popen([
        executable, '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', '640x480', '-r', '50', '-i', 'pipe:0', '-an', '-c:v',
        'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', str(args.output),
    ], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for qpos in frames:
            data.qpos[:] = qpos
            mujoco.mj_forward(model, data)
            renderer.update_scene(data, camera=camera)
            writer.stdin.write(renderer.render().tobytes())
        writer.stdin.close()
        errors = writer.stderr.read()
        if writer.wait(timeout=30) != 0:
            raise RuntimeError('replay encoding failed: ' + errors.decode(errors='replace')[-1000:])
    finally:
        renderer.close()
        if writer.poll() is None:
            writer.kill()
            writer.wait(timeout=5)
    receipt = {
        'source': 'recorded-simulation-qpos', 'physicalRobot': False,
        'sceneSha256': digest(args.scene), 'replaySha256': digest(args.replay),
        'videoSha256': digest(args.output), 'frames': len(frames), 'fps': 50,
        'durationSeconds': len(frames) / 50,
        'renderSettings': {'cameraAzimuth': 135, 'cameraElevation': -12,
                           'cameraDistance': 1.25, 'headlightAmbient': 0.4,
                           'headlightDiffuse': 0.8},
    }
    args.output.with_suffix('.receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
