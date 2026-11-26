import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAuthenticatedCore } from '../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs';

async function fixture(
  t,
  fetchImpl,
  cookie = async () => 'rdk_sso_web_session=fixture-verified',
  upstreamRequest = async () => ({}),
) {
  let childEnv,
    invalidations = 0;
  const auth = {
    audience: 'https://studio.example/robotics-learning',
    mode: 'browser-login',
    cookie,
    status: async () => ({ authenticated: true, accountId: 'fixture-owner' }),
    invalidate: async () => invalidations++,
  };
  const core = await connectAuthenticatedCore({
    authentication: auth,
    fetchImpl,
    connect: (options) => {
      childEnv = options.env;
      return { request: upstreamRequest, notify() {}, close: async () => {} };
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

test('training preflight sends the selected resource, task, engine and device on the live route', async (t) => {
  const params = {
    name: 'rdk_training_preflight',
    arguments: {
      computeResourceId: 'gpu-7',
      taskId: 'originman-reference-track',
      engine: 'originman-reference-ppo',
      device: 'cuda',
    },
  };
  let failure;
  const f = await fixture(t, async (url, options) => {
    assert.match(String(url), /\/api\/v1\/duck\/compute-resources\/gpu-7\/preflight$/);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.cookie, 'rdk_sso_web_session=fixture-verified');
    assert.deepEqual(JSON.parse(options.body), {
      taskId: 'originman-reference-track',
      engine: 'originman-reference-ppo',
      device: 'cuda',
    });
    if (failure) return Response.json({ ok: false, error: failure }, { status: 404 });
    return Response.json({ ok: true, report: {}, trainingSubmitted: false });
  });
  assert.equal(
    (await f.core.request('tools/call', params)).structuredContent.trainingSubmitted,
    false,
  );
  failure = 'SIM2REAL_API_NOT_FOUND';
  const unavailable = await f.core.request('tools/call', params);
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.structuredContent.error, 'PLATFORM_FEATURE_UNAVAILABLE');
  failure = 'SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND';
  const missing = await f.core.request('tools/call', params);
  assert.equal(missing.structuredContent.error, failure);
});

test('logs use the authenticated cursor API once and resume from the last returned line', async (t) => {
  const lines = Array.from({ length: 250 }, (_, i) => ({
    n: i + 6,
    stream: 'stdout',
    text: 'training progress',
  }));
  let calls = 0;
  const f = await fixture(t, async (url, options) => {
    calls++;
    assert.match(String(url), /\/runs\/run-42\/logs\?after=5$/);
    assert.equal(options.headers.cookie, 'rdk_sso_web_session=fixture-verified');
    return Response.json({
      ok: true,
      runId: 'run-42',
      status: 'completed',
      total: 255,
      retainedFrom: 6,
      lines,
    });
  });
  const { structuredContent: value } = await f.core.request('tools/call', {
    name: 'rdk_run_logs',
    arguments: { runId: 'run-42', after: 5 },
  });
  assert.equal(calls, 1);
  assert.equal(value.lines.length, 200);
  assert.equal(value.nextAfter, 205);
  assert.equal(value.hasMore, true);
});

test('logs preserve a server-provided terminal tail and distinguish a transient Worker outage', async (t) => {
  let ready = true;
  const f = await fixture(t, async () =>
    ready
      ? Response.json({
          ok: true,
          runId: 'run-42',
          status: 'completed',
          total: 4,
          retainedFrom: 4,
          lines: [],
          source: 'retained-tail',
          stdoutTail: 'retained output',
        })
      : Response.json(
          { ok: false, error: 'SIM2REAL_RUN_LOGS_UNAVAILABLE', retryable: true },
          { status: 503 },
        ),
  );
  const request = () =>
    f.core.request('tools/call', {
      name: 'rdk_run_logs',
      arguments: { runId: 'run-42', after: 4 },
    });
  const tail = await request();
  assert.equal(tail.structuredContent.source, 'retained-tail');
  assert.equal(tail.structuredContent.nextAfter, 4);
  assert.equal(tail.structuredContent.stdoutTail, 'retained output');
  ready = false;
  const failure = await request();
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error, 'SIM2REAL_RUN_LOGS_UNAVAILABLE');
  assert.equal(failure.structuredContent.retryable, true);
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

test('board connection failures distinguish SSH reachability, authentication and agent health without exposing endpoints', async (t) => {
  let message;
  const f = await fixture(t, async () => Response.json({ ok: false, message }, { status: 502 }));
  for (const [upstream, expected] of [
    [
      'SSH 连接失败：ssh: connect to host 192.168.1.8 port 22: Connection timed out',
      'BOARD_SSH_TIMEOUT',
    ],
    [
      'SSH 连接失败：root@192.168.1.8: Permission denied (publickey,password)',
      'BOARD_SSH_AUTH_FAILED',
    ],
    ['板端 agent 健康检查失败', 'BOARD_AGENT_UNAVAILABLE'],
    ['unexpected raw internal details', 'DEVELOPMENT_TARGET_UNAVAILABLE'],
  ]) {
    message = upstream;
    await assert.rejects(
      f.core.developmentTarget('connect-board', { accountId: 'alice', targetId: 'b1' }),
      (error) => {
        assert.equal(error.code, expected);
        assert.equal(error.httpStatus, 502);
        assert.equal(error.needsLogin, false);
        assert.doesNotMatch(
          error.message + (error.nextAction ?? ''),
          /192\.168|root@|internal details/,
        );
        return true;
      },
    );
  }
});

test('telemetry summaries use the authenticated compact route for the exact Run', async (t) => {
  const f = await fixture(t, async (url) => {
    const target = new URL(url);
    assert.match(target.pathname, /\/runs\/run-42\/(telemetry|replay)$/);
    const list = target.pathname.endsWith('/telemetry');
    assert.equal(target.searchParams.get(list ? 'includeSamples' : 'includeFrames'), 'false');
    return Response.json(
      {
        ok: true,
        runId: 'run-42',
        telemetry: [{ id: 'chunk', sampleCount: 1540, source: 'browser', samples: [{ t: 0 }] }],
        frameCount: 1540,
      },
      { headers: { 'X-RDK-Telemetry-Summary': '1' } },
    );
  });
  const list = await f.core.readTelemetrySummary('rdk_telemetry_list', { runId: 'run-42' });
  assert.equal(list.telemetry[0].sampleCount, 1540);
  assert.equal(list.telemetry[0].samples, undefined);
  const replay = await f.core.readTelemetrySummary('rdk_runs_replay', { runId: 'run-42' });
  assert.equal(replay.frameCount, 1540);
  assert.equal(replay.frames, undefined);
});

test('OriginMan CPU preflight uses actual steps from the exact Run and never chooses a board', async (t) => {
  const runId = 'originman-formal-run';
  const sha256 = 'a'.repeat(64);
  const connected = { id: 'x5-ready', status: 'connected', boardPlatform: 'rdk-x5' };
  const disconnected = { id: 'x5-offline', status: 'disconnected', boardPlatform: 'rdk-x5' };
  const run = {
    id: runId,
    status: 'completed',
    contractId: 'custom-policy-originman-dance-v2',
    training: { originmanDance: { trainingSteps: 8192 } },
    metrics: { trainingSteps: 503808, originmanDance: { qualityGatePassed: true } },
    artifact: { format: 'onnx', sha256, deployable: false },
  };
  const calls = [];
  let devices = [disconnected];
  let upstreamRun = run;
  const f = await fixture(t, async (url, options) => {
    const u = new URL(url);
    calls.push([options.method, u.pathname, u.search]);
    if (u.pathname.endsWith('/runs/' + runId)) return Response.json({ ok: true, run: upstreamRun });
    if (u.pathname.endsWith('/board-station/devices')) return Response.json({ ok: true, devices });
    assert.equal(u.searchParams.get('deviceId'), connected.id);
    assert.deepEqual(JSON.parse(options.body), { runId });
    return Response.json({
      ok: true,
      runId,
      deviceId: connected.id,
      sha256,
      staged: true,
      loaded: true,
    });
  });
  const noDevice = await f.core.rehearseOriginmanDanceCpu({ runId });
  assert.equal(noDevice.run.trainingSteps, 503808);
  assert.equal(noDevice.run.artifact.sha256, sha256);
  assert.equal(noDevice.blocker, 'x5-not-connected');
  assert.equal(noDevice.stopWorkflow, true);
  assert.equal(noDevice.motionAuthorized, false);

  devices = [disconnected, connected];
  assert.equal(
    (await f.core.rehearseOriginmanDanceCpu({ runId })).blocker,
    'x5-device-id-required',
  );
  assert.equal(
    (await f.core.rehearseOriginmanDanceCpu({ runId, deviceId: disconnected.id })).blocker,
    'x5-device-unavailable',
  );
  assert.deepEqual(
    calls.map(([method]) => method),
    Array(6).fill('GET'),
  );

  upstreamRun = { ...run, id: 'other-run' };
  await assert.rejects(f.core.rehearseOriginmanDanceCpu({ runId, deviceId: connected.id }), {
    code: 'WORKSPACE_EVIDENCE_MISMATCH',
  });
  assert.equal(calls.length, 7);
  upstreamRun = run;
  const receipt = await f.core.rehearseOriginmanDanceCpu({ runId, deviceId: connected.id });
  assert.equal(receipt.phase, 'rehearsal');
  assert.equal(receipt.run.trainingSteps, 503808);
  assert.equal(receipt.sha256, sha256);
  assert.deepEqual(
    calls.map(([method]) => method),
    [...Array(9).fill('GET'), 'POST'],
  );
});

test('explicit Local Bridge connect retains only its verified session for board requests', async (t) => {
  const device = {
    id: 'bridge-target',
    provider: 'studio-local-bridge',
    bridgeDeviceId: 'ssh:operator@edge.example:22',
    host: 'edge.example',
  };
  let accountCookie = 'rdk_sso_web_session=owner-one';
  const seen = [];
  const f = await fixture(
    t,
    async (url, options) => {
      const u = new URL(url);
      seen.push({ path: u.pathname, cookie: options.headers.cookie, method: options.method });
      if (u.pathname.endsWith('/device-connections'))
        return Response.json({ ok: true, connections: [], studioDevices: [device] });
      if (u.pathname.endsWith('/local-bridge/status'))
        return Response.json({
          ok: true,
          bridges: [{ bridgeId: 'bridge-one', online: true, devices: [device] }],
        });
      if (u.pathname.endsWith('/connect')) {
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { bridgeId: 'bridge-one' });
        const headers = new Headers();
        headers.append(
          'set-cookie',
          'rdk_studio_devices=signed-device-session; Path=/; HttpOnly; Secure; SameSite=Lax',
        );
        headers.append(
          'set-cookie',
          'rdk_sso_web_session=must-not-be-retained; Path=/; Secure; HttpOnly',
        );
        return Response.json(
          { ok: true, device: { id: device.id, host: device.host } },
          { headers },
        );
      }
      return Response.json({ ok: true });
    },
    async () => accountCookie,
  );
  const result = await f.core.request('tools/call', {
    name: 'rdk_device_connect',
    arguments: { connectionId: device.id },
  });
  assert.equal(result.structuredContent.sessionBound, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /signed-device-session|owner-one|must-not-be-retained/,
  );
  await f.request('/api/v1/duck/board-station/status?deviceId=bridge-target');
  await f.request('/api/v1/duck/models');
  assert.equal(seen.at(-2).cookie, accountCookie + '; rdk_studio_devices=signed-device-session');
  assert.equal(seen.at(-1).cookie, accountCookie);
  accountCookie = 'rdk_sso_web_session=owner-two';
  await f.request('/api/v1/duck/board-station/status?deviceId=bridge-target');
  assert.equal(seen.at(-1).cookie, accountCookie);
});

test('Bridge connection rejects wrong device receipts and never installs their cookie', async (t) => {
  const device = {
    id: 'bridge-target',
    provider: 'studio-local-bridge',
    bridgeDeviceId: 'ssh:operator@edge.example:22',
    host: 'edge.example',
  };
  let calls = 0;
  const f = await fixture(t, async (url, options) => {
    const p = new URL(url).pathname;
    if (p.endsWith('/device-connections'))
      return Response.json({ ok: true, connections: [], studioDevices: [device] });
    if (p.endsWith('/local-bridge/status'))
      return Response.json({
        ok: true,
        bridges: [{ bridgeId: 'bridge-one', online: true, devices: [device] }],
      });
    if (p.endsWith('/connect')) {
      calls++;
      return Response.json(
        { ok: true, device: { id: 'another-board', host: device.host } },
        { headers: { 'set-cookie': 'rdk_studio_devices=wrong-session; Path=/; HttpOnly; Secure' } },
      );
    }
    assert.doesNotMatch(options.headers.cookie, /wrong-session/);
    return Response.json({ ok: true });
  });
  const result = await f.core.request('tools/call', {
    name: 'rdk_device_connect',
    arguments: { connectionId: device.id },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, 'STUDIO_BRIDGE_SESSION_UNCONFIRMED');
  assert.equal(calls, 1);
  await f.request('/api/v1/duck/board-station/status?deviceId=bridge-target');
});

const recordingTools = [
  'rdk_recordings_list',
  'rdk_recording_read',
  'rdk_recording_create',
  'rdk_recording_append',
];
test('unsupported recording APIs are absent from the catalog and direct calls never dispatch a write', async (t) => {
  let businessCalls = 0;
  const f = await fixture(
    t,
    async (url, init) => {
      assert.equal(new URL(url).pathname, '/robotics-learning/api/sim2real/recordings');
      assert.equal(init.method, 'GET');
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    },
    undefined,
    async (method) => {
      if (method === 'tools/list')
        return {
          tools: [...recordingTools, 'rdk_runs_list'].map((name) => ({ name })),
          nextCursor: 'opaque-next',
        };
      businessCalls++;
      throw Error('unsupported business call must not be forwarded');
    },
  );
  const list = await f.core.request('tools/list', {});
  assert.deepEqual(
    list.tools.map((tool) => tool.name),
    ['rdk_runs_list'],
  );
  assert.equal(list.nextCursor, 'opaque-next');
  const rejected = await f.core.request('tools/call', {
    name: 'rdk_recording_create',
    arguments: { name: 'no-write' },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error, 'PLATFORM_FEATURE_UNAVAILABLE');
  assert.equal(businessCalls, 0);
});
test('recording support stays available when implemented and is scoped to the current account cookie', async (t) => {
  let cookie = 'rdk_sso_web_session=account-a';
  const seen = [];
  const f = await fixture(
    t,
    async (_url, init) => {
      seen.push(init.headers.cookie);
      return init.headers.cookie.endsWith('account-a')
        ? Response.json({}, { status: 404 })
        : Response.json({ recordings: [] });
    },
    async () => cookie,
    async () => ({ tools: recordingTools.map((name) => ({ name })) }),
  );
  assert.deepEqual((await f.core.request('tools/list', {})).tools, []);
  cookie = 'rdk_sso_web_session=account-b';
  assert.deepEqual(
    (await f.core.request('tools/list', {})).tools.map((tool) => tool.name),
    recordingTools,
  );
  assert.deepEqual(seen, ['rdk_sso_web_session=account-a', 'rdk_sso_web_session=account-b']);
});
test('network and permission failures do not masquerade as unsupported recording APIs', async (t) => {
  for (const failure of ['network', 403, 503]) {
    const f = await fixture(
      t,
      async () => {
        if (failure === 'network') throw TypeError('fetch failed');
        return Response.json({ error: 'UNAVAILABLE' }, { status: failure });
      },
      undefined,
      async () => ({ tools: recordingTools.map((name) => ({ name })) }),
    );
    assert.deepEqual(
      (await f.core.request('tools/list', {})).tools.map((tool) => tool.name),
      recordingTools,
    );
    assert.equal(f.invalidations(), 0);
  }
});
