"""Small MuJoCo football environment used to validate the MicroDuck task API.

The environment is deliberately self contained.  It uses a free MuJoCo body
as the high-level duck interface and exposes the same local-observation shape
for one duck or a whole team.  A later adapter can replace ``apply_action``
with the 14-servo MicroDuck actor without changing the task/reward contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import mujoco
import numpy as np


FIELD_LENGTH = 6.0
FIELD_WIDTH = 4.0
GOAL_X = FIELD_LENGTH / 2
DT = 0.04
DUCK_RADIUS = 0.18
BALL_RADIUS = 0.11


def _scene_xml(num_ducks: int) -> str:
    bodies = []
    for i in range(num_ducks):
        side = -1 if i < (num_ducks + 1) // 2 else 1
        lane = i % max(1, (num_ducks + 1) // 2)
        x = -1.8 + 0.7 * lane if side < 0 else 1.0 + 0.7 * lane
        y = (-0.65 if lane % 2 == 0 else 0.65) * (1 if side < 0 else 1)
        bodies.append(
            f'<body name="duck{i}" pos="{x:.3f} {y:.3f} 0.22">'
            f'<freejoint name="duck{i}_free"/><geom name="duck{i}" type="sphere" size="0.18" mass="0.8" '
            'rgba="0.95 0.65 0.08 1"/></body>'
        )
    return f"""
<mujoco model="microduck-football">
  <option timestep="{DT}" gravity="0 0 -9.81" integrator="implicitfast" solver="Newton"/>
  <visual><global offwidth="960" offheight="540"/></visual>
  <size njmax="500" nconmax="200"/>
  <default><geom friction="0.8 0.02 0.01" condim="3"/></default>
  <worldbody>
    <light name="stadium-light" pos="0 -1 8" dir="0 0 -1" diffuse="1 1 1" specular="0.2 0.2 0.2"/>
    <camera name="overview" pos="0 -7 6" xyaxes="1 0 0 0 0.65 0.76"/>
    <geom name="field" type="plane" size="{FIELD_LENGTH} {FIELD_WIDTH} 0.05" rgba="0.12 0.42 0.16 1"/>
    <geom name="left-wall" type="box" pos="0 {-FIELD_WIDTH/2:.3f} 0.18" size="{FIELD_LENGTH/2:.3f} 0.04 0.18" rgba="0.8 0.8 0.8 1"/>
    <geom name="right-wall" type="box" pos="0 {FIELD_WIDTH/2:.3f} 0.18" size="{FIELD_LENGTH/2:.3f} 0.04 0.18" rgba="0.8 0.8 0.8 1"/>
    <body name="ball" pos="0 0 {BALL_RADIUS + 0.02:.3f}"><freejoint name="ball_free"/><geom name="ball" type="sphere" size="{BALL_RADIUS}" mass="0.045" rgba="0.95 0.95 0.95 1"/></body>
    <geom name="goal-left" type="box" pos="{-GOAL_X:.3f} 0 0.35" size="0.04 1.0 0.35" rgba="0.85 0.1 0.1 0.55"/>
    <geom name="goal-right" type="box" pos="{GOAL_X:.3f} 0 0.35" size="0.04 1.0 0.35" rgba="0.1 0.3 0.9 0.55"/>
    {''.join(bodies)}
  </worldbody>
</mujoco>
"""


@dataclass(frozen=True)
class FootballConfig:
    task: str = "single-goal-kick"
    episode_seconds: float = 12.0
    control_hz: float = 25.0
    seed: int = 20260920

    @property
    def num_ducks(self) -> int:
        return {"single-goal-kick": 1, "soccer-2v2": 4, "soccer-3v3": 6}[self.task]

    @property
    def blue_count(self) -> int:
        return 1 if self.task == "single-goal-kick" else int(self.task.split("-")[1][0])


class MicroDuckFootballEnv:
    """MuJoCo football task with local observations and shaped reward."""

    def __init__(self, config: FootballConfig | None = None):
        self.config = config or FootballConfig()
        if self.config.task not in ("single-goal-kick", "soccer-2v2", "soccer-3v3"):
            raise ValueError(f"unknown football task: {self.config.task}")
        self.model = mujoco.MjModel.from_xml_string(_scene_xml(self.config.num_ducks))
        self.data = mujoco.MjData(self.model)
        self.ball_body = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, "ball")
        self.duck_bodies = [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, f"duck{i}") for i in range(self.config.num_ducks)]
        self.ball_joint = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, "ball_free")
        self.duck_joints = [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, f"duck{i}_free") for i in range(self.config.num_ducks)]
        self.rng = np.random.default_rng(self.config.seed)
        self.step_count = 0
        self.last_ball_distance = 0.0
        self.last_goal_distance = 0.0
        self.scored = False

    @property
    def observation_dim(self) -> int:
        return 20 if self.config.task == "single-goal-kick" else 24

    @property
    def privileged_observation_dim(self) -> int:
        """Critic-only channels: world-frame ball truth + every duck's position.

        The asymmetric actor-critic contract: the actor keeps its local, partially
        observable channels, while the value function reads the ground truth the
        sim hands out for free (this is what the upstream-style training stack
        does with its ball-true-value critic).
        """
        return 10 + 2 * (self.config.num_ducks - 1)

    @property
    def action_dim(self) -> int:
        return 4  # forward, strafe, turn, kick

    def reset(self, seed: int | None = None) -> np.ndarray:
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        mujoco.mj_resetData(self.model, self.data)
        self.step_count = 0
        self.scored = False
        ball_qadr = self.model.jnt_qposadr[self.ball_joint]
        self.data.qpos[ball_qadr : ball_qadr + 7] = (self.rng.uniform(-0.2, 0.2), self.rng.uniform(-0.7, 0.7), BALL_RADIUS + 0.02, 1, 0, 0, 0)
        ball_dadr = self.model.jnt_dofadr[self.ball_joint]
        self.data.qvel[ball_dadr : ball_dadr + 6] = 0
        for i, body_id in enumerate(self.duck_bodies):
            qadr = self.model.jnt_qposadr[self.duck_joints[i]]
            side = -1 if i < self.config.blue_count else 1
            lane = i % self.config.blue_count
            self.data.qpos[qadr : qadr + 7] = (side * (1.2 + 0.25 * lane), (-0.65 if lane % 2 == 0 else 0.65), 0.22, 1, 0, 0, 0)
            dadr = self.model.jnt_dofadr[self.duck_joints[i]]
            self.data.qvel[dadr : dadr + 6] = 0
        mujoco.mj_forward(self.model, self.data)
        self.last_ball_distance = self._distance_to_ball(0)
        self.last_goal_distance = self._goal_distance()
        return np.stack([self.observe(i) for i in range(self.config.blue_count)])

    def _duck_xy(self, index: int) -> np.ndarray:
        return self.data.xpos[self.duck_bodies[index], :2].copy()

    def _ball_xy(self) -> np.ndarray:
        return self.data.xpos[self.ball_body, :2].copy()

    def _distance_to_ball(self, index: int) -> float:
        return float(np.linalg.norm(self._duck_xy(index) - self._ball_xy()))

    def _goal_distance(self) -> float:
        ball = self._ball_xy()
        return float(np.linalg.norm(np.array([GOAL_X, 0.0]) - ball))

    def observe(self, index: int = 0) -> np.ndarray:
        duck = self._duck_xy(index)
        ball = self._ball_xy()
        ball_vel = self.data.qvel[self.model.jnt_dofadr[self.ball_joint] : self.model.jnt_dofadr[self.ball_joint] + 2]
        duck_vel = self.data.qvel[self.model.jnt_dofadr[self.duck_joints[index]] : self.model.jnt_dofadr[self.duck_joints[index]] + 2]
        rel_ball = ball - duck
        rel_goal = np.array([GOAL_X, 0.0]) - ball
        own = np.array([*rel_ball, *ball_vel, *duck_vel, *rel_goal, self.data.qpos[self.model.jnt_qposadr[self.duck_joints[index]] + 3]])
        teammates = []
        for j in range(self.config.blue_count):
            if j != index:
                teammates.extend(self._duck_xy(j) - duck)
        opponents = []
        for j in range(self.config.blue_count, self.config.num_ducks):
            opponents.extend(self._duck_xy(j) - duck)
        obs = np.concatenate([own, np.asarray(teammates, dtype=np.float64), np.asarray(opponents, dtype=np.float64)])
        if obs.size < self.observation_dim:
            obs = np.pad(obs, (0, self.observation_dim - obs.size))
        return obs[: self.observation_dim].astype(np.float32)

    def observe_privileged(self, index: int = 0) -> np.ndarray:
        """World-frame ground truth for the value function, not the actor."""
        ball = self._ball_xy()
        ball_vel = self.data.qvel[self.model.jnt_dofadr[self.ball_joint] : self.model.jnt_dofadr[self.ball_joint] + 2]
        duck = self._duck_xy(index)
        duck_vel = self.data.qvel[self.model.jnt_dofadr[self.duck_joints[index]] : self.model.jnt_dofadr[self.duck_joints[index]] + 2]
        rel_goal = np.array([GOAL_X, 0.0]) - ball
        others = []
        for j in range(self.config.num_ducks):
            if j != index:
                others.extend(self._duck_xy(j) - duck)
        privileged = np.concatenate([
            ball, ball_vel, rel_goal, duck, duck_vel,
            np.asarray(others, dtype=np.float64),
        ])
        if privileged.size != self.privileged_observation_dim:
            raise RuntimeError(
                f"privileged observation assembled as {privileged.size}, expected {self.privileged_observation_dim}"
            )
        return privileged.astype(np.float32)

    def _apply_action(self, index: int, action: np.ndarray) -> bool:
        action = np.asarray(action, dtype=np.float64)
        body = self.duck_bodies[index]
        force = np.array([np.clip(action[0], -1, 1), np.clip(action[1], -1, 1), 0.0]) * 2.5
        self.data.xfrc_applied[body, :3] = force
        kick = bool(action[3] > 0.35)
        if kick and self._distance_to_ball(index) < DUCK_RADIUS + BALL_RADIUS + 0.12:
            ball_dof = self.model.jnt_dofadr[self.ball_joint]
            # The high-level command represents a duck facing the opponent
            # goal.  A spherical proxy has no heading, so use the goal-facing
            # kick vector explicitly instead of the incidental duck-to-ball
            # vector.  This keeps the MuJoCo prototype aligned with the
            # football task contract and gives PPO a learnable contact signal.
            direction = np.array([GOAL_X, 0.0]) - self._ball_xy()
            direction /= np.linalg.norm(direction) + 1e-8
            self.data.qvel[ball_dof : ball_dof + 2] += direction * 2.2
            return True
        return False

    def step(self, action: np.ndarray | Iterable[np.ndarray]):
        actions = np.asarray(action, dtype=np.float64)
        if actions.ndim == 1:
            actions = actions[None, :]
        for i in range(min(self.config.blue_count, len(actions))):
            self._apply_action(i, actions[i])
        # Scripted opponents keep the milestone deterministic. They shadow the
        # ball and occasionally kick it away, which is enough for 2v2/3v3 API
        # and reward tests before self-play is enabled.
        for i in range(self.config.blue_count, self.config.num_ducks):
            delta = self._ball_xy() - self._duck_xy(i)
            scripted = np.array([np.clip(delta[0], -1, 1), np.clip(delta[1], -1, 1), 0, 1 if np.linalg.norm(delta) < 0.42 else 0])
            self._apply_action(i, scripted)
        for _ in range(2):
            mujoco.mj_step(self.model, self.data)
        self.step_count += 1
        ball_distance = self._distance_to_ball(0)
        goal_distance = self._goal_distance()
        progress = self.last_goal_distance - goal_distance
        approach = self.last_ball_distance - ball_distance
        ball_x, ball_y = self._ball_xy()
        goal = ball_x >= GOAL_X - 0.16 and abs(ball_y) < 1.0
        out = abs(ball_y) > FIELD_WIDTH / 2 - 0.15 or abs(ball_x) > GOAL_X + 0.4
        self.scored = self.scored or goal
        reward = 0.15 * progress + 0.04 * approach - 0.005
        if goal:
            reward += 10.0
        if out:
            reward -= 2.0
        terminated = bool(goal or out or self.step_count >= int(self.config.episode_seconds * self.config.control_hz))
        self.last_goal_distance = goal_distance
        self.last_ball_distance = ball_distance
        obs = np.stack([self.observe(i) for i in range(self.config.blue_count)])
        info = {"goal": goal, "scored": self.scored, "ballX": float(ball_x), "ballY": float(ball_y), "goalDistance": goal_distance}
        return obs, np.full(self.config.blue_count, reward, dtype=np.float32), terminated, info


class FootballBatch:
    """Independent MuJoCo worlds with a stable torch-friendly batch API."""

    def __init__(self, task: str, num_envs: int, seed: int = 20260920):
        self.envs = [MicroDuckFootballEnv(FootballConfig(task=task, seed=seed + i)) for i in range(num_envs)]
        self.observation_dim = self.envs[0].observation_dim
        self.action_dim = self.envs[0].action_dim
        self.privileged_observation_dim = self.envs[0].privileged_observation_dim
        self.num_agents = self.envs[0].config.blue_count

    def reset(self) -> np.ndarray:
        return np.stack([env.reset() for env in self.envs])

    def privileged_obs(self) -> np.ndarray:
        """Ground-truth observations for the controlled (blue) agents, post-reset/step."""
        return np.stack([
            np.stack([env.observe_privileged(i) for i in range(env.config.blue_count)])
            for env in self.envs
        ])

    def step(self, actions: np.ndarray):
        results = [env.step(actions[i]) for i, env in enumerate(self.envs)]
        obs, rewards, dones, infos = zip(*results)
        for i, done in enumerate(dones):
            if done:
                obs = list(obs)
                obs[i] = self.envs[i].reset()
        return np.stack(obs), np.stack(rewards), np.asarray(dones, dtype=np.float32), list(infos)
