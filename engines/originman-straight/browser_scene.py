"""Visual-only export of compiled MuJoCo geometry and world body poses."""
import base64
import numpy as np


def packed(array, dtype):
    return base64.b64encode(np.asarray(array, dtype=dtype).tobytes()).decode()


def scene_description(model):
    meshes = {}
    geoms = []
    for i in range(model.ngeom):
        if model.geom_group[i] == 3 or model.geom_rgba[i, 3] <= 0:
            continue
        kind = int(model.geom_type[i])
        if kind not in (0, 6, 7):
            raise ValueError("unsupported_browser_geometry")
        mesh = int(model.geom_dataid[i]) if kind == 7 else None
        if mesh is not None and str(mesh) not in meshes:
            va, vn = int(model.mesh_vertadr[mesh]), int(model.mesh_vertnum[mesh])
            fa, fn = int(model.mesh_faceadr[mesh]), int(model.mesh_facenum[mesh])
            meshes[str(mesh)] = {
                "vertices": packed(model.mesh_vert[va:va+vn], "<f4"),
                "faces": packed(model.mesh_face[fa:fa+fn], "<u4"),
            }
        geoms.append({
            "body": int(model.geom_bodyid[i]), "type": kind, "mesh": mesh,
            "size": model.geom_size[i].tolist(),
            "position": model.geom_pos[i].tolist(),
            "quaternion": model.geom_quat[i].tolist(),
            "rgba": model.geom_rgba[i].tolist(),
        })
    return {"version": 1, "bodyCount": model.nbody, "geoms": geoms, "meshes": meshes}


def visual_sample(env, info):
    data = env.physical.data
    return {
        "time": round(env.physical.time, 6),
        "bodies": np.concatenate((data.xpos, data.xquat), axis=1).round(7).ravel().tolist(),
        "force": info.get("externalForceWorldN", [0, 0, 0]),
    }
