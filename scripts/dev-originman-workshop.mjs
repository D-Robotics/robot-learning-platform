#!/usr/bin/env node
/** Own isolated local workbench + real CPU worker; never attaches a device. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, openSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
}
if (args.includes('--help')) {
  console.log(
    'node scripts/dev-originman-workshop.mjs --scene <scene.xml> --python <python> --data-dir <new-directory> [--font <CJK font>] [--resume]',
  );
  process.exit(0);
}
const scene = path.resolve(option('scene', ''));
const python = path.resolve(option('python', path.join(root, '.eval-venv/bin/python')));
if (!existsSync(python))
  throw new Error('A Python environment with OriginMan dependencies is required via --python');
const data = path.resolve(option('data-dir', `artifacts/originman-workbench-${Date.now()}`));
if (!args.includes('--scene') || !existsSync(scene))
  throw new Error('Adapted caller-owned --scene is required');
if (args.includes('--resume')) {
  if (!existsSync(path.join(data, 'instance.json')))
    throw new Error('--resume only accepts a previous owned workshop directory');
} else mkdirSync(data, { recursive: false, mode: 0o700 });
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const webPort = await freePort(),
  workerPort = await freePort();
const token = randomBytes(36).toString('base64url');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  RDK_SIM2REAL_STORAGE_DIR: path.join(data, 'platform'),
  RDK_SIM2REAL_BIND_HOST: '127.0.0.1',
  RDK_SIM2REAL_DEPLOYMENT: 'local',
  RDK_SIM2REAL_SSO_REQUIRED: '0',
  RDK_SIM2REAL_SSO_ENABLED: '0',
  RDK_SIM2REAL_AUTH_MODE: '',
  RDK_SIM2REAL_REQUIRE_MICRODUCK: '0',
  RDK_SIM2REAL_PORT: String(webPort),
  RDK_SIM2REAL_LOCAL_RUNNER_URL: `http://127.0.0.1:${workerPort}/train`,
  RDK_SIM2REAL_LOCAL_RUNNER_MODE: 'real',
  RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: token,
  RDK_SIM2REAL_LOCAL_WORKER_PORT: String(workerPort),
  RDK_SIM2REAL_LOCAL_WORKER_HOST: '127.0.0.1',
  RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR: path.join(data, 'worker'),
  RDK_SIM2REAL_TRAIN_ENGINES_JSON: JSON.stringify({
    'originman-recovery': {
      executable: path.resolve(python),
      args: [path.join(root, 'engines/originman-straight/workshop_adapter.py')],
    },
  }),
  ORIGINMAN_SCENE: scene,
  ...(option('font') ? { ORIGINMAN_RENDER_FONT: path.resolve(option('font')) } : {}),
};
// This fixture owns fresh storage and local authentication; never reconfigures the user's running platform.
delete env.RDK_STUDIO_DEPLOYMENT_PROFILE;
delete env.RDK_SIM2REAL_BOARD_AGENT_URL;
delete env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const worker = spawn(
  process.execPath,
  [path.join(root, 'services/sim2real-web/local-training-worker.mjs')],
  {
    cwd: root,
    env,
    stdio: [
      'ignore',
      openSync(path.join(data, 'worker.log'), 'a'),
      openSync(path.join(data, 'worker-error.log'), 'a'),
    ],
  },
);
const web = spawn(
  process.execPath,
  ['--import', 'tsx/esm', path.join(root, 'services/sim2real-web/server.ts')],
  {
    cwd: root,
    env,
    stdio: [
      'ignore',
      openSync(path.join(data, 'web.log'), 'a'),
      openSync(path.join(data, 'web-error.log'), 'a'),
    ],
  },
);
const children = [worker, web];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children)
  child.on('error', (error) => {
    console.error(error.message);
    stop();
    process.exitCode = 1;
  });
for (const child of children)
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`Owned workshop service exited (${code}); see isolated logs.`);
      stop();
      process.exitCode = 1;
    }
  });
const url = `http://127.0.0.1:${webPort}`;
let ready = false;
for (let i = 0; i < 100 && !stopping; i++) {
  try {
    const response = await fetch(`${url}/readyz`);
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    /* startup */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!ready) {
  stop();
  throw new Error('Owned workshop workbench did not become ready; see isolated logs');
}
const info = {
  url: `${url}/?robot=originman#train/submit`,
  storage: data,
  webPid: web.pid,
  workerPid: worker.pid,
  physics: 'real CPU MuJoCo',
  hardwareCommands: false,
};
writeFileSync(path.join(data, 'instance.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
