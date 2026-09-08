import { Router, type Request, type Response } from 'express';

import {
  STUDIO_WEB_CLOUD_SESSION_COOKIE,
  decodeStudioWebCloudCookie,
  parseCookieValue,
  studioCookieAuthConfigured,
} from './studio-cookie-auth.js';
import type { Sim2RealAuthPort } from './sim2real-auth.js';

/**
 * Studio SSO relay routes for the standalone Sim2Real service.
 *
 * The account database lives in RDK Studio's login chain, not here. This
 * router relays the same JSON body Studio's own login page posts to
 * `POST /api/sso/direct/login` on the Studio main shell, then transparently
 * adopts the web-cloud session cookie Studio sets. Two supported relays:
 *
 *  - Same-origin browser (rdkstudio.d-robotics.cc): forward the request to
 *    the Studio main shell via nginx path, let it set the real cookie.
 *  - Direct: POST the credentials upstream and re-issue the cookie locally.
 *
 * CSRF: login is a POST, so the shared `sim2RealCsrfMiddleware` (registered
 * before these routes) still rejects cross-site submissions.
 */
const STUDIO_SHELL_LOGIN_TIMEOUT_MS = 30_000;
const MAX_RELAY_BODY_BYTES = 8_192;
const DEFAULT_SHELL_URL = 'https://rdkstudio.d-robotics.cc';

const RESET_COOKIE = `${STUDIO_WEB_CLOUD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;

function studioShellLoginUrl(): string | null {
  const raw = String(process.env.RDK_SIM2REAL_STUDIO_SHELL_URL ?? '').trim().replace(/\/+$/, '');
  const base = raw || DEFAULT_SHELL_URL;
  try {
    const parsed = new URL(`${base}/api/sso/direct/login`);
    // Same SSRF rule as the board-agent URL: plain HTTP is allowed only for
    // loopback (local mock/dev login shells); remote shells must use HTTPS so
    // relayed credentials cannot be intercepted.
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
    if (parsed.username || parsed.password || parsed.hash) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function studioShellBaseUrl(): string | null {
  const raw = String(process.env.RDK_SIM2REAL_STUDIO_SHELL_URL ?? '').trim().replace(/\/+$/, '');
  const base = raw || DEFAULT_SHELL_URL;
  try {
    const parsed = new URL(base);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
    if (parsed.username || parsed.password || parsed.hash) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function studioRedirectTarget(): string | null {
  // Where to send the browser when the frontend asks "where is the Studio
  // login page". Same loopback-http allowance as the relay target.
  return studioShellBaseUrl();
}

function relayJson(response: Response, status: number, payload: unknown): void {
  response.status(status).setHeader('Cache-Control', 'no-store').json(payload);
}

async function relayLoginUpstream(
  loginUrl: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; setCookie: string[]; payload: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STUDIO_SHELL_LOGIN_TIMEOUT_MS);
  try {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RELAY_BODY_BYTES) return null;
    const response = await fetchImpl(loginUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: serialized,
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    if (text.length > MAX_RELAY_BODY_BYTES * 8) return null;
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { ok: false, error: 'SIM2REAL_LOGIN_RELAY_INVALID_RESPONSE' };
      }
    }
    const setCookie = response.headers.getSetCookie?.() ?? [];
    return { status: response.status, setCookie, payload };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function hasUsableCookie(setCookie: string[]): boolean {
  return setCookie.some((cookie) =>
    cookie.startsWith(`${STUDIO_WEB_CLOUD_SESSION_COOKIE}=`) &&
    decodeStudioWebCloudCookie(parseCookieValueFromSetCookie(cookie)) !== null,
  );
}

function parseCookieValueFromSetCookie(cookie: string): string {
  const value = cookie.split(';')[0] ?? '';
  const equals = value.indexOf('=');
  const raw = equals >= 0 ? value.slice(equals + 1) : '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

function appendSetCookies(response: Response, setCookie: string[]): void {
  const existing = response.getHeader('Set-Cookie');
  const list = existing === undefined
    ? []
    : Array.isArray(existing)
      ? existing.map(String)
      : [String(existing)];
  // Only adopt the Studio web-cloud session cookie; a Studio login response
  // may also refresh the legacy rdk_sso_session id cookie, which this service
  // cannot validate, so it is deliberately dropped here.
  const adopted = setCookie.filter((cookie) => cookie.startsWith(`${STUDIO_WEB_CLOUD_SESSION_COOKIE}=`));
  response.setHeader('Set-Cookie', [...list, ...adopted]);
}

/** Exposed for the frontend auth gate: where the Studio login UI lives. */
export function studioLoginInfo(): {
  loginPageUrl: string | null;
  relayConfigured: boolean;
} {
  const shellUrl = studioShellLoginUrl();
  return {
    loginPageUrl: shellUrl ? studioRedirectTarget() : null,
    relayConfigured: shellUrl !== null,
  };
}

export function createStudioLoginRelayRouter(options: {
  auth?: Sim2RealAuthPort;
  fetchImpl?: typeof fetch;
} = {}): Router {
  const router = Router();
  const auth = options.auth;
  const fetchImpl = options.fetchImpl ?? fetch;

  /** GET /api/sso/session — 401/200 with the current cookie identity. */
  router.get('/api/sso/session', (request, response) => {
    const principal = auth?.resolvePrincipal(request) ?? null;
    if (!principal) {
      relayJson(response, 401, {
        ok: false,
        error: 'SIM2REAL_AUTH_REQUIRED',
        message: '请先登录 RDK Studio 再使用 Sim2Real 工作区。',
        ...(studioShellLoginUrl()
          ? {
              loginRelay: {
                configured: true,
                ...(studioLoginInfo().loginPageUrl
                  ? { loginPageUrl: studioLoginInfo().loginPageUrl }
                  : {}),
              },
            }
          : { loginRelay: { configured: false } }),
      });
      return;
    }
    relayJson(response, 200, {
      ok: true,
      identity: {
        accountId: principal.accountId,
        ...(principal.displayName ? { displayName: principal.displayName } : {}),
        ...(principal.email ? { email: principal.email } : {}),
      },
    });
  });

  /** POST /api/sso/login — relay credentials to Studio and adopt its cookie. */
  router.post('/api/sso/login', (request, response, next) => {
    void (async () => {
      if (!studioCookieAuthConfigured()) {
        relayJson(response, 503, {
          ok: false,
          error: 'SIM2REAL_SSO_NOT_CONFIGURED',
          message: '服务端未配置 Studio Cookie 密钥，无法完成本地登录；请从 RDK Studio 主站登录。',
        });
        return;
      }
      const target = studioShellLoginUrl();
      if (!target) {
        relayJson(response, 503, {
          ok: false,
          error: 'SIM2REAL_LOGIN_RELAY_NOT_CONFIGURED',
          message: '未配置 Studio 登录中继；请通过 RDK Studio 主站登录。',
        });
        return;
      }
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const method = String(body.method ?? '').trim();
      if (!['account', 'sms', 'email'].includes(method)) {
        relayJson(response, 400, {
          ok: false,
          error: 'SIM2REAL_LOGIN_METHOD_INVALID',
          message: '登录方式必须是 account、sms 或 email。',
        });
        return;
      }
      const forwarded: Record<string, unknown> = {};
      for (const key of [
        'method',
        'userName',
        'password',
        'mobile',
        'email',
        'code',
        'emailcode',
      ]) {
        const value = body[key];
        if (typeof value === 'string' && value.length <= 4_096) forwarded[key] = value;
      }
      const relayed = await relayLoginUpstream(target, forwarded, fetchImpl).catch(() => null);
      if (!relayed) {
        relayJson(response, 502, {
          ok: false,
          error: 'SIM2REAL_LOGIN_RELAY_UNREACHABLE',
          message: '暂时无法连接 RDK Studio 登录服务，请稍后重试。',
          retryable: true,
        });
        return;
      }
      const payload =
        relayed.payload && typeof relayed.payload === 'object'
          ? (relayed.payload as Record<string, unknown>)
          : {};
      if (relayed.status >= 200 && relayed.status < 300 && payload.ok !== true) {
        // Studio returns its own JSON error shape (409 wrong password, etc.).
        // Preserve the status so the frontend can show the real reason.
        relayJson(
          response,
          relayed.status >= 400 ? relayed.status : 409,
          {
            ok: false,
            error: String(payload.error ?? 'SIM2REAL_LOGIN_REJECTED'),
            message: String(payload.message ?? payload.error ?? '登录未通过账号中心校验。'),
          },
        );
        return;
      }
      if (relayed.status >= 400) {
        relayJson(response, relayed.status, {
          ok: false,
          error: String(payload.error ?? 'SIM2REAL_LOGIN_REJECTED'),
          message: String(payload.message ?? payload.error ?? '登录未通过账号中心校验。'),
        });
        return;
      }
      if (!hasUsableCookie(relayed.setCookie)) {
        relayJson(response, 502, {
          ok: false,
          error: 'SIM2REAL_LOGIN_COOKIE_MISSING',
          message: 'Studio 登录成功但未返回可识别的会话 Cookie，请改从 RDK Studio 主站登录。',
          retryable: true,
        });
        return;
      }
      appendSetCookies(response, relayed.setCookie);
      const adoptedCookie = relayed.setCookie
        .find((cookie) => cookie.startsWith(`${STUDIO_WEB_CLOUD_SESSION_COOKIE}=`));
      const decoded = adoptedCookie
        ? decodeStudioWebCloudCookie(parseCookieValueFromSetCookie(adoptedCookie))
        : null;
      if (!decoded) {
        relayJson(response, 502, {
          ok: false,
          error: 'SIM2REAL_LOGIN_COOKIE_INVALID',
          message: '登录会话无法解析，请改从 RDK Studio 主站登录。',
        });
        return;
      }
      relayJson(response, 200, {
        ok: true,
        identity: {
          accountId: decoded.user.id,
          ...(decoded.user.name ? { displayName: decoded.user.name } : {}),
          ...(decoded.user.email ? { email: decoded.user.email } : {}),
        },
        sessionExpiresAt: decoded.expiresAt,
      });
    })().catch(next);
  });

  /** POST /api/sso/logout — clear the shared session cookie. */
  router.post('/api/sso/logout', (_request, response) => {
    response
      .status(200)
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Set-Cookie', RESET_COOKIE)
      .json({ ok: true });
  });

  return router;
}
