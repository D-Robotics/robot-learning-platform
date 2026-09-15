from dataclasses import dataclass
import json
import math
import pathlib
import re
import sys

import mujoco

# assets/originbot is the single source of truth for the shared robot body
# calibration (Menagerie-style); add the repo root so the asset module stays
# importable without installing anything.
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
import assets.originbot.originbot as _originbot  # noqa: E402


@dataclass(frozen=True)
class ModelDefinition:
    key: str
    name: str
    description: str
    actuator_names: tuple[str, ...]
    xml: str
    initial_qpos: tuple[float, ...]
    # Geometry and sensor metadata are kept beside the MJCF so route handlers
    # cannot silently drift from the calibrated robot model.
    wheel_radius: float | None = None
    track_width: float | None = None
    max_wheel_speed: float | None = None
    lidar_angles: tuple[float, ...] = ()
    lidar_range_max: float | None = None
    # Provenance: "builtin" models ship with the platform; "registry" models
    # are deployer-reviewed entries from services/mujoco-web/registry/.
    source: str = "builtin"


CARTPOLE_XML = r"""
<mujoco model="cartpole">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.01" gravity="0 0 -9.81" integrator="RK4"/>
  <visual>
    <global offwidth="640" offheight="480"/>
    <quality shadowsize="2048"/>
  </visual>
  <asset>
    <texture name="checker" type="2d" builtin="checker" rgb1="0.14 0.17 0.21" rgb2="0.08 0.09 0.12" width="512" height="512"/>
    <material name="floor" texture="checker" texrepeat="8 8" reflectance="0.18"/>
  </asset>
  <worldbody>
    <light name="key" pos="0 -3 5" dir="0 0 -1" directional="true" diffuse="0.85 0.88 1"/>
    <geom name="floor" type="plane" size="5 5 0.05" material="floor"/>
    <body name="cart" pos="0 0 0.18">
      <joint name="slider" type="slide" axis="1 0 0" range="-1.6 1.6" limited="true" damping="0.8"/>
      <geom name="cart_box" type="box" size="0.25 0.2 0.12" rgba="0.12 0.55 0.95 1"/>
      <geom name="wheel_left" type="cylinder" pos="0 -0.22 -0.08" quat="0.707 0.707 0 0" size="0.07 0.04" rgba="0.05 0.06 0.08 1"/>
      <geom name="wheel_right" type="cylinder" pos="0 0.22 -0.08" quat="0.707 0.707 0 0" size="0.07 0.04" rgba="0.05 0.06 0.08 1"/>
      <body name="pole" pos="0 0 0.22">
        <joint name="hinge" type="hinge" axis="0 1 0" damping="0.02"/>
        <geom name="pole_rod" fromto="0 0 0 0 0 1.2" type="capsule" size="0.045" rgba="0.98 0.55 0.18 1"/>
        <geom name="pole_tip" pos="0 0 1.2" type="sphere" size="0.12" rgba="1 0.74 0.25 1"/>
      </body>
    </body>
    <site name="center" pos="0 0 0.01" size="0.02" rgba="0.2 0.8 1 1"/>
    <camera name="overview" pos="3 -4 2.5" xyaxes="0.8 0.6 0 -0.3 0.4 0.85"/>
  </worldbody>
  <actuator>
    <motor name="cart_force" joint="slider" gear="80" ctrllimited="true" ctrlrange="-1 1"/>
    <motor name="pole_torque" joint="hinge" gear="2" ctrllimited="true" ctrlrange="-1 1"/>
  </actuator>
</mujoco>
"""


DOUBLE_PENDULUM_XML = r"""
<mujoco model="double_pendulum">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.008" gravity="0 0 -9.81" integrator="RK4"/>
  <visual>
    <global offwidth="640" offheight="480"/>
    <quality shadowsize="2048"/>
  </visual>
  <asset>
    <texture name="checker" type="2d" builtin="checker" rgb1="0.14 0.17 0.21" rgb2="0.08 0.09 0.12" width="512" height="512"/>
    <material name="floor" texture="checker" texrepeat="8 8" reflectance="0.18"/>
  </asset>
  <worldbody>
    <light name="key" pos="0 -3 5" dir="0 0 -1" directional="true" diffuse="0.85 0.88 1"/>
    <geom name="floor" type="plane" size="5 5 0.05" material="floor"/>
    <body name="upper_arm" pos="0 0 1.7">
      <joint name="shoulder" type="hinge" axis="0 1 0" damping="0.015"/>
      <geom name="upper_rod" fromto="0 0 0 0 0 -0.9" type="capsule" size="0.055" rgba="0.12 0.72 0.62 1"/>
      <geom name="elbow" pos="0 0 -0.9" type="sphere" size="0.11" rgba="0.33 0.92 0.82 1"/>
      <body name="lower_arm" pos="0 0 -0.9">
        <joint name="elbow_hinge" type="hinge" axis="0 1 0" damping="0.01"/>
        <geom name="lower_rod" fromto="0 0 0 0 0 -0.8" type="capsule" size="0.05" rgba="0.98 0.38 0.42 1"/>
        <geom name="weight" pos="0 0 -0.8" type="sphere" size="0.13" rgba="1 0.62 0.32 1"/>
      </body>
    </body>
    <camera name="overview" pos="2.8 -4 1.6" xyaxes="0.82 0.57 0 -0.18 0.26 0.95"/>
  </worldbody>
  <actuator>
    <motor name="shoulder_torque" joint="shoulder" gear="2" ctrllimited="true" ctrlrange="-1 1"/>
    <motor name="elbow_torque" joint="elbow_hinge" gear="2" ctrllimited="true" ctrlrange="-1 1"/>
  </actuator>
</mujoco>
"""

ORIGINBOT_XML = r"""
<mujoco model="originbot">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.01" gravity="0 0 -9.81" integrator="implicitfast"/>
  <visual><global offwidth="960" offheight="640"/></visual>
  <asset>
    <texture name="floor_tex" type="2d" builtin="checker" rgb1="0.16 0.18 0.22" rgb2="0.08 0.09 0.12" width="512" height="512"/>
    <material name="floor" texture="floor_tex" texrepeat="12 12"/>
  </asset>
  <worldbody>
    <light name="key" pos="2 -3 5" dir="-0.2 0.3 -1" directional="true" diffuse="0.9 0.9 1"/>
    <geom name="floor" type="plane" size="8 8 .05" material="floor"/>
    <geom name="wall_n" type="box" pos="0 4 .25" size="4 .08 .25" rgba=".25 .3 .38 1"/>
    <geom name="wall_s" type="box" pos="0 -4 .25" size="4 .08 .25" rgba=".25 .3 .38 1"/>
    <geom name="wall_e" type="box" pos="4 0 .25" size=".08 4 .25" rgba=".25 .3 .38 1"/>
    <geom name="wall_w" type="box" pos="-4 0 .25" size=".08 4 .25" rgba=".25 .3 .38 1"/>
    <geom name="obstacle_a" type="box" pos="1.2 .8 .2" size=".28 .45 .2" rgba=".62 .28 .18 1"/>
    <geom name="obstacle_b" type="cylinder" pos="-1.0 -1.1 .22" size=".32 .22" rgba=".62 .28 .18 1"/>
    <body name="base" pos="0 0 .16">
      <freejoint name="base_free"/>
      {ROBOT_BODIES}
      <!-- Keep odometry at the base origin; the IMU is intentionally mounted
           above it and must not be used as the odom position reference. -->
      <site name="odom" pos="0 0 0" size=".012" rgba="0 1 0 1"/>
      <site name="imu" pos="0 0 .18" size=".015" rgba="1 0 0 1"/>
      <!-- Site local +Z is the ray direction.  Nineteen rays cover a 180
           degree forward fan at 10 degree increments (-90..+90). -->
      <site name="ray_00" pos=".30 0 .12" quat=".7071 .7071 0 0" size=".01"/>
      <site name="ray_01" pos=".30 0 .12" quat=".7071 .6964 .1228 0" size=".01"/>
      <site name="ray_02" pos=".30 0 .12" quat=".7071 .6645 .2418 0" size=".01"/>
      <site name="ray_03" pos=".30 0 .12" quat=".7071 .6124 .3536 0" size=".01"/>
      <site name="ray_04" pos=".30 0 .12" quat=".7071 .5425 .4545 0" size=".01"/>
      <site name="ray_05" pos=".30 0 .12" quat=".7071 .4545 .5425 0" size=".01"/>
      <site name="ray_06" pos=".30 0 .12" quat=".7071 .3536 .6124 0" size=".01"/>
      <site name="ray_07" pos=".30 0 .12" quat=".7071 .2418 .6645 0" size=".01"/>
      <site name="ray_08" pos=".30 0 .12" quat=".7071 .1228 .6964 0" size=".01"/>
      <site name="ray_09" pos=".30 0 .12" quat=".7071 0 .7071 0" size=".01"/>
      <site name="ray_10" pos=".30 0 .12" quat=".7071 -.1228 .6964 0" size=".01"/>
      <site name="ray_11" pos=".30 0 .12" quat=".7071 -.2418 .6645 0" size=".01"/>
      <site name="ray_12" pos=".30 0 .12" quat=".7071 -.3536 .6124 0" size=".01"/>
      <site name="ray_13" pos=".30 0 .12" quat=".7071 -.4545 .5425 0" size=".01"/>
      <site name="ray_14" pos=".30 0 .12" quat=".7071 -.5425 .4545 0" size=".01"/>
      <site name="ray_15" pos=".30 0 .12" quat=".7071 -.6124 .3536 0" size=".01"/>
      <site name="ray_16" pos=".30 0 .12" quat=".7071 -.6645 .2418 0" size=".01"/>
      <site name="ray_17" pos=".30 0 .12" quat=".7071 -.6964 .1228 0" size=".01"/>
      <site name="ray_18" pos=".30 0 .12" quat=".7071 -.7071 0 0" size=".01"/>
      <!-- Forward RGB/depth camera. MuJoCo cameras look along local -Z;
           local X=-robot Y and a 15 degree-down local Y make -Z point
           slightly down along robot +X, so the floor and obstacles stay in
           view. The raw endpoint converts metric depth to millimetres. -->
      <camera name="depth_camera" pos=".34 0 .25" xyaxes="0 -1 0 .259 0 .966" fovy="78"/>
    </body>
    <camera name="overview" pos="3.8 -5.2 3.4" xyaxes=".81 .59 0 -.32 .44 .84"/>
  </worldbody>
  <sensor>
    <framequat name="imu_orientation" objtype="site" objname="imu"/>
    <gyro name="imu_gyro" site="imu"/>
    <accelerometer name="imu_accel" site="imu"/>
    <framepos name="odom_position" objtype="site" objname="odom"/>
    <rangefinder name="lidar_00" site="ray_00" cutoff="4"/>
    <rangefinder name="lidar_01" site="ray_01" cutoff="4"/>
    <rangefinder name="lidar_02" site="ray_02" cutoff="4"/>
    <rangefinder name="lidar_03" site="ray_03" cutoff="4"/>
    <rangefinder name="lidar_04" site="ray_04" cutoff="4"/>
    <rangefinder name="lidar_05" site="ray_05" cutoff="4"/>
    <rangefinder name="lidar_06" site="ray_06" cutoff="4"/>
    <rangefinder name="lidar_07" site="ray_07" cutoff="4"/>
    <rangefinder name="lidar_08" site="ray_08" cutoff="4"/>
    <rangefinder name="lidar_09" site="ray_09" cutoff="4"/>
    <rangefinder name="lidar_10" site="ray_10" cutoff="4"/>
    <rangefinder name="lidar_11" site="ray_11" cutoff="4"/>
    <rangefinder name="lidar_12" site="ray_12" cutoff="4"/>
    <rangefinder name="lidar_13" site="ray_13" cutoff="4"/>
    <rangefinder name="lidar_14" site="ray_14" cutoff="4"/>
    <rangefinder name="lidar_15" site="ray_15" cutoff="4"/>
    <rangefinder name="lidar_16" site="ray_16" cutoff="4"/>
    <rangefinder name="lidar_17" site="ray_17" cutoff="4"/>
    <rangefinder name="lidar_18" site="ray_18" cutoff="4"/>
  </sensor>
  <actuator>
    <!-- MuJoCo's velocity actuator models the embedded wheel controller.  Its
         control is wheel rad/s; app.py still returns the resulting actuator
         force so the command-to-torque path remains observable. -->
    {WHEEL_ACTUATORS}
  </actuator>
</mujoco>
""".format(
    ROBOT_BODIES=_originbot.robot_bodies(caster_offset_z=-0.07),
    WHEEL_ACTUATORS=_originbot.wheel_actuators(),
)


MODEL_DEFINITIONS = {
    "cartpole": ModelDefinition(
        key="cartpole",
        name="Cart-pole",
        description="A controllable cart and hinged pole. Push the cart and watch the coupled dynamics.",
        actuator_names=("cart force", "pole torque"),
        xml=CARTPOLE_XML,
        initial_qpos=(0.0, 0.34),
    ),
    "double-pendulum": ModelDefinition(
        key="double-pendulum",
        name="Double pendulum",
        description="A chaotic two-link pendulum with torque control at both joints.",
        actuator_names=("shoulder torque", "elbow torque"),
        xml=DOUBLE_PENDULUM_XML,
        initial_qpos=(1.05, -0.72),
    ),
    "originbot": ModelDefinition(
        key="originbot",
        name="OriginBot X5",
        description="差速轮 OriginBot：底盘、双驱轮、万向轮、19 束前向激光与障碍场景。",
        actuator_names=("左轮角速度", "右轮角速度"),
        xml=ORIGINBOT_XML,
        initial_qpos=(0.0, 0.0, 0.17, 1.0, 0.0, 0.0, 0.0),
        wheel_radius=0.09,
        track_width=0.50,
        max_wheel_speed=8.0,
        lidar_angles=tuple(float(-1.5707963267948966 + i * 0.17453292519943295) for i in range(19)),
        lidar_range_max=4.0,
    ),
}


# ---------------------------------------------------------------------------
# Deployer model registry
#
# The registry is a filesystem whitelist, reviewed like code: entries land
# here through deployer config management (git/scp/ansible), never through a
# network upload endpoint. See registry/README.md for the entry contract.
# Every entry is shape-validated AND compiled with real MuJoCo at import
# time; an invalid entry raises so the service refuses to start instead of
# serving a broken model (fail-closed).
# ---------------------------------------------------------------------------

_REGISTRY_DIR = pathlib.Path(__file__).resolve().parent / "registry"
_KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
# Matches the StepRequest controls cap in app.py.
_MAX_ACTUATORS = 32


def _registry_error(path: pathlib.Path, reason: str) -> ValueError:
    return ValueError(f"mujoco-web model registry {path.name}: {reason}")


def _registry_string(path: pathlib.Path, raw: dict, field: str, max_length: int) -> str:
    value = raw.get(field)
    if not isinstance(value, str):
        raise _registry_error(path, f"'{field}' must be a string")
    value = value.strip()
    if not value or len(value) > max_length:
        raise _registry_error(path, f"'{field}' must be 1..{max_length} characters")
    return value


def _registry_number(
    path: pathlib.Path,
    raw: dict,
    field: str,
    *,
    minimum: float,
    required: bool,
) -> float | None:
    if field not in raw:
        if required:
            raise _registry_error(path, f"'{field}' is required")
        return None
    value = raw[field]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _registry_error(path, f"'{field}' must be a number")
    value = float(value)
    if not math.isfinite(value) or value < minimum:
        raise _registry_error(path, f"'{field}' must be a finite number >= {minimum}")
    return value


def _load_registry_entry(path: pathlib.Path) -> ModelDefinition:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _registry_error(path, f"cannot read JSON ({exc})") from exc
    if not isinstance(raw, dict):
        raise _registry_error(path, "top-level value must be a JSON object")

    key = _registry_string(path, raw, "key", 32)
    if not _KEY_PATTERN.fullmatch(key):
        raise _registry_error(path, "'key' must match [a-z0-9][a-z0-9-]* (max 32)")
    name = _registry_string(path, raw, "name", 64)
    description = _registry_string(path, raw, "description", 400)

    xml = raw.get("xml")
    if not isinstance(xml, str) or not xml.strip() or len(xml) > 200_000:
        raise _registry_error(path, "'xml' must be a non-empty MJCF string (max 200000 characters)")

    actuator_raw = raw.get("actuator_names")
    if not isinstance(actuator_raw, list) or not 1 <= len(actuator_raw) <= _MAX_ACTUATORS:
        raise _registry_error(path, f"'actuator_names' must be a list of 1..{_MAX_ACTUATORS} names")
    actuator_names: list[str] = []
    for item in actuator_raw:
        if not isinstance(item, str) or not item.strip() or len(item) > 64:
            raise _registry_error(path, "actuator names must be 1..64 character strings")
        actuator_names.append(item.strip())

    qpos_raw = raw.get("initial_qpos", [])
    if not isinstance(qpos_raw, list) or len(qpos_raw) > 64:
        raise _registry_error(path, "'initial_qpos' must be a list of at most 64 numbers")
    initial_qpos: list[float] = []
    for item in qpos_raw:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            raise _registry_error(path, "'initial_qpos' entries must be finite numbers")
        initial_qpos.append(float(item))

    wheel_radius = _registry_number(path, raw, "wheel_radius", minimum=1e-4, required=False)
    track_width = _registry_number(path, raw, "track_width", minimum=1e-4, required=False)
    max_wheel_speed = _registry_number(path, raw, "max_wheel_speed", minimum=1e-4, required=False)
    lidar_range_max = _registry_number(path, raw, "lidar_range_max", minimum=1e-4, required=False)
    lidar_raw = raw.get("lidar_angles", [])
    if not isinstance(lidar_raw, list) or len(lidar_raw) > 64:
        raise _registry_error(path, "'lidar_angles' must be a list of at most 64 angles")
    lidar_angles: list[float] = []
    for item in lidar_raw:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            raise _registry_error(path, "'lidar_angles' entries must be finite numbers")
        lidar_angles.append(float(item))
    if (lidar_angles or lidar_range_max is not None) and wheel_radius is None:
        raise _registry_error(
            path,
            "'lidar_angles'/'lidar_range_max' require 'wheel_radius' (differential-drive metadata is one group)",
        )

    # Compile with real MuJoCo before the definition is accepted. This is the
    # fail-closed gate: route handlers index actuator metadata by position, so
    # a compiled actuator count that disagrees with actuator_names means the
    # entry lies about the robot and must stop the service, not serve it.
    try:
        compiled = mujoco.MjModel.from_xml_string(xml)
    except Exception as exc:  # mujoco raises ValueError on bad MJCF
        raise _registry_error(path, f"MJCF does not compile ({exc})") from exc
    if compiled.nu != len(actuator_names):
        raise _registry_error(
            path,
            f"'actuator_names' has {len(actuator_names)} entries but the MJCF exposes {compiled.nu} actuators",
        )
    if compiled.nq < len(initial_qpos):
        raise _registry_error(
            path,
            f"'initial_qpos' has {len(initial_qpos)} values but the MJCF has {compiled.nq} position DOFs",
        )

    return ModelDefinition(
        key=key,
        name=name,
        description=description,
        actuator_names=tuple(actuator_names),
        xml=xml,
        initial_qpos=tuple(initial_qpos),
        wheel_radius=wheel_radius,
        track_width=track_width,
        max_wheel_speed=max_wheel_speed,
        lidar_angles=tuple(lidar_angles),
        lidar_range_max=lidar_range_max,
        source="registry",
    )


def load_registry_models(
    registry_dir: pathlib.Path | None = None,
    reserved_keys: frozenset[str] | set[str] = frozenset(),
) -> dict[str, ModelDefinition]:
    """Load deployer-reviewed models from the registry directory.

    Only strict ``*.json`` files are considered (README.md and the
    ``*.json.example`` sample are ignored). Keys colliding with builtin
    models or another registry entry raise, so a deployer cannot silently
    shadow a reviewed platform model.
    """
    directory = _REGISTRY_DIR if registry_dir is None else pathlib.Path(registry_dir)
    if not directory.is_dir():
        return {}
    definitions: dict[str, ModelDefinition] = {}
    taken: set[str] = set(reserved_keys)
    for path in sorted(directory.glob("*.json")):
        definition = _load_registry_entry(path)
        if definition.key in taken:
            raise _registry_error(
                path,
                f"key '{definition.key}' is already used by a builtin or another registry entry",
            )
        taken.add(definition.key)
        definitions[definition.key] = definition
    return definitions


# Registry models merge at import time so every route that reads
# MODEL_DEFINITIONS serves deployer-provisioned models with zero route
# changes, and an invalid entry stops the process at startup.
MODEL_DEFINITIONS.update(
    load_registry_models(reserved_keys=frozenset(MODEL_DEFINITIONS))
)
