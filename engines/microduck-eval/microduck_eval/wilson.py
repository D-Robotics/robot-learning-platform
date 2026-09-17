"""Wilson score interval, byte-for-byte the same semantics as the platform gate.

The platform decides release with the Wilson 95% *lower bound* (see
``engines/starter-ppo/runner.py::wilson_bounds`` and
``shared/artifact-quality-gate.ts``). Evaluation here must not invent a second
statistic, otherwise "passes the gate" would mean two different things.
"""

from __future__ import annotations

import math

#: Two-sided z for 95% confidence. Kept as a literal so CPU-only runs (no scipy)
#: produce the exact same bound the gate recomputes.
Z_95 = 1.959963984540054


def _z_for(confidence: float) -> float:
    if abs(confidence - 0.95) < 1e-12:
        return Z_95
    # Inverse normal CDF via Acklam's rational approximation; only used when a
    # caller asks for a non-default confidence level.
    if not 0.5 < confidence < 0.9999:
        raise ValueError("confidence must be in (0.5, 0.9999)")
    p = 1.0 - (1.0 - confidence) / 2.0
    a = [-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00]
    b = [-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (
        ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def wilson_bounds(
    successes: int, total: int, confidence: float = 0.95
) -> tuple[float, float] | None:
    """Return ``(low, high)`` bounds for ``successes / total``.

    Matches the platform exactly (``engines/starter-ppo/runner.py::wilson_bounds``,
    ``shared/artifact-quality-gate.ts``): the default confidence uses the same
    two-sided z, and **no episodes returns ``None``** because "no evidence" must
    never be readable as 0% or 100%. The caller decides how to fail.
    """
    if total < 0 or successes < 0 or successes > total:
        raise ValueError("successes/total must satisfy 0 <= successes <= total")
    if total <= 0:
        return None
    z = _z_for(confidence)
    phat = successes / total
    denom = 1.0 + z * z / total
    centre = (phat + z * z / (2 * total)) / denom
    margin = z * math.sqrt(phat * (1 - phat) / total + z * z / (4 * total * total)) / denom
    return max(0.0, centre - margin), min(1.0, centre + margin)


def rounded(
    bounds: tuple[float, float] | None, digits: int = 4
) -> tuple[float, float] | None:
    """The platform stores CI bounds rounded to 4 decimals (see eval reports)."""
    if bounds is None:
        return None
    return round(bounds[0], digits), round(bounds[1], digits)
