#!/usr/bin/env python3
"""Contract tests for the task-pack goal-navigation training path.

Runs on the development machine (no ROS, no board): exercises the
GoalNavEnv physics/randomization/curriculum, the eval envelopes, and the
quality gate directly, plus one micro training round through the file
protocol. Wired into `npm run verify` via verify:goalnav (verify chain).

What these tests protect:
- observation layouts match the board runtime exactly (8D native, 42D generic);
- domain randomization is reproducible from a seed and actually changes dynamics;
- the curriculum expands only after the success threshold clears;
- eval envelopes pin dynamics (identical seed -> identical episode);
- the quality gate fails closed on missing metrics;
- a smoke training round produces eval-report.json with a verdict.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
RUNNER = os.path.join(REPO, "engines", "starter-ppo", "runner.py")

sys.path.insert(0, os.path.join(REPO, "engines", "starter-ppo"))

try:
    import numpy  # noqa: F401
    import torch  # noqa: F401
except ImportError:
    print("[goalnav] SKIP — python3 with numpy+torch not found")
    sys.exit(0)

# Spec-load the runner (hyphenated filename cannot be `import`ed normally).
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("starter_runner", RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

PACK_PATH = os.path.join(REPO, "tasks", "originbot-goal-navigation.json")


def load_pack():
    with open(PACK_PATH) as handle:
        task = json.load(handle)
    with open(os.path.join(REPO, "adapters", "rdk-originbot.json")) as handle:
        adapter = json.load(handle)
    return {
        "schemaVersion": 1,
        "kind": "goal-navigation",
        "id": task["id"],
        "adapter": adapter,
        "reward": task["reward"],
        "termination": task["termination"],
        "workspace": task["workspace"],
        "curriculum": task["curriculum"],
        "domainRandomization": task["domainRandomization"],
        "qualityGate": task["qualityGate"],
        "controlHz": 10,
        "physicsTimestepSeconds": 0.02,
        "decimation": 1,
        "seed": 7,
    }


class GoalNavEnvContract(unittest.TestCase):
    def setUp(self):
        self.pack = load_pack()
        self.env = runner.GoalNavEnv(self.pack, num_envs=4, seed=7)

    def test_observation_layouts_match_board_runtime(self):
        self.assertEqual(self.env.observation_size, 8)
        self.assertEqual(self.env.action_size, 2)
        generic = load_pack()
        generic["adapter"] = json.load(
            open(os.path.join(REPO, "adapters", "generic-differential-drive.json"))
        )
        env42 = runner.GoalNavEnv(generic, num_envs=2, seed=7)
        self.assertEqual(env42.observation_size, 42)
        obs = env42.observe_one(0)
        self.assertAlmostEqual(float(obs[5]), -1.0)  # projected gravity upright

    def test_observation_noise_and_layout(self):
        obs = self.env.observe()
        self.assertEqual(obs.shape, (4, 8))
        self.assertTrue(all(abs(float(v)) <= 3.0 for v in obs[0]))

    def test_domain_randomization_is_reproducible_and_effective(self):
        spec = self.pack["domainRandomization"]
        domain_a = runner.DomainParams.sample(runner.np.random.default_rng(11), spec)
        domain_b = runner.DomainParams.sample(runner.np.random.default_rng(11), spec)
        domain_c = runner.DomainParams.sample(runner.np.random.default_rng(12), spec)
        self.assertEqual(domain_a.as_dict(), domain_b.as_dict())
        self.assertNotEqual(domain_a.motor_gain, domain_c.motor_gain)

    def test_eval_envelope_pins_exact_dynamics(self):
        envelope = self.pack["domainRandomization"]["evalEnvelopes"]["hard"]
        domain = runner.eval_domain_params(envelope)
        self.assertAlmostEqual(domain.motor_gain, 0.8)
        self.assertAlmostEqual(domain.lag_tau, 0.25)
        self.assertAlmostEqual(domain.gyro_noise, 0.02)
        self.assertAlmostEqual(domain.odom_noise, 0.05)
        self.assertAlmostEqual(domain.angular_bias, 0.05)
        self.assertEqual(domain.latency_steps, 2)

    def test_dynamics_respects_clamps_and_lag(self):
        # Full-throttle straight command: lag means the position barely moves
        # in one control step even at gain=1, tau=0.05.
        env = runner.GoalNavEnv(self.pack, num_envs=1, seed=3)
        env.domain = [runner.DomainParams(motor_gain=1.0, lag_tau=0.05)]
        x_before = float(env.state[0, 0])
        env.step(runner.np.asarray([[1.0, 0.0]]))
        x_after = float(env.state[0, 0])
        self.assertLess(x_after - x_before, env.max_linear * env.control_dt)
        self.assertGreater(x_after - x_before, 0.0)

    def test_collision_terminates_with_negative_reward(self):
        env = runner.GoalNavEnv(self.pack, num_envs=1, seed=3)
        env.has_obstacles = True
        env.obstacles[0] = [(0.05, 0.0, 0.2)]  # directly ahead
        _, rewards, done, _ = env.step(runner.np.asarray([[1.0, 0.0]]))
        self.assertTrue(bool(done[0]))
        self.assertLess(float(rewards[0]), 0.0)

    def test_goal_reach_terminates_with_bonus(self):
        env = runner.GoalNavEnv(self.pack, num_envs=1, seed=3)
        env.state[0, 3] = 0.02  # goal effectively at the robot
        env.state[0, 4] = 0.0
        _, rewards, done, success = env.step(runner.np.asarray([[0.0, 0.0]]))
        self.assertTrue(bool(success[0]))
        self.assertGreater(float(rewards[0]), 0.0)

    def test_curriculum_expands_only_after_threshold(self):
        env = self.env
        initial = env.goal_distance[1]
        env.success_history = [True] * 50
        env._maybe_expand_curriculum()
        self.assertGreater(env.goal_distance[1], initial)
        # Below threshold: no expansion.
        env2 = runner.GoalNavEnv(self.pack, num_envs=1, seed=7)
        before = env2.goal_distance[1]
        env2.success_history = [False] * 50
        env2._maybe_expand_curriculum()
        self.assertEqual(env2.goal_distance[1], before)

    def test_training_steps_change_policy(self):
        torch.manual_seed(5)
        model = runner.ActorCritic(8, 2)
        opt = torch.optim.Adam(model.parameters(), lr=3e-4)
        obs0 = torch.from_numpy(self.env.observe())
        before = model.forward(obs0)[0].detach().clone()
        for _ in range(3):
            batch = runner.collect_rollout(
                model, self.env, 16, torch.device("cpu"),
                lambda actions: (lambda r: (r[1], r[2]))(self.env.step(actions)),
            )
            rewards = torch.stack(batch[4])
            values = torch.stack(batch[3])
            dones = torch.stack(batch[5])
            returns = runner.gae_returns(rewards, values, dones, 0.99, 0.95)
            runner.ppo_update(
                model, opt, torch.cat(batch[0]), torch.cat(batch[1]), torch.cat(batch[2]),
                (returns - values).reshape(-1), returns.reshape(-1), torch.device("cpu"),
            )
        after = model.forward(obs0)[0].detach()
        self.assertFalse(torch.allclose(before, after))


class QualityGateContract(unittest.TestCase):
    def test_pass_on_strong_metrics(self):
        report = {"envelopes": {"nominal": {"successRate": 0.9, "collisionRate": 0.05}}}
        gate = runner.evaluate_quality_gate(report, {"minSuccessRate": 0.7, "maxCollisionRate": 0.15})
        self.assertTrue(gate["passed"])
        self.assertEqual(gate["errors"], [])

    def test_fail_closed_on_weak_or_missing_metrics(self):
        weak = runner.evaluate_quality_gate(
            {"envelopes": {"nominal": {"successRate": 0.4, "collisionRate": 0.05}}},
            {"minSuccessRate": 0.7, "maxCollisionRate": 0.15},
        )
        self.assertFalse(weak["passed"])
        missing = runner.evaluate_quality_gate({"envelopes": {}}, {"minSuccessRate": 0.7})
        self.assertFalse(missing["passed"])
        self.assertTrue(any("missing" in error for error in missing["errors"]))


class FileProtocolSmoke(unittest.TestCase):
    def test_micro_training_round_produces_eval_report(self):
        pack = load_pack()
        request = {
            "schemaVersion": 1,
            "contractId": pack["id"] + "-policy-v1",
            "contract": {
                "id": pack["id"] + "-policy-v1",
                "robotId": pack["adapter"]["id"],
                "observationSize": 8,
                "actionSize": 2,
                "controlHz": 10,
                "physicsTimestepSeconds": 0.02,
                "decimation": 1,
            },
            "model": {"modelId": "goalnav-contract", "version": "0.1.0-test"},
            "training": {"profile": "smoke", "numEnvs": 4, "maxIterations": 2, "video": False},
            "task": pack,
        }
        with tempfile.TemporaryDirectory(prefix="goalnav-contract-") as workdir:
            request_path = os.path.join(workdir, "request.json")
            result_path = os.path.join(workdir, "result.json")
            with open(request_path, "w") as handle:
                json.dump(request, handle)
            env_vars = dict(os.environ)
            env_vars.update({
                "RDK_SIM2REAL_REQUEST_FILE": request_path,
                "RDK_SIM2REAL_RESULT_FILE": result_path,
            })
            completed = subprocess.run(
                [sys.executable, RUNNER], env=env_vars, capture_output=True, text=True, timeout=300,
                cwd=workdir,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr[-600:])
            with open(result_path) as handle:
                result = json.load(handle)
            self.assertEqual(result["metrics"]["taskKind"], "goal-navigation")
            self.assertIn("qualityGatePassed", result["metrics"])
            self.assertIn("hardSuccessRate", result["metrics"])
            with open(os.path.join(workdir, "eval-report.json")) as handle:
                report = json.load(handle)
            self.assertEqual(report["taskId"], "originbot-goal-navigation")
            self.assertIn("qualityGate", report)
            self.assertIsInstance(report["trained"].get("envelopes"), dict)
            for envelope_name in ("nominal", "hard"):
                self.assertIn(envelope_name, report["trained"]["envelopes"])
            # The gate verdict must be an honest boolean, never absent.
            self.assertIsInstance(report["qualityGate"]["passed"], bool)


if __name__ == "__main__":
    unittest.main(verbosity=2)
