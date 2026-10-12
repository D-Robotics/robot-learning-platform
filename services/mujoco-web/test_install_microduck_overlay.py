"""Regression checks for reinstalling the additive MicroDuck overlay."""

from __future__ import annotations

import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "microduck_overlay_installer", Path(__file__).with_name("install-microduck-overlay.py")
)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class OverlayInstallerTests(unittest.TestCase):
    def test_reinstall_updates_cache_key_and_preserves_upstream_and_index_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            target = root / "release"
            (source / "community").mkdir(parents=True)
            target.mkdir()
            overlay = source / installer.ASSETS[0]
            overlay.write_text("console.log('version one');", encoding="utf-8")
            (source / installer.ASSETS[1]).write_bytes(b"test-image")
            (source / installer.NETWORK_MARKER).write_text("blockPeer();", encoding="utf-8")
            upstream_tag = '<script type="module" src="./assets/upstream.js"></script>'
            index = target / "index.html"
            index.write_text(f"<html><head></head><body>{upstream_tag}</body></html>", encoding="utf-8")
            index.chmod(0o640)
            with patch.object(installer, "SOURCE_ROOT", source), patch.object(
                installer, "target_root", return_value=target
            ):
                installer.main()
                first_digest = hashlib.sha256(overlay.read_bytes()).hexdigest()[:12]
                self.assertIn(f"?v={first_digest}", index.read_text())
                overlay.write_text("console.log('version two');", encoding="utf-8")
                installer.main()
                second_digest = hashlib.sha256(overlay.read_bytes()).hexdigest()[:12]
                content = index.read_text()
                self.assertIn(f"?v={second_digest}", content)
                self.assertNotIn(first_digest, content)
                self.assertEqual(content.count(installer.MARKER), 1)
                self.assertIn(upstream_tag, content)
                self.assertEqual((target / installer.ASSETS[0]).read_bytes(), overlay.read_bytes())
                self.assertEqual(index.stat().st_mode & 0o7777, 0o640)
                modified = index.stat().st_mtime_ns
                installer.main()
                self.assertEqual(index.read_text(), content)
                self.assertEqual(index.stat().st_mtime_ns, modified)

    def test_network_boundary_is_synchronous_and_precedes_every_upstream_script(self):
        source = Path(__file__).with_name(installer.NETWORK_MARKER)
        module = '<script type="module" src="/bundle/upstream.js"></script>'
        content = f'<html><head>{module}</head><body></body></html>'
        updated = installer.install_network_boundary(content, source)
        guard = installer.network_script_tag(source)
        self.assertLess(updated.index(installer.NETWORK_POLICY), updated.index(guard))
        self.assertLess(updated.index(guard), updated.index(module))
        self.assertEqual(updated.index(guard), updated.index("<script"))
        self.assertNotIn("defer", guard)
        self.assertNotIn("async", guard)
        self.assertNotIn("module", guard)
        self.assertEqual(updated, installer.install_network_boundary(updated, source))

    def test_network_boundary_refresh_changes_only_its_cached_additions(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / installer.NETWORK_MARKER
            source.write_text("versionOne();", encoding="utf-8")
            module = '<script type="module" src="/bundle/upstream.js"></script>'
            installed = installer.install_network_boundary(f'<head>{module}</head>', source)
            previous_digest = hashlib.sha256(source.read_bytes()).hexdigest()[:12]
            source.write_text("versionTwo();", encoding="utf-8")
            updated = installer.install_network_boundary(installed, source)
            self.assertNotIn(previous_digest, updated)
            self.assertEqual(updated.count(installer.NETWORK_MARKER), 1)
            self.assertEqual(updated.count(installer.NETWORK_POLICY_ID), 1)
            self.assertIn(module, updated)
            self.assertEqual(updated, installer.install_network_boundary(updated, source))

    def test_missing_head_refuses_a_late_network_boundary(self):
        source = Path(__file__).with_name(installer.NETWORK_MARKER)
        with self.assertRaisesRegex(SystemExit, "no <head>"):
            installer.install_network_boundary('<body><script src="x.js"></script></body>', source)

    def test_refresh_preserves_attributes_queries_and_fragment(self):
        source = Path(__file__).with_name(installer.ASSETS[0])
        content = "<script nonce='kept' src='./microduck-community-overlay.js?x=1&amp;v=old#fragment' defer></script>"
        updated = installer.install_script_reference(content, source)
        self.assertIn("nonce='kept'", updated)
        self.assertIn("?x=1&amp;v=", updated)
        self.assertIn("#fragment' defer", updated)
        self.assertNotIn("v=old", updated)

    def test_marker_text_does_not_prevent_inserting_the_script(self):
        source = Path(__file__).with_name(installer.ASSETS[0])
        content = f"<body><!-- {installer.MARKER} --></body>"
        updated = installer.install_script_reference(content, source)
        self.assertIn(installer.script_tag(source), updated)


if __name__ == "__main__":
    unittest.main()
