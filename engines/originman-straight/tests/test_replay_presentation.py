"""Renderer contracts, executable without a display or a training dependency."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

import mujoco
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from replay_presentation import (
    camera_for,
    decorate,
    force_windows,
    frame_at,
    phase,
    playback_schedule,
    style_model,
)
from standing_render import paired_rows


def row():
    return {
        "controller": "rl",
        "force": -8,
        "start": 0.1,
        "seconds": 0.4,
        "fallen": False,
        "recoverySuccess": True,
        "frames": [
            {
                "time": t,
                "qpos": [0, y, 0.2, 1, 0, 0, 0],
                "externalForceWorldN": [0, force, 0],
                "tiltDegrees": 1,
            }
            for t, y, force in (
                (0.04, 0, 0),
                (0.08, 0, 0),
                (0.12, -0.01, -8),
                (0.16, -0.02, -8),
                (0.2, -0.03, 0),
                (0.4, 0, 0),
            )
        ],
    }


class ReplayPresentationTest(unittest.TestCase):
    def test_schedule_is_monotone_shares_clock_and_labels_final_hold(self):
        r = row()
        original = copy.deepcopy(r)
        schedule = playback_schedule([r] * 4)
        self.assertEqual(schedule[0][0], 0.04)
        self.assertEqual(schedule[-25:], [(0.4, 0)] * 25)
        self.assertTrue(all(a[0] <= b[0] for a, b in zip(schedule, schedule[1:])))
        self.assertTrue(any(rate == 0.5 for _, rate in schedule))
        self.assertEqual(r, original)
        self.assertIs(frame_at(r, 0.15), r["frames"][2])
        self.assertIs(frame_at(r, 6), r["frames"][-1])

    def test_status_never_calls_observation_recovery_success(self):
        r = row()
        self.assertEqual(phase(r, frame_at(r, 0.1), 0.1), "before")
        self.assertEqual(phase(r, frame_at(r, 0.14), 0.14), "push")
        self.assertEqual(phase(r, frame_at(r, 0.3), 0.3), "observe")
        self.assertEqual(phase(r, frame_at(r, 0.4), 0.4), "passed")
        r["fallen"] = True
        self.assertEqual(phase(r, frame_at(r, 6), 6), "fallen")
        r["fallen"], r["recoverySuccess"] = False, False
        self.assertEqual(phase(r, frame_at(r, 6), 6), "failed")
        self.assertEqual(force_windows(r), [[0.08, 0.16]])

    def test_no_force_trace_does_not_invent_push_or_slow_motion(self):
        r = row()
        r["force"] = 0
        for f in r["frames"]:
            f["externalForceWorldN"] = [0, 0, 0]
        self.assertEqual(force_windows(r), [])
        self.assertFalse(any(rate == 0.5 for _, rate in playback_schedule([r] * 4)))
        self.assertEqual(phase(r, frame_at(r, 0.3), 0.3), "before")

    def test_scene_style_and_decorations_do_not_change_physics(self):
        model = mujoco.MjModel.from_xml_string(
            '<mujoco><worldbody><light pos="0 0 3"/><geom name="ground" type="plane" size="3 3 .1"/><body pos="0 0 .3"><freejoint/><geom name="body_link_visual" type="box" size=".05 .05 .1" mass="1"/></body></worldbody></mujoco>'
        )
        names = [
            "body_mass",
            "body_inertia",
            "geom_friction",
            "geom_contype",
            "geom_conaffinity",
            "geom_pos",
            "geom_size",
            "dof_damping",
        ]
        before = {name: getattr(model, name).copy() for name in names}
        style_model(model)
        for name in names:
            np.testing.assert_array_equal(getattr(model, name), before[name])
        scene = mujoco.MjvScene(model, maxgeom=100)
        frame = row()["frames"][2]
        original = copy.deepcopy(frame)
        decorate(scene, frame)
        self.assertEqual(scene.geoms[scene.ngeom - 1].type, mujoco.mjtGeom.mjGEOM_ARROW)
        self.assertEqual(frame, original)
        self.assertTrue(
            all(
                g.category == mujoco.mjtCatBit.mjCAT_DECOR
                for g in scene.geoms[: scene.ngeom]
            )
        )

    def test_invalid_and_unpaired_records_are_rejected_before_graphics(self):
        rows = [row() for _ in range(4)]
        for r, controller in zip(
            rows, ["reference", "imu-feedback", "untrained", "rl"]
        ):
            r["controller"] = controller
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)

            def save():
                (path / "episodes.jsonl").write_text(
                    "\n".join(json.dumps(r) for r in rows)
                )

            save()
            self.assertEqual(len(paired_rows(path, 0)), 4)
            for index in (-1, 1):
                with self.assertRaises(ValueError):
                    paired_rows(path, index)
            rows[2]["start"] = 0.2
            save()
            with self.assertRaisesRegex(ValueError, "disturbance"):
                paired_rows(path, 0)
            rows[2]["start"] = 0.1
            rows[0]["frames"][1]["time"] = 0.01
            save()
            with self.assertRaisesRegex(ValueError, "increasing"):
                paired_rows(path, 0)

    def test_camera_is_fixed_and_accounts_for_all_controller_displacements(self):
        rows = [row() for _ in range(4)]
        rows[2]["frames"][2]["qpos"][1] = -0.5
        camera = camera_for(rows)
        self.assertAlmostEqual(camera.lookat[1], -0.25)
        self.assertEqual(camera.azimuth, 15)
        self.assertEqual(camera.elevation, -20)
        self.assertGreaterEqual(camera.distance, 0.82)


if __name__ == "__main__":
    unittest.main()
