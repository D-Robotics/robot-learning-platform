"""Headless CPU MuJoCo replay of upstream MicroDuck MJCF scenes.

This is deliberately *not* mjlab/MuJoCo Warp: it is a single-environment CPU
rollout used to get a number you can reproduce on a laptop. The report records
``dynamics: cpu-mujoco`` so a success rate from here is never silently compared
with a GPU-parallel one.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .envelope import EvalEnvelope
from .tasks import EpisodeTrace

#: Order the policy was trained against (14 servos). The MJCF happens to declare
#: joints in this same order; we assert it instead of assuming it.
SERVO_JOINT_ORDER = [
    "left_hip_yaw",
    "left_hip_roll",
    "left_hip_pitch",
    "left_knee",
    "left_ankle",
    "neck_pitch",
    "head_pitch",
    "head_yaw",
    "head_roll",
    "right_hip_yaw",
    "right_hip_roll",
    "right_hip_pitch",
    "right_knee",
    "right_ankle",
]

#: STAND2 / HOME_FRAME. Actions are offsets from this pose.
DEFAULT_POSE = np.array(
    [
        0.0,
        -0.0873,
        -0.4579,
        -0.0049,
        0.4530,
        0.3491,
        0.3491,
        0.0,
        0.0,
        0.0,
        0.0873,
        0.4579,
        0.0049,
        -0.4530,
    ],
    dtype=np.float64,
)

CONTROL_HZ = 50.0

#: Calibrated position-actuator stiffness for the CPU harness.
#:
#: The MJCF ships ``kp = 0.55`` with ``forcerange = ±0.96 N·m``. Measured against
#: the zero-action baseline (hold HOME for 4 s on flat ground), 0.55 N·m/rad
#: cannot hold the robot up — it tips backward at ~0.9 s — while 1.5 and above
#: hold it within a few degrees. 2.0 is the smallest round value with margin.
#: This is a *first-order* stand-in for BAM's identified voltage model: it has no
#: back-EMF, no load-dependent friction, and no current limiter. See
#: ``docs/eval-report-contract.md`` §6 for the measurement table.
CALIBRATED_KP = 2.0

#: Torque ceiling: BAM's stall torque ``vin * kt / R`` at the nominal 7.5 V.
#: The MJCF's ±0.96 N·m happens to match, but it is stated here explicitly
#: because the ceiling is what actually produced the "nothing survives" result
#: before the gains were calibrated.
CALIBRATED_FORCE_CEILING_NM = 0.976


#: Physics presets. mjlab's own defaults differ from what a bare MJCF load gets
#: from MuJoCo, and the difference is not cosmetic: ``implicitfast`` is what the
#: trainer integrates with, and stiff foot contacts behave differently under the
#: explicit ``euler`` default (mjlab 1.3.0 ``src/mjlab/sim/sim.py::MujocoCfg``).
PHYSICS_PRESETS = {
    "mjlab": {
        "integrator": "implicitfast",
        "solver": "newton",
        "cone": "pyramidal",
        "jacobian": "auto",
        "impratio": 1.0,
        "tolerance": 1e-8,
        "ls_tolerance": 0.01,
        "iterations": 100,
        "ls_iterations": 50,
    },
    "raw": {},
}


def apply_physics_preset(model, preset: str) -> None:
    """Apply a named physics preset to a compiled model."""
    import mujoco

    if preset not in PHYSICS_PRESETS:
        raise ValueError(f"unknown physics preset {preset!r}; known: {sorted(PHYSICS_PRESETS)}")
    settings = PHYSICS_PRESETS[preset]
    if not settings:
        return
    integrators = {"euler": mujoco.mjtIntegrator.mjINT_EULER,
                   "implicitfast": mujoco.mjtIntegrator.mjINT_IMPLICITFAST}
    solvers = {"newton": mujoco.mjtSolver.mjSOL_NEWTON, "cg": mujoco.mjtSolver.mjSOL_CG,
               "pgs": mujoco.mjtSolver.mjSOL_PGS}
    cones = {"pyramidal": mujoco.mjtCone.mjCONE_PYRAMIDAL,
             "elliptic": mujoco.mjtCone.mjCONE_ELLIPTIC}
    model.opt.integrator = integrators[settings["integrator"]]
    model.opt.solver = solvers[settings["solver"]]
    model.opt.cone = cones[settings["cone"]]
    model.opt.impratio = settings["impratio"]
    model.opt.tolerance = settings["tolerance"]
    model.opt.ls_tolerance = settings["ls_tolerance"]
    model.opt.iterations = settings["iterations"]
    model.opt.ls_iterations = settings["ls_iterations"]


#: Collision presets. MicroDuck's ``FULL_COLLISION`` (microduck_constants.py)
#: rewrites the foot geoms to ``condim=3`` / friction 1.0 / priority 1 and drops
#: every other collision geom to ``condim=1``; loading the MJCF directly leaves
#: MuJoCo's own defaults in place instead.
COLLISION_PRESETS = ("raw", "full")


def apply_collision_preset(model, preset: str) -> dict[str, object]:
    """Apply a named collision preset and return the facts worth reporting."""
    import mujoco

    if preset not in COLLISION_PRESETS:
        raise ValueError(f"unknown collision preset {preset!r}; known: {COLLISION_PRESETS}")
    if preset == "raw":
        return {"collisionPreset": "raw"}
    feet = 0
    others = 0
    for geom_id in range(model.ngeom):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id) or ""
        if not name.endswith("_collision"):
            continue
        if name in ("left_foot_collision", "right_foot_collision"):
            model.geom_condim[geom_id] = 3
            model.geom_friction[geom_id, 0] = 1.0
            model.geom_priority[geom_id] = 1
            feet += 1
        else:
            model.geom_condim[geom_id] = 1
            others += 1
    return {"collisionPreset": "full", "footCollisionGeoms": feet, "otherCollisionGeoms": others}


def apply_calibrated_position_gains(
    model,
    actuator_ids: list[int],
    *,
    kp: float | None = None,
    force_ceiling: float | None = None,
) -> dict[str, float | bool]:
    """Install the calibrated position gains and return the facts to report."""
    stiffness = CALIBRATED_KP if kp is None else float(kp)
    ceiling = CALIBRATED_FORCE_CEILING_NM if force_ceiling is None else float(force_ceiling)
    if stiffness <= 0 or ceiling <= 0:
        raise ValueError("kp and force_ceiling must be positive")
    model.actuator_gainprm[actuator_ids, 0] = stiffness
    model.actuator_biasprm[actuator_ids, 1] = -stiffness
    model.actuator_forcerange[actuator_ids, 0] = -ceiling
    model.actuator_forcerange[actuator_ids, 1] = ceiling
    model.actuator_forcelimited[actuator_ids] = 1
    return {"calibratedKp": stiffness, "forceCeilingNm": ceiling, "calibratedForStanding": True}


class ModelLayoutError(RuntimeError):
    """The MJCF does not expose the joints/actuators the contract needs."""


@dataclass
class SceneSpec:
    """Which MJCF to load and where its parts are."""

    xml: Path
    has_ball: bool
    trunk_body: str = "trunk_base"


def find_scene(model_root: str | Path, *, with_ball: bool) -> SceneSpec:
    root = Path(model_root)
    robot_dir = root / "src" / "mjlab_microduck" / "robot" / "microduck"
    if not robot_dir.is_dir():
        raise FileNotFoundError(
            f"{robot_dir} not found; pass --model-root pointing at a microduck_rl checkout"
        )
    if with_ball:
        scene = robot_dir / "scene_ball.xml"
        if not scene.is_file():
            raise FileNotFoundError(f"{scene} not found (upstream scene_ball.xml)")
        return SceneSpec(xml=scene, has_ball=True)
    scene = robot_dir / "scene.xml"
    if not scene.is_file():
        raise FileNotFoundError(f"{scene} not found (upstream scene.xml)")
    return SceneSpec(xml=scene, has_ball=False)


class MicroDuckSim:
    """One MicroDuck in one MuJoCo world, stepped at the policy's 50 Hz.

    ``actuator_model`` selects what turns an action into joint torque:

    * ``"mjcf"`` (default) — the MJCF position actuator with *calibrated* gains
      (see ``CALIBRATED_KP``): the only variant measured to hold the standing
      baseline, which the harness qualification requires.
    * ``"bam"`` — a port of the XL330 voltage-control law the trainer uses, fed
      through MuJoCo as a direct motor actuator. Kept for comparison; see
      ``microduck_eval/actuator.py`` for why its duty gain (0.575 N·m/rad) is
      about 3.5x softer than the calibrated position actuator.
    """

    def __init__(
        self,
        spec: SceneSpec,
        *,
        action_scale: float = 1.0,
        actuator_model: str = "mjcf",
        kp: float | None = None,
        force_ceiling: float | None = None,
        bam_params: "BamParams | None" = None,
        physics: str = "mjlab",
        collisions: str = "full",
    ) -> None:
        import mujoco

        self.mujoco = mujoco
        self.model = mujoco.MjModel.from_xml_path(str(spec.xml))
        self.data = mujoco.MjData(self.model)
        self.spec = spec
        self.action_scale = float(action_scale)
        self.physics_preset = physics
        self.collision_preset = collisions
        if actuator_model not in ("bam", "mjcf"):
            raise ValueError(f"actuator_model must be 'bam' or 'mjcf', got {actuator_model!r}")
        self.actuator_model = actuator_model

        self.joint_ids: list[int] = []
        self.qpos_indices: list[int] = []
        self.qvel_indices: list[int] = []
        for name in SERVO_JOINT_ORDER:
            joint_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, name)
            if joint_id < 0:
                raise ModelLayoutError(f"joint {name!r} is missing from {spec.xml.name}")
            self.joint_ids.append(joint_id)
            self.qpos_indices.append(int(self.model.jnt_qposadr[joint_id]))
            self.qvel_indices.append(int(self.model.jnt_dofadr[joint_id]))

        self.actuator_ids: list[int] = []
        for name in SERVO_JOINT_ORDER:
            actuator_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_ACTUATOR, name)
            if actuator_id < 0:
                raise ModelLayoutError(f"actuator {name!r} is missing from {spec.xml.name}")
            self.actuator_ids.append(actuator_id)

        self.trunk_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, spec.trunk_body)
        if self.trunk_id < 0:
            raise ModelLayoutError(f"body {spec.trunk_body!r} is missing from {spec.xml.name}")

        self.trunk_root_qpos = int(self.model.jnt_qposadr[
            mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, "trunk_base_freejoint")
        ]) if spec.trunk_body == "trunk_base" else 0
        self.ball_qpos = None
        if spec.has_ball:
            ball_joint = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, "ball_free")
            if ball_joint < 0:
                raise ModelLayoutError("scene_ball.xml loaded but joint 'ball_free' is missing")
            self.ball_qpos = int(self.model.jnt_qposadr[ball_joint])

        self.base_mass = float(self.model.body_mass[self.trunk_id])
        self.default_pose = DEFAULT_POSE.copy()
        self.step_dt = 1.0 / CONTROL_HZ
        self.substeps = max(1, int(round(self.step_dt / float(self.model.opt.timestep))))
        apply_physics_preset(self.model, physics)
        collision_facts = apply_collision_preset(self.model, collisions)

        self.bam_params = None
        self.actuator_facts: dict[str, object] = {
            **collision_facts,
            "physicsPreset": physics,
            "integrator": int(self.model.opt.integrator),
            "cone": int(self.model.opt.cone),
            "tolerance": float(self.model.opt.tolerance),
            "model": actuator_model,
            "sceneKp": float(self.model.actuator_gainprm[self.actuator_ids[0], 0]),
            "sceneForceRangeNm": float(self.model.actuator_forcerange[self.actuator_ids[0], 1]),
        }
        if actuator_model == "mjcf":
            self.actuator_facts.update(
                apply_calibrated_position_gains(
                    self.model, self.actuator_ids, kp=kp, force_ceiling=force_ceiling
                )
            )
        else:
            from .actuator import load_bam_params, torque as bam_torque

            self._bam_torque = bam_torque
            self.bam_params = bam_params or load_bam_params()
            # Feed torques straight through MuJoCo's actuator: gain 1, no bias,
            # so `ctrl` *is* the joint torque. The MJCF's placeholder position
            # gains (kp=0.55) would otherwise still be in the loop.
            self.model.actuator_gainprm[self.actuator_ids, 0] = 1.0
            self.model.actuator_gainprm[self.actuator_ids, 1] = 0.0
            self.model.actuator_biasprm[self.actuator_ids, :] = 0.0
            # Widen the ceiling to the BAM stall torque; the firmware current
            # limit is enforced inside the control law (as a duty-cycle window),
            # exactly as the training-side actuator does it.
            ceiling = float(self.bam_params.stall_torque)
            self.model.actuator_forcerange[self.actuator_ids, 0] = -ceiling
            self.model.actuator_forcerange[self.actuator_ids, 1] = ceiling
            self.model.actuator_forcelimited[self.actuator_ids] = 1
            self.actuator_facts.update(
                {
                    "bamDutyGain": self.bam_params.duty_gain,
                    "bamStallTorqueNm": self.bam_params.stall_torque,
                    "bamVin": self.bam_params.vin,
                    "bamKpFirmware": self.bam_params.kp_fw,
                }
            )

    # ---- setup -----------------------------------------------------------
    def reset(self, *, base_xy: tuple[float, float], base_yaw: float,
              ball_distance: float | None, payload_fraction: float) -> None:
        mujoco = self.mujoco
        mujoco.mj_resetData(self.model, self.data)
        root = self.trunk_root_qpos
        self.data.qpos[root + 0] = base_xy[0]
        self.data.qpos[root + 1] = base_xy[1]
        # z is left at the model's spawn height (0.12 m) for every episode.
        half = base_yaw / 2.0
        self.data.qpos[root + 3 : root + 7] = [np.cos(half), 0.0, 0.0, np.sin(half)]
        for index, qpos_index in enumerate(self.qpos_indices):
            self.data.qpos[qpos_index] = self.default_pose[index]
        self.data.ctrl[:] = 0.0
        self.model.body_mass[self.trunk_id] = self.base_mass * (1.0 + payload_fraction)
        if self.ball_qpos is not None and ball_distance is not None:
            self.data.qpos[self.ball_qpos + 0] = base_xy[0] + ball_distance * np.cos(base_yaw)
            self.data.qpos[self.ball_qpos + 1] = base_xy[1] + ball_distance * np.sin(base_yaw)
            self.data.qpos[self.ball_qpos + 2] = 0.035
            self.data.qpos[self.ball_qpos + 3 : self.ball_qpos + 7] = [1.0, 0.0, 0.0, 0.0]
        mujoco.mj_forward(self.model, self.data)

    # ---- observation (61D contract) --------------------------------------
    def _rotation_matrix(self) -> np.ndarray:
        quat = self.data.xquat[self.trunk_id]
        matrix = np.zeros(9, dtype=np.float64)
        self.mujoco.mju_quat2Mat(matrix, quat)
        return matrix.reshape(3, 3)

    def projected_gravity(self) -> np.ndarray:
        """World gravity expressed in the trunk frame (the policy's 2nd slot)."""
        return self._rotation_matrix().T @ np.array([0.0, 0.0, -1.0])

    def base_ang_vel(self) -> np.ndarray:
        """Trunk angular velocity in the trunk frame (the policy's 1st slot).

        The upstream trainer reads this from an IMU gyro on the trunk; here it is
        the free-joint velocity rotated into the trunk frame, which is the same
        physical quantity without the sensor's noise model.
        """
        quat = self.data.xquat[self.trunk_id]
        velocity = np.zeros(6, dtype=np.float64)
        result = np.zeros(6, dtype=np.float64)
        self.mujoco.mj_objectVelocity(
            self.model, self.data, self.mujoco.mjtObj.mjOBJ_BODY, self.trunk_id, velocity, 1
        )
        self.mujoco.mju_transformSpatial(
            result,
            velocity,
            0,
            np.zeros(3, dtype=np.float64),
            np.zeros(3, dtype=np.float64),
            np.ascontiguousarray(self._rotation_matrix().reshape(9)),
        )
        return result[:3]

    def observation(self, command: np.ndarray, last_action: np.ndarray) -> np.ndarray:
        joint_pos = self.data.qpos[self.qpos_indices] - self.default_pose
        joint_vel = self.data.qvel[self.qvel_indices]
        observation = np.concatenate(
            [
                self.base_ang_vel(),
                self.projected_gravity(),
                joint_pos,
                joint_vel,
                last_action,
                command,
            ]
        ).astype(np.float32)
        if observation.shape != (61,):
            raise ModelLayoutError(f"assembled observation is {observation.shape}, expected (61,)")
        return observation

    # ---- stepping --------------------------------------------------------
    def apply_action(self, action: np.ndarray) -> None:
        target = self.default_pose + action * self.action_scale
        if self.bam_params is None:
            for offset, actuator_id in enumerate(self.actuator_ids):
                self.data.ctrl[actuator_id] = float(target[offset])
            return
        torques = self._bam_torque(
            self.bam_params,
            q_target=target,
            q=self.data.qpos[self.qpos_indices],
            dq=self.data.qvel[self.qvel_indices],
        )
        if not np.all(np.isfinite(torques)):
            raise ModelLayoutError("BAM actuator produced a non-finite torque")
        for offset, actuator_id in enumerate(self.actuator_ids):
            self.data.ctrl[actuator_id] = float(torques[offset])

    def advance(self) -> None:
        for _ in range(self.substeps):
            self.mujoco.mj_step(self.model, self.data)
        # mj_step integrates qpos/qvel but leaves derived state (xpos, xquat,
        # contacts, sensordata) as of the *previous* step, so every measurement
        # read afterwards would be one frame stale — and contact counting would
        # be wrong. Recompute kinematics explicitly.
        self.mujoco.mj_forward(self.model, self.data)

    # ---- measurements ----------------------------------------------------
    def base_xy(self) -> tuple[float, float]:
        position = self.data.xpos[self.trunk_id]
        return float(position[0]), float(position[1])

    def base_z(self) -> float:
        return float(self.data.xpos[self.trunk_id][2])

    def body_tilt(self) -> tuple[float, float]:
        matrix = self._rotation_matrix()
        pitch = float(np.arctan2(-matrix[2, 0], np.sqrt(matrix[2, 1] ** 2 + matrix[2, 2] ** 2)))
        roll = float(np.arctan2(matrix[2, 1], matrix[2, 2]))
        return pitch, roll

    def ball_xy(self) -> tuple[float, float]:
        if self.ball_qpos is None:
            return 0.0, 0.0
        return float(self.data.qpos[self.ball_qpos]), float(self.data.qpos[self.ball_qpos + 1])

    def trunk_ground_contact(self) -> bool:
        mujoco = self.mujoco
        for index in range(self.data.ncon):
            contact = self.data.contact[index]
            for geom_id in (contact.geom1, contact.geom2):
                body_id = int(self.model.geom_bodyid[geom_id])
                if body_id == self.trunk_id:
                    other = int(self.model.geom_bodyid[contact.geom2 if geom_id == contact.geom1 else contact.geom1])
                    if self.model.body_mass[other] == 0.0:  # worldbody/floor
                        return True
        return False


def _noise_sampler(seed: int):
    return np.random.default_rng(seed)


def rollout(
    sim: MicroDuckSim,
    policy,
    envelope: EvalEnvelope,
    command: np.ndarray,
    *,
    episode_index: int,
) -> EpisodeTrace:
    """Run one episode and return the measured trace.

    Initial conditions are drawn per-episode from ``envelope.seed`` so the whole
    envelope is reproducible from a single integer. Recurrent policies are
    reset here: an episode that starts from the previous episode's hidden state
    measures the wrong thing while looking perfectly healthy.
    """
    reset = getattr(policy, "reset", None)
    if callable(reset):
        reset()
    rng = _noise_sampler(envelope.seed + episode_index * 7919)
    state = envelope.initial_state
    jitter = np.asarray(state.base_pos_jitter, dtype=np.float64)
    base_xy = (
        state.base_pos[0] + (rng.random() * 2 - 1) * jitter[0],
        state.base_pos[1] + (rng.random() * 2 - 1) * jitter[1],
    )
    base_yaw = state.base_yaw + (rng.random() * 2 - 1) * state.base_yaw_jitter
    ball_distance = None
    if state.ball_distance is not None and sim.ball_qpos is not None:
        ball_distance = max(
            0.05,
            state.ball_distance + (rng.random() * 2 - 1) * state.ball_distance_jitter,
        )
    sim.reset(
        base_xy=base_xy,
        base_yaw=base_yaw,
        ball_distance=ball_distance,
        payload_fraction=envelope.payload_fraction,
    )

    trace = EpisodeTrace(dt=sim.step_dt)
    steps = int(round(envelope.episode_seconds / sim.step_dt))
    last_action = np.zeros(14, dtype=np.float32)
    for step in range(steps):
        observation = sim.observation(command, last_action)
        if envelope.gyro_noise_std:
            observation = observation.copy()
            observation[0:3] += rng.normal(0.0, envelope.gyro_noise_std, size=3).astype(np.float32)
        action = policy.act(observation)
        if envelope.command_dropout and rng.random() < envelope.command_dropout:
            action = last_action.copy()
        sim.apply_action(action)
        sim.advance()
        last_action = action.astype(np.float32)

        trace.base_xy.append(sim.base_xy())
        trace.base_z.append(sim.base_z())
        pitch, roll = sim.body_tilt()
        trace.body_pitch.append(pitch)
        trace.body_roll.append(roll)
        if sim.ball_qpos is not None:
            trace.ball_xy.append(sim.ball_xy())
            trace.ball_z.append(float(sim.data.qpos[sim.ball_qpos + 2]))
        trace.ground_contact.append(sim.trunk_ground_contact())
    return trace


def servo_order_matches(sim: "MicroDuckSim") -> bool:
    """True when the compiled MJCF declares servo joints in the trained order.

    Checked on the *compiled* model, not on raw XML text: includes and meshes make
    text scanning unreliable, while MuJoCo's own qpos addresses give the exact
    order the policy's 14D slots will read.
    """
    addresses = [int(sim.model.jnt_qposadr[joint_id]) for joint_id in sim.joint_ids]
    return addresses == sorted(addresses)
