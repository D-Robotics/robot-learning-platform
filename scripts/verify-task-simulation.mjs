#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const override = String(process.env.RDK_SIM2REAL_PYTHON || '').trim();
const candidates = override
  ? [override]
  : [
      path.join(root, '.venv/bin/python'),
      path.join(root, 'services/mujoco-web/.venv/bin/python'),
      'python3',
    ];
let python;
for (const candidate of candidates) {
  if (!override && candidate !== 'python3' && !existsSync(candidate)) continue;
  const check = spawnSync(
    candidate,
    ['-c', 'import sys; assert sys.version_info >= (3, 10); import mujoco, fastapi, httpx'],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  if (!check.error && check.status === 0) {
    python = candidate;
    break;
  }
}
if (!python) {
  console.error(
    '[task-simulation] A working Python environment with MuJoCo, FastAPI and HTTPX is required.\nInstall services/mujoco-web/requirements-test.txt into .venv, or set RDK_SIM2REAL_PYTHON.',
  );
  process.exit(1);
}
const result = spawnSync(
  python,
  ['-m', 'unittest', 'discover', '-s', 'services/mujoco-web', '-p', 'test_*.py', '-v'],
  {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: 'inherit',
    timeout: 120_000,
  },
);
if (result.error) console.error('[task-simulation]', result.error.message);
process.exit(result.status ?? 1);
