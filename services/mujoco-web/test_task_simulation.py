"""Real MuJoCo regressions for the browser task-session contract.

Run: python -m unittest discover -s services/mujoco-web -p 'test_task_simulation.py'
No EGL, renderer, downloaded model, or GPU is involved.
"""
from __future__ import annotations

import copy
import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

import task_simulation as tasks
import app as playground
from app import app


class TaskSimulationTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {})
        self.environment.start()
        for key in ("RDK_SIM2REAL_SIMULATION_SECRET", "RDK_SIM2REAL_DEPLOYMENT", "RDK_STUDIO_DEPLOYMENT_PROFILE",
                    "RDK_SIM2REAL_SSO_REQUIRED", "SSO_REQUIRED", "RDK_SIM2REAL_AUTH_MODE"):
            os.environ.pop(key, None)
        tasks.close_task_sessions()
        with playground._sessions_lock:
            playground._close_all_sessions()
        self.client = TestClient(app)

    def tearDown(self):
        tasks.close_task_sessions()
        with playground._sessions_lock:
            playground._close_all_sessions()
        self.client.close()
        self.environment.stop()

    def create(self, task_id="balance-stilts", seed=42):
        response = self.client.post("/api/task-sessions", json={"taskId": task_id, "seed": seed})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def action(self, state, value=0.3):
        contract = state["contract"]
        if contract["engine"] == "microduck-football":
            return [[value] * contract["actionDim"] for _ in range(contract["numAgents"])]
        return [value] * 14

    def step(self, state, steps=1):
        response = self.client.post(f"/api/task-sessions/{state['sessionId']}/step",
                                    json={"action": self.action(state), "steps": steps})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def delete(self, state):
        self.assertEqual(self.client.delete(f"/api/task-sessions/{state['sessionId']}").status_code, 200)

    def test_catalog_and_every_actual_engine_scene(self):
        response = self.client.get("/api/task-scenes")
        self.assertEqual(response.status_code, 200)
        scenes = response.json()["scenes"]
        self.assertEqual({scene["taskId"] for scene in scenes}, set(tasks.TASKS))
        counts = {}
        for contract in scenes:
            with self.subTest(task=contract["taskId"]):
                state = self.create(contract["taskId"])
                self.assertEqual(state["taskId"], contract["taskId"])
                self.assertEqual(state["time"], 0)
                self.assertTrue(state["contract"]["available"])
                if contract["engine"] == "microduck-recurrent":
                    self.assertEqual(contract["contractId"], "microduck-policy-v1")
                    self.assertEqual((contract["observationDim"], contract["actionDim"]), (61, 14))
                else:
                    self.assertEqual(contract["contractId"], f"{contract['taskId']}-engine-v1")
                    self.assertNotEqual(contract["contractId"], "microduck-policy-v1")
                self.assertEqual(state["contract"]["contractId"], contract["contractId"])
                self.assertEqual(state["scene"]["representation"], "engine-proxy")
                geoms = state["scene"]["geoms"]
                counts[state["taskId"]] = len(geoms)
                for geom in geoms:
                    self.assertEqual(len(geom["xpos"]), 3)
                    self.assertEqual(len(geom["xmat"]), 9)
                    self.assertEqual(len(geom["rgba"]), 4)
                    self.assertNotEqual(geom["type"], "unsupported")
                stepped = self.step(state)
                self.assertAlmostEqual(stepped["time"], contract["controlPeriodSeconds"])
                self.assertEqual(stepped["stepCount"], 1)
                self.assertFalse(np.array_equal(state["qpos"], stepped["qpos"]))
                observation = np.asarray(stepped["observation"])
                expected = (contract["numAgents"], contract["observationDim"]) if contract["engine"] == "microduck-football" and contract["numAgents"] > 1 else (contract["observationDim"],)
                self.assertEqual(observation.shape, expected)
                self.assertTrue(np.isfinite(observation).all())
                # The returned geometry comes from the compiled training model.
                session = tasks._sessions[state["sessionId"]]
                for geom in stepped["scene"]["geoms"]:
                    np.testing.assert_array_equal(geom["size"], session.env.model.geom_size[geom["id"]])
                    np.testing.assert_array_equal(geom["xpos"], session.env.data.geom_xpos[geom["id"]])
                self.delete(state)
        self.assertNotEqual(counts["balance-basketball"], counts["balance-stilts"])
        self.assertGreater(counts["balance-ladder"], counts["balance-stilts"])
        self.assertEqual(counts["football-2v2"] - counts["football-single-goal-kick"], 3)
        self.assertEqual(counts["football-3v3"] - counts["football-2v2"], 2)

    def test_step_delegates_to_actual_environment_without_action_remapping(self):
        state = self.create("balance-basketball")
        session = tasks._sessions[state["sessionId"]]
        with patch.object(session.env, "step", wraps=session.env.step) as actual_step:
            stepped = self.step(state, steps=3)
        self.assertEqual(actual_step.call_count, 3)
        for call in actual_step.call_args_list:
            np.testing.assert_array_equal(call.args[0], [0.3] * 14)
        np.testing.assert_allclose(stepped["replay"]["posture"], [0.3 * (1 - 0.65**3)] * 14)

    def test_display_robots_follow_actual_proxy_bodies_and_replay_for_every_task(self):
        for task_id in tasks.TASKS:
            with self.subTest(task=task_id):
                initial = self.create(task_id)
                state = self.step(initial, steps=2)
                session = tasks._sessions[state["sessionId"]]
                env = session.env
                football = task_id.startswith("football-")
                robots = state["scene"]["robots"]
                expected_names = [f"duck{index}" for index in range(env.config.num_ducks)] if football else ["duck"]
                self.assertEqual([robot["id"] for robot in robots], expected_names)
                self.assertEqual(state["scene"]["representation"], "engine-proxy")
                self.assertEqual(state["scene"]["robotRepresentation"], "display-adaptation")
                self.assertTrue(any(
                    previous["xpos"] != current["xpos"] or previous["xmat"] != current["xmat"]
                    for previous, current in zip(initial["scene"]["robots"], robots)
                ))
                all_proxy_ids = []
                for index, robot in enumerate(robots):
                    body_id = tasks.mujoco.mj_name2id(env.model, tasks.mujoco.mjtObj.mjOBJ_BODY, robot["id"])
                    self.assertEqual(robot["bodyId"], body_id)
                    np.testing.assert_array_equal(robot["xpos"], env.data.xpos[body_id])
                    np.testing.assert_array_equal(robot["xmat"], env.data.xmat[body_id])
                    self.assertEqual(robot["visualYaw"], np.pi / 2 if task_id == "balance-stilts" else 0)
                    if task_id == "balance-stilts":
                        # The display rotates inside this actual body frame.
                        # Verify the rod offsets remain local +/-X, without
                        # pre-rotating either the physical body or its geoms.
                        local_rotation = env.data.xmat[body_id].reshape(3, 3).T
                        for rod, x in (("stilt_left", -.04), ("stilt_right", .04)):
                            geom_id = tasks.mujoco.mj_name2id(env.model, tasks.mujoco.mjtObj.mjOBJ_GEOM, rod)
                            local = local_rotation @ (env.data.geom_xpos[geom_id] - env.data.xpos[body_id])
                            np.testing.assert_allclose(local[:2], [x, 0], atol=1e-12)
                    proxy_name = robot["id"] if football else "duck_body"
                    proxy_id = tasks.mujoco.mj_name2id(env.model, tasks.mujoco.mjtObj.mjOBJ_GEOM, proxy_name)
                    self.assertEqual(robot["proxyGeomIds"], [proxy_id])
                    all_proxy_ids.extend(robot["proxyGeomIds"])
                    # Keep the original collision proxy in the scene. Only the
                    # frontend substitutes a display mesh at this body origin.
                    proxy_geom = state["scene"]["geoms"][proxy_id]
                    self.assertEqual(proxy_geom["type"], "sphere")
                    np.testing.assert_array_equal(proxy_geom["size"], env.model.geom_size[proxy_id])
                    if football:
                        self.assertIsNone(robot["posture"])
                        self.assertEqual(robot["team"], "blue" if index < env.config.blue_count else "red")
                        self.assertEqual(robot["footOffset"], [0, 0, -0.18])
                    else:
                        np.testing.assert_array_equal(robot["posture"], env.posture)
                        self.assertEqual(len(robot["posture"]), 14)
                        self.assertIsNone(robot["team"])
                        self.assertEqual(robot["footOffset"], [0, 0, 0])
                        self.assertAlmostEqual(np.linalg.norm(np.asarray(proxy_geom["xpos"]) - robot["xpos"]), .1)
                if football:
                    ball_geom = next(geom for geom in state["scene"]["geoms"] if geom["name"] == "ball")
                    self.assertNotIn(ball_geom["id"], all_proxy_ids)
                    self.assertEqual(ball_geom["type"], "sphere")
                    np.testing.assert_array_equal(ball_geom["size"], env.model.geom_size[ball_geom["id"]])
                self.step(state, steps=2)
                response = self.client.post(f"/api/task-sessions/{state['sessionId']}/replay", json=state["replay"])
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["scene"]["robots"], robots)
                self.delete(state)

    def test_display_robot_descriptors_leave_integration_state_and_model_physics_unchanged(self):
        for task_id in tasks.TASKS:
            with self.subTest(task=task_id):
                state = self.step(self.create(task_id))
                session = tasks._sessions[state["sessionId"]]
                env = session.env
                snapshot = copy.deepcopy(tasks._snapshot(session))
                model_fields = ["body_mass", "body_inertia", "geom_type", "geom_size", "geom_friction",
                                "geom_solref", "geom_solimp", "geom_rgba", "jnt_range", "dof_damping"]
                physics = {name: getattr(env.model, name).copy() for name in model_fields}
                reward, done = copy.deepcopy(session.reward), session.done
                scene = tasks._scene(session)
                self.assertEqual(tasks._snapshot(session), snapshot)
                self.assertEqual(scene["geoms"], state["scene"]["geoms"])
                for name, values in physics.items():
                    np.testing.assert_array_equal(getattr(env.model, name), values)
                np.testing.assert_array_equal(session.reward, reward)
                self.assertEqual(session.done, done)
                self.delete(state)

    def test_display_metrics_omit_rolled_away_for_tasks_without_a_ball(self):
        for task_id in ("balance-basketball", "balance-stilts", "balance-ball", "balance-ladder", "swing-pump"):
            with self.subTest(task=task_id):
                state = self.step(self.create(task_id))
                session = tasks._sessions[state["sessionId"]]
                _, original_metrics = session.env._extra_termination()
                if task_id in ("balance-basketball", "balance-ball"):
                    self.assertEqual(state["metrics"]["rolledAway"], original_metrics["rolledAway"])
                else:
                    self.assertNotIn("rolledAway", state["metrics"])
                if task_id == "balance-stilts":
                    # Hide the irrelevant display label without changing the
                    # training environment's termination/reward definition.
                    self.assertEqual(original_metrics, {"rolledAway": False})
                self.delete(state)

    def test_display_bounds_follow_geometry_without_inflating_long_goal_or_wall_height(self):
        rotation = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], dtype=float)
        np.testing.assert_allclose(tasks._display_half_extent("box", np.array([4, .2, .1]), rotation), [.1, .2, 4])
        np.testing.assert_allclose(tasks._display_half_extent("sphere", np.array([.3, 0, 0]), rotation), [.3, .3, .3])
        np.testing.assert_allclose(tasks._display_half_extent("capsule", np.array([.2, 2, 0]), rotation), [2.2, .2, .2])
        np.testing.assert_allclose(tasks._display_half_extent("cylinder", np.array([.2, 2, 0]), rotation), [2, .2, .2])
        state = self.create("football-single-goal-kick")
        bounds = state["scene"]["bounds"]
        self.assertLess(bounds["high"][2], 1.0)
        self.assertGreater(bounds["high"][0] - bounds["low"][0], 6.0)
        self.assertGreater(bounds["high"][1] - bounds["low"][1], 4.0)
        session = tasks._sessions[state["sessionId"]]
        before_qpos, before_sizes = session.env.data.qpos.copy(), session.env.model.geom_size.copy()
        tasks._scene(session)
        np.testing.assert_array_equal(session.env.data.qpos, before_qpos)
        np.testing.assert_array_equal(session.env.model.geom_size, before_sizes)

    def test_reset_reproduces_seed_and_clears_action_reward_and_time(self):
        state = self.create("balance-ball", seed=123)
        stepped = self.step(state, steps=4)
        self.assertGreater(stepped["time"], 0)
        reset = self.client.post(f"/api/task-sessions/{state['sessionId']}/reset", json={}).json()
        self.assertEqual(reset["qpos"], state["qpos"])
        self.assertEqual(reset["observation"], state["observation"])
        self.assertEqual(reset["action"], [0.0] * 14)
        self.assertEqual(reset["reward"], 0)
        self.assertEqual(reset["stepCount"], 0)
        self.assertFalse(reset["done"])
        changed = self.client.post(f"/api/task-sessions/{state['sessionId']}/reset", json={"seed": 321}).json()
        self.assertNotEqual(changed["qpos"], state["qpos"])

    def test_replay_restores_hidden_state_and_exact_future_physics(self):
        for task_id in tasks.TASKS:
            with self.subTest(task=task_id):
                state = self.step(self.create(task_id), steps=2)
                recorded = copy.deepcopy(state)
                future = self.step(state, steps=2)
                replay = self.client.post(f"/api/task-sessions/{state['sessionId']}/replay", json=recorded["replay"])
                self.assertEqual(replay.status_code, 200, replay.text)
                restored = replay.json()
                self.assertEqual(restored["qpos"], recorded["qpos"])
                self.assertEqual(restored["qvel"], recorded["qvel"])
                self.assertEqual(restored["action"], recorded["action"])
                self.assertEqual(restored["stepCount"], recorded["stepCount"])
                self.assertEqual(restored["observation"], recorded["observation"])
                self.assertEqual(restored["metrics"], recorded["metrics"])
                resumed = self.step(restored, steps=2)
                np.testing.assert_array_equal(resumed["qpos"], future["qpos"])
                np.testing.assert_array_equal(resumed["qvel"], future["qvel"])
                self.assertEqual(resumed["reward"], future["reward"])
                self.delete(state)

    def test_replay_rejects_bad_dimensions_quaternions_and_hidden_state_atomically(self):
        state = self.step(self.create("balance-stilts"))
        endpoint = f"/api/task-sessions/{state['sessionId']}/replay"
        for key in ("qpos", "qvel", "posture", "prevPosture", "lastAction", "command", "integrationState"):
            with self.subTest(field=key):
                broken = copy.deepcopy(state["replay"])
                broken[key] = broken[key][:-1]
                self.assertEqual(self.client.post(endpoint, json=broken).status_code, 422)
        broken = copy.deepcopy(state["replay"])
        broken["taskId"] = "balance-basketball"
        self.assertEqual(self.client.post(endpoint, json=broken).status_code, 422)
        broken = copy.deepcopy(state["replay"])
        broken["qpos"] = [0.0] * len(broken["qpos"])
        broken["integrationState"][1:1 + len(broken["qpos"])] = broken["qpos"]
        self.assertEqual(self.client.post(endpoint, json=broken).status_code, 422)
        broken = copy.deepcopy(state["replay"])
        broken["privateState"] = {"anything": 1}
        self.assertEqual(self.client.post(endpoint, json=broken).status_code, 422)
        after = self.client.get(f"/api/task-sessions/{state['sessionId']}/state").json()
        self.assertEqual(after["qpos"], state["qpos"])
        self.assertEqual(after["replay"]["posture"], state["replay"]["posture"])

    def test_invalid_actions_and_missing_sessions_are_clear_errors(self):
        state = self.create()
        endpoint = f"/api/task-sessions/{state['sessionId']}/step"
        for action in ([0] * 13, [0] * 15, [2] * 14, [[0] * 14]):
            self.assertEqual(self.client.post(endpoint, json={"action": action}).status_code, 422)
        for steps in (0, 11):
            self.assertEqual(self.client.post(endpoint, json={"action": [0] * 14, "steps": steps}).status_code, 422)
        nonfinite = self.client.post(endpoint, content=json.dumps({"action": [float("nan")] * 14}), headers={"Content-Type": "application/json"})
        self.assertEqual(nonfinite.status_code, 422)
        self.assertEqual(self.client.get("/api/task-sessions/missing/state").status_code, 404)
        self.assertEqual(self.client.post("/api/task-sessions", json={"taskId": "unknown"}).status_code, 404)
        team = self.create("football-2v2")
        self.assertEqual(self.client.post(f"/api/task-sessions/{team['sessionId']}/step", json={"action": [0] * 14}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/task-sessions/{team['sessionId']}/step", json={"action": [[0] * 4]}).status_code, 422)

    def test_terminated_episode_requires_reset(self):
        state = self.create()
        tasks._sessions[state["sessionId"]].env.step_count = 599
        last = self.step(state, steps=10)
        self.assertTrue(last["done"])
        self.assertEqual(last["stepCount"], 600)
        endpoint = f"/api/task-sessions/{state['sessionId']}/step"
        self.assertEqual(self.client.post(endpoint, json={"action": [0] * 14}).status_code, 409)

    def test_cleanup_capacity_and_idempotent_delete(self):
        state = self.create()
        session_id = state["sessionId"]
        with patch.object(tasks, "MAX_TASK_SESSIONS", 1):
            self.assertEqual(self.client.post("/api/task-sessions", json={"taskId": "balance-ball"}).status_code, 429)
        tasks._sessions[session_id].last_seen -= tasks.TASK_SESSION_TTL_SECONDS + 1
        tasks.cleanup_task_sessions()
        self.assertNotIn(session_id, tasks._sessions)
        self.assertEqual(self.client.get(f"/api/task-sessions/{session_id}/state").status_code, 404)
        for _ in range(2):
            self.assertEqual(self.client.delete(f"/api/task-sessions/{session_id}").status_code, 200)

    def test_per_session_steps_are_serialized(self):
        state = self.create()
        session = tasks._sessions[state["sessionId"]]
        active = 0
        maximum = 0
        counter_lock = threading.Lock()
        engine_step = session.env.step

        def guarded(action):
            nonlocal active, maximum
            with counter_lock:
                active += 1
                maximum = max(maximum, active)
            try:
                return engine_step(action)
            finally:
                with counter_lock:
                    active -= 1

        def issue():
            return tasks.step_task_session(state["sessionId"], tasks.StepTaskRequest(action=[0] * 14))

        with patch.object(session.env, "step", side_effect=guarded), ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: issue(), range(4)))
        self.assertEqual(maximum, 1)
        self.assertEqual(sorted(result["stepCount"] for result in results), [1, 2, 3, 4])

    def test_missing_engine_modules_does_not_break_catalog_or_existing_model_api(self):
        with patch.object(tasks, "ROOT", tasks.ROOT / "not-installed"):
            scenes = self.client.get("/api/task-scenes").json()["scenes"]
            self.assertTrue(all(not scene["available"] for scene in scenes))
            response = self.client.post("/api/task-sessions", json={"taskId": "balance-ball"})
            self.assertEqual(response.status_code, 503)
            self.assertEqual(self.client.get("/api/models").status_code, 200)

    def test_originbot_replay_restores_pose_controls_sensors_and_exact_future_physics(self):
        created = self.client.post("/api/sessions", json={"model": "originbot"}).json()
        session_id = created["id"]
        endpoint = f"/api/sessions/{session_id}"
        recorded = self.client.post(endpoint + "/cmd_vel", json={"linear": 0.2, "angular": 0.1}).json()
        self.assertEqual(recorded["replay"]["taskId"], "originbot")
        self.assertEqual(len(recorded["replay"]["command"]), 13)
        future = self.client.post(endpoint + "/cmd_vel", json={"linear": 0.3, "angular": -0.2}).json()
        response = self.client.post(endpoint + "/replay", json=recorded["replay"])
        self.assertEqual(response.status_code, 200, response.text)
        restored = response.json()
        for key in ("time", "qpos", "qvel", "controls", "sensors", "sensorRaw", "replay"):
            self.assertEqual(restored[key], recorded[key], key)
        self.assertEqual(restored["cmd_vel"]["source"], "replay")
        self.assertEqual(restored["cmd_vel"]["requestedLinear"], recorded["cmd_vel"]["requestedLinear"])
        resumed = self.client.post(endpoint + "/cmd_vel", json={"linear": 0.3, "angular": -0.2}).json()
        np.testing.assert_array_equal(resumed["qpos"], future["qpos"])
        np.testing.assert_array_equal(resumed["qvel"], future["qvel"])
        self.assertEqual(resumed["sensors"], future["sensors"])

    def test_originbot_replay_rejects_invalid_snapshots_without_mutation(self):
        created = self.client.post("/api/sessions", json={"model": "originbot"}).json()
        endpoint = f"/api/sessions/{created['id']}"
        recorded = self.client.post(endpoint + "/cmd_vel", json={"linear": 0.2, "angular": 0.1}).json()
        for key in ("qpos", "qvel", "integrationState", "action", "command"):
            with self.subTest(field=key):
                bad = copy.deepcopy(recorded["replay"])
                bad[key] = bad[key][:-1]
                self.assertEqual(self.client.post(endpoint + "/replay", json=bad).status_code, 422)
        bad = copy.deepcopy(recorded["replay"])
        bad["taskId"] = "balance-stilts"
        self.assertEqual(self.client.post(endpoint + "/replay", json=bad).status_code, 422)
        bad = copy.deepcopy(recorded["replay"])
        bad["command"][0] = float("nan")
        response = self.client.post(endpoint + "/replay", content=json.dumps(bad), headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 422)
        bad = copy.deepcopy(recorded["replay"])
        bad["privateState"] = 1
        self.assertEqual(self.client.post(endpoint + "/replay", json=bad).status_code, 422)
        after = self.client.get(endpoint + "/state").json()
        self.assertEqual(after["replay"], recorded["replay"])

    def test_originbot_replay_rejects_another_model_session(self):
        originbot = self.client.post("/api/sessions", json={"model": "originbot"}).json()
        cartpole = self.client.post("/api/sessions", json={"model": "cartpole"}).json()
        response = self.client.post(f"/api/sessions/{cartpole['id']}/replay", json=originbot["replay"])
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
