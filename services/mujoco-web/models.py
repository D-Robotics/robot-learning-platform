from dataclasses import dataclass


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
      <geom name="chassis" type="box" size=".28 .23 .10" mass="4" rgba=".12 .42 .8 1"/>
      <geom name="top" type="cylinder" pos="0 0 .13" size=".16 .025" mass=".2" rgba=".18 .62 .95 1"/>
      <body name="left_wheel" pos="0 .25 -.08"><joint name="left_wheel_joint" type="hinge" axis="0 1 0" damping=".08"/><geom name="left_wheel_geom" type="cylinder" quat=".7071 .7071 0 0" size=".09 .035" mass=".35" friction="1.2 .01 .001" rgba=".04 .05 .07 1"/></body>
      <body name="right_wheel" pos="0 -.25 -.08"><joint name="right_wheel_joint" type="hinge" axis="0 1 0" damping=".08"/><geom name="right_wheel_geom" type="cylinder" quat=".7071 .7071 0 0" size=".09 .035" mass=".35" friction="1.2 .01 .001" rgba=".04 .05 .07 1"/></body>
      <geom name="caster" type="sphere" pos="-.20 0 -.07" size=".055" mass=".1" friction=".8 .01 .001" rgba=".15 .15 .18 1"/>
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
    <velocity name="left_wheel" joint="left_wheel_joint" kv="8" ctrllimited="true" ctrlrange="-8 8"/>
    <velocity name="right_wheel" joint="right_wheel_joint" kv="8" ctrllimited="true" ctrlrange="-8 8"/>
  </actuator>
</mujoco>
"""


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
