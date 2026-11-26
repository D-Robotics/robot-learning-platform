import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Router, urlencoded, type Request, type Response } from 'express';

import type { Sim2RealAuthPort } from './sim2real-auth.js';
import {
  decodeStudioWebCloudCookie,
  parseCookieValue,
  STUDIO_WEB_CLOUD_SESSION_COOKIE,
} from './studio-cookie-auth.js';

export const STUDIO_PLUGIN_AUTHORIZE_PATH = '/api/sso/plugin/authorize';
const FLOW_TTL_MS = 10 * 60_000;
const FLOW_LIMIT = 1_024;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

type ApprovedSession = { accountId: string; expiresAt: number; cookie: string };
type Flow = {
  expiresAt: number;
  secretHash: Buffer;
  userCode: string;
  attempts: number;
  approved?: ApprovedSession;
};

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function field(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}

export function createStudioPluginAuthRouter({
  auth,
  enabled,
  basePath,
  publicOrigin,
  now = Date.now,
}: {
  auth: Sim2RealAuthPort;
  enabled: boolean;
  basePath: string;
  publicOrigin: string | undefined;
  now?: () => number;
}): Router {
  const router = Router();
  const flows = new Map<string, Flow>();
  const authorizePath = basePath + STUDIO_PLUGIN_AUTHORIZE_PATH;
  const audience = publicOrigin ? publicOrigin + basePath : '';
  const active = enabled && Boolean(audience);

  router.use('/api/sso/plugin', (_request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    if (!active) {
      response.status(503).json({ error: 'PLUGIN_AUTH_NOT_CONFIGURED' });
      return;
    }
    next();
  });

  function readSession(request: Request): ApprovedSession | null {
    const principal = auth.resolvePrincipal(request);
    if (!principal) return null;
    const value = parseCookieValue(request.headers.cookie, STUDIO_WEB_CLOUD_SESSION_COOKIE);
    const payload = decodeStudioWebCloudCookie(value, { now });
    if (payload?.user.id !== principal.accountId) return null;
    return {
      accountId: principal.accountId,
      expiresAt: payload.expiresAt,
      cookie: STUDIO_WEB_CLOUD_SESSION_COOKIE + '=' + encodeURIComponent(value),
    };
  }

  function findFlow(id: string | null): Flow | undefined {
    if (!id) return undefined;
    const flow = flows.get(id);
    if (flow && flow.expiresAt > now()) return flow;
    flows.delete(id);
    return undefined;
  }

  function page(response: Response, status: number, content: string): void {
    response
      .status(status)
      .set({
        'Content-Security-Policy':
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'X-Frame-Options': 'DENY',
      })
      .type('html')
      .send(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>授权学习平台插件</title><main><h1>授权学习平台插件</h1>${content}</main></html>`,
      );
  }

  router.post('/api/sso/plugin/start', (request, response) => {
    if (request.body?.audience !== audience) {
      response.status(400).json({ error: 'PLUGIN_AUTH_AUDIENCE_INVALID' });
      return;
    }
    for (const [id, flow] of flows) {
      if (flow.expiresAt <= now()) flows.delete(id);
    }
    if (flows.size >= FLOW_LIMIT) {
      response.status(429).json({ error: 'PLUGIN_AUTH_CAPACITY' });
      return;
    }
    const id = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const userCode = Array.from(
      { length: 8 },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
    ).join('');
    const expiresAt = now() + FLOW_TTL_MS;
    flows.set(id, { expiresAt, secretHash: hash(secret), userCode, attempts: 0 });
    response.json({
      id,
      secret,
      userCode,
      expiresAt,
      verificationUrl: publicOrigin + authorizePath + '?id=' + id,
    });
  });

  router.get(STUDIO_PLUGIN_AUTHORIZE_PATH, (request, response) => {
    const id = field(request.query.id, /^[a-f0-9]{32}$/);
    const flow = findFlow(id);
    if (!flow) return page(response, 410, '<p>连接请求已过期，请在插件内重新申请。</p>');
    if (flow.approved) return page(response, 200, '<p>已确认。请回到插件检查连接。</p>');
    const principal = auth.resolvePrincipal(request);
    if (!principal)
      return page(
        response,
        401,
        `<p>请先登录学习平台，再确认连接。</p><p><a href="${escapeHtml(basePath + '/login?returnTo=' + encodeURIComponent(authorizePath + '?id=' + id))}">登录学习平台</a></p>`,
      );
    const name = escapeHtml(principal.displayName ?? principal.accountId);
    // no-referrer would also make the browser send Origin: null on this
    // form POST. strict-origin preserves the origin without exposing the flow ID.
    response.set('Referrer-Policy', 'strict-origin');
    page(
      response,
      200,
      `<p>当前账号：<strong>${name}</strong></p><p>输入插件显示的连接码。请只确认你本人发起的连接。</p><form method="post" action="${escapeHtml(authorizePath)}"><input type="hidden" name="id" value="${id}"><label>连接码 <input name="code" required maxlength="8" pattern="[A-Za-z0-9]{8}" autocapitalize="characters" autocomplete="off"></label> <button>确认授权</button></form>`,
    );
  });

  router.post(
    STUDIO_PLUGIN_AUTHORIZE_PATH,
    urlencoded({ extended: false, limit: '4kb' }),
    (request, response) => {
      if (request.get('origin') !== publicOrigin) {
        return page(response, 403, '<p>请在学习平台授权页确认连接。</p>');
      }
      const id = field(request.body?.id, /^[a-f0-9]{32}$/);
      const flow = findFlow(id);
      if (!id || !flow) return page(response, 410, '<p>连接请求已过期，请在插件内重新申请。</p>');
      if (flow.approved) return page(response, 200, '<p>已确认。请回到插件检查连接。</p>');
      const session = readSession(request);
      if (!session)
        return page(response, 401, '<p>学习平台登录已过期。请登录后重新打开授权链接。</p>');
      const code = field(request.body?.code, /^[a-zA-Z0-9]{8}$/)?.toUpperCase();
      if (!code || !timingSafeEqual(Buffer.from(code), Buffer.from(flow.userCode))) {
        if (++flow.attempts >= 5) {
          flows.delete(id);
          return page(response, 410, '<p>连接码多次错误，请在插件内重新申请。</p>');
        }
        return page(
          response,
          403,
          `<p>连接码不匹配。<a href="${escapeHtml(authorizePath + '?id=' + id)}">返回重试</a></p>`,
        );
      }
      flow.approved = session;
      return page(response, 200, '<p>授权成功。请回到插件继续 Workshop。</p>');
    },
  );

  router.post('/api/sso/plugin/poll', (request, response) => {
    const id = field(request.body?.id, /^[a-f0-9]{32}$/);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization') ?? '')?.[1];
    const flow = findFlow(id);
    if (!flow) {
      response.status(410).json({ error: 'PLUGIN_AUTH_EXPIRED' });
      return;
    }
    if (!token || !timingSafeEqual(hash(token), flow.secretHash)) {
      response.status(403).json({ error: 'PLUGIN_AUTH_DENIED' });
      return;
    }
    if (!flow.approved) {
      response.status(202).json({ status: 'pending' });
      return;
    }
    if (flow.approved.expiresAt <= now()) {
      response.status(410).json({ error: 'PLUGIN_AUTH_EXPIRED' });
      return;
    }
    // Keep the same receipt until this flow expires, so a lost poll response
    // or an MCP restart can finish the confirmed connection.
    response.json({ status: 'authenticated', ...flow.approved });
  });

  return router;
}
