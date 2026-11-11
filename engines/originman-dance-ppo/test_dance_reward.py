import math
import unittest

from dance_env import DEFAULT_REWARD_TUNING, REWARD_TUNING_LIMITS, alternating_arm_targets, validate_dance_config
from dance_env_v2 import section_phase_features


class AlternatingArmRewardTests(unittest.TestCase):
    def test_explicit_phase_marks_opposite_arm_targets_on_adjacent_beats(self):
        even = section_phase_features(0, 0, False)
        odd = section_phase_features(1, 1 / 8, False)
        repeated = section_phase_features(2, 2 / 8, False)
        self.assertEqual(even.shape, (5,))
        self.assertAlmostEqual(float(even[3]), 1)
        self.assertAlmostEqual(float(odd[3]), -1)
        self.assertAlmostEqual(float(repeated[3]), 1)
        self.assertEqual(float(section_phase_features(3, 0.9, True)[4]), 1)

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


class RewardTuningValidationTests(unittest.TestCase):
    def base_config(self, **extra):
        return {
            "schemaVersion": 1,
            "title": "tuning",
            "bpm": 100,
            "sections": [{"type": "weight-shift", "beats": 8, "intensity": 0.5}],
            **extra,
        }

    def test_absent_reward_tuning_keeps_default_shape(self):
        config = validate_dance_config(self.base_config())
        self.assertNotIn("rewardTuning", config)

    def test_valid_overrides_are_normalized_and_kept(self):
        config = validate_dance_config(
            self.base_config(rewardTuning={"squatDepthM": 0.05, "tiltPenalty": 4})
        )
        self.assertEqual(config["rewardTuning"], {"squatDepthM": 0.05, "tiltPenalty": 4.0})

    def test_unknown_key_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_dance_config(self.base_config(rewardTuning={"armSwing": 1.0}))

    def test_out_of_range_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_dance_config(self.base_config(rewardTuning={"workPenalty": 9.9}))

    def test_non_numeric_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_dance_config(self.base_config(rewardTuning={"workPenalty": "high"}))

    def test_defaults_stay_inside_limits(self):
        self.assertEqual(set(DEFAULT_REWARD_TUNING), set(REWARD_TUNING_LIMITS))
        for key, value in DEFAULT_REWARD_TUNING.items():
            low, high = REWARD_TUNING_LIMITS[key]
            self.assertTrue(low <= value <= high, key)
