"""Interactive closed-loop MicroDuck: PC MuJoCo sim + remote/local policy.

The evaluator (``report.py``) replays *fixed-command* episodes into a report;
this module is the operator-facing counterpart: a live 50 Hz loop where the
velocity twist ``[lin_vel_x, lin_vel_y, ang_vel_z]`` can be changed at any
control step. The policy input is the evaluator's 61D contract, whose trailing
command block is twist(3) + head pose(4) + body pose(6) — the loop drives the
twist live and holds head/body at their rest pose, the same defaults every
shipped envelope evaluates with, so a new command reaches the policy on the
very next tick without touching the graph.

Two inference backends:

* ``local`` — ONNX Runtime on this machine via the evaluator's own loader
  (``policy.load_policy``), so feed-forward, stacked-history and recurrent
  graphs all behave exactly as in evaluation.
* ``board`` — every observation is POSTed to a board station agent
  (``POST /v1/station/policy-infer``, body ``{"observations": [row]}``), the
  same wire contract the workbench's board trial uses. PC keeps the physics,
  the board keeps the model.

The loop is deliberately honest about slipping: if inference or scheduling
makes a tick late, the deficit is counted and reported, never hidden by
stepping faster to catch up.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

import numpy as np

from .envelope import NOMINAL
from .policy import load_policy
from .sim import CONTROL_HZ, MicroDuckSim, find_scene

#: The velocity envelope the shipped policies train against is ±0.4 m/s
#: (``envelope.py``); the interactive clamp keeps a little headroom above it so
#: an operator can probe the edge, while a typo like ``v 5 0 0`` cannot leave
#: the trained command distribution.
MAX_LINEAR_MPS = 0.5
MAX_ANGULAR_RADPS = 1.5
LINEAR_STEP_MPS = 0.1
ANGULAR_STEP_RADPS = 0.5

BOARD_INFER_PATH = "/v1/station/policy-infer"
BOARD_STATUS_PATH = "/v1/station/status"


class TwistCommand:
    """The operator-editable twist, safe to mutate from the REPL thread."""

    def __init__(self, twist: np.ndarray) -> None:
        self._lock = threading.Lock()
        self._value = self._clamp(np.asarray(twist, dtype=np.float32))

    @staticmethod
    def _clamp(twist: np.ndarray) -> np.ndarray:
        clamped = np.stack(
            [
                np.clip(twist[0], -MAX_LINEAR_MPS, MAX_LINEAR_MPS),
                np.clip(twist[1], -MAX_LINEAR_MPS, MAX_LINEAR_MPS),
                np.clip(twist[2], -MAX_ANGULAR_RADPS, MAX_ANGULAR_RADPS),
            ]
        ).astype(np.float32)
        return clamped

    def get(self) -> np.ndarray:
        with self._lock:
            return self._value.copy()

    def set(self, twist: np.ndarray) -> np.ndarray:
        with self._lock:
            self._value = self._clamp(np.asarray(twist, dtype=np.float32))
            return self._value.copy()

    def nudge(self, d_lin: float = 0.0, d_ang: float = 0.0) -> np.ndarray:
        with self._lock:
            self._value = self._clamp(self._value + np.asarray([d_lin, 0.0, d_ang], dtype=np.float32))
            return self._value.copy()


def parse_twist(text: str) -> np.ndarray:
    """Parse ``"vx,vy,wz"`` (commas or spaces) into a float32 twist."""
    parts = [part for part in text.replace(",", " ").split() if part]
    if len(parts) != 3:
        raise ValueError(f"twist needs 3 numbers vx,vy,wz, got {text!r}")
    try:
        values = np.asarray([float(part) for part in parts], dtype=np.float32)
    except ValueError as error:
        raise ValueError(f"twist is not numeric: {text!r}") from error
    if not np.all(np.isfinite(values)):
        raise ValueError(f"twist must be finite: {text!r}")
    return TwistCommand._clamp(values)


class BoardInferError(RuntimeError):
    """The board station agent refused or could not serve an inference."""


class BoardPolicy:
    """One-row client for the board station batch-inference contract.

    Response rows are the loaded model's actions; the board runtime owns any
    recurrent/stacked state, so this side stays stateless on purpose.

    The connection is reused across ticks: at 50 Hz a fresh TCP handshake per
    inference consumes most of the 20 ms budget, so one keep-alive connection
    is held open and re-opened (once per call) if the agent dropped it.
    """

    def __init__(self, base_url: str, *, token: str = "", timeout_s: float = 2.0) -> None:
        url = base_url.rstrip("/")
        if not url.endswith(BOARD_INFER_PATH):
            url += BOARD_INFER_PATH
        self.url = url
        self.status_url = url[: -len(BOARD_INFER_PATH)] + BOARD_STATUS_PATH
        parsed = urlsplit(self.url)
        self._scheme = parsed.scheme or "http"
        self._host = parsed.hostname or "127.0.0.1"
        self._port = parsed.port or (443 if self._scheme == "https" else 80)
        self._infer_path = parsed.path or BOARD_INFER_PATH
        self._status_path = self._infer_path[: -len(BOARD_INFER_PATH)] + BOARD_STATUS_PATH
        self.token = token or ""
        self.timeout_s = timeout_s
        self.calls = 0
        self._connection: http.client.HTTPConnection | None = None

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Connection": "keep-alive"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _open_connection(self) -> http.client.HTTPConnection:
        if self._scheme == "https":
            return http.client.HTTPSConnection(self._host, self._port, timeout=self.timeout_s)
        return http.client.HTTPConnection(self._host, self._port, timeout=self.timeout_s)

    def _request(self, method: str, path: str, body: bytes | None) -> tuple[int, dict[str, Any]]:
        """One JSON round trip on the reused connection; one reconnect retry.

        The retry exists for the keep-alive race: an agent-side idle timeout
        closes the socket between our ticks, which surfaces as a broken request
        on the first attempt, not a server refusal.
        """
        last_error: Exception | None = None
        for attempt in (0, 1):
            connection = self._connection
            if connection is None:
                connection = self._open_connection()
            try:
                connection.request(method, path, body=body, headers=self._headers())
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                self._connection = None if response.will_close else connection
                return response.status, payload
            except (http.client.HTTPException, OSError, TimeoutError, json.JSONDecodeError) as error:
                try:
                    connection.close()
                except OSError:
                    pass
                self._connection = None
                last_error = error
        raise BoardInferError(f"board request failed at {self.url}: {last_error}") from last_error

    def check_reachable(self) -> dict[str, Any]:
        status, payload = self._request("GET", self._status_path, None)
        if status >= 400 or not payload.get("ok", True):
            raise BoardInferError(
                f"board station not reachable at {self.status_url} "
                f"(HTTP {status}): {json.dumps(payload)[:200]}"
            )
        return payload

    def act(self, observation: np.ndarray) -> np.ndarray:
        body = json.dumps({"observations": [observation.astype(np.float32).tolist()]}).encode("utf-8")
        status, payload = self._request("POST", self._infer_path, body)
        actions = payload.get("actions") if isinstance(payload, dict) else None
        if status >= 400 or not payload.get("ok") or not isinstance(actions, list) or not actions:
            raise BoardInferError(
                f"board inference returned no actions (HTTP {status}): {json.dumps(payload)[:200]}"
            )
        row = np.asarray(actions[0], dtype=np.float32)
        if row.shape != (14,):
            hint = (
                " (row width equals the observation width — this looks like the "
                "loopback reference agent, which mocks inference per-row and is "
                "not a policy; point --board-url at a board agent with a loaded model)"
                if row.shape == observation.shape
                else ""
            )
            raise BoardInferError(f"board returned action of shape {row.shape}, expected (14,){hint}")
        if not np.all(np.isfinite(row)):
            raise BoardInferError("board returned a non-finite action")
        self.calls += 1
        return row


def _format_status(tick: int, sim: MicroDuckSim, command: np.ndarray, speed_ema: float) -> str:
    pitch, roll = sim.body_tilt()
    x, y = sim.base_xy()
    return (
        f"t={tick / CONTROL_HZ:7.2f}s "
        f"cmd=[{command[0]:+.2f} {command[1]:+.2f} {command[2]:+.2f}] "
        f"xy=({x:+.3f},{y:+.3f}) z={sim.base_z():.3f} "
        f"tilt=({np.degrees(pitch):+5.1f}°,{np.degrees(roll):+5.1f}°) "
        f"v≈{speed_ema:.2f}m/s"
    )


def run_live(
    sim: MicroDuckSim,
    backend,
    command: TwistCommand,
    *,
    duration_s: float = 0.0,
    print_hz: float = 5.0,
    on_step: Callable[[int, np.ndarray, np.ndarray], None] | None = None,
    on_status: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Step the sim at CONTROL_HZ until ``duration_s`` elapses (0 = until stopped).

    The caller ends the loop via ``on_step`` returning ``False``, or ^C, which
    is absorbed so the summary of what was measured is still returned.
    """
    emit = on_status or (lambda line: print(line, flush=True))
    envelope = NOMINAL
    state = envelope.initial_state
    sim.reset(
        base_xy=(state.base_pos[0], state.base_pos[1]),
        base_yaw=state.base_yaw,
        ball_distance=None,
        payload_fraction=envelope.payload_fraction,
    )
    reset = getattr(backend, "reset", None)
    if callable(reset):
        reset()

    last_action = np.zeros(14, dtype=np.float32)
    status_every = max(1, int(round(CONTROL_HZ / max(print_hz, 1e-6))))
    speed_ema = 0.0
    previous_xy = np.asarray(sim.base_xy(), dtype=np.float64)
    slipped_ticks = 0
    fall_reported = False
    tick = 0
    started = time.monotonic()
    next_tick = started
    stop = False
    summary: dict[str, Any] = {}
    try:
        while not stop:
            now = time.monotonic()
            if now < next_tick:
                time.sleep(next_tick - now)
            else:
                slipped_ticks += int((now - next_tick) / (1.0 / CONTROL_HZ))
            next_tick += 1.0 / CONTROL_HZ
            if duration_s > 0 and now - started >= duration_s:
                break

            twist = command.get()
            # The 13-slot command block: live twist + head/body pose at rest,
            # the defaults every shipped envelope evaluates with.
            command_block = np.concatenate(
                [twist, np.zeros(10, dtype=np.float32)]
            ).astype(np.float32)
            observation = sim.observation(command_block, last_action)
            action = backend.act(observation)
            sim.apply_action(action)
            sim.advance()
            last_action = action.astype(np.float32)
            tick += 1

            xy = np.asarray(sim.base_xy(), dtype=np.float64)
            instant = float(np.linalg.norm(xy - previous_xy)) * CONTROL_HZ
            previous_xy = xy
            speed_ema += 0.1 * (instant - speed_ema)

            if sim.trunk_ground_contact():
                if not fall_reported:
                    emit(f"[!] t={tick / CONTROL_HZ:.2f}s 躯干触地（跌倒），闭环继续，可改指令复位姿态")
                    fall_reported = True
            else:
                fall_reported = False

            if on_step is not None:
                if on_step(tick, observation, action) is False:
                    stop = True
            if tick % status_every == 0:
                emit(_format_status(tick, sim, twist, speed_ema))
    except KeyboardInterrupt:
        # Interactive ^C ends the loop and still reports what was measured.
        pass

    wall = time.monotonic() - started
    return {
        "steps": tick,
        "wallSeconds": round(wall, 3),
        "expectedSteps": int(round((duration_s if duration_s > 0 else wall) * CONTROL_HZ)),
        "slippedTicks": slipped_ticks,
        "finalBase": [*sim.base_xy(), sim.base_z()],
        "finalCommand": command.get().tolist(),
    }


# ---- interactive command REPL ---------------------------------------------
HELP = (
    "指令：w/s 前后 ±0.1 m/s，a/d 转向 ±0.5 rad/s，0 站立，"
    "v vx,vy,wz 直接设速度，status 当前状态，q 退出"
)

#: The hello-world choreography: forward → turn in place → stand, the three
#: commands a velocity policy exists to track, in one hands-free run.
DEMO_SCHEDULE = [
    ("前进 0.3 m/s", (0.3, 0.0, 0.0), 2.0),
    ("原地左转 0.5 rad/s", (0.0, 0.0, 0.5), 2.0),
    ("停止站立", (0.0, 0.0, 0.0), 1.0),
]


def run_demo(
    sim: MicroDuckSim,
    backend,
    *,
    schedule: list[tuple[str, tuple[float, float, float]]] | None = None,
    print_hz: float = 5.0,
    on_status: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """One-command hello world: walk the preset command choreography.

    Each stage announces itself, sets the twist, and runs for its duration —
    the observable proof that a changed command reaches the policy on the next
    tick and the sim answers in closed loop.
    """
    stages = list(schedule or DEMO_SCHEDULE)
    command = TwistCommand(np.zeros(3, dtype=np.float32))
    emit = on_status or (lambda line: print(line, flush=True))
    ticks_per_stage = [int(round(seconds * CONTROL_HZ)) for _, _, seconds in stages]
    total_ticks = sum(ticks_per_stage)
    state = {"stage": -1}

    def on_step(tick: int, _observation: np.ndarray, _action: np.ndarray):
        index = state["stage"]
        if tick >= total_ticks:
            emit(f"demo 编排完成：{len(stages)} 个阶段，共 {total_ticks / CONTROL_HZ:.0f}s")
            return False
        next_index = 0
        consumed = 0
        for candidate, width in enumerate(ticks_per_stage):
            if tick < consumed + width:
                next_index = candidate
                break
            consumed += width
        if next_index != index:
            label, twist, seconds = stages[next_index]
            command.set(twist)
            state["stage"] = next_index
            emit(f"▶ 阶段 {next_index + 1}/{len(stages)}：{label}（{seconds:.0f}s）→ cmd={list(twist)}")
        return None

    return run_live(
        sim,
        backend,
        command,
        duration_s=0.0,
        print_hz=print_hz,
        on_step=on_step,
        on_status=emit,
    )


def _spawn_repl(command: TwistCommand, on_change: Callable[[str], None]) -> threading.Thread:
    def loop() -> None:
        for line in sys.stdin:
            text = line.strip()
            if not text:
                continue
            try:
                if text in ("q", "quit", "exit"):
                    on_change("q")
                    return
                if text in ("w", "s"):
                    on_change(str(command.nudge(d_lin=LINEAR_STEP_MPS if text == "w" else -LINEAR_STEP_MPS).tolist()))
                elif text in ("a", "d"):
                    on_change(str(command.nudge(d_ang=ANGULAR_STEP_RADPS if text == "a" else -ANGULAR_STEP_RADPS).tolist()))
                elif text in ("0", "stop"):
                    on_change(str(command.set([0.0, 0.0, 0.0]).tolist()))
                elif text == "status":
                    on_change("cmd=" + str(command.get().tolist()))
                elif text.startswith("v"):
                    on_change(str(command.set(parse_twist(text[1:])).tolist()))
                else:
                    on_change(HELP)
            except ValueError as error:
                on_change(f"忽略：{error}")

    thread = threading.Thread(target=loop, name="twist-repl", daemon=True)
    thread.start()
    return thread


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m microduck_eval.live_loop",
        description="PC MuJoCo 实时闭环：本地 ONNX 或板端推理，运行中可改速度指令。",
    )
    parser.add_argument("--model-root", required=True, help="path to a microduck_rl checkout")
    parser.add_argument("--backend", choices=("local", "board"), default="local")
    parser.add_argument("--policy", default=None, help="ONNX policy for --backend local")
    parser.add_argument("--history-frames", type=int, default=1)
    parser.add_argument("--board-url", default="http://127.0.0.1:19100",
                        help="board station agent base URL for --backend board")
    parser.add_argument("--board-token", default="",
                        help="Bearer token; defaults to $RDK_SIM2REAL_BOARD_AGENT_TOKEN")
    parser.add_argument("--command", default="0,0,0", help="initial twist vx,vy,wz")
    parser.add_argument("--demo", action="store_true",
                        help="hello world：预设编排（前进2s→左转2s→站立1s）跑完即退，无需交互")
    parser.add_argument("--duration", type=float, default=0.0,
                        help="seconds to run (0 = interactive until q/^C)")
    parser.add_argument("--scene-variant", choices=("walk", "groundcontact"), default="walk")
    parser.add_argument("--actuator-model", choices=("mjcf", "bam", "bam-ctrl"), default="mjcf")
    parser.add_argument("--action-scale", type=float, default=1.0)
    parser.add_argument("--kp", type=float, default=None)
    parser.add_argument("--force-ceiling", type=float, default=None)
    parser.add_argument("--print-hz", type=float, default=5.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    token = args.board_token or os.environ.get("RDK_SIM2REAL_BOARD_AGENT_TOKEN", "")
    try:
        command = TwistCommand(parse_twist(args.command))
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.backend == "local" and not args.policy:
        print("error: --backend local 需要 --policy 指向 ONNX 文件", file=sys.stderr)
        return 2
    if args.backend == "board":
        backend = BoardPolicy(args.board_url, token=token)
        try:
            status = backend.check_reachable()
        except BoardInferError as error:
            print(f"error: {error}", file=sys.stderr)
            return 2
        print(f"board station 就绪：{json.dumps(status)[:120]}")
    else:
        try:
            backend = load_policy(args.policy, args.history_frames)
        except Exception as error:  # contract errors carry precise, actionable text
            print(f"error: {error}", file=sys.stderr)
            return 2

    try:
        spec = find_scene(args.model_root, with_ball=False, variant=args.scene_variant)
        sim = MicroDuckSim(
            spec,
            action_scale=args.action_scale,
            actuator_model=args.actuator_model,
            kp=args.kp,
            force_ceiling=args.force_ceiling,
        )
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    summary: dict[str, Any] = {}
    if args.demo:
        summary = run_demo(sim, backend, print_hz=args.print_hz)
    elif args.duration > 0 or not sys.stdin.isatty():
        summary = run_live(sim, backend, command, duration_s=args.duration, print_hz=args.print_hz)
    else:
        print(HELP)
        stopped = threading.Event()

        def on_change(message: str) -> None:
            print(f"  cmd -> {message}", flush=True)
            if message == "q":
                stopped.set()

        _spawn_repl(command, on_change)
        summary = run_live(
            sim,
            backend,
            command,
            duration_s=0.0,
            print_hz=args.print_hz,
            on_step=lambda *_: (False if stopped.is_set() else True),
        )
    print(f"闭环结束：{json.dumps(summary, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
