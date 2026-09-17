#!/usr/bin/env python3
"""Reward vocabulary evaluation, shared by every engine.

`scripts/reward-vocabulary.mjs` owns the *vocabulary* (which terms exist, which
op pays how, which engine can measure what). This module owns the *arithmetic*
in Python, and it deliberately keeps the historical fixed-key formula as
`historical_reward` so the equivalence between them is a test rather than a
claim: `tests/test_reward_expansion_parity.py` runs both over the same feature
trajectories and requires them to agree.

Keeping one implementation is the point. Before this, `starter-ppo` and
`mjx-adapter` each had their own copy of the reward expression, and they already
disagreed about a missing key (KeyError versus a silent zero).
"""

import numpy as np


# The legacy five-key formula, preserved verbatim as the reference the vocabulary
# expansion must reproduce. Do not "simplify" this against the new evaluator: its
# only job is to be the thing equivalence is measured against.
def historical_reward(reward_cfg, *, prev_distance, distance, action, success, collided,
                      goal_eps, fall_penalty=None, fallen=False):
    # `.get` with a zero default so a caller can compare one term at a time; the
    # fitted values are what the parity test supplies, not the key set.
    reward = (
        reward_cfg.get("progress", 0.0) * (prev_distance - distance)
        + reward_cfg.get("actionPenalty", 0.0) * action
        + (reward_cfg.get("goal", 0.0) if success else 0.0)
        + (reward_cfg.get("collision", 0.0) if collided else 0.0)
    )
    if "dwell" in reward_cfg and distance < goal_eps * 1.5:
        reward += reward_cfg["dwell"]
    if fall_penalty is not None and fallen:
        reward -= fall_penalty
    return reward


# Default slew for `rate_limit`: the payment is released over a horizon rather
# than in one step, which is what removes the jackpot. The value is expressed as
# the target's per-step approach rate.
RATE_LIMIT_SLEW = 0.1


class RewardTracker:
    """Per-environment state the vocabulary evaluator needs.

    Only the rate-limited terms carry state (their slewed target). It lives here
    rather than in each engine so both engines cannot implement it differently.
    """

    __slots__ = ("rate_targets",)

    def __init__(self):
        self.rate_targets = {}

    def reset(self, env_indices=None):
        if env_indices is None:
            self.rate_targets.clear()
            return
        for name in self.rate_targets:
            for index in env_indices:
                self.rate_targets[name].pop(index, None)


def evaluate_formula(formula, features, *, previous=None, tracker=None, env_index=0, iteration=0):
    """Total reward for one environment, from a validated vocabulary formula.

    `features` maps a term name to the value measured *this* step; `previous`
    maps the same names to the value measured last step. Terms absent from the
    mapping contribute nothing -- the pack validator already refused terms the
    engine cannot measure, so an absence here means "not measured this step"
    (a missing sensor sample), never "this term was never implemented".

    Returns `(reward, contributions)` where `contributions` maps term name to its
    signed contribution, which is what makes a reward accountable per term
    (`Episode_Reward/<term>`-style reporting).
    """
    previous = previous or {}
    contributions = {}
    total = 0.0

    for entry in formula:
        op = entry["op"]
        name = entry["term"]
        weight = entry["weight"]
        value = features.get(name)
        if value is None:
            continue

        if op in ("potential", "shaping"):
            before = previous.get(name)
            if before is None:
                # Improvement is undefined without a previous measurement, so
                # nothing is paid. Paying the raw value instead would turn the
                # first step into a bonus and reintroduce the farmable pattern
                # this op exists to avoid.
                continue
            # The term declares which direction is progress. `progress` is a
            # distance and improves by falling; `proximity` improves by rising.
            # Applying one direction to both pays the policy for walking away.
            delta = float(value) - float(before)
            direction = entry.get("improves")
            if direction not in ("rises", "falls"):
                # Refuse rather than assume. A default here silently inverts the
                # term when the field is missing, which pays the policy for
                # moving away from the goal -- a bug that trains happily.
                raise ValueError(
                    "reward term %r has no declared improvement direction" % (name,)
                )
            contribution = weight * (delta if direction == "rises" else -delta)
        elif op == "penalty":
            contribution = -weight * abs(float(value))
        elif op == "bonus":
            contribution = weight * float(value)
        elif op == "smoothness":
            before = previous.get(name)
            if before is None:
                continue
            if "curriculum" in entry and iteration < entry["curriculum"]["introduceAfterIteration"]:
                continue
            contribution = -weight * (float(value) - float(before)) ** 2
        elif op == "rate_limit":
            if tracker is None:
                raise ValueError("rate_limit requires a RewardTracker")
            targets = tracker.rate_targets.setdefault(name, {})
            current = float(targets.get(env_index, 0.0))
            # Approach the raw value, but never faster than the slew. Payment is
            # the increase of the slewed target, so a sudden jump pays over a
            # horizon instead of in one step: arriving early buys nothing, which
            # is what makes `slow` the argmax and removes the jackpot.
            target = min(float(value), current + RATE_LIMIT_SLEW)
            targets[env_index] = target
            contribution = weight * (target - current)
        else:  # pragma: no cover - the JS validator owns the closed op set
            raise ValueError("unknown reward op %r" % (op,))

        contributions[name] = contributions.get(name, 0.0) + contribution
        total += contribution
    return total, contributions


# ---------------------------------------------------------------------------
# Vectorised evaluation.
#
# `starter-ppo` steps thousands of environments per control step, so a per-env
# Python loop would dominate the training step. This mirrors the scalar
# semantics exactly (asserted by tests/test_reward_expansion_parity.py) because a
# second, faster-but-different implementation is how the two engines drifted
# apart in the first place.
# ---------------------------------------------------------------------------


class VectorRewardTracker:
    """Per-environment rate-limit state for the vectorised evaluator."""

    __slots__ = ("rate_targets", "_dtype")

    def __init__(self, num_envs=0, dtype=None):
        self.rate_targets = {}
        self._dtype = dtype or np.float32

    def target(self, name, num_envs):
        current = self.rate_targets.get(name)
        if current is None or current.shape[0] != num_envs:
            current = np.zeros(num_envs, dtype=self._dtype)
            self.rate_targets[name] = current
        return current

    def reset(self, indices=None):
        """Clear the slewed targets for reset environments.

        A rate-limited payment is per episode: an auto-reset episode must start
        with nothing released, or the next episode would inherit the previous
        one's slew position and could collect the bonus twice.
        """
        if indices is None:
            for name, current in self.rate_targets.items():
                self.rate_targets[name] = np.zeros_like(current)
            return
        for name, current in self.rate_targets.items():
            current[indices] = 0.0


def evaluate_formula_vector(formula, features, *, previous=None, tracker=None, iteration=0,
                            num_envs=None):
    """Vectorised reward. `features` maps term name to an `(num_envs,)` array.

    `previous` supplies last step's value for shaping terms; a term absent from
    it contributes nothing, matching the scalar evaluator's refusal to pay
    improvement it cannot measure.
    """
    previous = previous or {}
    if num_envs is None:
        num_envs = 1
        for value in features.values():
            num_envs = int(np.asarray(value).reshape(-1).shape[0])
            break
    total = np.zeros(num_envs, dtype=np.float32)
    contributions = {}

    for entry in formula:
        op = entry["op"]
        name = entry["term"]
        weight = float(entry["weight"])
        raw = features.get(name)
        if raw is None:
            continue
        value = np.asarray(raw, dtype=np.float32).reshape(-1)

        if op in ("potential", "shaping"):
            before = previous.get(name)
            if before is None:
                continue
            delta = value - np.asarray(before, dtype=np.float32).reshape(-1)
            direction = entry.get("improves")
            if direction not in ("rises", "falls"):
                raise ValueError("reward term %r has no declared improvement direction" % (name,))
            contribution = weight * (delta if direction == "rises" else -delta)
        elif op == "penalty":
            contribution = -weight * np.abs(value)
        elif op == "bonus":
            contribution = weight * value
        elif op == "smoothness":
            before = previous.get(name)
            if before is None:
                continue
            if "curriculum" in entry and iteration < entry["curriculum"]["introduceAfterIteration"]:
                continue
            delta = value - np.asarray(before, dtype=np.float32).reshape(-1)
            contribution = -weight * delta * delta
        elif op == "rate_limit":
            if tracker is None:
                raise ValueError("rate_limit requires a VectorRewardTracker")
            current = tracker.target(name, num_envs)
            target = np.minimum(value, current + RATE_LIMIT_SLEW)
            contribution = weight * (target - current)
            tracker.rate_targets[name] = target
        else:  # pragma: no cover - the JS validator owns the closed op set
            raise ValueError("unknown reward op %r" % (op,))

        total += contribution.astype(np.float32)
        contributions[name] = contributions.get(name, np.zeros(num_envs, dtype=np.float32)) + contribution
    return total, contributions
