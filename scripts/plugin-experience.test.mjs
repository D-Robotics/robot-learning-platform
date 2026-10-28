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
} from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';

const profile = { schemaVersion: 1, id: 'demo', policy: { source: 'reference' } };
const tools = ['rdk_platform_status', 'rdk_simulator_open', 'rdk_training_status'];
const ready = {
  ok: true,
  authMode: 'cookie',
  health: { ready: true, degraded: [] },
  session: { authenticated: true },
};
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
  const { experienceProxy } =
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
  const list = await proxy('tools/list');
  assert.deepEqual(list.tools[0], original);
  assert.equal(list.tools.length, 5);
  const guide = await proxy('tools/call', { name: 'rdk_experience_guide' });
  assert.match(guide.structuredContent.guide, /场景准备/);
  const passthrough = await proxy('tools/call', {
    name: 'existing_write_tool',
    arguments: { x: 1 },
  });
  assert.equal(passthrough.isError, true);
  assert.deepEqual(passthrough.arguments, { x: 1 });
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
    if (!configured) assert.match(context.nativeCompute.nextAction, /宿主接口/);
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
