"""Ensure public simulation APIs cannot bypass the Node identity bridge."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "mujoco_nginx_installer", Path(__file__).with_name("install-nginx-route.py")
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class SimulationNginxTests(unittest.TestCase):
    def test_auth_api_routes_preserve_node_api_path_for_root_lab_and_legacy_prefix(self):
        route = installer.API_ROUTE
        self.assertIn("location = /mujoco/api {", route)
        self.assertIn("location ^~ /mujoco/api/ {", route)
        self.assertIn("proxy_pass http://127.0.0.1:18102;", route)
        self.assertIn("location = /sim2real/mujoco/api {", route)
        self.assertIn("proxy_pass http://127.0.0.1:18102/mujoco/api;", route)
        self.assertIn("location ^~ /sim2real/mujoco/api/ {", route)
        self.assertIn("proxy_pass http://127.0.0.1:18102/mujoco/api/;", route)
        self.assertIn("location = /mujoco/lab/api {", route)
        self.assertIn("location ^~ /mujoco/lab/api/ {", route)
        self.assertNotIn("18100", route)

    def test_preserves_existing_lab_and_robotics_routes_then_installs_api_guard_idempotently(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "nginx.conf"
            lab = "    location /mujoco/ { proxy_pass http://127.0.0.1:18100/; }\n"
            lab_ui = "    location /mujoco/lab/ { proxy_pass http://127.0.0.1:18100/; add_header X-Lab-Custom preserved; }\n"
            robotics = "    location /robotics-learning/ { proxy_pass http://127.0.0.1:18102/; }\n"
            original = f"server {{\n{installer.MARKER}{robotics}{lab}{lab_ui}}}\n"
            config.write_text(original)
            config.chmod(0o640)
            with patch.object(installer, "CONFIG", config), contextlib.redirect_stdout(io.StringIO()):
                installer.main()
                updated = config.read_text()
                self.assertIn(lab, updated)
                self.assertIn(lab_ui, updated)
                self.assertIn(robotics, updated)
                self.assertIn(installer.API_ROUTE, updated)
                self.assertEqual(updated.count("location /mujoco/ {"), 1)
                self.assertEqual(updated.count("location /mujoco/lab/"), 1)
                self.assertEqual(len([entry for entry in installer.location_blocks(updated) if entry[1].endswith(("/api", "/api/"))]), 6)
                self.assertEqual(config.stat().st_mode & 0o7777, 0o640)
                modified = config.stat().st_mtime_ns
                installer.main()
                self.assertEqual(config.read_text(), updated)
                self.assertEqual(config.stat().st_mtime_ns, modified)

    def test_refuses_conflicting_unmanaged_api_routes_without_rewriting_anything(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "nginx.conf"
            original = f"server {{\n{installer.MARKER}    location /mujoco/api/ {{ proxy_pass http://127.0.0.1:18100/api/; }}\n}}\n"
            config.write_text(original)
            with patch.object(installer, "CONFIG", config), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    installer.main()
            self.assertEqual(config.read_text(), original)

    def test_revalidates_api_proxy_inside_its_location_rather_than_other_routes(self):
        valid = f"server {{\n{installer.MARKER}{installer.API_ROUTE}}}"
        self.assertTrue(installer.api_routes_match(installer.target_server_block(valid)))
        invalid = valid.replace("proxy_pass http://127.0.0.1:18102;", "proxy_pass http://127.0.0.1:18100;", 1)
        self.assertFalse(installer.api_routes_match(installer.target_server_block(invalid)))

    def test_refuses_an_unmanaged_lab_api_bypass_without_changing_the_lab_ui(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "nginx.conf"
            lab_ui = "    location /mujoco/lab/ { proxy_pass http://127.0.0.1:18100/; }\n"
            bypass = "    location /mujoco/lab/api/ { proxy_pass http://127.0.0.1:18100/api/; }\n"
            original = f"server {{\n{installer.MARKER}{lab_ui}{bypass}}}\n"
            config.write_text(original)
            with patch.object(installer, "CONFIG", config), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    installer.main()
            self.assertEqual(config.read_text(), original)


if __name__ == "__main__":
    unittest.main()
