/**
 * Studio direct-login relay for the `studio-cookie` auth mode.
 *
 * Lets the Sim2Real workbench render its own login page instead of pushing
 * users to the Studio shell: credentials are relayed server-to-server to the
 * Studio main shell (`POST /api/sso/direct/login`), and every session cookie
 * Studio sets is passed through verbatim to the same-origin browser. The
 * platform never stores credentials, and the resulting cookies are the exact
 * site-wide Studio sessions it already decrypts/trusts in studio-cookie mode.
 *
 * Two surface wrappers share one core:
 *   - handleJson: JSON API (fetch callers) → JSON responses
 *   - handleForm: progressive-enhancement form POST → redirects only
 *     (works with CSP script-src=self and without JavaScript).
 *
 * The Studio origin is the same `configuredStudioOrigin()` the local-bridge
 * routes use. Per D-006 principle, credentials are relayed only to an
 * explicitly configured origin — never an invented one.
 */
import type { Request, Response } from 'express';

import { studioCookieAuthConfigured } from './studio-cookie-auth.js';

const RELAY_TIMEOUT_MS = 30_000;
const RELAY_MIN_INTERVAL_MS = 1_500;
const relayLastAtByIp = new Map<string, number>();

function relayOrigin(): string | null {
  const origin = String(
    process.env.RDK_SIM2REAL_STUDIO_ORIGIN ||
      process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN ||
      'https://rdkstudio.d-robotics.cc',
  )
    .trim()
    .replace(/\/+$/, '');
  return origin || null;
}

export function studioDirectRelayAvailable(): boolean {
  return studioCookieAuthConfigured() && relayOrigin() !== null;
}

function clientKey(request: Request): string {
  return String(request.headers['x-forwarded-for'] ?? request.socket?.remoteAddress ?? 'local')
    .split(',')[0]
    .trim();
}

function throttled(request: Request): number {
  const key = clientKey(request);
  const now = Date.now();
  const elapsed = now - (relayLastAtByIp.get(key) ?? 0);
  if (elapsed < RELAY_MIN_INTERVAL_MS) return RELAY_MIN_INTERVAL_MS - elapsed;
  relayLastAtByIp.set(key, now);
  if (relayLastAtByIp.size > 10_000) relayLastAtByIp.clear();
  return 0;
}

export type StudioDirectRelayDeps = {
  post?: (url: string, body: string) => Promise<UpstreamResponse>;
};

/** 结构化最小响应类型：兼容全局 fetch Response，避免解析成 express Response。 */
type UpstreamResponse = {
  ok: boolean;
  status: number;
  headers: { getSetCookie?: () => string[]; get: (name: string) => string | null };
};

export type RelayOutcome = {
  status: number;
  /** 原样透传的 Studio 会话 cookie（仅成功时存在）。 */
  setCookies: string[];
  body?: Record<string, unknown>;
  redirect?: string;
};

export function createStudioDirectRelay(deps: StudioDirectRelayDeps = {}) {
  const post =
    deps.post ??
    (async (url: string, body: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'RDK-Learning-Platform/1.0 (+direct-login-relay)',
        },
        body,
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      }));

  async function relay(userName: string, password: string): Promise<RelayOutcome> {
    const upstream = await post(
      `${relayOrigin()}/api/sso/direct/login`,
      JSON.stringify({ method: 'account', userName, password }),
    );
    if (upstream.status === 401 || upstream.status === 403) {
      return {
        status: 401,
        setCookies: [],
        body: { ok: false, error: 'SIM2REAL_LOGIN_FAILED', message: '账号或密码不正确。' },
        redirect: '/login?error=invalid',
      };
    }
    if (!upstream.ok) {
      return {
        status: 502,
        setCookies: [],
        body: { ok: false, error: 'SIM2REAL_STUDIO_RELAY_FAILED', message: '登录服务暂时不可用，请稍后重试。' },
        redirect: '/login?error=unavailable',
      };
    }
    const setCookies = (upstream.headers.getSetCookie?.() ?? []).filter((cookie) =>
      /^(rdk_sso_web_session|rdk_sso_session|token)=/i.test(cookie.trim()),
    );
    if (setCookies.length === 0) {
      return {
        status: 502,
        setCookies: [],
        body: { ok: false, error: 'SIM2REAL_STUDIO_RELAY_FAILED', message: '登录服务未返回会话，请稍后重试。' },
        redirect: '/login?error=unavailable',
      };
    }
    // 保障安全属性：上游缺省时补齐。
    const hardened = setCookies.map((cookie) => {
      const withHttponly = /httponly/i.test(cookie) ? cookie : `${cookie}; HttpOnly`;
      return /samesite/i.test(withHttponly) ? withHttponly : `${withHttponly}; SameSite=Lax`;
    });
    return { status: 200, setCookies: hardened, redirect: '/' };
  }

  async function runWithGuards(
    request: Request,
    userName: string,
    password: string,
  ): Promise<RelayOutcome> {
    const wait = throttled(request);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await relay(userName, password);
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? '登录服务超时' : '登录服务不可达';
      return {
        status: 502,
        setCookies: [],
        body: { ok: false, error: 'SIM2REAL_STUDIO_RELAY_FAILED', message: `${reason}，请稍后重试。` },
        redirect: '/login?error=unavailable',
      };
    }
  }

  function applyCookies(response: Response, outcome: RelayOutcome): void {
    for (const cookie of outcome.setCookies) response.setHeader('set-cookie', cookie);
  }

  return {
    /** JSON API 形态（fetch 调用方）。 */
    async handleJson(request: Request, response: Response): Promise<void> {
      if (!studioDirectRelayAvailable()) {
        response.status(503).json({
          ok: false,
          error: 'SIM2REAL_STUDIO_RELAY_UNAVAILABLE',
          message: 'Studio 登录中继未配置。',
        });
        return;
      }
      const userName = String(request.body?.userName ?? '').trim().slice(0, 160);
      const password = String(request.body?.password ?? '').slice(0, 256);
      if (!userName || !password) {
        response
          .status(400)
          .json({ ok: false, error: 'SIM2REAL_INVALID_CREDENTIALS', message: '请输入账号与密码。' });
        return;
      }
      const outcome = await runWithGuards(request, userName, password);
      applyCookies(response, outcome);
      response.status(outcome.status).json(outcome.body ?? { ok: outcome.status === 200 });
    },

    /** 表单形态（无 JS 的 HTML 登录页）：成功/失败一律重定向。 */
    async handleForm(request: Request, response: Response): Promise<void> {
      if (!studioDirectRelayAvailable()) {
        response.redirect(302, '/login?error=unavailable');
        return;
      }
      const userName = String(request.body?.userName ?? '').trim().slice(0, 160);
      const password = String(request.body?.password ?? '').slice(0, 256);
      if (!userName || !password) {
        response.redirect(302, '/login?error=missing');
        return;
      }
      const outcome = await runWithGuards(request, userName, password);
      applyCookies(response, outcome);
      if (outcome.status === 200) response.redirect(302, '/');
      else response.redirect(302, `/login?error=${outcome.redirect?.split('error=')[1] ?? 'unavailable'}`);
    },
  };
}

/** 独立登录页（平台自有 UI；无脚本，CSP 免疫）。 */
export function renderStudioDirectLoginPage(error?: string): string {
  const messages: Record<string, string> = {
    missing: '请输入账号与密码。',
    invalid: '账号或密码不正确。',
    unavailable: '登录服务暂时不可用，请稍后重试。',
  };
  const errorHtml = error
    ? `<p class="login-error" role="alert">${messages[error] ?? '登录失败，请重试。'}</p>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>登录 · RDK Robot Learning Platform</title>
<link rel="stylesheet" href="/tokens.css"/>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}
  .login-card{width:min(380px,92vw);padding:28px 26px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
  h1{margin:0 0 4px;font-size:20px}
  .login-sub{margin:0 0 18px;color:var(--muted);font-size:13px}
  label{display:block;margin:12px 0 6px;font-size:13px;color:var(--muted-strong)}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line-strong);border-radius:8px;background:var(--bg);color:var(--text);font-size:14px}
  button{width:100%;margin-top:18px;padding:11px 12px;border:0;border-radius:8px;background:var(--accent);color:var(--panel);font-size:15px;font-weight:600;cursor:pointer}
  button:hover{filter:brightness(1.05)}
  .login-error{margin:14px 0 0;padding:10px 12px;border-radius:8px;background:var(--red-soft,#fdecec);color:var(--red-text,#a12b2b);font-size:13px}
  .login-note{margin-top:16px;color:var(--muted);font-size:12px;line-height:1.5}
</style>
</head>
<body>
<main class="login-card">
  <h1>RDK Robot Learning Platform</h1>
  <p class="login-sub">使用工作区账号登录，会话由统一登录服务签发。</p>
  ${errorHtml}
  <form method="post" action="/api/sim2real/auth/studio-direct/login">
    <label for="userName">账号</label>
    <input id="userName" name="userName" autocomplete="username" required/>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required/>
    <button type="submit">登录</button>
  </form>
  <p class="login-note">登录即表示同意以工作区身份在本平台记录训练、评测与部署数据。</p>
</main>
</body>
</html>`;
}
