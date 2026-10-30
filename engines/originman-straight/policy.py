"""Optional independent critic while preserving the reused actor architecture."""

import sys
from pathlib import Path

from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "microduck-football"))
from train_football import ActorCritic as SharedActorCritic


class ResidualActorCritic(SharedActorCritic):
    def __init__(self, obs_dim, action_dim, value_network="shared"):
        if value_network not in ("shared", "separate"):
            raise ValueError("value_network must be shared or separate")
        super().__init__(obs_dim, action_dim)
        self.value_network = value_network
        if value_network == "separate":
            self.value = nn.Sequential(
                nn.Linear(obs_dim, 128),
                nn.Tanh(),
                nn.Linear(128, 128),
                nn.Tanh(),
                nn.Linear(128, 1),
            )

    def forward(self, obs):
        features = self.body(obs)
        value = self.value(obs if self.value_network == "separate" else features)
        return self.mean(features), value.squeeze(-1)
