import contextlib
import io
import unittest

from adapter import environment_for_contract
from dance_env import ConfigurableChoreography
from dance_env_v2 import ExplicitAlternationChoreography


class ContractVersionTests(unittest.TestCase):
    def test_old_models_keep_their_original_observation_semantics(self):
        self.assertIs(environment_for_contract({'id': 'custom-policy-originman-dance-v1'}), ConfigurableChoreography)

    def test_v2_models_explicitly_select_alternation_phase(self):
        self.assertIs(environment_for_contract({'id': 'custom-policy-originman-dance-v2'}), ExplicitAlternationChoreography)

    def test_unknown_or_missing_versions_do_not_silently_use_v1(self):
        for contract in ({}, {'id': 'custom-policy-originman-dance-v99'}):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                environment_for_contract(contract)
