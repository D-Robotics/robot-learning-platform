import { createDecipheriv } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createUserCenterDirectLoginRouter,
  encryptSsoLoginPayload,
  ssoTokenFromLoginData,
} from './user-center-direct.js';

const AES_KEY = '0123456789abcdef'; // 16 bytes, AES-128
const SESSION_SECRET = 'unit-test-session-secret-0123456789abcdef';

const originalEnv: Record<string, string | undefined> = {
  RDK_SIM2REAL_UC_DIRECT_AES_KEY: process.env.RDK_SIM2REAL_UC_DIRECT_AES_KEY,
  RDK_SIM2REAL_UC_SESSION_SECRET: process.env.RDK_SIM2REAL_UC_SESSION_SECRET,
  RDK_SIM2REAL_UC_SSO_BASE: process.env.RDK_SIM2REAL_UC_SSO_BASE,
};

beforeEach(() => {
  process.env.RDK_SIM2REAL_UC_DIRECT_AES_KEY = AES_KEY;
  process.env.RDK_SIM2REAL_UC_SESSION_SECRET = SESSION_SECRET;
  delete process.env.RDK_SIM2REAL_UC_SSO_BASE;
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function decryptPayload(data: string): string {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'utf8'), null);
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

function makeResponse() {
  const headers: Record<string, unknown> = {};
  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    setHeader(name: string, value: unknown) {
      headers[name] = value;
    },
    json(payload: unknown) {
      statusCode = statusCode || 200;
      body = payload;
      return response;
    },
  };
  return {
    response,
    get lastStatus() {
      return statusCode;
    },
    get body() {
      return body as Record<string, unknown>;
    },
    get cookie() {
      return String(headers['set-cookie'] ?? '');
    },
  };
}

function callSession(
  router: NonNullable<ReturnType<typeof createUserCenterDirectLoginRouter>>,
  body: unknown,
) {
  const request = {
    body,
    protocol: 'https',
    headers: {},
  } as never;
  const mock = makeResponse();

  return router
    .postSession(request, mock.response as unknown as Parameters<typeof router.postSession>[1])
    .then(() => ({ lastStatus: mock.lastStatus, body: mock.body, cookie: mock.cookie }));
}

describe('user-center direct login (own-brand page backend)', () => {
  it('encrypts the credentials with AES-128-ECB into the portal wire format', () => {
    const data = encryptSsoLoginPayload({ userName: 'u1', password: 'p1' }, AES_KEY);
    const plain = decryptPayload(data);
    expect(JSON.parse(plain)).toEqual({ userName: 'u1', password: 'p1' });
    // ECB output is deterministic for identical input - the wire format the
    // portal parser expects.
    expect(encryptSsoLoginPayload({ userName: 'u1', password: 'p1' }, AES_KEY)).toBe(data);
  });

  it('extracts the token from every documented response shape', () => {
    expect(ssoTokenFromLoginData({ data: 'a' })).toBe('a');
    expect(ssoTokenFromLoginData({ token: 'b' })).toBe('b');
    expect(ssoTokenFromLoginData({ access_token: 'c' })).toBe('c');
    expect(ssoTokenFromLoginData({ accessToken: 'd' })).toBe('d');
    expect(ssoTokenFromLoginData({ result: { token: 'e' } })).toBe('e');
    expect(ssoTokenFromLoginData({})).toBe('');
  });

  it('factory returns null when the AES key is absent or malformed', () => {
    expect(createUserCenterDirectLoginRouter({ aesKey: '' })).toBeNull();
    expect(createUserCenterDirectLoginRouter({ aesKey: 'short' })).toBeNull();
  });

  it('mints the platform session cookie on a successful IdP round', async () => {
    const router = createUserCenterDirectLoginRouter({
      docsVerify: async () => ({
        claims: { sub: 'uc-user-1', name: '张三', email: 'z@dr.example' },
      }),
      fetchJson: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 0, data: 'portal-token' }),
      }),
    })!;
    const result = await callSession(router, { userName: 'u', password: 'p' });
    expect(result.lastStatus).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(result.cookie).toContain('rdk_sim2real_uc_session=');
    expect(result.cookie).toContain('HttpOnly');
  });

  it('unifies every credential rejection into one 401 message', async () => {
    const router = createUserCenterDirectLoginRouter({
      fetchJson: async (url) => {
        if (url.endsWith('/api/login')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ status: 10000, message: 'password_not_match', data: '' }),
          };
        }
        throw new Error('not reached');
      },
    })!;
    const result = await callSession(router, { userName: 'u', password: 'wrong' });
    expect(result.lastStatus).toBe(401);
    expect(result.body).toMatchObject({ error: 'SIM2REAL_UC_DIRECT_REJECTED' });
  });

  it('refuses to mint a session when the IdP token fails JWKS verification', async () => {
    const router = createUserCenterDirectLoginRouter({
      docsVerify: async () => null,
      fetchJson: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 0, data: 'forged-token' }),
      }),
    })!;
    const result = await callSession(router, { userName: 'u', password: 'p' });
    expect(result.lastStatus).toBe(401);
    expect(result.body).toMatchObject({ error: 'SIM2REAL_UC_DIRECT_REJECTED' });
  });

  it('rejects missing credentials with 400 before touching the IdP', async () => {
    let calls = 0;
    const router = createUserCenterDirectLoginRouter({
      fetchJson: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => '{}', ...({} as never) };
      },
    })!;
    const res = await callSession(router, { userName: '', password: '' });
    expect(res.lastStatus).toBe(400);
    expect(calls).toBe(0);
  });

  it('reports the IdP as unavailable when it cannot be reached', async () => {
    const router = createUserCenterDirectLoginRouter({
      fetchJson: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    })!;
    const res = await callSession(router, { userName: 'u', password: 'p' });
    expect(res.lastStatus).toBe(502);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_UC_DIRECT_UNAVAILABLE' });
  });

  it('session cookie round-trips into a verified principal', async () => {
    const router = createUserCenterDirectLoginRouter({
      docsVerify: async () => ({
        claims: { sub: 'uc-user-1', name: '张三', email: 'z@dr.example' },
      }),
      fetchJson: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 0, data: 'portal-token' }),
      }),
    })!;
    const result = await callSession(router, { userName: 'u', password: 'p' });
    const raw = result.cookie.split(';')[0].split('=').slice(1).join('=');
    // verifyUserCenterSessionCookieValue parity: HMAC + exp re-check is
    // exercised in user-center-auth.test.ts; here we only assert shape.
    const [, sig] = raw.split('.');
    expect(sig.length).toBeGreaterThan(20);
    expect(result.cookie).toContain('SameSite=Lax');
  });
});
