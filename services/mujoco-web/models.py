from dataclasses import dataclass


@dataclass(frozen=True)
class ModelDefinition:
    key: str
    name: str
    description: str
    actuator_names: tuple[str, ...]
    xml: str
    initial_qpos: tuple[float, ...]


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
}
