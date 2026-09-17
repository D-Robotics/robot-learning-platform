#!/usr/bin/env python3
"""Reward-sign and layout invariants, as regression tests.

Each of these encodes a lesson that cost real debugging time in the reference
MicroDuck training repository (`AGENTS.md` there), generalised to this platform.
They are cheap pure checks, which is precisely why they belong in CI: the
expensive failures they prevent are discovered as a policy that trains happily
and then farms its own penalty term, or as a policy that runs while reading
shifted observation slots.

Why a test and not a convention: the reference repository's own note is that on
every run every `Episode_Reward/<penalty>` must be <= 0. That is a property of
the reward configuration, so it can be checked without training anything.
"""

import glob
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TASKS = os.path.join(ROOT, "tasks")
RUNNER = os.path.join(ROOT, "engines", "starter-ppo", "runner.py")
VOCAB = os.path.join(ROOT, "engines", "reward_vocabulary.py")

# Terms the engine adds to a reward with a negative meaning. Their configured
# weight must therefore be <= 0: the engine multiplies the weight by a
# non-negative magnitude, so a positive weight would pay the policy for the
# behaviour the term exists to punish.
PENALTY_TERMS = ("collision", "actionPenalty", "fallPenalty")
POSITIVE_TERMS = ("progress", "goal", "dwell")


def pack_files():
    return sorted(glob.glob(os.path.join(TASKS, "*.json")))


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


class RewardSignContract(unittest.TestCase):
    def test_penalty_weights_are_never_positive(self):
        """A positive weight on a penalty pays for the violation."""
        checked = 0
        for path in pack_files():
            pack = load(path)
            reward = pack.get("reward") or {}
            for term in PENALTY_TERMS:
                if term not in reward:
                    continue
                checked += 1
                value = reward[term]
                self.assertIsInstance(value, (int, float), (path, term))
                self.assertLessEqual(
                    value,
                    0,
                    f"{os.path.basename(path)}: reward.{term}={value} is a penalty but is "
                    "configured positive; the engine multiplies it by a non-negative "
                    "magnitude, so this pays the policy for the violation",
                )
        self.assertGreater(checked, 0, "no penalty terms found to check")

    def test_positive_weights_are_never_negative(self):
        """The mirror image: a negative weight on a bonus inverts it."""
        checked = 0
        for path in pack_files():
            pack = load(path)
            reward = pack.get("reward") or {}
            for term in POSITIVE_TERMS:
                if term not in reward:
                    continue
                checked += 1
                self.assertGreaterEqual(
                    reward[term],
                    0,
                    f"{os.path.basename(path)}: reward.{term}={reward[term]} is a bonus but is "
                    "configured negative",
                )
        self.assertGreater(checked, 0, "no positive terms found to check")

    def test_engine_multiplies_penalty_weights_by_non_negative_magnitudes(self):
        """The convention above is only safe if the engine keeps these magnitudes.

        The runner now evaluates a validated reward vocabulary, so the
        multiplication the packs rely on lives in the shared evaluator
        (`engines/reward_vocabulary.py`): every `penalty` op must pay
        `-weight * abs(magnitude)` and every `smoothness` op must pay
        `-weight * squared-delta`, so the weight's sign cannot be inverted by a
        signed magnitude. A future edit that made either magnitude signed would
        let a negative weight reward the behaviour it exists to punish.
        """
        with open(VOCAB, encoding="utf-8") as handle:
            source = handle.read()
        self.assertIn(
            "contribution = -weight * abs(float(value))",
            source,
            "the scalar `penalty` op must multiply its weight by a non-negative "
            "magnitude (abs), or a negative weight starts paying for violations",
        )
        self.assertIn(
            "contribution = -weight * np.abs(value)",
            source,
            "the vectorised `penalty` op must mirror the scalar `-weight * abs` shape",
        )
        self.assertIn(
            "contribution = -weight * (float(value) - float(before)) ** 2",
            source,
            "the scalar `smoothness` op must pay a squared (non-negative) magnitude",
        )
        self.assertIn(
            "contribution = -weight * delta * delta",
            source,
            "the vectorised `smoothness` op must mirror the scalar squared-delta shape",
        )
        # `historical_reward` is the frozen reference the vocabulary expansion is
        # measured against (tests/test_reward_expansion_parity.py), so its action
        # and collision terms keep the legacy non-negative-magnitude shapes.
        self.assertIn(
            "reward_cfg.get(\"actionPenalty\", 0.0) * action",
            source,
            "the frozen historical reference must keep the action-penalty shape",
        )
        self.assertIn(
            '(reward_cfg.get("collision", 0.0) if collided else 0.0)',
            source,
            "the frozen historical reference must keep the collision-constant shape",
        )

    def test_no_pack_pays_a_repeating_bonus_that_outlives_the_episode(self):
        """A per-step bonus inside a terminal region is only safe if it ends there.

        The goal-navigation reward pays a `dwell` bonus every step inside the goal
        radius. That is a deliberate dense gradient for settling, and it cannot
        become a jackpot only because reaching the goal also terminates the
        episode. Assert that coupling so a future change cannot leave the bonus
        paying forever. (The termination is now one vectorised disjunction; the
        pin moved with it.)
        """
        with open(RUNNER, encoding="utf-8") as handle:
            source = handle.read()
        self.assertRegex(
            source,
            re.compile(r"done = success \| collision_now \| out_of_bound", re.S),
            "success must terminate the episode, or the dwell bonus pays indefinitely",
        )
        # And the vectorised evaluator must keep paying a `bonus` op as
        # `weight * value`, so the dwell bonus cannot silently flip sign.
        with open(VOCAB, encoding="utf-8") as handle:
            vocabulary = handle.read()
        self.assertIn(
            "contribution = weight * value",
            vocabulary,
            "the vectorised `bonus` op must pay weight times the measured feature",
        )


class ObservationLayoutContract(unittest.TestCase):
    """The 61D slot order is the hot-swap contract across the whole policy family.

    These read the real declaration out of `shared/sim2real.ts` instead of
    restating it: a test that spells the expected layout out and then asserts it
    equals itself proves nothing, which is the mistake this class originally
    made. Parsing source text is not elegant, but it is a real check, and it is
    what fails when someone reorders, renames or resizes a slot.
    """

    TS = os.path.join(ROOT, "shared", "sim2real.ts")
    EXPECTED = [
        ("gyro", 3),
        ("projected_gravity", 3),
        ("joint_position_error", 14),
        ("joint_velocity", 14),
        ("last_action", 14),
        ("command", 13),
    ]

    @classmethod
    def declared_layout(cls):
        with open(cls.TS, encoding="utf-8") as handle:
            source = handle.read()
        block = re.search(
            r"MICRODUCK_OBSERVATION_LAYOUT[^=]*=\s*Object\.freeze\(\s*\[(.*?)\]",
            source,
            re.S,
        )
        if block is None:
            # Fall back to the plain literal form so the test reports the real
            # problem (a reshaped declaration) rather than a parse failure.
            block = re.search(r"MICRODUCK_OBSERVATION_LAYOUT[^=]*=\s*\[(.*?)\]", source, re.S)
        assert block is not None, "MICRODUCK_OBSERVATION_LAYOUT not found in shared/sim2real.ts"
        return [(m.group(1), int(m.group(2))) for m in re.finditer(r"name:\s*'([a-z_]+)',\s*size:\s*(\d+)", block.group(1))]

    def test_declared_layout_matches_the_shared_contract(self):
        layout = self.declared_layout()
        self.assertEqual(
            layout,
            self.EXPECTED,
            "the 61D slot order is shared by every policy in the family; reordering, "
            "renaming or resizing a slot silently rebinds existing policies",
        )

    def test_declared_layout_sums_to_the_contract_size(self):
        layout = self.declared_layout()
        self.assertEqual(sum(size for _, size in layout), 61)
        names = [name for name, _ in layout]
        self.assertEqual(len(names), len(set(names)), "duplicate slot name")

    def test_layout_is_frozen_at_runtime_not_only_as_const(self):
        """`as const` is compile-time only; a runtime mutation would rebind consumers."""
        with open(self.TS, encoding="utf-8") as handle:
            source = handle.read()
        self.assertRegex(
            source,
            re.compile(r"MICRODUCK_OBSERVATION_LAYOUT[^=]*=\s*Object\.freeze\("),
            "the layout must be frozen at runtime: it is the contract every policy in "
            "the family is hot-swappable against",
        )

    def test_slot_ranges_derive_from_order(self):
        """Consumers need name -> index, and declaration order is the only source.

        Slot ranges are positional, so the derivation is checked here (against the
        real declaration) rather than assumed independently by each consumer.
        """
        offset = 0
        ranges = {}
        for name, size in self.declared_layout():
            ranges[name] = (offset, offset + size - 1)
            offset += size
        self.assertEqual(ranges["gyro"], (0, 2))
        self.assertEqual(ranges["command"], (48, 60))
        self.assertEqual(offset, 61)


if __name__ == "__main__":
    unittest.main(verbosity=2)
