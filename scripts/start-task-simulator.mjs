#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { root: defaultRoot, host: '127.0.0.1', port: '18100', check: false };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--help') {
    console.log(
      'Usage: node scripts/start-task-simulator.mjs [--root directory] [--host 127.0.0.1] [--port 18100] [--check]\nPython override: RDK_SIM2REAL_PYTHON',
    );
    process.exit(0);
  }
  if (flag === '--check') {
    options.check = true;
    continue;
  }
  const key = { '--root': 'root', '--host': 'host', '--port': 'port' }[flag];
  if (!key || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    console.error(`[task-simulator] Unknown or incomplete option: ${flag}`);
    process.exit(1);
  }
  options[key] = process.argv[++index];
}
const root = path.resolve(options.root);
const service = path.join(root, 'services/mujoco-web');
const serviceEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !options.host.trim()) {
  console.error(
    '[task-simulator] --port must be an integer from 1 to 65535 and --host must be nonempty',
  );
  process.exit(1);
}
if (
  !existsSync(path.join(service, 'task_simulation.py')) ||
  !existsSync(path.join(service, 'app.py'))
) {
  console.error(
    '[task-simulator] Service files are missing; --root must point to the repository or a packaged task simulator',
  );
  process.exit(1);
}

// Probe the actual service and compile every declared task, rather than
// treating a Python version or importable MuJoCo package as readiness.
const preflight = `
import json, sys
sys.path.insert(0, sys.argv[1])
import uvicorn, mujoco, numpy, PIL
import app
from task_simulation import TASKS, _contract, _make_env
missing = [task for task in TASKS if not _contract(task)["available"]]
if missing:
    raise RuntimeError("Task engine modules are missing: " + ", ".join(missing))
for task in TASKS:
    env = _make_env(task, 20260922)
    env.reset()
print(json.dumps({"ok": True, "taskScenes": len(TASKS), "mujoco": mujoco.__version__}))
`;
const override = String(process.env.RDK_SIM2REAL_PYTHON || '').trim();
const candidates = override
  ? [override]
  : [path.join(root, '.venv/bin/python'), path.join(service, '.venv/bin/python'), 'python3'];
let python;
let lastFailure = '';
for (const candidate of candidates) {
  if (candidate !== 'python3' && !existsSync(candidate) && !override) continue;
  const probe = spawnSync(candidate, ['-c', preflight, service], {
    cwd: root,
    env: serviceEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (!probe.error && probe.status === 0) {
    python = candidate;
    console.log(`[task-simulator] ${probe.stdout.trim()}`);
    break;
  }
  lastFailure = probe.error?.message || probe.stderr.trim().split('\n').slice(-3).join('\n');
}
if (!python) {
  console.error(
    `[task-simulator] Python preflight failed: ${lastFailure}\nInstall the pinned stack with Python 3.12 or newer:\n  python3.12 -m venv .venv\n  .venv/bin/python -m pip install -r services/mujoco-web/requirements.txt`,
  );
  process.exit(1);
}
if (options.check) process.exit(0);

const displayHost = options.host.includes(':') ? `[${options.host}]` : options.host;
console.log(
  `[task-simulator] Starting http://${displayHost}:${port}; set RDK_SIM2REAL_MUJOCO_WEB_URL to this origin before starting the workbench`,
);
const child = spawn(
  python,
  [
    '-m',
    'uvicorn',
    '--app-dir',
    service,
    'app:app',
    '--host',
    options.host,
    '--port',
    String(port),
  ],
  {
    cwd: root,
    env: serviceEnv,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  },
);
let stopping = false;
child.once('error', (error) => {
  console.error(`[task-simulator] ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
  });
