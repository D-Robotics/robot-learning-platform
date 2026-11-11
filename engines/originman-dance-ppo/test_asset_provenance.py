import hashlib
from pathlib import Path
import tempfile
import unittest

from asset_provenance import verified_sha256, verify_joint_names


class AssetProvenanceTests(unittest.TestCase):
    def test_accepts_the_exact_scene_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            scene = Path(directory) / "scene.xml"
            scene.write_bytes(b"<mujoco/>\n")
            digest = hashlib.sha256(scene.read_bytes()).hexdigest()
            self.assertEqual(verified_sha256(scene, digest, "scene.xml"), digest)

    def test_refuses_a_scene_changed_after_manifest_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            scene = Path(directory) / "scene.xml"
            scene.write_bytes(b"<mujoco/>\n")
            original = hashlib.sha256(scene.read_bytes()).hexdigest()
            scene.write_bytes(b"<mujoco><!-- changed --></mujoco>\n")
            with self.assertRaisesRegex(ValueError, "does not match"):
                verified_sha256(scene, original, "scene.xml")

    def test_rejects_malformed_manifest_digests(self):
        with tempfile.TemporaryDirectory() as directory:
            scene = Path(directory) / "scene.xml"
            scene.write_bytes(b"x")
            with self.assertRaisesRegex(ValueError, "missing or malformed"):
                verified_sha256(scene, "../scene", "scene.xml")

    def test_requires_an_exact_unique_twenty_actuator_joint_set(self):
        names = [f"joint-{index}" for index in range(20)]
        self.assertIsNone(verify_joint_names(names, list(reversed(names))))
        with self.assertRaisesRegex(ValueError, "do not match"):
            verify_joint_names(names, names[:-1] + ["other-joint"])
        with self.assertRaisesRegex(ValueError, "do not match"):
            verify_joint_names(names, names[:-1] + [names[0]])


if __name__ == "__main__":
    unittest.main()
