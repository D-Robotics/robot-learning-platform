#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readStudioPluginCredentialEnv(file) {
  if (!file) return {};
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > 65_536 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error(
        'MCP credentials file must be an owned regular file with mode 0600 and size at most 64 KiB.',
      );
    }
    const bytes = Buffer.alloc(65_537);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > 65_536) throw new Error('MCP credentials file exceeds 64 KiB.');
    let source;
    try {
      source = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    } catch {
      throw new Error('MCP credentials file must contain a JSON object.');
    }
    const allowed = new Set([
      'RDK_SIM2REAL_MCP_COOKIE',
      'RDK_SIM2REAL_MCP_USERNAME',
      'RDK_SIM2REAL_MCP_PASSWORD',
    ]);
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      Object.keys(source).length === 0 ||
      Object.entries(source).some(
        ([key, value]) => !allowed.has(key) || typeof value !== 'string' || !value,
      )
    ) {
      throw new Error(
        'MCP credentials file accepts only non-empty cookie or username/password strings.',
      );
    }
    if (Boolean(source.RDK_SIM2REAL_MCP_USERNAME) !== Boolean(source.RDK_SIM2REAL_MCP_PASSWORD)) {
      throw new Error('MCP username and password must be configured together.');
    }
    if (source.RDK_SIM2REAL_MCP_COOKIE && /[\r\n\0]/.test(source.RDK_SIM2REAL_MCP_COOKIE)) {
      throw new Error('MCP cookie must be a single header value.');
    }
    return source;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function resolveStudioPluginRuntime(runtimeRoot = root) {
  const source = path.join(runtimeRoot, 'services/duck-lab-mcp/server.ts');
  const compiled = path.join(runtimeRoot, 'dist-server/services/duck-lab-mcp/server.js');
  if (fs.existsSync(source)) {
    try {
      const require = createRequire(path.join(runtimeRoot, 'package.json'));
      const loader = require.resolve('tsx/esm');
      return {
        cwd: runtimeRoot,
        mode: 'source',
        args: ['--import', pathToFileURL(loader).href, source],
      };
    } catch {
      // A runtime without development dependencies can use its compiled entry.
    }
  }
  if (fs.existsSync(compiled)) return { cwd: runtimeRoot, mode: 'compiled', args: [compiled] };
  throw new Error(
    'Duck Lab MCP runtime is unavailable; run npm ci or npm run build in the learning-platform repository.',
  );
}

export function startStudioPluginMcp() {
  const runtime = resolveStudioPluginRuntime();
  const credentials = readStudioPluginCredentialEnv(process.env.RDK_SIM2REAL_MCP_CREDENTIALS_FILE);
  if (process.argv.includes('--check')) {
    process.stdout.write(JSON.stringify({ ok: true, mode: runtime.mode }) + '\n');
    return;
  }
  const child = spawn(process.execPath, runtime.args, {
    cwd: runtime.cwd,
    env: { ...process.env, ...credentials },
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.once('error', (error) => {
    process.stderr.write(`[studio-plugin] MCP launch failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    startStudioPluginMcp();
  } catch (error) {
    process.stderr.write(
      `[studio-plugin] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
