import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAuthenticatedCore } from '../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs';

async function fixture(t, fetchImpl, cookie = async () => 'rdk_sso_web_session=fixture-verified') {
  let childEnv,
    invalidations = 0;
  const auth = {
    audience: 'https://studio.example/robotics-learning',
    mode: 'browser-login',
    cookie,
    status: async () => ({ authenticated: true }),
    invalidate: async () => invalidations++,
  };
  const core = await connectAuthenticatedCore({
    authentication: auth,
    fetchImpl,
    connect: (options) => {
      childEnv = options.env;
      return { request: async () => ({}), notify() {}, close: async () => {} };
    },
  });
  t.after(() => core.close());
  assert.ok(childEnv, 'proxy connection must use the owned core factory');
  const request = (pathname, options = {}) =>
    fetch(childEnv.RDK_SIM2REAL_MCP_BASE_URL + pathname, {
      ...options,
      headers: { cookie: childEnv.RDK_SIM2REAL_MCP_COOKIE, ...options.headers },
    });
  return { core, request, invalidations: () => invalidations };
}
test('network failure is a gateway error and does not delete the account session', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw new TypeError('fetch failed');
  });
  const response = await f.request('/api/v1/duck/models');
  const value = await response.json();
  assert.equal(response.status, 502);
  assert.equal(value.error, 'PLATFORM_NETWORK_ERROR');
  assert.equal(value.needsLogin, false);
  assert.equal(f.invalidations(), 0);
  assert.equal(calls, 1);
});
test('timeout keeps sign-in and never retries a mutation', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    throw new DOMException('timed out', 'TimeoutError');
  });
  const response = await f.request('/api/v1/duck/runs', {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json' },
  });
  const value = await response.json();
  assert.equal(response.status, 504);
  assert.equal(value.error, 'PLATFORM_TIMEOUT');
  assert.equal(value.needsLogin, false);
  assert.equal(f.invalidations(), 0);
  assert.equal(calls, 1);
});
test('only a real upstream 401 invalidates login; permission rejection remains 403', async (t) => {
  let status = 403;
  const f = await fixture(
    t,
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: status === 403 ? 'PERMISSION_DENIED' : 'SESSION_EXPIRED',
        }),
        { status, headers: { 'content-type': 'application/json' } },
      ),
  );
  assert.equal((await f.request('/api/v1/duck/models')).status, 403);
  assert.equal(f.invalidations(), 0);
  status = 401;
  const response = await f.request('/api/v1/duck/models');
  assert.equal(response.status, 401);
  assert.equal((await response.json()).needsLogin, true);
  assert.equal(f.invalidations(), 1);
});
test('course model reader uses the same verified identity and preserves full manifests', async (t) => {
  const manifest = { modelId: 'course', contract: { observationSize: 14 } };
  const f = await fixture(t, async (url, options) => {
    assert.equal(String(url), 'https://studio.example/robotics-learning/api/v1/duck/models');
    assert.equal(options.headers.cookie, 'rdk_sso_web_session=fixture-verified');
    assert.equal(options.redirect, 'error');
    return Response.json({ models: [{ id: 'model', manifest }] });
  });
  assert.deepEqual((await f.core.readModels()).models[0].manifest, manifest);
});

test('experiment sessions use only the pinned platform and never return its session cookie', async (t) => {
  const observed = [];
  const f = await fixture(t, async (url, options) => {
    observed.push({ url: String(url), method: options.method });
    assert.equal(options.headers.cookie, 'rdk_sso_web_session=fixture-verified');
    assert.equal(options.redirect, 'error');
    return Response.json({
      ok: true,
      schemaVersion: 1,
      ownerScoped: true,
      view: { contextId: 'lesson', training: { runId: 'train' } },
    });
  });
  const caps = await f.core.experimentSession('capabilities');
  assert.equal(caps.supported, true);
  const result = await f.core.experimentSession('remember', {
    contextId: 'lesson',
    runId: 'train',
  });
  assert.doesNotMatch(JSON.stringify(result), /fixture-verified/);
  assert.deepEqual(observed, [
    {
      url: 'https://studio.example/robotics-learning/api/v1/duck/experiments/capabilities',
      method: 'GET',
    },
    { url: 'https://studio.example/robotics-learning/api/v1/duck/experiments', method: 'POST' },
  ]);
  await assert.rejects(f.core.experimentSession('resume', { contextId: '../../other' }));
  assert.equal(observed.length, 2);
});

test('only a missing capability route permits local fallback; other session errors remain failures', async (t) => {
  let status = 404;
  const f = await fixture(t, async () =>
    Response.json({ ok: false, code: 'EXPERIMENT_NOT_FOUND', message: '未找到此实验' }, { status }),
  );
  assert.deepEqual(await f.core.experimentSession('capabilities'), { supported: false });
  await assert.rejects(f.core.experimentSession('resume', { contextId: 'lesson' }), {
    code: 'EXPERIMENT_NOT_FOUND',
    httpStatus: 404,
  });
  status = 503;
  await assert.rejects(f.core.experimentSession('capabilities'), { httpStatus: 503 });
  assert.equal(f.invalidations(), 0);
});
test('course model reader rejects malformed and oversized responses without invalidating login', async (t) => {
  let payload = 'not json';
  const f = await fixture(t, async () => new Response(payload));
  await assert.rejects(f.core.readModels(), { code: 'MODEL_RESPONSE_INVALID' });
  payload = 'x'.repeat(2 * 1024 * 1024 + 1);
  await assert.rejects(f.core.readModels(), { code: 'MODEL_RESPONSE_TOO_LARGE' });
  assert.equal(f.invalidations(), 0);
});

test('board connect and Workshop creation use the account that selected the target', async (t) => {
  let account = 'alice';
  const requests = [];
  const f = await fixture(
    t,
    async (url, options) => {
      requests.push([new URL(url).pathname, options.method]);
      assert.equal(options.headers.cookie, 'rdk_sso_web_session=alice');
      return Response.json({ ok: true, schemaVersion: 1 });
    },
    async (options) => {
      assert.equal(options.startLogin, false);
      if (options.accountId !== account) throw Error('账号已切换');
      return 'rdk_sso_web_session=' + account;
    },
  );
  await f.core.developmentTarget('connect-board', { accountId: account, targetId: 'b1' });
  await f.core.workshopSession('create', { computeResourceId: 'w1' }, { accountId: account });
  account = 'bob';
  await assert.rejects(
    f.core.developmentTarget('connect-board', { accountId: 'alice', targetId: 'b1' }),
    /账号已切换/,
  );
  await assert.rejects(
    f.core.workshopSession('create', { computeResourceId: 'w1' }, { accountId: 'alice' }),
    /账号已切换/,
  );
  assert.deepEqual(requests, [
    ['/robotics-learning/api/sim2real/device-connections/b1/connect', 'POST'],
    ['/robotics-learning/api/v1/duck/workshop-sessions', 'POST'],
  ]);
});
