"""Versioned explicit alternation phase; does not change the v1 environment."""
import math

import numpy as np

from dance_env import ConfigurableChoreography


def section_phase_features(local_beat, progress, hold):
    return np.asarray([
        math.sin(2 * math.pi * progress),
        math.cos(2 * math.pi * progress),
        math.sin(math.pi * local_beat),
        math.cos(math.pi * local_beat),
        float(hold),
    ], dtype=np.float32)


class ExplicitAlternationChoreography(ConfigurableChoreography):
    observation_adapter_id = 'originman-dance-phase-v2'

    def observe(self):
        _, index, local, progress, _ = self.condition()
        return np.r_[
            super().observe()[:-5],
            section_phase_features(local, progress, index == len(self.sections) - 1 and progress >= 0.75),
        ].astype(np.float32)
