import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import {
  isLocalRunnerConfigured,
  localRunnerTokenRequired,
  localRunnerTokenUsable,
  fetchLocalRunArtifact,
  requestLocalTraining,
} from './local-runner.js';

const previousLocal = process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
const previousRobogo = process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
const previousLocalToken = process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN;
const previousNodeEnv = process.env.NODE_ENV;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;

afterEach(() => {
  if (previousLocal === undefined) delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
  else process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = previousLocal;
  if (previousRobogo === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
  else process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = previousRobogo;
  if (previousLocalToken === undefined) delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN;
  else process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = previousLocalToken;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
});

describe('local Sim2Real runner adapter', () => {
  it('fails closed instead of falling back to a RoboGo endpoint', async () => {
    delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
    process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = 'https://robogo.example.test/train';
    expect(isLocalRunnerConfigured()).toBe(false);
    await expect(
      requestLocalTraining({
        accountId: 'alice',
        manifest: BUILTIN_MICRODUCK_MODEL.manifest,
      }),
    ).rejects.toThrow('sim2real_robogo_runner_not_configured');
  });

  it('does not forward a Studio bearer token to the internal worker', async () => {
    delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN;
    let authorization = '';
    const result = await requestLocalTraining({
      accountId: 'alice',
      requestToken: 'Bearer should-not-leak',
      manifest: BUILTIN_MICRODUCK_MODEL.manifest,
      runnerUrl: 'http://127.0.0.1:18198/train',
      fetchImpl: (async (_input, init) => {
        authorization = String(new Headers(init?.headers).get('authorization') || '');
        return new Response(
          JSON.stringify({ status: 'completed', runId: 'local-run-1', mock: true }),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as typeof fetch,
    });

    expect(result).toMatchObject({ status: 'completed', externalRunId: 'local-run-1', mock: true });
    expect(authorization).toBe('');
  });

  it('requires a strong bearer before calling an exposed or production worker', async () => {
    expect(localRunnerTokenRequired('http://127.0.0.1:18198/train')).toBe(false);
    expect(localRunnerTokenRequired('https://worker.example.test/train')).toBe(true);
    expect(localRunnerTokenUsable('worker-test-token')).toBe(false);
    expect(localRunnerTokenUsable('ab'.repeat(16))).toBe(true);

    await expect(
      requestLocalTraining({
        accountId: 'alice',
        manifest: BUILTIN_MICRODUCK_MODEL.manifest,
        runnerUrl: 'https://worker.example.test/train',
        fetchImpl: vi.fn() as typeof fetch,
      }),
    ).rejects.toThrow('sim2real_runner_token_invalid');

    process.env.NODE_ENV = 'production';
    await expect(
      requestLocalTraining({
        accountId: 'alice',
        manifest: BUILTIN_MICRODUCK_MODEL.manifest,
        runnerUrl: 'http://127.0.0.1:18198/train',
        fetchImpl: vi.fn() as typeof fetch,
      }),
    ).rejects.toThrow('sim2real_runner_token_invalid');
  });

  it('verifies downloaded artifact bytes against the worker digest', async () => {
    const bytes = Buffer.from('onnx-fixture');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const fetchImpl = (async () =>
      new Response(bytes, {
        status: 200,
        headers: {
          'content-length': String(bytes.length),
          'x-artifact-sha256': digest,
        },
      })) as typeof fetch;
    const valid = await fetchLocalRunArtifact({
      externalRunId: 'artifact-run-1',
      runnerUrl: 'http://127.0.0.1:18198/train',
      fetchImpl,
    });
    expect(valid).toMatchObject({ bytes, sha256: digest });

    const invalid = await fetchLocalRunArtifact({
      externalRunId: 'artifact-run-1',
      runnerUrl: 'http://127.0.0.1:18198/train',
      fetchImpl: (async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(bytes.length),
            'x-artifact-sha256': 'f'.repeat(64),
          },
        })) as typeof fetch,
    });
    expect(invalid).toBeNull();
  });
});
