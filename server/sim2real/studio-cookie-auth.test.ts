import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  STUDIO_WEB_CLOUD_SESSION_COOKIE,
  createStudioCookieAuth,
  decodeStudioWebCloudCookie,
  encodeStudioWebCloudCookie,
  parseCookieValue,
  studioCookieAuthConfigured,
} from './studio-cookie-auth.js';

const NOW = 1_760_000_000_000;
const SECRET = 'k'.repeat(48);
const PREVIOUS_SECRET = 'p'.repeat(44);
const USER = { id: 'user-42', name: 'Alice', email: 'alice@example.com' };

function cookieFor(
  options: { secret?: string; user?: typeof USER; expiresAt?: number; accessToken?: string } = {},
): string {
  const encoded = encodeStudioWebCloudCookie(
    options.user ?? USER,
    options.expiresAt ?? NOW + 60_000,
    options.accessToken,
    { secret: options.secret ?? SECRET },
  );
  if (!encoded) throw new Error('cookie encode failed');
  return encodeURIComponent(encoded);
}

function requestWithCookie(cookieValue: string): Request {
  return {
    method: 'GET',
    path: '/api/sim2real/overview',
    url: '/api/sim2real/overview',
    headers: { cookie: `${STUDIO_WEB_CLOUD_SESSION_COOKIE}=${cookieValue}` },
  } as unknown as Request;
}

describe('studio web-cloud cookie codec', () => {
  it('round-trips a Studio-compatible cookie payload', () => {
    const encoded = encodeStudioWebCloudCookie(USER, NOW + 60_000, 'robogo-token', { secret: SECRET });
    expect(encoded).toBeTruthy();
    expect(String(encoded).startsWith('v1.')).toBe(true);
    expect(String(encoded).split('.').length).toBe(4);
    const decoded = decodeStudioWebCloudCookie(String(encoded), {
      secrets: [SECRET],
      now: () => NOW,
    });
    expect(decoded).not.toBeNull();
    expect(decoded?.user.id).toBe('user-42');
    expect(decoded?.user.name).toBe('Alice');
    expect(decoded?.accessToken).toBe('robogo-token');
    expect(decoded?.expiresAt).toBe(NOW + 60_000);
  });

  it('rejects expired cookies', () => {
    const expired = cookieFor({ expiresAt: NOW - 1_000 });
    expect(decodeStudioWebCloudCookie(expired, { secrets: [SECRET], now: () => NOW })).toBeNull();
  });

  it('rejects cookies encrypted with a different secret (fail closed)', () => {
    const foreign = cookieFor({ secret: 'x'.repeat(48) });
    expect(decodeStudioWebCloudCookie(foreign, { secrets: [SECRET], now: () => NOW })).toBeNull();
  });

  it('accepts cookies signed with a rotation-grace (previous) secret', () => {
    const rotated = cookieFor({ secret: PREVIOUS_SECRET });
    expect(
      decodeStudioWebCloudCookie(rotated, { secrets: [SECRET, PREVIOUS_SECRET], now: () => NOW }),
    ).not.toBeNull();
  });

  it('rejects tampered ciphertext (GCM auth tag mismatch)', () => {
    const encoded = String(encodeStudioWebCloudCookie(USER, NOW + 60_000, undefined, { secret: SECRET }));
    const parts = encoded.split('.');
    // Flip a char guaranteed to change the ciphertext: the LAST base64 char
    // of a segment only carries 2 meaningful bits (the rest is padding), so
    // flipping it occasionally decodes to identical bytes — the source of a
    // rare flake. The FIRST char of the ciphertext segment always lands in
    // encrypted bytes, so flipping it must trip the GCM auth tag.
    const ciphertext = parts[2];
    const flipped = ciphertext[0] === 'A' ? 'B' : 'A';
    const tampered = [parts[0], parts[1], flipped + ciphertext.slice(1), parts[3]].join('.');
    expect(decodeStudioWebCloudCookie(tampered, { secrets: [SECRET], now: () => NOW })).toBeNull();
  });

  it('rejects malformed cookie values without throwing', () => {
    for (const value of ['', 'garbage', 'v1.only-two', 'v1.a.b.c', 'v1.####.####.####']) {
      expect(decodeStudioWebCloudCookie(value, { secrets: [SECRET], now: () => NOW })).toBeNull();
    }
  });

  it('rejects payloads with an invalid user shape', () => {
    // Manually craft: valid encryption but user.id is empty.
    const badUser = { id: '   ', name: 'x', email: '' };
    const encoded = encodeStudioWebCloudCookie(badUser, NOW + 60_000, undefined, { secret: SECRET });
    expect(decodeStudioWebCloudCookie(String(encoded), { secrets: [SECRET], now: () => NOW })).toBeNull();
  });

  it('parses the cookie header the same way Studio does (percent-decoding)', () => {
    const value = cookieFor();
    expect(parseCookieValue(`other=1; ${STUDIO_WEB_CLOUD_SESSION_COOKIE}=${value}`, STUDIO_WEB_CLOUD_SESSION_COOKIE)).toBe(value);
    expect(parseCookieValue('', STUDIO_WEB_CLOUD_SESSION_COOKIE)).toBe('');
  });
});

describe('studio cookie auth adapter', () => {
  it('resolves a principal and runner token from a valid cookie', () => {
    const auth = createStudioCookieAuth({ secret: SECRET, now: () => NOW });
    const request = requestWithCookie(cookieFor({ accessToken: 'robogo-token' }));
    expect(auth.isMultiUserDeployment()).toBe(true);
    expect(auth.resolvePrincipal(request)).toEqual({
      accountId: 'user-42',
      displayName: 'Alice',
      email: 'alice@example.com',
    });
    expect(auth.resolveAccessToken(request)).toBe('robogo-token');
  });

  it('returns null for requests without a cookie', () => {
    const auth = createStudioCookieAuth({ secret: SECRET, now: () => NOW });
    const request = { headers: {} } as unknown as Request;
    expect(auth.resolvePrincipal(request)).toBeNull();
    expect(auth.resolveAccessToken(request)).toBeNull();
  });

  it('returns null when no secret is configured (fail closed)', () => {
    const auth = createStudioCookieAuth({ secret: '', now: () => NOW });
    const request = requestWithCookie(cookieFor());
    expect(auth.resolvePrincipal(request)).toBeNull();
  });

  it('reports configuration state without leaking the secret', () => {
    expect(studioCookieAuthConfigured({ secret: SECRET })).toBe(true);
    expect(studioCookieAuthConfigured({ secret: 'short' })).toBe(false);
    expect(studioCookieAuthConfigured({ secret: '' })).toBe(false);
  });
});

// Keep the same import surface exercised as a request-shim smoke check.
