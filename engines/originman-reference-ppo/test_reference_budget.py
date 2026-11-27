import importlib.util
from pathlib import Path

import numpy as np
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "originman_reference_worker", Path(__file__).with_name("adapter.py"),
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class TestReferenceBudget(unittest.TestCase):
    def test_observation_contracts_keep_distinct_layouts(self):
        env = worker.ReferenceTracking.__new__(worker.ReferenceTracking)
        env.tick = 0
        env.bpm = 100
        env.robot = SimpleNamespace(orientation=lambda: (np.eye(3), 0))
        env.qpos = env.qvel = np.arange(18)
        env.neutral = np.full(18, .1)
        env.data = SimpleNamespace(qpos=np.full(18, .3), qvel=np.full(18, 2.), sensordata=np.ones(3))
        env.target = np.full((50, 18), .4)
        env.target_vel = np.full((50, 18), 4.)
        env.previous = np.full(18, .5)

        env.motion_contract = True
        observation = env.observe()
        self.assertEqual(observation.shape, (78,))
        np.testing.assert_allclose(observation[0:11], [0, 0, 1, .25, .25, .25, 0, 1, 0, 1, -1])
        np.testing.assert_allclose(observation[11:29], .4)
        np.testing.assert_allclose(observation[29:47], .2)
        np.testing.assert_allclose(observation[47:65], .8)
        np.testing.assert_array_equal(observation[65:73], [1, 0, 0, 0, 0, 0, 0, 0])
        np.testing.assert_array_equal(observation[73:78], [0, 1, 0, 1, 0])
        env.tick = 49
        self.assertEqual(env.observe()[-1], 1)

        env.motion_contract = False
        observation = env.observe()
        self.assertEqual(observation.shape, (96,))
        np.testing.assert_allclose(observation[6:24], .4)
        np.testing.assert_allclose(observation[60:78], .4)
        np.testing.assert_allclose(observation[78:96], .5)

    def run_checkpoints(self, stop_when_passing):
        class PassingLearner:
            def __init__(self, *_args, **_kwargs):
                self.num_timesteps = 0
                self.device = SimpleNamespace(type="cpu", __str__=lambda: "cpu")

            def learn(self, total_timesteps, **_kwargs):
                self.num_timesteps += total_timesteps

            def save(self, weights):
                weights.write_text("fixture")

        def export_weights(_weights, policy, _observations, *, metadata):
            policy.write_text("fixture")
            return "a" * 64

        first_pass = {
            "qualityGatePassed": True, "framesEvaluated": 918,
            "trackingRmseRad": 0.01, "maxTiltDeg": 24.0,
        }
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(worker, "ReferenceTracking", return_value=SimpleNamespace(close=lambda: None)),
            patch.object(worker, "PPO", PassingLearner),
            patch.object(worker, "write_onnx", side_effect=export_weights),
            patch.object(worker.onnx, "load"),
            patch.object(worker, "ReferenceEvaluator"),
            patch.object(worker, "WorkerProgress"),
            patch.object(worker, "resolve_training_device", return_value="cpu"),
            patch.object(worker.torch, "set_num_threads"),
            patch.object(worker, "evaluate", side_effect=[
                (first_pass, []),
                ({**first_pass, "trackingRmseRad": 0.02}, []),
            ]),
        ):
            _, _, steps, _, result, _, checkpoints = worker.train_and_export(
                None, Path(directory), None, 65_536, 1, 7, SimpleNamespace(
                    stance_profile=None, contract_id=worker.CONTRACT, bpm=100.0, reference_lead_frames=0),
                [], stop_when_passing=stop_when_passing,
            )
        return steps, result["selectedCheckpointSteps"], [item["steps"] for item in checkpoints]

    def test_screen_selects_lead_only_when_it_improves_a_stable_full_replay(self):
        original = {"qualityGatePassed": True, "trackingRmseRad": .08}
        for compensated, expected in (
            ({"qualityGatePassed": True, "trackingRmseRad": .04}, worker.ACTUATOR_LEAD_FRAMES),
            ({"qualityGatePassed": False, "trackingRmseRad": .02}, 0),
            ({"qualityGatePassed": True, "trackingRmseRad": .09}, 0),
        ):
            with self.subTest(compensated=compensated):
                env = SimpleNamespace(motion_contract=True, reference_lead_frames=0)
                uncalibrated = SimpleNamespace()
                with (
                    patch.object(worker, "ReferenceTracking", side_effect=[env, uncalibrated]),
                    patch.object(worker, "evaluate", side_effect=[
                        (original, []), (compensated, []), (original, []),
                    ]),
                ):
                    chosen, report = worker.reference_gate(None, None)
                self.assertIs(chosen, env)
                self.assertEqual(chosen.reference_lead_frames, expected)
                self.assertEqual(report["referenceLeadFrames"], expected)
                self.assertEqual(report["gate"], compensated if expected else original)

    def test_long_composition_accepts_every_range_including_a_short_pose(self):
        ranges = [{"id": "short", "from": 0, "to": 2}]
        ranges.extend({"id": "arms", "from": index, "to": index + 100}
                      for index in range(2, 11_902, 100))
        ranges.append({"id": "end", "from": 11_902, "to": 12_000})
        training = {"originmanReferenceComposition": {"ranges": ranges}}
        self.assertEqual(worker.composition_ranges(training, 12_000), ranges)
        with self.assertRaisesRegex(ValueError, "frame boundaries"):
            worker.composition_ranges(training, 11_999)

    def test_source_preset_without_choreography_ranges_runs_the_chosen_budget(self):
        self.assertEqual(self.run_checkpoints(False), (65_536, 32_768, [32_768, 65_536]))

    def test_uploaded_reference_can_stop_at_its_first_passing_checkpoint(self):
        self.assertEqual(self.run_checkpoints(True), (32_768, 32_768, [32_768]))


if __name__ == "__main__":
    unittest.main()
