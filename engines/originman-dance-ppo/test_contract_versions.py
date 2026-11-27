import contextlib
import io
import math
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
import torch

from adapter import environment_for_contract
from body import physics_substeps
from choreography_reference import JOINT_NAMES, ReferenceControl
from dance_env import ConfigurableChoreography
from dance_env_v2 import ExplicitAlternationChoreography
from train import resolve_training_device, train


class ContractVersionTests(unittest.TestCase):
    def test_50hz_clock_uses_the_scene_timestep_and_preserves_untagged_replay(self):
        self.assertEqual(physics_substeps(0.002), 10)
        self.assertEqual(physics_substeps(0.001), 20)
        self.assertEqual(physics_substeps(0.002, legacy_timing=True), 20)
        with self.assertRaisesRegex(ValueError, 'does not divide'):
            physics_substeps(0.003)

    def test_reference_policy_export_uses_the_same_phase_and_joint_order_as_training(self):
        reference = ReferenceControl([
            {"type": "weight-shift", "beats": 8, "intensity": .5},
            {"type": "squat-rise", "beats": 8, "intensity": .6},
        ], JOINT_NAMES)
        observations = np.zeros((8, 78), dtype=np.float32)
        residuals = np.tile(np.linspace(-1.2, 1.2, 18, dtype=np.float32), (8, 1))
        for i, phase in enumerate((0., .24, .5, .99999) * 2):
            observations[i, 65 + i // 4] = 1.
            observations[i, 73:75] = [math.sin(math.tau * phase), math.cos(math.tau * phase)]
        expected = np.asarray([reference.command(obs, action) for obs, action in zip(observations, residuals)])
        exported = reference(torch.from_numpy(observations), torch.from_numpy(residuals)).detach().numpy()
        np.testing.assert_allclose(exported, expected, atol=2e-6)

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

        environment = Mock(names=[], observation_space=Mock(shape=(78,)), action_space=Mock(shape=(18,)),
                           model=Mock(opt=Mock(timestep=0.001)), substeps=20)
        with patch('train.SubprocVecEnv') as vector, patch('train.PPO', side_effect=StopBeforeLearning) as ppo:
            with self.assertRaises(StopBeforeLearning):
                train(bundle=Path('.'), output=Path('.'),
                      dance_config={'trainingSteps': 8192, 'seed': 7, 'bpm': 100}, num_envs=64,
                      environment_class=lambda *_args, **_kwargs: environment, device='cpu')
        self.assertEqual(len(vector.call_args.args[0]), 64)
        self.assertEqual(ppo.call_args.kwargs['n_steps'] * 64, 4096)
        vector.return_value.close.assert_called_once()
