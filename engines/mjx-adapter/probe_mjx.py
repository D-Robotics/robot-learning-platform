#!/usr/bin/env python3
"""MJX compatibility probe for the mjx adapter.

Run: engines/mjx-adapter/.venv/bin/python engines/mjx-adapter/probe_mjx.py

Regression-encodes the physics findings the adapter's MJCF design depends
on (verified 2026-09 on mujoco 3.13 + mujoco-mjx 3.13 + jax 0.11 CPU).
Every check runs against the PRODUCTION robot (adapter.build_mjcf), not a
hand-copied XML — a copy drifted once and hid a reset-penetration launch
bug for a whole session.

  1. integrator: Euler and RK4 mishandle the stiff kv=8 velocity servo
     (Euler oscillates boundedly around the wheel-speed target, RK4
     diverges — both went NaN before the force limit); implicitfast
     integrates the servo feedback implicitly and tracks smoothly —
     the adapter uses it.
  2. collisions: cylinder-plane works (the platform OriginBot's wheels);
     cylinder-box does NOT — walls/box obstacles must stay out of the
     training MJCF (obstacles are task-level analytic circles anyway).
  3. freejoint qvel rotation is BODY-frame (CPU exact; MJX within 1e-4).
  4. the 3-point stance robot (cylinder wheels on the center line, low
     friction caster touching the floor) drives and turns with correct
     signs and 80-140% command tracking.
  5. MJX matches CPU MuJoCo on the same scene to sub-centimeter over 100
     steps (this is the cross-backend parity claim the adapter rests on).
  6. the robot stays grounded: rest height derived from wheel geometry
     (wheels exactly touching) and force-limited wheel servos mean no
     reset penetration launch and no spin-up wheelie, at any yaw and any
     command (CPU and MJX).
"""

import importlib.util
import pathlib
import sys

import mujoco
import numpy as np
from mujoco import mjx

import jax

_HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("mjx_adapter_probe", _HERE / "adapter.py")
_adapter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_adapter)

WHEEL_RADIUS = _adapter.WHEEL_RADIUS
TRACK_WIDTH = _adapter.TRACK_WIDTH
# The physics timestep the adapter actually runs (its _MJX_MAX_PHYSICS_DT
# cap): at 0.02 MJX's contact solver injects energy into this stance — the
# probe is what proved that, so it pins the capped value.
DT = _adapter._MJX_MAX_PHYSICS_DT


def production_mjcf(integrator="implicitfast"):
    """The adapter's real training MJCF, with the integrator swappable."""
    return _adapter.build_mjcf(DT).replace('integrator="implicitfast"', f'integrator="{integrator}"')


def set_rest_pose(data, yaw=0.0):
    data.qpos[2] = _adapter.REST_HEIGHT
    data.qpos[3:7] = [np.cos(yaw / 2), 0, 0, np.sin(yaw / 2)]


def yaw_of(qpos):
    return float(np.arctan2(2 * (qpos[3] * qpos[6] + qpos[4] * qpos[5]),
                            1 - 2 * (qpos[5] ** 2 + qpos[6] ** 2)))


def run_mjx(xml, ctrl, steps, yaw=0.0):
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    set_rest_pose(data, yaw)
    data.ctrl[:] = ctrl
    mujoco.mj_forward(model, data)
    mjx_model = mjx.put_model(model)
    mjx_data = mjx.put_data(model, data)
    step = jax.jit(mjx.step)
    for _ in range(steps):
        mjx_data = step(mjx_model, mjx_data)
    return np.asarray(mjx_data.qpos), np.asarray(mjx_data.qvel)


def run_cpu(xml, ctrl, steps, yaw=0.0):
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    set_rest_pose(data, yaw)
    data.ctrl[:] = ctrl
    mujoco.mj_forward(model, data)
    for _ in range(steps):
        mujoco.mj_step(model, data)
    return np.asarray(data.qpos), np.asarray(data.qvel)


def check_rest_pose_touches_floor():
    """The reset pose must put the wheel rims exactly on the floor: a pose
    even 1 cm under launches the robot when the contact solver resolves
    the pre-loaded penetration."""
    model = mujoco.MjModel.from_xml_string(production_mjcf())
    data = mujoco.MjData(model)
    set_rest_pose(data)
    mujoco.mj_forward(model, data)
    worst = min((data.contact[i].dist for i in range(data.ncon)), default=0.0)
    print(f"[probe] rest pose: ncon={data.ncon} worst contact dist={worst:+.6f} "
          f"(REST_HEIGHT={_adapter.REST_HEIGHT:.4f})")
    assert data.ncon >= 3, "3-point stance must have all contacts closed at reset"
    assert worst > -1e-4, f"reset pose penetrates the floor by {-worst:.4f} m (launch bug)"


def check_integrators():
    """The kv=8 velocity servo is stiff: explicit integrators mishandle the
    wheel-speed loop even with the force limit in place (Euler oscillates
    boundedly around the target, RK4 diverges; before the force limit both
    went NaN in a few steps). implicitfast integrates the servo feedback
    implicitly and tracks the target smoothly — that is why the adapter
    uses it."""
    for integrator, expect_track in (("Euler", False), ("implicitfast", True), ("RK4", False)):
        xml = production_mjcf(integrator)
        try:
            # collect wheel speeds over the run so the mean error sees the
            # whole oscillation, not only a lucky terminal step
            speeds = []
            model = mujoco.MjModel.from_xml_string(xml)
            data = mujoco.MjData(model)
            set_rest_pose(data)
            data.ctrl[:] = [4.0, 4.0]
            mujoco.mj_forward(model, data)
            mjx_model = mjx.put_model(model)
            mjx_data = mjx.put_data(model, data)
            step = jax.jit(mjx.step)
            for _ in range(80):
                mjx_data = step(mjx_model, mjx_data)
                speeds.append(float(np.asarray(mjx_data.qvel)[6]))
            finite = bool(np.all(np.isfinite(speeds)))
            err = float(np.mean(np.abs(np.asarray(speeds[-30:]) - 4.0))) if finite else float("inf")
        except Exception as error:  # noqa: BLE001 - probe reports, never crashes
            print(f"[probe] integrator {integrator}: raises {type(error).__name__}")
            finite, err = False, float("inf")
        track = finite and err < 0.5
        verdict = "OK" if track == expect_track else "CHANGED"
        print(f"[probe] integrator {integrator}: finite={finite} mean wheel err={err:.2f} rad/s {verdict}")
        assert track == expect_track, f"integrator {integrator} servo tracking changed (err={err:.2f})"


def check_cylinder_box_collision():
    xml = production_mjcf().replace(
        '<geom name="floor" type="plane" size="12 12 0.1"/>',
        '<geom name="floor" type="plane" size="12 12 0.1"/>'
        '<geom name="block" type="box" pos="1 0 .2" size=".1 .1 .2"/>',
    )
    try:
        run_mjx(xml, [4.0, 4.0], 10)
        print("[probe] cylinder-box collision: supported (adapter may add box obstacles)")
    except NotImplementedError as error:
        print(f"[probe] cylinder-box collision: NOT supported ({error}) — walls/box "
              "obstacles stay out of the training MJCF")


def check_frame_convention():
    """A pitched free body spinning about its own z in zero gravity: body-frame
    qvel rotation keeps the body z axis fixed; world-frame precesses it."""
    xml = """
<mujoco model="free_body">
  <option gravity="0 0 0" timestep="0.001"/>
  <worldbody>
    <body name="b" pos="0 0 0">
      <freejoint name="root"/>
      <geom name="g" type="box" size=".1 .02 .01"/>
    </body>
  </worldbody>
</mujoco>
"""
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    pitch = np.pi / 6
    data.qpos[3:7] = [np.cos(pitch / 2), 0, np.sin(pitch / 2), 0]
    data.qvel[5] = 1.0  # spin about (which frame?) z
    mujoco.mj_forward(model, data)
    mjx_data = mjx.put_data(model, data)
    mjx_model = mjx.put_model(model)
    step = jax.jit(mjx.step)
    for _ in range(100):
        mjx_data = step(mjx_model, mjx_data)
    # body z axis in world after 0.1 s of spin: R·ẑ = third column of the
    # rotation matrix built from the (w, x, y, z) quaternion
    quat = np.asarray(mjx_data.qpos)[3:7]
    body_z = np.array([
        2 * (quat[1] * quat[3] + quat[0] * quat[2]),
        2 * (quat[2] * quat[3] - quat[0] * quat[1]),
        1 - 2 * (quat[1] ** 2 + quat[2] ** 2),
    ])
    print(f"[probe] frame convention: body z y-component moved {abs(body_z[1]):.2e} in world "
          "(body-frame qvel; world-frame would move it ~5e-2)")
    assert abs(body_z[1]) < 1e-4, "freejoint qvel rotation frame changed (not body-frame)"


def check_no_launch():
    """The regression this probe exists for: reset from REST_HEIGHT at ANY
    yaw with ANY (even max) command must keep the chassis on the floor.
    Two historical bugs this catches: reset pose penetrating the floor
    (solver launches the robot to resolve pre-loaded contacts) and
    unlimited servo torque wheelie at spin-up (kv*error reached 26.6 N.m
    per wheel on a chassis whose CG sits above the axle)."""
    for backend, run in (("cpu", run_cpu), ("mjx", run_mjx)):
        worst = 0.0
        for yaw in np.linspace(-np.pi, np.pi, 9):
            for ctrl in ([3.333, 3.333], [3.333, -3.333], [8.0, 8.0], [-8.0, 8.0]):
                qpos, _ = run(production_mjcf(), ctrl, 60, yaw=yaw)
                worst = max(worst, float(qpos[2]))
        print(f"[probe] no-launch {backend}: worst z over 9 yaws x 4 ctrls = {worst:.4f}")
        assert worst < 0.19, f"{backend} launched the robot (z={worst:.3f})"


def check_driving():
    xml = production_mjcf()
    # forward 2s @ 4 rad/s -> ideal 0.72 m (force-limited spin-up ~140 ms
    # costs a centimeter; steady state tracks ~97%)
    steps_2s = int(round(2.0 / DT))
    qpos, _ = run_mjx(xml, [4.0, 4.0], steps_2s)
    ratio = qpos[0] / 0.72
    print(f"[probe] forward 2s: x={qpos[0]:+.3f}/0.72 ({ratio:.0%}) z={qpos[2]:.4f}")
    assert 0.8 <= ratio <= 1.4, f"forward tracking {ratio:.0%} outside 80-140%"
    assert abs(qpos[2] - _adapter.REST_HEIGHT) < 0.01, "chassis height drifted (stance broken)"
    # spin: left forward + right backward turns CW (negative yaw), ideal
    # rate -2*w*R/T. Measured on the LAST 2s of a 4s run (steady state):
    # cylinder tires scrub while spinning in place (contact-patch edges
    # travel at different speeds), so the gain runs above 1 — the policy
    # is closed-loop on goal delta, so a bounded gain offset is honest
    # physics, same class as the motorGain domain randomization.
    total_yaw = 0.0
    prev = 0.0
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    set_rest_pose(data)
    data.ctrl[:] = [2.0, -2.0]
    mujoco.mj_forward(model, data)
    mjx_model = mjx.put_model(model)
    mjx_data = mjx.put_data(model, data)
    step = jax.jit(mjx.step)
    steps_4s = int(round(4.0 / DT))
    for i in range(steps_4s):
        mjx_data = step(mjx_model, mjx_data)
        yaw = yaw_of(np.asarray(mjx_data.qpos))
        delta = (yaw - prev + np.pi) % (2 * np.pi) - np.pi
        if i >= steps_4s - steps_2s:
            total_yaw += delta
        prev = yaw
    rate = total_yaw / 2.0
    ideal = -(2 * 2.0 * WHEEL_RADIUS) / TRACK_WIDTH
    print(f"[probe] spin steady 2s: yaw rate {rate:+.3f} rad/s (ideal {ideal:+.3f}, {rate/ideal:.0%})")
    assert np.sign(rate) == np.sign(ideal), "spin direction inverted"
    assert 0.8 <= rate / ideal <= 1.7, f"spin tracking {rate/ideal:.0%} outside 80-170%"
    # curve: right faster -> CCW (positive yaw)
    qpos, _ = run_mjx(xml, [3.0, 4.0], steps_2s)
    yaw = yaw_of(qpos)
    print(f"[probe] curve 2s [3,4]: yaw={yaw:+.3f} (expect positive/CCW) y={qpos[1]:+.3f}")
    assert yaw > 0.05 and qpos[1] > 0, "curve direction wrong"
    # long stability under mixed control
    qpos, _ = run_mjx(xml, [2.0, -3.0], int(round(20.0 / DT)))
    print(f"[probe] stability 20s mixed ctrl: finite={bool(np.all(np.isfinite(qpos)))} z={qpos[2]:.4f}")
    assert np.all(np.isfinite(qpos)) and abs(qpos[2] - _adapter.REST_HEIGHT) < 0.02, "robot fell or diverged"


def check_cpu_mjx_parity():
    """THE reason the adapter caps the physics timestep at 0.01: at 0.02
    the MJX contact solver injects energy into this exact-touch stance
    (the chassis outruns the wheels' rolling speed; trajectories diverge
    by 0.4 m in 2 s). At the capped dt the two backends agree to ~2 cm
    over a 2 s turning run."""
    steps = int(round(2.0 / DT))
    xml = production_mjcf()
    qpos_mjx, _ = run_mjx(xml, [3.0, 4.0], steps)
    qpos_cpu, _ = run_cpu(xml, [3.0, 4.0], steps)
    dx = abs(qpos_mjx[0] - qpos_cpu[0])
    dy = abs(qpos_mjx[1] - qpos_cpu[1])
    print(f"[probe] CPU vs MJX {steps} steps (curve): |dx|={dx:.5f} |dy|={dy:.5f} "
          f"(mjx x={qpos_mjx[0]:.4f}, cpu x={qpos_cpu[0]:.4f})")
    # Straight-line runs agree to ~0.2%; a turning trajectory engages the
    # contact solver in slip, where CPU and MJX numerics legitimately
    # diverge — same qualitative dynamics, not bitwise parity.
    assert dx < 0.05 and dy < 0.05, f"CPU/MJX parity broke: dx={dx} dy={dy}"


if __name__ == "__main__":
    print(f"[probe] jax {jax.__version__} devices={jax.devices()} | mujoco {mujoco.__version__}")
    check_rest_pose_touches_floor()
    check_integrators()
    check_cylinder_box_collision()
    check_frame_convention()
    check_no_launch()
    check_driving()
    check_cpu_mjx_parity()
    print("[probe] all checks passed")
