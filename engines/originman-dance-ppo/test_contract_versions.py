import contextlib
import io
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from adapter import environment_for_contract
from dance_env import ConfigurableChoreography
from dance_env_v2 import ExplicitAlternationChoreography
from train import resolve_training_device, train


class ContractVersionTests(unittest.TestCase):
    def test_old_models_keep_their_original_observation_semantics(self):
        self.assertIs(environment_for_contract({'id': 'custom-policy-originman-dance-v1'}), ConfigurableChoreography)

    def test_v2_models_explicitly_select_alternation_phase(self):
        self.assertIs(environment_for_contract({'id': 'custom-policy-originman-dance-v2'}), ExplicitAlternationChoreography)

    def test_unknown_or_missing_versions_do_not_silently_use_v1(self):
        for contract in ({}, {'id': 'custom-policy-originman-dance-v99'}):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                environment_for_contract(contract)

    def test_device_auto_prefers_cuda_and_falls_back_to_cpu(self):
        with patch('train.torch.cuda.is_available', return_value=True):
            self.assertEqual(resolve_training_device('auto'), 'cuda')
            self.assertEqual(resolve_training_device('cpu'), 'cpu')
        with patch('train.torch.cuda.is_available', return_value=False):
            self.assertEqual(resolve_training_device('auto'), 'cpu')
            with self.assertRaisesRegex(ValueError, 'CUDA was requested'):
                resolve_training_device('cuda')

    def test_quick_check_constructs_two_4096_step_rollouts_at_64_environments(self):
        class StopBeforeLearning(Exception):
            pass

        environment = Mock(names=[], observation_space=Mock(shape=(78,)), action_space=Mock(shape=(18,)))
        with patch('train.SubprocVecEnv') as vector, patch('train.PPO', side_effect=StopBeforeLearning) as ppo:
            with self.assertRaises(StopBeforeLearning):
                train(bundle=Path('.'), output=Path('.'),
                      dance_config={'trainingSteps': 8192, 'seed': 7}, num_envs=64,
                      environment_class=lambda *_args, **_kwargs: environment, device='cpu')
        self.assertEqual(len(vector.call_args.args[0]), 64)
        self.assertEqual(ppo.call_args.kwargs['n_steps'] * 64, 4096)
        vector.return_value.close.assert_called_once()
