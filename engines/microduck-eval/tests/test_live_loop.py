"""Live-loop contract tests: synthetic scene + ONNX + stub board agent.

No upstream MJCF is needed (the repo never distributes microduck_rl assets):
the scene here is a minimal synthetic stand-in that satisfies the layout the
harness asserts (14 named servos, trunk freejoint, gyro sensor). It proves the
loop mechanics — 50 Hz pacing, twist injection into obs slots 48:51, backend
dispatch — not gait quality, which remains the evaluator's job.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("mujoco")
onnx = pytest.importorskip("onnx")

from microduck_eval.live_loop import (  # noqa: E402
    BoardInferError,
    BoardPolicy,
    TwistCommand,
    parse_twist,
    run_demo,
    run_live,
)
from microduck_eval import live_loop  # noqa: E402
from microduck_eval.policy import ACTION_SIZE, OBSERVATION_SIZE, load_policy  # noqa: E402
from microduck_eval.sim import SERVO_JOINT_ORDER, MicroDuckSim, find_scene  # noqa: E402

from test_policy_onnx_e2e import build_feedforward_graph  # noqa: E402

STUB_ACTION_ROW = np.asarray([0.01 * (i + 1) for i in range(ACTION_SIZE)], dtype=np.float32)


def _write_synthetic_scene(model_root: Path) -> Path:
    """Minimal MJCF that passes the harness layout assertions, nothing more.

    Servos form a nested hinge chain: MuJoCo caps a body at 6 DOFs, so the
    freejoint trunk cannot host the 14 hinges directly.
    """
    actuators = "\n".join(
        f'    <position name="{name}" joint="{name}" kp="0.55"/>'
        for name in SERVO_JOINT_ORDER
    )
    chain = ""
    # Nest from the last servo inward so the chain reads in SERVO_JOINT_ORDER.
    for name in reversed(SERVO_JOINT_ORDER):
        chain = (
            f'      <body name="seg_{name}" pos="0.02 0 0">\n'
            f'        <joint name="{name}" type="hinge" axis="0 0 1"/>\n'
            f'        <geom name="seg_{name}_collision" type="capsule" fromto="0 0 0 0.02 0 0" size="0.008" mass="0.02"/>\n'
            f"{chain}"
            f"      </body>\n"
        )
    xml = f"""<?xml version="1.0"?>
<mujoco model="live-loop-fixture">
  <option timestep="0.004"/>
  <worldbody>
    <geom name="floor_plane" type="plane" size="4 4 0.1"/>
    <body name="trunk_base" pos="0 0 0.12">
      <freejoint name="trunk_base_freejoint"/>
      <geom name="trunk_collision" type="box" size="0.05 0.04 0.02" mass="0.3"/>
      <site name="imu" pos="0 0 0"/>
{chain}    </body>
  </worldbody>
  <actuator>
{actuators}
  </actuator>
  <sensor>
    <gyro name="imu_ang_vel" site="imu"/>
  </sensor>
</mujoco>
"""
    scene_dir = model_root / "src" / "mjlab_microduck" / "robot" / "microduck"
    scene_dir.mkdir(parents=True)
    scene = scene_dir / "scene_walk.xml"
    scene.write_text(xml)
    return scene


class StubStationHandler(BaseHTTPRequestHandler):
    """The board-agent wire contract: status GET + batch inference POST.

    HTTP/1.1 with accurate Content-Length so keep-alive engages and the
    connection-reuse behaviour of BoardPolicy is exercised, not just its
    request/response shapes. client_ports records one entry per TCP
    connection (the ephemeral client port), so reuse is provable.
    """

    protocol_version = "HTTP/1.1"
    token = ""
    last_body: dict | None = None
    client_ports: set[int] = set()
    observation_width = OBSERVATION_SIZE

    def log_message(self, *args) -> None:  # keep pytest output clean
        pass

    def _authorized(self) -> bool:
        expected = type(self).token
        return not expected or self.headers.get("Authorization") == f"Bearer {expected}"

    def _json(self, code: int, payload: dict) -> None:
        type(self).client_ports.add(self.client_address[1])
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/v1/station/status" and self._authorized():
            self._json(200, {"ok": True, "model": "stub.onnx"})
        else:
            self._json(401, {"ok": False, "error": "unauthorized"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        type(self).last_body = json.loads(self.rfile.read(length).decode("utf-8"))
        if not self._authorized():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        rows = type(self).last_body.get("observations")
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], list):
            self._json(400, {"ok": False, "error": "observations-not-2d"})
            return
        if any(len(row) != type(self).observation_width for row in rows):
            self._json(400, {"ok": False, "error": "observation-dimension-mismatch"})
            return
        self._json(200, {"ok": True, "actions": [STUB_ACTION_ROW.tolist()] * len(rows)})


@pytest.fixture()
def stub_station():
    StubStationHandler.token = ""
    StubStationHandler.last_body = None
    StubStationHandler.client_ports = set()
    StubStationHandler.observation_width = OBSERVATION_SIZE
    server = ThreadingHTTPServer(("127.0.0.1", 0), StubStationHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


# ---- command surface --------------------------------------------------------

def test_parse_twist_validates_and_clamps():
    assert parse_twist("0.4,0.1,-0.2").tolist() == pytest.approx([0.4, 0.1, -0.2])
    assert parse_twist("5 0 0").tolist() == pytest.approx([0.5, 0.0, 0.0])
    with pytest.raises(ValueError):
        parse_twist("1,2")
    with pytest.raises(ValueError):
        parse_twist("a,b,c")
    with pytest.raises(ValueError):
        parse_twist("nan,0,0")


def test_twist_command_mutations_are_clamped():
    command = TwistCommand(parse_twist("0,0,0"))
    command.nudge(d_lin=0.1)
    assert command.get()[0] == pytest.approx(0.1, abs=1e-7)
    command.nudge(d_ang=0.5)
    assert command.get()[2] == pytest.approx(0.5, abs=1e-7)
    command.set([9.0, -9.0, 9.0])
    assert command.get().tolist() == pytest.approx([0.5, -0.5, 1.5])


# ---- board client -----------------------------------------------------------

def test_board_policy_roundtrip_hits_station_contract(stub_station):
    board = BoardPolicy(stub_station)
    assert board.check_reachable()["ok"] is True

    observation = np.arange(OBSERVATION_SIZE, dtype=np.float32) * 0.01
    action = board.act(observation)
    np.testing.assert_allclose(action, STUB_ACTION_ROW, atol=1e-7)
    sent = StubStationHandler.last_body
    assert len(sent["observations"]) == 1
    assert len(sent["observations"][0]) == OBSERVATION_SIZE


def test_board_policy_reuses_one_tcp_connection_across_calls(stub_station):
    board = BoardPolicy(stub_station)
    observation = np.zeros(OBSERVATION_SIZE, dtype=np.float32)
    for _ in range(5):
        board.act(observation)

    # Five inferences, one TCP connection: the 50 Hz budget must not be spent
    # on per-call handshakes.
    assert len(StubStationHandler.client_ports) == 1
    assert board.calls == 5


def test_board_policy_composes_and_resets_caller_owned_history(stub_station):
    StubStationHandler.observation_width = OBSERVATION_SIZE * 3
    board = BoardPolicy(stub_station, history_frames=3)
    first = np.ones(OBSERVATION_SIZE, dtype=np.float32)
    second = first * 2
    board.act(first)
    np.testing.assert_array_equal(
        StubStationHandler.last_body["observations"][0],
        np.concatenate([first * 0, first * 0, first]),
    )
    board.act(second)
    np.testing.assert_array_equal(
        StubStationHandler.last_body["observations"][0],
        np.concatenate([first * 0, first, second]),
    )
    board.reset()
    board.act(second)
    np.testing.assert_array_equal(
        StubStationHandler.last_body["observations"][0],
        np.concatenate([first * 0, first * 0, second]),
    )


@pytest.mark.parametrize("frames", [0, -1, 65, 1.5])
def test_board_policy_rejects_invalid_history_depth(frames):
    with pytest.raises(BoardInferError, match="history_frames"):
        BoardPolicy("http://127.0.0.1:9", history_frames=frames)


def test_main_forwards_history_depth_to_board_backend(tmp_path, stub_station, monkeypatch):
    _write_synthetic_scene(tmp_path / "microduck_rl")
    StubStationHandler.observation_width = OBSERVATION_SIZE * 3

    def run_once(_sim, backend, _command, **kwargs):
        backend.act(np.ones(OBSERVATION_SIZE, dtype=np.float32))
        return {"steps": 1}

    monkeypatch.setattr(live_loop, "run_live", run_once)
    assert live_loop.main([
        "--backend", "board", "--board-url", stub_station,
        "--model-root", str(tmp_path / "microduck_rl"),
        "--history-frames", "3", "--duration", "0.02",
    ]) == 0


def test_board_policy_requires_matching_token(stub_station):
    StubStationHandler.token = "secret"
    board = BoardPolicy(stub_station, token="secret")
    assert board.check_reachable()["ok"] is True

    observer = BoardPolicy(stub_station, token="wrong")
    with pytest.raises(BoardInferError):
        observer.check_reachable()
    with pytest.raises(BoardInferError):
        observer.act(np.zeros(OBSERVATION_SIZE, dtype=np.float32))


def test_board_policy_fails_closed_when_agent_missing():
    board = BoardPolicy("http://127.0.0.1:9")  # discard port: nothing listens
    with pytest.raises(BoardInferError):
        board.check_reachable()


# ---- full loop --------------------------------------------------------------

def _build_fixtures(tmp_path: Path):
    _write_synthetic_scene(tmp_path / "microduck_rl")
    policy_path = tmp_path / "policy.onnx"
    onnx.save(build_feedforward_graph(), policy_path)
    return load_policy(policy_path)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class RecordingPolicy:
    def __init__(self, clock, latencies=()):
        self.clock = clock
        self.latencies = iter(latencies)
        self.observations = []
        self.start_times = []

    def act(self, observation):
        self.start_times.append(self.clock.now)
        self.observations.append(observation.copy())
        self.clock.now += next(self.latencies, 0.0)
        return np.zeros(ACTION_SIZE, dtype=np.float32)


def test_run_live_drops_missed_deadlines_without_catchup_bursts(tmp_path, monkeypatch):
    _write_synthetic_scene(tmp_path / "microduck_rl")
    sim = MicroDuckSim(find_scene(tmp_path / "microduck_rl", with_ball=False, variant="walk"))
    clock = FakeClock()
    monkeypatch.setattr(live_loop, "time", clock)
    policy = RecordingPolicy(clock, latencies=[0.09])
    summary = run_live(
        sim, policy, TwistCommand(parse_twist("0,0,0")),
        on_step=lambda tick, *_: tick < 4,
        on_status=lambda _: None,
    )
    # An initial 90 ms inference misses three complete 20 ms deadlines. Later
    # inferences must each wait a fresh period instead of draining old ticks.
    assert policy.start_times == pytest.approx([0.0, 0.09, 0.11, 0.13])
    assert summary["slippedTicks"] == 3


def test_run_live_checks_duration_after_waiting_for_tick(tmp_path, monkeypatch):
    _write_synthetic_scene(tmp_path / "microduck_rl")
    sim = MicroDuckSim(find_scene(tmp_path / "microduck_rl", with_ball=False, variant="walk"))
    clock = FakeClock()
    monkeypatch.setattr(live_loop, "time", clock)
    policy = RecordingPolicy(clock)
    summary = run_live(
        sim, policy, TwistCommand(parse_twist("0,0,0")),
        duration_s=0.05, on_status=lambda _: None,
    )
    assert policy.start_times == pytest.approx([0.0, 0.02, 0.04])
    assert summary["wallSeconds"] == 0.05


def test_run_live_local_backend_steps_and_injects_twist(tmp_path):
    policy = _build_fixtures(tmp_path)
    sim = MicroDuckSim(find_scene(tmp_path / "microduck_rl", with_ball=False, variant="walk"))
    command = TwistCommand(parse_twist("0.2,0,0"))
    seen: list[tuple[np.ndarray, np.ndarray]] = []
    statuses: list[str] = []

    def on_step(tick: int, observation: np.ndarray, action: np.ndarray):
        seen.append((observation, action))
        if tick == 6:
            command.set(parse_twist("0.0,0.0,0.4"))
        return tick < 12

    summary = run_live(
        sim, policy, command,
        print_hz=10.0,
        on_step=on_step, on_status=statuses.append,
    )

    assert summary["steps"] == 12
    assert summary["slippedTicks"] >= 0
    assert len(seen) == summary["steps"]
    first_obs, first_action = seen[0]
    assert first_obs.shape == (OBSERVATION_SIZE,)
    assert first_action.shape == (ACTION_SIZE,)
    assert np.all(np.isfinite(first_action))
    # The 13-slot command block trails the obs: twist at 48:51, head/body pose
    # (slots 51:61) stay at rest.
    np.testing.assert_allclose(first_obs[48:51], [0.2, 0.0, 0.0], atol=1e-7)
    assert np.allclose(first_obs[51:61], 0.0, atol=1e-7)
    # The mid-run change reaches the policy on the very next tick.
    np.testing.assert_allclose(seen[6][0][48:51], [0.0, 0.0, 0.4], atol=1e-7)
    assert any("cmd=" in line for line in statuses)


def test_run_live_board_backend_applies_station_actions(tmp_path, stub_station):
    policy = _build_fixtures(tmp_path)  # noqa: F841 — proves board path needs no local graph
    sim = MicroDuckSim(find_scene(tmp_path / "microduck_rl", with_ball=False, variant="walk"))
    board = BoardPolicy(stub_station)
    board.check_reachable()

    seen: list[tuple[np.ndarray, np.ndarray]] = []

    def on_step(tick, observation, action):
        seen.append((observation, action))
        return tick < 6

    summary = run_live(
        sim, board, TwistCommand(parse_twist("0.1,0,0")),
        print_hz=50.0,
        on_step=on_step,
        on_status=lambda line: None,
    )

    assert summary["steps"] == 6
    assert board.calls == summary["steps"]
    for observation, action in seen:
        assert observation.shape == (OBSERVATION_SIZE,)
        np.testing.assert_allclose(action, STUB_ACTION_ROW, atol=1e-7)
    assert len(StubStationHandler.last_body["observations"][0]) == OBSERVATION_SIZE


# ---- demo choreography ------------------------------------------------------

def test_run_demo_walks_preset_schedule_and_stops(tmp_path, monkeypatch):
    _write_synthetic_scene(tmp_path / "microduck_rl")
    clock = FakeClock()
    monkeypatch.setattr(live_loop, "time", clock)
    policy = RecordingPolicy(clock)
    sim = MicroDuckSim(find_scene(tmp_path / "microduck_rl", with_ball=False, variant="walk"))
    # Compressed schedule: three stages of 0.1 s each so the whole hello world
    # fits in 0.3 s of wall time while still exercising every transition.
    schedule = [
        ("前进", (0.3, 0.0, 0.0), 0.1),
        ("左转", (0.0, 0.0, 0.5), 0.1),
        ("站立", (0.0, 0.0, 0.0), 0.1),
    ]
    lines: list[str] = []

    summary = run_demo(sim, policy, schedule=schedule, print_hz=50.0, on_status=lines.append)

    assert summary["steps"] == 15  # exactly 3 x 0.1 s x 50 Hz, then stop
    assert summary["finalCommand"] == [0.0, 0.0, 0.0]
    stage_lines = [line for line in lines if line.startswith("▶")]
    assert len(stage_lines) == 3
    assert "前进" in stage_lines[0] and "cmd=[0.3, 0.0, 0.0]" in stage_lines[0]
    assert "左转" in stage_lines[1] and "cmd=[0.0, 0.0, 0.5]" in stage_lines[1]
    assert "站立" in stage_lines[2]
    assert any("编排完成" in line for line in lines)
    # Every stage starts with its own command, including the very first tick.
    np.testing.assert_allclose(
        np.asarray(policy.observations)[:, 48:51],
        np.repeat(np.asarray([stage[1] for stage in schedule]), 5, axis=0),
        atol=1e-7,
    )


@pytest.mark.parametrize("schedule", [[], [("empty", (0, 0, 0), 0.0)], [("negative", (0, 0, 0), -1.0)]])
def test_run_demo_rejects_schedules_without_any_control_ticks(schedule):
    with pytest.raises(ValueError, match="at least one"):
        run_demo(None, None, schedule=schedule)
