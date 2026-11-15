import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAuthenticatedCore } from '../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs';
import { experienceProxy } from '../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs';

const run = {
  id: 'run-dance',
  taskId: 'dance',
  status: 'completed',
  mock: false,
  finishedAt: '2026-11-12T00:13:00Z',
  metrics: { trainingDevice: 'cpu', successRate: 0, originmanDance: { qualityGatePassed: false } },
};
const failed = {
  id: 'deploy-failed',
  status: 'failed',
  deviceId: 'board-x5',
  mode: 'preflight',
  updatedAt: '2026-11-11T12:00:00Z',
  steps: [{ id: 'board-passport', status: 'failed', detail: 'No probe result.' }],
};
const ready = {
  id: 'deploy-ready',
  status: 'ready',
  deviceId: 'board-x5',
  updatedAt: '2026-11-12T00:00:00Z',
};
const devices = [
  {
    id: 'board-x5',
    status: 'connected',
    boardPlatform: 'rdk-x5',
    lastCheckedAt: '2026-11-12T00:12:00Z',
  },
];
const routes = {
  '/projects': { projects: [{ id: 'project-dance', name: '舞蹈练习', slug: 'dance' }] },
  '/models': { models: [{ id: 'model-dance', builtin: false }] },
  '/datasets': { datasets: [{ id: 'data-dance', version: 'v1', sourceRunId: run.id }] },
  '/workspace-summary': {
    generatedAt: '2026-11-12T00:14:00Z',
    runCountScope: 'owner-ledger',
    counts: {
      runs: 201,
      activeRuns: 1,
      projects: 1,
      models: 8,
      datasets: 1,
      registeredArtifacts: 3,
      evaluations: 2,
      deployments: 2,
      devices: 1,
      connectedDevices: 1,
      detectedDevices: 1,
    },
    latest: { run },
    deviceStatuses: devices,
  },
  '/board-station/devices': { devices, agentConfigured: true },
  '/runs/run-dance': { run },
  '/evaluations?runId=run-dance&limit=11': {
    evaluations: [
      {
        id: 'eval-dance',
        runId: run.id,
        status: 'failed',
        source: 'runner',
        attested: false,
        stale: true,
      },
    ],
  },
  '/artifacts?runId=run-dance&limit=11': {
    artifacts: [
      { id: 'artifact-dance', runId: run.id, status: 'candidate', sha256: 'a'.repeat(64) },
    ],
  },
  '/compute-resources': {
    computeResources: [
      {
        id: 'gpu-fresh',
        name: 'GPU',
        status: 'online',
        cuda: true,
        lastCheckedAt: '2026-11-12T00:12:00Z',
        gpuName: 'RTX 4090',
        maxConcurrentJobs: 2,
        engines: ['originman-dance-ppo'],
        runnerUrl: 'http://127.0.0.1:1111/train',
      },
      {
        id: 'gpu-timeout',
        status: 'offline',
        message: 'Worker probe timed out.',
        lastCheckedAt: '2026-11-12T00:11:00Z',
      },
    ],
  },
  '/deployments': { deployments: [failed, ready] },
  '/deployments/deploy-failed': { deployment: failed },
  '/deployments/deploy-failed/history': {
    deploymentId: failed.id,
    history: [{ id: 'event-1', status: 'failed', summary: 'No probe result.' }],
    verification: { passed: false, mock: false },
  },
  '/board-station/health?deviceId=board-x5': [
    503,
    { ok: false, error: 'SIM2REAL_BOARD_AGENT_OFFLINE' },
  ],
};

async function fixture(t, overrides = {}) {
  const calls = [];
  const auth = {
    audience: 'https://fixture.example',
    status: async () => ({ authenticated: true, accountId: 'fixture-owner' }),
    cookie: async ({ accountId }) => {
      assert.equal(accountId, 'fixture-owner');
      return 'session=fixture';
    },
  };
  const upstream = await connectAuthenticatedCore({
    authentication: auth,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.cookie, 'session=fixture');
      assert.equal(options.redirect, 'error');
      const route = url.replace('https://fixture.example/api/v1/duck', '');
      calls.push(route);
      const response = { ...routes, ...overrides }[route];
      if (Array.isArray(response)) return Response.json(response[1], { status: response[0] });
      return Response.json(
        response ? { ok: true, ...response } : { ok: false, error: 'NOT_FOUND' },
        {
          status: response ? 200 : 404,
        },
      );
    },
    connect: () => ({
      request: async (method) => (method === 'tools/list' ? { tools: [] } : {}),
      close: async () => {},
    }),
  });
  t.after(() => upstream.close());
  const dispatch = experienceProxy(upstream, { authentication: auth });
  const inspect = async (args) =>
    (
      await dispatch('tools/call', {
        name: 'rdk_workspace_inspect',
        arguments: args,
      })
    ).structuredContent;
  return { inspect, calls, dispatch };
}

test('账号全貌、旧活跃 Run、训练产出和最近失败部署可在一次只读查询中追查', async (t) => {
  const { inspect, calls, dispatch } = await fixture(t);
  const catalog = await dispatch('tools/list', {});
  assert.equal(
    catalog.tools.find((tool) => tool.name === 'rdk_workspace_inspect').annotations.readOnlyHint,
    true,
  );
  const evidence = await inspect({});
  assert.equal(evidence.summary.runCountScope, 'owner-ledger');
  assert.equal(evidence.summary.counts.runs, 201);
  assert.equal(evidence.summary.counts.activeRuns, 1);
  assert.equal(evidence.summary.counts.registeredArtifacts, 3);
  assert.equal(evidence.projects.items[0].id, 'project-dance');
  assert.equal(evidence.models.items[0].builtin, false);
  assert.equal(evidence.datasets.items[0].sourceRunId, run.id);
  assert.equal(evidence.training.artifacts.items[0].status, 'candidate');
  assert.equal(evidence.training.evaluations.items[0].status, 'failed');
  assert.equal(evidence.training.evaluations.items[0].stale, true);
  assert.equal(evidence.training.run.metrics.originmanDance.qualityGatePassed, false);
  assert.equal(evidence.deployments.latest.id, 'deploy-ready');
  assert.equal(evidence.deployments.history.deploymentId, 'deploy-failed');
  assert.equal(evidence.devices.items[0].boardPlatform, 'rdk-x5');
  assert.equal(evidence.summary.counts.connectedDevices, evidence.summary.counts.detectedDevices);
  assert.equal(calls.filter((route) => route === '/workspace-summary').length, 1);
  assert.ok(!calls.includes('/overview'));
  assert.ok(!calls.some((route) => route.startsWith('/board-station/health')));
});

const scenarios = [
  [
    '只有一台 GPU，能跑舞蹈吗',
    { scope: 'compute' },
    (v) => {
      assert.deepEqual(v.compute.items[0].engines, ['originman-dance-ppo']);
      assert.equal(v.compute.items[0].maxConcurrentJobs, 2);
      assert.equal(v.compute.items[0].lastCheckedAt, '2026-11-12T00:12:00Z');
      assert.ok(!Object.hasOwn(v.compute.items[0], 'runnerUrl'));
      assert.equal(v.compute.items[1].message, 'Worker probe timed out.');
    },
  ],
  [
    '按原 Run 查时间、执行设备、零分和质量门',
    { scope: 'training', runId: run.id },
    (v) => {
      assert.equal(v.training.run.finishedAt, run.finishedAt);
      assert.equal(v.training.run.metrics.trainingDevice, 'cpu');
      assert.equal(v.training.run.metrics.successRate, 0);
      assert.equal(v.training.run.metrics.originmanDance.qualityGatePassed, false);
      assert.equal(v.summary, undefined);
    },
  ],
  [
    '已连接的 X5 上 BoardAgent 是否可达',
    { scope: 'devices', deviceId: 'board-x5' },
    (v) => {
      assert.equal(v.devices.status, 'unavailable');
      assert.equal(v.devices.error.code, 'SIM2REAL_BOARD_AGENT_OFFLINE');
      assert.equal(v.devices.error.httpStatus, 503);
    },
  ],
  [
    '为什么这条部署失败',
    { scope: 'deployments', deploymentId: failed.id },
    (v) => {
      assert.equal(v.deployments.latestFailure.blockingSteps[0].id, 'board-passport');
      assert.equal(v.deployments.history.verification.passed, false);
    },
  ],
  [
    '截断 ID 和路径不可代替原 ID',
    { scope: 'training', runId: '../other' },
    (v) => {
      assert.equal(v.error.platformCode, 'WORKSPACE_INVALID_ARGUMENTS');
    },
  ],
  [
    'ID 必须与所查询对象一致',
    { scope: 'compute', runId: run.id },
    (v) => {
      assert.equal(v.error.platformCode, 'WORKSPACE_INVALID_ARGUMENTS');
    },
  ],
];
for (const [question, args, check] of scenarios)
  test(question, async (t) => check(await (await fixture(t)).inspect(args)));

test('旧平台返回 200 条时标为窗口统计，老设备记录可查询', async (t) => {
  const { inspect, calls } = await fixture(t, {
    '/workspace-summary': {
      counts: { runs: 200, activeRuns: 0 },
      latest: { run },
      generatedAt: '2026-11-12T00:14:00Z',
    },
  });
  const evidence = await inspect({});
  assert.equal(evidence.summary.runCountScope, 'recent-window');
  assert.equal(evidence.summary.deviceCountScope, 'legacy-summary');
  assert.equal(evidence.summary.counts.registeredArtifacts, null);
  assert.equal(evidence.summary.counts.evaluations, null);
  assert.equal(evidence.devices.items[0].id, 'board-x5');
  assert.ok(calls.includes('/board-station/devices'));
  assert.ok(!calls.includes('/overview'));
});

test('部分失败保留原错误，已确认无 Run、无部署和无评测分别可辨', async (t) => {
  const { inspect } = await fixture(t, {
    '/workspace-summary': {
      counts: { runs: 0, activeRuns: 0 },
      latest: { run: null },
      deviceStatuses: [],
    },
    '/compute-resources': [403, { ok: false, error: 'PERMISSION_DENIED' }],
    '/deployments': { deployments: [] },
    '/evaluations?runId=run-dance&limit=11': { evaluations: [] },
    '/artifacts?runId=run-dance&limit=11': [503, { ok: false, error: 'EVIDENCE_UNAVAILABLE' }],
  });
  const all = await inspect({});
  assert.equal(all.training.run, null);
  assert.equal(all.compute.error.code, 'PERMISSION_DENIED');
  assert.equal(all.deployments.returned, 0);
  const specific = await inspect({ scope: 'training', runId: run.id });
  assert.equal(specific.training.evaluations.returned, 0);
  assert.equal(specific.training.artifacts.error.code, 'EVIDENCE_UNAVAILABLE');
});

test('部署和训练列表截取时保留边界', async (t) => {
  const deployments = Array.from({ length: 13 }, (_, n) => ({ ...ready, id: 'deployment-' + n }));
  const artifacts = Array.from({ length: 11 }, (_, n) => ({ id: 'artifact-' + n, runId: run.id }));
  const { inspect } = await fixture(t, {
    '/deployments': { deployments },
    '/artifacts?runId=run-dance&limit=11': { artifacts },
  });
  const evidence = await inspect({});
  for (const section of [evidence.deployments, evidence.training.artifacts]) {
    assert.equal(section.returned, 10);
    assert.equal(section.limited, true);
  }
});

test('指定 Run 不存在时不会查询或归入其他 Run 的证据', async (t) => {
  const { inspect, calls } = await fixture(t);
  const evidence = await inspect({ scope: 'training', runId: 'run-missing' });
  assert.equal(evidence.training.status, 'unavailable');
  assert.equal(evidence.training.error.httpStatus, 404);
  assert.deepEqual(calls, ['/runs/run-missing']);
});

test('平台回错 Run 的评测时，保留训练状态并拒绝交叉归因', async (t) => {
  const { inspect } = await fixture(t, {
    '/evaluations?runId=run-dance&limit=11': {
      evaluations: [{ id: 'eval-other', runId: 'other' }],
    },
  });
  const evidence = await inspect({ scope: 'training', runId: run.id });
  assert.equal(evidence.training.run.id, run.id);
  assert.equal(evidence.training.evaluations.error.code, 'WORKSPACE_EVIDENCE_MISMATCH');
});

test('最近被门禁阻断的部署和最近执行失败的部署分别保留', async (t) => {
  const blocked = { ...ready, id: 'deploy-blocked', status: 'blocked' };
  const { inspect } = await fixture(t, { '/deployments': { deployments: [failed, blocked] } });
  const { deployments } = await inspect({ scope: 'deployments' });
  assert.equal(deployments.latest.id, blocked.id);
  assert.equal(deployments.latestBlocked.id, blocked.id);
  assert.equal(deployments.latestFailure.id, failed.id);
  assert.equal(deployments.history.deploymentId, failed.id);
});

test('设备专项查询只读取设备接口，即使工作区汇总不可用', async (t) => {
  const { inspect, calls } = await fixture(t, {
    '/workspace-summary': [503, { ok: false }],
    '/overview': [502, { ok: false }],
  });
  const evidence = await inspect({ scope: 'devices' });
  assert.equal(evidence.devices.status, 'read');
  assert.equal(evidence.devices.items[0].id, 'board-x5');
  assert.deepEqual(calls, ['/board-station/devices']);
});

test('托管数据集链接基于同账号记录，外部、撤销及损坏的记录不提供下载', async (t) => {
  const sha256 = 'a'.repeat(64);
  const uri = 'dataset-hosted://' + sha256 + '/%E7%BB%83%E4%B9%A0.csv';
  const valid = { id: 'hosted', name: '练习', status: 'registered', uri, sha256, sizeBytes: 20 };
  const records = [
    valid,
    { ...valid, id: 'external', uri: 'https://other.example/video?token=private-token' },
    { ...valid, id: 'revoked', status: 'revoked' },
    { ...valid, id: 'wrong-digest', sha256: 'b'.repeat(64) },
    { ...valid, id: 'bad-name', uri: 'dataset-hosted://' + sha256 + '/a%2fb' },
  ];
  const { inspect, dispatch } = await fixture(t, { '/datasets': { datasets: records } });
  const exact = await inspect({ scope: 'datasets', datasetId: 'hosted' });
  assert.equal(exact.datasets.returned, 1);
  assert.match(exact.studentReply, /平台托管/);
  const result = (
    await dispatch('tools/call', {
      name: 'rdk_datasets_list',
      arguments: {},
    })
  ).structuredContent;
  assert.equal(
    result.datasets[0].links.download,
    'https://fixture.example/api/v1/duck/datasets/hosted/file',
  );
  assert.equal(result.datasets[1].storage, 'external');
  assert.equal(result.datasets[2].storage, 'hosted');
  assert.equal(result.datasets[3].storage, 'unverified');
  assert.equal(result.datasets[4].storage, 'unverified');
  assert.ok(result.datasets.slice(1).every((item) => !item.links));
  assert.doesNotMatch(JSON.stringify(result), /private-token|dataset-hosted:/);
});

test('完成训练才核对同一 Run 的部署资格、回放及 ONNX 下载', async () => {
  const runId = 'originman-run';
  const sha256 = 'a'.repeat(64);
  let deployable = false;
  let matchingChecksum = true;
  const dispatch = experienceProxy(
    {
      request: async () => ({ structuredContent: { runId, status: 'completed' } }),
      readTrainingRun: async (id) => ({
        id,
        status: 'completed',
        mock: false,
        artifact: { format: 'onnx', sha256, deployable },
      }),
      verifyPolicyDownload: async (id, digest) => {
        assert.equal(id, runId);
        assert.equal(digest, sha256);
        return matchingChecksum;
      },
      readTelemetrySummary: async () => ({ runId, frameCount: 7 }),
    },
    { env: { RDK_SIM2REAL_MCP_BASE_URL: 'https://fixture.example/learning' } },
  );
  const call = () => dispatch('tools/call', { name: 'rdk_training_status', arguments: { runId } });
  const first = (await call()).structuredContent;
  assert.deepEqual(first.runDelivery, {
    deployment: 'ineligible',
    replay: 'telemetry',
    policy: 'available',
  });
  assert.equal(
    first.links.policyDownload,
    'https://fixture.example/learning/api/v1/duck/runs/originman-run/artifact',
  );
  assert.match(first.studentReply, /不可部署到真机/);
  assert.match(first.studentReply, /查看本轮遥测回放数据/);
  deployable = true;
  matchingChecksum = false;
  const second = (await call()).structuredContent;
  assert.equal(second.runDelivery.deployment, 'eligible');
  assert.equal(second.runDelivery.policy, 'unavailable');
  assert.equal(second.links.policyDownload, undefined);
  assert.match(second.studentReply, /仍需通过目标设备预检/);
});

test('learning guide validates and dispatches the public productId and task values before any platform call', async () => {
  const proxy = experienceProxy(
    {
      request: () => {
        throw Error('Unexpected platform call');
      },
    },
    { env: { RDK_SIM2REAL_MCP_BASE_URL: 'https://fixture.example/learning' } },
  );
  const call = (arguments_) =>
    proxy('tools/call', { name: 'rdk_learning_guide', arguments: arguments_ });
  const outcome = await call({ productId: 'originman', task: 'simulation' });
  assert.match(outcome.structuredContent.links.workbench, /robot=originman/);
  const invalid = await call({ taskId: 'walk' });
  assert.equal(invalid.structuredContent.error.platformCode, 'INVALID_LEARNING_GUIDE_ARGUMENT');
  assert.equal(invalid.structuredContent.error.category, 'invalid-arguments');
  assert.match(invalid.structuredContent.recovery, /simulation.+reinforcement.+dance/);
  const conflict = await call({ productId: 'originman', robot: 'OriginBot' });
  assert.match(conflict.structuredContent.error.message, /不同机型/);
  const typo = await call({ productId: 'origin-man', task: 'simulation' });
  assert.match(typo.structuredContent.recovery, /originman/);
});

test('retained core does not drop compute diagnostics or confuse artifact counts across platform versions', async (t) => {
  let legacy = false;
  let replyStatus = 200;
  const calls = [];
  const auth = {
    audience: 'https://fixture.example',
    status: async () => ({ authenticated: true, accountId: 'owner-a' }),
    cookie: async () => 'session=fixture',
    invalidate: async () => {},
  };
  const upstream = await connectAuthenticatedCore({
    authentication: auth,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method });
      assert.equal(options.headers.cookie, 'session=fixture');
      if (path.endsWith('/artifacts')) {
        const artifacts = Array.from({ length: 10 }, (_, i) => ({ id: String(i), type: 'model' }));
        return Response.json(
          legacy
            ? { ok: true, total: 10, available: 12, artifacts }
            : { ok: true, total: 12, available: 11, returned: 10, artifacts },
        );
      }
      if (path.endsWith('/test')) {
        assert.equal(options.method, 'POST');
        if (replyStatus !== 200)
          return Response.json({ error: 'AUTH_REQUIRED' }, { status: replyStatus });
        return Response.json({
          ok: true,
          connected: false,
          computeResource: { id: 'gpu-a', status: 'offline' },
          diagnostic: {
            code: 'WORKER_HTTP_ERROR',
            httpStatus: 404,
            endpoint: {
              host: 'worker.example.com',
              port: 443,
              path: '/rl/healthz',
              resolvedAddresses: [],
            },
            recovery: '检查 /rl/healthz。',
          },
        });
      }
      assert.equal(path, '/api/v1/duck/compute-resources');
      assert.equal(options.headers['idempotency-key'], 'same-resource');
      return Response.json(
        {
          error: 'SIM2REAL_INVALID_COMPUTE_RESOURCE_URL',
          message: '公网 Worker 必须使用 HTTPS。',
          nextAction: '请改用 HTTPS 后重试。',
        },
        { status: 400 },
      );
    },
    connect: () => ({
      close: async () => {},
      request: async (_method, params) => {
        if (params.name === 'rdk_platform_status')
          return {
            structuredContent: {
              health: { ready: true },
              session: { authenticated: false },
              connection: { state: 'authentication-required', recovery: '核对当前账号的认证配置' },
            },
          };
        throw Error('Unexpected retained tool call');
      },
    }),
  });
  t.after(() => upstream.close());
  const proxy = experienceProxy(upstream, { authentication: auth });
  const call = (name, arguments_) => proxy('tools/call', { name, arguments: arguments_ });
  assert.deepEqual((await call('rdk_artifacts_list', { limit: 10 })).structuredContent, {
    total: 12,
    available: 11,
    returned: 10,
    artifacts: Array.from({ length: 10 }, (_, i) => ({ id: String(i), type: 'model' })),
  });
  legacy = true;
  const filtered = (await call('rdk_artifacts_list', { runId: 'sample', limit: 10 }))
    .structuredContent;
  assert.equal(filtered.total, 12);
  assert.equal(filtered.returned, 10);
  assert.equal(filtered.available, null);
  const health = (await call('rdk_compute_resource_test', { computeResourceId: 'gpu-a' }))
    .structuredContent;
  assert.equal(health.connected, false);
  assert.equal(health.diagnostic.code, 'WORKER_HTTP_ERROR');
  assert.match(health.recovery, /healthz/);
  const invalid = await call('rdk_compute_resource_register', {
    name: 'external',
    runnerUrl: 'http://worker.example.com/train',
    idempotencyKey: 'same-resource',
  });
  assert.equal(
    invalid.structuredContent.error.platformCode,
    'SIM2REAL_INVALID_COMPUTE_RESOURCE_URL',
  );
  assert.equal(invalid.structuredContent.error.httpStatus, 400);
  assert.match(invalid.structuredContent.recovery, /HTTPS/);
  replyStatus = 401;
  const missing = await call('rdk_compute_resource_test', { computeResourceId: 'gpu-a' });
  assert.equal(missing.structuredContent.error.category, 'authentication');
  assert.match(missing.structuredContent.recovery, /rdk_auth_login/);
  const status = await call('rdk_platform_status');
  assert.match(status.structuredContent.connection.recovery, /rdk_auth_login/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 3);
});

test('legacy connector errors distinguish input from an unavailable platform capability', async () => {
  const proxy = experienceProxy({
    request: async (_method, { name }) => {
      const prefix =
        name === 'rdk_models_list' ? 'DSH_CAPABILITY_FAILED' : 'DSH_CAPABILITY_REJECTED';
      return { isError: true, content: [{ type: 'text', text: '[' + prefix + '] 失败' }] };
    },
  });
  const call = (name) => proxy('tools/call', { name, arguments: {} });
  assert.equal(
    (await call('rdk_models_list')).structuredContent.error.category,
    'platform-configuration',
  );
  assert.equal(
    (await call('rdk_models_register')).structuredContent.error.category,
    'invalid-arguments',
  );
  assert.match((await call('rdk_models_register')).structuredContent.recovery, /参数/);
});
