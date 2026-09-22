import crypto from 'node:crypto';

import type { Request, Response } from 'express';

import type { Sim2RealPrincipal } from './sim2real-auth.js';
import {
  createUserCenterSessionCookieValue,
  USER_CENTER_SESSION_COOKIE,
} from './user-center-auth.js';

/**
 * 复刻 Studio 主壳的账号密码直登后端（/api/sso/direct/login 的平台侧版本）：
 *
 *   浏览器表单 → 本路由 → AES-128-ECB 加密 {userName,password} →
 *   POST {UC_SSO_BASE}/api/login {type:'up', data} → IdP 当场验密签发
 *   RS256 JWT → 本侧 JWKS 验签 → 签发工作台自有会话 cookie。
 *
 * 与 Studio 主壳的差异是刻意的：主壳与 IdP 同进程互信，直登 token 直接采信；
 * 工作台是独立服务，token 必须先过 JWKS 验签才被采信（fail-closed）。
 * 凭据错误统一返回同一条 401 文案，不区分「账号不存在/密码错误」以防枚举。
 */

export const USER_CENTER_SESSION_PATH = '/api/sim2real/auth/uc/session';
const MIN_AES_KEY_BYTES = 16;
const SSO_TIMEOUT_MS = 30_000;

export function readDirectAesKey(): string {
  const raw = String(process.env.RDK_SIM2REAL_UC_DIRECT_AES_KEY ?? '');
  return Buffer.byteLength(raw, 'utf8') === MIN_AES_KEY_BYTES ? raw : '';
}

export function userCenterDirectLoginConfigured(): boolean {
  return readDirectAesKey().length > 0;
}

/** AES-128-ECB（PKCS7）+ base64，与门户 CryptoJS `as(key, plain)` 逐字节兼容。 */
export function encryptSsoLoginPayload(value: unknown, aesKey: string): string {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'utf8'), null);
  return Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString(
    'base64',
  );
}

/** 多形态 token 提取（对齐 Studio ssoTokenFromLoginData 的字段优先级）。 */
export function ssoTokenFromLoginData(data: Record<string, unknown>): string {
  const result = data.result;
  const raw =
    data.data ??
    data.token ??
    data.access_token ??
    data.accessToken ??
    (result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).token
      : '');
  return typeof raw === 'string' ? raw.trim() : '';
}

type FetchJsonLike = (
  url: string,
  init: {
    method: 'POST' | 'GET';
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const defaultFetchJson: FetchJsonLike = async (url, init) => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(SSO_TIMEOUT_MS),
  });
  return { ok: response.ok, status: response.status, text: () => response.text() };
};

export type UserCenterDirectLoginRouter = {
  sessionPath: string;
  /** Express handler for POST /api/sim2real/auth/uc/session. */
  postSession: (request: Request, response: Response) => Promise<void>;
};

export function createUserCenterDirectLoginRouter(options?: {
  docsVerify?: (token: string) => Promise<{
    claims: Record<string, unknown>;
  } | null>;
  aesKey?: string;
  ssoBase?: string;
  sessionSecret?: string;
  fetchJson?: FetchJsonLike;
}): UserCenterDirectLoginRouter | null {
  const aesKey = options?.aesKey ?? readDirectAesKey();
  if (Buffer.byteLength(aesKey, 'utf8') !== MIN_AES_KEY_BYTES) return null;
  const configRaw = String(process.env.RDK_SIM2REAL_UC_SSO_BASE || 'https://sso.d-robotics.cc')
    .trim()
    .replace(/\/+$/, '');
  const ssoBase = options?.ssoBase ?? (configRaw || 'https://sso.d-robotics.cc');
  const sessionSecret =
    options?.sessionSecret ?? String(process.env.RDK_SIM2REAL_UC_SESSION_SECRET ?? '').trim();
  const docsVerify =
    options?.docsVerify ??
    (async (token: string) => {
      const { verifyUserCenterJwt } = await import('./user-center-jwt.js');
      return verifyUserCenterJwt(token);
    });
  const fetchJson = options?.fetchJson ?? defaultFetchJson;

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

  const postSession = async (request: Request, response: Response): Promise<void> => {
    const body =
      request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const userName = String(body.userName ?? '').trim();
    const password = typeof body.password === 'string' ? body.password : '';
    const invalid = () => {
      response.status(400).json({ ok: false, error: 'SIM2REAL_UC_DIRECT_INVALID' });
    };
    if (!userName || !password) {
      invalid();
      return;
    }

    const data = await fetchJson(`${ssoBase}/api/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        SourceApp: 'getway-sso',
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({
        type: 'up',
        data: encryptSsoLoginPayload({ userName, password }, aesKey),
      }),
    })
      .then(async (res) => ({ status: res.status, text: await res.text() }))
      .catch(() => null);
    if (!data) {
      response.status(502).json({ ok: false, error: 'SIM2REAL_UC_DIRECT_UNAVAILABLE' });
      return;
    }
    let parsed: Record<string, unknown> = {};
    try {
      const candidate: unknown = JSON.parse(data.text);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
    // IdP 业务码：HTTP 200 时 status 非 0 仍是失败（冻结/未激活等）。
    if (Number(parsed.status ?? 0) !== 0) {
      response.status(401).json({
        ok: false,
        error: 'SIM2REAL_UC_DIRECT_REJECTED',
        message: '账号或密码不正确。',
      });
      return;
    }
    const token = ssoTokenFromLoginData(parsed);
    if (!token) {
      response.status(401).json({
        ok: false,
        error: 'SIM2REAL_UC_DIRECT_REJECTED',
        message: '账号或密码不正确。',
      });
      return;
    }

    // The IdP-issued JWT must pass the platform JWKS verification before any
    // session is minted - an unverified token is never trusted, even though
    // the IdP itself validated the credentials a step earlier.
    const verified = await docsVerify(token).catch(() => null);
    const principal = verified ? principalFromVerified(verified) : null;
    if (!principal) {
      response.status(401).json({
        ok: false,
        error: 'SIM2REAL_UC_DIRECT_REJECTED',
        message: '账号或密码不正确。',
      });
      return;
    }

    const cookieValue = createUserCenterSessionCookieValue(principal, sessionSecret);
    const maxAge = Math.floor(
      Number(process.env.RDK_SIM2REAL_UC_SESSION_TTL_MS ?? 12 * 60 * 60 * 1000) / 1000,
    );
    response.setHeader(
      'set-cookie',
      `${USER_CENTER_SESSION_COOKIE}=${cookieValue}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${
        request.protocol === 'https' ? '; Secure' : ''
      }`,
    );
    response.json({
      ok: true,
      user: {
        accountId: principal.accountId,
        displayName: principal.displayName ?? '',
        email: principal.email ?? '',
      },
    });
  };

  return { sessionPath: USER_CENTER_SESSION_PATH, postSession };
}
