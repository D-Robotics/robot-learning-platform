import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateProfile,
  prepareExperience,
  connectMcp,
  readToolResult,
} from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';

test('OriginMan one-step acceptance follows the same Run, verifies one evaluation, and opens its result', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const sha = 'a'.repeat(64);
  const scene = 'b'.repeat(64);
  const checks = [{ type: 'alternating-arms', clean: true, passed: false }];
  const run = {
    id: 'dance-test',
    status: 'running',
    taskId: 'originman-dance',
    mock: false,
    contractId: 'custom-policy-originman-dance-v2',
    artifact: { format: 'onnx', sha256: sha, deployable: false },
    training: {
      engine: 'originman-dance-ppo',
      originmanDance: { bpm: 100, sections: [{ type: 'alternating-arms' }] },
    },
    metrics: {
      originmanDance: {
        qualityGatePassed: false,
        sceneProvenance: { sceneSha256: scene },
        evaluations: [{ bpm: 100, sections: structuredClone(checks) }],
      },
    },
  };
  let evaluationCount = 0;
  let resultScene = scene;
  const proxy = experienceProxy(
    {
      async request(method, { name, arguments: args }) {
        assert.equal(method, 'tools/call');
        assert.equal(name, 'rdk_training_status');
        assert.equal(args.runId, run.id);
        return { structuredContent: { runId: run.id, status: run.status, taskId: run.taskId } };
      },
      readTrainingRun: async (id) => {
        assert.equal(id, run.id);
        return run;
      },
      verifyPolicyDownload: async () => true,
      evaluateDanceRun: async (id) => {
        assert.equal(id, run.id);
        evaluationCount++;
        return {
          source: {
            runId: run.id,
            policySha256: sha,
            sceneSha256: resultScene,
            contractId: run.contractId,
          },
          qualityGatePassed: false,
          evaluations: [{ bpm: 100, sections: checks }],
        };
      },
    },
    { env: { RDK_SIM2REAL_MCP_BASE_URL: 'https://platform.test/learning' }, waitBudgetMs: 1 },
  );
  const call = async (name, args = { runId: run.id }) =>
    (await proxy('tools/call', { name, arguments: args })).structuredContent;
  const accept = 'rdk_originman_dance_acceptance';
  const waiting = await call(accept);
  assert.equal(waiting.nextTool, accept);
  assert.equal(waiting.simulationAcceptance.state, 'waiting');
  assert.equal(evaluationCount, 0);
  run.status = 'completed';
  await call('rdk_training_wait');
  assert.equal(evaluationCount, 0);
  const final = await call(accept, waiting.nextArguments);
  assert.equal(final.simulationAcceptance.state, 'failed');
  assert.deepEqual(final.simulationAcceptance.sections, checks);
  assert.match(final.studentReply, /未达标/);
  assert.equal(new URL(final.studioNavigation.arguments.url).searchParams.get('runId'), run.id);
  assert.match(final.links.policyDownload, /dance-test\/artifact$/);
  assert.equal(evaluationCount, 1);
  resultScene = 'c'.repeat(64);
  const stale = await call(accept);
  assert.equal(stale.simulationAcceptance.state, 'unverified');
  assert.equal(stale.studioNavigation, undefined);
  resultScene = scene;
  checks[0].passed = true;
  const inconsistent = await call(accept);
  assert.equal(inconsistent.simulationAcceptance.state, 'unverified');
  assert.equal(inconsistent.studioNavigation, undefined);
  run.status = 'failed';
  assert.equal((await call(accept)).simulationAcceptance.state, 'not-evaluated');
  assert.equal(evaluationCount, 3);
});

test('MCP business failures retain flat, nested and textual diagnostics', () => {
  for (const [result, message, code, status] of [
    [
      {
        structuredContent: {
          ok: false,
          message: 'Worker unreachable',
          platformCode: 'WORKER_OFFLINE',
          httpStatus: 503,
        },
      },
      'Worker unreachable',
      'WORKER_OFFLINE',
      503,
    ],
    [
      {
        isError: true,
        structuredContent: {
          error: { message: 'Not authorized', platformCode: 'DENIED', httpStatus: 403 },
        },
      },
      'Not authorized',
      'DENIED',
      403,
    ],
    [
      { isError: true, content: [{ type: 'text', text: 'Connection failed' }] },
      'Connection failed',
      undefined,
      undefined,
    ],
    [
      { structuredContent: { ok: false, error: 'Invalid resource' } },
      'Invalid resource',
      undefined,
      undefined,
    ],
  ]) {
    assert.throws(
      () => readToolResult(result),
      (error) => {
        assert.equal(error.message, message);
        assert.equal(error.platformCode, code);
        assert.equal(error.httpStatus, status);
        return true;
      },
    );
  }
  assert.deepEqual(readToolResult({ structuredContent: { ok: true, value: 0 } }), {
    ok: true,
    value: 0,
  });
});

const profile = { schemaVersion: 1, id: 'demo', policy: { source: 'reference' } };
const tools = ['rdk_platform_status', 'rdk_simulator_open', 'rdk_training_status'];
const ready = {
  ok: true,
  authMode: 'cookie',
  health: { ready: true, degraded: [] },
  session: { authenticated: true },
};

test('OriginMan never accepts a MicroDuck entry or legacy fallback', async () => {
  const origin = { ...profile, robot: 'originman' };
  for (const wrong of [
    { entryUrl: '/mujoco/microduck/' },
    { robot: 'microduck', entryUrl: '/mujoco/microduck/' },
  ]) {
    const calls = [];
    const result = await prepareExperience(
      origin,
      async (name, args) => {
        calls.push([name, args]);
        return name === 'rdk_platform_status' ? ready : wrong;
      },
      { tools, baseUrl: 'https://platform.test/robotics-learning/' },
    );
    assert.equal(result.status, 'blocked');
    assert.deepEqual(calls[1], ['rdk_simulator_open', { robot: 'originman' }]);
  }
  const missing = await prepareExperience(
    origin,
    async (name) => {
      if (name === 'rdk_platform_status') return ready;
      assert.equal(name, 'rdk_simulator_open');
      throw Object.assign(new Error('old server'), {
        platformCode: 'SIM2REAL_API_NOT_FOUND',
        httpStatus: 404,
      });
    },
    { tools: [...tools, 'rdk_workspace_overview'], baseUrl: 'https://platform.test/' },
  );
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.entryUrl, undefined);
  assert.ok(missing.checks.some((check) => check.id === 'robot' && check.status === 'blocked'));
});

test('OriginMan preparation preserves product and reverse proxy mount', async () => {
  const result = await prepareExperience(
    { ...profile, robot: 'originman' },
    async (name) =>
      name === 'rdk_platform_status'
        ? ready
        : { robot: 'originman', entryUrl: './?robot=originman#train/submit' },
    { tools, baseUrl: 'https://platform.test/robotics-learning/' },
  );
  assert.equal(result.status, 'prepared');
  assert.equal(
    result.entryUrl,
    'https://platform.test/robotics-learning/?robot=originman#train/submit',
  );
  assert.ok(Object.values(result.execution).every((value) => value === false));
});

test('missing MicroDuck assets do not block OriginMan, while other degradation still does', async () => {
  for (const [degraded, expected] of [
    [['microduck-not-mounted'], 'prepared'],
    [['microduck-not-mounted', 'worker-offline'], 'blocked'],
  ]) {
    const result = await prepareExperience(
      { ...profile, robot: 'originman' },
      async (name) =>
        name === 'rdk_platform_status'
          ? { ...ready, health: { ready: true, degraded } }
          : { robot: 'originman', entryUrl: './?robot=originman#train/submit' },
      { tools, baseUrl: 'https://platform.test/' },
    );
    assert.equal(result.status, expected);
  }
});
function context(overrides = {}) {
  const calls = [];
  return {
    calls,
    call: async (name, args) => {
      calls.push([name, args]);
      return (
        overrides[name] ??
        (name === 'rdk_platform_status' ? ready : { entryUrl: '/mujoco/microduck/' })
      );
    },
  };
}
const options = { baseUrl: 'https://studio.example/learning', tools };

test('experience CLI actually runs when launched through a symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-experience-entry-'));
  try {
    const aliasDirectory = path.join(dir, 'scripts-alias');
    fs.symlinkSync(
      fileURLToPath(new URL('../plugins/rdk-robot-learning-platform/scripts', import.meta.url)),
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const alias = path.join(aliasDirectory, 'experience.mjs');
    const config = path.join(dir, 'profile.json');
    fs.writeFileSync(config, JSON.stringify(profile));
    const r = spawnSync(process.execPath, [alias, 'validate', config], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'valid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reference preparation preserves mount and never claims browser or motion success', async () => {
  const { call, calls } = context();
  const result = await prepareExperience(profile, call, options);
  assert.equal(result.status, 'prepared');
  assert.equal(result.entryUrl, 'https://studio.example/learning/mujoco/microduck/');
  assert.ok(Object.values(result.execution).every((x) => x === false));
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['rdk_platform_status', 'rdk_simulator_open'],
  );
});
test('already mounted paths and full URLs preserve mount exactly once', async () => {
  for (const entryUrl of ['/learning/mujoco/', 'https://studio.example/learning/mujoco/']) {
    const { call } = context({ rdk_simulator_open: { entryUrl } });
    assert.equal(
      (await prepareExperience(profile, call, options)).entryUrl,
      'https://studio.example/learning/mujoco/',
    );
  }
});
test('foreign origins, credentials, traversal and empty entries are rejected', async () => {
  for (const entryUrl of [
    'https://evil.example/',
    '//evil.example/',
    '../private',
    'https://user:pass@studio.example/learning/',
    '',
  ]) {
    const { call } = context({ rdk_simulator_open: { entryUrl } });
    await assert.rejects(prepareExperience(profile, call, options));
  }
});
test('missing tools, degraded platform and unauthenticated session stop before simulator query', async () => {
  for (const status of [
    { ...ready, ok: false },
    { ...ready, health: { ready: true, degraded: ['worker'] } },
    { ...ready, session: { authenticated: false } },
  ]) {
    const { call, calls } = context({ rdk_platform_status: status });
    assert.equal((await prepareExperience(profile, call, options)).status, 'blocked');
    assert.equal(calls.length, 1);
  }
  const { call, calls } = context();
  assert.equal(
    (await prepareExperience(profile, call, { ...options, tools: [] })).status,
    'blocked',
  );
  assert.equal(calls.length, 0);
});
test('unconfigured or incomplete trained policies cannot use latest or completed as quality proof', async () => {
  assert.throws(() =>
    validateProfile({ ...profile, policy: { source: 'trained', runId: 'latest' } }),
  );
  const trained = {
    ...profile,
    policy: { source: 'trained', runId: 'fixed-run', sha256: 'a'.repeat(64) },
  };
  for (const run of [
    { runId: 'fixed-run', status: 'failed' },
    { runId: 'other', status: 'completed' },
  ]) {
    const { call, calls } = context({ rdk_training_status: run });
    assert.equal((await prepareExperience(trained, call, options)).status, 'blocked');
    assert.ok(!calls.some((x) => x[0] === 'rdk_simulator_open'));
  }
  const { call } = context({ rdk_training_status: { runId: 'fixed-run', status: 'completed' } });
  const result = await prepareExperience(trained, call, options);
  assert.equal(result.status, 'needs-verification');
  assert.equal(result.execution.policyLoaded, false);
});
test('recovery never writes, erases records or starts training; backend rejection is retained', async () => {
  const { call, calls } = context();
  const result = await prepareExperience(profile, call, { ...options, action: 'recover' });
  assert.equal(result.execution.resetCompleted, false);
  assert.ok(calls.every((x) => ['rdk_platform_status', 'rdk_simulator_open'].includes(x[0])));
  await assert.rejects(
    prepareExperience(
      profile,
      async () => {
        throw new Error('HTTP 403 permission denied');
      },
      options,
    ),
    /403/,
  );
});
test('real stdio roundtrip, timeout cancellation and owned child shutdown', async () => {
  const source = `const readline=require('node:readline'); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.method==='hang'||!('id' in m))return; console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[]}}));});`;
  const client = connectMcp({ args: ['-e', source], timeoutMs: 200 });
  try {
    assert.deepEqual(await client.request('tools/list'), { tools: [] });
    await assert.rejects(client.request('hang'), /timed out/);
    assert.deepEqual(await client.request('tools/list'), { tools: [] });
  } finally {
    await client.close();
  }
});

test('missing MCP executable fails and closes without hanging', async () => {
  const client = connectMcp({
    command: '/nonexistent-rdk-experience-node',
    args: [],
    timeoutMs: 200,
  });
  try {
    await assert.rejects(client.request('tools/list'), /ENOENT/);
  } finally {
    await client.close();
  }
});

test('only a reference API-not-found may use the same workspace simulator entry', async () => {
  const { readToolResult } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience.mjs');
  for (const code of ['SIM2REAL_API_NOT_FOUND', 'FORBIDDEN']) {
    const call = async (name) => {
      if (name === 'rdk_platform_status') return ready;
      if (name === 'rdk_simulator_open')
        return readToolResult({
          isError: true,
          structuredContent: {
            error: { platformCode: code, httpStatus: 404, message: 'API missing' },
          },
        });
      assert.equal(name, 'rdk_workspace_overview');
      return { integrations: { simulator: { available: true, entryUrl: '/mujoco/microduck/' } } };
    };
    const opts = { ...options, tools: [...tools, 'rdk_workspace_overview'] };
    if (code === 'FORBIDDEN') await assert.rejects(prepareExperience(profile, call, opts));
    else {
      const result = await prepareExperience(profile, call, opts);
      assert.equal(result.status, 'prepared');
      assert.ok(result.checks.some((c) => c.status === 'compatibility'));
    }
  }
});

test('experience MCP preserves upstream tools, results and errors and exposes guide without host skills', async () => {
  const { experienceProxy, EXPERIENCE_TOOLS } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const original = { name: 'existing_write_tool', annotations: { readOnlyHint: false } };
  const proxy = experienceProxy({
    request: async (method, params) => {
      if (method === 'initialize')
        return { instructions: 'original', serverInfo: { name: 'original' } };
      if (method === 'tools/list') return { tools: [original] };
      return {
        isError: true,
        content: [{ type: 'text', text: 'original rejection' }],
        arguments: params.arguments,
      };
    },
  });
  const init = await proxy('initialize');
  assert.equal(init.serverInfo.name, 'original');
  assert.ok(init.instructions.startsWith('original'));
  assert.match(init.instructions, /每轮按需登记/);
  assert.match(init.instructions, /mcp__rdk-robot-learning-platform__rdk_training_wait/);
  assert.match(init.instructions, /artifactRetention、links.policyDownload/);
  assert.match(init.instructions, /当前进度→本次结果→下一步/);
  assert.match(init.instructions, /仍可只读查询原Run/);
  assert.doesNotMatch(
    init.instructions,
    /先rdk_auth_status显示实际版本|默认先一次流程检查并展示状态表/,
  );
  const list = await proxy('tools/list');
  assert.deepEqual(list.tools[0], original);
  assert.equal(list.tools.length, 1 + EXPERIENCE_TOOLS.length);
  assert.ok(list.tools.some((t) => t.name === 'rdk_originman_evaluation_read'));
  assert.ok(list.tools.some((t) => t.name === 'rdk_training_wait'));
  const guide = await proxy('tools/call', { name: 'rdk_experience_guide' });
  assert.match(guide.structuredContent.guide, /场景准备/);
  assert.equal(guide.structuredContent.learnerInterface.entryPrompt, '带我开始 Workshop');
  assert.equal(guide.structuredContent.learnerInterface.inlineAppAvailable, false);
  assert.equal(guide.structuredContent.learnerInterface.diagnostics, 'on-demand');
  const passthrough = await proxy('tools/call', {
    name: 'existing_write_tool',
    arguments: { x: 1 },
  });
  assert.equal(passthrough.isError, true);
  assert.deepEqual(passthrough.arguments, { x: 1 });
});

test('the packaged tool can open the standalone MicroDuck reference without the learning-guide endpoint', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const missing = {
    isError: true,
    structuredContent: { error: { platformCode: 'SIM2REAL_API_NOT_FOUND', httpStatus: 404 } },
  };
  const calls = [];
  const proxy = experienceProxy({
    request: async (_method, { name }) => {
      calls.push(name);
      return name === 'rdk_simulator_open'
        ? missing
        : {
            structuredContent: {
              integrations: {
                simulator: { browser: { available: true, entryUrl: '/mujoco/microduck/' } },
              },
            },
          };
    },
  });
  const open = (args) => proxy('tools/call', { name: 'rdk_simulator_open', arguments: args });
  assert.deepEqual((await open({ robot: 'microduck' })).structuredContent, {
    robot: 'microduck',
    available: true,
    entryUrl: '/mujoco/microduck/',
  });
  assert.equal(
    (await open({ robot: 'originman' })).structuredContent.error.platformCode,
    'SIM2REAL_API_NOT_FOUND',
  );
  assert.equal(
    (await open({ runId: 'run-42' })).structuredContent.error.platformCode,
    'SIM2REAL_API_NOT_FOUND',
  );
  assert.deepEqual(calls, [
    'rdk_simulator_open',
    'rdk_workspace_overview',
    'rdk_simulator_open',
    'rdk_simulator_open',
  ]);
});

test('MCP cancellation reaches upstream and leaves subsequent reads usable', async () => {
  const source = `const r=require('node:readline');let cancelled=false;r.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='notifications/cancelled'){cancelled=true;return;}if(m.method==='hang')return;console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{cancelled}}));});`;
  const client = connectMcp({ args: ['-e', source], timeoutMs: 2000 });
  try {
    const control = new AbortController();
    const pending = client.request('hang', {}, { signal: control.signal });
    control.abort();
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(await client.request('read'), { cancelled: true });
  } finally {
    await client.close();
  }
});

test('offline diagnostics separate reported host, loaded runtime and unqueried platform layers', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const calls = [];
  const proxy = experienceProxy({
    request: async (method) => {
      calls.push(method);
      return {};
    },
  });
  await proxy('initialize', { clientInfo: { name: 'Qoder Desktop', version: '0.5.3' } });
  const result = await proxy('tools/call', { name: 'rdk_plugin_status', arguments: {} });
  assert.equal(result.structuredContent.diagnostics.host.family, 'qoder');
  assert.equal(result.structuredContent.diagnostics.host.verified, false);
  assert.equal(result.structuredContent.diagnostics.layers.authentication, 'not-queried');
  assert.equal(result.structuredContent.diagnostics.layers.platform, 'not-queried');
  assert.deepEqual(calls, ['initialize']);
});

test('guide distinguishes native compute configuration from desktop presence without leaking secrets', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  for (const configured of [false, true]) {
    const secret = 'private-host-token-never-return';
    const env = configured
      ? {
          RDK_LEARNING_STUDIO_HOST_ORIGIN: 'http://127.0.0.1:12345',
          RDK_LEARNING_STUDIO_HOST_TOKEN: secret,
          RDK_STUDIO_PLUGIN_REGISTRY: '/private/registry.json',
          RDK_STUDIO_PLUGIN_ROOT: '/private/plugin',
          RDK_STUDIO_SESSION_FILE: '/private/session.json',
        }
      : {};
    const proxy = experienceProxy({ request: async () => ({}) }, { env });
    const result = await proxy('tools/call', { name: 'rdk_experience_guide' });
    const context = result.structuredContent.clientContext;
    assert.equal(context.nativeCompute.configuration, configured ? 'present' : 'missing');
    assert.equal(context.nativeCompute.runtimeVerified, false);
    assert.match(context.browserAuthentication, /网页/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-host-token-never-return|12345|private\/session/,
    );
    if (!configured) assert.match(context.nativeCompute.nextAction, /适配器/);
  }
});

test('packaging coverage accepts discovered optional tools but still rejects invented tool names', async () => {
  const { verifyTools } = await import('./verify-platform-plugin.mjs');
  const tools = [
    { name: 'rdk_platform_status', annotations: { readOnlyHint: true, destructiveHint: false } },
  ];
  const expected = { tools, snapshot: tools, catalog: [] };
  const optional = [{ name: 'rdk_workflow_inspect' }];
  const documented = new Set(['rdk_platform_status', 'rdk_workflow_inspect']);
  assert.throws(() => verifyTools(tools, expected, documented), /unknown tool/);
  verifyTools(tools, expected, documented, optional);
  assert.throws(
    () => verifyTools(tools, expected, new Set([...documented, 'rdk_invented']), optional),
    /unknown tool: rdk_invented/,
  );
});

test('experience tools appear once on the final upstream catalog page and preserve opaque cursors', async () => {
  const { experienceProxy, EXPERIENCE_TOOLS } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const cursor = 'opaque+/token= with spaces';
  const calls = [];
  const first = { tools: [{ name: 'first' }], nextCursor: cursor, _meta: { page: 1 } };
  const last = { tools: [{ name: 'last' }], _meta: { page: 2 } };
  const proxy = experienceProxy({
    request: async (method, params) => {
      assert.equal(method, 'tools/list');
      calls.push(params);
      return params.cursor === cursor ? last : first;
    },
  });
  assert.deepEqual(await proxy('tools/list', {}), first);
  assert.deepEqual(await proxy('tools/list', { cursor }), {
    ...last,
    tools: [...last.tools, ...EXPERIENCE_TOOLS],
  });
  assert.deepEqual(calls, [{}, { cursor }]);
});

test('preparation discovers required tools beyond the first catalog page', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const calls = [];
  const proxy = experienceProxy({
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === 'tools/list')
        return params.cursor
          ? { tools: [{ name: 'rdk_simulator_open' }] }
          : { tools: [{ name: 'rdk_platform_status' }], nextCursor: 'next-page' };
      const value =
        params.name === 'rdk_platform_status'
          ? { ...ready, baseUrl: options.baseUrl }
          : { entryUrl: '/mujoco/microduck/' };
      return { structuredContent: value };
    },
  });
  const result = await proxy('tools/call', {
    name: 'rdk_experience_prepare',
    arguments: { profile },
  });
  assert.equal(result.structuredContent.status, 'prepared');
  assert.deepEqual(
    calls.filter(([method]) => method === 'tools/list').map(([, params]) => params),
    [{}, { cursor: 'next-page' }],
  );
});

test('catalog name collisions and repeated paging cursors fail explicitly before business calls', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const collision = experienceProxy({
    request: async () => ({ tools: [{ name: 'rdk_experience_guide' }] }),
  });
  await assert.rejects(collision('tools/list'), /reserved|collision/i);
  let reads = 0;
  const looping = experienceProxy({
    request: async (method) => {
      assert.equal(method, 'tools/list', 'invalid catalog must not execute business tools');
      return { tools: [{ name: `tool_${++reads}` }], nextCursor: 'same-cursor' };
    },
  });
  const result = await looping('tools/call', {
    name: 'rdk_experience_prepare',
    arguments: { profile },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /cursor|paging/i);
  assert.equal(reads, 2);
});

test('catalog traversal rejects cross-page duplicates, invalid cursors and page-budget exhaustion', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  for (const mode of ['duplicate', 'invalid-cursor', 'page-budget']) {
    let reads = 0;
    const proxy = experienceProxy({
      request: async (method) => {
        assert.equal(method, 'tools/list');
        reads++;
        if (mode === 'duplicate') return { tools: [{ name: 'same' }], nextCursor: `${reads}` };
        if (mode === 'invalid-cursor') return { tools: [], nextCursor: 123 };
        return { tools: [], nextCursor: `${reads}` };
      },
    });
    const result = await proxy('tools/call', {
      name: 'rdk_experience_prepare',
      arguments: { profile },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /Duplicate|cursor|budget/i);
    assert.equal(reads, mode === 'page-budget' ? 128 : mode === 'duplicate' ? 2 : 1);
  }
});

test('cancellation during catalog paging stops before platform reads', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const controller = new AbortController();
  const proxy = experienceProxy({
    request: async (method, _params, options) => {
      assert.equal(method, 'tools/list');
      assert.equal(options.signal, controller.signal);
      controller.abort(new Error('catalog read cancelled'));
      return { tools: [{ name: 'rdk_platform_status' }] };
    },
  });
  const result = await proxy(
    'tools/call',
    { name: 'rdk_experience_prepare', arguments: { profile } },
    controller.signal,
  );
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /catalog read cancelled/);
});

test('preparation follows opaque catalog pages over an actual stdio child connection', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const source = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;if(m.method==='tools/list')result=m.params.cursor==='opaque+/= second page'?{tools:[{name:'rdk_simulator_open'}]}:{tools:[{name:'rdk_platform_status'}],nextCursor:'opaque+/= second page'};else result={structuredContent:m.params.name==='rdk_platform_status'?{ok:true,baseUrl:'https://studio.example/learning',authMode:'cookie',health:{ready:true,degraded:[]},session:{authenticated:true}}:{entryUrl:'/mujoco/microduck/'}};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`;
  const upstream = connectMcp({ args: ['-e', source], timeoutMs: 2000 });
  try {
    const result = await experienceProxy(upstream)('tools/call', {
      name: 'rdk_experience_prepare',
      arguments: { profile },
    });
    assert.equal(result.structuredContent.status, 'prepared');
    assert.equal(
      result.structuredContent.entryUrl,
      'https://studio.example/learning/mujoco/microduck/',
    );
    assert.ok(Object.values(result.structuredContent.execution).every((value) => value === false));
  } finally {
    await upstream.close();
  }
});

test('runtime version requires matching loaded source hashes and rejects a stale cached process', async (t) => {
  const { createHash } = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-runtime-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'references'));
  fs.copyFileSync(
    new URL(
      '../plugins/rdk-robot-learning-platform/references/originman-dance-manifest.json',
      import.meta.url,
    ),
    path.join(root, 'references/originman-dance-manifest.json'),
  );
  for (const name of [
    'experience-mcp.mjs',
    'experience.mjs',
    'workflow-inspection.mjs',
    'workspace-evidence.mjs',
    'experiment-context.mjs',
    'short-training.mjs',
    'plugin-auth.mjs',
    'authenticated-core.mjs',
    'plugin-errors.mjs',
    'course-setup.mjs',
    'submission-journal.mjs',
    'workshop-course.mjs',
    'originman-dance-config.mjs',
    'dance-training.mjs',
    'dance-coaching.mjs',
    'dance-evaluation.mjs',
    'dance-iteration.mjs',
    'workshop-entry.mjs',
    'development-targets.mjs',
    'playback-plan.mjs',
    'mcp-app-resource.mjs',
    'guided-input.mjs',
    'robot-onboarding.mjs',
    'classroom-guide.mjs',
  ])
    fs.copyFileSync(
      new URL('../plugins/rdk-robot-learning-platform/scripts/' + name, import.meta.url),
      path.join(root, 'scripts', name),
    );
  const { pluginRuntimeIdentity } = await import(
    pathToFileURL(path.join(root, 'scripts/experience-mcp.mjs')).href
  );
  assert.equal(pluginRuntimeIdentity().loadedSourcesMatch, false);
  const writeProvenance = () =>
    fs.writeFileSync(
      path.join(root, 'provenance.json'),
      JSON.stringify({
        version: '0.1.15',
        wrapperSources: Object.fromEntries(
          [
            'experience-mcp.mjs',
            'experience.mjs',
            'workflow-inspection.mjs',
            'workspace-evidence.mjs',
            'experiment-context.mjs',
            'short-training.mjs',
            'plugin-auth.mjs',
            'authenticated-core.mjs',
            'plugin-errors.mjs',
            'course-setup.mjs',
            'submission-journal.mjs',
            'workshop-course.mjs',
            'originman-dance-config.mjs',
            'dance-training.mjs',
            'dance-coaching.mjs',
            'dance-evaluation.mjs',
            'dance-iteration.mjs',
            'workshop-entry.mjs',
            'development-targets.mjs',
            'playback-plan.mjs',
            'mcp-app-resource.mjs',
            'guided-input.mjs',
            'robot-onboarding.mjs',
            'classroom-guide.mjs',
          ].map((name) => [
            'scripts/' + name,
            createHash('sha256')
              .update(fs.readFileSync(path.join(root, 'scripts', name)))
              .digest('hex'),
          ]),
        ),
      }),
    );
  writeProvenance();
  assert.equal(pluginRuntimeIdentity().version, '0.1.15');
  assert.equal(pluginRuntimeIdentity().loadedSourcesMatch, true);
  fs.appendFileSync(
    path.join(root, 'scripts/experiment-context.mjs'),
    '\n// replaced after this process loaded\n',
  );
  writeProvenance();
  assert.equal(pluginRuntimeIdentity().version, null);
  assert.equal(pluginRuntimeIdentity().loadedSourcesMatch, false);
});

test('beginner guide starts fresh and routes known tasks without reading old Runs', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const dispatch = experienceProxy(
    {
      request() {
        assert.fail('new planning is local');
      },
    },
    {
      env: { RDK_SIM2REAL_MCP_BASE_URL: 'https://platform.test/robotics-learning' },
    },
  );
  const guide = async (args) =>
    (await dispatch('tools/call', { name: 'rdk_learning_guide', arguments: args }))
      .structuredContent;
  assert.equal((await guide({ intent: 'new' })).stage, 'task');
  assert.equal((await guide({ intent: 'new', task: 'dance' })).stage, 'movement');
  assert.deepEqual((await guide({ intent: 'new', task: 'recovery' })).nextArguments, {
    intent: 'new',
    course: 'recovery',
  });
  assert.equal(
    (await guide({ task: 'imitation' })).links.workbench,
    'https://platform.test/robotics-learning/?learningMode=imitation#overview',
  );
  const otherRobot = await guide({ task: 'reinforcement', robot: 'MicroDuck' });
  assert.match(otherRobot.studentReply, /MicroDuck/);
  assert.doesNotMatch(otherRobot.studentReply, /OriginMan/);
  assert.equal(
    otherRobot.links.workbench,
    'https://platform.test/robotics-learning/?robot=microduck&learningMode=reinforcement#train/configure',
  );
  assert.equal(
    (await guide({ task: 'simulation', robot: 'OriginBot' })).links.workbench,
    'https://platform.test/robotics-learning/?robot=originbot#simulate',
  );
  assert.equal(
    (await guide({ task: 'evaluation', robot: 'my custom robot' })).links.workbench,
    'https://platform.test/robotics-learning/?robot=custom#train/prepare',
  );
  for (const [task, page] of [
    ['overview', 'overview'],
    ['simulation', 'simulate'],
    ['evaluation', 'evaluate'],
    ['replay', 'records'],
    ['deployment', 'deploy/preflight'],
  ]) {
    const next = await guide({ task });
    assert.equal(next.links.workbench, 'https://platform.test/robotics-learning/#' + page);
    assert.deepEqual(next.studioNavigation, {
      tool: 'studio_open_url',
      arguments: { url: next.links.workbench },
    });
  }
  assert.equal((await guide({ intent: 'results' })).stage, 'choose-run');
});

test('bundled core guide is advertised once with the wrapper intent contract', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const dispatch = experienceProxy({
    request: async () => ({ tools: [{ name: 'rdk_learning_guide', description: 'core' }] }),
  });
  const catalog = await dispatch('tools/list');
  const guides = catalog.tools.filter(({ name }) => name === 'rdk_learning_guide');
  assert.equal(guides.length, 1);
  assert.ok(guides[0].inputSchema.properties.intent.enum.includes('retry'));
});

test('guide reads the exact Run and keeps confirmed retry idempotent', async (t) => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-guide-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = [
    'rdk_model_validate',
    'rdk_models_list',
    'rdk_model_register',
    'rdk_compute_resources_list',
    'rdk_compute_resource_test',
    'rdk_training_submit',
  ];
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        '../plugins/rdk-robot-learning-platform/references/originman-dance-manifest.json',
        import.meta.url,
      ),
    ),
  );
  const dance = {
    schemaVersion: 1,
    title: '双段舞',
    bpm: 100,
    trainingSteps: 8192,
    sections: [
      { type: 'alternating-arms', beats: 8, intensity: 0.25 },
      { type: 'open-pose', beats: 4, intensity: 0.5 },
    ],
  };
  const previous = {
    id: 'run-old',
    modelId: 'dance-model',
    status: 'completed',
    computeResourceId: 'worker',
    training: { numEnvs: 2, originmanDance: dance },
    metrics: { trainingDevice: 'mps', originmanDance: { qualityGatePassed: false } },
  };
  let writes = 0;
  const dispatch = experienceProxy(
    {
      async request(method, { name, arguments: args }) {
        if (method === 'tools/list') return { tools: names.map((name) => ({ name })) };
        let value;
        if (name === 'rdk_training_status') {
          assert.equal(args.runId, previous.id);
          value = { run: previous };
        } else if (name === 'rdk_model_validate') value = { valid: true };
        else if (name === 'rdk_models_list') value = { models: [{ id: 'dance-model', manifest }] };
        else if (name === 'rdk_compute_resources_list')
          value = { computeResources: [{ id: 'worker' }] };
        else if (name === 'rdk_compute_resource_test')
          value = { id: 'worker', connected: true, mock: false, engines: ['originman-dance-ppo'] };
        else if (name === 'rdk_training_submit') {
          writes++;
          assert.equal(args.originmanDance.trainingSteps, 500000);
          assert.equal(args.originmanDance.sections.length, 2);
          value = { runId: 'run-new', status: 'queued' };
        } else assert.fail(name);
        return { structuredContent: value };
      },
    },
    {
      contextDirectory: dir,
      env: { RDK_SIM2REAL_MCP_BASE_URL: 'https://platform.test/robotics-learning' },
    },
  );
  const call = async (name, args) =>
    (await dispatch('tools/call', { name, arguments: args })).structuredContent;
  const guide = (args) => call('rdk_learning_guide', args);
  const result = await guide({ intent: 'results', runId: previous.id });
  assert.match(result.studentReply, /mps.*未达标.*暂无可播放/s);
  assert.doesNotMatch(result.studentReply, /标称/);
  const evaluated = previous.metrics.originmanDance;
  evaluated.evaluations = [
    { bpm: 95, sections: dance.sections.map(({ type }) => ({ type, passed: false })) },
    {
      bpm: 100,
      sections: dance.sections.map(({ type }, index) => ({ type, passed: index === 1 })),
    },
  ];
  const measured = await guide({ intent: 'results', runId: previous.id });
  assert.match(measured.studentReply, /标称 100 BPM 下，1\/2 段达标/);
  evaluated.evaluations[1].sections.pop();
  const partial = await guide({ intent: 'results', runId: previous.id });
  assert.doesNotMatch(partial.studentReply, /标称/);
  previous.training.video = false;
  const videoDisabled = await guide({ intent: 'results', runId: previous.id });
  assert.match(videoDisabled.studentReply, /提交时关闭了视频生成/);
  delete previous.training.video;
  assert.equal(new URL(result.links.runDetail).searchParams.get('runId'), previous.id);
  assert.deepEqual(result.studioNavigation, {
    tool: 'studio_open_url',
    arguments: { url: result.links.runDetail },
  });
  assert.match(result.delivery, /舞蹈独立评测.*原 Run/);
  assert.match(result.delivery, /不要调用 rdk_experiment_remember 关联舞蹈评测/);
  const retry = { intent: 'retry', runId: previous.id, changes: { trainingSteps: 500000 } };
  const preview = await guide(retry);
  assert.equal(preview.stage, 'retry-confirm');
  assert.deepEqual(preview.changes, [{ label: '训练步数', before: 8192, after: 500000 }]);
  assert.equal(writes, 0);
  const first = await guide({ ...retry, confirmed: true });
  const repeat = await guide({ ...retry, confirmed: true });
  assert.deepEqual(first.nextArguments, repeat.nextArguments);
  const submitted = await call(first.nextTool, first.nextArguments);
  assert.equal(new URL(submitted.links.runDetail).searchParams.get('runId'), 'run-new');
  assert.equal(new URL(submitted.links.previousRun).searchParams.get('runId'), previous.id);
  assert.equal(submitted.nextTool, 'rdk_originman_dance_acceptance');
  assert.deepEqual(submitted.nextArguments, { runId: 'run-new' });
  const duplicate = await call(first.nextTool, first.nextArguments);
  assert.equal(duplicate.alreadySubmitted, true);
  assert.equal(writes, 1);
});

test('compute guide gives an actionable link and excludes incompatible resources', async () => {
  const { developmentTargets } =
    await import('../plugins/rdk-robot-learning-platform/scripts/development-targets.mjs');
  const engine = 'originman-dance-ppo';
  const result = await developmentTargets(
    { action: 'list-compute', engine },
    {
      authentication: {
        async status() {
          return { authenticated: true, accountId: 'owner' };
        },
      },
      baseUrl: 'https://platform.test/robotics-learning',
      async request(operation) {
        assert.equal(operation, 'compute');
        return {
          computeResources: [
            {
              id: 'local',
              source: 'local-agent',
              status: 'online',
              mock: false,
              engines: [engine],
            },
            { id: 'offline', status: 'offline', mock: false, engines: [engine] },
            { id: 'wrong', status: 'online', mock: false, engines: ['starter-ppo'] },
            { id: 'right', status: 'online', mock: false, engines: [engine], gpuName: 'RTX 4090' },
          ],
        };
      },
    },
  );
  assert.deepEqual(
    result.compute.map(({ id }) => id),
    ['right'],
  );
  assert.equal(result.links.resources, 'https://platform.test/robotics-learning/#resources');
  assert.match(result.studentReply, /RTX 4090/);
});

test('legacy replay is linked only after verifying bytes for the exact Run', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const sha = 'a'.repeat(64);
  const replay = 'b'.repeat(64);
  const run = {
    id: 'legacy-dance',
    status: 'completed',
    mock: false,
    artifact: { sha256: sha },
    metrics: {
      trainingDevice: 'cuda',
      trainingDeviceName: 'NVIDIA GeForce RTX 4090',
      originmanDance: {
        replay: { sha256: replay },
        video: {
          file: 'dance-replay.mp4',
          sha256: 'c'.repeat(64),
          sizeBytes: 1024,
          policySha256: sha,
          sourceReplaySha256: replay,
        },
      },
    },
  };
  let allow = false;
  let checked = 0;
  let compactTelemetry = true;
  const emptySummary = { runId: run.id, frameCount: 0, sampleCount: 0 };
  const route = './api/v1/duck/runs/legacy-dance/dance-video';
  const dispatch = experienceProxy(
    {
      readTrainingRun: async () => run,
      readTelemetrySummary: async () => (compactTelemetry ? emptySummary : null),
      request: async (_method, params) => ({
        structuredContent: params.name === 'rdk_runs_replay' ? emptySummary : { run },
      }),
      async verifyLegacyDanceVideo(runId, receipt) {
        assert.equal(runId, run.id);
        assert.equal(receipt, run.metrics.originmanDance.video);
        checked++;
        return allow ? route : null;
      },
    },
    { env: { RDK_SIM2REAL_MCP_BASE_URL: 'https://platform.test/robotics-learning' } },
  );
  const guide = async () =>
    (
      await dispatch('tools/call', {
        name: 'rdk_learning_guide',
        arguments: { intent: 'results', runId: run.id },
      })
    ).structuredContent;
  const unavailable = await guide();
  assert.equal(unavailable.links.danceVideo, undefined);
  assert.match(unavailable.studentReply, /有本轮视频记录，当前未能核验播放入口/);
  assert.match(unavailable.studentReply, /NVIDIA GeForce RTX 4090 \(cuda\)/);
  allow = true;
  assert.equal(
    (await guide()).links.danceVideo,
    'https://platform.test/robotics-learning/api/v1/duck/runs/legacy-dance/dance-video',
  );
  const readTelemetry = async () =>
    (
      await dispatch('tools/call', {
        name: 'rdk_runs_replay',
        arguments: { runId: run.id },
      })
    ).structuredContent;
  const telemetry = await readTelemetry();
  assert.equal(telemetry.frameCount, 0);
  assert.equal(telemetry.replayKind, 'simulation');
  assert.equal(new URL(telemetry.links.replay).hash, '#replay-heading');
  assert.match(telemetry.studentReply, /暂无通用遥测帧.*本轮仿真回放/s);
  compactTelemetry = false;
  assert.deepEqual(await readTelemetry(), telemetry);
  run.metrics.trainingDeviceName = '<untrusted>';
  run.artifact.sha256 = 'd'.repeat(64);
  const rejected = await guide();
  assert.equal(rejected.links.danceVideo, undefined);
  assert.match(rejected.studentReply, /实际训练设备：cuda。/);
  assert.doesNotMatch(rejected.studentReply, /untrusted/);
  assert.equal(checked, 4);
});

test('OriginMan auto iteration raises quick-check budget, preserves the Run chain and stops on pass', async () => {
  const { createDanceIteration } =
    await import('../plugins/rdk-robot-learning-platform/scripts/dance-iteration.mjs');
  const { submitOnce, recoverSubmission } =
    await import('../plugins/rdk-robot-learning-platform/scripts/submission-journal.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-iteration-test-'));
  const run = {
    id: 'quick',
    taskId: 'originman-dance',
    contractId: 'dance',
    computeResourceId: 'worker-4090',
    modelId: 'dance-ppo',
    mock: false,
    training: {
      engine: 'originman-dance-ppo',
      numEnvs: 64,
      originmanDance: {
        schemaVersion: 1,
        title: 'Original',
        bpm: 100,
        seed: 7,
        trainingSteps: 8192,
        sections: [{ type: 'alternating-arms', beats: 8, intensity: 0.5 }],
      },
    },
    metrics: {
      trainingDevice: 'cuda',
      trainingDeviceName: 'NVIDIA GeForce RTX 4090',
      trainingSteps: 8192,
      originmanDance: { sceneProvenance: { sceneSha256: 'a'.repeat(64) } },
    },
  };
  let formal;
  let submissions = 0;
  const accepted = (run, state) => ({
    run,
    simulationAcceptance: { state },
    runDelivery: { policy: 'available', replay: 'simulation' },
  });
  const journal = (contextId) => ({
    contextId,
    scope: 'dance-test',
    phase: 'train',
    directory,
    remember: async (runId) => ({ runId }),
  });
  const create = () =>
    createDanceIteration({
      baseUrl: 'https://fixture.test/learning',
      account: async () => 'owner',
      accept: async (id) => (id === run.id ? accepted(run, 'failed') : accepted(formal, 'passed')),
      recover: (contextId) => recoverSubmission(journal(contextId)),
      submit: (args) =>
        submitOnce({
          ...journal(args.contextId),
          submit: async () => {
            submissions++;
            assert.equal(args.numEnvs, 64);
            assert.equal(args.computeResourceId, run.computeResourceId);
            assert.equal(args.modelId, run.modelId);
            assert.deepEqual(args.dance.sections, run.training.originmanDance.sections);
            const steps = Math.ceil(args.dance.trainingSteps / 4096) * 4096;
            formal = {
              ...run,
              id: 'formal',
              training: { ...run.training, originmanDance: args.dance },
              metrics: { ...run.metrics, trainingSteps: steps },
            };
            return { runId: formal.id };
          },
        }),
    });
  const args = { runId: run.id, goal: 'original-quality-gate', additionalSteps: 503808 };
  try {
    const low = await create()({ ...args, additionalSteps: 8192 });
    assert.equal(low.iteration.state, 'budget-exhausted');
    assert.equal(submissions, 0);
    const started = await create()(args);
    assert.deepEqual(started.nextArguments, args);
    assert.equal(started.iteration.spentSteps, 503808);
    assert.equal(formal.training.originmanDance.trainingSteps, 500000);
    assert.equal(started.iteration.state, 'waiting');
    const done = await create()(started.nextArguments);
    assert.equal(submissions, 1);
    assert.equal(done.nextArguments, undefined);
    assert.equal(done.iteration.state, 'passed');
    assert.deepEqual(
      done.iteration.rounds.map((row) => [row.runId, row.state]),
      [
        ['quick', 'failed'],
        ['formal', 'passed'],
      ],
    );
    assert.match(done.iteration.rounds[1].change, /8,192 → 500,000/);
    assert.equal(
      new URL(done.studioNavigation.arguments.url).pathname,
      '/learning/dance-iterations.html',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('auto iteration tunes exactly one reward at 64 envs after a verified formal failure', async () => {
  const { createDanceIteration, matchesDanceIterationGpu } =
    await import('../plugins/rdk-robot-learning-platform/scripts/dance-iteration.mjs');
  const config = {
    schemaVersion: 1,
    title: 'Original',
    bpm: 100,
    seed: 7,
    trainingSteps: 500000,
    sections: [{ type: 'alternating-arms', beats: 8, intensity: 0.5 }],
  };
  const run = {
    id: 'formal-miss',
    taskId: 'originman-dance',
    status: 'completed',
    modelId: 'model',
    computeResourceId: 'worker-4090',
    mock: false,
    training: { engine: 'originman-dance-ppo', numEnvs: 64, originmanDance: config },
    metrics: {
      trainingDevice: 'cuda',
      trainingDeviceName: 'NVIDIA GeForce RTX 4090',
      trainingSteps: 503808,
      originmanDance: {
        qualityGatePassed: false,
        evaluations: [
          {
            bpm: 100,
            failed: false,
            completed: true,
            sections: [
              {
                type: 'alternating-arms',
                beats: 8,
                clean: true,
                stylePassed: false,
                passed: false,
                measurements: {
                  alternatingArmFraction: 0.5,
                  armBeatCorrelation: 0.15,
                  armAsymmetryRangeM: 0.07,
                },
              },
            ],
          },
        ],
      },
    },
  };
  let submitted;
  const iterate = createDanceIteration({
    baseUrl: 'https://fixture.test',
    account: async () => 'owner',
    accept: async () => ({ run, simulationAcceptance: { state: 'failed' } }),
    recover: async () => null,
    submit: async (args) => {
      submitted = args;
      return { submission: { runId: 'reward-round' } };
    },
  });
  const args = { runId: run.id, goal: 'original-quality-gate', additionalSteps: 503808 };
  assert.equal(
    (await iterate({ ...args, additionalSteps: 500000 })).iteration.state,
    'budget-exhausted',
  );
  assert.equal(submitted, undefined);
  assert.equal((await iterate(args)).iteration.state, 'waiting');
  const { title, rewardTuning, ...retained } = submitted.dance;
  const { title: _originalTitle, ...original } = config;
  assert.deepEqual(retained, original);
  assert.deepEqual(rewardTuning, { armSpeedWeight: 1.7 });
  assert.equal(matchesDanceIterationGpu({ cuda: true, gpuName: 'RTX 4090' }), true);
  assert.equal(matchesDanceIterationGpu({ cuda: false, gpuName: 'RTX 4090' }), false);
  assert.equal(matchesDanceIterationGpu({ cuda: true, gpuName: 'RTX 3090' }), false);
});

test('an OriginMan goal starts with no Run, abandons a worse parameter trial and stops on success', async (t) => {
  const { createDanceIteration } =
    await import('../plugins/rdk-robot-learning-platform/scripts/dance-iteration.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-goal-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const jobs = new Map();
  const recipes = [];
  const args = {
    contextId: 'fresh-dance-goal',
    goal: 'dance-quality-gate',
    computeResourceId: 'isolated-4090',
    totalSteps: 2 * 8192 + 3 * 503808,
    dance: {
      schemaVersion: 1,
      title: '交替摆臂',
      bpm: 100,
      seed: 7,
      sections: [{ type: 'alternating-arms', beats: 8, intensity: 0.5 }],
    },
  };
  const source = {
    async account() {
      return 'fixture-account';
    },
    recover: async (id) => jobs.get(id),
    submit: async (input) => {
      const runId = 'trial-' + (jobs.size + 1);
      const receipt = { submission: { runId } };
      recipes.push(input);
      jobs.set(input.contextId, receipt);
      return receipt;
    },
    accept: async (id) => {
      const i = Number(id.split('-').pop()) - 1;
      const plan = recipes[i];
      const passed = i === 4;
      const measurements = [
        [0.01485, 0, 0.14],
        [0.01, 0, 0.12],
        [0.07, 0.6, 0.16],
        [0.04, 0.4, 0.05],
        [0.12, 0.72, 0.23],
      ][i];
      return {
        simulationAcceptance: { state: passed ? 'passed' : 'failed', allTemposVerified: true },
        runDelivery: { policy: 'available', replay: 'simulation' },
        run: {
          id,
          taskId: 'originman-dance',
          mock: false,
          contractId: 'dance-v2',
          modelId: 'model',
          computeResourceId: args.computeResourceId,
          training: { engine: 'originman-dance-ppo', numEnvs: 64, originmanDance: plan.dance },
          metrics: {
            trainingDevice: 'cuda',
            trainingDeviceName: 'NVIDIA RTX 4090',
            trainingSteps: Math.ceil(plan.dance.trainingSteps / 4096) * 4096,
            originmanDance: {
              sceneProvenance: { sceneSha256: 'a'.repeat(64) },
              evaluations: [95, 100, 105].map((bpm) => ({
                bpm,
                sections: [
                  {
                    type: 'alternating-arms',
                    clean: true,
                    passed,
                    measurements: {
                      armAsymmetryRangeM: measurements[0],
                      alternatingArmFraction: measurements[1],
                      armBeatCorrelation: measurements[2],
                    },
                  },
                ],
              })),
            },
          },
        },
      };
    },
  };
  const create = () =>
    createDanceIteration({
      ...source,
      contextDirectory: directory,
      baseUrl: 'https://fixture.test/learning',
    });
  let iteration = await create()(args);
  assert.equal(recipes[0].dance.trainingSteps, 8192);
  assert.equal(recipes[0].previousRunId, undefined);
  await assert.rejects(() => create()({ ...args, totalSteps: args.totalSteps + 4096 }), /已绑定/);
  while (iteration.nextArguments) iteration = await create()(iteration.nextArguments);
  assert.equal(iteration.iteration.state, 'passed');
  assert.equal(iteration.iteration.bestRunId, 'trial-5');
  assert.equal(iteration.iteration.spentSteps, args.totalSteps);
  assert.equal(recipes.length, 5);
  assert.equal(recipes[1].dance.trainingSteps, 8192);
  assert.deepEqual(recipes[1].dance.rewardTuning, { armSwingWeight: 4.5 });
  assert.equal(recipes[2].dance.trainingSteps, 500000);
  assert.equal(recipes[2].previousRunId, 'trial-1');
  assert.deepEqual(recipes[3].dance.rewardTuning, { armSwingWeight: 4.5 });
  assert.equal(recipes[4].previousRunId, 'trial-3');
  assert.deepEqual(recipes[4].dance.rewardTuning, { armSpeedWeight: 1.7 });
  assert.equal((await create()(args)).iteration.state, 'passed');
  assert.equal(recipes.length, 5);
});

test('Studio returns a short continuation during slow work and keeps the exact goal and budget', async (t) => {
  const { createDanceGoalContinuation } =
    await import('../plugins/rdk-robot-learning-platform/scripts/dance-iteration.mjs');
  const contextDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-continue-'));
  t.after(() => fs.rmSync(contextDirectory, { recursive: true, force: true }));
  const draft = {
    goal: 'dance-quality-gate',
    contextId: 'background-dance',
    computeResourceId: 'the-worker',
    totalSteps: 1024000,
    dance: {
      schemaVersion: 1,
      title: '摆臂',
      bpm: 100,
      sections: [{ type: 'alternating-arms', beats: 8, intensity: 0.5 }],
    },
  };
  let calls = 0;
  let finish;
  const hold = new Promise((resolve) => {
    finish = resolve;
  });
  const body = {
    state: 'passed',
    spentSteps: 520192,
    reason: '已达标',
    rounds: [{ runId: 'real-run', state: 'passed' }],
  };
  const create = () =>
    createDanceGoalContinuation({
      baseUrl: 'https://platform.example.test/learning',
      pollMs: 10,
      pauseMs: 1,
      contextDirectory,
      account: async () => 'operator',
      iterate: async (args) => {
        assert.deepEqual(args, draft);
        calls++;
        await hold;
        return { iteration: body };
      },
    });
  const api = create();
  const first = await api(draft);
  assert.equal(first.iteration.state, 'waiting');
  assert.deepEqual(Object.keys(first.nextArguments), ['resumeContextId', 'pollAfter']);
  assert.equal(first.nextArguments.resumeContextId, draft.contextId);
  const second = await api(first.nextArguments);
  assert.equal(second.nextArguments.resumeContextId, draft.contextId);
  assert.equal(calls, 1);
  await assert.rejects(() => api({ ...draft, totalSteps: 2000000 }), /绑定原目标/);
  finish();
  const terminal = await api(second.nextArguments);
  assert.equal(terminal.nextArguments, undefined);
  assert.equal(terminal.iteration.remainingSteps, 503808);
  assert.match(terminal.studioNavigation.arguments.url, /dance-iterations.html/);
  assert.deepEqual(
    (await create()({ resumeContextId: draft.contextId })).iteration,
    terminal.iteration,
  );
  assert.equal(calls, 1);
});

test('an independent evaluation timeout polls the identical Run until its report is ready', async () => {
  const { createDanceEvaluationReader } =
    await import('../plugins/rdk-robot-learning-platform/scripts/dance-evaluation.mjs');
  const calls = [];
  const report = { source: { runId: 'original' } };
  let ready = false;
  const read = createDanceEvaluationReader({
    async readDanceEvaluationRun(id) {
      calls.push(['GET', id]);
      return ready ? report : null;
    },
    async evaluateDanceRun(id) {
      calls.push(['POST', id]);
      throw new DOMException('Timed out', 'TimeoutError');
    },
  });
  await assert.rejects(read('original'), { code: 'DANCE_EVALUATION_PENDING' });
  await assert.rejects(read('original'), { code: 'DANCE_EVALUATION_PENDING' });
  ready = true;
  assert.equal(await read('original'), report);
  assert.deepEqual(calls, [
    ['GET', 'original'],
    ['POST', 'original'],
    ['GET', 'original'],
    ['GET', 'original'],
  ]);
});

test('Studio protects the automatic scope even after invalid arguments, and rejects ordinary fallback', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const calls = [];
  const dispatch = experienceProxy(
    {
      async request(method, params) {
        calls.push([method, params]);
        throw Error('No training operation should reach the upstream connection');
      },
    },
    { env: { RDK_STUDIO_INHERIT_LOGIN: '1' } },
  );
  const call = (name, args) => dispatch('tools/call', { name, arguments: args });
  const early = await call('rdk_originman_dance_train', { contextId: 'fallback' });
  assert.equal(early.structuredContent.error.platformCode, 'DANCE_ROUTE_REQUIRED');
  assert.equal(early.structuredContent.nextTool, 'rdk_originman_dance_iterate');
  const invalid = await call('rdk_originman_dance_iterate', {
    goal: 'invalid',
    totalSteps: 524288,
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.nextTool, 'rdk_originman_dance_iterate');
  const changed = await call('rdk_training_submit', {
    engine: 'originman-dance-ppo',
    contextId: 'new',
  });
  assert.equal(changed.structuredContent.error.platformCode, 'DANCE_GOAL_RESERVED');
  assert.equal(calls.length, 0);
});

test('Studio and Qoder expose and use the same non-actuating OriginMan CPU tool', async () => {
  const { experienceProxy } =
    await import('../plugins/rdk-robot-learning-platform/scripts/experience-mcp.mjs');
  const tool = 'rdk_originman_dance_cpu_rehearse';
  const args = { runId: 'dance-run-v2', deviceId: 'x5-real-001' };
  for (const host of ['RDK Studio', 'Qoder']) {
    const requests = [];
    const proxy = experienceProxy({
      async request(method) {
        if (method === 'initialize') return { capabilities: {}, serverInfo: { name: 'fixture' } };
        assert.equal(method, 'tools/list');
        return { tools: [] };
      },
      async rehearseOriginmanDanceCpu(args) {
        requests.push(args);
        const evidence = { runId: args.runId, run: { trainingSteps: 503808 } };
        if (!args.deviceId)
          return {
            ...evidence,
            phase: 'preflight',
            stopWorkflow: true,
            blocker: 'x5-not-connected',
            nextAction: '当前没有已接通的 RDK X5。',
          };
        return {
          ...evidence,
          phase: 'rehearsal',
          staged: true,
          loaded: true,
          motionAuthorized: false,
          timing: { syntheticCyclePassed: true },
        };
      },
    });
    const { instructions } = await proxy('initialize', {
      clientInfo: { name: host, version: '1.0' },
    });
    assert.match(instructions, /load_tools\(\{"query":"rdk_originman_dance_cpu_rehearse"\}\)/);
    assert.match(instructions, /使用目录中的完整名称调用.*只有唯一匹配/);
    assert.doesNotMatch(
      instructions,
      /mcp__rdk-robot-learning-platform__rdk_originman_dance_cpu_rehearse/,
    );
    const catalog = await proxy('tools/list');
    const descriptor = catalog.tools.find(({ name }) => name === tool);
    assert.deepEqual(descriptor.inputSchema.required, ['runId']);
    assert.equal(descriptor.annotations.destructiveHint, false);
    assert.match(descriptor.description, /stopWorkflow=true.*studentReply.*结束本轮/);
    const missing = await proxy('tools/call', { name: tool, arguments: { runId: args.runId } });
    assert.equal(missing.isError, undefined);
    assert.equal(missing.structuredContent.stopWorkflow, true);
    assert.match(missing.structuredContent.instructions, /studentReply.*结束本轮/);
    assert.match(
      missing.structuredContent.studentReply,
      /实际采样 503,808 步.*没有已接通的 RDK X5/,
    );
    assert.deepEqual(requests, [{ runId: args.runId }]);
    const measured = await proxy('tools/call', { name: tool, arguments: args });
    assert.deepEqual(requests, [{ runId: args.runId }, args]);
    assert.equal(measured.structuredContent.motionAuthorized, false);
    assert.match(
      measured.structuredContent.studentReply,
      /真实 IMU、舵机映射和整机控制周期仍待验证/,
    );
  }
});
