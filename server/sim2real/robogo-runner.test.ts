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

  it('rejects literal private HTTPS targets unless the operator explicitly allowlists them', () => {
    const previous = process.env.RDK_SIM2REAL_COMPUTE_ALLOW_PRIVATE_HTTPS_HOSTS;
    delete process.env.RDK_SIM2REAL_COMPUTE_ALLOW_PRIVATE_HTTPS_HOSTS;
    try {
      expect(() => normalizeRunnerUrl('https://127.0.0.1:19090/train')).toThrow(
        'sim2real_robogo_runner_url_invalid',
      );
      expect(() => normalizeRunnerUrl('https://[::ffff:127.0.0.1]:19090/train')).toThrow(
        'sim2real_robogo_runner_url_invalid',
      );
      process.env.RDK_SIM2REAL_COMPUTE_ALLOW_PRIVATE_HTTPS_HOSTS = '127.0.0.1';
      expect(normalizeRunnerUrl('https://127.0.0.1:19090/train')).toBe(
        'https://127.0.0.1:19090/train',
      );
    } finally {
      if (previous === undefined) delete process.env.RDK_SIM2REAL_COMPUTE_ALLOW_PRIVATE_HTTPS_HOSTS;
      else process.env.RDK_SIM2REAL_COMPUTE_ALLOW_PRIVATE_HTTPS_HOSTS = previous;
    }
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
        new Response(
          JSON.stringify({ status: 'queued', runId: 'safe-run-1', url: 'javascript:alert(1)' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )) as typeof fetch,
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

  it('fails closed on malformed or oversized declared runner response lengths', async () => {
    const request = {
      accountId: 'alice',
      manifest: BUILTIN_MICRODUCK_MODEL.manifest,
      runnerUrl: 'https://runner.example.test/train',
    } as const;
    let capturedInit: RequestInit | undefined;
    await expect(
      requestRobogoTraining({
        ...request,
        fetchImpl: (async (_input, init) => {
          capturedInit = init;
          return new Response('{}', {
            status: 400,
            headers: { 'content-length': 'not-a-length' },
          });
        }) as typeof fetch,
      }),
    ).rejects.toThrow('sim2real_runner_response_too_large');
    expect(capturedInit?.redirect).toBe('error');

    await expect(
      requestRobogoTrainingStatus({
        accountId: 'alice',
        externalRunId: 'run-1',
        runnerUrl: 'https://runner.example.test/train',
        fetchImpl: (async () =>
          new Response('{}', {
            status: 200,
            headers: { 'content-length': '1000001' },
          })) as typeof fetch,
      }),
    ).rejects.toThrow('sim2real_runner_response_too_large');
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

  it('propagates bounded worker failure diagnostics onto the run result', async () => {
    const result = await requestRobogoTrainingStatus({
      accountId: 'alice',
      externalRunId: 'run-err-1',
      runnerUrl: 'https://runner.example.test/train',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            status: 'failed',
            runId: 'run-err-1',
            message: '本地训练进程失败。',
            errorCode: 'training_process_failed',
            exitCode: 1,
            stderrTail: 'TypeError: Object of type ndarray is not JSON serializable',
            stdoutTail: 'reward=1.58',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    expect(result.failureDetail).toEqual({
      errorCode: 'training_process_failed',
      exitCode: 1,
      stderrTail: 'TypeError: Object of type ndarray is not JSON serializable',
      stdoutTail: 'reward=1.58',
    });
  });

  it('keeps run records free of failureDetail when the worker reports none', async () => {
    const result = await requestRobogoTrainingStatus({
      accountId: 'alice',
      externalRunId: 'run-ok-1',
      runnerUrl: 'https://runner.example.test/train',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ status: 'running', runId: 'run-ok-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    });
    expect(result.failureDetail).toBeUndefined();
  });

  it('reports validated queue evidence only while the Worker job is queued', async () => {
    const createdAt = '2025-06-01T01:23:45.000Z';
    const read = (status: string, queuePosition: unknown, timestamp: string) =>
      requestRobogoTrainingStatus({
        accountId: 'alice',
        externalRunId: 'queue-job',
        runnerUrl: 'https://runner.example.test/train',
        fetchImpl: async () =>
          Response.json({ status, runId: 'queue-job', queuePosition, createdAt: timestamp }),
      });
    expect((await read('queued', 3, createdAt)).queue).toEqual({
      position: 3,
      queuedAt: createdAt,
    });
    expect((await read('queued', '3', createdAt)).queue).toEqual({ queuedAt: createdAt });
    expect((await read('queued', 1, '2099-01-01T00:00:00.000Z')).queue).toEqual({ position: 1 });
    expect((await read('queued', 1001, 'invalid')).queue).toBeUndefined();
    expect((await read('running', 2, createdAt)).queue).toBeUndefined();
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
            taskEvaluation: {
              taskId: 'originbot-goal-navigation',
              trained: {
                envelopes: {
                  nominal: { successRate: 0.88, collisionRate: 0, episodes: 50 },
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
              injected: { shouldDisappear: true },
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
      taskEvaluation: {
        taskId: 'originbot-goal-navigation',
        trained: { envelopes: { nominal: { successRate: 0.88, episodes: 50 } } },
      },
    });
    expect(result.taskEvaluation).not.toHaveProperty('injected');
  });

  it('retains validated recovery evidence through the worker status boundary', async () => {
    const receipt = {
      schemaVersion: 1,
      phase: 'train',
      requestedTimesteps: 8192,
      actualTimesteps: 8192,
      seed: 7,
      pushMaxForce: 8.1,
      policySha256: 'a'.repeat(64),
      hardwareEligible: false,
    };
    const read = async (engine: string, policySha256: string) =>
      (
        await requestRobogoTrainingStatus({
          accountId: 'alice',
          externalRunId: 'job',
          runnerUrl: 'https://runner.example.test/train',
          fetchImpl: async () =>
            Response.json({
              status: 'completed',
              runId: 'job',
              mock: false,
              metrics: {
                contractValid: true,
                observationSize: 14,
                actionSize: 2,
                engine,
                originmanWorkshop: { ...receipt, policySha256, workerPath: '/private/path' },
              },
            }),
        })
      ).metrics?.originmanWorkshop;
    expect(await read('originman-recovery', receipt.policySha256)).toEqual(receipt);
    expect(await read('originman-recovery', 'broken')).toBeUndefined();
    expect(await read('other', receipt.policySha256)).toBeUndefined();
  });

  describe('reference choreography evaluation', () => {
    const evaluation = {
      framesExpected: 12_000,
      framesEvaluated: 12_000,
      trackingMaeRad: 0.04,
      maxTiltDeg: 8,
      finalYawDeg: 1,
      qualityGatePassed: true,
      referenceSha256: 'a'.repeat(64),
      sceneSha256: 'b'.repeat(64),
    };
    const poll = async (sections: readonly unknown[], overrides: Partial<typeof evaluation> = {}) =>
      (
        await requestRobogoTrainingStatus({
          accountId: 'alice',
          externalRunId: 'reference-run',
          runnerUrl: 'https://runner.example.test/train',
          fetchImpl: async () =>
            Response.json({
              status: 'completed',
              runId: 'reference-run',
              metrics: {
                engine: 'originman-reference-ppo',
                contractValid: true,
                observationSize: 96,
                actionSize: 18,
                originmanReference: { ...evaluation, ...overrides, sections },
              },
            }),
        })
      ).metrics?.originmanReference;
    const segment = (id: string, expected: number, evaluated = expected) => ({
      id,
      framesExpected: expected,
      framesEvaluated: evaluated,
      completed: expected === evaluated,
    });

    it('retains all expanded sections including two-frame action clips', async () => {
      const sections = Array.from({ length: 1024 }, () => segment('short-action', 2));
      const runFrames = 2 * sections.length + 9 * (sections.length - 1);
      const result = await poll(sections, {
        framesExpected: runFrames,
        framesEvaluated: runFrames,
      });
      expect(result?.sections?.length).toBe(sections.length);
      expect(result?.sections).toEqual(sections);
    });

    it('retains a single section spanning the longest supported trajectory', async () => {
      const sections = [segment('long-action', evaluation.framesExpected)];
      expect((await poll(sections))?.sections).toEqual(sections);
    });

    it('retains unfinished sections and leaves space for transition frames', async () => {
      const sections = [segment('open', 250, 100), segment('close', 225, 0)];
      expect(
        await poll(sections, {
          framesExpected: 500,
          framesEvaluated: 100,
          qualityGatePassed: false,
        }),
      ).toMatchObject({ sections, qualityGatePassed: false });
    });

    it.each([
      ['expected frame count', [segment('open', 8000), segment('close', 4001)], {}],
      [
        'evaluated frame count',
        [segment('open', 55), segment('close', 500, 46)],
        { framesEvaluated: 100 },
      ],
      ['section count', Array.from({ length: 1025 }, () => segment('short-action', 2)), {}],
    ] as const)(
      'omits section data that exceeds the run %s',
      async (_label, sections, overrides) => {
        const result = await poll(sections, overrides);
        expect(result?.framesExpected).toBe(12_000);
        expect(result).not.toHaveProperty('sections');
      },
    );
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
      metrics: {
        contractValid: true,
        observationSize: 61,
        actionSize: 14,
        trainingDevice: 'cuda:0',
        trainingDeviceName: 'NVIDIA GeForce RTX 4090',
      },
    });
    expect(gpu.metrics).toMatchObject({
      cuda: true,
      trainingDevice: 'cuda:0',
      trainingDeviceName: 'NVIDIA GeForce RTX 4090',
    });

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
      metrics: {
        contractValid: true,
        observationSize: 61,
        actionSize: 14,
        trainingDevice: 'mps',
        trainingDeviceName: '<invalid>',
      },
    });
    expect(spoofed.metrics?.cuda).toBeUndefined();
    expect(spoofed.metrics?.trainingDevice).toBe('mps');
    expect(spoofed.metrics?.trainingDeviceName).toBeUndefined();
  });
});
