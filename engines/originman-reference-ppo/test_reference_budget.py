import importlib.util
from pathlib import Path
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
    def run_checkpoints(self, stop_when_passing):
        class PassingLearner:
            def __init__(self, *_args, **_kwargs):
                self.num_timesteps = 0
                self.device = SimpleNamespace(type="cpu", __str__=lambda: "cpu")

            def learn(self, total_timesteps, **_kwargs):
                self.num_timesteps += total_timesteps

            def save(self, weights):
                weights.write_text("fixture")

        def export_weights(_weights, policy, _observations):
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
                None, Path(directory), None, 65_536, 1, 7, SimpleNamespace(stance_profile=None),
                [], stop_when_passing=stop_when_passing,
            )
        return steps, result["selectedCheckpointSteps"], [item["steps"] for item in checkpoints]

    def test_source_preset_without_choreography_ranges_runs_the_chosen_budget(self):
        self.assertEqual(self.run_checkpoints(False), (65_536, 32_768, [32_768, 65_536]))

    def test_uploaded_reference_can_stop_at_its_first_passing_checkpoint(self):
        self.assertEqual(self.run_checkpoints(True), (32_768, 32_768, [32_768]))


if __name__ == "__main__":
    unittest.main()
