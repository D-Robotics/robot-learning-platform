#!/usr/bin/env node
/** Probe the shipped Windows/macOS launchers with an isolated Studio import. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  connectMcp,
  readToolResult,
} from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';

const [
  archiveArg = process.env.RDK_UNIVERSAL_ARCHIVE,
  expectedTarget = process.env.RDK_UNIVERSAL_TARGET,
] = process.argv.slice(2);
const target = process.platform + '-' + process.arch;
assert.ok(
  archiveArg && expectedTarget === target && ['win32-x64', 'darwin-arm64'].includes(target),
  'Usage: node scripts/verify-universal-studio-bundle.mjs <zip> <native-platform-architecture>',
);
const archive = path.resolve(archiveArg);
const windows = process.platform === 'win32';
const pluginName = 'rdk-robot-learning-platform';

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    ...options,
  });
  assert.ifError(result.error);
  return result;
}

function requireExit(result, status) {
  assert.equal(result.status, status, result.stdout + result.stderr);
  return result.stdout;
}

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-universal-studio-')));
const data = path.join(fixture, 'Studio 数据');
const download = path.join(fixture, '解压 下载');
const unpacked = path.join(download, pluginName);
const imported = path.join(fixture, '已导入 插件', pluginName);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(PATH$|RDK_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i.test(key),
  ),
);
env.PATH = windows
  ? ['System32', path.join('System32', 'WindowsPowerShell', 'v1.0')]
      .map((directory) => path.join(process.env.SystemRoot, directory))
      .join(path.delimiter)
  : '/usr/bin:/bin';
env.RDK_DATA_DIR = data;
env.CI = 'true';

function launchInstaller() {
  const cwd = unpacked;
  return windows
    ? run('cmd.exe', ['/d', '/c', 'setup-studio-windows.cmd'], { cwd, env, input: '\r\n' })
    : run('./setup-studio-macos.command', [], { cwd, env, input: '' });
}

const requests = [];
const server = createServer((request, response) => {
  requests.push(request.method);
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"UNEXPECTED_FIXTURE_REQUEST"}');
});
try {
  fs.mkdirSync(data);
  fs.mkdirSync(download);
  const extracted = windows
    ? run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:RDK_UNIVERSAL_FIXTURE_ZIP, $env:RDK_UNIVERSAL_FIXTURE_DOWNLOAD)",
        ],
        {
          env: {
            ...env,
            RDK_UNIVERSAL_FIXTURE_ZIP: archive,
            RDK_UNIVERSAL_FIXTURE_DOWNLOAD: download,
          },
        },
      )
    : run('/usr/bin/unzip', ['-q', archive, '-d', download]);
  requireExit(extracted, 0);
  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const { version } = readJson(path.join(unpacked, 'plugin.json'));
  assert.deepEqual(readJson(path.join(unpacked, '.mcp.json')).mcpServers, {});
  assert.match(requireExit(launchInstaller(), 2), /"installationState":"requires-action"/);
  assert.ok(!fs.existsSync(path.join(data, 'mcp.json')), 'No connection before host import');

  // The host importer copies the release and records its owned path separately.
  fs.cpSync(unpacked, imported, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  fs.writeFileSync(
    path.join(data, 'plugins-registry.json'),
    JSON.stringify({
      plugins: { [pluginName + '@user']: { enabled: true, version, installPath: imported } },
    }),
  );
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const platformUrl = 'http://127.0.0.1:' + server.address().port + '/robotics-learning';
  const configuration = path.join(data, 'mcp.json');
  fs.writeFileSync(
    configuration,
    JSON.stringify({
      mcpServers: { [pluginName]: { env: { RDK_SIM2REAL_MCP_BASE_URL: platformUrl } } },
    }),
  );
  assert.match(requireExit(launchInstaller(), 0), /"installationState":"installed"/);
  const connections = readJson(configuration).mcpServers;
  assert.deepEqual(Object.keys(connections), [pluginName]);
  const entry = connections[pluginName];
  const binary = windows ? 'node.exe' : 'node';
  const runtime = path.join(imported, 'mcp', 'runtime', target, binary);
  const { nodeVersion } = readJson(
    path.join(imported, 'mcp', 'runtime', target, 'provenance.json'),
  );
  assert.equal(fs.realpathSync(entry.command), fs.realpathSync(runtime));
  assert.deepEqual(entry.args, [path.join(imported, 'scripts', 'experience-mcp.mjs')]);
  assert.equal(entry.permissions.tools.rdk_workshop, 'readonly');
  const declarations = readJson(path.join(imported, '.mcp.json')).mcpServers;
  assert.equal(declarations[pluginName].command, './mcp/runtime/' + target + '/' + binary);
  assert.deepEqual(declarations[pluginName].args, ['./scripts/experience-mcp.mjs']);

  // Simulate a learner moving the downloaded folder after installation.
  fs.renameSync(download, path.join(fixture, '已移动 下载'));
  assert.equal(
    requireExit(run(entry.command, ['-p', 'process.platform+"-"+process.arch'], { env }), 0).trim(),
    target,
  );
  const client = connectMcp({ ...entry, env: { ...env, ...entry.env }, timeoutMs: 15_000 });
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'Studio universal installer fixture', version: '1.0.0' },
    });
    assert.equal(init.serverInfo.version, version);
    client.notify('notifications/initialized');
    const { tools } = await client.request('tools/list');
    assert.ok(tools.some(({ name }) => name === 'rdk_workshop'));
    assert.ok(tools.some(({ name }) => name === 'rdk_auth_login'));
    const status = readToolResult(
      await client.request('tools/call', { name: 'rdk_plugin_status', arguments: {} }),
    );
    assert.equal(status.pluginRuntime.version, version);
    assert.equal(status.pluginRuntime.loadedSourcesMatch, true);
    const preview = readToolResult(
      await client.request('tools/call', { name: 'rdk_workshop', arguments: { intent: 'start' } }),
    );
    assert.equal(preview.stage, 'preview');
    assert.equal(preview.submission.training, false);
    assert.equal(new URL(preview.links.workshop).origin, new URL(platformUrl).origin);
    assert.ok(
      requests.every((method) => method === 'GET'),
      'Installer preview must not write',
    );
    console.log(
      JSON.stringify({ target, nodeVersion, version, tools: tools.length, installedMcp: true }),
    );
  } finally {
    await client.close();
  }
} finally {
  server.close();
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
}
