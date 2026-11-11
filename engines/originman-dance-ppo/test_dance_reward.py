import math
import unittest

from dance_env import alternating_arm_targets


class AlternatingArmRewardTests(unittest.TestCase):
    def test_speed_peaks_at_direction_changes_not_position_extrema(self):
        for beat in (0.0, 1.0, 2.0):
            position, pulse = alternating_arm_targets(beat, 0.25)
            self.assertGreater(abs(position), 0.08)
            self.assertAlmostEqual(pulse, 0.0)
        for beat in (0.5, 1.5, 2.5):
            position, pulse = alternating_arm_targets(beat, 0.25)
            self.assertAlmostEqual(position, 0.0)
            self.assertAlmostEqual(pulse, 1.0)

    def test_target_and_speed_are_periodic_and_intensity_changes_amplitude(self):
        for beat in (0.1, 0.4, 1.2):
            position, pulse = alternating_arm_targets(beat, 0.25)
            next_position, next_pulse = alternating_arm_targets(beat + 2, 0.25)
            self.assertAlmostEqual(position, next_position)
            self.assertAlmostEqual(pulse, next_pulse)
            self.assertTrue(math.isfinite(position) and 0 <= pulse <= 1)
        self.assertGreater(alternating_arm_targets(0, 1)[0], alternating_arm_targets(0, 0.25)[0])
