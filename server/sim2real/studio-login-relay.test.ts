import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  encodeStudioWebCloudCookie,
  STUDIO_WEB_CLOUD_SESSION_COOKIE,
} from './studio-cookie-auth.js';
import { createStudioLoginRelayRouter } from './studio-login-relay.js';

const NOW = 1_760_000_000_000;
const SECRET = 'k'.repeat(48);
const USER = { id: 'user-42', name: 'Alice', email: 'alice@example.com' };

process.env.RDK_STUDIO_COOKIE_SECRET = SECRET;

// The relay decodes with the real clock, so the minted cookie must expire in
// the actual future (the fixed NOW above is only for the codec tests).
const futureExpiry = Date.now() + 60_000;

function studioLoginResponse(): Response {
  const cookieValue = encodeStudioWebCloudCookie(USER, futureExpiry, 'robogo-token', {
    secret: SECRET,
  });
  const response = new Response(JSON.stringify({ ok: true, user: USER }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(cookieValue ? { 'set-cookie': `${STUDIO_WEB_CLOUD_SESSION_COOKIE}=${encodeURIComponent(cookieValue)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=1209600` } : {}),
    },
  });
  return response;
}

function fakeFetchSequence(responses: (Response | Error)[]): typeof fetch {
  let index = 0;
  return (async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

type RelayCall = {
  method: string;
  path: string;
  headers: Record<string, unknown>;
  body: unknown;
};

async function callRelay(
  router: ReturnType<typeof createStudioLoginRelayRouter>,
  init: { path: string; method: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string[]> }> {
  const calls: RelayCall[] = [];
  // Minimal express router shim: invoke handlers directly on a fake req/res.
  const request = {
    method: init.method,
    path: init.path,
    url: init.path,
    headers: { origin: 'https://sim2real.test' },
    body: init.body ?? {},
  } as unknown as Request;
  const headers: Record<string, string[]> = {};
  const response = {
    status(code: number) {
      calls.push({ method: 'POST', path: 'status', headers: {}, body: code });
      response.statusCode = code;
      return response;
    },
    statusCode: 0,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value : [value];
      return response;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()]?.join(', ');
    },
    json(payload: Record<string, unknown>) {
      calls.push({ method: 'POST', path: 'json', headers: {}, body: payload });
      response.sent = payload;
      return response;
    },
    sent: null as unknown,
  } as unknown as {
    status: (code: number) => unknown;
    statusCode: number;
    setHeader: (name: string, value: string | string[]) => unknown;
    getHeader: (name: string) => string | undefined;
    json: (payload: Record<string, unknown>) => unknown;
    sent: unknown;
  };
  // Find the matching route in the router stack.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (router as any).stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: unknown, res: unknown, next: (err?: unknown) => void) => void }> };
  }>;
  const layer = stack.find((entry) => entry.route?.path === init.path && entry.route.methods[init.method.toLowerCase()]);
  if (!layer) throw new Error(`route not found: ${init.method} ${init.path}`);
  await new Promise<void>((resolve) => {
    for (const routeLayer of layer.route!.stack) {
      routeLayer.handle(request, response, () => undefined);
    }
    // Async handlers fire a detached promise; poll until the JSON body lands.
    const startedAt = Date.now();
    const waitForBody = () => {
      if (response.sent !== null || Date.now() - startedAt > 2_000) resolve();
      else setTimeout(waitForBody, 5);
    };
    waitForBody();
  });
  return { status: response.statusCode, body: (response.sent ?? {}) as Record<string, unknown>, headers };
}

describe('studio login relay routes', () => {
  it('POST /api/sso/login relays credentials and adopts the Studio cookie', async () => {
    process.env.RDK_SIM2REAL_STUDIO_SHELL_URL = 'https://studio.example';
    process.env.RDK_SIM2REAL_PUBLIC_ORIGIN = 'https://sim2real.test';
    const router = createStudioLoginRelayRouter({
      fetchImpl: fakeFetchSequence([studioLoginResponse()]),
    });
    const result = await callRelay(router, {
      path: '/api/sso/login',
      method: 'POST',
      body: { method: 'account', userName: 'alice', password: 'secret-pw' },
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    const identity = result.body.identity as Record<string, string>;
    expect(identity.accountId).toBe('user-42');
    const setCookie = result.headers['set-cookie'] ?? [];
    expect(setCookie.some((cookie) => cookie.startsWith(`${STUDIO_WEB_CLOUD_SESSION_COOKIE}=`))).toBe(true);
    delete process.env.RDK_SIM2REAL_STUDIO_SHELL_URL;
    delete process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
  });

  it('rejects an invalid login method', async () => {
    process.env.RDK_SIM2REAL_STUDIO_SHELL_URL = 'https://studio.example';
    const router = createStudioLoginRelayRouter({ fetchImpl: fakeFetchSequence([]) });
    const result = await callRelay(router, {
      path: '/api/sso/login',
      method: 'POST',
      body: { method: 'wechat' },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('SIM2REAL_LOGIN_METHOD_INVALID');
    delete process.env.RDK_SIM2REAL_STUDIO_SHELL_URL;
  });

  it('surfaces upstream login rejections with the upstream status', async () => {
    process.env.RDK_SIM2REAL_STUDIO_SHELL_URL = 'https://studio.example';
    const upstream = new Response(JSON.stringify({ ok: false, message: '密码错误' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
    const router = createStudioLoginRelayRouter({ fetchImpl: fakeFetchSequence([upstream]) });
    const result = await callRelay(router, {
      path: '/api/sso/login',
      method: 'POST',
      body: { method: 'account', userName: 'alice', password: 'wrong' },
    });
    expect(result.status).toBe(409);
    expect(result.body.message).toBe('密码错误');
    delete process.env.RDK_SIM2REAL_STUDIO_SHELL_URL;
  });

  it('reports an unreachable Studio shell as a retryable 502', async () => {
    process.env.RDK_SIM2REAL_STUDIO_SHELL_URL = 'https://studio.example';
    const router = createStudioLoginRelayRouter({
      fetchImpl: fakeFetchSequence([new Error('fetch failed')]),
    });
    const result = await callRelay(router, {
      path: '/api/sso/login',
      method: 'POST',
      body: { method: 'account', userName: 'alice', password: 'pw' },
    });
    expect(result.status).toBe(502);
    expect(result.body.retryable).toBe(true);
    delete process.env.RDK_SIM2REAL_STUDIO_SHELL_URL;
  });

  it('POST /api/sso/logout clears the session cookie', async () => {
    const router = createStudioLoginRelayRouter({ fetchImpl: fakeFetchSequence([]) });
    const result = await callRelay(router, { path: '/api/sso/logout', method: 'POST' });
    expect(result.status).toBe(200);
    expect((result.headers['set-cookie'] ?? [])[0]).toContain(`${STUDIO_WEB_CLOUD_SESSION_COOKIE}=;`);
  });
});
