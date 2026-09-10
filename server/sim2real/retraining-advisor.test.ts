import { describe, expect, it } from 'vitest';

import { adviseRetraining } from './retraining-advisor.js';
import type { Sim2RealRunRecord } from '../../shared/sim2real.js';

function baseRun(): Sim2RealRunRecord {
  return {
    id: 'run-adv-1',
    modelId: 'model-adv',
    backend: 'local',
    status: 'completed',
    summary: 'completed local run',
    taskId: 'originbot-goal-navigation',
    createdAt: '2026-09-10T00:00:00.000Z',
    training: {
      profile: 'standard',
      numEnvs: 8,
      maxIterations: 800,
      video: false,
      algorithm: 'sac',
    },
  } as Sim2RealRunRecord;
}

function boardEvaluation(sampleCount: number, actionMae?: number) {
  return {
    evaluatedAt: '2026-09-10T12:00:00.000Z',
    sampleCount,
    ...(actionMae == null ? {} : { actionMae }),
    replay: { sampleCount, source: 'board-agent' as const, chunkCount: 1, droppedCount: 0 },
  };
}

function samples(count: number, opts: { done?: boolean; zeroed?: boolean } = {}) {
  const observation = opts.zeroed
    ? [0, 0, 0, 0, 0, 0, 0, 0]
    : [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  return Array.from({ length: count }, () => ({
    t: 1,
    observation,
    action: [0.1, 0.2],
    ...(opts.done ? { done: true } : {}),
  }));
}

describe('retraining advisor (flywheel read-only half)', () => {
  it('says insufficient-evidence below the board sample floor, never a silent pass', () => {
    const advice = adviseRetraining({
      run: baseRun(),
      evaluation: boardEvaluation(30, 0.9),
      telemetry: [{ samples: samples(30) } as never],
    });
    expect(advice.verdict).toBe('insufficient-evidence');
    expect(advice.suggestedTraining).toBeUndefined();
    expect(advice.summary).toContain('30/120');
  });

  it('recommends retraining when action MAE breaches the advisory threshold', () => {
    const advice = adviseRetraining({
      run: baseRun(),
      evaluation: boardEvaluation(200, 0.4),
      telemetry: [{ samples: samples(200) } as never],
    });
    expect(advice.verdict).toBe('retrain-recommended');
    const mae = advice.signals.find((signal) => signal.id === 'action-mae');
    expect(mae?.breached).toBe(true);
    // The suggestion carries the run's own task/algorithm and local backend —
    // but it is a request body for the operator, never auto-submitted.
    expect(advice.suggestedTraining).toMatchObject({
      taskId: 'originbot-goal-navigation',
      backend: 'local',
      training: { profile: 'standard', algorithm: 'sac' },
    });
    expect(advice.note).toContain('绝不自动发起');
  });

  it('flags termination-heavy and stale-observation telemetry windows', () => {
    const advice = adviseRetraining({
      run: baseRun(),
      evaluation: boardEvaluation(300, 0.1),
      telemetry: [
        { samples: [...samples(100), ...samples(200, { done: true, zeroed: true })] } as never,
      ],
    });
    expect(advice.verdict).toBe('retrain-recommended');
    expect(advice.signals.find((s) => s.id === 'done-ratio')?.breached).toBe(true);
    expect(advice.signals.find((s) => s.id === 'stale-observation-ratio')?.breached).toBe(true);
    expect(advice.signals.find((s) => s.id === 'action-mae')?.breached).toBe(false);
  });

  it('stays healthy when all signals sit inside the advisory thresholds', () => {
    const advice = adviseRetraining({
      run: baseRun(),
      evaluation: boardEvaluation(200, 0.05),
      telemetry: [{ samples: samples(200) } as never],
    });
    expect(advice.verdict).toBe('healthy');
    expect(advice.suggestedTraining).toBeUndefined();
    expect(advice.boardSamples).toBe(200);
  });

  it('never counts non-board replay provenance as drift evidence', () => {
    const advice = adviseRetraining({
      run: baseRun(),
      evaluation: {
        evaluatedAt: '2026-09-10T12:00:00.000Z',
        sampleCount: 500,
        actionMae: 0.9,
        replay: { sampleCount: 500, source: 'import' as never, chunkCount: 2, droppedCount: 0 },
      },
    });
    expect(advice.verdict).toBe('insufficient-evidence');
    expect(advice.boardSamples).toBe(0);
  });

  it('reports null-valued signals with honest evidence strings', () => {
    const advice = adviseRetraining({
      run: baseRun(),
      evaluation: boardEvaluation(200),
      telemetry: [],
    });
    expect(advice.verdict).toBe('healthy');
    const done = advice.signals.find((s) => s.id === 'done-ratio');
    expect(done?.value).toBeNull();
    expect(done?.evidence).toContain('没有遥测样本');
  });
});
