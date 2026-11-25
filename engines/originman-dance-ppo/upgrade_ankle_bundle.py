"""Build a new simulation bundle with the source ankle-pitch collision meshes."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import xml.etree.ElementTree as ET

from adapter import validate_bundle


def sha256(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def vector(attributes, key, default):
    return tuple(float(value) for value in attributes.get(key, default).split())


def source_ankle_mesh(source, name):
    link = source.find(f"./link[@name='{name}']")
    if link is None or len(link.findall("collision")) != 1:
        raise ValueError(f"{name}: expected one source collision")
    collision = link.find("collision")
    geometry = collision.find("geometry")
    mesh = collision.find("geometry/mesh")
    origin = collision.find("origin")
    pose = {} if origin is None else origin.attrib
    if (
        geometry is None
        or len(geometry) != 1
        or mesh is None
        or not mesh.get("filename")
        or vector(mesh.attrib, "scale", "1 1 1") != (1, 1, 1)
        or vector(pose, "xyz", "0 0 0") != (0, 0, 0)
        or vector(pose, "rpy", "0 0 0") != (0, 0, 0)
    ):
        raise ValueError(f"{name}: expected an unscaled source mesh at the link origin")
    return Path(mesh.attrib["filename"]).name


def upgrade(bundle, source_urdf, destination):
    bundle = bundle.absolute()
    destination = destination.absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Choose a new output directory")
    source_report = validate_bundle(bundle)
    manifest = source_report["manifest"]
    parent_scene = source_report["sceneSha256"]
    if sha256(source_urdf) != manifest.get("sourceUrdfSha256"):
        raise ValueError("Source URDF differs from the bundle's recorded digest")
    source = ET.parse(source_urdf)
    scene = ET.parse(
        bundle / "model" / "scene.xml",
        parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True)),
    )
    mesh_hashes = {}
    alternate_rotations = {"axisangle", "euler", "xyaxes", "zaxis"}
    for side in ("l", "r"):
        name = f"{side}_ank_pitch_link"
        filename = source_ankle_mesh(source, name)
        expected_mesh = manifest["meshSha256"].get(filename)
        source_mesh = source_urdf.parent.parent / "meshes" / filename
        if expected_mesh is None or sha256(source_mesh) != expected_mesh:
            raise ValueError(f"{name}: source collision mesh differs from the bundle")
        body = scene.find(f".//body[@name='{name}']")
        visual = None if body is None else body.find(f"./geom[@name='{name}_visual']")
        collision = None if body is None else body.find(f"./geom[@name='{name}_collision']")
        if collision is None or collision.get("type") != "box" or "size" not in collision.attrib:
            raise ValueError(f"{name}: expected a box collision in the parent scene")
        if visual is None or visual.get("type") != "mesh":
            raise ValueError(f"{name}: expected a mesh visual in the parent scene")
        mesh_name = visual.get("mesh")
        asset = scene.find(f"./asset/mesh[@name='{mesh_name}']")
        if (
            asset is None
            or asset.get("file") != f"meshes/{filename}"
            or vector(asset.attrib, "scale", "1 1 1") != (1, 1, 1)
            or "refpos" in asset.attrib
            or "refquat" in asset.attrib
            or not alternate_rotations.isdisjoint(visual.attrib)
            or vector(visual.attrib, "pos", "0 0 0") != (0, 0, 0)
            or vector(visual.attrib, "quat", "1 0 0 0") != (1, 0, 0, 0)
        ):
            raise ValueError(f"{name}: parent scene visual differs from the source collision")
        collision.set("type", "mesh")
        collision.set("mesh", mesh_name)
        collision.set("pos", visual.get("pos", "0 0 0"))
        collision.set("quat", visual.get("quat", "1 0 0 0"))
        del collision.attrib["size"]
        mesh_hashes[filename] = expected_mesh

    with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
        candidate = Path(staging) / "bundle"
        shutil.copytree(bundle, candidate)
        scene_path = candidate / "model" / "scene.xml"
        scene.write(scene_path, encoding="unicode")
        manifest["sceneSha256"] = sha256(scene_path)
        manifest["hardwareEligible"] = False
        manifest["sceneDerivation"] = {
            "kind": "source-ankle-pitch-collision",
            "parentSceneSha256": parent_scene,
            "sourceUrdfSha256": manifest["sourceUrdfSha256"],
            "meshSha256": mesh_hashes,
        }
        expected_collision = "ankle pitch links use source collision mesh convex hulls"
        if isinstance(manifest.get("collision"), str) and manifest["collision"]:
            expected_collision = manifest["collision"] + "; " + expected_collision
        manifest["collision"] = expected_collision
        (candidate / "model" / "model-manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n"
        )
        validate_bundle(candidate)
        candidate.rename(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path, help="Existing dance bundle")
    parser.add_argument(
        "--source-urdf", required=True, type=Path, help="Original package URDF or Xacro"
    )
    parser.add_argument("--out", required=True, type=Path, help="New bundle directory")
    args = parser.parse_args()
    try:
        upgrade(args.bundle, args.source_urdf, args.out)
    except (OSError, ValueError, ET.ParseError) as exc:
        parser.error(str(exc))
    print(args.out.absolute())
