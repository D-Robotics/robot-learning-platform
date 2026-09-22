/**
 * `user-center` auth mode (D-006): direct User Center SSO integration,
 * independent of the Studio product.
 *
 * Browser flow (OAuth2 authorization code, same IdP contract as Studio):
 *   GET  /api/sim2real/auth/uc/login     → 302 to the User Center authorize page
 *   GET  /api/sim2real/auth/uc/callback  → code exchange + JWT verify + session cookie
 *   GET  /api/sim2real/auth/uc/logout    → clears the platform session
 *
 * API clients may alternatively present `Authorization: Bearer <User Center
 * access token>`; the token is verified locally against the User Center
 * JWKS (see user-center-jwt.ts — introspection is NOT trusted).
 *
 * Session: stateless HMAC-signed cookie (`rdk_sim2real_uc_session`), 14-day
 * TTL. accountId is the User Center `sub` — the same identity the Studio
 * cookie mode keys its ledger on, so per-user data survives the mode switch.
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import type { Sim2RealAuthPort, Sim2RealPrincipal } from './sim2real-auth.js';
import type { VerifiedUserCenterJwt } from './user-center-jwt.js';

export const USER_CENTER_SESSION_COOKIE = 'rdk_sim2real_uc_session';
export const USER_CENTER_LOGIN_PATH = '/api/sim2real/auth/uc/login';
export const USER_CENTER_LOGOUT_PATH = '/api/sim2real/auth/uc/logout';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

export type UserCenterAuthConfig = {
  ssoBase: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  callbackPath: string;
};

export function readUserCenterAuthConfig(): UserCenterAuthConfig {
  return {
    ssoBase:
      String(process.env.RDK_SIM2REAL_UC_SSO_BASE || 'https://sso.d-robotics.cc').replace(
        /\/+$/,
        '',
      ) || 'https://sso.d-robotics.cc',
    clientId: String(process.env.RDK_SIM2REAL_UC_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.RDK_SIM2REAL_UC_CLIENT_SECRET || '').trim(),
    sessionSecret: String(process.env.RDK_SIM2REAL_UC_SESSION_SECRET || '').trim(),
    callbackPath:
      String(process.env.RDK_SIM2REAL_UC_CALLBACK_PATH || '/api/sim2real/auth/uc/callback')
        .trim()
        .replace(/\/+$/, '') || '/api/sim2real/auth/uc/callback',
  };
}

export function userCenterAuthConfigured(): boolean {
  const config = readUserCenterAuthConfig();
  return (
    config.clientId.length > 0 &&
    config.clientSecret.length > 0 &&
    config.sessionSecret.length >= MIN_SECRET_LENGTH
  );
}

/**
 * 登录地址下发给 401 响应体（UI setAuthGate 读取 ssoLoginUrl）。
 * 仅 user-center 模式返回平台自有登录入口；studio-cookie 模式沿用
 * UI 默认的 /rdkstudio/（Studio 同域 SSO）。
 */
export function ssoLoginUrlForDeployment(): string | null {
  const mode = String(process.env.RDK_SIM2REAL_AUTH_MODE || '')
    .trim()
    .toLowerCase();
  return mode === 'user-center' ? USER_CENTER_LOGIN_PATH : null;
}

function hmacSign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createUserCenterSessionCookieValue(
  principal: { accountId: string; displayName?: string; email?: string },
  sessionSecret: string,
  nowMs = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: principal.accountId,
      name: principal.displayName ?? '',
      email: principal.email ?? '',
      exp: Math.floor(nowMs / 1000) + Math.floor(SESSION_TTL_MS / 1000),
    }),
  ).toString('base64url');
  return `${payload}.${hmacSign(payload, sessionSecret)}`;
}

export function verifyUserCenterSessionCookieValue(
  cookieValue: string,
  sessionSecret: string,
): Sim2RealPrincipal | null {
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  const expected = hmacSign(payload, sessionSecret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed: { sub?: unknown; name?: unknown; email?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const accountId = typeof parsed.sub === 'string' ? parsed.sub.trim() : '';
  if (!accountId || accountId.includes('/')) return null;
  const exp = typeof parsed.exp === 'number' ? parsed.exp : Number(parsed.exp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
  return {
    accountId,
    displayName: typeof parsed.name === 'string' ? parsed.name : undefined,
    email: typeof parsed.email === 'string' ? parsed.email : undefined,
  };
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

export type UserCenterAuth = Sim2RealAuthPort & {
  mode: 'user-center';
  loginPath: string;
  logoutPath: string;
  loginUrl: string;
  /** Registers the OAuth2 login/callback/logout routes on an Express router. */
  registerRoutes: (router: import('express').Router) => void;
};

export function createUserCenterAuth(options?: {
  docsVerify?: (token: string) => Promise<VerifiedUserCenterJwt | null>;
  tokenExchange?: (
    url: string,
    body: URLSearchParams,
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}): UserCenterAuth {
  const config = readUserCenterAuthConfig();
  const sessionSecret = config.sessionSecret;
  const docsVerify =
    options?.docsVerify ??
    (async (token: string) => {
      const { verifyUserCenterJwt: verify } = await import('./user-center-jwt.js');
      return verify(token);
    });
  const tokenExchange =
    options?.tokenExchange ??
    (async (url: string, body: URLSearchParams) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(50_000),
      });
      return { ok: response.ok, status: response.status, json: () => response.json() };
    });

  const principalFromVerified = (verified: {
    claims: Record<string, unknown>;
  }): Sim2RealPrincipal | null => {
    const claims = verified.claims;
    const accountId = String(claims.sub ?? claims.user_id ?? claims.userId ?? '').trim();
    if (!accountId) return null;
    const displayName =
      String(claims.name ?? claims.preferred_username ?? claims.username ?? '').trim() || undefined;
    const email = String(claims.email ?? '').trim() || undefined;
    return { accountId, displayName, email };
  };

  const auth: UserCenterAuth = {
    mode: 'user-center',
    loginPath: USER_CENTER_LOGIN_PATH,
    logoutPath: USER_CENTER_LOGOUT_PATH,
    isMultiUserDeployment: () => true,
    loginUrl: USER_CENTER_LOGIN_PATH,
    resolveAccessToken: (request) => {
      const header = String(request.headers.authorization ?? '').trim();
      return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    },
    resolvePrincipal: (request) => {
      // SYNC by contract: every consumer does `const principal = auth.resolvePrincipal(req)`
      // and treats truthy as authenticated. A Promise here would be truthy and
      // bypass auth, so JWT verification for Bearer callers happens in the
      // pre-middleware below, which mints a valid session cookie into the
      // incoming headers before any handler resolves the principal.
      const session = readCookie(request, USER_CENTER_SESSION_COOKIE);
      if (!session) return null;
      return verifyUserCenterSessionCookieValue(session, sessionSecret);
    },
    registerRoutes: (router) => {
      // Bearer → session 预中间件：API 客户端用 User Center access token 时，
      // 验签通过后把等价会话注入本请求的 cookie 头，同步 resolvePrincipal
      // 即可读取。验签失败不注入（fail closed）。
      router.use(async (request, _response, next) => {
        try {
          const header = String(request.headers.authorization ?? '').trim();
          if (header.startsWith('Bearer ') && !readCookie(request, USER_CENTER_SESSION_COOKIE)) {
            const verified = await docsVerify(header.slice(7).trim()).catch(() => null);
            const principal = verified ? principalFromVerified(verified) : null;
            if (principal) {
              const session = createUserCenterSessionCookieValue(principal, sessionSecret);
              request.headers.cookie = request.headers.cookie
                ? `${request.headers.cookie}; ${USER_CENTER_SESSION_COOKIE}=${session}`
                : `${USER_CENTER_SESSION_COOKIE}=${session}`;
            }
          }
        } catch {
          // 认证预处理失败按未认证继续，由 resolvePrincipal fail closed。
        }
        next();
      });
      router.get(USER_CENTER_LOGIN_PATH, (_request, response) => {
        if (!userCenterAuthConfigured()) {
          response.status(503).json({
            ok: false,
            error: 'SIM2REAL_UC_NOT_CONFIGURED',
            message:
              'User Center 登录未配置：需要 RDK_SIM2REAL_UC_CLIENT_ID / _CLIENT_SECRET / _SESSION_SECRET。',
          });
          return;
        }
        const state = crypto.randomBytes(16).toString('base64url');
        const redirectUri = new URL(config.callbackPath, `https://${_request.hostname}`).toString();
        // state 同时写入短效 HttpOnly cookie，回调时双向校验防 CSRF。
        response.setHeader(
          'set-cookie',
          `rdk_sim2real_uc_state=${state}; Path=${config.callbackPath}; Max-Age=600; HttpOnly; SameSite=Lax${
            _request.protocol === 'https' ? '; Secure' : ''
          }`,
        );
        const authorizeUrl = new URL('/oauth2/authorize', config.ssoBase);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('client_id', config.clientId);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('state', state);
        response.redirect(302, authorizeUrl.toString());
      });

      router.get(config.callbackPath, (request, response) => {
        const code = String(request.query.code || '');
        const state = String(request.query.state || '');
        const stateCookie = readCookie(request, 'rdk_sim2real_uc_state');
        if (!code || !state || !stateCookie || state !== stateCookie) {
          response.status(400).send('登录验证失败：state 校验不通过。');
          return;
        }
        const redirectUri = new URL(config.callbackPath, `https://${request.hostname}`).toString();
        void tokenExchange(
          new URL('/oauth2/token', config.ssoBase).toString(),
          new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }),
        )
          .then(async (exchange) => {
            if (!exchange.ok) {
              response.status(502).send('登录验证未完成：User Center token 交换失败。');
              return;
            }
            const payload = (await exchange.json().catch(() => null)) as {
              access_token?: unknown;
            } | null;
            const accessToken =
              typeof payload?.access_token === 'string' ? payload.access_token : '';
            const verified = accessToken ? await docsVerify(accessToken) : null;
            if (!verified) {
              response.status(401).send('登录验证失败：access token 未通过签名校验。');
              return;
            }
            const principal = principalFromVerified(verified);
            if (!principal) {
              response.status(401).send('登录验证失败：token 缺少用户标识。');
              return;
            }
            const cookieValue = createUserCenterSessionCookieValue(principal, sessionSecret);
            response.setHeader('set-cookie', [
              `${USER_CENTER_SESSION_COOKIE}=${cookieValue}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${
                request.protocol === 'https' ? '; Secure' : ''
              }`,
              'rdk_sim2real_uc_state=; Path=/; Max-Age=0; HttpOnly',
            ]);
            response.redirect(302, '/');
          })
          .catch(() => {
            response.status(502).send('登录验证未完成：User Center 暂时不可用。');
          });
      });

      router.get(USER_CENTER_LOGOUT_PATH, (_request, response) => {
        response.setHeader(
          'set-cookie',
          `${USER_CENTER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
        );
        response.redirect(302, '/');
      });
    },
  };
  return auth;
}
