import { describe, expect, it } from 'vitest';

import { normalizeTaskEvaluationEvidence } from './task-evaluation.js';

describe('Task-Pack evaluation boundary', () => {
  it('keeps only bounded release evidence fields', () => {
    const normalized = normalizeTaskEvaluationEvidence({
      schemaVersion: 1,
      taskId: 'originbot-goal-navigation',
      adapterId: 'rdk-originbot',
      trained: {
        meanReward: 4.2,
        episodesPerEnvelope: 50,
        confidenceLevel: 0.95,
        envelopes: {
          nominal: {
            successRate: 0.88,
            collisionRate: 0,
            episodes: 50,
            successRateCiLow: 0.756,
            ignored: 'not persisted',
          },
        },
      },
      qualityGate: {
        passed: true,
        criteria: {
          minSuccessRate: 0.7,
          maxCollisionRate: 0.15,
          gateOn: 'ciLowerBound',
        },
      },
      unknownLargeObject: { secret: 'discarded' },
      reportSha256: 'A'.repeat(64),
    });

    expect(normalized).toMatchObject({
      taskId: 'originbot-goal-navigation',
      trained: {
        envelopes: { nominal: { successRate: 0.88, episodes: 50 } },
      },
      qualityGate: { criteria: { gateOn: 'ciLowerBound' } },
      reportSha256: 'a'.repeat(64),
    });
    expect(normalized).not.toHaveProperty('unknownLargeObject');
    expect(normalized?.trained?.envelopes?.nominal).not.toHaveProperty('ignored');
  });

  it('rejects an invalid task identity and never coerces null/string metrics to zero', () => {
    expect(normalizeTaskEvaluationEvidence({ taskId: '../escape' })).toBeUndefined();
    const normalized = normalizeTaskEvaluationEvidence({
      taskId: 'safe-task',
      trained: {
        envelopes: {
          nominal: { successRate: '0.99', collisionRate: null, episodes: '50' },
        },
      },
    });
    expect(normalized?.trained).toBeUndefined();
  });

  it('caps envelope and error collections at the trust boundary', () => {
    const envelopes = Object.fromEntries(
      Array.from({ length: 20 }, (_item, index) => [
        `envelope${index}`,
        { successRate: 0.5, collisionRate: 0.1, episodes: 30 },
      ]),
    );
    const normalized = normalizeTaskEvaluationEvidence({
      taskId: 'safe-task',
      trained: { envelopes },
      qualityGate: {
        errors: Array.from({ length: 50 }, (_item, index) => `error-${index}`),
      },
    });
    expect(Object.keys(normalized?.trained?.envelopes ?? {})).toHaveLength(8);
    expect(normalized?.qualityGate?.errors).toHaveLength(32);
  });
});

/**
 * The MicroDuck evaluation engine (engines/microduck-eval) emits envelope
 * metrics beyond the navigation ones. Those extra numbers are the difference
 * between "0% success" and "0% success, ball never moved, trunk hit the floor
 * at 4 cm" — so the untrusted-input boundary must keep them instead of
 * silently dropping them.
 */
describe('MicroDuck evaluation evidence', () => {
  const microduckReport = {
    schemaVersion: 1,
    taskId: 'ball-kick',
    adapterId: 'microduck-cpu-eval',
    observationAdapterId: 'microduck-61d-v1',
    trained: {
      envelopes: {
        nominal: {
          episodes: 50,
          successRate: 0,
          successRateCiLow: 0,
          successRateCiHigh: 0.0713,
          collisionRate: 1,
          collisionRateCiLow: 0.9287,
          collisionRateCiHigh: 1,
          fallRate: 1,
          fallRateCiLow: 0.9287,
          fallRateCiHigh: 1,
          meanEpisodeLength: 4,
          meanReward: 0,
          ballTravelM: 0,
          ballTravelMStd: 0,
          ballPeakSpeedMps: 0,
          minBaseHeightM: 0.0425,
          maxTiltRad: 3.129,
        },
        hard: { episodes: 50, successRate: 1, successRateCiLow: 0.9287, successRateCiHigh: 1 },
      },
    },
    baseline: {
      envelopes: {
        nominal: { episodes: 50, successRate: 0, successRateCiLow: 0, successRateCiHigh: 0.0713 },
      },
    },
    qualityGate: {
      passed: false,
      errors: ['success rate 0.0000 (ciLowerBound) is below the required 0.7000'],
      criteria: { minSuccessRate: 0.7, maxCollisionRate: 0.1, gateOn: 'ciLowerBound' },
    },
    seed: 20260916,
    controlLatencyMs: 12.5,
  };

  it('keeps task-level measurements in physical units', () => {
    const nominal = normalizeTaskEvaluationEvidence(microduckReport)?.trained?.envelopes?.nominal;
    expect(nominal?.measurements).toEqual({
      ballTravelM: 0,
      ballTravelMStd: 0,
      ballPeakSpeedMps: 0,
      minBaseHeightM: 0.0425,
      maxTiltRad: 3.129,
    });
  });

  it('promotes fall rate and episode length to first-class fields', () => {
    const nominal = normalizeTaskEvaluationEvidence(microduckReport)?.trained?.envelopes?.nominal;
    expect(nominal?.fallRate).toBe(1);
    expect(nominal?.fallRateCiLow).toBeCloseTo(0.9287, 4);
    expect(nominal?.fallRateCiHigh).toBe(1);
    expect(nominal?.meanEpisodeLength).toBe(4);
    // Measurements must not duplicate the fields that already have a home.
    expect(nominal?.measurements).not.toHaveProperty('fallRate');
    expect(nominal?.measurements).not.toHaveProperty('episodes');
    expect(nominal?.measurements).not.toHaveProperty('successRate');
  });

  it('carries the frozen envelope set and gate criteria through', () => {
    const normalized = normalizeTaskEvaluationEvidence(microduckReport);
    expect(Object.keys(normalized?.trained?.envelopes ?? {})).toEqual(['nominal', 'hard']);
    expect(normalized?.qualityGate?.criteria).toEqual({
      minSuccessRate: 0.7,
      maxCollisionRate: 0.1,
      gateOn: 'ciLowerBound',
    });
    expect(normalized?.qualityGate?.passed).toBe(false);
    expect(normalized?.seed).toBe(20260916);
  });

  it('still rejects junk instead of laundering it into measurements', () => {
    const nominal = normalizeTaskEvaluationEvidence({
      taskId: 'ball-kick',
      trained: {
        envelopes: {
          nominal: {
            episodes: 50,
            successRate: 0.5,
            'bad-key': 1,
            evilKey: Number.POSITIVE_INFINITY,
            note: 'a string is not a measurement',
            nested: { deep: 1 },
            okRad: 1.5,
          },
        },
      },
    })?.trained?.envelopes?.nominal;
    expect(nominal?.measurements).toEqual({ okRad: 1.5 });
  });

  it('caps how many measurements one envelope can smuggle in', () => {
    const metrics: Record<string, number> = { episodes: 50, successRate: 1 };
    for (let index = 0; index < 60; index += 1) metrics[`metric${index}`] = index;
    const nominal = normalizeTaskEvaluationEvidence({
      taskId: 'ball-kick',
      trained: { envelopes: { nominal: metrics } },
    })?.trained?.envelopes?.nominal;
    expect(Object.keys(nominal?.measurements ?? {})).toHaveLength(24);
  });
});
