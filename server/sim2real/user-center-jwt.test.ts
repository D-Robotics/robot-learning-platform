import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetUserCenterJwksCacheForTests,
  setUserCenterJwtFetchForTests,
  verifyUserCenterJwt,
} from './user-center-jwt.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function jwkForPublicKey(): Record<string, unknown> {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid: KID, alg: 'RS256', use: 'sig' };
}

function signJwt(claims: Record<string, unknown>, key = privateKey): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

function jwksResponse(keys: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ keys }),
  } as unknown as Response;
}

const NOW = Math.floor(Date.now() / 1000);
const baseClaims = { iss: 'user-center', sub: 'uc-user-1', name: '测试用户', exp: NOW + 600 };

describe('User Center JWT verification (RS256 + JWKS)', () => {
  beforeEach(() => {
    resetUserCenterJwksCacheForTests();
    setUserCenterJwtFetchForTests(async () => jwksResponse([jwkForPublicKey()]));
  });
  afterEach(() => {
    setUserCenterJwtFetchForTests(null);
    resetUserCenterJwksCacheForTests();
  });

  it('accepts a correctly signed token and maps identity claims', async () => {
    const verified = await verifyUserCenterJwt(signJwt(baseClaims));
    expect(verified).not.toBeNull();
    expect(verified?.claims.sub).toBe('uc-user-1');
    expect(verified?.protectedHeader).toEqual({ kid: KID, alg: 'RS256' });
  });

  it('rejects an expired token', async () => {
    const verified = await verifyUserCenterJwt(signJwt({ ...baseClaims, exp: NOW - 3600 }));
    expect(verified).toBeNull();
  });

  it('rejects a token signed by an untrusted key', async () => {
    const { privateKey: rogue } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const verified = await verifyUserCenterJwt(signJwt(baseClaims, rogue));
    expect(verified).toBeNull();
  });

  it('rejects a wrong issuer', async () => {
    const verified = await verifyUserCenterJwt(signJwt({ ...baseClaims, iss: 'not-user-center' }));
    expect(verified).toBeNull();
  });

  it('returns null when the JWKS transport fails (fail closed)', async () => {
    setUserCenterJwtFetchForTests(async () => {
      throw new Error('network down');
    });
    const verified = await verifyUserCenterJwt(signJwt(baseClaims));
    expect(verified).toBeNull();
  });
});
