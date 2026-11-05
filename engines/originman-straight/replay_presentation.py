"""Render-only classroom styling and timeline; never integrates robot dynamics."""

import math

import mujoco
import numpy as np

FPS = 25


def force_windows(row):
    """Recorded sample intervals carrying a nonzero world force, not guessed labels."""
    windows = []
    previous = 0.0
    for frame in row["frames"]:
        t = float(frame["time"])
        if np.linalg.norm(frame["externalForceWorldN"]) > 1e-8:
            if windows and previous <= windows[-1][1] + 1e-8:
                windows[-1][1] = t
            else:
                windows.append([previous, t])
        previous = t
    return windows


def playback_schedule(rows, fps=FPS):
    end = max(row["seconds"] for row in rows)
    windows = force_windows(rows[0])
    start = max(0.0, windows[0][0] - 0.25) if windows else end
    stop = min(end, windows[-1][1] + 0.7) if windows else end
    result = []
    t = max(row["frames"][0]["time"] for row in rows)
    while t < end - 1e-8:
        slow = start <= t < stop
        result.append((t, 0.5 if slow else 1.0))
        t = min(end, t + (0.5 if slow else 1.0) / fps)
    result.extend([(end, 0.0)] * fps)  # One explicitly labelled final-frame hold.
    return result


def frame_at(row, t):
    times = [frame["time"] for frame in row["frames"]]
    index = max(0, int(np.searchsorted(times, t + 1e-8, side="right")) - 1)
    return row["frames"][index]


def phase(row, frame, t):
    if t >= row["seconds"] - 1e-8:
        if row["fallen"]:
            return "fallen"
        return "passed" if row["recoverySuccess"] else "failed"
    if np.linalg.norm(frame["externalForceWorldN"]) > 1e-8:
        return "push"
    windows = force_windows(row)
    first_force_time = next(
        (
            f["time"]
            for f in row["frames"]
            if np.linalg.norm(f["externalForceWorldN"]) > 1e-8
        ),
        math.inf,
    )
    if windows and frame["time"] >= first_force_time:
        return "observe"
    return "before"


def style_model(model):
    """Only visual arrays change; source XML and dynamics arrays stay untouched."""
    model.vis.headlight.ambient[:] = 0.2
    model.vis.headlight.diffuse[:] = 0.15
    model.vis.headlight.specular[:] = 0.1
    model.vis.quality.shadowsize = 2048
    model.vis.quality.offsamples = 4
    model.vis.global_.fovy = 34
    for i in range(model.nlight):
        model.light_type[i] = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL
        model.light_pos[i] = [0.5, -0.6, 3]
        model.light_dir[i] = [-0.08, 0.08, -1]
        model.light_ambient[i] = [0.16, 0.18, 0.2]
        model.light_diffuse[i] = [0.5, 0.48, 0.45]
        model.light_specular[i] = [0.2, 0.2, 0.2]
        model.light_castshadow[i] = True
    for i in range(model.ngeom):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) or ""
        if name == "ground":
            model.geom_rgba[i] = [0.68, 0.73, 0.76, 1]
        elif name == "line":
            model.geom_rgba[i, 3] = 0  # Old navigation stripe is not this task.
        elif name.endswith("_visual"):
            if any(part in name for part in ("body_link", "head_")):
                color = [0.88, 0.91, 0.92, 1]
            elif "ank_roll" in name:
                color = [0.19, 0.28, 0.34, 1]
            else:
                color = [0.38, 0.53, 0.62, 1]
            model.geom_rgba[i] = color


def camera_for(rows):
    camera = mujoco.MjvCamera()
    poses = np.array([f["qpos"][:3] for row in rows for f in row["frames"]])
    center = (poses[:, :2].min(axis=0) + poses[:, :2].max(axis=0)) / 2
    camera.lookat[:] = [*center, 0.18]
    # Shared fixed framing includes every recorded displacement; no per-policy chase.
    spread = np.ptp(poses[:, :2], axis=0).max()
    camera.distance = max(0.82, (spread + 0.36) / 1.4)
    camera.azimuth, camera.elevation = 15, -20
    return camera


def connector(scene, kind, width, start, end, rgba):
    if scene.ngeom >= scene.maxgeom:
        raise ValueError("replay decoration geometry capacity exceeded")
    geom = scene.geoms[scene.ngeom]
    mujoco.mjv_initGeom(
        geom,
        kind,
        np.zeros(3),
        np.zeros(3),
        np.eye(3).ravel(),
        np.array(rgba, dtype=np.float32),
    )
    mujoco.mjv_connector(
        geom, kind, width, np.array(start, dtype=float), np.array(end, dtype=float)
    )
    geom.category = mujoco.mjtCatBit.mjCAT_DECOR
    scene.ngeom += 1


def decorate(scene, frame):
    # A shadow-free fill separates the shell from its darker joints; the key
    # remains near vertical, so contact shadows do not overwhelm the floor.
    if scene.nlight < len(scene.lights):
        light = scene.lights[scene.nlight]
        light.type = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL
        light.dir[:] = [-0.6, 0.4, -0.5]
        light.ambient[:] = 0
        light.diffuse[:] = [0.14, 0.16, 0.18]
        light.specular[:] = 0.05
        light.castshadow, light.headlight = False, False
        light.attenuation[:] = [1, 0, 0]
        scene.nlight += 1
    for geom in scene.geoms[: scene.ngeom]:
        geom.specular = 0.08
        geom.shininess = 0.15
        geom.reflectance = 0
    for value in np.arange(-0.8, 0.81, 0.1):
        for start, end in (
            ([value, -0.8, 0.001], [value, 0.8, 0.001]),
            ([-0.8, value, 0.001], [0.8, value, 0.001]),
        ):
            connector(
                scene,
                mujoco.mjtGeom.mjGEOM_LINE,
                1.0,
                start,
                end,
                [0.55, 0.61, 0.64, 1],
            )
    # Small origin cross stays fixed, providing a displacement reference.
    for start, end in (
        ([-0.025, 0, 0.002], [0.025, 0, 0.002]),
        ([0, -0.025, 0.002], [0, 0.025, 0.002]),
    ):
        connector(
            scene,
            mujoco.mjtGeom.mjGEOM_CAPSULE,
            0.0012,
            start,
            end,
            [0.18, 0.37, 0.43, 1],
        )
    force = np.array(frame["externalForceWorldN"], dtype=float)
    magnitude = np.linalg.norm(force)
    if magnitude > 1e-8:
        direction = force / magnitude
        anchor = np.array(frame["qpos"][:3], dtype=float)
        # Tail and tip both sit outside the trunk, aligned with recorded world force.
        tip = anchor - direction * 0.09
        tail = anchor - direction * 0.26
        connector(
            scene, mujoco.mjtGeom.mjGEOM_ARROW, 0.009, tail, tip, [1, 0.37, 0.08, 1]
        )
