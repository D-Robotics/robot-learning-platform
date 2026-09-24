import { describe, expect, it } from 'vitest';

import {
  pearsonCorrelation,
  spearmanCorrelation,
  summarizeSimRealCorrelation,
} from './sim-real-correlation.js';

describe('pearsonCorrelation', () => {
  it('returns 1 for a perfect positive line', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
  });

  it('returns -1 for a perfect negative line', () => {
    expect(pearsonCorrelation([1, 2, 3], [9, 6, 3])).toBeCloseTo(-1, 12);
  });

  it('returns null for a constant channel instead of a fake coefficient', () => {
    expect(pearsonCorrelation([5, 5, 5], [1, 2, 3])).toBeNull();
  });

  it('returns null with fewer than two pairs', () => {
    expect(pearsonCorrelation([1], [1])).toBeNull();
  });
});

describe('spearmanCorrelation', () => {
  it('is 1 for any strictly monotone relationship, unlike Pearson', () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [1, 8, 27, 64, 125];
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(1, 12);
    expect(pearsonCorrelation(xs, ys)).toBeLessThan(1);
  });

  it('gives tied values the average rank', () => {
    // xs has a genuine tie (20, 20): ranks [1, 2.5, 2.5, 4]; ys tracks ranks.
    const xs = [10, 20, 20, 30];
    const ys = [1, 2.5, 2.5, 4];
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(1, 12);
  });

  it('returns null for a constant channel', () => {
    expect(spearmanCorrelation([7, 7, 7], [1, 2, 3])).toBeNull();
  });
});

describe('summarizeSimRealCorrelation', () => {
  it('reports correlations and MMRV over a small fixture', () => {
    const report = summarizeSimRealCorrelation([
      { runId: 'a', simValue: 0.9, realValue: 1.0 },
      { runId: 'b', simValue: 0.6, realValue: 0.8 },
      { runId: 'c', simValue: 0.3, realValue: 0.4 },
    ]);
    expect(report.pairCount).toBe(3);
    expect(report.pearson).toEqual({ value: expect.any(Number) });
    expect(report.spearman).toEqual({ value: 1 });
    // Relative errors: -0.1, -0.25, -0.25 -> mean -0.2, median -0.25.
    const mmrv = report.mmrv as {
      mean: number;
      median: number;
      rms: number;
      variance: number;
      count: number;
    };
    expect(mmrv.mean).toBeCloseTo(-0.2, 12);
    expect(mmrv.median).toBeCloseTo(-0.25, 12);
    expect(mmrv.rms).toBeCloseTo(Math.sqrt((0.01 + 0.0625 + 0.0625) / 3), 12);
    expect(mmrv.variance).toBeCloseTo(0.005, 12);
    expect(mmrv.count).toBe(3);
  });

  it('refuses correlations below the pair floor with a reason', () => {
    const report = summarizeSimRealCorrelation([
      { runId: 'a', simValue: 1, realValue: 1 },
      { runId: 'b', simValue: 2, realValue: 2 },
    ]);
    expect(report.pearson).toEqual({ value: null, reason: 'insufficient-pairs' });
    expect(report.spearman).toEqual({ value: null, reason: 'insufficient-pairs' });
  });

  it('honors an explicit lower pair floor', () => {
    const report = summarizeSimRealCorrelation(
      [
        { runId: 'a', simValue: 1, realValue: 2 },
        { runId: 'b', simValue: 2, realValue: 4 },
      ],
      { minPairs: 2 },
    );
    expect(report.pearson).toEqual({ value: 1 });
  });

  it('counts exclusions by reason and keeps the math on valid pairs', () => {
    const report = summarizeSimRealCorrelation([
      { runId: 'good-1', simValue: 0.9, realValue: 1.0 },
      { runId: 'good-2', simValue: 0.6, realValue: 0.8 },
      { runId: 'good-3', simValue: 0.3, realValue: 0.4 },
      { runId: 'nan', simValue: Number.NaN, realValue: 0.5 },
      { runId: 'zero-real', simValue: 0.5, realValue: 0 },
    ]);
    // A zero-real pair still correlates (both channels are finite numbers);
    // it only drops out of the relative-error statistics, where it is counted.
    expect(report.pairCount).toBe(4);
    expect(report.excludedPairCount).toBe(1);
    expect(report.exclusionReasons).toEqual({
      'non-finite-value': 1,
      'zero-real-value': 1,
    });
    // MMRV only covers pairs that admit a relative error.
    expect(report.mmrv).toEqual({ ...report.mmrv, count: 3 });
  });

  it('reports null MMRV when no pair can carry a relative error', () => {
    const report = summarizeSimRealCorrelation([
      { runId: 'a', simValue: 1, realValue: 0 },
      { runId: 'b', simValue: 2, realValue: 0 },
      { runId: 'c', simValue: 3, realValue: 0 },
    ]);
    expect(report.mmrv).toEqual({ value: null, reason: 'no-relative-error-pairs' });
    // The real channel is constant zero: no correlation is definable either.
    expect(report.pearson).toEqual({ value: null, reason: 'zero-variance' });
  });

  it('never fabricates correlations from empty input', () => {
    const report = summarizeSimRealCorrelation([]);
    expect(report.pairCount).toBe(0);
    expect(report.pearson).toEqual({ value: null, reason: 'insufficient-pairs' });
    expect(report.mmrv).toEqual({ value: null, reason: 'no-relative-error-pairs' });
  });
});
