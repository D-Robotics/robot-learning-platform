from __future__ import annotations

import io
import math
import secrets
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import mujoco
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field, field_validator

from models import MODEL_DEFINITIONS, ModelDefinition


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
MAX_SESSIONS = 24
SESSION_TTL_SECONDS = 30 * 60
# A browser normally sends DELETE on pagehide, but a crashed tab, a mobile
# suspension, or a dead reverse-proxy connection cannot do that. The janitor
# keeps abandoned models/GL contexts bounded even when no new session is made.
SESSION_CLEANUP_INTERVAL_SECONDS = min(60.0, max(1.0, SESSION_TTL_SECONDS / 2.0))
FRAME_WIDTH = 640
FRAME_HEIGHT = 480
DEPTH_MAX_METERS = 8.0
# The browser and the board policy contract issue one twist at 20 Hz.  Keep
# one command period equal to 50 ms while retaining the 10 ms physics step.
CMD_VEL_STEP_SECONDS = 0.05


@dataclass
class SimulationSession:
    session_id: str
    definition: ModelDefinition
    model: mujoco.MjModel
    data: mujoco.MjData
    last_seen: float
    seed: int | None = None
    domain_randomization: dict[str, float] = field(default_factory=dict)
    # Last bounded command is part of the observable control feedback.  Keep
    # it in the session so a state poll has the same command context as the
    # immediate cmd_vel response.
    last_cmd_vel: dict[str, Any] = field(
        default_factory=lambda: {
            "linear": 0.0,
            "angular": 0.0,
            "requestedLinear": 0.0,
            "requestedAngular": 0.0,
            "appliedLinear": 0.0,
            "appliedAngular": 0.0,
            "wheelRadS": [0.0, 0.0],
            "requestedWheelRadS": [0.0, 0.0],
            "wheelCtrl": [0.0, 0.0],
            "wheelTorqueNm": [0.0, 0.0],
            "saturated": False,
            "source": "idle",
        }
    )
    # EGL/GL contexts are thread-affine; keep one context per worker thread
    # and render kind instead of sharing RGB and depth state accidentally.
    renderers: dict[tuple[int, str], mujoco.Renderer] = field(default_factory=dict)


class StepRequest(BaseModel):
    controls: list[float] = Field(default_factory=list, max_length=32)
    steps: int = Field(default=1, ge=1, le=50)

    @field_validator("controls")
    @classmethod
    def finite_controls(cls, values: list[float]) -> list[float]:
        if any(not math.isfinite(float(value)) for value in values):
            raise ValueError("controls must contain finite numbers")
        return values

class CmdVelRequest(BaseModel):
    linear: float = Field(default=0.0, ge=-0.6, le=0.6)
    angular: float = Field(default=0.0, ge=-2.5, le=2.5)

    @field_validator("linear", "angular")
    @classmethod
    def finite_command(cls, value: float) -> float:
        if not math.isfinite(float(value)):
            raise ValueError("cmd_vel values must be finite numbers")
        return value


class SessionRequest(BaseModel):
    model: str = "cartpole"
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    domain_randomization: bool = False


def _session_cleanup_loop(stop_event: threading.Event) -> None:
    """Reclaim idle sessions independently of request traffic."""

    while not stop_event.wait(SESSION_CLEANUP_INTERVAL_SECONDS):
        with _sessions_lock:
            _cleanup_sessions(time.monotonic())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    stop_event = threading.Event()
    janitor = threading.Thread(
        target=_session_cleanup_loop,
        args=(stop_event,),
        name="mujoco-session-janitor",
        daemon=True,
    )
    janitor.start()
    try:
        yield
    finally:
        stop_event.set()
        janitor.join(timeout=2.0)
        with _sessions_lock:
            _close_all_sessions()


app = FastAPI(
    title="MuJoCo Web Playground",
    description="A fixed-model browser playground backed by the MuJoCo physics engine.",
    version="1.0.0",
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def content_security_policy(request: Request, call_next):
    """Second layer behind the escaping fix for registry-supplied names.

    The page only loads its own module script, its own stylesheet, same-origin
    API responses and rendered frames as blob: URLs, so 'self' plus blob:
    images covers everything it legitimately uses. The browser rejects any
    script that a future injection regression would try to run.
    """
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' blob:; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
    )
    return response


@app.exception_handler(RequestValidationError)
async def request_validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """Return finite, serializable 422 details even for NaN/Inf JSON input.

    Starlette's default handler echoes ``input`` values. Python's JSON parser
    accepts non-standard NaN/Infinity tokens, but JSONResponse correctly
    refuses to serialize them, turning a bad request into a 500. Omitting the
    untrusted value keeps the API fail-closed and makes the error response
    valid JSON for gateways and clients.
    """

    details = [
        {
            "loc": [str(part) for part in error.get("loc", ())],
            "msg": str(error.get("msg", "Invalid request")),
            "type": str(error.get("type", "value_error")),
        }
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": details})

_sessions: dict[str, SimulationSession] = {}
_sessions_lock = threading.RLock()


def _definition(key: str) -> ModelDefinition:
    try:
        return MODEL_DEFINITIONS[key]
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown model: {key}") from exc


def _zero_cmd_vel(definition: ModelDefinition, source: str) -> dict[str, Any]:
    """Return the stable zero-control envelope used by every OriginBot path."""

    radius = float(definition.wheel_radius or 0.09)
    track = float(definition.track_width or 0.50)
    return {
        "linear": 0.0,
        "angular": 0.0,
        "requestedLinear": 0.0,
        "requestedAngular": 0.0,
        "appliedLinear": 0.0,
        "appliedAngular": 0.0,
        "wheelRadS": [0.0, 0.0],
        "requestedWheelRadS": [0.0, 0.0],
        "wheelCtrl": [0.0, 0.0],
        "wheelTorqueNm": [0.0, 0.0],
        "saturated": False,
        "source": source,
        "wheelRadius": radius,
        "trackWidth": track,
        "maxWheelSpeed": float(definition.max_wheel_speed or 8.0),
    }


def _close_renderers(session: SimulationSession) -> None:
    """Release GL resources owned by a session.

    A renderer is cached per worker thread because EGL contexts are
    thread-affine.  Closing the session must therefore close every cached
    renderer, including renderers created by a thread that has since gone
    idle.  ``Renderer.close`` is not present on a few older MuJoCo wheels, so
    keep the fallback harmless and always clear the cache afterwards.
    """

    for renderer in tuple(session.renderers.values()):
        close = getattr(renderer, "close", None)
        if close is None:
            continue
        try:
            close()
        except Exception:
            # Session eviction is a resource-protection path.  A stale GL
            # object must not prevent the remaining sessions from being
            # removed or make an explicit DELETE return 500.
            continue
    session.renderers.clear()


def _drop_session(session_id: str) -> SimulationSession | None:
    """Remove one session and release its model/renderers.

    Callers hold ``_sessions_lock``.  Keeping removal in one helper makes the
    TTL and explicit DELETE paths use identical cleanup semantics.
    """

    session = _sessions.pop(session_id, None)
    if session is not None:
        _close_renderers(session)
    return session


def _cleanup_sessions(now: float) -> None:
    expired = [
        session_id
        for session_id, session in _sessions.items()
        if now - session.last_seen > SESSION_TTL_SECONDS
    ]
    for session_id in expired:
        _drop_session(session_id)


def _close_all_sessions() -> None:
    """Release every live session during an orderly service shutdown."""

    for session_id in tuple(_sessions):
        _drop_session(session_id)


def _metadata(definition: ModelDefinition, model: mujoco.MjModel) -> dict[str, Any]:
    sensor_contract: dict[str, Any] = {}
    if definition.lidar_angles:
        sensor_contract["scan"] = {
            "count": len(definition.lidar_angles),
            "angleMin": float(definition.lidar_angles[0]),
            "angleMax": float(definition.lidar_angles[-1]),
            "angleIncrement": float(definition.lidar_angles[1] - definition.lidar_angles[0]) if len(definition.lidar_angles) > 1 else 0.0,
            "rangeMin": 0.05,
            "rangeMax": float(definition.lidar_range_max or 0.0),
            "frame": "base_lidar",
        }
        sensor_contract["depth"] = {
            "frame": "depth_camera",
            "previewEncoding": "mono8-normalized-jpeg",
            "rawEncoding": "mono16-mm-png",
            "encoding": "mono16-mm",
            "unit": "millimetres",
            "invalidValue": 0,
        }
        sensor_contract["imu"] = {"frame": "imu", "orientation": True, "gyro": True, "accelerometer": True}
    return {
        "key": definition.key,
        "name": definition.name,
        "description": definition.description,
        "source": definition.source,
        "timestep": float(model.opt.timestep),
        "controlPeriod": CMD_VEL_STEP_SECONDS if definition.wheel_radius is not None else float(model.opt.timestep),
        "controlHz": round(1.0 / CMD_VEL_STEP_SECONDS) if definition.wheel_radius is not None else round(1.0 / float(model.opt.timestep)),
        "actuators": [
            {
                "name": name,
                "min": float(model.actuator_ctrlrange[index, 0]) if model.actuator_ctrllimited[index] else -1.0,
                "max": float(model.actuator_ctrlrange[index, 1]) if model.actuator_ctrllimited[index] else 1.0,
            }
            for index, name in enumerate(definition.actuator_names)
        ],
        **({
            "wheelRadius": definition.wheel_radius,
            "trackWidth": definition.track_width,
            "maxWheelSpeed": definition.max_wheel_speed,
            "lidarAngles": list(definition.lidar_angles),
            "lidarRangeMax": definition.lidar_range_max,
        } if definition.wheel_radius is not None else {}),
        "sensorContract": sensor_contract,
    }


def _new_session(
    definition: ModelDefinition,
    *,
    seed: int | None = None,
    enable_domain_randomization: bool = False,
) -> SimulationSession:
    model = mujoco.MjModel.from_xml_string(definition.xml)
    data = mujoco.MjData(model)
    randomization: dict[str, float] = {}
    effective_seed = seed
    if enable_domain_randomization and definition.key == "originbot":
        # Keep randomization bounded and reproducible.  We mutate only contact
        # and controller parameters after compiling the reviewed MJCF; the
        # returned episode metadata lets a trainer join outcomes to settings.
        # A seed-less randomized session is still reproducible: mint the seed
        # once, return it in the episode envelope, and let a client recreate
        # the exact domain by sending it back on the next session.
        if effective_seed is None:
            effective_seed = secrets.randbelow(2**31)
        rng = np.random.default_rng(effective_seed)
        friction_scale = float(rng.uniform(0.90, 1.10))
        kv_scale = float(rng.uniform(0.95, 1.05))
        # Wheel names belong to the geoms (the parent bodies have separate
        # names).  Looking up the body names as mjOBJ_GEOM silently returned
        # -1, so the episode metadata claimed randomized friction while the
        # compiled model stayed nominal.
        for geom_name in ("left_wheel_geom", "right_wheel_geom"):
            geom_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, geom_name)
            if geom_id >= 0:
                model.geom_friction[geom_id, 0] *= friction_scale
        # Velocity actuator gainprm[0] is kv for MuJoCo's velocity actuator.
        if model.nu >= 2:
            model.actuator_gainprm[:2, 0] *= kv_scale
        # Python bindings require the data object as the second argument on
        # current MuJoCo releases; constants are refreshed after the model
        # mutation before the first forward pass.
        mujoco.mj_setConst(model, data)
        randomization = {"wheelFrictionScale": friction_scale, "velocityGainScale": kv_scale}
    for index, value in enumerate(definition.initial_qpos):
        if index < model.nq:
            data.qpos[index] = value
    mujoco.mj_forward(model, data)
    session = SimulationSession(
        session_id=uuid.uuid4().hex,
        definition=definition,
        model=model,
        data=data,
        last_seen=time.monotonic(),
        seed=effective_seed,
        domain_randomization=randomization,
    )
    if definition.wheel_radius is not None:
        session.last_cmd_vel = _zero_cmd_vel(definition, "idle")
    return session


def _get_session(session_id: str) -> SimulationSession:
    with _sessions_lock:
        session = _sessions.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Simulation session not found")
        now = time.monotonic()
        # Creation-time cleanup alone leaves an abandoned session resident
        # until another client creates a session.  Expire on access as well so
        # a stale client cannot resurrect its simulation and GL resources are
        # reclaimed even on an otherwise idle service.
        if now - session.last_seen > SESSION_TTL_SECONDS:
            _drop_session(session_id)
            raise HTTPException(status_code=404, detail="Simulation session expired")
        session.last_seen = now
        return session


def _state(session: SimulationSession) -> dict[str, Any]:
    q = session.data.qpos
    v = session.data.qvel
    yaw = float(2 * math.atan2(q[6], q[3])) if len(q) >= 7 else 0.0
    sensor_values: dict[str, list[float]] = {}
    for sensor_id in range(session.model.nsensor):
        name = mujoco.mj_id2name(session.model, mujoco.mjtObj.mjOBJ_SENSOR, sensor_id) or f"sensor_{sensor_id}"
        adr = session.model.sensor_adr[sensor_id]
        dim = session.model.sensor_dim[sensor_id]
        sensor_values[name] = [float(value) for value in session.data.sensordata[adr : adr + dim]]
    # Keep scan ordering explicit.  Sensor declaration order is stable in our
    # MJCF today, but sorting by the zero-padded beam index prevents a future
    # compiler/model edit from silently permuting observations.
    lidar_values: dict[int, float] = {}
    for sensor_id in range(session.model.nsensor):
        name = mujoco.mj_id2name(session.model, mujoco.mjtObj.mjOBJ_SENSOR, sensor_id) or ""
        if not name.startswith("lidar_"):
            continue
        try:
            beam = int(name.rsplit("_", 1)[1])
        except (ValueError, IndexError):
            continue
        value = float(session.data.sensordata[session.model.sensor_adr[sensor_id]])
        # Preserve MuJoCo's raw return (-1 means no hit) until the contract
        # masks below are built.  Flattening it too early would make a
        # saturated beam indistinguishable from an invalid one.
        lidar_values[beam] = value
    ordered_beams = sorted(lidar_values)
    range_max = float(session.definition.lidar_range_max or 4.0)
    scan: list[float] = []
    scan_raw: list[float | None] = []
    scan_valid: list[bool] = []
    scan_saturated: list[bool] = []
    for beam in ordered_beams:
        raw = float(lidar_values[beam])
        finite_raw = math.isfinite(raw)
        scan_raw.append(raw if finite_raw else None)
        # A no-hit/non-finite ray is exposed as max range in the flat array,
        # while the validity and saturation masks retain the distinction for
        # consumers that need ROS LaserScan semantics.
        scan.append(raw if finite_raw and raw > 0 else range_max)
        scan_valid.append(finite_raw and 0.0 < raw < range_max)
        scan_saturated.append(finite_raw and raw >= range_max)
    # Free-joint translational velocity is world-frame; odometry and cmd_vel
    # consumers expect base-frame velocity.
    world_vx = float(v[0]) if len(v) > 0 else 0.0
    world_vy = float(v[1]) if len(v) > 1 else 0.0
    body_vx = math.cos(yaw) * world_vx + math.sin(yaw) * world_vy
    body_vy = -math.sin(yaw) * world_vx + math.cos(yaw) * world_vy
    yaw_rate = float(v[5]) if len(v) > 5 else 0.0
    depth_base = f"/api/sessions/{session.session_id}"
    odom = {
        "x": float(q[0]) if len(q) > 0 else 0.0,
        "y": float(q[1]) if len(q) > 1 else 0.0,
        "yaw": yaw,
        "linearX": body_vx,
        "linearY": body_vy,
        "angularZ": yaw_rate,
    }
    imu = {
        "yaw": yaw,
        "gyroZ": yaw_rate,
        "orientation": sensor_values.get("imu_orientation", []),
        "gyro": sensor_values.get("imu_gyro", []),
        "accel": sensor_values.get("imu_accel", []),
    }
    wheel_velocity: list[float] = []
    for actuator_id in range(min(2, session.model.nu)):
        # The OriginBot velocity actuators target one hinge each. Reading the
        # joint DOF rather than assuming qvel offsets keeps this correct if a
        # future model adds another free joint or a suspension DOF.
        joint_id = int(session.model.actuator_trnid[actuator_id, 0])
        dof_id = int(session.model.jnt_dofadr[joint_id]) if joint_id >= 0 else -1
        wheel_velocity.append(float(v[dof_id]) if 0 <= dof_id < len(v) else 0.0)
    contacts: list[dict[str, Any]] = []
    collision = False
    collision_geoms = {"obstacle_a", "obstacle_b", "wall_n", "wall_s", "wall_e", "wall_w"}
    for contact_id in range(min(int(session.data.ncon), 64)):
        contact = session.data.contact[contact_id]
        geom1 = mujoco.mj_id2name(session.model, mujoco.mjtObj.mjOBJ_GEOM, int(contact.geom1)) or f"geom_{contact.geom1}"
        geom2 = mujoco.mj_id2name(session.model, mujoco.mjtObj.mjOBJ_GEOM, int(contact.geom2)) or f"geom_{contact.geom2}"
        contact_collision = geom1 in collision_geoms or geom2 in collision_geoms
        collision = collision or contact_collision
        contacts.append({"geom1": geom1, "geom2": geom2, "distance": float(contact.dist), "collision": contact_collision})
    return {
        "id": session.session_id,
        "episode": {
            "seed": session.seed,
            "domainRandomization": bool(session.domain_randomization),
            "parameters": session.domain_randomization,
        },
        "model": _metadata(session.definition, session.model),
        "time": float(session.data.time),
        "qpos": [float(value) for value in session.data.qpos],
        "qvel": [float(value) for value in session.data.qvel],
        "controls": [float(value) for value in session.data.ctrl],
        "actuatorForces": [float(value) for value in session.data.actuator_force],
        "contacts": contacts,
        "collision": collision,
        **({
            "drive": {
                "wheelRadS": wheel_velocity,
                "wheelTorqueNm": [float(value) for value in session.data.actuator_force[:2]],
                "wheelCtrl": [float(value) for value in session.data.ctrl[:2]],
            }
        } if session.definition.wheel_radius is not None else {}),
        "sensors": {
            "odom": odom,
            "imu": imu,
            # Keep `scan` as the historical flat array consumed by the web
            # recorder; richer LaserScan contract data lives beside it.
            "scan": scan,
            "scanMeta": {
                "count": len(scan),
                "valid": scan_valid,
                "saturated": scan_saturated,
                "rawRanges": scan_raw,
                "angleMin": float(session.definition.lidar_angles[0]) if session.definition.lidar_angles else -math.pi / 2,
                "angleIncrement": float(session.definition.lidar_angles[1] - session.definition.lidar_angles[0]) if len(session.definition.lidar_angles) > 1 else 0.0,
                "rangeMin": 0.05,
                "rangeMax": range_max,
                "frame": "base_lidar",
            },
            "depth": {
                "available": session.definition.key == "originbot",
                "endpoint": f"{depth_base}/depth.jpg",
                "rawEndpoint": f"{depth_base}/depth.png",
                "previewEncoding": "mono8-normalized-jpeg",
                "rawEncoding": "mono16-mm-png",
                "encoding": "mono16-mm",
                "unit": "millimetres",
                "invalidValue": 0,
                "maxMeters": DEPTH_MAX_METERS,
                "frame": "depth_camera",
            },
        },
        "sensorRaw": sensor_values,
        **({"cmd_vel": dict(session.last_cmd_vel)} if session.definition.wheel_radius is not None else {}),
    }


def _renderer(session: SimulationSession, kind: str) -> mujoco.Renderer:
    # FastAPI runs sync endpoints in a worker pool. EGL contexts are thread
    # affine, so never share one renderer between worker threads or between
    # RGB/depth modes (depth mode changes GL framebuffer state).
    key = (threading.get_ident(), kind)
    renderer = session.renderers.get(key)
    if renderer is None:
        renderer = mujoco.Renderer(session.model, height=FRAME_HEIGHT, width=FRAME_WIDTH)
        session.renderers[key] = renderer
    return renderer


def _hide_sensor_debug_geometry(
    renderer: mujoco.Renderer,
    *,
    rangefinder_only: bool = False,
) -> None:
    """Keep rangefinder debug rays out of RGB/depth frames.

    MuJoCo adds rangefinder visualizations as ``mjCAT_DECOR`` geoms. They are
    useful in a developer visualizer, but yellow rays would become fake scene
    pixels in exported depth/RGB observations. The sensor values remain fully
    available through ``sensordata`` and ``scan``.
    """

    decor = int(mujoco.mjtCatBit.mjCAT_DECOR)
    line = int(mujoco.mjtGeom.mjGEOM_LINE)
    for index in range(int(renderer.scene.ngeom)):
        geom = renderer.scene.geoms[index]
        should_hide = int(geom.type) == line if rangefinder_only else bool(int(geom.category) & decor)
        if should_hide:
            if rangefinder_only:
                # Alpha/category are ignored by MuJoCo's depth pass; remove
                # the decor primitive from the render list by changing its
                # type after the scene has been assembled.
                geom.type = int(mujoco.mjtGeom.mjGEOM_NONE)
            else:
                geom.rgba[3] = 0.0
                geom.category = 0


def _render(session: SimulationSession) -> bytes:
    renderer = _renderer(session, "rgb")
    renderer.update_scene(session.data, camera="overview")
    _hide_sensor_debug_geometry(renderer)
    pixels = renderer.render()
    image = Image.fromarray(pixels, mode="RGB")
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=86, optimize=True)
    return output.getvalue()


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    with _sessions_lock:
        active_sessions = len(_sessions)
    return {
        "ok": True,
        "engine": "mujoco",
        "mujoco_version": mujoco.__version__,
        "sessions": {
            "active": active_sessions,
            "capacity": MAX_SESSIONS,
            "ttlSeconds": SESSION_TTL_SECONDS,
            "janitorIntervalSeconds": SESSION_CLEANUP_INTERVAL_SECONDS,
        },
    }


@app.get("/api/models")
def models() -> dict[str, Any]:
    return {
        "models": [
            {
                "key": definition.key,
                "name": definition.name,
                "description": definition.description,
                "source": definition.source,
                "actuators": list(definition.actuator_names),
                **({
                    "wheelRadius": definition.wheel_radius,
                    "trackWidth": definition.track_width,
                    "maxWheelSpeed": definition.max_wheel_speed,
                    "lidarCount": len(definition.lidar_angles),
                    "lidarRangeMax": definition.lidar_range_max,
                } if definition.wheel_radius is not None else {}),
            }
            for definition in MODEL_DEFINITIONS.values()
        ]
    }


@app.post("/api/sessions")
def create_session(request: SessionRequest) -> dict[str, Any]:
    definition = _definition(request.model)
    with _sessions_lock:
        _cleanup_sessions(time.monotonic())
        if len(_sessions) >= MAX_SESSIONS:
            raise HTTPException(status_code=503, detail="Too many active simulations")
        session = _new_session(
            definition,
            seed=request.seed,
            enable_domain_randomization=request.domain_randomization,
        )
        _sessions[session.session_id] = session
        return _state(session)


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str) -> dict[str, Any]:
    """Explicitly end a simulation and release its model/renderer resources."""

    with _sessions_lock:
        session = _drop_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Simulation session not found")
        return {"ok": True, "id": session_id, "closed": True}


@app.get("/api/sessions/{session_id}/state")
def session_state(session_id: str, response: Response) -> dict[str, Any]:
    # State contains live sensor/control values.  An intermediary or browser
    # cache must never replay an older observation to a policy loop.
    response.headers["Cache-Control"] = "no-store"
    with _sessions_lock:
        return _state(_get_session(session_id))


@app.get("/api/sessions/{session_id}/frame.jpg")
def session_frame(session_id: str) -> Response:
    with _sessions_lock:
        session = _get_session(session_id)
        content = _render(session)
    return Response(
        content=content,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )

@app.get("/api/sessions/{session_id}/depth.jpg")
def session_depth(session_id: str) -> Response:
    with _sessions_lock:
        session = _get_session(session_id)
        renderer = _renderer(session, "depth")
        camera = "depth_camera" if session.definition.key == "originbot" else "overview"
        renderer.update_scene(session.data, camera=camera)
        _hide_sensor_debug_geometry(renderer, rangefinder_only=True)
        renderer.enable_depth_rendering()
        # Depth mode may add its sensor/decor pass after the scene update;
        # apply the mask once more so debug rays never enter metric pixels.
        _hide_sensor_debug_geometry(renderer, rangefinder_only=True)
        try:
            pixels = np.asarray(renderer.render(), dtype=np.float32)
        finally:
            renderer.disable_depth_rendering()
        valid = np.isfinite(pixels) & (pixels > 0) & (pixels < DEPTH_MAX_METERS)
        normalized = np.where(valid, 255.0 * (1.0 - np.clip(pixels, 0.0, DEPTH_MAX_METERS) / DEPTH_MAX_METERS), 0.0).astype(np.uint8)
        output = io.BytesIO()
        Image.fromarray(normalized, mode="L").save(output, format="JPEG", quality=90, optimize=True)
    return Response(
        content=output.getvalue(),
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store", "X-Depth-Encoding": "mono8-normalized-jpeg"},
    )


@app.get("/api/sessions/{session_id}/depth.png")
def session_depth_raw(session_id: str) -> Response:
    """Return metric depth as unsigned 16-bit millimetres (zero = invalid)."""
    with _sessions_lock:
        session = _get_session(session_id)
        renderer = _renderer(session, "depth")
        camera = "depth_camera" if session.definition.key == "originbot" else "overview"
        renderer.update_scene(session.data, camera=camera)
        _hide_sensor_debug_geometry(renderer, rangefinder_only=True)
        renderer.enable_depth_rendering()
        _hide_sensor_debug_geometry(renderer, rangefinder_only=True)
        try:
            pixels = np.asarray(renderer.render(), dtype=np.float32)
        finally:
            renderer.disable_depth_rendering()
        valid = np.isfinite(pixels) & (pixels > 0) & (pixels < DEPTH_MAX_METERS)
        millimetres = np.where(valid, np.clip(pixels * 1000.0, 0.0, 65535.0), 0.0).astype(np.uint16)
        output = io.BytesIO()
        Image.fromarray(millimetres, mode="I;16").save(output, format="PNG", optimize=True)
    return Response(
        content=output.getvalue(),
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Depth-Encoding": "mono16-mm-png",
            "X-Depth-Unit": "millimetres",
            "X-Depth-Invalid": "0",
        },
    )


@app.post("/api/sessions/{session_id}/step")
def step_session(session_id: str, request: StepRequest) -> dict[str, Any]:
    with _sessions_lock:
        session = _get_session(session_id)
        controls = [0.0] * session.model.nu
        for index, value in enumerate(request.controls[: session.model.nu]):
            if session.model.actuator_ctrllimited[index]:
                low, high = session.model.actuator_ctrlrange[index]
                controls[index] = max(float(low), min(float(high), float(value)))
            else:
                controls[index] = float(value)
        for index, value in enumerate(controls):
            session.data.ctrl[index] = value
        for _ in range(request.steps):
            mujoco.mj_step(session.model, session.data)
        # `/step` is also a low-level control path for OriginBot.  Keep the
        # high-level feedback truthful when it follows `/cmd_vel`: an omitted
        # controls list means both wheels are stopped, so retaining the prior
        # twist would make recorders attribute motion to a stale command.
        if session.definition.wheel_radius is not None and session.model.nu >= 2:
            radius = session.definition.wheel_radius or 0.09
            track = session.definition.track_width or 0.50
            left, right = (float(controls[0]), float(controls[1]))
            applied_linear = radius * (left + right) / 2.0
            applied_angular = radius * (right - left) / track
            session.last_cmd_vel = {
                "linear": applied_linear,
                "angular": applied_angular,
                "requestedLinear": applied_linear,
                "requestedAngular": applied_angular,
                "appliedLinear": applied_linear,
                "appliedAngular": applied_angular,
                "wheelRadS": [left, right],
                "requestedWheelRadS": [left, right],
                "wheelCtrl": [float(session.data.ctrl[0]), float(session.data.ctrl[1])],
                "wheelTorqueNm": [float(session.data.actuator_force[0]), float(session.data.actuator_force[1])],
                "saturated": False,
                "source": "step",
                "wheelRadius": radius,
                "trackWidth": track,
                "maxWheelSpeed": session.definition.max_wheel_speed or 8.0,
            }
        return _state(session)

@app.post("/api/sessions/{session_id}/cmd_vel")
def cmd_vel(session_id: str, request: CmdVelRequest) -> dict[str, Any]:
    with _sessions_lock:
        session = _get_session(session_id)
        if session.definition.wheel_radius is None or session.model.nu < 2:
            raise HTTPException(status_code=400, detail="cmd_vel is only available for differential-drive models")
        radius = session.definition.wheel_radius or 0.09
        track = session.definition.track_width or 0.50
        declared_max_wheel_speed = session.definition.max_wheel_speed or 8.0
        # Differential-drive inverse kinematics, followed by the same wheel
        # speed clamp used by the physical controller.
        left = (request.linear - request.angular * track / 2) / radius
        right = (request.linear + request.angular * track / 2) / radius
        requested_left, requested_right = left, right
        left = max(-declared_max_wheel_speed, min(declared_max_wheel_speed, left))
        right = max(-declared_max_wheel_speed, min(declared_max_wheel_speed, right))
        for index, value in enumerate((left, right)):
            if session.model.actuator_ctrllimited[index]:
                low, high = session.model.actuator_ctrlrange[index]
                value = max(float(low), min(float(high), value))
            if index == 0:
                left = value
            else:
                right = value
        session.data.ctrl[0] = left
        session.data.ctrl[1] = right
        steps = max(1, int(round(CMD_VEL_STEP_SECONDS / float(session.model.opt.timestep))))
        for _ in range(steps):
            mujoco.mj_step(session.model, session.data)
        applied_linear = radius * (left + right) / 2.0
        applied_angular = radius * (right - left) / track
        session.last_cmd_vel = {
            "linear": request.linear,
            "angular": request.angular,
            "requestedLinear": request.linear,
            "requestedAngular": request.angular,
            "appliedLinear": applied_linear,
            "appliedAngular": applied_angular,
            "wheelRadS": [left, right],
            "requestedWheelRadS": [requested_left, requested_right],
            "wheelCtrl": [float(session.data.ctrl[0]), float(session.data.ctrl[1])],
            "wheelTorqueNm": [float(session.data.actuator_force[0]), float(session.data.actuator_force[1])],
            "saturated": left != requested_left or right != requested_right,
            "source": "cmd_vel",
            "wheelRadius": radius,
            "trackWidth": track,
            "maxWheelSpeed": declared_max_wheel_speed,
        }
        return _state(session)


@app.post("/api/sessions/{session_id}/reset")
def reset_session(session_id: str) -> dict[str, Any]:
    with _sessions_lock:
        session = _get_session(session_id)
        mujoco.mj_resetData(session.model, session.data)
        session.data.ctrl[:] = 0.0
        session.last_cmd_vel = _zero_cmd_vel(session.definition, "reset")
        for index, value in enumerate(session.definition.initial_qpos):
            if index < session.model.nq:
                session.data.qpos[index] = value
        mujoco.mj_forward(session.model, session.data)
        return _state(session)
