"""OriginMan lower-body joint labels used by the experiment environment."""

LEGS = [
    f"{side}_{joint}"
    for side in ("l", "r")
    for joint in ("hip_roll", "hip_pitch", "knee", "ank_pitch", "ank_roll")
]

