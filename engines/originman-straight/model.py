"""Convert a caller-owned OriginMan package to a free-base MuJoCo model.

Retains every physical link's inertial tensor and all 20 revolute joints.
Collision boxes bound each original STL. Self collision is disabled in this
first adaptation; robot/ground contact is physical. No root forces or welds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

LEGS = [
    f"{side}_{joint}"
    for side in ("l", "r")
    for joint in ("hip_roll", "hip_pitch", "knee", "ank_pitch", "ank_roll")
]


def numbers(text, default="0 0 0"):
    return np.fromstring(text or default, sep=" ")


def fmt(a):
    return " ".join(f"{v:.10g}" for v in a)


def origin(node):
    o = node.find("origin")
    return (
        (np.zeros(3), np.eye(3))
        if o is None
        else (
            numbers(o.get("xyz")),
            Rotation.from_euler("xyz", numbers(o.get("rpy"))).as_matrix(),
        )
    )


def quat(matrix):
    q = Rotation.from_matrix(matrix).as_quat()
    return fmt(q[[3, 0, 1, 2]])


def stl_bounds(path):
    buf = path.read_bytes()
    count = struct.unpack_from("<I", buf, 80)[0]
    if len(buf) != 84 + 50 * count:
        raise ValueError("expected binary STL")
    dt = np.dtype(
        [("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attr", "<u2")]
    )
    v = (
        np.frombuffer(buf, dtype=dt, offset=84)
        .copy()["vertices"]
        .reshape(-1, 3)
        .astype(float)
    )
    if not np.isfinite(v).all():
        raise ValueError("nonfinite mesh")
    return v.min(0), v.max(0)


def prepare(source: Path, out: Path, foot_collision="box"):
    import xacro

    if foot_collision not in ("box", "convex-mesh"):
        raise ValueError("foot_collision must be box or convex-mesh")
    out.mkdir(parents=True, exist_ok=True)
    if source.is_file() and source.suffix == ".zip":
        unpack = out / "source"
        unpack.mkdir(exist_ok=True)
        with zipfile.ZipFile(source) as z:
            for entry in z.infolist():
                target = (unpack / entry.filename).resolve()
                if not target.is_relative_to(unpack.resolve()):
                    raise ValueError("unsafe archive path")
            z.extractall(unpack)
        roots = list(unpack.rglob("package.xml"))
        if len(roots) != 1:
            raise ValueError("expected exactly one ROS package")
        package = roots[0].parent
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
    else:
        package = source.resolve()
        digest = None
    xfile = package / "urdf/originman_urdf.urdf.xacro"
    text = xfile.read_text().replace("$(find originman_urdf)", str(package))
    expanded = xacro.parse(text)
    xacro.process_doc(expanded)
    robot = ET.fromstring(expanded.toxml())
    links = {l.get("name"): l for l in robot.findall("link")}
    children = {}
    for j in robot.findall("joint"):
        children.setdefault(j.find("parent").get("link"), []).append(j)
    root = ET.Element("mujoco", model="originman-straight")
    ET.SubElement(
        root, "compiler", angle="radian", inertiafromgeom="false", autolimits="true"
    )
    ET.SubElement(
        root, "option", timestep="0.002", gravity="0 0 -9.81", integrator="implicitfast"
    )
    defaults = ET.SubElement(root, "default")
    ET.SubElement(defaults, "joint", damping="0.03", armature="0.002")
    ET.SubElement(
        defaults, "geom", friction="0.8 0.02 0.001", condim="3", solref="0.01 1"
    )
    asset = ET.SubElement(root, "asset")
    world = ET.SubElement(root, "worldbody")
    ET.SubElement(world, "light", pos="0 -2 4", dir="0 0 -1")
    ET.SubElement(
        world,
        "geom",
        name="ground",
        type="plane",
        size="10 10 0.1",
        rgba="0.85 0.88 0.9 1",
        contype="2",
        conaffinity="1",
    )
    ET.SubElement(
        world,
        "geom",
        name="line",
        type="box",
        pos="2 0 0.0001",
        size="4 0.004 0.0001",
        rgba="0.2 0.4 0.8 1",
        contype="0",
        conaffinity="0",
    )
    actuators = ET.SubElement(root, "actuator")
    joints = []
    meshdir = out / "meshes"
    meshdir.mkdir(exist_ok=True)

    def add(linkname, parent, joint=None):
        link = links[linkname]
        p, rot = origin(joint) if joint is not None else (np.zeros(3), np.eye(3))
        body = ET.SubElement(parent, "body", name=linkname, pos=fmt(p), quat=quat(rot))
        if linkname == "body_link":
            ET.SubElement(body, "freejoint", name="root")
            ET.SubElement(body, "site", name="imu", pos="0 0 0.04", size="0.002")
        if joint is not None and joint.get("type") == "revolute":
            name = joint.get("name")
            limit = joint.find("limit")
            ET.SubElement(
                body,
                "joint",
                name=name,
                type="hinge",
                axis=joint.find("axis").get("xyz"),
                range=f"{limit.get('lower')} {limit.get('upper')}",
            )
            # These are simulation assumptions, NOT measured servo parameters.
            ET.SubElement(
                actuators,
                "position",
                name=name,
                joint=name,
                kp="8" if name in LEGS else "3",
                kv="0.18" if name in LEGS else "0.08",
                forcerange="-1.5 1.5",
                ctrlrange=f"{limit.get('lower')} {limit.get('upper')}",
            )
            joints.append(name)
        inertial = link.find("inertial")
        if inertial is not None:
            ip, ir = origin(inertial)
            a = inertial.find("inertia").attrib
            mat = np.array(
                [
                    [float(a["ixx"]), float(a["ixy"]), float(a["ixz"])],
                    [float(a["ixy"]), float(a["iyy"]), float(a["iyz"])],
                    [float(a["ixz"]), float(a["iyz"]), float(a["izz"])],
                ]
            )
            mat = ir @ mat @ ir.T
            ET.SubElement(
                body,
                "inertial",
                pos=fmt(ip),
                mass=inertial.find("mass").get("value"),
                fullinertia=fmt(mat[[0, 1, 2, 0, 0, 1], [0, 1, 2, 1, 2, 2]]),
            )
        visual = link.find("visual")
        if visual is not None:
            mesh = visual.find("geometry/mesh")
            if mesh is None:
                raise ValueError("expected mesh visual")
            file = package / "meshes" / Path(mesh.get("filename")).name
            shutil.copyfile(file, meshdir / file.name)
            vp, vr = origin(visual)
            lo, hi = stl_bounds(file)
            ET.SubElement(asset, "mesh", name=linkname, file="meshes/" + file.name)
            ET.SubElement(
                body,
                "geom",
                name=linkname + "_visual",
                type="mesh",
                mesh=linkname,
                pos=fmt(vp),
                quat=quat(vr),
                contype="0",
                conaffinity="0",
                group="2",
                rgba="0.45 0.58 0.72 1",
            )
            # Collision is derived from the COLLISION node, not assumed visual.
            collision = link.find("collision")
            cp, cr = origin(collision)
            cfile = (
                package
                / "meshes"
                / Path(collision.find("geometry/mesh").get("filename")).name
            )
            lo, hi = stl_bounds(cfile)
            collision_geometry = {
                "type": "box",
                "pos": fmt(cp + cr @ ((lo + hi) / 2)),
                "quat": quat(cr),
                "size": fmt(np.maximum((hi - lo) / 2, 0.0005)),
            }
            if linkname in ("l_ank_roll_link", "r_ank_roll_link"):
                # A semantic IK frame must not depend on mesh compilation's
                # principal axes or center of mass.
                ET.SubElement(
                    body,
                    "site",
                    name=linkname + "_foot_frame",
                    pos=collision_geometry["pos"],
                    quat=quat(cr),
                    size="0.001",
                )
                if foot_collision == "convex-mesh":
                    shutil.copyfile(cfile, meshdir / cfile.name)
                    meshname = linkname + "_contact_mesh"
                    ET.SubElement(
                        asset, "mesh", name=meshname, file="meshes/" + cfile.name
                    )
                    collision_geometry = {
                        "type": "mesh",
                        "mesh": meshname,
                        "pos": fmt(cp),
                        "quat": quat(cr),
                    }
            ET.SubElement(
                body,
                "geom",
                name=linkname + "_collision",
                **collision_geometry,
                contype="1",
                conaffinity="2",
                group="3",
                rgba="0.8 0.4 0.2 0.25",
            )
        for child in children.get(linkname, []):
            add(child.find("child").get("link"), body, child)

    add("body_link", world)
    sensors = ET.SubElement(root, "sensor")
    ET.SubElement(sensors, "gyro", name="gyro", site="imu")
    ET.SubElement(sensors, "accelerometer", name="accel", site="imu")
    path = out / "scene.xml"
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding="unicode")
    manifest = {
        "sourceZipSha256": digest,
        "sourceUrdfSha256": hashlib.sha256(xfile.read_bytes()).hexdigest(),
        "joints": joints,
        "legJoints": LEGS,
        "floatingBase": True,
        "externalRootForces": False,
        "collision": "STL bounding boxes except selected foot collision; ground contact only; self collision disabled",
        "footCollision": foot_collision,
        "footCollisionScope": "convex hull of source collision mesh when selected; not concave decomposition or measured sole compliance",
        "actuators": {
            "kp": 8,
            "kv": 0.18,
            "effortLimitNm": 1.5,
            "status": "unmeasured simulation assumptions",
        },
        "hardwareEligible": False,
        "meshSha256": {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(meshdir.glob("*.STL"))
        },
    }
    (out / "model-manifest.json").write_text(json.dumps(manifest, indent=2))
    return path


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--foot-collision", choices=["box", "convex-mesh"], default="box")
    a = p.parse_args()
    print(prepare(a.source, a.out, a.foot_collision))
