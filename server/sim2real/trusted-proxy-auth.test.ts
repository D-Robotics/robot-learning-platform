import { createHmac } from 'node:crypto';

import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  createTrustedProxyAuth,
  TRUSTED_PROXY_HEADERS,
  trustedProxyCanonicalMessage,
} from './trusted-proxy-auth.js';

const NOW = 1_760_000_000_000;
const SECRET = 's'.repeat(40);

function requestFor(
  path: string,
  overrides: Record<string, string> = {},
): Request {
  const timestamp = String(Math.floor(NOW / 1000));
  const accountId = overrides[TRUSTED_PROXY_HEADERS.account] || 'alice';
  const runnerToken = overrides[TRUSTED_PROXY_HEADERS.runnerToken] || '';
  const message = trustedProxyCanonicalMessage({
    method: 'POST',
    path,
    accountId,
    timestamp,
    runnerToken,
  });
  const signature = createHmac('sha256', SECRET).update(message).digest('hex');
  return {
    method: 'POST',
    path,
    url: path,
    headers: {
      [TRUSTED_PROXY_HEADERS.account]: accountId,
      [TRUSTED_PROXY_HEADERS.timestamp]: timestamp,
      [TRUSTED_PROXY_HEADERS.signature]: signature,
      ...(runnerToken ? { [TRUSTED_PROXY_HEADERS.runnerToken]: runnerToken } : {}),
      ...(overrides[TRUSTED_PROXY_HEADERS.signature]
        ? { [TRUSTED_PROXY_HEADERS.signature]: overrides[TRUSTED_PROXY_HEADERS.signature] }
        : {}),
    },
  } as unknown as Request;
}

describe('trusted proxy auth adapter', () => {
  it('accepts a fresh signed identity and optional runner token', () => {
    const auth = createTrustedProxyAuth({ secret: SECRET, now: () => NOW });
    const request = requestFor('/api/sim2real/runs', {
      [TRUSTED_PROXY_HEADERS.runnerToken]: 'short-lived-token',
    });
    expect(auth.resolvePrincipal(request)).toMatchObject({ accountId: 'alice' });
    expect(auth.resolveAccessToken(request)).toBe('short-lived-token');
  });

  it('rejects tampered paths, stale timestamps, and missing secrets', () => {
    const auth = createTrustedProxyAuth({ secret: SECRET, now: () => NOW });
    const signed = requestFor('/api/sim2real/runs');
    expect(auth.resolvePrincipal({ ...signed, path: '/api/sim2real/models' } as Request)).toBeNull();

    const stale = requestFor('/api/sim2real/runs');
    (stale.headers as Record<string, string>)[TRUSTED_PROXY_HEADERS.timestamp] = '1';
    expect(auth.resolvePrincipal(stale)).toBeNull();

    const disabled = createTrustedProxyAuth({ secret: 'too-short', now: () => NOW });
    expect(disabled.resolvePrincipal(signed)).toBeNull();

    const querySigned = requestFor('/api/sim2real/runs?view=active');
    expect(auth.resolvePrincipal(querySigned)).toMatchObject({ accountId: 'alice' });
    const queryTampered = {
      ...querySigned,
      url: '/api/sim2real/runs?view=all',
    } as Request;
    expect(auth.resolvePrincipal(queryTampered)).toBeNull();
  });

  it('rejects replaying a signed mutation while caching verification per request', () => {
    const auth = createTrustedProxyAuth({ secret: SECRET, now: () => NOW });
    const signed = requestFor('/api/sim2real/runs');
    expect(auth.resolvePrincipal(signed)).toMatchObject({ accountId: 'alice' });
    // The route resolves the principal and token separately; both lookups on
    // the same Express request must use the cached verification result.
    expect(auth.resolveAccessToken(signed)).toBeNull();
    const replay = {
      ...signed,
      headers: { ...(signed.headers as Record<string, string>) },
    } as Request;
    expect(auth.resolvePrincipal(replay)).toBeNull();
  });
});
