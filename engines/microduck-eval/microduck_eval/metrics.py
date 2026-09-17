"""Episode outcomes -> envelope metrics, using the platform's own semantics.

Only two things are computed here: counts with Wilson bounds (for rates) and
arithmetic means (for physical measurements). Anything the gate cannot read is
reported as a task-specific measurement rather than being folded into
``successRate``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .envelope import EvalEnvelope
from .tasks import EpisodeOutcome
from .wilson import wilson_bounds


@dataclass
class EpisodeResult:
    index: int
    outcome: EpisodeOutcome
    seed: int


@dataclass
class EnvelopeResult:
    envelope: EvalEnvelope
    episodes: list[EpisodeResult] = field(default_factory=list)

    # ---- rates -----------------------------------------------------------
    @property
    def episode_count(self) -> int:
        return len(self.episodes)

    def _rate(self, predicate) -> tuple[int, int]:
        successes = sum(1 for item in self.episodes if predicate(item.outcome))
        return successes, self.episode_count

    def as_metrics(self, confidence: float = 0.95) -> dict[str, Any]:
        successes, total = self._rate(lambda outcome: outcome.success)
        falls, _ = self._rate(lambda outcome: outcome.fall)
        collisions, _ = self._rate(lambda outcome: outcome.collision)
        success_bounds = wilson_bounds(successes, total, confidence)
        fall_bounds = wilson_bounds(falls, total, confidence)
        collision_bounds = wilson_bounds(collisions, total, confidence)

        metrics: dict[str, Any] = {"episodes": total}
        if total == 0:
            # No episodes = no evidence. Emit no rates at all rather than zeros,
            # so the gate fails closed instead of reading a fake 0%.
            metrics["insufficientEvidence"] = True
            return metrics

        metrics.update(
            {
                "successRate": round(successes / total, 4),
                "successRateCiLow": round(success_bounds[0], 4),
                "successRateCiHigh": round(success_bounds[1], 4),
                "collisionRate": round(collisions / total, 4),
                "collisionRateCiLow": round(collision_bounds[0], 4),
                "collisionRateCiHigh": round(collision_bounds[1], 4),
                "fallRate": round(falls / total, 4),
                "fallRateCiLow": round(fall_bounds[0], 4),
                "fallRateCiHigh": round(fall_bounds[1], 4),
            }
        )
        rewards = [item.outcome.reward for item in self.episodes]
        metrics["meanReward"] = round(sum(rewards) / total, 4)
        lengths = [item.outcome.length_seconds for item in self.episodes]
        metrics["meanEpisodeLength"] = round(sum(lengths) / total, 4)

        # Task-specific physical measurements: averaged over episodes, never
        # merged into a single score. `fallRate` is separate from 1-successRate
        # because a policy can fail the task while standing perfectly still.
        keys = sorted({key for item in self.episodes for key in item.outcome.metrics})
        for key in keys:
            values = [item.outcome.metrics[key] for item in self.episodes if key in item.outcome.metrics]
            if values:
                metrics[key] = round(sum(values) / len(values), 4)
                metrics[f"{key}Std"] = round(_std(values), 4)
        return metrics

    def as_dict(self, confidence: float = 0.95) -> dict[str, Any]:
        return {
            "envelope": self.envelope.as_dict(),
            "metrics": self.as_metrics(confidence),
        }


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return (sum((value - mean) ** 2 for value in values) / (len(values) - 1)) ** 0.5


def aggregate(results: list[EnvelopeResult], confidence: float = 0.95) -> dict[str, Any]:
    """Shape the platform already reads: ``{envelopes: {name: metrics}}``."""
    return {
        "envelopes": {item.envelope.name: item.as_metrics(confidence) for item in results},
        "meanReward": round(
            sum(item.as_metrics(confidence).get("meanReward", 0.0) for item in results) / len(results),
            4,
        )
        if results
        else 0.0,
        "episodesPerEnvelope": results[0].episode_count if results else 0,
        "confidenceLevel": confidence,
    }


def harness_qualification(
    baseline: list[EnvelopeResult],
    trained: list[EnvelopeResult] | None = None,
) -> dict[str, Any]:
    """Can this harness tell a good policy from a bad one? Prove it, don't assume.

    Two independent checks, both from measurements rather than assumptions:

    1. The zero-action baseline holds the HOME pose. If *it* falls, the
       dynamics/actuator path cannot hold the robot up at all, and every rate is
       an artifact.
    2. If a policy that is supposed to work (a real training artifact, flagged
       ``trusted``) fails here, the harness cannot be trusted to judge policies
       either — the failure is far more likely to be the harness than the policy.

    Both states force the release gate to FAIL, so an unqualified harness can
    never certify a policy *or* condemn one.
    """
    checks: dict[str, Any] = {}
    reasons: list[str] = []
    if not baseline:
        return {
            "passed": False,
            "reasons": ["no zero-action baseline was run; the harness is unqualified"],
            "envelopes": {},
        }
    for result in baseline:
        metrics = result.as_metrics()
        episodes = metrics.get("episodes", 0)
        falls = int(round(metrics.get("fallRate", 0.0) * episodes))
        checks[result.envelope.name] = {
            "episodes": episodes,
            "baselineFallRate": metrics.get("fallRate"),
            "baselineMeanBaseHeightM": metrics.get("minBaseHeightM"),
        }
        if episodes and falls == episodes:
            reasons.append(
                f"envelope {result.envelope.name}: the zero-action baseline fell in all "
                f"{episodes} episodes (min trunk height "
                f"{metrics.get('minBaseHeightM')} m) — the dynamics/actuator path cannot "
                "hold the robot up, so rates from this harness are only comparable within "
                "the same implementation"
            )

    trained = trained or []
    for result in trained:
        metrics = result.as_metrics()
        episodes = metrics.get("episodes", 0)
        successes = int(round(metrics.get("successRate", 0.0) * episodes))
        falls = int(round(metrics.get("fallRate", 0.0) * episodes))
        entry = checks.setdefault(result.envelope.name, {"episodes": episodes})
        entry["trainedFallRate"] = metrics.get("fallRate")
        if episodes and successes == 0 and falls == episodes:
            reasons.append(
                f"envelope {result.envelope.name}: the evaluated policy fell in all "
                f"{episodes} episodes while the baseline stood — a policy that trained "
                "successfully should not be uniformly worse than holding still, so the "
                "harness cannot currently judge learned policies (actuator/dynamics "
                "fidelity), and no success rate from it is meaningful"
            )
    return {"passed": not reasons, "reasons": reasons, "envelopes": checks}
