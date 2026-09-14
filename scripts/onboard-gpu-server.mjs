#!/usr/bin/env node

/**
 * Bounded, read-only onboarding probe for a remote GPU training server.
 *
 * This is intentionally separate from gpu-deploy.mjs: onboarding must be safe
 * to run from an agent and must not execute arbitrary user-provided shell.
 * Every remote command below is a fixed probe; user values are passed only as
 * validated SSH coordinates or as a safely quoted, validated workspace path.
 *
 * Usage:
 *   node scripts/onboard-gpu-server.mjs --host gpu-host.example.internal --user robot --json
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DIR = '~/rdk-sim2real';
const MAX_OUTPUT = 12_000;

function validHost(value) {
  const host = String(value ?? '').trim();
  if (!host || host.length > 253) return false;
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) ||
    (/^\[?[0-9a-fA-F:]+\]?$/.test(host) && host.includes(':'))
  );
}

function validUser(value) {
  return /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(String(value ?? '').trim());
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validRemoteDir(value) {
  const dir = String(value ?? '').trim();
  // Permit a conventional absolute or ~/ path, but reject shell metacharacters.
  return dir.length > 0 && dir.length <= 240 && /^(?:~\/|\/)[a-zA-Z0-9._/@+-]+$/.test(dir);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function parseArgs(argv, env = process.env) {
  const flags = {
    host: env.RDK_GPU_HOST || '',
    port: env.RDK_GPU_PORT || '22',
    user: env.RDK_GPU_USER || '',
    dir: env.RDK_GPU_DIR || DEFAULT_DIR,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--host') ((flags.host = next ?? ''), (i += 1));
    else if (arg === '--port') ((flags.port = next ?? ''), (i += 1));
    else if (arg === '--user') ((flags.user = next ?? ''), (i += 1));
    else if (arg === '--dir') ((flags.dir = next ?? ''), (i += 1));
    else if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (
    !flags.help &&
    (!validHost(flags.host) ||
      !validUser(flags.user) ||
      !validPort(flags.port) ||
      !validRemoteDir(flags.dir))
  ) {
    throw new Error(
      'invalid --host/--user/--port/--dir; values are validated and shell metacharacters are rejected',
    );
  }
  flags.port = Number(flags.port);
  return flags;
}

function probeCommand(flags, command, timeout = 12_000) {
  const target = `${flags.user}@${flags.host}`;
  const args = [
    '-o',
    'PreferredAuthentications=publickey',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    '-p',
    String(flags.port),
    target,
    command,
  ];
  const result = spawnSync('ssh', args, { encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT });
  const stdout = String(result.stdout ?? '')
    .slice(0, MAX_OUTPUT)
    .trim();
  const stderr = String(result.stderr ?? '')
    .slice(0, MAX_OUTPUT)
    .trim();
  return {
    ok: result.status === 0,
    exitCode: result.status,
    timedOut: Boolean(result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM'),
    stdout,
    stderr,
  };
}

export function runOnboarding(flags, runner = probeCommand) {
  const run = (name, command, parse) => {
    const probe = runner(flags, command);
    return {
      name,
      ok: probe.ok,
      ...((parse && parse(probe)) || { detail: probe.stdout || probe.stderr }),
      exitCode: probe.exitCode,
      timedOut: probe.timedOut,
    };
  };
  const remoteDir = shellQuote(flags.dir);
  const checks = [
    run('ssh', 'printf %s ready', (p) => ({
      detail: p.stdout,
      error: p.ok ? undefined : p.stderr || 'ssh probe failed',
    })),
    run(
      'gpu',
      'command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader',
      (p) => ({ detail: p.stdout, error: p.ok ? undefined : p.stderr || 'nvidia-smi unavailable' }),
    ),
    run('python', 'python3 -c "import sys; print(sys.version.split()[0])"', (p) => ({
      detail: p.stdout,
      error: p.ok ? undefined : p.stderr || 'python3 unavailable',
    })),
    run('workspace', `test -x ${remoteDir}/.venv/bin/python`, (p) => ({
      detail: p.ok ? `${flags.dir}/.venv/bin/python` : 'missing .venv/bin/python',
    })),
    run(
      'worker',
      `python3 -c "import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:19091/healthz', timeout=3); print(r.read().decode())"`,
      (p) => ({
        detail: p.stdout,
        error: p.ok ? undefined : p.stderr || 'worker healthz unavailable',
      }),
    ),
    run(
      'hbdk',
      `if test -x ${remoteDir}/.venv/bin/hb_mapper; then ${remoteDir}/.venv/bin/hb_mapper --version; elif command -v hb_mapper >/dev/null; then hb_mapper --version; else exit 127; fi`,
      (p) => ({ detail: p.stdout, error: p.ok ? undefined : p.stderr || 'hb_mapper unavailable' }),
    ),
  ];
  const ok = checks.every((item) => item.ok);
  return {
    schemaVersion: 1,
    kind: 'gpu-server-onboarding',
    host: flags.host,
    port: flags.port,
    user: flags.user,
    workspace: flags.dir,
    readOnly: true,
    ok,
    checks,
    next: ok ? 'server-ready-for-training-and-compilation' : 'fix-failed-checks-before-training',
    generatedAt: new Date().toISOString(),
  };
}

function printHuman(result) {
  console.log(
    `GPU server onboarding: ${result.ok ? 'READY' : 'BLOCKED'} (${result.user}@${result.host}:${result.port})`,
  );
  for (const check of result.checks)
    console.log(
      `  ${check.ok ? '✓' : '✗'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
    );
  console.log(result.next);
}

async function main() {
  try {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) {
      console.log(
        'usage: node scripts/onboard-gpu-server.mjs --host <host> --user <user> [--port 22] [--dir ~/rdk-sim2real] [--json]',
      );
      return;
    }
    const result = runOnboarding(flags);
    if (flags.json) console.log(JSON.stringify(result));
    else printHuman(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
