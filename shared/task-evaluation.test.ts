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
