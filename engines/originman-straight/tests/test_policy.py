"""Critic optimization must not move an independently parameterized actor."""

import sys
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from policy import ResidualActorCritic


@pytest.mark.parametrize("architecture", ["shared", "separate"])
def test_value_only_update_exposes_or_prevents_actor_drift(architecture):
    torch.manual_seed(842)
    policy = ResidualActorCritic(41, 10, architecture)
    observations = torch.randn(32, 41) * 0.2
    before, values = policy(observations)
    expected = before.detach().clone()
    optimizer = torch.optim.Adam(policy.parameters(), lr=0.001)
    loss = (values - (values.detach() + 1)).square().mean()
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    after, _ = policy(observations)
    if architecture == "separate":
        torch.testing.assert_close(after, expected, rtol=0, atol=0)
    else:
        assert torch.max(abs(after - expected)) > 1e-3
    assert torch.max(abs(policy(observations)[1] - values.detach())) > 1e-3
