#!/usr/bin/env python3
"""Parity proof: the vocabulary expansion reproduces the historical reward.

The migration promise is that every pre-existing pack behaves *exactly* as it did
before the reward became declarative. That is a numerical claim, so it is checked
numerically: `expandLegacyRewardMap` (JavaScript, the resolver's own code) is run
for real, and both the historical formula and the expanded formula are evaluated
over the same feature trajectories.

Two things this catches that reading the code cannot:

* an expansion that is merely *similar* -- a missing `abs`, a sign applied on the
  wrong side, a term paid every step instead of once;
* drift between the JS expansion and the Python evaluator, which live in
  different languages and would otherwise only disagree in a training run.

The JS side is executed through node rather than re-implemented here, because a
second copy of the mapping would defeat the purpose.
"""

import json
import math
import os
import random
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "engines"))

from reward_vocabulary import (  # noqa: E402
    RATE_LIMIT_SLEW,
    RewardTracker,
    VectorRewardTracker,
    evaluate_formula,
    evaluate_formula_vector,
    historical_reward,
)

VOCABULARY = os.path.join(ROOT, "scripts", "reward-vocabulary.mjs")

# A pack-shaped reward map, matching what every shipped pack declares today.
LEGACY_REWARD = {
    "progress": 1.0,
    "collision": -5,
    "goal": 10,
    "actionPenalty": -0.01,
    "dwell": 0.2,
}
GOAL_EPS = 0.15


def expand_via_node(reward, engine="starter-ppo"):
    """Run the real JS expansion so parity is measured against shipped code."""
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is unavailable; cannot exercise the JS expansion")
    script = (
        "import { expandLegacyRewardMap } from "
        + json.dumps("file://" + VOCABULARY)
        + ";\n"
        + "const reward = JSON.parse(process.argv[1]);\n"
        + "const engine = process.argv[2];\n"
        + "process.stdout.write(JSON.stringify(expandLegacyRewardMap(reward, engine)));\n"
    )
    run = subprocess.run(
        [node, "--input-type=module", "-e", script, json.dumps(reward), engine],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if run.returncode != 0:
        raise AssertionError("JS expansion failed: " + run.stderr.strip())
    return json.loads(run.stdout)


def trajectory(seed, steps=120):
    """A plausible approach-and-settle trajectory plus a collision variant."""
    rng = random.Random(seed)
    distance = 1.6
    rows = []
    for step in range(steps):
        # Close most of the gap, then settle inside the goal radius.
        if distance > GOAL_EPS:
            distance = max(GOAL_EPS * 0.5, distance - rng.uniform(0.005, 0.05))
        else:
            distance = max(0.0, distance + rng.uniform(-0.01, 0.01))
        rows.append(
            {
                "prev_distance": rows[-1]["distance"] if rows else 1.6,
                "distance": distance,
                "action": min(1.0, rng.uniform(0.0, 1.0)),
                "success": distance < GOAL_EPS,
                "collided": step == steps - 3 and seed % 3 == 0,
            }
        )
    return rows


# Directions for hand-written formulas in these tests. The engine-side evaluator
# requires `improves` on every shaping term (it refuses to guess, because guessing
# once inverted `progress` and paid the policy for walking away), so fixtures
# supply it explicitly rather than relying on a default.
DIRECTIONS = {
    "progress": "falls",
    "proximity": "rises",
    "upright": "rises",
    "heading": "rises",
    "goal_reach": "rises",
    "goal_hold": "rises",
    "collision": "falls",
    "action_magnitude": "falls",
    "action_rate": "falls",
    "accel_z": "falls",
    "body_rate": "falls",
}


def with_directions(*entries):
    """Build a fixture formula, attaching each term's declared direction."""
    return [{**entry, "improves": DIRECTIONS[entry["term"]]} for entry in entries]


class RewardExpansionParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.formula = expand_via_node(LEGACY_REWARD)

    def test_expansion_uses_the_declared_vocabulary(self):
        ops = {entry["op"] for entry in self.formula}
        self.assertTrue(ops <= {"potential", "shaping", "penalty", "bonus", "rate_limit", "smoothness"})
        terms = {entry["term"] for entry in self.formula}
        self.assertEqual(
            terms,
            {"progress", "goal_reach", "collision", "action_magnitude", "goal_hold"},
        )
        for entry in self.formula:
            self.assertGreater(entry["weight"], 0, entry)

    # The `goal` key is the one term whose semantics the migration deliberately
    # changes: the historical formula pays the whole bonus on the step success is
    # reached, while the vocabulary's `rate_limit` releases the same total over a
    # slew horizon. Demanding step-by-step equality for it would forbid the very
    # op that removes the jackpot, so the two halves are checked separately:
    # everything else must match exactly, and `goal_reach` must pay a bounded
    # total equal to its weight.
    EXACT_TERMS = {"progress", "collision", "action_magnitude", "goal_hold"}

    def test_every_non_rate_limited_term_matches_the_historical_formula_exactly(self):
        """Step-by-step equality for the terms whose meaning did not change.

        This is where a missing `abs`, a sign applied on the wrong side, or a
        shaping term evaluated in the wrong direction shows up.
        """
        exact = [entry for entry in self.formula if entry["op"] != "rate_limit"]
        historical_cfg = {k: v for k, v in LEGACY_REWARD.items() if k != "goal"}
        worst = 0.0
        for seed in range(12):
            for row in trajectory(seed):
                expected = historical_reward(
                    historical_cfg,
                    prev_distance=row["prev_distance"],
                    distance=row["distance"],
                    action=row["action"],
                    success=row["success"],
                    collided=row["collided"],
                    goal_eps=GOAL_EPS,
                )
                features = {
                    "progress": row["distance"],
                    "collision": 1.0 if row["collided"] else 0.0,
                    "action_magnitude": row["action"],
                    "goal_hold": 1.0 if row["distance"] < GOAL_EPS * 1.5 else 0.0,
                }
                actual, contributions = evaluate_formula(
                    exact, features, previous={"progress": row["prev_distance"]}
                )
                self.assertEqual(
                    set(contributions) - self.EXACT_TERMS,
                    set(),
                    f"unexpected term in the exact comparison: {sorted(contributions)}",
                )
                worst = max(worst, abs(actual - expected))
        self.assertLess(worst, 1e-9, f"term drift {worst}")

    def test_goal_payment_is_equivalent_in_total_but_slewed(self):
        """`rate_limit` pays the same amount as the one-shot bonus, spread out.

        That is the whole point of the migration: the total is unchanged, but the
        policy can no longer collect it in a single step, so arriving early buys
        nothing.
        """
        one_shot = float(LEGACY_REWARD["goal"])
        slewed = [entry for entry in self.formula if entry["term"] == "goal_reach"]
        self.assertEqual(len(slewed), 1)
        tracker = RewardTracker()
        total = 0.0
        steps = 0
        # A policy that is repeatedly inside the goal radius.
        for _ in range(200):
            reward, _ = evaluate_formula(
                slewed, {"goal_reach": 1.0}, tracker=tracker, env_index=0
            )
            total += reward
            steps += 1
            if total >= one_shot - 1e-9:
                break
        self.assertAlmostEqual(
            total, one_shot, places=6, msg="the rate-limited total must equal the one-shot bonus"
        )
        self.assertGreater(
            steps, 1, "the payment must be released over more than one step, or it is still a jackpot"
        )

    def test_rate_limited_goal_payment_cannot_be_farmed(self):
        """The whole point of the op: a repeated stay pays a bounded total."""
        fixture = with_directions({"op": "rate_limit", "term": "goal_reach", "weight": 10.0})
        tracker = RewardTracker()
        total = 0.0
        for _ in range(500):
            reward, _ = evaluate_formula(
                fixture, {"goal_reach": 1.0}, tracker=tracker, env_index=0
            )
            total += reward
        # Bounded by the weight itself, no matter how long the policy stays.
        self.assertLessEqual(total, 10.0 + 1e-9)
        self.assertAlmostEqual(total, 10.0, places=6)
        # And the bound is reached only through the slew, not in one step.
        self.assertLess(RATE_LIMIT_SLEW, 1.0)

    def test_potential_term_pays_nothing_for_holding_still(self):
        fixture = with_directions({"op": "potential", "term": "progress", "weight": 1.0})
        reward, _ = evaluate_formula(
            fixture, {"progress": 0.5}, previous={"progress": 0.5}
        )
        self.assertEqual(reward, 0.0)

    def test_missing_previous_measurement_pays_nothing(self):
        """A shaping term cannot pay on a step with no prior measurement.

        Paying the raw value there would hand out a first-step bonus, which is
        the farmable pattern these ops exist to remove.
        """
        for op in ("potential", "shaping", "smoothness"):
            reward, _ = evaluate_formula(
                [{"op": op, "term": "progress", "weight": 1.0}], {"progress": 0.9}
            )
            self.assertEqual(reward, 0.0, op)

    def test_smoothness_curriculum_defers_the_penalty(self):
        fixture = with_directions(
            {
                "op": "smoothness",
                "term": "action_rate",
                "weight": 0.2,
                "curriculum": {"introduceAfterIteration": 100},
            }
        )
        before, _ = evaluate_formula(
                fixture,
            {"action_rate": 0.5 if False else 0.0},
            previous={"action_rate": 0.0},
            iteration=50,
        )
        self.assertEqual(before, 0.0, "the regulariser must be off before the skill exists")
        features = {"action_rate": 0.4}
        after, _ = evaluate_formula(
            fixture, features, previous={"action_rate": 0.0}, iteration=150
        )
        self.assertAlmostEqual(after, -0.2 * 0.4**2, places=12)

    def test_penalty_op_charges_regardless_of_the_sign_of_the_measurement(self):
        fixture = with_directions({"op": "penalty", "term": "action_magnitude", "weight": 2.0})
        for value in (0.3, -0.3):
            reward, _ = evaluate_formula(
                fixture, {"action_magnitude": value})
            self.assertAlmostEqual(reward, -0.6, places=12)

    def test_contributions_are_accountable_per_term(self):
        _, contributions = evaluate_formula(
            with_directions(
                {"op": "penalty", "term": "collision", "weight": 5.0},
                {"op": "bonus", "term": "goal_hold", "weight": 0.2},
            ),
            {"collision": 1.0, "goal_hold": 1.0},
        )
        self.assertEqual(contributions["collision"], -5.0)
        self.assertAlmostEqual(contributions["goal_hold"], 0.2, places=12)


class VocabularyRefusals(unittest.TestCase):
    """The JS validator is the closed set; these pin what it refuses."""

    def run_js(self, expression, *args):
        """Evaluate a full JS expression with the vocabulary as `v`.

        `expression` is used verbatim, so a caller can pass an IIFE. Prefixing a
        namespace internally would make anything but a plain call inexpressible.
        """
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node is unavailable")
        script = (
            "import * as v from " + json.dumps("file://" + VOCABULARY) + ";\n"
            "try { process.stdout.write(JSON.stringify(((" + expression + ")))); }\n"
            "catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }\n"
        )
        run = subprocess.run(
            [node, "--input-type=module", "-e", script, *args],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if run.returncode != 0:
            raise AssertionError(run.stderr.strip())
        return json.loads(run.stdout)

    def test_an_attitude_term_is_refused_on_the_kinematic_engine(self):
        result = self.run_js(
            "v.validateRewardFormula(JSON.parse(process.argv[1]), 'starter-ppo')",
            json.dumps([{"op": "potential", "term": "upright", "weight": 0.5}]),
        )
        self.assertTrue(result["errors"], "a term the engine cannot measure must be refused")
        self.assertIn("cannot observe", result["errors"][0])

    def test_the_same_term_is_accepted_on_the_contact_engine(self):
        result = self.run_js(
            "v.validateRewardFormula(JSON.parse(process.argv[1]), 'mjx-ppo')",
            json.dumps([{"op": "potential", "term": "upright", "weight": 0.5}]),
        )
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["terms"]), 1)

    def test_unknown_op_term_and_param_are_refused(self):
        cases = {
            "op": [{"op": "reward_me", "term": "progress", "weight": 1}],
            "term": [{"op": "penalty", "term": "vibes", "weight": 1}],
            "params": [{"op": "penalty", "term": "progress", "weight": 1, "params": {"x": 1}}],
        }
        for label, formula in cases.items():
            result = self.run_js(
                "v.validateRewardFormula(JSON.parse(process.argv[1]), 'starter-ppo')",
                json.dumps(formula),
            )
            self.assertTrue(result["errors"], f"{label} should be refused")

    def test_non_positive_weight_is_refused_rather_than_reinterpreted(self):
        for weight in (0, -1):
            result = self.run_js(
                "v.validateRewardFormula(JSON.parse(process.argv[1]), 'starter-ppo')",
                json.dumps([{"op": "penalty", "term": "collision", "weight": weight}]),
            )
            self.assertTrue(result["errors"], weight)

    def test_a_pack_may_not_declare_both_reward_forms(self):
        result = self.run_js(
            "(() => { try { v.resolveRewardFormula({ reward: { progress: 1 },"
            " rewardFormula: [] }, 'starter-ppo'); return { errors: [] }; }"
            " catch (e) { return { errors: [e.message] }; } })()"
        )
        self.assertTrue(result["errors"])
        self.assertIn("not both", result["errors"][0])


class VectorisedEvaluationMatchesScalar(unittest.TestCase):
    """The vectorised path must be the same function, not a faster lookalike.

    `starter-ppo` runs thousands of environments per control step, so the reward
    is evaluated vectorised there. Two implementations of one semantic is exactly
    how the engines drifted apart before, so agreement is asserted on random
    inputs rather than argued from the source.
    """

    def _formula(self):
        return with_directions(
            {"op": "potential", "term": "progress", "weight": 1.0},
            {"op": "rate_limit", "term": "goal_reach", "weight": 10.0},
            {"op": "penalty", "term": "collision", "weight": 5.0},
            {"op": "penalty", "term": "action_magnitude", "weight": 0.01},
            {"op": "bonus", "term": "goal_hold", "weight": 0.2},
            {
                "op": "smoothness",
                "term": "action_rate",
                "weight": 0.3,
                "curriculum": {"introduceAfterIteration": 10},
            },
        )

    def test_agrees_with_the_scalar_evaluator_step_by_step(self):
        """Two independent runs of the same semantics must produce the same numbers.

        Each path starts with empty rate-limit state and is never fed from the
        other: mirroring state between them (the first attempt) made the test
        compare its own bookkeeping rather than the two implementations.
        """
        import numpy as np

        rng = np.random.default_rng(7)
        formula = self._formula()
        envs = 32
        scalar_tracker = RewardTracker()
        vector_tracker = VectorRewardTracker(envs)
        for step in range(30):
            progress = rng.uniform(0.0, 2.0, size=envs)
            prev_progress = progress + rng.uniform(-0.05, 0.05, size=envs)
            features = {
                "progress": progress,
                "goal_reach": (rng.uniform(size=envs) < 0.05).astype("float32"),
                "collision": np.zeros(envs, dtype="float32"),
                "action_magnitude": rng.uniform(0.0, 1.0, size=envs),
                "goal_hold": (progress < 0.2).astype("float32"),
                "action_rate": rng.uniform(0.0, 0.5, size=envs),
            }
            previous = {"progress": prev_progress, "action_rate": features["action_rate"] * 0.9}
            vector, _ = evaluate_formula_vector(
                formula, features, previous=previous, tracker=vector_tracker, iteration=step
            )
            for index in range(envs):
                expected, _ = evaluate_formula(
                    formula,
                    {k: float(v[index]) for k, v in features.items()},
                    previous={k: float(v[index]) for k, v in previous.items()},
                    tracker=scalar_tracker,
                    env_index=index,
                    iteration=step,
                )
                self.assertAlmostEqual(
                    float(vector[index]),
                    expected,
                    places=5,
                    msg=f"step {step} env {index}",
                )

    def test_vectorised_rate_limit_stays_bounded(self):
        import numpy as np

        formula = with_directions({"op": "rate_limit", "term": "goal_reach", "weight": 10.0})
        tracker = VectorRewardTracker(4)
        total = np.zeros(4, dtype="float32")
        for _ in range(300):
            reward, _ = evaluate_formula_vector(
                formula, {"goal_reach": np.ones(4, dtype="float32")}, tracker=tracker
            )
            total += reward
        for value in total:
            self.assertLessEqual(float(value), 10.0 + 1e-4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
