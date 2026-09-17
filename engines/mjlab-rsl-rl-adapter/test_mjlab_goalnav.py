#!/usr/bin/env python3
"""Tests for the mjlab goal-navigation task + adapter seam.

Run: python3 -m unittest discover -s engines/mjlab-rsl-rl-adapter -p 'test_mjlab*.py'
     (no mjlab needed — every mjlab-dependent path is exercised against a
     stub module; with mjlab absent the honest-refusal paths run for real)

mjlab cannot be installed on every dev box (its wandb>=0.22.3 pin is
unresolvable on this host — probe-verified), so the module's mjlab API
usage is pinned two ways instead:
  * build_goalnav_env_cfg is driven against STUB mjlab cfg classes that
    record the kwargs — asserting the decimation/joints/scales/terms the
    real API would receive, so an mjlab API drift fails loudly
  * the manager term functions (goal delta / yaw error / rewards /
    terminations) are tested on a mock env with hand-computed geometry —
    they are pure functions of root state + goal, no mjlab involved
The honest-refusal contract (REFUSED exit 3 when mjlab is missing, never a
fabricated completed run) is asserted on the real module with no stub.
"""

import importlib.util
import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
TASK_PATH = REPO_ROOT / "tasks" / "originbot-goal-navigation.json"
ADAPTERS_DIR = REPO_ROOT / "adapters"
MODULE_PATH = HERE / "mjlab_goalnav_task.py"
ADAPTER_PATH = HERE / "adapter.py"


try:
    import torch  # noqa: F401
    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False

try:
    import mujoco  # noqa: F401
    HAVE_MUJOCO = True
except ImportError:
    HAVE_MUJOCO = False


def load_module():
    spec = importlib.util.spec_from_file_location("mjlab_goalnav_task", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_resolved_pack():
    task = json.loads(TASK_PATH.read_text())
    adapter = json.loads((ADAPTERS_DIR / f"{task['adapterId']}.json").read_text())
    decision_hz = adapter.get("runtime", {}).get("decisionHz", 10)
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
        "controlHz": decision_hz,
        "seed": 7,
    }


class _Recorder:
    """Stub for every mjlab cfg class: records constructor kwargs."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        for key, value in kwargs.items():
            setattr(self, key, value)

    def __repr__(self):
        return f"<stub {type(self).__name__} {sorted(self.kwargs)}>"


def _install_mjlab_stub():
    """A fake 'mjlab' package exposing the exact import surface used."""
    stub = types.ModuleType("mjlab")

    def make_cfg(name):
        return type(name, (_Recorder,), {})

    envs = types.ModuleType("mjlab.envs")
    envs.ManagerBasedRlEnv = make_cfg("ManagerBasedRlEnv")
    envs.ManagerBasedRlEnvCfg = make_cfg("ManagerBasedRlEnvCfg")
    envs.SceneCfg = make_cfg("SceneCfg")

    envs_mdp = types.ModuleType("mjlab.envs.mdp")
    actions_mod = types.ModuleType("mjlab.envs.mdp.actions")
    actions_mod.JointVelocityActionCfg = make_cfg("JointVelocityActionCfg")
    obs_mod = types.ModuleType("mjlab.envs.mdp.observations")

    def _mdp_func(name):
        def func(env, **params):
            raise AssertionError(f"stub mdp func {name} must not be called in tests")
        func.__name__ = name
        return func

    obs_mod.base_ang_vel = _mdp_func("base_ang_vel")
    obs_mod.last_action = _mdp_func("last_action")
    obs_mod.projected_gravity = _mdp_func("projected_gravity")
    terms_mod = types.ModuleType("mjlab.envs.mdp.terminations")
    terms_mod.time_out = _mdp_func("time_out")

    managers_obs = types.ModuleType("mjlab.managers.observation_manager")
    managers_obs.ObservationGroupCfg = make_cfg("ObservationGroupCfg")
    managers_obs.ObservationTermCfg = make_cfg("ObservationTermCfg")
    managers_reward = types.ModuleType("mjlab.managers.reward_manager")
    managers_reward.RewardTermCfg = make_cfg("RewardTermCfg")
    managers_term = types.ModuleType("mjlab.managers.termination_manager")
    managers_term.TerminationTermCfg = make_cfg("TerminationTermCfg")

    scene_mod = types.ModuleType("mjlab.scene")
    scene_mod.SceneCfg = envs.SceneCfg
    sim_mod = types.ModuleType("mjlab.sim")
    sim_mod.SimulationCfg = make_cfg("SimulationCfg")
    entity_mod = types.ModuleType("mjlab.entity.entity")
    entity_cls = make_cfg("EntityCfg")
    entity_mod.EntityCfg = entity_cls
    entity_mod.EntityCfg.InitialStateCfg = make_cfg("InitialStateCfg")

    for name, mod in {
        "mjlab": stub, "mjlab.envs": envs, "mjlab.envs.mdp": envs_mdp,
        "mjlab.envs.mdp.actions": actions_mod,
        "mjlab.envs.mdp.observations": obs_mod,
        "mjlab.envs.mdp.terminations": terms_mod,
        "mjlab.managers": types.ModuleType("mjlab.managers"),
        "mjlab.managers.observation_manager": managers_obs,
        "mjlab.managers.reward_manager": managers_reward,
        "mjlab.managers.termination_manager": managers_term,
        "mjlab.scene": scene_mod, "mjlab.sim": sim_mod,
        "mjlab.entity": types.ModuleType("mjlab.entity"),
        "mjlab.entity.entity": entity_mod,
    }.items():
        sys.modules[name] = mod
    stub.envs = envs
    envs.mdp = envs_mdp
    envs_mdp.actions = actions_mod
    envs_mdp.observations = obs_mod
    envs_mdp.terminations = terms_mod
    stub.managers = sys.modules["mjlab.managers"]
    stub.scene = scene_mod
    stub.sim = sim_mod
    stub.entity = sys.modules["mjlab.entity"]
    return stub


class GoalNavCfgTests(unittest.TestCase):
    """build_goalnav_env_cfg hands mjlab the calibrated task, not guesses."""

    def setUp(self):
        self._saved = dict(sys.modules)
        _install_mjlab_stub()
        self.module = load_module()

    def tearDown(self):
        sys.modules.clear()
        sys.modules.update(self._saved)

    def test_cfg_pins_decimation_joints_and_scales(self):
        pack = load_resolved_pack()
        cfg = self.module.build_goalnav_env_cfg(pack, num_envs=64)
        control_hz = pack["controlHz"]
        self.assertEqual(cfg.kwargs["decimation"], max(1, round((1.0 / control_hz) / 0.005)))
        actions = cfg.kwargs["actions"]
        wheels = actions["wheels"]
        self.assertEqual(wheels.kwargs["entity_name"], "robot")
        self.assertEqual(
            wheels.kwargs["joint_names"], ["wheel_left_hinge", "wheel_right_hinge"]
        )
        calib = json.loads(
            (REPO_ROOT / "assets" / "originbot" / "calibration.json").read_text()
        )
        max_wheel = float(calib["wheels"]["maxWheelSpeed"])
        self.assertEqual(wheels.kwargs["scale"], (max_wheel, max_wheel))

    def test_cfg_8d_layout_terms_and_pack_weights(self):
        pack = load_resolved_pack()
        cfg = self.module.build_goalnav_env_cfg(pack, num_envs=8)
        obs_group = cfg.kwargs["observations"]["actor"]
        terms = obs_group.kwargs["terms"]
        # the exact starter 8D field set, nothing else
        self.assertEqual(
            sorted(terms), ["believed_twist", "goal_delta", "last_command", "yaw_error"]
        )
        rewards = cfg.kwargs["rewards"]
        self.assertAlmostEqual(
            rewards["progress"].kwargs["weight"], float(pack["reward"]["progress"])
        )
        self.assertAlmostEqual(
            rewards["goal"].kwargs["weight"], float(pack["reward"]["goal"])
        )
        self.assertAlmostEqual(
            rewards["action_penalty"].kwargs["weight"],
            float(pack["reward"]["actionPenalty"]),
        )
        terminations = cfg.kwargs["terminations"]
        self.assertIn("goal_reached", terminations)
        self.assertIn("time_out", terminations)
        timeout = pack["termination"]["timeoutSteps"]
        self.assertAlmostEqual(cfg.kwargs["episode_length_s"], timeout / pack["controlHz"])

    def test_cfg_seed_and_envs(self):
        pack = load_resolved_pack()
        cfg = self.module.build_goalnav_env_cfg(pack, num_envs=17)
        self.assertEqual(cfg.kwargs["seed"], 7)
        self.assertEqual(cfg.kwargs["scene"].kwargs["num_envs"], 17)


@unittest.skipUnless(HAVE_MUJOCO, "mujoco not installed")
class RobotSpecTests(unittest.TestCase):
    """The robot entity must be the shared calibrated MJCF, not a copy."""

    def test_spec_fn_builds_mjx_scene_model(self):
        module = load_module()
        spec_fn = module._robot_spec_fn()
        spec_obj = spec_fn()
        model = spec_obj.compile()
        import mujoco

        self.assertEqual(model.nq, 9)  # free joint + 2 wheel hinges
        self.assertEqual(model.nu, 2)
        wall = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "wall_x+")
        self.assertEqual(wall, -1, "robot entity must NOT embed workspace walls")


@unittest.skipUnless(HAVE_TORCH, "torch not installed (mjlab stack is torch-native)")
class TermFunctionTests(unittest.TestCase):
    """Manager terms are pure geometry: hand-computed expectations."""

    def _make_env(self, robot_xy=(1.0, 0.0), yaw=0.0, goal=(3.0, 2.0)):
        import torch

        module = load_module()
        w = math.cos(yaw / 2.0)
        z = math.sin(yaw / 2.0)
        root_state = torch.tensor(
            [[robot_xy[0], robot_xy[1], 0.17, w, 0.0, 0.0, z, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]]
        )
        robot_data = types.SimpleNamespace(root_entity_state=root_state)

        class _Cmd:
            def get_command(self, name):
                return torch.tensor([[goal[0], goal[1]]])

        class _Action:
            def __init__(self):
                self.terminated_actions = torch.tensor([[0.7, -0.2]])

        return (
            module,
            types.SimpleNamespace(
                scene={"robot": types.SimpleNamespace(data=robot_data)},
                command_manager=_Cmd(),
                action_manager=types.SimpleNamespace(action=_Action()),
            ),
        )

    def test_goal_delta_body_frame_identity_yaw(self):
        module, env = self._make_env()
        out = module._goal_delta_body_frame(env)
        # robot at (1,0) yaw 0, goal (3,2): body frame == world frame
        self.assertAlmostEqual(float(out[0][0]), 2.0, places=5)
        self.assertAlmostEqual(float(out[0][1]), 2.0, places=5)

    def test_goal_delta_body_frame_rotated_yaw(self):
        module, env = self._make_env(robot_xy=(1.0, 0.0), yaw=math.pi / 2, goal=(1.0, 2.0))
        out = module._goal_delta_body_frame(env)
        # yaw=90°: world +y becomes body +x; goal is 2 m above robot
        self.assertAlmostEqual(float(out[0][0]), 2.0, places=5)
        self.assertAlmostEqual(float(out[0][1]), 0.0, places=5)

    def test_yaw_error_wraps_via_sin_cos(self):
        module, env = self._make_env(robot_xy=(0.0, 0.0), yaw=0.0, goal=(1.0, 0.0))
        out = module._yaw_error(env)
        # goal straight along +x, yaw 0: sin(0)=0, cos(0)=1
        self.assertAlmostEqual(float(out[0][0]), 0.0, places=5)
        self.assertAlmostEqual(float(out[0][1]), 1.0, places=5)

    def test_goal_reward_and_termination_threshold(self):
        module, close_env = self._make_env(robot_xy=(0.0, 0.0), goal=(0.1, 0.0))
        reached = module._goal_reached(close_env)
        self.assertTrue(bool(reached[0]))
        module, far_env = self._make_env(robot_xy=(0.0, 0.0), goal=(2.0, 0.0))
        reached = module._goal_reached(far_env)
        self.assertFalse(bool(reached[0]))

    def test_progress_reward_positive_when_closing(self):
        module, env = self._make_env()
        first = module._progress_reward(env)  # prev==distance on first call
        self.assertAlmostEqual(float(first[0]), 0.0, places=5)
        # move robot closer to goal (3,2): now at (2,1)
        env.scene["robot"].data.root_entity_state[0][0] = 2.0
        env.scene["robot"].data.root_entity_state[0][1] = 1.0
        second = module._progress_reward(env)
        prev = math.hypot(3.0 - 1.0, 2.0 - 0.0)  # |goal - (1,0)| at first call
        now = math.hypot(3.0 - 2.0, 2.0 - 1.0)  # |goal - (2,1)| after moving
        self.assertAlmostEqual(float(second[0]), prev - now, places=5)
        self.assertGreater(float(second[0]), 0.0)

    def test_action_penalty_mean_abs(self):
        module, env = self._make_env()
        out = module._action_penalty(env)
        self.assertAlmostEqual(float(out[0]), (0.7 + 0.2) / 2, places=5)


@unittest.skipUnless(HAVE_TORCH, "torch not installed (adapter requires it)")
@unittest.skipIf(
    os.environ.get("RDK_RSL_ADAPTER_FORCE_MJLAB") == "0",
    "forced-kinematic mode would mask the fallback labeling",
)
class HonestBackendTests(unittest.TestCase):
    """Without mjlab the adapter trains the kinematic fallback AND labels
    it; a forced mjlab request it cannot honor is a refusal, never a
    silent kinematic substitution."""

    def _run(self, tmp, extra_env=None):
        pack = load_resolved_pack()
        request = {
            "schemaVersion": 1,
            "contractId": "goalnav-policy-v1",
            "contract": {
                "id": "goalnav-policy-v1",
                "observationSize": 8,
                "actionSize": 2,
                "controlHz": pack["controlHz"],
                "physicsTimestepSeconds": 0.005,
            },
            "model": {"modelId": "mjlab-test", "version": "0.1.0-test"},
            "training": {"profile": "smoke", "numEnvs": 2, "maxIterations": 2},
            "task": pack,
        }
        request_path = os.path.join(tmp, "request.json")
        result_path = os.path.join(tmp, "result.json")
        with open(request_path, "w") as handle:
            json.dump(request, handle)
        env = {k: v for k, v in os.environ.items() if not k.startswith("RDK_")}
        env.update({
            "PYTHONPATH": str(REPO_ROOT),
            "RDK_SIM2REAL_REQUEST_FILE": request_path,
            "RDK_SIM2REAL_RESULT_FILE": result_path,
            "RDK_STARTER_ENGINE_ITERATIONS": "2",
            "RDK_STARTER_ENGINE_STEPS": "8",
            "RDK_STARTER_ENGINE_ENVS": "2",
        })
        env.update(extra_env or {})
        proc = subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            capture_output=True, text=True, timeout=900, env=env, cwd=tmp,
        )
        return proc, result_path

    def test_fallback_is_labeled_kinematic(self):
        """No FORCE flag: result honestly says starter-kinematic, run completes."""
        with tempfile.TemporaryDirectory() as tmp:
            proc, result_path = self._run(tmp)
            self.assertEqual(proc.returncode, 0, proc.stderr[-500:])
            with open(result_path) as handle:
                result = json.load(handle)
            self.assertEqual(result["metrics"]["physicsBackend"], "starter-kinematic")
            self.assertFalse(result["deployable"])
            self.assertTrue(os.path.exists(os.path.join(tmp, "SHA256SUMS")))

    def test_forced_mjlab_without_mjlab_refuses(self):
        """FORCE=1 but mjlab unimportable: exit 3, no result.json ever."""
        import importlib.util

        mjlab_spec = importlib.util.find_spec("mjlab")
        if mjlab_spec is not None:
            self.skipTest("mjlab installed here; refusal path unreachable")
        with tempfile.TemporaryDirectory() as tmp:
            proc, result_path = self._run(tmp, {"RDK_RSL_ADAPTER_FORCE_MJLAB": "1"})
            self.assertEqual(proc.returncode, 3, proc.stderr[-500:])
            self.assertIn("REFUSED", proc.stderr)
            self.assertFalse(os.path.exists(result_path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
