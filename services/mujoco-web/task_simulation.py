"""Browser task sessions backed by the same MuJoCo environments as training.

The wire format contains compiled geometry and state, never rendered frames.
Engine scenes are intentionally labelled proxies: the recurrent environments
reduce 14 posture channels to forces, and football uses four high-level
commands rather than pretending to expose the deployment servo contract.
"""
from __future__ import annotations

import importlib
import math
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import mujoco
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from simulation_auth import LOCAL_OWNER, current_owner, reserve_session, release_session


ROOT = Path(__file__).resolve().parents[2]
MAX_TASK_SESSIONS = 32
TASK_SESSION_TTL_SECONDS = 30 * 60
router = APIRouter()
_sessions: dict[str, "TaskSession"] = {}
_sessions_lock = threading.RLock()
_engine_import_lock = threading.Lock()


TASKS = {
    "balance-basketball": ("篮球平衡", "microduck-recurrent", "鸭子在小滚球上保持平衡", 14, 61, 1),
    "balance-stilts": ("高跷平衡", "microduck-recurrent", "固定双杆高跷上的姿态平衡", 14, 61, 1),
    "balance-ball": ("球面平衡", "microduck-recurrent", "大稳定球上的平衡", 14, 61, 1),
    "balance-ladder": ("梯面攀爬", "microduck-recurrent", "垂直梯杆上的攀爬段代理", 14, 61, 1),
    "swing-pump": ("摆动旋转", "microduck-recurrent", "悬挂秋千上的摆幅泵动", 14, 61, 1),
    "football-single-goal-kick": ("足球：单鸭射门", "microduck-football", "单鸭追球并射入球门", 4, 20, 1),
    "football-2v2": ("足球：2v2", "microduck-football", "两只受控鸭与两只脚本对手", 4, 24, 2),
    "football-3v3": ("足球：3v3", "microduck-football", "三只受控鸭与三只脚本对手", 4, 24, 3),
}


def _engine_directory(engine: str) -> Path:
    repository = ROOT / "engines" / engine
    # Production ships a minimal service directory rather than a full clone.
    # Keep the original engine modules beside the service in that layout.
    return repository if repository.is_dir() else Path(__file__).resolve().parent / "engines" / engine


def _contract(task_id: str) -> dict[str, Any]:
    name, engine, description, action_dim, obs_dim, agents = TASKS[task_id]
    football = engine == "microduck-football"
    directory = _engine_directory(engine)
    modules = ["football_env.py"] if football else [
        "proxy_common.py", "balance_env.py", "ballbalance_env.py", "ladder_env.py", "swing_env.py",
    ]
    available = all((directory / module).is_file() for module in modules)
    return {
        "taskId": task_id, "name": name, "description": description, "engine": engine,
        # Recurrent proxy tasks preserve the platform's 61D observation / 14D
        # posture channel contract. Their engine-proxy provenance still marks
        # these as simulator traces, never board evidence. Football exposes a
        # separate high-level contract and cannot bind to a servo-policy run.
        "contractId": f"{task_id}-engine-v1" if football else "microduck-policy-v1",
        "actionDim": action_dim, "observationDim": obs_dim, "numAgents": agents,
        "controlPeriodSeconds": 0.08 if football else 0.02,
        "actionRange": [-1.0, 1.0],
        "actionLabels": ["forward", "strafe", "turn (reserved)", "kick"] if football
        else [f"posture {index + 1}" for index in range(14)],
        "inactiveActionIndices": [2] if football else [],
        "representation": "engine-proxy", "scriptedOpponents": football and agents > 1,
        "available": available,
        "unavailableReason": None if available else "Task engine modules are not installed",
    }


def _make_env(task_id: str, seed: int):
    """Import only when requested so a minimal service remains usable."""
    if task_id not in TASKS:
        raise HTTPException(404, "Unknown task scene")
    if not _contract(task_id)["available"]:
        raise HTTPException(503, "Task engine modules are not installed")
    try:
        with _engine_import_lock:
            directory = str(_engine_directory(TASKS[task_id][1]))
            if directory not in sys.path:
                sys.path.insert(0, directory)
            if task_id.startswith("football-"):
                module = importlib.import_module("football_env")
                task = {"football-single-goal-kick": "single-goal-kick",
                        "football-2v2": "soccer-2v2", "football-3v3": "soccer-3v3"}[task_id]
                return module.MicroDuckFootballEnv(module.FootballConfig(task=task, seed=seed))
            if task_id in ("balance-basketball", "balance-stilts"):
                module = importlib.import_module("balance_env")
                return module.BasketballBalanceEnv(module.BalanceConfig(seed=seed, stilts=task_id == "balance-stilts"))
            module_name, env_class, config_class = {
                "balance-ball": ("ballbalance_env", "BallBalanceEnv", "BallBalanceConfig"),
                "balance-ladder": ("ladder_env", "LadderClimbEnv", "LadderConfig"),
                "swing-pump": ("swing_env", "SwingPumpEnv", "SwingConfig"),
            }[task_id]
            module = importlib.import_module(module_name)
            return getattr(module, env_class)(getattr(module, config_class)(seed=seed))
    except (ImportError, OSError, ValueError, RuntimeError) as exc:
        raise HTTPException(503, "Task simulation engine could not be loaded") from exc


class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    taskId: str = Field(max_length=80)
    seed: int = Field(default=20260922, ge=0, le=2**31 - 1)


class ResetTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)


def _finite(value: Any) -> bool:
    if isinstance(value, (list, tuple)):
        return all(_finite(item) for item in value)
    if isinstance(value, dict):
        return all(_finite(item) for item in value.values())
    if isinstance(value, (float, int, np.number)):
        return math.isfinite(float(value))
    return value is None or isinstance(value, (str, bool))


class StepTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: list[float] | list[list[float]] = Field(max_length=14)
    steps: int = Field(default=1, ge=1, le=10)

    @field_validator("action")
    @classmethod
    def finite_action(cls, value):
        if not _finite(value):
            raise ValueError("action must contain finite numbers")
        return value


class ReplayTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    taskId: str = Field(max_length=80)
    qpos: list[float] = Field(max_length=128)
    qvel: list[float] = Field(max_length=128)
    integrationState: list[float] = Field(max_length=4096)
    time: float = Field(ge=0)
    stepCount: int = Field(ge=0, le=1000000)
    action: list[float] | list[list[float]] = Field(max_length=14)
    reward: float | list[float]
    done: bool
    posture: list[float] | None = Field(default=None, max_length=14)
    prevPosture: list[float] | None = Field(default=None, max_length=14)
    lastAction: list[float] | None = Field(default=None, max_length=14)
    command: list[float] | None = Field(default=None, max_length=13)
    lastBallDistance: float | None = None
    lastGoalDistance: float | None = None
    scored: bool | None = None

    @field_validator("qpos", "qvel", "integrationState", "time", "action", "reward", "posture",
                     "prevPosture", "lastAction", "command", "lastBallDistance", "lastGoalDistance")
    @classmethod
    def finite_state(cls, value):
        if not _finite(value):
            raise ValueError("replay state must contain finite numbers")
        return value


@dataclass
class TaskSession:
    session_id: str
    task_id: str
    env: Any
    seed: int
    last_seen: float
    action: np.ndarray
    reward: Any = 0.0
    done: bool = False
    metrics: dict[str, Any] = field(default_factory=dict)
    owner: str = LOCAL_OWNER
    lock: threading.RLock = field(default_factory=threading.RLock)


def cleanup_task_sessions(now: float | None = None) -> None:
    now = time.monotonic() if now is None else now
    with _sessions_lock:
        for session_id, session in tuple(_sessions.items()):
            with session.lock:
                if now - session.last_seen > TASK_SESSION_TTL_SECONDS:
                    _sessions.pop(session_id, None)
                    release_session("task", session_id)


def close_task_sessions() -> None:
    with _sessions_lock:
        for session_id, session in _sessions.items():
            with session.lock:
                release_session("task", session_id)
        _sessions.clear()


@contextmanager
def _locked_session(session_id: str):
    with _sessions_lock:
        cleanup_task_sessions()
        session = _sessions.get(session_id)
        if session is None or session.owner != current_owner():
            raise HTTPException(404, "Task session expired or does not exist")
        session.lock.acquire()
        session.last_seen = time.monotonic()
    try:
        yield session
    finally:
        session.lock.release()


def _json(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {key: _json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json(item) for item in value]
    return value


def _is_football(session):
    return session.task_id.startswith("football-")


def _wire_action(session):
    action = session.action
    return action[0].tolist() if _is_football(session) and session.env.config.blue_count == 1 else action.tolist()


def _wire_reward(session):
    reward = np.asarray(session.reward)
    if _is_football(session) and session.env.config.blue_count == 1:
        return float(reward.reshape(-1)[0])
    return _json(session.reward)


def _action(session: TaskSession, value) -> np.ndarray:
    try:
        action = np.asarray(value, dtype=np.float64)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, "action shape does not match the task contract") from exc
    contract = _contract(session.task_id)
    expected = (contract["numAgents"], contract["actionDim"]) if _is_football(session) else (14,)
    if _is_football(session) and contract["numAgents"] == 1 and action.shape == (4,):
        action = action[None, :]
    if action.shape != expected or not np.isfinite(action).all():
        raise HTTPException(422, f"action must have shape {list(expected)} and contain finite numbers")
    if np.any(np.abs(action) > 1.0):
        raise HTTPException(422, "action values must be within [-1, 1]")
    return action


def _metrics(session: TaskSession) -> dict[str, Any]:
    env = session.env
    if _is_football(session):
        ball_x, ball_y = env._ball_xy()
        return {"scored": bool(env.scored), "ballX": float(ball_x), "ballY": float(ball_y),
                "goalDistance": env._goal_distance(), "ballDistance": env._distance_to_ball(0)}
    _, extra = env._extra_termination()
    if mujoco.mj_name2id(env.model, mujoco.mjtObj.mjOBJ_JOINT, "ball_free") < 0:
        extra = {name: value for name, value in extra.items() if name != "rolledAway"}
    tilt = env._tilt()
    return {"tilt": tilt, "fallen": tilt > 1.0, **extra}


def _display_half_extent(geom_type: str, size: np.ndarray, rotation: np.ndarray) -> np.ndarray:
    """World AABB support distances for display only; compiled physics is untouched."""
    if geom_type == "sphere":
        return np.full(3, size[0])
    if geom_type == "ellipsoid":
        return np.sqrt(np.sum((rotation * size) ** 2, axis=1))
    if geom_type in ("capsule", "cylinder"):
        axis = rotation[:, 2]
        radial = np.full(3, size[0]) if geom_type == "capsule" else size[0] * np.sqrt(np.maximum(0, 1 - axis ** 2))
        return np.abs(axis) * size[1] + radial
    return np.abs(rotation) @ size


def _display_robots(session: TaskSession, geoms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Visual meshes follow actual proxy bodies; these are not servo joint states."""
    env = session.env
    football = _is_football(session)
    bodies = env.duck_bodies if football else [
        mujoco.mj_name2id(env.model, mujoco.mjtObj.mjOBJ_BODY, "duck"),
    ]
    robots = []
    for index, body_id in enumerate(bodies):
        if body_id < 0:
            continue
        name = mujoco.mj_id2name(env.model, mujoco.mjtObj.mjOBJ_BODY, body_id)
        proxy_name = name if football else "duck_body"
        robots.append({
            "id": name, "bodyId": int(body_id),
            "proxyGeomIds": [geom["id"] for geom in geoms
                             if geom["bodyId"] == body_id and geom["name"] == proxy_name],
            "xpos": env.data.xpos[body_id].tolist(),
            "xmat": env.data.xmat[body_id].tolist(),
            "posture": None if football else env.posture.tolist(),
            "team": ("blue" if index < env.config.blue_count else "red") if football else None,
            "footOffset": [0.0, 0.0, -0.18] if football else [0.0, 0.0, 0.0],
            # The official display model's feet are separated along local Y;
            # the stilt proxy rods are separated along local X. Keep this
            # display calibration separate from the actual physics rotation.
            "visualYaw": math.pi / 2 if session.task_id == "balance-stilts" else 0.0,
        })
    return robots


def _scene(session: TaskSession) -> dict[str, Any]:
    env = session.env
    types = {int(getattr(mujoco.mjtGeom, "mjGEOM_" + name.upper())): name for name in
             ("plane", "sphere", "capsule", "ellipsoid", "cylinder", "box")}
    geoms = []
    extent_points = []
    for index in range(env.model.ngeom):
        name = mujoco.mj_id2name(env.model, mujoco.mjtObj.mjOBJ_GEOM, index) or f"geom-{index}"
        geom_type = types.get(int(env.model.geom_type[index]), "unsupported")
        color = env.model.geom_rgba[index].astype(float).copy()
        # Supply a display palette for uncoloured engine geoms. Never mutate
        # the model: contacts, masses, friction and dynamics stay identical.
        if np.allclose(color, [0.5, 0.5, 0.5, 1.0]):
            color = np.array([0.19, 0.28, 0.34, 1.0])
            if name in ("floor", "field"):
                color = np.array([0.78, 0.83, 0.82, 1.0])
            elif name == "duck_body":
                color = np.array([0.98, 0.68, 0.14, 1.0])
            elif name == "ball":
                color = np.array([0.92, 0.38, 0.12, 1.0])
        if _is_football(session) and name.startswith("duck"):
            try:
                opponent = int(name[4:]) >= env.config.blue_count
                color = np.array([0.86, 0.20, 0.22, 1.0] if opponent else [0.12, 0.45, 0.90, 1.0])
            except ValueError:
                pass
        position = env.data.geom_xpos[index].copy()
        size = env.model.geom_size[index].copy()
        geoms.append({"id": index, "name": name, "type": geom_type, "size": size.tolist(),
                      "rgba": color.tolist(), "modelRgba": env.model.geom_rgba[index].tolist(),
                      "xpos": position.tolist(), "xmat": env.data.geom_xmat[index].tolist(),
                      "bodyId": int(env.model.geom_bodyid[index])})
        if geom_type != "plane" and color[3] > 0:
            half_extent = _display_half_extent(geom_type, size, env.data.geom_xmat[index].reshape(3, 3))
            extent_points.extend([position - half_extent, position + half_extent])
    points = np.asarray(extent_points if extent_points else [[-.5, -.5, 0], [.5, .5, 1]])
    low, high = points.min(axis=0), points.max(axis=0)
    center = (low + high) / 2
    radius = max(0.6, float(np.linalg.norm(high - low) / 2))
    return {"geoms": geoms, "robots": _display_robots(session, geoms),
            "robotRepresentation": "display-adaptation",
            "bounds": {"center": center.tolist(), "radius": radius,
                                       "low": low.tolist(), "high": high.tolist()},
            "representation": "engine-proxy"}


def _snapshot(session: TaskSession) -> dict[str, Any]:
    env = session.env
    spec = mujoco.mjtState.mjSTATE_INTEGRATION
    integration = np.zeros(mujoco.mj_stateSize(env.model, spec))
    mujoco.mj_getState(env.model, env.data, integration, spec)
    state = {"taskId": session.task_id, "qpos": env.data.qpos.tolist(), "qvel": env.data.qvel.tolist(),
             "integrationState": integration.tolist(), "time": float(env.data.time),
             "stepCount": int(env.step_count), "action": _wire_action(session),
             "reward": _wire_reward(session), "done": session.done}
    if _is_football(session):
        state.update(lastBallDistance=env.last_ball_distance, lastGoalDistance=env.last_goal_distance,
                     scored=bool(env.scored))
    else:
        state.update(posture=env.posture.tolist(), prevPosture=env.prev_posture.tolist(),
                     lastAction=env.last_action.tolist(), command=env.command.tolist())
    return state


def _state(session: TaskSession) -> dict[str, Any]:
    env = session.env
    # mj_step can leave derived positions at its pre-integration stage.
    # Forward before exporting the actual current qpos to avoid a one-frame lag.
    mujoco.mj_forward(env.model, env.data)
    obs = np.stack([env.observe(index) for index in range(env.config.blue_count)]) if _is_football(session) else env.observation()
    if _is_football(session) and env.config.blue_count == 1:
        obs = obs[0]
    replay = _snapshot(session)
    state = {"sessionId": session.session_id, "taskId": session.task_id, "seed": session.seed,
             "time": float(env.data.time), "stepCount": int(env.step_count), "done": session.done,
             "reward": _wire_reward(session), "metrics": _json(_metrics(session)),
             "observation": obs.tolist(), "action": _wire_action(session),
             "contract": _contract(session.task_id), "qpos": replay["qpos"], "qvel": replay["qvel"],
             "replay": replay, "scene": _scene(session)}
    if not _finite(state):
        session.done = True
        raise HTTPException(503, "Task simulation produced non-finite state; reset the session")
    return state


@router.get("/api/task-scenes")
def task_scenes():
    return {"scenes": [_contract(task_id) for task_id in TASKS]}


@router.post("/api/task-sessions")
def create_task_session(request: CreateTaskRequest):
    with _sessions_lock:
        cleanup_task_sessions()
        if len(_sessions) >= MAX_TASK_SESSIONS:
            raise HTTPException(429, "Task simulation session capacity reached; close an idle session")
        session_id, owner = uuid.uuid4().hex, current_owner()
        reserve_session("task", session_id, owner)
        try:
            env = _make_env(request.taskId, request.seed)
            env.reset(seed=request.seed)
            contract = _contract(request.taskId)
            shape = (contract["numAgents"], contract["actionDim"]) if request.taskId.startswith("football-") else (14,)
            session = TaskSession(session_id, request.taskId, env, request.seed,
                                  time.monotonic(), np.zeros(shape), owner=owner)
            if _is_football(session):
                session.reward = np.zeros(env.config.blue_count)
            state = _state(session)
            _sessions[session.session_id] = session
            return state
        except Exception:
            release_session("task", session_id)
            raise


@router.get("/api/task-sessions/{session_id}/state")
def task_state(session_id: str):
    with _locked_session(session_id) as session:
        return _state(session)


@router.post("/api/task-sessions/{session_id}/step")
def step_task_session(session_id: str, request: StepTaskRequest):
    with _locked_session(session_id) as session:
        if session.done:
            raise HTTPException(409, "Episode finished; reset the task session before stepping")
        action = _action(session, request.action)
        for _ in range(request.steps):
            _, reward, done, metrics = session.env.step(action)
            session.action = action.copy()
            session.reward = reward
            session.done = bool(done)
            session.metrics = metrics
            if session.done:
                break
        return _state(session)


@router.post("/api/task-sessions/{session_id}/reset")
def reset_task_session(session_id: str, request: ResetTaskRequest):
    with _locked_session(session_id) as session:
        if request.seed is not None:
            session.seed = request.seed
        session.env.reset(seed=session.seed)
        session.action.fill(0)
        session.reward = np.zeros(session.env.config.blue_count) if _is_football(session) else 0.0
        session.done = False
        session.metrics = {}
        return _state(session)


def _vector(value, size, label):
    if value is None or len(value) != size:
        raise HTTPException(422, f"{label} must contain exactly {size} numbers")
    values = np.asarray(value, dtype=float)
    if not np.isfinite(values).all():
        raise HTTPException(422, f"{label} must contain finite numbers")
    return values


@router.post("/api/task-sessions/{session_id}/replay")
def replay_task_session(session_id: str, request: ReplayTaskRequest):
    with _locked_session(session_id) as session:
        env = session.env
        if request.taskId != session.task_id:
            raise HTTPException(422, "Replay task does not match this session")
        qpos = _vector(request.qpos, env.model.nq, "qpos")
        qvel = _vector(request.qvel, env.model.nv, "qvel")
        integration = _vector(request.integrationState,
                              mujoco.mj_stateSize(env.model, mujoco.mjtState.mjSTATE_INTEGRATION), "integrationState")
        # MuJoCo's integration vector begins with time, qpos, qvel. Reject
        # contradictory redundant values before mutating any live state.
        if not (integration[0] == request.time and np.array_equal(integration[1:1 + env.model.nq], qpos)
                and np.array_equal(integration[1 + env.model.nq:1 + env.model.nq + env.model.nv], qvel)):
            raise HTTPException(422, "Replay integrationState does not match time/qpos/qvel")
        for joint in range(env.model.njnt):
            kind = int(env.model.jnt_type[joint])
            start = int(env.model.jnt_qposadr[joint])
            offset = 3 if kind == int(mujoco.mjtJoint.mjJNT_FREE) else 0
            if kind in (int(mujoco.mjtJoint.mjJNT_FREE), int(mujoco.mjtJoint.mjJNT_BALL)):
                if not np.isclose(np.linalg.norm(qpos[start + offset:start + offset + 4]), 1.0, atol=1e-6):
                    raise HTTPException(422, "Replay joint quaternions must be unit length")
        action = _action(session, request.action)
        engine_values = {}
        if _is_football(session):
            if request.lastBallDistance is None or request.lastGoalDistance is None or request.scored is None:
                raise HTTPException(422, "Football replay requires distance history and scored state")
            if request.lastBallDistance < 0 or request.lastGoalDistance < 0:
                raise HTTPException(422, "Football replay distances cannot be negative")
        else:
            engine_values = {"posture": _vector(request.posture, 14, "posture"),
                             "prev_posture": _vector(request.prevPosture, 14, "prevPosture"),
                             "last_action": _vector(request.lastAction, 14, "lastAction"),
                             "command": _vector(request.command, 13, "command")}
            if any(np.any(np.abs(engine_values[key]) > 1.0) for key in ("posture", "prev_posture", "last_action")):
                raise HTTPException(422, "Replay posture/action values must be within [-1, 1]")
        reward = np.asarray(request.reward)
        expected_reward = (env.config.blue_count,) if _is_football(session) and env.config.blue_count > 1 else ()
        if reward.shape != expected_reward:
            # A newly reset football session has a scalar zero reward.
            if not (_is_football(session) and reward.shape == () and float(reward) == 0.0 and request.stepCount == 0):
                raise HTTPException(422, "Replay reward shape does not match task")
        mujoco.mj_setState(env.model, env.data, integration, mujoco.mjtState.mjSTATE_INTEGRATION)
        env.step_count = request.stepCount
        if _is_football(session):
            env.last_ball_distance = request.lastBallDistance
            env.last_goal_distance = request.lastGoalDistance
            env.scored = request.scored
        else:
            env.posture = engine_values["posture"].copy()
            env.prev_posture = engine_values["prev_posture"].copy()
            env.last_action = engine_values["last_action"].copy()
            env.command = engine_values["command"].copy()
        session.action = action.copy()
        session.reward = request.reward
        session.done = request.done
        return _state(session)


@router.delete("/api/task-sessions/{session_id}")
def delete_task_session(session_id: str):
    with _sessions_lock:
        session = _sessions.get(session_id)
        if session is not None:
            if session.owner != current_owner():
                raise HTTPException(404, "Task session expired or does not exist")
            with session.lock:
                _sessions.pop(session_id, None)
                release_session("task", session_id)
    return {"deleted": True}
