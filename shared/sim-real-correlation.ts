/**
 * Sim–real correlation report (SimplerEnv-style methodology).
 *
 * Purpose: quantify whether a simulation-side metric predicts the real-robot
 * side across runs. SimplerEnv popularized judging a sim2real pipeline by the
 * correlation between simulated and real evaluation outcomes (Pearson r plus
 * MMRV summaries of the relative error, with rank correlation carrying the
 * practical "does sim preserve the real ranking" reading). This module is the
 * platform's honest generic core for that methodology: pure functions over
 * (simValue, realValue) pairs. Degenerate inputs are reported as null with a
 * reason — a constant channel correlates with nothing, and two pairs do not
 * make a trend — never a fabricated coefficient.
 *
 * The module never gates a release: correlation is evidence about the
 * evidence chain, not a threshold. Direction conventions differ per channel
 * (success rates are higher-is-better, error metrics lower-is-better); the
 * caller labels them, the math stays sign-faithful.
 */

export interface SimRealPair {
  runId: string;
  simValue: number;
  realValue: number;
}

export interface CorrelationStatistic {
  value: number;
}

export interface NullStatistic {
  value: null;
  reason: string;
}

export interface SimRealMmrv {
  /** Mean of the signed relative errors (sim - real) / |real|. */
  mean: number;
  median: number;
  /** Root mean square of the signed relative errors. */
  rms: number;
  /** Population variance of the signed relative errors. */
  variance: number;
  count: number;
}

export interface SimRealCorrelationReport {
  pairCount: number;
  excludedPairCount: number;
  exclusionReasons: Record<string, number>;
  /** Correlations below this pair count are reported as null. */
  minPairs: number;
  pearson: CorrelationStatistic | NullStatistic;
  spearman: CorrelationStatistic | NullStatistic;
  mmrv: SimRealMmrv | NullStatistic;
}

export const DEFAULT_MIN_PAIRS_FOR_CORRELATION = 3;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/** Average ranks (1-based) with ties sharing the mean of their positions. */
function averageRanks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index }));
  order.sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) {
      end += 1;
    }
    const rank = (start + end) / 2 + 1;
    for (let position = start; position <= end; position += 1) {
      ranks[order[position].index] = rank;
    }
    start = end + 1;
  }
  return ranks;
}

export function spearmanCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  return pearsonCorrelation(averageRanks(xs), averageRanks(ys));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Build the full report. Non-finite channel values and zero real values (no
 * relative error definable) are excluded and counted by reason — silently
 * dropping pairs would inflate confidence the methodology does not have.
 */
export function summarizeSimRealCorrelation(
  pairs: readonly SimRealPair[],
  options: { minPairs?: number } = {},
): SimRealCorrelationReport {
  const minPairs = options.minPairs ?? DEFAULT_MIN_PAIRS_FOR_CORRELATION;
  const exclusionReasons: Record<string, number> = {};
  const excluded = (reason: string) => {
    exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
  };

  const valid: SimRealPair[] = [];
  for (const pair of pairs) {
    if (!isFiniteNumber(pair?.simValue) || !isFiniteNumber(pair?.realValue)) {
      excluded('non-finite-value');
      continue;
    }
    valid.push(pair);
  }

  const relativeErrors: number[] = [];
  for (const pair of valid) {
    if (pair.realValue === 0) {
      excluded('zero-real-value');
      continue;
    }
    relativeErrors.push((pair.simValue - pair.realValue) / Math.abs(pair.realValue));
  }

  const insufficient = valid.length < minPairs;
  const xs = valid.map((pair) => pair.simValue);
  const ys = valid.map((pair) => pair.realValue);

  // The pair floor is a hard gate, not a decoration: below it the report
  // refuses coefficients entirely instead of publishing an unstable number.
  const pearsonValue = pearsonCorrelation(xs, ys);
  const pearson: CorrelationStatistic | NullStatistic = insufficient
    ? { value: null, reason: 'insufficient-pairs' }
    : pearsonValue === null
      ? { value: null, reason: 'zero-variance' }
      : { value: pearsonValue };

  const spearmanValue = spearmanCorrelation(xs, ys);
  const spearman: CorrelationStatistic | NullStatistic = insufficient
    ? { value: null, reason: 'insufficient-pairs' }
    : spearmanValue === null
      ? { value: null, reason: 'zero-variance' }
      : { value: spearmanValue };

  let mmrv: SimRealMmrv | NullStatistic;
  if (relativeErrors.length === 0) {
    mmrv = { value: null, reason: 'no-relative-error-pairs' };
  } else {
    const mean = relativeErrors.reduce((sum, value) => sum + value, 0) / relativeErrors.length;
    mmrv = {
      mean,
      median: median(relativeErrors),
      rms: Math.sqrt(
        relativeErrors.reduce((sum, value) => sum + value * value, 0) / relativeErrors.length,
      ),
      variance:
        relativeErrors.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) /
        relativeErrors.length,
      count: relativeErrors.length,
    };
  }

  return {
    pairCount: valid.length,
    excludedPairCount: pairs.length - valid.length,
    exclusionReasons,
    minPairs,
    pearson,
    spearman,
    mmrv,
  };
}
