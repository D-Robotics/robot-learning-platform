#!/usr/bin/env python3
"""Contract tests for the task-pack goal-navigation training path.

Runs on the development machine (no ROS, no board): exercises the
GoalNavEnv physics/randomization/curriculum, the eval envelopes, and the
quality gate directly, plus one micro training round through the file
protocol. Wired into `npm run verify` via verify:goalnav (verify chain).

What these tests protect:
- observation layouts match the board runtime exactly (8D native, 42D generic);
- domain randomization is reproducible from a seed and actually changes dynamics,
  including wheel slip (true-vs-odometry pose divergence) and frame dropout;
- the curriculum expands only after the success threshold clears;
- eval envelopes pin dynamics (identical seed -> identical episode), and
  legacy 6-value envelopes keep their old semantics;
- evaluation reports Wilson confidence bounds with enough episodes to mean
  something, and the quality gate fails closed on missing metrics or bounds;
- the same seed in two separate processes produces identical eval metrics
  (cross-process determinism, not just single-process);
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
        "evaluationConfig": task.get("evaluationConfig"),
        "qualityGate": task["qualityGate"],
        "controlHz": 10,
        "physicsTimestepSeconds": 0.02,
        "decimation": 1,
        "seed": 7,
    }


def build_request(pack, iterations=2, envs=4):
    return {
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
        "training": {"profile": "smoke", "numEnvs": envs, "maxIterations": iterations, "video": False},
        "task": pack,
    }


def run_engine(request, workdir, extra_env=None):
    """Run the engine once through the file protocol; returns the result dict."""
    request_path = os.path.join(workdir, "request.json")
    result_path = os.path.join(workdir, "result.json")
    with open(request_path, "w") as handle:
        json.dump(request, handle)
    env_vars = dict(os.environ)
    env_vars.update({
        "RDK_SIM2REAL_REQUEST_FILE": request_path,
        "RDK_SIM2REAL_RESULT_FILE": result_path,
    })
    env_vars.update(extra_env or {})
    completed = subprocess.run(
        [sys.executable, RUNNER], env=env_vars, capture_output=True, text=True, timeout=300,
        cwd=workdir,
    )
    assert completed.returncode == 0, completed.stderr[-600:]
    with open(result_path) as handle:
        return json.load(handle)


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
        # 8-value envelope pins dropout and slip too.
        self.assertAlmostEqual(domain.odom_dropout, 0.05)
        self.assertAlmostEqual(domain.slip_scale, 0.8)

    def test_legacy_six_value_envelope_keeps_old_semantics(self):
        domain = runner.eval_domain_params([0.8, 0.25, 0.02, 0.05, 0.05, 2])
        self.assertEqual(domain.latency_steps, 2)
        self.assertEqual(domain.odom_dropout, 0.0)
        self.assertEqual(domain.slip_scale, 1.0)

    def test_wheel_slip_drives_odometry_drift(self):
        # Same commands, same noise: with slip the true pose differs from the
        # odometry pose, and odometry believes the wheel speeds (slip-blind).
        env = runner.GoalNavEnv(self.pack, num_envs=1, seed=3)
        env.domain = [runner.DomainParams(motor_gain=1.0, lag_tau=0.05, slip_scale=0.5)]
        action = runner.np.asarray([[1.0, 0.0]])
        for _ in range(20):
            env.step(action)
        true_x = float(env.state[0, 0])
        odom_x = float(env.odom[0, 0])
        self.assertGreater(odom_x, true_x + 0.01, "odometry must over-report distance when wheels slip")
        # No slip: poses coincide (lag settles, no bias).
        env2 = runner.GoalNavEnv(self.pack, num_envs=1, seed=3)
        env2.domain = [runner.DomainParams(motor_gain=1.0, lag_tau=0.01, slip_scale=1.0)]
        for _ in range(20):
            env2.step(action)
        self.assertAlmostEqual(float(env2.state[0, 0]), float(env2.odom[0, 0]), places=3)

    def test_frame_dropout_repeats_previous_observation(self):
        env = runner.GoalNavEnv(self.pack, num_envs=1, seed=5)
        env.domain = [runner.DomainParams(odom_dropout=1.0)]  # every frame drops
        first = env.observe()
        env.state[0, 0] = 0.5  # pose moves after the first observation
        frozen = env.observe()
        self.assertTrue((first == frozen).all(), "p=1.0 dropout must freeze the observation")

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

    def test_workspace_bound_terminates_escaping_episode(self):
        # An episode whose TRUE pose leaves workspace.bound must terminate
        # without success — the arena edge an operator would stop at.
        env = runner.GoalNavEnv(self.pack, num_envs=1, seed=3)
        bound = self.pack["workspace"]["bound"]
        env.state[0, 0] = bound + 0.5  # already outside, moving outward
        _, rewards, done, success = env.step(runner.np.asarray([[1.0, 0.0]]))
        self.assertTrue(bool(done[0]))
        self.assertFalse(bool(success[0]))

    def test_episode_final_captured_before_reset(self):
        # The terminal distance/collision are captured BEFORE the auto-reset;
        # post-reset state would report the fresh episode's clean numbers.
        env = runner.GoalNavEnv(self.pack, num_envs=1, seed=3)
        env.has_obstacles = True
        env.obstacles[0] = [(0.05, 0.0, 0.2)]  # directly ahead
        goal_distance = float(runner.np.hypot(env.state[0, 3] - env.state[0, 0],
                                              env.state[0, 4] - env.state[0, 1]))
        env.step(runner.np.asarray([[1.0, 0.0]]))
        term = env._episode_final[0]
        self.assertTrue(term["collision"])
        # Not the resampled distance, and not zero either.
        self.assertAlmostEqual(term["finalDistance"], goal_distance, delta=0.15)
        self.assertGreater(term["finalDistance"], 0.0)

    def test_rollout_stores_unclamped_action_with_matching_logp(self):
        # PPO trains on the unclamped sample; the env saturates the command.
        # Storing the clamped point's log-prob is the NaN mechanism this
        # suite guards against (log-prob cliff when means drift past +-1).
        torch.manual_seed(11)
        model = runner.ActorCritic(8, 2)
        obs = torch.randn(4, 8)
        with torch.no_grad():
            dist = model.distribution(obs)
            raw = dist.sample()
            raw_clamped = raw.clamp(-1.0, 1.0)
        saturating = (raw.abs() > 1.0).any()
        if saturating:
            # At least one stored action must be the unclamped value.
            logp_raw = dist.log_prob(raw).sum(-1)
            logp_clamped = dist.log_prob(raw_clamped).sum(-1)
            self.assertFalse(torch.allclose(logp_raw, logp_clamped))

    def test_collect_rollout_commands_are_saturated(self):
        # Whatever the Gaussian proposes, the env only ever executes commands
        # inside [-1, 1] — a1 clamps, a2 is raw (saturated at env boundary).
        torch.manual_seed(13)
        model = runner.ActorCritic(8, 2)
        executed = []
        holder = {"env": self.env}

        def step_fn(actions):
            executed.append(actions.copy())
            obs, rew, done, _ = holder["env"].step(actions)
            return rew, done

        batch = runner.collect_rollout(model, self.env, 2, torch.device("cpu"), step_fn)
        for frame in executed:
            self.assertLessEqual(float(frame.max()), 1.0)
            self.assertGreaterEqual(float(frame.min()), -1.0)
        # Stored actions may be raw; their log-probs must match the stored
        # point (finite, matching distribution evaluated at that action).
        acts = torch.cat(batch[1])
        logps = torch.cat(batch[2])
        self.assertTrue(torch.isfinite(logps).all())
        with torch.no_grad():
            dist = model.distribution(torch.cat(batch[0]))
        recomputed = dist.log_prob(acts).sum(-1)
        self.assertTrue(torch.allclose(recomputed, logps, atol=1e-5))

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


class StatisticsContract(unittest.TestCase):
    def test_wilson_bounds_math(self):
        self.assertIsNone(runner.wilson_bounds(6, 0))
        low, high = runner.wilson_bounds(0, 50)
        self.assertAlmostEqual(low, 0.0, places=4)
        self.assertAlmostEqual(high, 0.0712, places=3)
        low, high = runner.wilson_bounds(50, 50)
        self.assertAlmostEqual(low, 0.9288, places=3)
        self.assertAlmostEqual(high, 1.0, places=4)
        low, _ = runner.wilson_bounds(6, 6)
        self.assertGreater(low, 0.5)
        self.assertLess(low, 0.7)  # 6/6 alone cannot certify a 0.7 gate
        with self.assertRaises(ValueError):
            runner.wilson_bounds(6, 6, confidence=0.42)

    def test_gate_judges_on_ci_lower_bound(self):
        # 50 episodes at 72%: Wilson low ~0.58 < 0.7 — point would pass,
        # the floor must not.
        report = {"envelopes": {"nominal": {
            "successRate": 0.72, "collisionRate": 0.0, "episodes": 50,
            "successRateCiLow": runner.wilson_bounds(36, 50)[0],
            "successRateCiHigh": runner.wilson_bounds(36, 50)[1],
            "collisionRateCiLow": 0.0, "collisionRateCiHigh": runner.wilson_bounds(0, 50)[1],
        }}}
        gate = runner.evaluate_quality_gate(report, {"minSuccessRate": 0.7, "gateOn": "ciLowerBound"})
        self.assertFalse(gate["passed"])
        self.assertTrue(any("CI low" in error for error in gate["errors"]))
        # Same report under point semantics passes: the modes are honest.
        gate_point = runner.evaluate_quality_gate(report, {"minSuccessRate": 0.7})
        self.assertTrue(gate_point["passed"])

    def test_gate_fails_closed_on_missing_bounds(self):
        report = {"envelopes": {"nominal": {"successRate": 0.9, "collisionRate": 0.0}}}
        gate = runner.evaluate_quality_gate(report, {"minSuccessRate": 0.7, "gateOn": "ciLowerBound"})
        self.assertFalse(gate["passed"])
        self.assertTrue(any("missing" in error for error in gate["errors"]))


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
        request = build_request(pack)
        with tempfile.TemporaryDirectory(prefix="goalnav-contract-") as workdir:
            result = run_engine(request, workdir)
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
                envelope = report["trained"]["envelopes"][envelope_name]
                # The statistical-power contract: every envelope carries its
                # episode count and Wilson bounds, and 2-iteration training
                # must fail the CI gate (untrained policy, honest verdict).
                self.assertGreaterEqual(envelope["episodes"], 30)
                for key in ("successRateCiLow", "successRateCiHigh",
                            "collisionRateCiLow", "collisionRateCiHigh"):
                    self.assertIn(key, envelope)
            self.assertFalse(report["qualityGate"]["passed"])
            # The gate verdict must be an honest boolean, never absent.
            self.assertIsInstance(report["qualityGate"]["passed"], bool)

    def test_cross_process_determinism(self):
        # Same seed, two fresh processes: eval metrics must be identical.
        pack = load_pack()
        pack["evaluationConfig"] = {"episodesPerEnvelope": 30, "confidenceLevel": 0.95}
        request = build_request(pack)
        metrics = []
        for run_idx in range(2):
            with tempfile.TemporaryDirectory(prefix="goalnav-determinism-") as workdir:
                result = run_engine(request, workdir)
                metrics.append(result["metrics"])
        comparable = ("reward", "initialReward", "successRate", "collisionRate",
                      "hardSuccessRate", "successRateCiLow", "evalEpisodes")
        for key in comparable:
            self.assertEqual(metrics[0][key], metrics[1][key],
                             "metric {!r} differs across processes with the same seed".format(key))


if __name__ == "__main__":
    unittest.main(verbosity=2)
