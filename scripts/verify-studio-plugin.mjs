#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportStudioPlugin } from './export-studio-plugin.mjs';
import { readStudioPluginCredentialEnv } from './start-studio-plugin-mcp.mjs';

const learningRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stdioCatalog(config, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.command, config.args, {
      cwd,
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`MCP cold start timed out: ${stderr.slice(-500)}`)),
      20_000,
    );
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(value);
    };
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled)
        finish(new Error(`MCP exited before tools/list (${code}): ${stderr.slice(-500)}`));
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error('MCP stdout contains non-JSON protocol output.'));
          return;
        }
        if (message.id === 2) {
          if (message.error) finish(new Error(JSON.stringify(message.error)));
          else finish(null, message.result);
        }
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'studio-plugin-verifier', version: '1.0.0' },
          capabilities: {},
        },
      }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
    );
  });
}

async function verifyNativeHost(studioRoot, pluginDirectory, temp) {
  const host = fs.realpathSync(studioRoot);
  const require = createRequire(path.join(host, 'package.json'));
  const loader = require.resolve('tsx/esm');
  // Run the host's actual importer/resolver with temporary config and data
  // roots. No application checkout or real user's plugin state is modified.
  const probe = path.join(temp, 'native-host-probe.mjs');
  fs.writeFileSync(
    probe,
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const host = process.argv[2], source = process.argv[3];
const learning = process.argv[4];
// Imported platform modules share CLI helpers; this probe has consumed its args.
process.argv.splice(2);
const require = createRequire(path.join(host, 'package.json'));
const express = require('express');
const { createPluginsRouter } = await import(pathToFileURL(path.join(host, 'server/routes/plugins-routes.ts')));
const { scanPlugins } = await import(pathToFileURL(path.join(host, 'server/plugins/plugin-scanner.ts')));
const { resolvePluginMcpServers } = await import(pathToFileURL(path.join(host, 'server/plugins/plugin-mcp-resolver.ts')));
const { loadStudioMcpTools } = await import(pathToFileURL(path.join(host, 'server/moss/run/run-mcp-tools.ts')));
const { MossApp } = await import(pathToFileURL(path.join(host, 'server/moss/run/app.ts')));
const { createSkillDiscoveryTools } = await import(pathToFileURL(path.join(host, 'server/agent/tools/skill-discovery-tools.ts')));
const { setPluginEnabled } = await import(pathToFileURL(path.join(host, 'server/plugins/plugin-registry.ts')));
const { createSim2RealRouter } = await import(pathToFileURL(path.join(learning, 'server/routes/sim2real-routes.ts')));
const { createSim2RealProject } = await import(pathToFileURL(path.join(learning, 'server/sim2real/sim2real-store.ts')));
const cookie = 'studio-plugin-fixture=owner-a';
const auth = { isMultiUserDeployment: () => true, resolvePrincipal: req => req.headers.cookie === cookie ? { accountId: 'owner-a', roles: ['operator'] } : null, resolveAccessToken: () => null };
await createSim2RealProject({ name: 'owned-demo-project', slug: 'owned-demo', modelIds: [], datasetIds: [] }, 'owner-a');
await createSim2RealProject({ name: 'foreign-demo-project', slug: 'foreign-demo', modelIds: [], datasetIds: [] }, 'owner-b');
const requests = [];
const platformApp = express();
platformApp.use((req, res, next) => { requests.push({ path: req.path, authenticated: req.headers.cookie === cookie }); next(); });
platformApp.use(createSim2RealRouter({ auth }, { prefix: '/api/v1/duck' }));
const platform = platformApp.listen(0, '127.0.0.1');
await new Promise(resolve => platform.once('listening', resolve));
const configured = JSON.parse(fs.readFileSync(path.join(source, '.mcp.json'), 'utf8'));
configured.mcpServers['rdk-learning-platform'].env.RDK_SIM2REAL_MCP_BASE_URL = 'http://127.0.0.1:' + platform.address().port;
fs.writeFileSync(path.join(source, '.mcp.json'), JSON.stringify(configured));
fs.mkdirSync(path.join(process.cwd(), 'plugins/sentinel/.rdstudio-plugin'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'plugins/sentinel/.rdstudio-plugin/plugin.json'), JSON.stringify({ name: 'test-sentinel', description: 'isolated bundled scan root', defaultEnabled: false }));
const app = express(); app.use(express.json()); app.use(createPluginsRouter());
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
let agentApp;
try {
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/plugins/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: source }) });
  const imported = await response.json();
  assert.equal(response.status, 200, JSON.stringify(imported));
  assert.equal(imported.id, 'rdk-robot-learning-platform@user');
  const installed = scanPlugins({ cwd: process.cwd() }).find(item => item.id === imported.id);
  assert.ok(installed, 'native host must discover imported plugin');
  assert.equal(installed.scope, 'user');
  assert.deepEqual(installed.warnings, []);
  agentApp = new MossApp(process.cwd(), {});
  const exportedSkills = fs.readdirSync(path.join(source, 'skills'));
  assert.equal(exportedSkills.length, 10);
  for (const name of exportedSkills) {
    assert.ok(agentApp.listSkills().some(skill => skill.name === name), 'default Agent registry must discover ' + name);
  }
  const loadSkill = createSkillDiscoveryTools({ matchLocal: query => agentApp.skills.matchByText(query), remoteEnabled: false }).find(tool => tool.name === 'load_skill');
  for (const name of ['rdk-platform-setup', 'rdk-platform-training-runs']) {
    const result = await loadSkill.execute({ name }, { workspaceDir: process.cwd(), sessionKey: 'plugin-skill-fixture' });
    assert.ok(String(result).includes('<skill name="' + name + '"'), String(result));
    assert.ok(String(result).includes('rdk_'), 'load_skill must return the actual teaching instructions');
  }
  const resolved = resolvePluginMcpServers({ cwd: process.cwd() }).find(item => item.name === 'rdk-learning-platform');
  assert.ok(resolved, 'enabled native plugin must expose its MCP config');
  const exported = JSON.parse(fs.readFileSync(path.join(source, '.mcp.json'), 'utf8')).mcpServers['rdk-learning-platform'];
  assert.deepEqual(resolved, { name: 'rdk-learning-platform', ...exported });
  const unauthenticated = await fetch('http://127.0.0.1:' + platform.address().port + '/api/v1/duck/projects');
  assert.equal(unauthenticated.status, 401, 'real platform route must require fixture identity');
  const loaded = await loadStudioMcpTools({ ownerKey: 'local:plugin-fixture', networkPolicy: { enabled: true }, includeUserConfigured: true });
  try {
    const tool = loaded.tools.find(item => item.name.endsWith('__rdk_projects_list'));
    assert.ok(tool, 'installed plugin must be consumed by the real Studio Agent MCP loader');
    assert.equal(tool.metadata.permissionBoundary, 'mcp_external', 'native MCP must retain default approval boundary');
    const result = await tool.execute({}, { abortSignal: new AbortController().signal });
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    assert.ok(text.includes('owned-demo-project'), text);
    assert.ok(!text.includes('foreign-demo-project'), 'platform owner filtering must survive native plugin execution');
    assert.ok(requests.some(item => item.path === '/api/v1/duck/projects' && item.authenticated));
  } finally { await loaded.close(); }
  const disabled = await loadStudioMcpTools({ ownerKey: 'local:plugin-fixture', networkPolicy: { enabled: true }, includeUserConfigured: false });
  try { assert.ok(!disabled.tools.some(item => item.name.endsWith('__rdk_projects_list')), 'disabled custom MCP must hide plugin tools'); }
  finally { await disabled.close(); }
  setPluginEnabled(imported.id, false);
  for (const name of exportedSkills) assert.ok(!agentApp.listSkills().some(skill => skill.name === name), 'disabled plugin must hide ' + name);
  setPluginEnabled(imported.id, true);
  process.stdout.write(JSON.stringify({ installed: true, authenticatedToolCall: true, runtimeConsumed: true, config: resolved }) + '\\n');
} finally { agentApp?.destroy(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => platform.close(resolve)); }
// Host modules own background watchers; this isolated import probe is done.
process.exit(0);
`,
  );
  const stdout = execFileSync(
    process.execPath,
    ['--import', pathToFileURL(loader).href, probe, host, pluginDirectory, learningRoot],
    {
      cwd: temp,
      env: {
        ...process.env,
        RDK_STUDIO_HOME: path.join(temp, 'studio-config'),
        RDK_DATA_DIR: path.join(temp, 'studio-data'),
        RDK_STUDIO_DEPLOYMENT_PROFILE: 'local-dev',
        RDK_SIM2REAL_STORAGE_DIR: path.join(temp, 'learning-ledger'),
        RDK_SIM2REAL_MCP_COOKIE: 'parent-cookie-must-not-be-needed',
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.installed, true);
  assert.equal(result.authenticatedToolCall, true);
  assert.equal(result.runtimeConsumed, true);
  return result.config;
}

export async function verifyStudioPlugin({ studioRoot = process.env.RDK_STUDIO_SOURCE_DIR } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-studio-plugin-'));
  try {
    const credentials = path.join(temp, 'private-mcp-auth.json');
    const fixtureCredentials = { RDK_SIM2REAL_MCP_COOKIE: 'studio-plugin-fixture=owner-a' };
    fs.writeFileSync(credentials, JSON.stringify(fixtureCredentials), { mode: 0o600 });
    assert.deepEqual(readStudioPluginCredentialEnv(credentials), fixtureCredentials);
    fs.chmodSync(credentials, 0o644);
    assert.throws(() => readStudioPluginCredentialEnv(credentials), /0600/);
    fs.chmodSync(credentials, 0o600);
    const symlink = path.join(temp, 'auth-link.json');
    fs.symlinkSync(credentials, symlink);
    assert.throws(() => readStudioPluginCredentialEnv(symlink));
    for (const invalid of [
      {},
      { command: 'do-not-execute' },
      { RDK_SIM2REAL_MCP_USERNAME: 'incomplete' },
    ]) {
      fs.writeFileSync(credentials, JSON.stringify(invalid));
      assert.throws(() => readStudioPluginCredentialEnv(credentials));
    }
    fs.writeFileSync(credentials, JSON.stringify(fixtureCredentials));
    const output = path.join(temp, 'exported-plugin');
    exportStudioPlugin({ output, platformUrl: 'https://platform.example.test' });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(output, '.rdstudio-plugin/plugin.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'rdk-robot-learning-platform');
    assert.equal(manifest.mcpServers, './.mcp.json');
    const config = JSON.parse(fs.readFileSync(path.join(output, '.mcp.json'), 'utf8')).mcpServers[
      'rdk-learning-platform'
    ];
    assert.ok(path.isAbsolute(config.command));
    assert.ok(path.isAbsolute(config.args[0]));
    assert.deepEqual(Object.keys(config.env), ['RDK_SIM2REAL_MCP_BASE_URL']);
    assert.throws(() => exportStudioPlugin({ output }), /already exists/);
    assert.throws(
      () =>
        exportStudioPlugin({
          output: path.join(temp, 'unsafe'),
          platformUrl: 'https://user:secret@example.test',
        }),
      /without credentials/,
    );
    const foreignCwd = path.join(temp, 'unrelated-cwd');
    fs.mkdirSync(foreignCwd);
    const catalog = await stdioCatalog(config, foreignCwd);
    const names = new Set(catalog.tools.map((tool) => tool.name));
    for (const name of [
      'rdk_platform_status',
      'rdk_projects_list',
      'rdk_runs_replay',
      'rdk_training_submit',
      'rdk_training_status',
    ])
      assert.ok(names.has(name), name);
    assert.deepEqual(
      catalog.tools,
      JSON.parse(
        fs.readFileSync(
          path.join(
            learningRoot,
            'plugins/rdk-robot-learning-platform/references/tool-catalog.json',
          ),
          'utf8',
        ),
      ),
      'Native connector must preserve the full published tool schema and safety annotations',
    );
    if (studioRoot) {
      const authenticatedOutput = path.join(temp, 'authenticated-plugin');
      exportStudioPlugin({
        output: authenticatedOutput,
        platformUrl: 'https://platform.example.test',
        credentialsFile: credentials,
      });
      assert.ok(
        !fs
          .readFileSync(path.join(authenticatedOutput, '.mcp.json'), 'utf8')
          .includes('studio-plugin-fixture=owner-a'),
      );
      const installedConfig = await verifyNativeHost(studioRoot, authenticatedOutput, temp);
      // The imported launcher must work even if the export folder is gone.
      fs.rmSync(output, { recursive: true });
      fs.rmSync(authenticatedOutput, { recursive: true });
      const installedCatalog = await stdioCatalog(installedConfig, foreignCwd);
      assert.deepEqual(installedCatalog.tools, catalog.tools);
    }
    return {
      ok: true,
      tools: catalog.tools.length,
      coldStart: true,
      nativeImport: Boolean(studioRoot),
      authenticatedRuntimeCall: Boolean(studioRoot),
      nativeSkillsLoaded: Boolean(studioRoot),
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--studio-root')) {
    process.stderr.write(
      'usage: node scripts/verify-studio-plugin.mjs [--studio-root <Studio checkout>]\n',
    );
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(
        '[studio-plugin] PASS ' +
          JSON.stringify(await verifyStudioPlugin({ studioRoot: args[1] })) +
          '\n',
      );
    } catch (error) {
      process.stderr.write(
        '[studio-plugin] FAIL ' + (error instanceof Error ? error.stack : String(error)) + '\n',
      );
      process.exitCode = 1;
    }
  }
}
