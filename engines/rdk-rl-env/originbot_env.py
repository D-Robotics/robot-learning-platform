"""Small, dependency-free OriginBot differential-drive environment.

The environment is intentionally compatible with the 8 -> 2 OriginBot policy
contract used by the starter trainer, but it models the failure modes that are
important for a sim-to-real policy: per-episode motor variation, actuator lag,
command latency, wheel slip, IMU/odometry noise and stale sensor frames.

This module is not a replacement for MuJoCo.  It is the deterministic fallback
used by the file-protocol trainer and by local contract tests.  Keeping the
same sensor and command semantics here makes it useful for smoke training and
for checking that a policy cannot accidentally rely on ideal simulator state.
"""

from collections import deque
from dataclasses import dataclass
import math
import random
from typing import Any, Deque, Dict, Mapping, Optional, Sequence, Tuple


def _clip(value: float, low: float, high: float) -> float:
    return max(low, min(high, float(value)))


def _wrap_angle(value: float) -> float:
    return (float(value) + math.pi) % (2.0 * math.pi) - math.pi


@dataclass
class OriginBotAdapter:
    """Static robot contract and command projection.

    ``project_action`` remains a public helper for callers that used the first
    version of this environment. Episode-specific randomization is applied by
    :class:`RDKRobotEnv`, rather than mutating this adapter, so two environments
    can safely share one adapter instance.
    """

    dt: float = 0.1
    max_linear: float = 0.3
    max_angular: float = 1.0
    observation_size: int = 8
    action_size: int = 2
    # Optional nominal calibration used when project_action is called directly.
    motor_gain: float = 1.0
    slip_scale: float = 1.0
    angular_bias: float = 0.0
    action_latency_steps: int = 0

    def project_action(self, action: Sequence[float]) -> Tuple[float, float]:
        """Clip a ``[linear, angular]`` command to the board safety limits.

        The returned values are physical ``m/s`` and ``rad/s``. The nominal
        calibration fields are retained for backwards compatibility with the
        original helper; the environment itself applies its sampled domain
        parameters exactly once in its dynamics path.
        """

        if len(action) < 2:
            raise ValueError("OriginBot action must contain linear and angular values")
        v = _clip(float(action[0]), -self.max_linear, self.max_linear)
        w = _clip(float(action[1]), -self.max_angular, self.max_angular)
        # Calibration cannot bypass the board's safety limits.
        return (
            _clip(v * float(self.motor_gain) * float(self.slip_scale), -self.max_linear, self.max_linear),
            _clip(w * float(self.motor_gain) + float(self.angular_bias), -self.max_angular, self.max_angular),
        )

    def clip_command(self, action: Sequence[float]) -> Tuple[float, float]:
        """Return a safety-clipped command without calibration side effects."""

        if len(action) < 2:
            raise ValueError("OriginBot action must contain linear and angular values")
        return (
            _clip(float(action[0]), -self.max_linear, self.max_linear),
            _clip(float(action[1]), -self.max_angular, self.max_angular),
        )

    def observation(
        self,
        state: Sequence[float],
        pose: Optional[Sequence[float]] = None,
        velocity: Optional[Sequence[float]] = None,
    ) -> list:
        """Build the native 8D observation layout.

        Layout: ``x, y, sin(yaw), cos(yaw), goal_dx, goal_dy, v, w``. When no
        overrides are supplied this preserves the original true-state helper.
        The environment passes noisy odometry and measured velocity instead.
        """

        if len(state) < 7:
            raise ValueError("OriginBot state must contain x, y, yaw, goal x/y, v, w")
        x, y, yaw, gx, gy = [float(v) for v in state[:5]]
        default_v, default_w = float(state[5]), float(state[6])
        if pose is not None:
            if len(pose) < 3:
                raise ValueError("pose must contain x, y, yaw")
            x, y, yaw = [float(v) for v in pose[:3]]
        if velocity is not None:
            if len(velocity) < 2:
                raise ValueError("velocity must contain linear and angular values")
            default_v, default_w = [float(v) for v in velocity[:2]]
        return [
            x,
            y,
            math.sin(yaw),
            math.cos(yaw),
            gx - x,
            gy - y,
            default_v,
            default_w,
        ]


@dataclass(frozen=True)
class DomainParameters:
    """One episode's sampled sim-to-real parameters."""

    motor_gain: float = 1.0
    lag_tau_seconds: float = 0.0
    gyro_noise_std: float = 0.0
    odom_noise_std: float = 0.0
    angular_bias: float = 0.0
    latency_steps: int = 0
    odom_dropout_prob: float = 0.0
    slip_scale: float = 1.0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "motorGain": round(float(self.motor_gain), 6),
            "lagTauSeconds": round(float(self.lag_tau_seconds), 6),
            "gyroNoiseStdRadSec": round(float(self.gyro_noise_std), 6),
            "odomNoiseStdM": round(float(self.odom_noise_std), 6),
            "angularBiasRadSec": round(float(self.angular_bias), 6),
            "actionLatencySteps": int(self.latency_steps),
            "odomDropoutProb": round(float(self.odom_dropout_prob), 6),
            "slipScale": round(float(self.slip_scale), 6),
        }


DEFAULT_RANDOMIZATION_SPEC: Dict[str, Sequence[float]] = {
    "motorGain": (0.8, 1.2),
    "lagTauSeconds": (0.05, 0.25),
    "gyroNoiseStdRadSec": (0.0, 0.05),
    "odomNoiseStdM": (0.0, 0.02),
    "angularBiasRadSec": (-0.05, 0.05),
    "actionLatencySteps": (0, 2),
    "odomDropoutProb": (0.0, 0.05),
    "slipScale": (0.8, 1.0),
}


def _range(spec: Mapping[str, Any], key: str, default: Sequence[float]) -> Tuple[float, float]:
    value = spec.get(key, default)
    if isinstance(value, (int, float)):
        lo = hi = float(value)
    else:
        values = list(value or default)
        if not values:
            values = list(default)
        if len(values) == 1:
            lo = hi = float(values[0])
        else:
            lo, hi = float(values[0]), float(values[1])
    if lo > hi:
        lo, hi = hi, lo
    return lo, hi


def sample_domain_parameters(
    rng: random.Random,
    enabled: bool,
    spec: Optional[Mapping[str, Any]] = None,
) -> DomainParameters:
    """Sample one immutable domain envelope using the environment RNG."""

    if not enabled:
        return DomainParameters()
    cfg = dict(DEFAULT_RANDOMIZATION_SPEC)
    if spec:
        cfg.update(spec)

    def uniform(key: str, default: Sequence[float]) -> float:
        lo, hi = _range(cfg, key, default)
        return rng.uniform(lo, hi)

    latency_lo, latency_hi = _range(cfg, "actionLatencySteps", (0, 0))
    latency_low = int(math.ceil(latency_lo))
    latency_high = int(math.floor(latency_hi))
    if latency_high < latency_low:
        latency_high = latency_low
    latency = rng.randint(latency_low, latency_high)
    return DomainParameters(
        motor_gain=uniform("motorGain", (1.0, 1.0)),
        lag_tau_seconds=uniform("lagTauSeconds", (0.0, 0.0)),
        gyro_noise_std=max(0.0, uniform("gyroNoiseStdRadSec", (0.0, 0.0))),
        odom_noise_std=max(0.0, uniform("odomNoiseStdM", (0.0, 0.0))),
        angular_bias=uniform("angularBiasRadSec", (0.0, 0.0)),
        latency_steps=max(0, latency),
        odom_dropout_prob=_clip(uniform("odomDropoutProb", (0.0, 0.0)), 0.0, 1.0),
        slip_scale=max(0.0, uniform("slipScale", (1.0, 1.0))),
    )


class RDKRobotEnv:
    """Deterministic, adapter-driven OriginBot navigation environment.

    ``domain_randomization`` may be a boolean or a mapping containing the
    ranges from ``tasks/originbot-goal-navigation.json``. Parameters are
    sampled once per episode and exposed in reset/step info. The true pose is
    kept in ``state``; ``odom`` is a separate, noisy/slip-blind sensor pose so
    policies cannot silently train on simulator ground truth.
    """

    def __init__(
        self,
        adapter: Optional[OriginBotAdapter] = None,
        seed: int = 7,
        horizon: int = 200,
        domain_randomization: Any = False,
        randomization_spec: Optional[Mapping[str, Any]] = None,
        goal_distance: Sequence[float] = (1.0, 2.0),
        goal_tolerance: float = 0.12,
        workspace_bound: Optional[float] = None,
        obstacle_count: int = 0,
        obstacle_radius: float = 0.15,
    ):
        self.adapter = adapter or OriginBotAdapter()
        self.horizon = max(1, int(horizon))
        self.rng = random.Random(seed)
        self.seed = int(seed)
        self.domain_randomization = bool(domain_randomization)
        if isinstance(domain_randomization, Mapping):
            self.domain_randomization = True
            if randomization_spec is None:
                randomization_spec = domain_randomization
        self.randomization_spec = dict(randomization_spec or {})
        self.goal_distance = (float(goal_distance[0]), float(goal_distance[1]))
        if self.goal_distance[0] > self.goal_distance[1]:
            self.goal_distance = (self.goal_distance[1], self.goal_distance[0])
        self.goal_tolerance = max(0.0, float(goal_tolerance))
        self.workspace_bound = None if workspace_bound is None else abs(float(workspace_bound))
        # Keep the dependency-free fallback on the same scene contract as the
        # task pack/MuJoCo path.  Obstacles are sampled per episode and are
        # exposed in reset/step metadata so replay can reconstruct the scene.
        self.obstacle_count = max(0, int(obstacle_count))
        self.obstacle_radius = max(0.0, float(obstacle_radius))
        self.obstacles: list[Tuple[float, float, float]] = []
        self.state = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
        self.odom = [0.0, 0.0, 0.0]
        self.t = 0
        self.episode_id = 0
        self.randomization: Dict[str, Any] = {}
        self.domain = DomainParameters()
        self._pending_actions: Deque[Tuple[float, float]] = deque()
        self._queue_latency = 0
        self._actuator_v = 0.0
        self._actuator_w = 0.0
        self._imu_gyro = 0.0
        self._sensor_odom = (0.0, 0.0, 0.0)
        self._last_sensor_odom = (0.0, 0.0, 0.0)
        self._last_obs = [0.0] * self.adapter.observation_size
        self._obs_initialized = False
        self._episode_return = 0.0
        self._episode_distance = 0.0
        self._episode_path_length = 0.0
        self._episode_success = False
        self._episode_collision = False
        self._episode_truncated = False
        self._episode_done = False
        self._last_command = (0.0, 0.0)
        self.reset()

    def _nominal_domain(self) -> DomainParameters:
        """Translate adapter calibration into the non-randomized envelope."""

        return DomainParameters(
            motor_gain=float(self.adapter.motor_gain),
            latency_steps=max(0, int(self.adapter.action_latency_steps)),
            angular_bias=float(self.adapter.angular_bias),
            slip_scale=max(0.0, float(self.adapter.slip_scale)),
        )

    def _sample_goal(self) -> Tuple[float, float]:
        angle = self.rng.uniform(-math.pi, math.pi)
        radius = self.rng.uniform(*self.goal_distance)
        return radius * math.cos(angle), radius * math.sin(angle)

    def _sample_obstacles(self, goal: Tuple[float, float]) -> list[Tuple[float, float, float]]:
        if self.obstacle_count <= 0:
            return []
        bound = self.workspace_bound if self.workspace_bound is not None else max(self.goal_distance[1] + 0.5, 2.0)
        radius = self.obstacle_radius
        obstacles: list[Tuple[float, float, float]] = []
        # Rejection sampling keeps the origin and goal corridor clear enough
        # for the fallback trainer to produce useful episodes while remaining
        # deterministic under the environment RNG.
        for _ in range(max(50, self.obstacle_count * 40)):
            if len(obstacles) >= self.obstacle_count:
                break
            x = self.rng.uniform(-bound + radius, bound - radius)
            y = self.rng.uniform(-bound + radius, bound - radius)
            if math.hypot(x, y) < radius * 2.5:
                continue
            if math.hypot(x - goal[0], y - goal[1]) < radius * 2.0:
                continue
            if any(math.hypot(x - ox, y - oy) < radius * 2.1 for ox, oy, _ in obstacles):
                continue
            obstacles.append((x, y, radius))
        return obstacles

    def _reset_episode_state(self) -> None:
        gx, gy = self._sample_goal()
        self.obstacles = self._sample_obstacles((gx, gy))
        yaw = self.rng.uniform(-math.pi, math.pi)
        self.state = [0.0, 0.0, yaw, gx, gy, 0.0, 0.0]
        self.odom = [0.0, 0.0, yaw]
        self.t = 0
        self._actuator_v = 0.0
        self._actuator_w = 0.0
        self._pending_actions.clear()
        self._pending_actions.extend([(0.0, 0.0)] * self.domain.latency_steps)
        self._queue_latency = self.domain.latency_steps
        self._last_command = (0.0, 0.0)
        self._last_obs = [0.0] * self.adapter.observation_size
        self._obs_initialized = False
        self._episode_return = 0.0
        self._episode_distance = math.hypot(gx, gy)
        self._episode_path_length = 0.0
        self._episode_success = False
        self._episode_collision = False
        self._episode_truncated = False
        self._episode_done = False
        self._imu_gyro = self.domain.angular_bias + self.rng.gauss(0.0, self.domain.gyro_noise_std)
        self._sensor_odom = tuple(self.odom)
        self._last_sensor_odom = self._sensor_odom

    def reset(self, seed: Optional[int] = None):
        """Start an episode and return ``(observation, info)``."""

        if seed is not None:
            self.seed = int(seed)
            self.rng.seed(self.seed)
        self.episode_id += 1
        self.domain = (
            sample_domain_parameters(self.rng, True, self.randomization_spec)
            if self.domain_randomization
            else self._nominal_domain()
        )
        self.randomization = self.domain.as_dict()
        self._reset_episode_state()
        obs = self._observe(fresh=True)
        return obs, self._reset_info()

    def _reset_info(self) -> Dict[str, Any]:
        return {
            "adapter": "originbot-differential-drive",
            "simulated": True,
            "episodeId": self.episode_id,
            "controlPeriodSeconds": float(self.adapter.dt),
            "controlHz": round(1.0 / float(self.adapter.dt), 6),
            "domainRandomization": dict(self.randomization),
            "observationLayout": "originbot-imu-odom-v1",
            "actionLayout": "originbot-twist-v1",
            "sensorModel": {
                "odom": "slip-blind-integrated",
                "imu": "gyro-with-noise-and-bias",
                "frameDropout": self.domain.odom_dropout_prob,
            },
            "obstacles": [
                {"x": float(x), "y": float(y), "radius": float(radius)}
                for x, y, radius in self.obstacles
            ],
        }

    def _delayed_command(self, command: Tuple[float, float]) -> Tuple[float, float]:
        latency = max(0, int(self.domain.latency_steps))
        if latency == 0:
            self._queue_latency = 0
            return command
        if self._queue_latency != latency:
            self._pending_actions.clear()
            self._pending_actions.extend([(0.0, 0.0)] * latency)
            self._queue_latency = latency
        self._pending_actions.append(command)
        # The queue is seeded with N zeros at reset: command k is applied at
        # step k+N, matching the board's command transport latency.
        return self._pending_actions.popleft()

    def _observe(self, fresh: bool = False) -> list:
        x, y, yaw = self.odom
        if fresh or not self._obs_initialized:
            # Draw noise before deciding dropout so seeded runs preserve a
            # stable random stream even when a frame is stale.
            noisy_x = x + self.rng.gauss(0.0, self.domain.odom_noise_std)
            noisy_y = y + self.rng.gauss(0.0, self.domain.odom_noise_std)
            noisy_yaw = yaw
            self._sensor_odom = (noisy_x, noisy_y, noisy_yaw)
            measured_w = self._imu_gyro
            obs = self.adapter.observation(
                self.state,
                pose=(noisy_x, noisy_y, noisy_yaw),
                velocity=(self._actuator_v, measured_w),
            )
            if self._obs_initialized and self.rng.random() < self.domain.odom_dropout_prob:
                obs = list(self._last_obs)
                self._sensor_odom = self._last_sensor_odom
            else:
                self._last_sensor_odom = self._sensor_odom
            self._last_obs = list(obs)
            self._obs_initialized = True
            return list(obs)
        return list(self._last_obs)

    def _episode_metrics(self, terminal: bool = False) -> Dict[str, Any]:
        gx, gy = self.state[3], self.state[4]
        distance = math.hypot(gx - self.state[0], gy - self.state[1])
        metrics = {
            "episodeId": self.episode_id,
            "steps": int(self.t),
            "return": float(self._episode_return),
            "goalDistance": float(distance),
            "initialGoalDistance": float(self._episode_distance),
            "pathLength": float(self._episode_path_length),
            "success": bool(self._episode_success),
            "collision": bool(self._episode_collision),
            "truncated": bool(self._episode_truncated),
            "controlPeriodSeconds": float(self.adapter.dt),
            "controlHz": round(1.0 / float(self.adapter.dt), 6),
            "controlLatencySteps": int(self.domain.latency_steps),
            "domainRandomization": dict(self.randomization),
        }
        if terminal:
            metrics["terminal"] = True
        return metrics

    def episode_metrics(self) -> Dict[str, Any]:
        """Return a snapshot suitable for an eval report or telemetry row."""

        return self._episode_metrics()

    def observe(self) -> list:
        """Return one sensor observation using the current episode model."""

        return self._observe(fresh=True)

    def step(self, action: Sequence[float]):
        """Advance one control period using Gymnasium-style return values."""

        if self._episode_done:
            info = {"episode": self._episode_metrics(terminal=True), "alreadyDone": True}
            return list(self._last_obs), 0.0, self._episode_success or self._episode_collision, self._episode_truncated, info

        raw_command = self.adapter.clip_command(action)
        applied_command = self._delayed_command(raw_command)
        self._last_command = applied_command
        target_v = applied_command[0] * self.domain.motor_gain
        target_w = applied_command[1] * self.domain.motor_gain
        alpha = 1.0
        if self.domain.lag_tau_seconds > 0.0:
            alpha = min(1.0, self.adapter.dt / (self.domain.lag_tau_seconds + self.adapter.dt))
        self._actuator_v += alpha * (target_v - self._actuator_v)
        self._actuator_w += alpha * (target_w - self._actuator_w)

        x, y, yaw, gx, gy, _, _ = self.state
        # True pose includes wheel slip and an unmodelled angular bias.
        true_w = self._actuator_w + self.domain.angular_bias
        self._imu_gyro = true_w + self.rng.gauss(0.0, self.domain.gyro_noise_std)
        new_yaw = _wrap_angle(yaw + true_w * self.adapter.dt)
        distance_moved = self._actuator_v * self.domain.slip_scale * self.adapter.dt
        new_x = x + distance_moved * math.cos(new_yaw)
        new_y = y + distance_moved * math.sin(new_yaw)
        self.state = [new_x, new_y, new_yaw, gx, gy, self._actuator_v, true_w]
        self._episode_path_length += abs(distance_moved)

        # Odometry integrates wheel-reported velocity and is blind to slip and
        # angular bias, just like the real diff-drive estimator.
        odom_x, odom_y, odom_yaw = self.odom
        odom_yaw = _wrap_angle(odom_yaw + self._actuator_w * self.adapter.dt)
        odom_x += self._actuator_v * math.cos(odom_yaw) * self.adapter.dt
        odom_y += self._actuator_v * math.sin(odom_yaw) * self.adapter.dt
        self.odom = [odom_x, odom_y, odom_yaw]
        self.t += 1

        distance = math.hypot(gx - new_x, gy - new_y)
        previous_distance = math.hypot(gx - x, gy - y)
        success = distance <= self.goal_tolerance
        collision = False
        if self.workspace_bound is not None:
            collision = abs(new_x) > self.workspace_bound or abs(new_y) > self.workspace_bound
        if not collision and self.obstacles:
            collision = any(
                math.hypot(new_x - ox, new_y - oy) <= radius
                for ox, oy, radius in self.obstacles
            )
        terminated = bool(success or collision)
        truncated = bool(self.t >= self.horizon and not terminated)
        reward = previous_distance - distance
        reward -= 0.01 * (
            abs(raw_command[0]) / max(self.adapter.max_linear, 1e-9)
            + abs(raw_command[1]) / max(self.adapter.max_angular, 1e-9)
        ) / 2.0
        if success:
            reward += 5.0
        if collision:
            reward -= 5.0
        self._episode_return += reward
        self._episode_success = bool(success)
        self._episode_collision = bool(collision)
        self._episode_truncated = bool(truncated)
        self._episode_done = bool(terminated or truncated)
        obs = self._observe(fresh=True)
        info: Dict[str, Any] = {
            "distance": float(distance),
            "success": bool(success),
            "collision": bool(collision),
            "terminated": terminated,
            "truncated": truncated,
            "cmd_vel": {"linear": float(raw_command[0]), "angular": float(raw_command[1])},
            "applied_cmd_vel": {"linear": float(applied_command[0]), "angular": float(applied_command[1])},
            "actuator": {"linear": float(self._actuator_v), "angular": float(self._actuator_w)},
            "odom": {"x": float(odom_x), "y": float(odom_y), "yaw": float(odom_yaw)},
            "odomMeasured": {"x": float(self._sensor_odom[0]), "y": float(self._sensor_odom[1]), "yaw": float(self._sensor_odom[2])},
            "imu": {"yaw": float(new_yaw), "gyroZ": float(self._imu_gyro)},
            "obstacles": [
                {"x": float(x), "y": float(y), "radius": float(radius)}
                for x, y, radius in self.obstacles
            ],
            "episode": self._episode_metrics(terminal=terminated or truncated),
        }
        return obs, float(reward), terminated, truncated, info


if __name__ == "__main__":
    env = RDKRobotEnv(seed=1, domain_randomization=True)
    obs, info = env.reset(seed=1)
    print("reset", info)
    for _ in range(3):
        obs, reward, done, truncated, step_info = env.step([0.1, 0.0])
        print(obs, reward, done, truncated, step_info["episode"])
