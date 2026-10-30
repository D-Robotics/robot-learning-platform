"""STL bottom-band support diagnostic; local Z is not a measured contact surface."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.spatial import ConvexHull


def audit(path):
    raw = path.read_bytes()
    dtype = np.dtype(
        [("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attr", "<u2")]
    )
    count = int.from_bytes(raw[80:84], "little")
    if len(raw) != 84 + 50 * count:
        raise ValueError("invalid binary STL")
    vertices = np.frombuffer(raw, dtype=dtype, offset=84)["vertices"].reshape(-1, 3)
    low, high = vertices.min(axis=0), vertices.max(axis=0)
    rectangle = float(np.prod((high - low)[:2]))
    bands = []
    for height in [0.0005, 0.001, 0.002, 0.003]:
        xy = np.unique(vertices[vertices[:, 2] <= low[2] + height, :2], axis=0)
        hull = ConvexHull(xy)
        bands.append(
            {
                "bandHeightM": height,
                "convexHullAreaM2": hull.volume,
                "areaRatioToBoundingRectangle": hull.volume / rectangle,
                "xyExtentM": np.ptp(xy, axis=0).tolist(),
            }
        )
    return {
        "mesh": path.name,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bboxExtentM": (high - low).tolist(),
        "bottomBands": bands,
        "scope": "local STL Z bottom-band convex hull; not an exact concave sole, pressure footprint, compliance measurement or proof of hardware stability",
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--meshes", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    with a.out.open("x") as f:
        json.dump(
            [audit(a.meshes / f"{s}_ank_roll_link.STL") for s in ["l", "r"]],
            f,
            indent=2,
        )
