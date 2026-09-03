from __future__ import annotations

import io
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import mujoco
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field

from models import MODEL_DEFINITIONS, ModelDefinition


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
MAX_SESSIONS = 24
SESSION_TTL_SECONDS = 30 * 60
FRAME_WIDTH = 640
FRAME_HEIGHT = 480


@dataclass
class SimulationSession:
    session_id: str
    definition: ModelDefinition
    model: mujoco.MjModel
    data: mujoco.MjData
    last_seen: float
    renderers: dict[int, mujoco.Renderer] = field(default_factory=dict)


class StepRequest(BaseModel):
    controls: list[float] = Field(default_factory=list)
    steps: int = Field(default=1, ge=1, le=50)


class SessionRequest(BaseModel):
    model: str = "cartpole"


app = FastAPI(
    title="MuJoCo Web Playground",
    description="A fixed-model browser playground backed by the MuJoCo physics engine.",
    version="1.0.0",
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_sessions: dict[str, SimulationSession] = {}
_sessions_lock = threading.RLock()


def _definition(key: str) -> ModelDefinition:
    try:
        return MODEL_DEFINITIONS[key]
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown model: {key}") from exc


def _cleanup_sessions(now: float) -> None:
    expired = [
        session_id
        for session_id, session in _sessions.items()
        if now - session.last_seen > SESSION_TTL_SECONDS
    ]
    for session_id in expired:
        session = _sessions.pop(session_id)
        for renderer in session.renderers.values():
            close = getattr(renderer, "close", None)
            if close is not None:
                close()


def _metadata(definition: ModelDefinition, model: mujoco.MjModel) -> dict[str, Any]:
    return {
        "key": definition.key,
        "name": definition.name,
        "description": definition.description,
        "timestep": float(model.opt.timestep),
        "actuators": [
            {"name": name, "min": -1.0, "max": 1.0}
            for name in definition.actuator_names
        ],
    }


def _new_session(definition: ModelDefinition) -> SimulationSession:
    model = mujoco.MjModel.from_xml_string(definition.xml)
    data = mujoco.MjData(model)
    for index, value in enumerate(definition.initial_qpos):
        if index < model.nq:
            data.qpos[index] = value
    mujoco.mj_forward(model, data)
    return SimulationSession(
        session_id=uuid.uuid4().hex,
        definition=definition,
        model=model,
        data=data,
        last_seen=time.monotonic(),
    )


def _get_session(session_id: str) -> SimulationSession:
    with _sessions_lock:
        session = _sessions.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Simulation session not found")
        session.last_seen = time.monotonic()
        return session


def _state(session: SimulationSession) -> dict[str, Any]:
    return {
        "id": session.session_id,
        "model": _metadata(session.definition, session.model),
        "time": float(session.data.time),
        "qpos": [float(value) for value in session.data.qpos],
        "qvel": [float(value) for value in session.data.qvel],
        "controls": [float(value) for value in session.data.ctrl],
    }


def _render(session: SimulationSession) -> bytes:
    # FastAPI runs sync endpoints in a worker pool. EGL contexts are thread
    # affine, so never share one renderer between worker threads.
    thread_id = threading.get_ident()
    renderer = session.renderers.get(thread_id)
    if renderer is None:
        renderer = mujoco.Renderer(session.model, height=FRAME_HEIGHT, width=FRAME_WIDTH)
        session.renderers[thread_id] = renderer
    renderer.update_scene(session.data, camera="overview")
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
    return {"ok": True, "engine": "mujoco", "mujoco_version": mujoco.__version__}


@app.get("/api/models")
def models() -> dict[str, Any]:
    return {
        "models": [
            {
                "key": definition.key,
                "name": definition.name,
                "description": definition.description,
                "actuators": list(definition.actuator_names),
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
        session = _new_session(definition)
        _sessions[session.session_id] = session
        return _state(session)


@app.get("/api/sessions/{session_id}/state")
def session_state(session_id: str) -> dict[str, Any]:
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


@app.post("/api/sessions/{session_id}/step")
def step_session(session_id: str, request: StepRequest) -> dict[str, Any]:
    with _sessions_lock:
        session = _get_session(session_id)
        controls = [0.0] * session.model.nu
        for index, value in enumerate(request.controls[: session.model.nu]):
            controls[index] = max(-1.0, min(1.0, float(value)))
        for index, value in enumerate(controls):
            session.data.ctrl[index] = value
        for _ in range(request.steps):
            mujoco.mj_step(session.model, session.data)
        return _state(session)


@app.post("/api/sessions/{session_id}/reset")
def reset_session(session_id: str) -> dict[str, Any]:
    with _sessions_lock:
        session = _get_session(session_id)
        mujoco.mj_resetData(session.model, session.data)
        for index, value in enumerate(session.definition.initial_qpos):
            if index < session.model.nq:
                session.data.qpos[index] = value
        mujoco.mj_forward(session.model, session.data)
        return _state(session)
