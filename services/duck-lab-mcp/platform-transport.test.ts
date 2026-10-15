import { describe, expect, it } from 'vitest';
import { createPlatformFetch, type PlatformClientConfig } from './platform-client.js';

const config: PlatformClientConfig = {
  baseUrl: 'http://platform.test',
  apiPrefix: '/api/v1/duck',
  timeoutMs: 1000,
};

describe('MCP actionable transport errors', () => {
  it('explains offline setup without exposing request credentials or retrying a write', async () => {
    let requests = 0;
    const platform = createPlatformFetch(
      { ...config, cookie: 'private-session' },
      {
        fetchImpl: (async () => {
          requests++;
          throw new TypeError('fetch failed private-session request-body-secret', {
            cause: { code: 'ECONNREFUSED' },
          });
        }) as typeof fetch,
      },
    );
    const error = await platform
      .fetch('/api/sim2real/runs?private=request-body-secret', {
        method: 'POST',
        headers: {},
        body: 'request-body-secret',
        signal: new AbortController().signal,
      })
      .catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('PLATFORM_UNREACHABLE');
    expect((error as Error).message).toContain('npm run dev:sim2real');
    expect((error as Error).message).toContain('RDK_SIM2REAL_MCP_BASE_URL');
    expect((error as Error).message).toContain('/api/v1/duck/runs');
    expect((error as Error).message).not.toContain('private-session');
    expect((error as Error).message).not.toContain('request-body-secret');
    expect(requests).toBe(1);
  });

  it('distinguishes timeouts and cancellation and never automatically replays motion', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      let requests = 0;
      const platform = createPlatformFetch(config, {
        fetchImpl: (async () => {
          requests++;
          throw new DOMException('secret message', name);
        }) as typeof fetch,
      });
      await expect(
        platform.requestAppRoute('/api/v1/duck/board-station/policy/start', {
          method: 'POST',
          json: { direction: 0 },
        }),
      ).rejects.toThrow(name === 'TimeoutError' ? 'PLATFORM_TIMEOUT' : 'PLATFORM_CANCELLED');
      expect(requests).toBe(1);
    }
  });

  it('gives the same diagnostics when account login cannot reach the service', async () => {
    const platform = createPlatformFetch(
      { ...config, username: 'secret-user', password: 'secret-password' },
      {
        fetchImpl: (async () => {
          throw new TypeError('fetch failed secret-password');
        }) as typeof fetch,
      },
    );
    const error = await platform.requestAppRoute('/healthz').catch((e) => e as Error);
    expect((error as Error).message).toContain('PLATFORM_UNREACHABLE');
    expect((error as Error).message).not.toContain('secret-password');
    expect((error as Error).message).not.toContain('secret-user');
  });
});
