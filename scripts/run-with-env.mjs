#!/usr/bin/env node

/**
 * Small, dependency-free dotenv loader used by the standalone examples.
 *
 * We intentionally keep environment loading outside the product runtime: an
 * existing process environment always wins, values are never logged, and the
 * loader only reads the explicitly selected file (or `.env` in the current
 * project). This keeps `npm run dev:*` predictable without pulling a second
 * configuration library into the public distribution.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;
  const key = match[1];
  let value = match[2].trim();
  const doubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  const singleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
  if (doubleQuoted || singleQuoted) {
    value = value.slice(1, -1);
    if (doubleQuoted) {
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  } else {
    // Match common dotenv behavior for an inline comment after whitespace.
    value = value.replace(/\s+#.*$/, '').trim();
  }
  return [key, value];
}

function loadEnv(file) {
  if (!file || !fs.existsSync(file)) return;
  const contents = fs.readFileSync(file, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/run-with-env.mjs <command> [args...]');
  process.exit(64);
}

const envFile = process.env.RDK_SIM2REAL_ENV_FILE || path.join(process.cwd(), '.env');
loadEnv(path.resolve(envFile));

const child = spawn(args[0], args.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
child.once('error', (error) => {
  console.error('[run-with-env] failed to start command:', error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
