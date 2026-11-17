"""Live workshop presentation, shared with recorded replays; dynamics stay frozen."""

import mujoco

from replay_presentation import decorate, style_model

PRESENTATION_VERSION = "workshop-live-v1"
FRAME_WIDTH, FRAME_HEIGHT = 960, 540


def configure_display(model):
    style_model(model)
    model.vis.headlight.active = 1
    model.vis.global_.offwidth = max(1280, model.vis.global_.offwidth)
    model.vis.global_.offheight = max(720, model.vis.global_.offheight)
    # Interactive frames have a tighter latency budget than exported videos.
    model.vis.quality.offsamples = 2
    model.vis.quality.shadowsize = 1024


def default_camera():
    camera = mujoco.MjvCamera()
    camera.lookat[:] = [0, 0, 0.18]
    camera.distance = 0.82
    camera.azimuth = 15
    camera.elevation = -20
    return camera


def update_display(renderer, model, data, camera, option, force=None):
    renderer.update_scene(data, camera=camera, scene_option=option)
    decorate(
        renderer.scene,
        {
            "qpos": data.qpos,
            "externalForceWorldN": [0, 0, 0] if force is None else force,
        },
    )
