import { describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import {
  isSim2RealRunnerOutcomeUnknown,
  isRobogoRunnerConfigured,
  normalizeRunnerUrl,
  requestRobogoTraining,
  requestRobogoTrainingStatus,
} from './robogo-runner.js';

describe('RoboGo Sim2Real runner adapter', () => {
  it('requires HTTPS for RoboGo, while local adapters explicitly opt into private HTTP', () => {
    expect(() => normalizeRunnerUrl('http://127.0.0.1:19090/train')).toThrow(
      'sim2real_robogo_runner_url_must_be_https',
    );
    expect(normalizeRunnerUrl('http://127.0.0.1:19090/train', { localHttp: true })).toBe(
      'http://127.0.0.1:19090/train',
    );
  });

  it('fails closed when no explicit runner URL is configured', async () => {
    await expect(
      requestRobogoTraining({
        accountId: 'alice',
        manifest: BUILTIN_MICRODUCK_MODEL.manifest,
        runnerUrl: '',
      }),
    ).rejects.toThrow('sim2real_robogo_runner_not_configured');
    expect(isRobogoRunnerConfigured('')).toBe(false);
  });

  it('only uses a process-wide RoboGo token when the caller explicitly allows private mode', async () => {
    const previous = process.env.RDK_SIM2REAL_ROBOGO_TOKEN;
    process.env.RDK_SIM2REAL_ROBOGO_TOKEN = 'private-env-token';
    const authorizations: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(String(new Headers(init?.headers).get('authorization') || ''));
      return new Response(JSON.stringify({ status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await requestRobogoTraining({
        accountId: 'alice',
        manifest: BUILTIN_MICRODUCK_MODEL.manifest,
        runnerUrl: 'https://runner.example.test/train',
        allowEnvironmentToken: true,
        fetchImpl,
      });
      await requestRobogoTraining({
        accountId: 'alice',
        manifest: BUILTIN_MICRODUCK_MODEL.manifest,
        runnerUrl: 'https://runner.example.test/train',
        allowEnvironmentToken: false,
        fetchImpl,
      });
      expect(authorizations).toEqual(['Bearer private-env-token', '']);
    } finally {
      if (previous === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_TOKEN;
      else process.env.RDK_SIM2REAL_ROBOGO_TOKEN = previous;
    }
  });

  it('posts only the normalized manifest and preserves the runner job id', async () => {
    let captured: { url: string; body: Record<string, unknown>; authorization: string } | undefined;
    const result = await requestRobogoTraining({
      accountId: 'alice',
      requestToken: 'Bearer session-token',
      manifest: BUILTIN_MICRODUCK_MODEL.manifest,
      training: { profile: 'smoke', numEnvs: 64, maxIterations: 5, video: false },
      taskId: 'kick',
      resumeFrom: {
        checkpointId: 'checkpoint-1500',
        artifactRef: 'artifact://microduck/checkpoint-1500',
        iteration: 1500,
      },
      runnerUrl: 'https://runner.example.test/v1/microduck/train',
      fetchImpl: (async (input, init) => {
        captured = {
          url: String(input),
          body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
          authorization: String(new Headers(init?.headers).get('authorization') || ''),
        };
        return new Response(
          JSON.stringify({
            status: 'running',
            runId: 'robogo-run-42',
            launchUrl: 'https://robogo.d-robotics.cc/runs/42',
            checkpoint: {
              checkpointId: 'checkpoint-1500',
              artifactRef: 'artifact://microduck/checkpoint-1500',
              iteration: 1500,
            },
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    expect(result).toMatchObject({
      status: 'running',
      externalRunId: 'robogo-run-42',
      launchUrl: 'https://robogo.d-robotics.cc/runs/42',
      checkpoint: {
        checkpointId: 'checkpoint-1500',
        artifactRef: 'artifact://microduck/checkpoint-1500',
        iteration: 1500,
      },
    });
    expect(captured).toMatchObject({
      url: 'https://runner.example.test/v1/microduck/train',
      authorization: 'Bearer session-token',
    });
    expect(captured?.body).toMatchObject({
      contractId: 'microduck-policy-v1',
      model: { modelId: 'microduck-official' },
      training: { profile: 'smoke', numEnvs: 64, maxIterations: 5 },
      taskId: 'kick',
      resumeFrom: { checkpointId: 'checkpoint-1500', iteration: 1500 },
    });
    expect(JSON.stringify(captured?.body)).not.toContain('shell');
  });

  it('does not expose an unsafe runner URL returned by the external service', async () => {
    const result = await requestRobogoTraining({
      accountId: 'alice',
      manifest: BUILTIN_MICRODUCK_MODEL.manifest,
      runnerUrl: 'https://runner.example.test/run',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ status: 'queued', runId: 'safe-run-1', url: 'javascript:alert(1)' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });

    expect(result).toMatchObject({ status: 'queued' });
    expect(result.launchUrl).toBeUndefined();
  });

  it('marks transport and 5xx responses as outcome-unknown but keeps 4xx rejection deterministic', async () => {
    const request = {
      accountId: 'alice',
      manifest: BUILTIN_MICRODUCK_MODEL.manifest,
      runnerUrl: 'https://runner.example.test/train',
    } as const;
    await expect(
      requestRobogoTraining({
        ...request,
        fetchImpl: (async () => {
          throw new Error('socket closed');
        }) as typeof fetch,
      }),
    ).rejects.toSatisfy((error: unknown) => isSim2RealRunnerOutcomeUnknown(error));
    await expect(
      requestRobogoTraining({
        ...request,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: 'invalid request' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      }),
    ).rejects.toSatisfy((error: unknown) => !isSim2RealRunnerOutcomeUnknown(error));
    await expect(
      requestRobogoTraining({
        ...request,
        fetchImpl: (async () =>
          new Response('not-json', {
            status: 400,
            headers: { 'content-type': 'text/plain' },
          })) as typeof fetch,
      }),
    ).rejects.toSatisfy((error: unknown) => !isSim2RealRunnerOutcomeUnknown(error));
    await expect(
      requestRobogoTraining({
        ...request,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: 'gateway timeout' }), {
            status: 504,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      }),
    ).rejects.toSatisfy((error: unknown) => isSim2RealRunnerOutcomeUnknown(error));
  });

  it('normalizes common runner terminal states without hiding failures', async () => {
    const statuses = ['succeeded', 'failed'] as const;
    const results = [];
    for (const status of statuses) {
      results.push(
        await requestRobogoTraining({
          accountId: 'alice',
          manifest: BUILTIN_MICRODUCK_MODEL.manifest,
          runnerUrl: 'https://runner.example.test/run',
          fetchImpl: (async () =>
            new Response(JSON.stringify({ status }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })) as typeof fetch,
        }),
      );
    }
    expect(results[0]).toMatchObject({ status: 'completed' });
    expect(results[1]).toMatchObject({
      status: 'failed',
      message: '训练 runner 报告任务失败或已取消。',
    });
  });

  it('polls a runner job and accepts bounded checkpoint, artifact, and metrics metadata', async () => {
    let capturedUrl = '';
    const result = await requestRobogoTrainingStatus({
      accountId: 'alice',
      requestToken: 'Bearer session-token',
      externalRunId: 'mock-run-42',
      runnerUrl: 'https://runner.example.test/train',
      fetchImpl: (async (input, init) => {
        capturedUrl = String(input);
        expect(init?.method).toBe('GET');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer session-token');
        return new Response(
          JSON.stringify({
            status: 'completed',
            runId: 'mock-run-42',
            mock: true,
            checkpoint: {
              checkpointId: 'mock-run-42-checkpoint-10',
              artifactRef: 'artifact://mock/microduck/mock-run-42/checkpoint-10',
              iteration: 10,
            },
            artifact: {
              artifactId: 'mock-run-42-policy',
              artifactRef: 'artifact://mock/microduck/mock-run-42/policy.onnx',
              kind: 'source',
              format: 'onnx',
              runtime: 'cpu-onnx',
              workload: 'locomotion',
              threads: 1,
              sha256: 'a'.repeat(64),
              sizeBytes: 0,
              deployable: false,
            },
            metrics: {
              contractValid: true,
              observationSize: 61,
              actionSize: 14,
              successRate: 0.72,
              fallRate: 0.18,
              iterations: 10,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    expect(capturedUrl).toBe('https://runner.example.test/runs/mock-run-42');
    expect(result).toMatchObject({
      status: 'completed',
      externalRunId: 'mock-run-42',
      mock: true,
      artifact: { artifactId: 'mock-run-42-policy', deployable: false, threads: 1 },
      metrics: { contractValid: true, successRate: 0.72, iterations: 10 },
    });
  });

  it('merges the worker-level cuda flag into metrics without trusting non-boolean values', async () => {
    const poll = (payload: Record<string, unknown>) =>
      requestRobogoTrainingStatus({
        accountId: 'alice',
        externalRunId: 'run-cuda',
        runnerUrl: 'http://127.0.0.1:19091/train',
        allowPrivateHttp: true,
        fetchImpl: (async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch,
      });

    const gpu = await poll({
      status: 'completed',
      runId: 'run-cuda',
      cuda: true,
      metrics: { contractValid: true, observationSize: 61, actionSize: 14 },
    });
    expect(gpu.metrics).toMatchObject({ cuda: true });

    // The worker-level flag loses when metrics already state it explicitly.
    const explicit = await poll({
      status: 'completed',
      runId: 'run-cuda',
      cuda: true,
      metrics: { contractValid: true, observationSize: 61, actionSize: 14, cuda: false },
    });
    expect(explicit.metrics).toMatchObject({ cuda: false });

    // A non-boolean (spoofed string, missing) must never report GPU usage.
    const spoofed = await poll({
      status: 'completed',
      runId: 'run-cuda',
      cuda: 'yes',
      metrics: { contractValid: true, observationSize: 61, actionSize: 14 },
    });
    expect(spoofed.metrics?.cuda).toBeUndefined();
  });
});
