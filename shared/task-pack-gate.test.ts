import { describe, expect, it } from 'vitest';
import { validateTaskPackEvalForRelease } from './artifact-quality-gate.js';

describe('task-pack eval release gate', () => {
  it('recomputes PASS from strong metrics even when the engine flag is false', () => {
    // The TS side never trusts the engine boolean: metrics are the truth.
    const verdict = validateTaskPackEvalForRelease({
      taskId: 'originbot-goal-navigation',
      report: {
        taskId: 'originbot-goal-navigation',
        qualityGate: { passed: false, criteria: { minSuccessRate: 0.7, maxCollisionRate: 0.15 } },
        trained: { envelopes: { nominal: { successRate: 0.83, collisionRate: 0.0, meanReward: 8.8 } } },
      },
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.successRate).toBeCloseTo(0.83);
    expect(verdict.collisionRate).toBe(0);
  });

  it('fails closed on missing report, missing metrics, and weak metrics', () => {
    expect(validateTaskPackEvalForRelease({ taskId: 't', report: null, requireReport: true }).passed).toBe(false);
    expect(
      validateTaskPackEvalForRelease({ taskId: 't', report: { taskId: 't', qualityGate: { criteria: { minSuccessRate: 0.7 } } } }).errors,
    ).toContain('nominal envelope metrics missing from eval report');
    const weak = validateTaskPackEvalForRelease({
      taskId: 't',
      report: {
        taskId: 't',
        qualityGate: { criteria: { minSuccessRate: 0.7, maxCollisionRate: 0.15 } },
        trained: { envelopes: { nominal: { successRate: 0.5, collisionRate: 0.3 } } },
      },
    });
    expect(weak.passed).toBe(false);
    expect(weak.errors.some((error) => error.includes('below gate'))).toBe(true);
    expect(weak.errors.some((error) => error.includes('above gate'))).toBe(true);
  });

  it('rejects a report produced for a different task', () => {
    const verdict = validateTaskPackEvalForRelease({
      taskId: 'originbot-goal-navigation',
      report: {
        taskId: 'generic-goal-navigation',
        qualityGate: { criteria: { minSuccessRate: 0.7 } },
        trained: { envelopes: { nominal: { successRate: 0.9, collisionRate: 0.0 } } },
      },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors[0]).toContain('task mismatch');
  });

  it('ignores the hard envelope for the release verdict but keeps it measurable', () => {
    // Only the nominal envelope gates release; the hard envelope informs
    // humans about robustness, never the deploy decision.
    const verdict = validateTaskPackEvalForRelease({
      taskId: 't',
      report: {
        taskId: 't',
        qualityGate: { criteria: { minSuccessRate: 0.7, maxCollisionRate: 0.15 } },
        trained: { envelopes: { nominal: { successRate: 0.83, collisionRate: 0.0 }, hard: { successRate: 0.1, collisionRate: 0.9 } } },
      },
    });
    expect(verdict.passed).toBe(true);
  });
});
