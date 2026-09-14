#!/usr/bin/env node

/**
 * Unified read-only onboarding for a GPU server + OriginBot.
 * It composes the bounded server and board probes; it never installs packages,
 * changes switches, uploads artifacts, or sends motion commands.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');
const env = {
  ...process.env,
  RDK_ACCEPTANCE_TIMEOUT_MS: process.env.RDK_ACCEPTANCE_TIMEOUT_MS || '8000',
};

function run(script, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 2_000_000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || '');
  } catch {
    // The probe output is optional; the caller still receives the raw streams.
  }
  return { exitCode: result.status ?? 1, parsed, stdout: result.stdout, stderr: result.stderr };
}

function main() {
  const server = run('onboard-gpu-server.mjs', [
    '--host',
    process.env.RDK_GPU_HOST || '',
    '--port',
    process.env.RDK_GPU_PORT || '22',
    '--user',
    process.env.RDK_GPU_USER || '',
    '--dir',
    process.env.RDK_GPU_DIR || '~/rdk-sim2real',
    '--json',
  ]);
  const device = run('accept-new-device.mjs', ['--json', '--allow-missing']);
  const result = {
    schemaVersion: 1,
    kind: 'stack-onboarding',
    readOnly: true,
    motionCommandsSent: 0,
    server: server.parsed || { ok: false, error: server.stderr?.trim() || 'server probe failed' },
    device: device.parsed || { ok: false, error: device.stderr?.trim() || 'device probe failed' },
    ok: Boolean(server.parsed?.ok && device.parsed?.ok),
    next:
      server.parsed?.ok && device.parsed?.ok
        ? 'ready-for-data-training-compile-load-gated-motion'
        : 'fix-blocked-checks-before-training-or-deployment',
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Stack onboarding: ${result.ok ? 'READY' : 'BLOCKED'} (read-only)`);
    console.log(`  server: ${result.server.ok ? 'PASS' : 'BLOCKED'}`);
    console.log(`  OriginBot: ${result.device.ok ? 'PASS' : 'BLOCKED'}`);
    console.log(`  next: ${result.next}`);
    console.log('  motion commands sent: 0');
  }
  process.exitCode = result.ok ? 0 : 1;
}

main();
