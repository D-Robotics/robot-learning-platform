import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginAuth } from '../plugins/rdk-robot-learning-platform/scripts/plugin-auth.mjs';
const origin = 'https://studio.example';
const base = origin + '/robotics-learning';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let approved = false,
    revoked = false,
    clock = Date.now();
  const seen = [];
  const secret = 's'.repeat(43),
    id = 'a'.repeat(32);
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers });
    const p = new URL(url).pathname;
    let value;
    let status = 200;
    if (p.endsWith('/start'))
      value = {
        ok: true,
        id,
        secret,
        verificationUrl: origin + '/api/sso/plugin/authorize?id=' + id,
        userCode: 'AAAAAAAA',
        expiresAt: clock + 300000,
      };
    else if (p.endsWith('/poll')) {
      status = approved ? 200 : 202;
      value = approved
        ? {
            ok: true,
            status: 'authenticated',
            accountId: 'alice',
            expiresAt: clock + 60000,
            cookie: 'rdk_sso_web_session=private-cookie',
          }
        : { ok: true, status: 'pending' };
    } else if (p === '/api/sso/me') value = { user: revoked ? null : { id: 'alice' } };
    else if (p.endsWith('/session')) {
      const body = JSON.parse(init.body);
      status = revoked ? 401 : 200;
      value = revoked
        ? { error: 'STUDIO_LOGIN_REQUIRED' }
        : {
            ok: true,
            accountId: body.accountId,
            expiresAt: clock + 60000,
            cookie: 'rdk_sso_web_session=private-cookie',
          };
    } else throw Error('unexpected endpoint');
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    dir,
    fetchImpl,
    seen,
    approve: () => (approved = true),
    revoke: () => (revoked = true),
    now: () => clock,
    expire: () => (clock += 70000),
  };
}
test('generic host starts browser guidance, keeps secret out of results, persists privately and restores', async (t) => {
  const f = fixture(t);
  const options = {
    env: { RDK_SIM2REAL_MCP_BASE_URL: base },
    cacheDirectory: f.dir,
    fetchImpl: f.fetchImpl,
    now: f.now,
    openUrl: async () => {},
  };
  const a = createPluginAuth(options);
  const pending = await a.call('rdk_auth_login', { openBrowser: false });
  assert.equal(pending.authenticated, false);
  assert.ok(pending.verificationUrl);
  assert.ok(!JSON.stringify(pending).includes('s'.repeat(43)));
  assert.equal((await a.status()).authenticated, false);
  f.approve();
  assert.equal((await a.status()).accountId, 'alice');
  assert.equal(fs.statSync(path.join(f.dir, fs.readdirSync(f.dir)[0])).mode & 0o777, 0o600);
  const b = createPluginAuth(options);
  assert.equal((await b.status()).authenticated, true);
  assert.ok(!JSON.stringify(await b.status()).includes('private-cookie'));
  await a.call('rdk_auth_logout');
  assert.equal((await a.status()).authenticated, false);
  assert.equal(fs.readdirSync(f.dir).length, 0);
});
test('native host never opens browser or reads another account, sends credential only to pinned origin', async (t) => {
  const f = fixture(t);
  let opens = 0;
  const a = createPluginAuth({
    env: {
      RDK_SIM2REAL_MCP_BASE_URL: base,
      RDK_STUDIO_LOGIN_BOUND: '1',
      RDK_STUDIO_LOGIN_ACCOUNT: 'alice',
      RDK_STUDIO_LOGIN_SESSION: 'native-private',
      RDK_STUDIO_LOGIN_ORIGIN: origin,
    },
    fetchImpl: f.fetchImpl,
    cacheDirectory: f.dir,
    openUrl: async () => opens++,
  });
  const result = await a.call('rdk_auth_login');
  assert.equal(result.mode, 'studio-session');
  assert.equal(result.accountId, 'alice');
  assert.equal(opens, 0);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].headers['x-rdk-sso-session'], 'native-private');
  assert.ok(!JSON.stringify(result).includes('native-private'));
  f.revoke();
  assert.equal((await a.status()).authenticated, false);
});
test('unbound/logged-out Studio does not fall back to browser or stale explicit passwords', async (t) => {
  const f = fixture(t);
  const a = createPluginAuth({
    env: {
      RDK_SIM2REAL_MCP_BASE_URL: base,
      RDK_STUDIO_LOGIN_BOUND: '1',
      RDK_SIM2REAL_MCP_PASSWORD: 'old-password',
    },
    fetchImpl: f.fetchImpl,
    cacheDirectory: f.dir,
  });
  assert.equal((await a.status()).authenticated, false);
  assert.equal(f.seen.length, 0);
});
test('cross-origin native binding and malformed remote URL fail before credentials leave', async (t) => {
  const f = fixture(t);
  const a = createPluginAuth({
    env: {
      RDK_SIM2REAL_MCP_BASE_URL: base,
      RDK_STUDIO_LOGIN_BOUND: '1',
      RDK_STUDIO_LOGIN_ACCOUNT: 'alice',
      RDK_STUDIO_LOGIN_SESSION: 'native-private',
      RDK_STUDIO_LOGIN_ORIGIN: 'https://evil.example',
    },
    fetchImpl: f.fetchImpl,
    cacheDirectory: f.dir,
  });
  await assert.rejects(
    a.cookie(),
    (e) => e.code === 'STUDIO_LOGIN_REQUIRED' && e.httpStatus === 401,
  );
  assert.equal(f.seen.length, 0);
  assert.throws(
    () => createPluginAuth({ env: { RDK_SIM2REAL_MCP_BASE_URL: 'http://evil.example' } }),
    /HTTPS/,
  );
});
test('browser parent logout/expiry is checked against SSO before every use', async (t) => {
  const f = fixture(t);
  const a = createPluginAuth({
    env: { RDK_SIM2REAL_MCP_BASE_URL: base },
    cacheDirectory: f.dir,
    fetchImpl: f.fetchImpl,
    now: f.now,
    openUrl: async () => {},
  });
  await a.call('rdk_auth_login');
  f.approve();
  assert.equal((await a.status()).authenticated, true);
  f.revoke();
  assert.equal((await a.status()).authenticated, false);
  assert.ok(f.seen.some((x) => x.url === origin + '/api/sso/me'));
});

test('authenticated proxy preserves idempotency and locale without forwarding host credentials', async () => {
  const { proxyRequestHeaders } =
    await import('../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs');
  const h = proxyRequestHeaders(
    {
      'idempotency-key': 'one-write',
      'accept-language': 'en-US',
      'x-sim2real-turn-id': 'turn-7',
      authorization: 'Bearer untrusted',
      cookie: 'proxy-secret',
      origin: 'https://evil.example',
    },
    Buffer.from('{}'),
    'rdk_sso_web_session=verified',
  );
  assert.equal(h['idempotency-key'], 'one-write');
  assert.equal(h['accept-language'], 'en-US');
  assert.equal(h['x-sim2real-turn-id'], 'turn-7');
  assert.equal(h.cookie, 'rdk_sso_web_session=verified');
  assert.equal(h.authorization, undefined);
  assert.equal(h.origin, undefined);
});

test('native authentication transport errors preserve identity and do not ask to sign in again', async (t) => {
  const f = fixture(t);
  const a = createPluginAuth({
    env: {
      RDK_SIM2REAL_MCP_BASE_URL: base,
      RDK_STUDIO_LOGIN_BOUND: '1',
      RDK_STUDIO_LOGIN_ACCOUNT: 'alice',
      RDK_STUDIO_LOGIN_SESSION: 'native-private',
      RDK_STUDIO_LOGIN_ORIGIN: origin,
    },
    cacheDirectory: f.dir,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const status = await a.status();
  assert.equal(status.authenticated, null);
  assert.equal(status.needsLogin, false);
  assert.equal(status.error, 'PLATFORM_NETWORK_ERROR');
  assert.equal(status.accountId, 'alice');
});
test('a temporary SSO service failure preserves the browser cache and recovers without another approval', async (t) => {
  const f = fixture(t);
  let unavailable = false;
  const a = createPluginAuth({
    env: { RDK_SIM2REAL_MCP_BASE_URL: base },
    cacheDirectory: f.dir,
    now: f.now,
    fetchImpl: async (...args) =>
      unavailable
        ? new Response(JSON.stringify({ error: 'SERVER_UNAVAILABLE' }), { status: 503 })
        : f.fetchImpl(...args),
    openUrl: async () => {},
  });
  await a.call('rdk_auth_login', { openBrowser: false });
  f.approve();
  assert.equal((await a.status()).authenticated, true);
  unavailable = true;
  const before = fs.readdirSync(f.dir);
  const status = await a.status();
  assert.equal(status.needsLogin, false);
  assert.equal(status.authenticated, null);
  assert.deepEqual(fs.readdirSync(f.dir), before);
  unavailable = false;
  assert.equal((await a.status()).authenticated, true);
});

test('concurrent first-use checks share one browser confirmation code', async (t) => {
  const f = fixture(t);
  let starts = 0;
  const a = createPluginAuth({
    env: { RDK_SIM2REAL_MCP_BASE_URL: base },
    cacheDirectory: f.dir,
    now: f.now,
    fetchImpl: async (...args) => {
      if (String(args[0]).endsWith('/start')) {
        starts++;
        await new Promise((r) => setTimeout(r, 15));
      }
      return f.fetchImpl(...args);
    },
    openUrl: async () => {},
  });
  const results = await Promise.all([
    a.status(),
    a.call('rdk_auth_login', { openBrowser: false }),
    a.status(),
  ]);
  assert.equal(starts, 1);
  assert.equal(new Set(results.map((x) => x.userCode)).size, 1);
});
test('logout during browser confirmation cannot restore the old session or recreate its cache', async (t) => {
  const f = fixture(t);
  let release, entered;
  const waiting = new Promise((r) => (entered = r));
  const gate = new Promise((r) => (release = r));
  const a = createPluginAuth({
    env: { RDK_SIM2REAL_MCP_BASE_URL: base },
    cacheDirectory: f.dir,
    now: f.now,
    fetchImpl: async (...args) => {
      if (String(args[0]).endsWith('/poll')) {
        entered();
        await gate;
      }
      return f.fetchImpl(...args);
    },
    openUrl: async () => {},
  });
  await a.call('rdk_auth_login', { openBrowser: false });
  f.approve();
  const status = a.status();
  await waiting;
  await a.call('rdk_auth_logout');
  release();
  await status;
  assert.equal((await a.status()).authenticated, false);
  assert.equal(fs.readdirSync(f.dir).length, 0);
});
