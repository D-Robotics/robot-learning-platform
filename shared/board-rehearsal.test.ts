import { describe, expect, it } from 'vitest';
import {
  BOARD_REHEARSAL_MAX_AGE_MS,
  BOARD_REHEARSAL_MIN_SAMPLES,
  parseBoardLatencyReceipt,
  summarizeBoardRehearsal,
  validateBoardRehearsalReceipt,
} from './board-rehearsal.js';
import { validateArtifactForDeployment } from './artifact-quality-gate.js';

const SHA = 'a'.repeat(64);
const NOW = Date.parse('2026-09-16T12:00:00Z');
const measuredAt = new Date(NOW - 60_000).toISOString();

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    measuredAt,
    tool: 'board-latency-rehearsal/1',
    stage: 'board-onnx',
    device: { host: 'x5-01', machine: 'aarch64', boardModel: 'RDK X5' },
    artifactSha256: SHA,
    artifactBytes: 90_210,
    decisionHz: 50,
    provider: 'CPUExecutionProvider',
    metrics: [
      {
        name: 'inference',
        samples: 300,
        medianMs: 1.4,
        p95Ms: 1.9,
        maxMs: 3.2,
        overBudgetRatio: 0,
        budgetMs: 20,
      },
      {
        name: 'control-step',
        samples: 300,
        medianMs: 2.1,
        p95Ms: 2.8,
        maxMs: 4.4,
        overBudgetRatio: 0,
        budgetMs: 20,
      },
    ],
    budgetMet: true,
    ...overrides,
  };
}

describe('board latency rehearsal receipt', () => {
  it('accepts a fresh in-budget board measurement', () => {
    const verdict = validateBoardRehearsalReceipt(receipt(), { now: NOW, artifactSha256: SHA });
    expect(verdict.errors).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(verdict.stage).toBe('board-onnx');
    // The whole-step figure gates, not the (always smaller) inference figure.
    expect(verdict.judgedMetric).toBe('control-step');
  });

  it('refuses a host measurement as deployment evidence', () => {
    const verdict = validateBoardRehearsalReceipt(receipt({ stage: 'host-torch' }), { now: NOW });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/only a board-onnx measurement/);
  });

  it('treats an undeclared stage as unknown rather than a board claim', () => {
    const { stage } = receipt();
    expect(stage).toBe('board-onnx');
    const undeclared = receipt();
    delete undeclared.stage;
    const verdict = validateBoardRehearsalReceipt(undeclared, { now: NOW });
    expect(verdict.stage).toBe('unknown');
    expect(verdict.passed).toBe(false);
  });

  it('rejects an unknown stage string instead of ignoring it', () => {
    const verdict = validateBoardRehearsalReceipt(receipt({ stage: 'gpu-cluster' }), { now: NOW });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/unknown measurement stage/);
  });

  it('cannot certify a different artifact', () => {
    const verdict = validateBoardRehearsalReceipt(receipt(), {
      now: NOW,
      artifactSha256: 'b'.repeat(64),
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/describes artifact a{64}/);
  });

  it('expires a stale rehearsal', () => {
    const stale = new Date(NOW - BOARD_REHEARSAL_MAX_AGE_MS - 86_400_000).toISOString();
    const verdict = validateBoardRehearsalReceipt(receipt({ measuredAt: stale }), { now: NOW });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/cannot certify a deployment/);
  });

  it('refuses a future-dated receipt', () => {
    const future = new Date(NOW + 3_600_000).toISOString();
    const verdict = validateBoardRehearsalReceipt(receipt({ measuredAt: future }), { now: NOW });
    expect(verdict.errors.join(' ')).toMatch(/in the future/);
  });

  it('re-derives budgetMet instead of trusting the producer boolean', () => {
    const over = receipt({
      metrics: [
        {
          name: 'control-step',
          samples: 300,
          medianMs: 0.4,
          p95Ms: 21,
          maxMs: 63,
          overBudgetRatio: 0.02,
          budgetMs: 20,
        },
      ],
      budgetMet: true,
    });
    const verdict = validateBoardRehearsalReceipt(over, { now: NOW });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/disagrees with its own metrics/);
  });

  it('fails when the median alone exceeds the budget', () => {
    const slow = receipt({
      metrics: [
        {
          name: 'inference',
          samples: 300,
          medianMs: 25,
          p95Ms: 31,
          maxMs: 40,
          overBudgetRatio: 1,
          budgetMs: 20,
        },
      ],
      budgetMet: false,
    });
    const verdict = validateBoardRehearsalReceipt(slow, { now: NOW });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/exceeds the 20.000 ms budget/);
  });

  it('rejects an unordered distribution', () => {
    const verdict = validateBoardRehearsalReceipt(
      receipt({
        metrics: [
          {
            name: 'inference',
            samples: 300,
            medianMs: 3,
            p95Ms: 2,
            maxMs: 4,
            overBudgetRatio: 0,
            budgetMs: 20,
          },
        ],
      }),
      { now: NOW },
    );
    expect(verdict.errors.join(' ')).toMatch(/percentiles must satisfy/);
  });

  it('rejects a sample count too small to support a verdict', () => {
    const verdict = validateBoardRehearsalReceipt(
      receipt({
        metrics: [
          {
            name: 'inference',
            samples: BOARD_REHEARSAL_MIN_SAMPLES - 1,
            medianMs: 1,
            p95Ms: 1.2,
            maxMs: 1.4,
            overBudgetRatio: 0,
            budgetMs: 20,
          },
        ],
      }),
      { now: NOW },
    );
    expect(verdict.errors.join(' ')).toMatch(/below the 100-sample minimum/);
  });

  it('rejects a self-contradicting over-budget ratio', () => {
    const verdict = validateBoardRehearsalReceipt(
      receipt({
        metrics: [
          {
            name: 'inference',
            samples: 300,
            medianMs: 1,
            p95Ms: 1.2,
            maxMs: 30,
            overBudgetRatio: 0,
            budgetMs: 20,
          },
        ],
      }),
      { now: NOW },
    );
    expect(verdict.errors.join(' ')).toMatch(/maxMs exceeds the budget but overBudgetRatio is 0/);
  });

  it('reports a missing receipt only when a deployment is claimed', () => {
    expect(validateBoardRehearsalReceipt(undefined, { deployable: true }).passed).toBe(false);
    expect(validateBoardRehearsalReceipt(undefined, { deployable: true }).errors.join(' ')).toMatch(
      /no board latency rehearsal receipt/,
    );
    const quiet = validateBoardRehearsalReceipt(undefined, { deployable: false });
    expect(quiet.passed).toBe(false);
    expect(quiet.errors).toEqual([]);
  });

  it('surfaces schema errors without inventing a verdict', () => {
    const parsed = parseBoardLatencyReceipt({ schemaVersion: 99 });
    expect(parsed.receipt).toBeNull();
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('summarizes a receipt for display with its stage named', () => {
    const summary = summarizeBoardRehearsal(receipt({ stage: 'host-onnx' }));
    expect(summary.summary).toMatch(/训练主机 ONNX 前向/);
    expect(summary.summary).toMatch(/p50 2\.100 ms/);
  });
});

describe('deployment gate with board rehearsal', () => {
  const artifact = {
    observationSize: 61,
    actionSize: 14,
    manifestObservationSize: 61,
    manifestActionSize: 14,
    hasArtifactRef: true,
    deployable: true,
    maxAbsAction: 0.9,
  };

  it('confirms a deployable artifact that has board evidence', () => {
    expect(
      validateArtifactForDeployment(artifact, {
        boardRehearsal: receipt(),
        artifactSha256: SHA,
        now: NOW,
      }).passed,
    ).toBe(true);
  });

  it('blocks a deployable artifact with no rehearsal', () => {
    const verdict = validateArtifactForDeployment(artifact, { now: NOW });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/no board latency rehearsal receipt/);
  });

  it('blocks a deployable artifact whose only measurement is on the training host', () => {
    const verdict = validateArtifactForDeployment(artifact, {
      boardRehearsal: receipt({ stage: 'host-torch' }),
      now: NOW,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(/only a board-onnx measurement/);
  });

  it('still blocks an otherwise-unsafe artifact even with a passing rehearsal', () => {
    const verdict = validateArtifactForDeployment(
      { ...artifact, actionSize: 3, maxAbsAction: 2 },
      { boardRehearsal: receipt(), now: NOW },
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.errors).toContain('action dimension mismatch');
    expect(verdict.errors).toContain('action exceeds normalized limit');
  });

  it('does not demand board evidence from a non-deployable artifact', () => {
    expect(
      validateArtifactForDeployment({ ...artifact, deployable: false }, { now: NOW }).errors,
    ).toEqual(['artifact is marked non-deployable']);
  });
});
