import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';

import {
  createStudioCookieAuth,
  encodeStudioWebCloudCookie,
  STUDIO_WEB_CLOUD_SESSION_COOKIE,
} from './studio-cookie-auth.js';
import { sim2RealCsrfMiddleware } from './standalone-adapters.js';
import { renderStudioDirectLoginPage } from './studio-direct-relay.js';
import { createStudioPluginAuthRouter } from './studio-plugin-auth.js';

afterEach(() => vi.unstubAllEnvs());

it('requires the displayed browser account and code, and only yields its original session to the matching plugin', async () => {
  const publicOrigin = 'https://studio.test';
  const basePath = '/robotics-learning';
  const audience = publicOrigin + basePath;
  const secret = 's'.repeat(48);
  const sessionExpiry = Date.now() + 60_000;
  vi.stubEnv('RDK_STUDIO_COOKIE_SECRET', secret);
  vi.stubEnv('RDK_SIM2REAL_AUTH_MODE', 'studio-cookie');
  vi.stubEnv('RDK_SIM2REAL_ALLOWED_ORIGINS', publicOrigin);
  let clock = Date.now();
  const auth = createStudioCookieAuth({ secret, now: () => clock });
  const cookie = (name: string) =>
    STUDIO_WEB_CLOUD_SESSION_COOKIE +
    '=' +
    encodeStudioWebCloudCookie(
      { id: name, name: '<' + name + '>', email: '' },
      sessionExpiry,
      undefined,
      { secret },
    );
  const alice = cookie('alice');
  const bob = cookie('bob');
  const app = express();
  app.use(express.json(), express.urlencoded({ extended: false }));
  app.use(
    basePath,
    sim2RealCsrfMiddleware,
    createStudioPluginAuthRouter({
      auth,
      enabled: true,
      basePath,
      publicOrigin,
      now: () => clock,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}`;
    const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(api + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const plugin = '/api/sso/plugin';
    expect((await post(plugin + '/start', { audience: 'https://elsewhere.test/' })).status).toBe(
      400,
    );
    const started = await post(plugin + '/start', { audience });
    expect(started.status).toBe(200);
    expect(started.headers.get('cache-control')).toBe('no-store');
    expect(started.headers.get('referrer-policy')).toBe('no-referrer');
    const flow = await started.json();
    const approval = '/api/sso/plugin/authorize';
    const view = approval + '?id=' + flow.id;
    expect(flow.verificationUrl).toBe(audience + view);
    const poll = (token: string) =>
      post(plugin + '/poll', { id: flow.id }, { authorization: 'Bearer ' + token });
    expect((await poll(flow.secret)).status).toBe(202);
    const loggedOut = await fetch(api + view);
    expect(loggedOut.status).toBe(401);
    expect(loggedOut.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await loggedOut.text()).toContain(encodeURIComponent(basePath + view));
    expect(
      renderStudioDirectLoginPage(undefined, basePath, undefined, undefined, basePath + view),
    ).toContain(`name="returnTo" value="${basePath + view}"`);
    const page = await fetch(api + view, { headers: { cookie: alice } });
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    // A browser-initiated form POST needs a non-opaque Origin. Only the
    // origin should appear in Referer, never the page URL with its flow ID.
    expect(page.headers.get('referrer-policy')).toBe('strict-origin');
    expect(await page.text()).toContain('&lt;alice&gt;');
    const confirm = (
      code: string,
      origin: string | undefined,
      value: string,
      site = 'same-origin',
    ) =>
      fetch(api + approval, {
        method: 'POST',
        headers: {
          ...(origin === undefined ? {} : { origin }),
          cookie: value,
          'sec-fetch-site': site,
        },
        body: new URLSearchParams({ id: flow.id, code }),
      });
    const denied = async (origin: string, site: string) => {
      const response = await confirm(flow.userCode, origin, alice, site);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'SIM2REAL_CSRF_BLOCKED' });
    };
    await denied('null', 'same-origin');
    await denied('https://elsewhere.test', 'same-site');
    await denied(publicOrigin, 'cross-site');
    expect((await confirm(flow.userCode, undefined, alice)).status).toBe(403);
    expect((await poll(flow.secret)).status).toBe(202);
    expect((await confirm('00000000', publicOrigin, alice)).status).toBe(403);
    expect((await confirm(flow.userCode, publicOrigin, alice)).status).toBe(200);
    expect((await confirm(flow.userCode, publicOrigin, bob)).status).toBe(200);
    expect((await poll('Z'.repeat(43))).status).toBe(403);
    expect(await (await poll(flow.secret)).json()).toEqual({
      accountId: 'alice',
      expiresAt: sessionExpiry,
      cookie: alice,
      status: 'authenticated',
    });
    clock += 61_000;
    expect((await poll(flow.secret)).status).toBe(410);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
