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
  await assert.rejects(
    prepareExperience(
      origin,
      async (name) => {
        if (name === 'rdk_platform_status') return ready;
        throw Object.assign(new Error('old server'), {
          platformCode: 'SIM2REAL_API_NOT_FOUND',
          httpStatus: 404,
        });
      },
      { tools: [...tools, 'rdk_workspace_overview'], baseUrl: 'https://platform.test/' },
    ),
    /old server/,
  );
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
  assert.equal(await open({ robot: 'originman' }), missing);
  assert.equal(await open({ runId: 'run-42' }), missing);
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
  });
  assert.equal(
    (await guide({ task: 'imitation' })).links.workbench,
    'https://platform.test/robotics-learning/#train',
  );
  const otherRobot = await guide({ task: 'reinforcement', robot: 'MicroDuck' });
  assert.match(otherRobot.studentReply, /MicroDuck/);
  assert.doesNotMatch(otherRobot.studentReply, /OriginMan/);
  for (const [task, page] of [
    ['overview', 'overview'],
    ['simulation', 'simulate'],
    ['evaluation', 'evaluate'],
    ['replay', 'records'],
    ['deployment', 'deploy'],
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
  const route = './api/v1/duck/runs/legacy-dance/dance-video';
  const dispatch = experienceProxy(
    {
      readTrainingRun: async () => run,
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
  allow = true;
  assert.equal(
    (await guide()).links.danceVideo,
    'https://platform.test/robotics-learning/api/v1/duck/runs/legacy-dance/dance-video',
  );
  run.artifact.sha256 = 'd'.repeat(64);
  assert.equal((await guide()).links.danceVideo, undefined);
  assert.equal(checked, 2);
});
