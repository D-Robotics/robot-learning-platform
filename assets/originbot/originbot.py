"""OriginBot 标定单一源（MuJoCo Menagerie 模式）。

calibration.json 是唯一事实源；本模块把它加载成 Python 常量并生成两份
MJCF（可视仿真版 / MJX 训练版）共享的机器人本体 XML 片段。

只依赖标准库，services/mujoco-web 与 engines/mjx-adapter 都可以无第三方
依赖地 import（各自通过 __file__ 相对定位仓库根）。
"""

import json
import pathlib

ASSET_DIR = pathlib.Path(__file__).resolve().parent
_CALIB = json.loads((ASSET_DIR / "calibration.json").read_text(encoding="utf-8"))

BASE = _CALIB["base"]
WHEELS = _CALIB["wheels"]
CASTER = _CALIB["caster"]

# Flattened scalars both MJCF variants need. Import these directly instead of
# re-typing the numbers (that is how the two copies drifted apart historically).
BASE_HEIGHT = float(BASE["height"])
WHEEL_RADIUS = float(WHEELS["radius"])
TRACK_WIDTH = float(WHEELS["trackWidth"])
WHEEL_KV = float(WHEELS["servoKv"])
MAX_WHEEL_SPEED = float(WHEELS["maxWheelSpeed"])


def _wheel_body(side, offset_y):
    """One driven wheel MJCF body; side is 'left' or 'right'."""
    sign = 1.0 if side == "left" else -1.0
    return (
        '<body name="{side}_wheel" pos="0 {offset_y} {offset_z}">'
        '<joint name="{side}_wheel_joint" type="hinge" axis="0 1 0" damping="{damping}"/>'
        '<geom name="{side}_wheel_geom" type="cylinder" quat="{quat}" '
        'size="{radius} {half_width}" mass="{mass}" friction="{friction}" rgba="{rgba}"/>'
        "</body>"
    ).format(
        side=side,
        offset_y=round(sign * float(offset_y), 4),
        offset_z=float(WHEELS["offsetZ"]),
        damping=float(WHEELS["damping"]),
        quat=WHEELS["quat"],
        radius=float(WHEELS["radius"]),
        half_width=float(WHEELS["halfWidth"]),
        mass=float(WHEELS["mass"]),
        friction=WHEELS["friction"],
        rgba=WHEELS["rgba"],
    )


def wheel_bodies_template():
    """Both wheel bodies with the mjx-adapter joint naming (wheel_left_hinge).

    The mujoco-web variant names joints left_wheel_joint; the MJX training
    MJCF historically used wheel_left_hinge. Actuator/step code in each
    consumer references its own names, so both variants are provided.
    """
    parts = []
    for side in ("left", "right"):
        sign = 1.0 if side == "left" else -1.0
        parts.append(
            '<body name="wheel_{side}" pos="0 {offset_y} {offset_z}">'
            '<joint name="wheel_{side}_hinge" type="hinge" axis="0 1 0" damping="{damping}"/>'
            '<geom name="wheel_{side}_geom" type="cylinder" quat="{quat}" '
            'size="{radius} {half_width}" mass="{mass}" friction="{friction}"/>'
            "</body>".format(
                side=side,
                offset_y=round(sign * float(WHEELS["offsetY"]), 4),
                offset_z=float(WHEELS["offsetZ"]),
                damping=float(WHEELS["damping"]),
                quat=WHEELS["quat"],
                radius=float(WHEELS["radius"]),
                half_width=float(WHEELS["halfWidth"]),
                mass=float(WHEELS["mass"]),
                friction=WHEELS["friction"],
            )
        )
    return "\n      ".join(parts)


def wheel_actuators(naming="joint_first", forcerange=None):
    """Velocity-servo actuators for both driven wheels (shared by variants).

    naming="joint_first" targets left_wheel_joint with actuator names
    left/right_wheel (mujoco-web visual MJCF); naming="wheel_first" targets
    wheel_left_hinge with actuator names wheel_left/wheel_right (mjx-adapter
    training MJCF — ctrl is written positionally, left first, in both).

    forcerange caps the servo torque (forcelimited). The training MJCF needs
    it: the CG sits nearly above the wheel axle (the caster is lightly
    loaded), so an uncapped kv*error servo torque wheelies the robot at
    spin-up; a real gearmotor saturates at its stall torque. None keeps the
    historical (unlimited) output for consumers that have not opted in.
    """
    left_joint = "left_wheel_joint" if naming == "joint_first" else "wheel_left_hinge"
    right_joint = "right_wheel_joint" if naming == "joint_first" else "wheel_right_hinge"
    left_name = "left_wheel" if naming == "joint_first" else "wheel_left"
    right_name = "right_wheel" if naming == "joint_first" else "wheel_right"
    ctrl = WHEELS["ctrlRange"]
    limits = (
        'forcelimited="true" forcerange="{} {}" '.format(-float(forcerange), float(forcerange))
        if forcerange is not None else ""
    )
    return (
        '<velocity {limits}name="{left_name}" joint="{left_joint}" kv="{kv}" '
        'ctrllimited="true" ctrlrange="{lo} {hi}"/>'
        '<velocity {limits}name="{right_name}" joint="{right_joint}" kv="{kv}" '
        'ctrllimited="true" ctrlrange="{lo} {hi}"/>'
    ).format(
        limits=limits,
        left_name=left_name, right_name=right_name,
        left_joint=left_joint, right_joint=right_joint,
        kv=WHEEL_KV, lo=ctrl[0], hi=ctrl[1],
    )


def robot_bodies(caster_offset_z, with_top=True):
    """Chassis + top + both wheels + caster, shared by both MJCF variants.

    caster_offset_z: visual variant keeps the caster airborne (-0.07); the MJX
    training variant lowers it to a real 3-point stance (-0.115) — see
    assets/originbot/README.md for why this difference is intentional.
    with_top: the visual model carries a top cylinder; the training MJCF
    (chassis + wheels + caster only) keeps its historical mass distribution.
    """
    chassis_size = BASE["chassisSize"]
    top_size = BASE["topSize"]
    return (
        '<geom name="chassis" type="box" size="{cs_x} {cs_y} {cs_z}" mass="{cs_mass}" rgba="{cs_rgba}"/>'
        '{top}'
        "{left}{right}"
        '<geom name="caster" type="sphere" pos="{caster_x} 0 {caster_z}" size="{caster_s}" '
        'mass="{caster_m}" friction=".8 .01 .001" rgba=".15 .15 .18 1"/>'
    ).format(
        cs_x=chassis_size[0], cs_y=chassis_size[1], cs_z=chassis_size[2],
        cs_mass=float(BASE["chassisMass"]), cs_rgba=BASE["chassisRgba"],
        top=(
            '<geom name="top" type="cylinder" pos="0 0 {t_z}" size="{t_r} {t_h}" '
            'mass="{t_mass}" rgba="{t_rgba}"/>'.format(
                t_z=float(BASE["topPosZ"]), t_r=float(top_size[0]), t_h=float(top_size[1]),
                t_mass=float(BASE["topMass"]), t_rgba=BASE["topRgba"],
            ) if with_top else ""
        ),
        left=_wheel_body("left", WHEELS["offsetY"]),
        right=_wheel_body("right", WHEELS["offsetY"]),
        caster_x=float(CASTER["posX"]), caster_z=round(float(caster_offset_z), 4),
        caster_s=float(CASTER["size"]), caster_m=float(CASTER["mass"]),
    )
