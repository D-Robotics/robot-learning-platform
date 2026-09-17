#!/usr/bin/env python3
"""Parity guard for the vendored quality gate.

`evaluate_quality_gate` intentionally exists twice: once in
`engines/starter-ppo/runner.py` and once in `engines/mjx-adapter/adapter.py`. The
copy is deliberate — the starter module hard-requires torch at import time while
the MJX true path must run on a jax-only deployment — but a duplicated verdict
function is exactly the kind of thing that drifts silently: the two adapters
would then disagree about whether the same run passes, depending on which one
produced it, and nothing would say so.

This test is the thing that says so. It compares the two implementations after
AST normalization (so formatting and comments cannot hide a divergence) and
fails on any difference.

It also fixes the criteria the gate understands, so adding a criterion to one
copy without the other cannot pass, and pins the fail-closed behaviours that
matter most: a missing metric never passes, and the newer criteria refuse rather
than pass when their evidence is absent.
"""

import ast
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STARTER = os.path.join(ROOT, "engines", "starter-ppo", "runner.py")
MJX = os.path.join(ROOT, "engines", "mjx-adapter", "adapter.py")
FUNCTION = "evaluate_quality_gate"


def _function_node(path, name):
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError("{} not found in {}".format(name, path))


def _normalized_dump(node):
    """AST dump with line/column data stripped, so only structure is compared."""
    clone = ast.fix_missing_locations(node)
    for item in ast.walk(clone):
        for attribute in ("lineno", "col_offset", "end_lineno", "end_col_offset"):
            if hasattr(item, attribute):
                setattr(item, attribute, 0)
    return ast.dump(clone)


class QualityGateParityContract(unittest.TestCase):
    def test_vendored_copy_matches_the_starter_implementation(self):
        starter = _function_node(STARTER, FUNCTION)
        vendored = _function_node(MJX, FUNCTION)
        self.assertEqual(
            _normalized_dump(starter),
            _normalized_dump(vendored),
            "{} has drifted between engines/starter-ppo/runner.py and "
            "engines/mjx-adapter/adapter.py; the two adapters would now disagree "
            "about the same run. Update both together.".format(FUNCTION),
        )

    def test_both_copies_accept_a_baseline_argument(self):
        for path in (STARTER, MJX):
            node = _function_node(path, FUNCTION)
            args = [argument.arg for argument in node.args.args]
            self.assertEqual(
                args,
                ["report", "quality_gate", "baseline"],
                "{} must take (report, quality_gate, baseline) in {}".format(FUNCTION, path),
            )
            # A default keeps the historical two-argument call sites working.
            self.assertEqual(len(node.args.defaults), 1, path)


class QualityGateFailClosedContract(unittest.TestCase):
    """Behavioural checks on the starter implementation, which the copy mirrors."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.join(ROOT, "engines"))
        from starter_ppo_loader import load_starter_engine  # noqa: PLC0415

        cls.starter = load_starter_engine()

    def _gate(self, report, quality_gate, baseline=None):
        return self.starter.evaluate_quality_gate(report, quality_gate, baseline)

    def test_missing_metric_never_passes(self):
        gate = self._gate({"envelopes": {"nominal": {}}}, {"minSuccessRate": 0.7})
        self.assertFalse(gate["passed"])
        self.assertTrue(any("missing" in error for error in gate["errors"]))

    def test_ci_lower_bound_is_the_judged_value(self):
        report = {
            "envelopes": {
                "nominal": {"successRate": 0.80, "successRateCiLow": 0.60, "collisionRate": 0.0}
            }
        }
        gate = self._gate(report, {"minSuccessRate": 0.7, "gateOn": "ciLowerBound"})
        self.assertFalse(gate["passed"])

    def test_action_smoothness_ceiling_refuses_a_chattering_policy(self):
        report = {"envelopes": {"nominal": {"successRate": 1.0, "collisionRate": 0.0, "actionChangeRms": 0.9}}}
        gate = self._gate(report, {"maxActionChangeRms": 0.5})
        self.assertFalse(gate["passed"])
        self.assertTrue(any("actionChangeRms" in error for error in gate["errors"]))
        # The figure it judged on is reported, so the refusal is auditable.
        self.assertEqual(gate["measured"]["actionChangeRms"], 0.9)

    def test_action_smoothness_ceiling_fails_closed_without_the_metric(self):
        report = {"envelopes": {"nominal": {"successRate": 1.0, "collisionRate": 0.0}}}
        gate = self._gate(report, {"maxActionChangeRms": 0.5})
        self.assertFalse(gate["passed"])
        self.assertTrue(any("actionChangeRms missing" in error for error in gate["errors"]))

    def test_ablation_refuses_a_policy_that_did_not_beat_the_baseline(self):
        trained = {"envelopes": {"nominal": {"successRate": 0.42, "collisionRate": 0.0}}}
        baseline = {"envelopes": {"nominal": {"successRate": 0.41}}}
        gate = self._gate(trained, {"ablation": {"minSuccessRateDelta": 0.2}}, baseline)
        self.assertFalse(gate["passed"])
        self.assertTrue(any("ablation" in error for error in gate["errors"]))

    def test_ablation_accepts_a_policy_that_clearly_beat_the_baseline(self):
        trained = {"envelopes": {"nominal": {"successRate": 0.95, "collisionRate": 0.0}}}
        baseline = {"envelopes": {"nominal": {"successRate": 0.02}}}
        gate = self._gate(trained, {"ablation": {"minSuccessRateDelta": 0.2}}, baseline)
        self.assertTrue(gate["passed"], gate["errors"])
        self.assertEqual(gate["measured"]["baselineSuccessRate"], 0.02)

    def test_ablation_can_demand_that_the_comparison_exist(self):
        trained = {"envelopes": {"nominal": {"successRate": 0.95, "collisionRate": 0.0}}}
        gate = self._gate(trained, {"ablation": {"requireBaseline": True}}, None)
        self.assertFalse(gate["passed"])
        self.assertTrue(any("requires a baseline" in error for error in gate["errors"]))

    def test_an_unmeasured_comparison_is_not_a_pass(self):
        """"We could not measure it" must not be readable as "it passed"."""
        trained = {"envelopes": {"nominal": {"successRate": 0.95, "collisionRate": 0.0}}}
        gate = self._gate(trained, {"ablation": {"minSuccessRateDelta": 0.2}}, None)
        self.assertFalse(gate["passed"])
        self.assertTrue(any("baseline successRate missing" in error for error in gate["errors"]))

    def test_declared_criteria_are_echoed_into_the_report(self):
        report = {"envelopes": {"nominal": {"successRate": 1.0, "collisionRate": 0.0, "actionChangeRms": 0.1}}}
        gate = self._gate(
            report,
            {"maxActionChangeRms": 0.5, "ablation": {"minSuccessRateDelta": 0.1}},
            {"envelopes": {"nominal": {"successRate": 0.0}}},
        )
        self.assertIn("maxActionChangeRms", gate["criteria"])
        self.assertIn("ablation", gate["criteria"])
        self.assertEqual(gate["criteria"]["ablation"], {"minSuccessRateDelta": 0.1})


if __name__ == "__main__":
    unittest.main(verbosity=2)
