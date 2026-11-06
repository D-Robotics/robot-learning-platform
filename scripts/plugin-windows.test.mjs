import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectMcp } from '../plugins/rdk-robot-learning-platform/scripts/experience.mjs';
import {
  windowsBootstrap,
  protectWindowsBinding,
  unprotectWindowsBinding,
} from '../plugins/rdk-robot-learning-platform/windows-binding.mjs';
test('Windows launch selects the authenticated workflow, preserving paths with spaces and Unicode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk Windows 插件 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'mcp'));
  fs.writeFileSync(
    path.join(root, 'windows-binding.mjs'),
    `export function readWindowsBinding(file,root){return {root,platformUrl:'https://studio.example/robotics-learning'}}`,
  );
  fs.writeFileSync(
    path.join(root, 'scripts/experience-mcp.mjs'),
    `export async function main(){console.log(JSON.stringify({entry:'authenticated-workflow',origin:process.env.RDK_SIM2REAL_MCP_BASE_URL,hostSessionPreserved:process.env.RDK_STUDIO_LOGIN_SESSION==='fixture-current-session',stalePasswordRemoved:!process.env.RDK_SIM2REAL_MCP_PASSWORD}))}`,
  );
  fs.writeFileSync(
    path.join(root, 'mcp/bundle.mjs'),
    `throw Error('Windows bypassed login and workflow tools')`,
  );
  const code = windowsBootstrap(root, path.join(root, 'private binding.dpapi'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      RDK_STUDIO_LOGIN_SESSION: 'fixture-current-session',
      RDK_SIM2REAL_MCP_PASSWORD: 'stale-fixture-password',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    entry: 'authenticated-workflow',
    origin: 'https://studio.example/robotics-learning',
    hostSessionPreserved: true,
    stalePasswordRemoved: true,
  });
});
test('Windows DPAPI contract is CurrentUser, stdin-only, and cannot decrypt under another installation', () => {
  const config = {
    root: 'C:\\课程 插件',
    platformUrl: 'https://studio.example/robotics-learning',
    credentials: { RDK_SIM2REAL_MCP_COOKIE: 'private-fixture' },
  };
  const cipher = Buffer.from('encrypted-fixture').toString('base64');
  const calls = [];
  const run = (exe, args, options) => {
    calls.push({ exe, args, options });
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /DataProtectionScope\]::CurrentUser/);
    assert.match(exe, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.equal(options.windowsHide, true);
    assert.ok(!JSON.stringify(args).includes('private-fixture'));
    return {
      status: 0,
      stdout: script.includes('::Protect(')
        ? cipher
        : Buffer.from(JSON.stringify(config)).toString('base64'),
    };
  };
  const opts = { platform: 'win32', run };
  assert.equal(protectWindowsBinding(config, opts), cipher);
  assert.deepEqual(unprotectWindowsBinding(cipher, config.root, opts), config);
  assert.throws(() => unprotectWindowsBinding(cipher, 'C:\\another', opts), /installation/);
  assert.ok(Buffer.from(calls[0].options.input, 'base64').toString().includes('private-fixture'));
  assert.throws(
    () => protectWindowsBinding(config, { platform: 'win32', run: () => ({ status: 1 }) }),
    /DPAPI failed/,
  );
});

test(
  'Windows runs the Qoder CMD installer and starts the configured MCP from its import ZIP',
  {
    skip: process.platform !== 'win32',
    timeout: 60000,
  },
  async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-win-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const root = path.join(temp, '课程 插件');
    const source = fileURLToPath(
      new URL('../plugins/rdk-robot-learning-platform/', import.meta.url),
    );
    fs.cpSync(source, root, { recursive: true });
    // Retained distributions supply this file. The test fixture supplies the
    // same runtime contract without embedding the retained bundle in source.
    fs.writeFileSync(
      path.join(root, 'runtime-requirements.json'),
      JSON.stringify({ node: '^22.22.2 || ^24.15.0 || >=26.0.0' }),
    );
    fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'mcp/bundle.mjs'),
      `
    import { createInterface } from 'node:readline';
    export async function main() {
      for await (const line of createInterface({input:process.stdin})) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        const result = request.method === 'tools/list' ? { tools: [] } : { capabilities: { tools: {} } };
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
      }
    }
  `,
    );
    fs.writeFileSync(
      path.join(root, 'scripts/start-core-mcp.mjs'),
      "import { main } from '../mcp/bundle.mjs'; await main();",
    );
    const installation = spawnSync('cmd.exe', ['/d', '/c', 'setup-qoder-windows.cmd'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
      },
      input: '\r\n',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25000,
    });
    assert.ifError(installation.error);
    assert.equal(installation.status, 0, installation.stdout + installation.stderr);
    const archive = path.join(root, 'Qoder本机导入包.zip');
    const extracted = path.join(temp, '导入后');
    const unzip = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:RDK_TEST_ZIP -DestinationPath $env:RDK_TEST_EXTRACT',
      ],
      {
        env: { ...process.env, RDK_TEST_ZIP: archive, RDK_TEST_EXTRACT: extracted },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      },
    );
    assert.ifError(unzip.error);
    assert.equal(unzip.status, 0, unzip.stderr);
    const importedRoot = path.join(extracted, 'rdk-robot-learning-platform');
    const config = JSON.parse(fs.readFileSync(path.join(importedRoot, '.mcp.json'), 'utf8'));
    const entry = config.mcpServers['rdk-learning-platform'];
    assert.equal(entry.args[0], path.join(root, 'scripts/experience-mcp.mjs'));
    assert.equal(entry.env.RDK_STUDIO_INHERIT_LOGIN, '0');
    assert.ok(!JSON.stringify(entry).includes('RDK_SIM2REAL_MCP_COOKIE'));
    const client = connectMcp({
      ...entry,
      env: { ...process.env, ...entry.env },
      timeoutMs: 10000,
    });
    try {
      await client.request('initialize', {
        clientInfo: { name: 'Qoder', version: 'windows-fixture' },
      });
      const catalog = await client.request('tools/list');
      assert.ok(catalog.tools.some((tool) => tool.name === 'rdk_workshop'));
      assert.ok(catalog.tools.some((tool) => tool.name === 'rdk_auth_login'));
    } finally {
      await client.close();
    }
  },
);

test(
  'Windows can protect and reopen a real current-user DPAPI binding',
  {
    skip: process.platform !== 'win32',
    timeout: 30000,
  },
  () => {
    const config = {
      root: 'C:\\课程 插件',
      platformUrl: 'https://studio.example/robotics-learning',
      credentials: { RDK_SIM2REAL_MCP_COOKIE: 'fixture-cookie' },
    };
    const cipher = protectWindowsBinding(config);
    assert.ok(!Buffer.from(cipher, 'base64').includes(Buffer.from('fixture-cookie')));
    assert.deepEqual(unprotectWindowsBinding(cipher, config.root), config);
  },
);
