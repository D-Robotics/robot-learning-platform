import { describe, expect, it } from 'vitest';
import { validateTaskPackEvalForRelease, wilsonBounds } from './artifact-quality-gate.js';

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
    expect(verdict.gateOn).toBe('point');
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

  it('judges on the CI lower bound when gateOn=ciLowerBound (weak floor fails)', () => {
    // 50 episodes at 72% point success: Wilson 95% low is ~0.58, below the
    // 0.7 gate. The point estimate would pass; the floor must not.
    const bounds = wilsonBounds(36, 50);
    expect(bounds).not.toBeNull();
    const verdict = validateTaskPackEvalForRelease({
      taskId: 't',
      report: {
        taskId: 't',
        qualityGate: { criteria: { minSuccessRate: 0.7, maxCollisionRate: 0.15, gateOn: 'ciLowerBound' } },
        trained: { envelopes: { nominal: {
          successRate: 0.72, collisionRate: 0.02, episodes: 50,
          successRateCiLow: bounds!.low, successRateCiHigh: bounds!.high,
          collisionRateCiLow: 0.0, collisionRateCiHigh: 0.1,
        } } },
      },
    });
    expect(verdict.gateOn).toBe('ciLowerBound');
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.some((error) => error.includes('CI low') && error.includes('below gate'))).toBe(true);
  });

  it('passes a CI-gated report whose 50-episode floor clears the gate', () => {
    // 50 episodes, 44 successes (88%): Wilson 95% low ~0.76 clears 0.7.
    const success = wilsonBounds(44, 50)!;
    const collision = wilsonBounds(0, 50)!;
    const verdict = validateTaskPackEvalForRelease({
      taskId: 't',
      report: {
        taskId: 't',
        qualityGate: { criteria: { minSuccessRate: 0.7, maxCollisionRate: 0.15, gateOn: 'ciLowerBound' } },
        trained: { envelopes: { nominal: {
          successRate: 0.88, collisionRate: 0.0, episodes: 50,
          successRateCiLow: success.low, successRateCiHigh: success.high,
          collisionRateCiLow: collision.low, collisionRateCiHigh: collision.high,
        } } },
      },
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.successRateCiLow).not.toBeNull();
  });

  it('fails closed when gateOn=ciLowerBound but bounds are missing', () => {
    const verdict = validateTaskPackEvalForRelease({
      taskId: 't',
      report: {
        taskId: 't',
        qualityGate: { criteria: { minSuccessRate: 0.7, gateOn: 'ciLowerBound' } },
        trained: { envelopes: { nominal: { successRate: 0.9, collisionRate: 0.0 } } },
      },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.some((error) => error.includes('confidence bounds missing'))).toBe(true);
  });

  it('rejects hand-edited bounds that disagree with the recomputed interval', () => {
    const success = wilsonBounds(44, 50)!;
    const collision = wilsonBounds(0, 50)!;
    const verdict = validateTaskPackEvalForRelease({
      taskId: 't',
      report: {
        taskId: 't',
        qualityGate: { criteria: { minSuccessRate: 0.7, gateOn: 'ciLowerBound' } },
        trained: { envelopes: { nominal: {
          successRate: 0.88, collisionRate: 0.0, episodes: 50,
          // Forged floor: the recomputation must catch it.
          successRateCiLow: 0.95, successRateCiHigh: success.high,
          collisionRateCiLow: collision.low, collisionRateCiHigh: collision.high,
        } } },
      },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.some((error) => error.includes('CI low mismatch'))).toBe(true);
  });

  it('wilsonBounds: empty evidence is null, 6/6 has a ~0.61 floor, 50 eps tightens', () => {
    expect(wilsonBounds(6, 0)).toBeNull();
    const six = wilsonBounds(6, 6)!;
    expect(six.low).toBeGreaterThan(0.5);
    expect(six.low).toBeLessThan(0.7);  // 0.610: 6 episodes alone cannot certify a 0.7 gate
    const fifty = wilsonBounds(50, 50)!;
    expect(fifty.low).toBeGreaterThan(six.low);
  });
});
