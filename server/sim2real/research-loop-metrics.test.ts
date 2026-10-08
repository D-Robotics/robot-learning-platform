import { describe, expect, it } from 'vitest';

import {
  computeResearchLoopMetrics,
  type ResearchLoopMetricsInput,
} from './research-loop-metrics.js';

const NOW_MS = Date.parse('2026-10-06T12:00:00.000Z');

function baseInput(overrides: Partial<ResearchLoopMetricsInput> = {}): ResearchLoopMetricsInput {
  return {
    runs: [],
    agentRuns: [],
    resources: [],
    nowMs: NOW_MS,
    windowDays: 30,
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    backend: 'local',
    status: 'completed',
    createdAt: '2026-10-05T10:00:00.000Z',
    finishedAt: '2026-10-05T12:00:00.000Z',
    ...overrides,
  };
}

describe('computeResearchLoopMetrics', () => {
  it('returns an empty, well-formed summary for an empty ledger', () => {
    const summary = computeResearchLoopMetrics(baseInput());
    expect(summary.runs).toEqual({
      total: 0,
      completed: 0,
      byRequestedVia: { agent: 0, workbench: 0, unattributed: 0 },
      agentShareOfAttributedPct: null,
    });
    expect(summary.loopLatency.training).toEqual({ sampleCount: 0, p50Ms: null, p90Ms: null });
    expect(summary.loopLatency.byBackend).toEqual([]);
    expect(summary.marginalReturns).toEqual([]);
    expect(summary.experimentCount).toBe(0);
    expect(summary.walls.oldestQueuedWaitMs).toBeNull();
    expect(summary.window).toEqual({
      days: 30,
      sinceIso: '2026-09-06T12:00:00.000Z',
    });
  });

  it('computes nearest-rank p50/p90 training latency and per-backend breakdown', () => {
    // Five runs: durations 1h, 2h, 3h, 4h, 5h → p50 = 3h (nearest rank),
    // p90 = ceil(0.9*5) = 5th sample = 5h.
    const runs = [1, 2, 3, 4, 5].map((hours, index) =>
      run({
        createdAt: `2026-10-05T10:00:00.000Z`,
        finishedAt: new Date(
          Date.parse('2026-10-05T10:00:00.000Z') + hours * 3_600_000,
        ).toISOString(),
        backend: index % 2 === 0 ? 'local' : 'robogo',
      }),
    );
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    expect(summary.loopLatency.training.sampleCount).toBe(5);
    expect(summary.loopLatency.training.p50Ms).toBe(3 * 3_600_000);
    expect(summary.loopLatency.training.p90Ms).toBe(5 * 3_600_000);
    const local = summary.loopLatency.byBackend.find((item) => item.backend === 'local');
    const robogo = summary.loopLatency.byBackend.find((item) => item.backend === 'robogo');
    expect(local?.sampleCount).toBe(3);
    expect(robogo?.sampleCount).toBe(2);
  });

  it('excludes mock runs and non-training backends from latency statistics', () => {
    const runs = [
      run({ mock: true }),
      run({ backend: 'contract', status: 'completed' }),
      run({ backend: 'browser', status: 'completed' }),
      run({ status: 'failed' }),
      run({ finishedAt: '2026-10-05T09:00:00.000Z' }), // finished before start → invalid
    ];
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    expect(summary.loopLatency.training.sampleCount).toBe(0);
    // Mock, contract and browser completed runs still count as completed —
    // only the latency statistics exclude them.
    expect(summary.runs.completed).toBe(4);
  });

  it('measures run→evaluation latency when an evaluation timestamp exists', () => {
    const runs = [
      run({ evaluation: { evaluatedAt: '2026-10-05T13:00:00.000Z' } }),
      run({ evaluation: { evaluatedAt: '2026-10-05T09:30:00.000Z' } }), // before start → skipped
    ];
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    expect(summary.loopLatency.toEvaluation.sampleCount).toBe(1);
    expect(summary.loopLatency.toEvaluation.p50Ms).toBe(3 * 3_600_000);
  });

  it('counts run origins and keeps unattributed rows out of the share denominator', () => {
    const runs = [
      run({ requestedVia: 'agent' }),
      run({ requestedVia: 'agent' }),
      run({ requestedVia: 'workbench' }),
      run({}), // legacy row without a marker
    ];
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    expect(summary.runs.byRequestedVia).toEqual({
      agent: 2,
      workbench: 1,
      unattributed: 1,
    });
    expect(summary.runs.agentShareOfAttributedPct).toBe(66.7);
  });

  it('reports null agent share when no run carries an explicit origin', () => {
    const summary = computeResearchLoopMetrics(baseInput({ runs: [run()] }));
    expect(summary.runs.agentShareOfAttributedPct).toBeNull();
    expect(summary.runs.byRequestedVia.unattributed).toBe(1);
  });

  it('aggregates agent chain autonomy: approval-free steps, gates, and longest chain', () => {
    const agentRuns = [
      {
        intent: 'full-loop',
        status: 'completed',
        createdAt: '2026-10-06T10:00:00.000Z',
        steps: [
          { status: 'completed' },
          { status: 'completed' },
          { status: 'completed', requiresApproval: true },
          { status: 'completed' },
          { status: 'failed' },
        ],
      },
      {
        intent: 'gpu-train',
        status: 'running',
        createdAt: '2026-10-06T11:00:00.000Z',
        steps: [{ status: 'completed' }, { status: 'blocked' }, { status: 'pending' }],
      },
    ];
    const summary = computeResearchLoopMetrics(baseInput({ agentRuns }));
    expect(summary.autonomy.agentRunCount).toBe(2);
    expect(summary.autonomy.agentRunsByStatus).toEqual({ completed: 1, running: 1 });
    expect(summary.autonomy.agentRunsByIntent).toEqual({ 'full-loop': 1, 'gpu-train': 1 });
    expect(summary.autonomy.stepTotal).toBe(8);
    expect(summary.autonomy.approvalGatedSteps).toBe(1);
    expect(summary.autonomy.completedApprovalGatedSteps).toBe(1);
    expect(summary.autonomy.completedApprovalFreeSteps).toBe(4);
    expect(summary.autonomy.failedOrBlockedSteps).toBe(2);
    // Longest consecutive approval-free completed chain is 2 (steps 1-2 and
    // the single step after the gate; the failed step and the gate reset it).
    expect(summary.autonomy.longestApprovalFreeChainSteps).toBe(2);
  });

  it('classifies an improving experiment series on a maximized metric', () => {
    const runs = [10, 12, 16, 24].map((meanReturn, index) =>
      run({
        experimentId: 'exp-a',
        metrics: { meanReturn },
        createdAt: new Date(
          Date.parse('2026-10-01T00:00:00.000Z') + index * 86_400_000,
        ).toISOString(),
      }),
    );
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    expect(summary.experimentCount).toBe(1);
    const group = summary.marginalReturns[0];
    expect(group.experimentId).toBe('exp-a');
    expect(group.metric).toBe('metrics.meanReturn');
    expect(group.direction).toBe('maximize');
    expect(group.runCount).toBe(4);
    expect(group.netDelta).toBe(14);
    expect(group.trend).toBe('improving');
  });

  it('classifies a diminishing series and treats a minimized metric correctly', () => {
    // actionMae decreasing fast then barely: good direction is negative delta,
    // so later near-zero deltas are a diminishing series.
    const runs = [0.4, 0.3, 0.22, 0.21, 0.208].map((actionMae, index) =>
      run({
        experimentId: 'exp-b',
        evaluation: { actionMae },
        createdAt: new Date(
          Date.parse('2026-10-01T00:00:00.000Z') + index * 86_400_000,
        ).toISOString(),
      }),
    );
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    const group = summary.marginalReturns[0];
    expect(group.direction).toBe('minimize');
    expect(group.netDelta).toBeCloseTo(-0.192, 6);
    expect(group.trend).toBe('diminishing');
    // Diminishing: early good-direction gains outpace the later ones.
    expect(group.recentMeanDelta!).toBeLessThan(group.earlierMeanDelta!);
  });

  it('keeps a series homogeneous when later runs record a different metric', () => {
    const runs = [
      run({ experimentId: 'exp-c', metrics: { meanReturn: 5 } }),
      run({ experimentId: 'exp-c', metrics: { meanReturn: 7 } }),
      // Different metric: must not join the meanReturn series.
      run({ experimentId: 'exp-c', evaluation: { actionMae: 0.1 } }),
    ];
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    const group = summary.marginalReturns[0];
    expect(group.metric).toBe('metrics.meanReturn');
    expect(group.runCount).toBe(2);
    expect(group.trend).toBe('undetermined');
  });

  it('ignores single-run experiments and failed runs for returns', () => {
    const runs = [
      run({ experimentId: 'solo', metrics: { meanReturn: 3 } }),
      run({ experimentId: 'exp-d', status: 'failed', metrics: { meanReturn: 1 } }),
      run({ experimentId: 'exp-d', metrics: { meanReturn: 2 } }),
    ];
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    expect(summary.marginalReturns).toEqual([]);
    expect(summary.experimentCount).toBe(0);
  });

  it('summarizes walls from current state regardless of the window', () => {
    const runs = [
      run({ status: 'queued', createdAt: '2026-09-01T00:00:00.000Z' }), // outside window, still queued
      run({ status: 'running' }),
      run({ status: 'blocked' }),
      run({ status: 'failed' }),
    ];
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    expect(summary.walls.queued).toBe(1);
    expect(summary.walls.running).toBe(1);
    expect(summary.walls.blocked).toBe(1);
    expect(summary.walls.failed).toBe(1);
    // Oldest queued run started 2026-09-01 → wait spans the whole window.
    expect(summary.walls.oldestQueuedWaitMs).toBe(NOW_MS - Date.parse('2026-09-01T00:00:00.000Z'));
  });

  it('classifies compute resources by health freshness', () => {
    const summary = computeResearchLoopMetrics(
      baseInput({
        resources: [
          { status: 'online', healthFresh: true },
          { status: 'online', healthFresh: false },
          { status: 'offline' },
          { status: 'degraded' },
        ],
      }),
    );
    expect(summary.walls.computeResources).toEqual({
      total: 4,
      onlineFresh: 1,
      onlineStale: 1,
      offline: 1,
      other: 1,
    });
  });

  it('applies the look-back window to run-scoped statistics only', () => {
    const runs = [
      run({ createdAt: '2026-08-01T10:00:00.000Z', requestedVia: 'agent' }), // outside 30d window
      run({}),
    ];
    const summary = computeResearchLoopMetrics(baseInput({ runs }));
    expect(summary.runs.total).toBe(1);
    expect(summary.loopLatency.training.sampleCount).toBe(1);
    expect(summary.walls.queued).toBe(0);
  });

  it('clamps an out-of-range window to the supported bounds', () => {
    const clamped = computeResearchLoopMetrics(baseInput({ windowDays: 5000 }));
    expect(clamped.window.days).toBe(365);
    const floored = computeResearchLoopMetrics(baseInput({ windowDays: 0 }));
    expect(floored.window.days).toBe(30);
  });
});
