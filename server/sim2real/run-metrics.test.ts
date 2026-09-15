import { describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import { requestRobogoTrainingStatus } from './robogo-runner.js';

/**
 * parseRunResult (reached here through requestRobogoTrainingStatus with a
 * stubbed fetch) is the boundary where engine-reported metrics enter the
 * platform run ledger. These tests pin the engine self-labeling fields
 * (physicsBackend / engine) the run detail UI reads: they must pass
 * through for well-formed identifiers and be stripped for anything a
 * hostile worker might smuggle through the safe-charset gate.
 */

const runner = 'https://runner.example.test';

function statusFetch(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

const baseMetrics = {
  contractValid: true,
  observationSize: 8,
  actionSize: 2,
};

describe('run metrics engine labeling (safeMetrics passthrough)', () => {
  it('passes through honest engine self-labels to the run record', async () => {
    const result = await requestRobogoTrainingStatus({
      accountId: 'alice',
      runId: 'run-mjx-1',
      manifest: BUILTIN_MICRODUCK_MODEL.manifest,
      runnerUrl: `${runner}/status`,
      fetchImpl: statusFetch({
        status: 'completed',
        metrics: {
          ...baseMetrics,
          physicsBackend: 'mjx',
          engine: 'mjx-ppo',
          successRate: 0.42,
          iterations: 2,
        },
      }),
    });
    expect(result.metrics?.physicsBackend).toBe('mjx');
    expect(result.metrics?.engine).toBe('mjx-ppo');
    // existing numeric fields keep flowing
    expect(result.metrics?.successRate).toBe(0.42);
    expect(result.metrics?.iterations).toBe(2);
  });

  it('passes through the kinematic fallback label for comparison runs', async () => {
    const result = await requestRobogoTrainingStatus({
      accountId: 'alice',
      runId: 'run-fallback-1',
      manifest: BUILTIN_MICRODUCK_MODEL.manifest,
      runnerUrl: `${runner}/status`,
      fetchImpl: statusFetch({
        status: 'completed',
        metrics: { ...baseMetrics, physicsBackend: 'starter-kinematic', engine: 'mjx-ppo' },
      }),
    });
    expect(result.metrics?.physicsBackend).toBe('starter-kinematic');
  });

  it('strips labels outside the safe identifier charset', async () => {
    for (const [key, value] of [
      ['physicsBackend', '<script>alert(1)</script>'],
      ['engine', 'engine with spaces!'],
      ['physicsBackend', 'leading space'],
      ['engine', 'a'.repeat(65)],
      ['physicsBackend', 123],
    ] as const) {
      const result = await requestRobogoTrainingStatus({
        accountId: 'alice',
        runId: 'run-hostile',
        manifest: BUILTIN_MICRODUCK_MODEL.manifest,
        runnerUrl: `${runner}/status`,
        fetchImpl: statusFetch({
          status: 'completed',
          metrics: { ...baseMetrics, [key]: value },
        }),
      });
      expect(result.metrics, `${key}=${JSON.stringify(value)}`).toBeDefined();
      expect(result.metrics?.[key], `${key}=${JSON.stringify(value)}`).toBeUndefined();
      // the run stays valid; only the hostile field is dropped
      expect(result.metrics?.contractValid).toBe(true);
    }
  });

  it('keeps treating malformed metrics cores as absent (no regression)', async () => {
    for (const metrics of [
      null,
      'nope',
      { contractValid: 'yes', observationSize: 8, actionSize: 2 },
      { ...baseMetrics, observationSize: 0 },
    ]) {
      const result = await requestRobogoTrainingStatus({
        accountId: 'alice',
        runId: 'run-bad',
        manifest: BUILTIN_MICRODUCK_MODEL.manifest,
        runnerUrl: `${runner}/status`,
        fetchImpl: statusFetch({ status: 'completed', metrics }),
      });
      expect(result.metrics).toBeUndefined();
    }
  });
});
