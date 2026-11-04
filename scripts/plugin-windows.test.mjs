import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
