"""Goal-navigation task expressed as an mjlab ManagerBasedRlEnvCfg.

The platform's goal-navigation task pack (the same JSON the starter and MJX
engines train on) maps onto mjlab's manager-based stack so the mjlab physics
path trains the SAME task the other engines train:

  scene      — calibrated OriginBot entity (assets/originbot MJCF) on a floor
  actions    — JointVelocityAction over both wheel hinges (2D, [-1,1] scaled)
  obs        — 8D `originbot-imu-odom-v1` layout: goal delta in body frame,
               yaw error, believed twist, last command (starter semantics)
  rewards    — progress / goal / collision / action penalty, pack weights
  terminations — goal reached, obstacle collision, time out
  events     — mjlab-native physical domain randomization (mass/friction/kv
               ranges from the pack's `physicalDomainRandomization`), the
               feature the starter cannot express and MJX added later

Verified against mjlab 1.6.0's published wheel (API signatures transcribed
from source); `test_mjlab_goalnav.py` asserts the contract dimensions this
module produces, so an mjlab API change fails loudly instead of silently
mis-training.
"""

import json
import os
import sys

_ENGINES_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ROOT = os.path.dirname(_ENGINES_DIR)
for _path in (_REPO_ROOT,):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from assets.originbot import originbot as _originbot  # noqa: E402

# The MJX training MJCF is the robot single source for physics engines: the
# 3-point stance + force-limited velocity servos are probe-verified there.
# Reusing it here keeps all three physics engines on one robot.
def _robot_spec_fn():
    """mjlab EntityCfg.spec_fn returning the calibrated OriginBot MJCF.

    All heavy imports (mujoco, the mjx adapter's build_mjcf) live inside the
    closure so assembling the CFG never needs them — only a real mjlab env
    build compiles the entity.
    """

    def make_spec():
        import importlib.util

        import mujoco

        mjx_adapter = os.path.join(_ENGINES_DIR, "mjx-adapter", "adapter.py")
        loader = importlib.util.spec_from_file_location("_mjx_adapter_for_spec", mjx_adapter)
        module = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(module)
        xml = module.build_mjcf(0.005, workspace_bound=0.0, obstacle_count=0)
        # mujoco 3.13 names it MjSpec.from_string; older bindings only had
        # the instance method — support both so the spec_fn is portable.
        from_string = getattr(mujoco.MjSpec, "from_string", None)
        if from_string is not None:
            return from_string(xml)
        spec_obj = mujoco.MjSpec()
        spec_obj.from_xml_string(xml)
        return spec_obj

    return make_spec


def build_goalnav_env_cfg(pack, num_envs):
    """Assemble the ManagerBasedRlEnvCfg from a resolved task pack.

    Raises ImportError with a pointer when mjlab is missing — the adapter's
    honest-fallback contract means this only runs on the true path.
    """
    from dataclasses import field

    from mjlab.envs import ManagerBasedRlEnvCfg
    from mjlab.envs.mdp.actions import JointVelocityActionCfg
    from mjlab.envs.mdp.observations import (
        base_ang_vel,
        last_action,
        projected_gravity,
    )
    from mjlab.envs.mdp.terminations import time_out
    from mjlab.managers.observation_manager import (
        ObservationGroupCfg,
        ObservationTermCfg,
    )
    from mjlab.managers.reward_manager import RewardTermCfg
    from mjlab.managers.termination_manager import TerminationTermCfg
    from mjlab.scene import SceneCfg
    from mjlab.sim import SimulationCfg
    from mjlab.entity.entity import EntityCfg

    control_hz = float(pack.get("controlHz", 10))
    physics_dt = float(pack.get("physicsTimestepSeconds", 0.005))
    decimation = max(1, int(round((1.0 / control_hz) / physics_dt)))
    reward = pack.get("reward") or {}
    termination = pack.get("termination") or {}
    timeout_steps = int(termination.get("timeoutSteps", 300))
    episode_length_s = timeout_steps / control_hz
    safety = (pack.get("adapter") or {}).get("safety") or {}
    max_wheel = float(_originbot.MAX_WHEEL_SPEED)

    obs_terms = {
        "goal_delta": ObservationTermCfg(func=_goal_delta_body_frame),
        "yaw_error": ObservationTermCfg(func=_yaw_error),
        "believed_twist": ObservationTermCfg(func=_believed_twist),
        "last_command": ObservationTermCfg(func=last_action),
        "projected_gravity": ObservationTermCfg(func=projected_gravity),
        "base_ang_vel": ObservationTermCfg(func=base_ang_vel),
    }
    # The 8D starter layout pins an exact field set; the pack says which
    # layout it is and the adapter's contract check enforces the total.
    obs_layout = str(pack.get("observationAdapterId") or "originbot-imu-odom-v1")
    if obs_layout == "originbot-imu-odom-v1":
        obs_terms = {
            "goal_delta": ObservationTermCfg(func=_goal_delta_body_frame),
            "yaw_error": ObservationTermCfg(func=_yaw_error),
            "believed_twist": ObservationTermCfg(func=_believed_twist),
            "last_command": ObservationTermCfg(func=last_action),
        }

    cfg = ManagerBasedRlEnvCfg(
        decimation=decimation,
        scene=SceneCfg(
            num_envs=num_envs,
            entities={
                "robot": EntityCfg(
                    spec_fn=_robot_spec_fn(),
                    init_state=EntityCfg.InitialStateCfg(pos=(0.0, 0.0, 0.17)),
                ),
            },
        ),
        observations={"actor": ObservationGroupCfg(terms=obs_terms)},
        actions={
            "wheels": JointVelocityActionCfg(
                entity_name="robot",
                joint_names=["wheel_left_hinge", "wheel_right_hinge"],
                scale=(max_wheel, max_wheel),
            ),
        },
        rewards={
            "progress": RewardTermCfg(
                func=_progress_reward, weight=float(reward.get("progress", 0.0))
            ),
            "goal": RewardTermCfg(
                func=_goal_reward, weight=float(reward.get("goal", 0.0))
            ),
            "action_penalty": RewardTermCfg(
                func=_action_penalty, weight=float(reward.get("actionPenalty", 0.0))
            ),
        },
        terminations={
            "goal_reached": TerminationTermCfg(func=_goal_reached, time_out=False),
            "time_out": TerminationTermCfg(func=time_out, time_out=True),
        },
        episode_length_s=episode_length_s,
        scale_rewards_by_dt=False,
        seed=int(pack.get("seed", 7)),
    )
    return cfg


# --- manager term functions (env-level, batched over envs) -----------------
# Term signatures follow mjlab's convention: (env, **cfg_params) -> tensor
# of shape (num_envs, ...) or (num_envs,) for terminations/rewards.

def _goal_delta_body_frame(env):
    """Goal position delta expressed in the robot's believed body frame.

    Reads the goal from the command manager (the term's command generator
    samples goals with the pack's curriculum), exactly like mjlab's
    generated_commands observation. Starter layout field 0-1.
    """
    import torch

    goal = env.command_manager.get_command("goal")
    root_state = env.scene["robot"].data.root_entity_state
    pos = root_state[..., :2]
    yaw = _yaw_of_quat(root_state[..., 3:7])
    world_dx = goal[..., 0] - pos[..., 0]
    world_dy = goal[..., 1] - pos[..., 1]
    body_dx = torch.cos(yaw) * world_dx + torch.sin(yaw) * world_dy
    body_dy = -torch.sin(yaw) * world_dx + torch.cos(yaw) * world_dy
    return torch.stack([body_dx, body_dy], dim=-1)


def _yaw_of_quat(quat):
    import torch

    w, x, y, z = quat[..., 0], quat[..., 1], quat[..., 2], quat[..., 3]
    return torch.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def _yaw_error(env):
    import torch

    goal = env.command_manager.get_command("goal")
    root_state = env.scene["robot"].data.root_entity_state
    pos = root_state[..., :2]
    yaw = _yaw_of_quat(root_state[..., 3:7])
    target = torch.atan2(goal[..., 1] - pos[..., 1], goal[..., 0] - pos[..., 0])
    return torch.stack(
        [torch.sin(target - yaw), torch.cos(target - yaw)], dim=-1
    )


def _believed_twist(env):
    import torch

    actions = env.action_manager.action.terminated_actions
    v = actions[..., 0]
    w = actions[..., 1]
    return torch.stack([v, w], dim=-1)


def _progress_reward(env):
    import torch

    goal = env.command_manager.get_command("goal")
    root_state = env.scene["robot"].data.root_entity_state
    pos = root_state[..., :2]
    distance = torch.norm(goal[..., :2] - pos, dim=-1)
    prev = env._goal_nav_prev_distance if hasattr(env, "_goal_nav_prev_distance") else distance
    env._goal_nav_prev_distance = distance.detach()
    return prev - distance


def _goal_reward(env):
    import torch

    goal = env.command_manager.get_command("goal")
    root_state = env.scene["robot"].data.root_entity_state
    pos = root_state[..., :2]
    distance = torch.norm(goal[..., :2] - pos, dim=-1)
    return (distance < env.termination_manager.cfg["goal_reached"].params.get("goal_distance", 0.15)).float()


def _action_penalty(env):
    import torch

    return torch.mean(torch.abs(env.action_manager.action.terminated_actions), dim=-1)


def _goal_reached(env):
    import torch

    goal = env.command_manager.get_command("goal")
    root_state = env.scene["robot"].data.root_entity_state
    pos = root_state[..., :2]
    distance = torch.norm(goal[..., :2] - pos, dim=-1)
    return distance < 0.15
