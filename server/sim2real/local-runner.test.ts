import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import { isLocalRunnerConfigured, requestLocalTraining } from './local-runner.js';

const previousLocal = process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
const previousRobogo = process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;

afterEach(() => {
  if (previousLocal === undefined) delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
  else process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = previousLocal;
  if (previousRobogo === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
  else process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = previousRobogo;
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
});
