import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from imitation_input import load_engine_demonstrations

ROOT = pathlib.Path(__file__).resolve().parent


def rows():
    return [{"type": "step", "observation": [i / 32, 0.1, 0.2],
             "action": [0.25], "done": i % 4 == 3} for i in range(32)]


def request_and_file(workdir):
    raw = "".join(json.dumps(row) + "\n" for row in rows())
    pathlib.Path(workdir, "demonstrations.jsonl").write_text(raw)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    return {"schemaVersion": 1, "model": {"modelId": "recorded-demo", "version": "1"},
            "contract": {"id": "recorded-demo", "observationSize": 3, "actionSize": 1},
            "training": {"profile": "smoke", "maxIterations": 1,
                         "demonstrationRunId": "recording-1", "demonstrationSha256": digest},
            "demonstrations": {"sourceRunId": "recording-1", "sha256": digest,
                               "sampleCount": 32, "episodeCount": 8}}


class DemonstrationInputTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engines = []
        for name, file in [("act", ROOT / "act/train_act.py"), ("diffusion-policy", ROOT / "diffusion-policy/train_dp.py")]:
            spec = importlib.util.spec_from_file_location(name.replace("-", "_"), file)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            cls.engines.append((name, file, module))

    def test_missing_input_and_implicit_synthetic_are_refused(self):
        for _, _, engine in self.engines:
            with self.subTest(engine=engine.ENGINE_NAME):
                with self.assertRaisesRegex(ValueError, "recorded demonstrations required"):
                    load_engine_demonstrations({"training": {"profile": "smoke"}}, engine.load_dataset, engine.synthetic_episodes, 3, 1)
                with self.assertRaisesRegex(ValueError, "syntheticSmoke requires smoke"):
                    load_engine_demonstrations({"training": {"profile": "standard", "syntheticSmoke": True}}, engine.load_dataset, engine.synthetic_episodes, 3, 1)

    def test_recordings_preserve_actions_and_never_call_synthetic_factory(self):
        for _, _, engine in self.engines:
            with tempfile.TemporaryDirectory() as workdir:
                request = request_and_file(workdir)
                previous = os.getcwd()
                try:
                    os.chdir(workdir)
                    with patch.object(engine, "synthetic_episodes", side_effect=AssertionError("synthetic substitution")):
                        episodes, source = load_engine_demonstrations(request, engine.load_dataset, engine.synthetic_episodes, 3, 1)
                    self.assertEqual(len(episodes), 8)
                    self.assertEqual(float(episodes[0][1][0][0]), 0.25)
                    self.assertIs(source["synthetic"], False)
                    self.assertEqual(source["sha256"], request["demonstrations"]["sha256"])
                    with self.assertRaisesRegex(ValueError, "dimensions differ"):
                        load_engine_demonstrations(request, engine.load_dataset, engine.synthetic_episodes, 4, 1)
                    pathlib.Path("demonstrations.jsonl").write_text("tampered")
                    with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                        load_engine_demonstrations(request, engine.load_dataset, engine.synthetic_episodes, 3, 1)
                finally:
                    os.chdir(previous)

    def test_both_engines_train_and_export_the_recorded_input(self):
        for name, file, engine in self.engines:
            if engine.torch is None:
                self.skipTest("torch unavailable")
            with self.subTest(engine=name), tempfile.TemporaryDirectory() as workdir:
                request = request_and_file(workdir)
                request["training"]["engine"] = name
                request_file = pathlib.Path(workdir, "request.json")
                result_file = pathlib.Path(workdir, "result.json")
                request_file.write_text(json.dumps(request))
                completed = subprocess.run([sys.executable, str(file)], cwd=workdir,
                    env={**os.environ, "RDK_SIM2REAL_REQUEST_FILE": str(request_file),
                         "RDK_SIM2REAL_RESULT_FILE": str(result_file)},
                    capture_output=True, text=True, timeout=120)
                self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
                result = json.loads(result_file.read_text())
                self.assertIs(result["dataset"]["synthetic"], False)
                self.assertEqual(result["dataset"]["sourceRunId"], "recording-1")
                self.assertEqual(result["metrics"]["demonstrationSha256"], request["demonstrations"]["sha256"])
                self.assertEqual(result["artifact"]["artifactRef"], "artifact://policy.onnx")
                self.assertEqual(result["artifact"]["kind"], "source")
                self.assertEqual(result["artifact"]["sha256"], hashlib.sha256(pathlib.Path(workdir, "policy.onnx").read_bytes()).hexdigest())
                self.assertTrue(pathlib.Path(workdir, "SHA256SUMS").is_file())


if __name__ == "__main__":
    unittest.main()
