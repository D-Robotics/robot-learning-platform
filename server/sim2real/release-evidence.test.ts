import { describe, expect, it } from 'vitest';

import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { validateRunForDeployment } from './release-evidence.js';

function run(overrides: Partial<Sim2RealRunRecord> = {}): Sim2RealRunRecord {
  return {
    id: 'run-1',
    modelId: 'model-1',
    backend: 'local',
    status: 'completed',
    summary: 'done',
    taskId: 'originbot-goal-navigation',
    metrics: {
      contractValid: true,
      observationSize: 8,
      actionSize: 2,
      successRate: 0.88,
    },
    artifact: {
      artifactId: 'policy-1',
      artifactRef: 'artifact://starter/model-1/policy.onnx',
      kind: 'source',
      format: 'onnx',
      sha256: 'a'.repeat(64),
      deployable: true,
    },
    taskEvaluation: {
      taskId: 'originbot-goal-navigation',
      qualityGate: {
        criteria: {
          minSuccessRate: 0.7,
          maxCollisionRate: 0.15,
          gateOn: 'ciLowerBound',
        },
      },
      trained: {
        envelopes: {
          nominal: {
            successRate: 0.88,
            collisionRate: 0,
            episodes: 50,
            successRateCiLow: 0.7562,
            successRateCiHigh: 0.9438,
            collisionRateCiLow: 0,
            collisionRateCiHigh: 0.0713,
          },
          hard: {
            successRate: 0.72,
            collisionRate: 0.02,
            episodes: 50,
            successRateCiLow: 0.5833,
            successRateCiHigh: 0.8253,
            collisionRateCiLow: 0.0035,
            collisionRateCiHigh: 0.105,
          },
        },
      },
      baseline: {
        envelopes: {
          nominal: { successRate: 0, collisionRate: 0, episodes: 50 },
        },
      },
    },
    createdAt: '2026-09-10T00:00:00.000Z',
    finishedAt: '2026-09-10T00:05:00.000Z',
    ...overrides,
  };
}

describe('deployment release evidence', () => {
  it('keeps read-only preflight available without a training run', () => {
    expect(validateRunForDeployment({ mode: 'preflight', modelId: 'model-1' })).toMatchObject({
      passed: true,
      checks: { preflightOnly: true },
    });
  });

  it('accepts a real completed artifact only after recomputing the Task-Pack gate', () => {
    const verdict = validateRunForDeployment({
      mode: 'canary',
      modelId: 'model-1',
      run: run(),
      checkedAt: '2026-09-10T01:00:00.000Z',
    });
    expect(verdict).toMatchObject({
      passed: true,
      runId: 'run-1',
      taskId: 'originbot-goal-navigation',
      checks: { taskGatePassed: true, artifactDigestPresent: true },
    });
  });

  it.each([
    ['missing run', null],
    ['mock run', run({ mock: true })],
    ['wrong model', run({ modelId: 'model-2' })],
    ['unfinished run', run({ status: 'running' })],
    ['unsigned artifact', run({ artifact: { ...run().artifact!, sha256: undefined } })],
    ['non-deployable artifact', run({ artifact: { ...run().artifact!, deployable: false } })],
  ])('fails closed for %s', (_label, candidate) => {
    expect(
      validateRunForDeployment({ mode: 'canary', modelId: 'model-1', run: candidate }).passed,
    ).toBe(false);
  });

  it('rejects a forged Task-Pack PASS when the measured confidence floor fails', () => {
    const weak = run();
    weak.taskEvaluation!.qualityGate!.passed = true;
    weak.taskEvaluation!.trained!.envelopes!.nominal = {
      successRate: 0.72,
      collisionRate: 0,
      episodes: 50,
      successRateCiLow: 0.5833,
      successRateCiHigh: 0.8253,
      collisionRateCiLow: 0,
      collisionRateCiHigh: 0.0713,
    };
    const verdict = validateRunForDeployment({ mode: 'canary', modelId: 'model-1', run: weak });
    expect(verdict.passed).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('CI low')]),
    );
  });
});
