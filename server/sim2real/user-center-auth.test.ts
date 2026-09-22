import crypto from 'node:crypto';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUserCenterAuth,
  createUserCenterSessionCookieValue,
  ssoLoginUrlForDeployment,
  verifyUserCenterSessionCookieValue,
} from './user-center-auth.js';

const SESSION_SECRET = 'unit-test-session-secret-0123456789abcdef';

function setEnv(mode: string): () => void {
  const previous = { ...process.env };
  process.env.RDK_SIM2REAL_AUTH_MODE = mode;
  process.env.RDK_SIM2REAL_UC_CLIENT_ID = 'client-1';
  process.env.RDK_SIM2REAL_UC_CLIENT_SECRET = 'secret-1';
  process.env.RDK_SIM2REAL_UC_SESSION_SECRET = SESSION_SECRET;
  return () => {
    for (const key of [
      'RDK_SIM2REAL_AUTH_MODE',
      'RDK_SIM2REAL_UC_CLIENT_ID',
      'RDK_SIM2REAL_UC_CLIENT_SECRET',
      'RDK_SIM2REAL_UC_SESSION_SECRET',
    ]) {
      if (key in previous) (process.env as Record<string, string | undefined>)[key] = previous[key];
      else delete (process.env as Record<string, string | undefined>)[key];
    }
  };
}

const principal = { accountId: 'uc-user-9', displayName: '张三', email: 'z@d-robotics.cc' };

describe('user-center session cookie', () => {
  it('round-trips a session cookie into the principal', () => {
    const cookie = createUserCenterSessionCookieValue(principal, SESSION_SECRET);
    const resolved = verifyUserCenterSessionCookieValue(cookie, SESSION_SECRET);
    expect(resolved).toMatchObject({ accountId: 'uc-user-9', displayName: '张三' });
  });

  it('rejects a tampered cookie', () => {
    const cookie = createUserCenterSessionCookieValue(principal, SESSION_SECRET);
    const [payload] = cookie.split('.');
    const forged = `${payload}.${crypto.randomBytes(32).toString('base64url')}`;
    expect(verifyUserCenterSessionCookieValue(forged, SESSION_SECRET)).toBeNull();
  });

  it('rejects an expired cookie', () => {
    const cookie = createUserCenterSessionCookieValue(principal, SESSION_SECRET, Date.now() - 15 * 24 * 60 * 60 * 1000);
    expect(verifyUserCenterSessionCookieValue(cookie, SESSION_SECRET)).toBeNull();
  });
});

describe('user-center auth routes', () => {
  const _exec = { signal: new AbortController().signal } as never;
  let restoreEnv: () => void;

  function makeApp(docsVerify: (token: string) => Promise<unknown>) {
    const auth = createUserCenterAuth({
      docsVerify: async (token) => docsVerify(token),
      tokenExchange: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'uc-jwt-token' }),
      }),
    });
    const app = express();
    auth.registerRoutes(app);
    return { auth, app };
  }

  beforeEach(() => {
    restoreEnv = setEnv('user-center');
  });
  afterEach(() => restoreEnv());

  it('exposes the platform login path as the deployment login url', () => {
    expect(ssoLoginUrlForDeployment()).toBe('/api/sim2real/auth/uc/login');
  });

  it('returns null outside user-center mode (studio-cookie keeps its default)', () => {
    const restore = setEnv('studio-cookie');
    try {
      expect(ssoLoginUrlForDeployment()).toBeNull();
    } finally {
      restore();
    }
  });
  function listen(app: express.Express): Promise<string> {
    return new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      });
    });
  }

  it('login redirects to the User Center authorize endpoint with a state cookie', async () => {
    const { app } = makeApp(async () => null);
    const base = await listen(app);
    const response = await fetch(`${base}/api/sim2real/auth/uc/login`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('sso.d-robotics.cc/oauth2/authorize');
    expect(response.headers.get('location')).toContain('client_id=client-1');
    expect(response.headers.get('location')).toContain('redirect_uri=https%3A%2F%2F127.0.0.1');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('rdk_sim2real_uc_state=');
    void base;
  });

  it('callback exchanges the code, verifies the jwt and issues a session cookie', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const _jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'RS256', use: 'sig' };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'user-center', sub: 'uc-user-9', name: '张三', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    const token = `${header}.${payload}.${signature}`;

    let exchangedUrl = '';
    const { app } = makeApp(async (t: string) => {
      expect(t).toBe(token);
      return {
        claims: { iss: 'user-center', sub: 'uc-user-9', name: '张三' },
        protectedHeader: { kid: 'k1', alg: 'RS256' },
      };
    });
    const stub = async (url: string, body: URLSearchParams) => {
      exchangedUrl = url;
      expect(String(body)).toContain('grant_type=authorization_code');
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: token }),
      } as unknown as Response;
    };
    const auth2 = createUserCenterAuth({
      docsVerify: async (t: string) => {
        expect(t).toBe(token);
        return {
          claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
          protectedHeader: { kid: 'k1', alg: 'RS256' },
        };
      },
      tokenExchange: stub as never,
    });
    const app2 = express();
    auth2.registerRoutes(app2);
    const base = await listen(app2);
    void app;

    const login = await fetch(`${base}/api/sim2real/auth/uc/login`, { redirect: 'manual' });
    const stateCookie = (login.headers.get('set-cookie') ?? '')
      .split(';')[0]
      .split('=')
      .slice(1)
      .join('=');
    void stateCookie;
    const callback = await fetch(
      `${base}/api/sim2real/auth/uc/callback?code=abc&state=st`,
      { redirect: 'manual', headers: { cookie: 'rdk_sim2real_uc_state=st' } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/');
    const sessionCookie = (callback.headers.get('set-cookie') ?? '')
      .split(';')
      .find((c) => c.startsWith('rdk_sim2real_uc_session='));
    expect(sessionCookie).toBeTruthy();
    const value = (sessionCookie as string).split('=').slice(1).join('=');
    expect(verifyUserCenterSessionCookieValue(value, SESSION_SECRET)).toMatchObject({
      accountId: 'uc-user-9',
    });
    expect(exchangedUrl).toContain('/oauth2/token');
  });

  it('does not mint a session when jwt verification fails', async () => {
    const { app } = makeApp(async () => null);
    const base = await listen(app);
    const callback = await fetch(
      `${base}/api/sim2real/auth/uc/callback?code=abc&state=st`,
      { redirect: 'manual', headers: { cookie: 'rdk_sim2real_uc_state=st' } },
    );
    expect(callback.status).toBe(401);
    expect(callback.headers.get('set-cookie') ?? '').not.toContain('rdk_sim2real_uc_session=');
  });
});
