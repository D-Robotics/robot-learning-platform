#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'examples/rdk-duck-policy-manifest.json');
const fetchFn = globalThis.fetch.bind(globalThis);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function buildEnv(overrides = {}) {
  const environment = { ...process.env };
  // Do not let a developer's real deployment settings or credentials bleed
  // into the disposable smoke services.  The test supplies every product
  // setting it needs below; PATH/Node and ordinary CI variables remain.
  for (const key of Object.keys(environment)) {
    if (/^(?:RDK_SIM2REAL|RDK_STUDIO|SSO)_/i.test(key)) delete environment[key];
  }
  return {
    ...environment,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...overrides,
  };
}

function spawnService(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: buildEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${label}] ${String(chunk)}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${label}] ${String(chunk)}`);
  });
  child.once('error', (error) => {
    process.stderr.write(`[${label}] process error: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  });
  child.once('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      process.stderr.write(`[${label}] exited unexpectedly: code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    }
  });
  return child;
}

async function terminate(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timeout = sleep(5_000).then(() => 'timeout');
  const result = await Promise.race([exited, timeout]);
  if (result === 'timeout' && child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
  }
}

async function fetchJson(url, init) {
  const response = await fetchFn(url, init);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response from ${url}: ${text.slice(0, 500)}`);
    }
  }
  return { response, body, text };
}

async function waitForJson(url, { expectStatus = 200, timeoutMs = 30_000, label = url, predicate } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(url, { headers: { accept: 'application/json' } });
      if (result.response.status === expectStatus && (!predicate || predicate(result.body, result.response))) {
        return result;
      }
      lastError = new Error(
        `${label} returned ${result.response.status}: ${JSON.stringify(result.body)}`,
      );
    } catch (error) {
      lastError = new Error(
        `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`${label} did not become ready`);
}

async function main() {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-e2e-'));
  const storageDir = path.join(scratchRoot, 'storage');
  const workerDataDir = path.join(scratchRoot, 'worker');
  const engineDir = path.join(scratchRoot, 'engine');
  await mkdir(storageDir, { recursive: true });
  await mkdir(workerDataDir, { recursive: true });
  await mkdir(engineDir, { recursive: true });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.modelId = 'rdk-duck-smoke-local-e2e';
  manifest.displayName = 'RDK Duck local smoke';
  manifest.version = '0.1.0-smoke';

  const devices = [
    {
      id: 'x5-smoke',
      host: '127.0.0.1',
      username: 'sim2real',
      status: 'connected',
      lastCheckedAt: new Date().toISOString(),
    },
  ];
  await writeFile(path.join(storageDir, 'devices.json'), JSON.stringify(devices, null, 2));

  const engineScript = path.join(engineDir, 'local-engine.mjs');
  await writeFile(
    engineScript,
    `import { readFile, writeFile } from 'node:fs/promises';\n` +
      `const request = JSON.parse(await readFile(process.env.RDK_SIM2REAL_REQUEST_FILE, 'utf8'));\n` +
      `if (request.schemaVersion !== 1) throw new Error('schemaVersion must be 1');\n` +
      `if (request.contractId !== 'rdk-duck-policy-v1') throw new Error('unexpected contractId');\n` +
      `if (request.model?.modelId !== 'rdk-duck-smoke-local-e2e') throw new Error('unexpected modelId');\n` +
      `if (request.training?.profile !== 'smoke') throw new Error('unexpected training profile');\n` +
      `if (request.training?.numEnvs !== 1) throw new Error('unexpected numEnvs');\n` +
      `if (request.training?.maxIterations !== 1) throw new Error('unexpected maxIterations');\n` +
      `if (request.training?.video !== false) throw new Error('unexpected video flag');\n` +
      `await new Promise((resolve) => setTimeout(resolve, 120));\n` +
      `await writeFile(process.env.RDK_SIM2REAL_RESULT_FILE, JSON.stringify({\n` +
      `  checkpoint: { checkpointId: 'smoke-cp-1', artifactRef: 'artifact://smoke/rdk-duck/cp-1', iteration: 1 },\n` +
      `  artifact: { artifactId: 'smoke-policy', artifactRef: 'artifact://smoke/rdk-duck/policy.onnx', kind: 'source', format: 'onnx', deployable: true },\n` +
      `  metrics: { reward: 1.25, cuda: false },\n` +
      `  deployable: true,\n` +
      `  cuda: false,\n` +
      `}, null, 2));\n`,
    { mode: 0o600 },
  );

  const workerPort = await freePort();
  const boardAgentPort = await freePort();
  const webPort = await freePort();
  const localRunnerToken = 'smoke-local-runner-token';

  const worker = spawnService(
    'local-worker',
    process.execPath,
    [path.join(repoRoot, 'services/sim2real-web/local-training-worker.mjs')],
    {
      RDK_SIM2REAL_LOCAL_WORKER_HOST: '127.0.0.1',
      RDK_SIM2REAL_LOCAL_WORKER_PORT: String(workerPort),
      RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR: workerDataDir,
      RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: localRunnerToken,
      RDK_SIM2REAL_TRAIN_EXECUTABLE: process.execPath,
      RDK_SIM2REAL_TRAIN_ARGS_JSON: JSON.stringify([engineScript]),
      RDK_SIM2REAL_TRAIN_TIMEOUT_MS: '30000',
      RDK_SIM2REAL_LOCAL_RUNNER_MODE: '',
    },
  );
  const boardAgent = spawnService(
    'board-agent',
    process.execPath,
    [path.join(repoRoot, 'services/sim2real-web/local-board-agent.mjs')],
    {
      RDK_SIM2REAL_BOARD_AGENT_BIND_HOST: '127.0.0.1',
      RDK_SIM2REAL_BOARD_AGENT_PORT: String(boardAgentPort),
      RDK_SIM2REAL_BOARD_AGENT_TOKEN: '',
      RDK_SIM2REAL_BOARD_AGENT_ARCH: 'aarch64',
      RDK_SIM2REAL_BOARD_AGENT_KERNEL: '6.1.0-rdk-smoke',
      RDK_SIM2REAL_BOARD_AGENT_PYTHON3: '/usr/bin/python3',
      RDK_SIM2REAL_BOARD_AGENT_TROS: 'present',
      RDK_SIM2REAL_BOARD_AGENT_DISK_BYTES: String(4 * 1024 ** 3),
    },
  );
  const web = spawnService(
    'sim2real-web',
    process.execPath,
    ['--import', 'tsx/esm', path.join(repoRoot, 'services/sim2real-web/server.ts')],
    {
      RDK_SIM2REAL_BIND_HOST: '127.0.0.1',
      RDK_SIM2REAL_PORT: String(webPort),
      RDK_SIM2REAL_STORAGE_DIR: storageDir,
      RDK_SIM2REAL_DEPLOYMENT: 'local',
      RDK_SIM2REAL_SSO_REQUIRED: '0',
      RDK_SIM2REAL_SSO_ENABLED: '0',
      RDK_SIM2REAL_AUTH_MODE: '',
      RDK_STUDIO_DEPLOYMENT_PROFILE: '',
      RDK_SIM2REAL_REQUIRE_MICRODUCK: '0',
      RDK_SIM2REAL_LOCAL_RUNNER_URL: `http://127.0.0.1:${workerPort}/train`,
      RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: localRunnerToken,
      RDK_SIM2REAL_LOCAL_RUNNER_MODE: '',
      RDK_SIM2REAL_BOARD_AGENT_URL: `http://127.0.0.1:${boardAgentPort}`,
      RDK_SIM2REAL_BOARD_AGENT_TOKEN: '',
    },
  );

  const base = `http://127.0.0.1:${webPort}`;
  const workerBase = `http://127.0.0.1:${workerPort}`;
  const boardBase = `http://127.0.0.1:${boardAgentPort}`;

  try {
    console.log(`[sim2real-smoke] waiting for worker:${workerPort}, board agent:${boardAgentPort}, and web:${webPort} health`);
    const workerHealth = await waitForJson(`${workerBase}/healthz`, {
      expectStatus: 200,
      label: 'local worker health',
    });
    assert.equal(workerHealth.body.ok, true);
    assert.equal(workerHealth.body.configured, true);

    console.log('[sim2real-smoke] worker ready, checking board agent');
    const boardHealth = await waitForJson(`${boardBase}/healthz`, {
      expectStatus: 200,
      label: 'board agent health',
    });
    assert.equal(boardHealth.body.ok, true);
    assert.equal(boardHealth.body.mock, true);
    assert.equal(boardHealth.body.actuatorControl, false);

    console.log('[sim2real-smoke] board agent ready, checking web');
    const webHealth = await waitForJson(`${base}/healthz`, {
      expectStatus: 200,
      label: 'web health',
    });
    assert.equal(webHealth.body.ok, true);
    assert.equal(webHealth.body.ready, true);
    assert.equal(webHealth.body.degraded.includes('storage-not-configured'), false);

    console.log('[sim2real-smoke] reading overview');
    const preOverview = await fetchJson(`${base}/api/v1/duck/overview?productId=rdk-duck`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(preOverview.response.status, 200);
    assert.equal(preOverview.body.ok, true);
    assert.equal(preOverview.body.selectedProductId, 'rdk-duck');
    assert.equal(
      preOverview.body.models.some((model) => model.manifest?.modelId === manifest.modelId),
      false,
    );
    assert.equal(preOverview.body.integrations.simulator.local.available, true);
    assert.equal(preOverview.body.integrations.simulator.boardAgent.available, true);

    console.log('[sim2real-smoke] registering model');
    const register = await fetchJson(`${base}/api/v1/duck/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    assert.equal(register.response.status, 201);
    assert.equal(register.body.ok, true);
    assert.equal(register.body.model.manifest.modelId, manifest.modelId);
    const modelId = register.body.model.id;

    console.log('[sim2real-smoke] launching local run');
    const runRequest = {
      modelId,
      backend: 'local',
      taskId: 'smoke',
      training: { profile: 'smoke', numEnvs: 1, maxIterations: 1, video: false },
    };
    const runKey = 'smoke-local-run-1';
    const launch = await fetchJson(`${base}/api/v1/duck/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': runKey,
      },
      body: JSON.stringify(runRequest),
    });
    assert.equal(launch.response.status, 201);
    assert.equal(launch.body.ok, true);
    const runId = launch.body.run.id;
    assert.equal(launch.body.run.backend, 'local');

    let currentRun = launch.body.run;
    console.log(`[sim2real-smoke] polling run ${runId} until completion`);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const status = await fetchJson(`${base}/api/v1/duck/runs/${encodeURIComponent(runId)}`, {
        headers: { accept: 'application/json' },
      });
      assert.equal(status.response.status, 200);
      currentRun = status.body.run;
      if (currentRun.status === 'completed') break;
      await sleep(250);
    }
    assert.equal(currentRun.status, 'completed', JSON.stringify(currentRun));
    assert.equal(Boolean(currentRun.mock), false);
    assert.equal(currentRun.checkpoint.artifactRef, 'artifact://smoke/rdk-duck/cp-1');

    console.log('[sim2real-smoke] checking idempotent replay');
    const replay = await fetchJson(`${base}/api/v1/duck/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': runKey,
      },
      body: JSON.stringify(runRequest),
    });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.run.id, runId);

    console.log('[sim2real-smoke] verifying mock board detect stays read-only');
    const detect = await fetchJson(`${base}/api/devices/x5-smoke/board/detect?persist=true`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    assert.equal(detect.response.status, 200);
    assert.equal(detect.body.ok, true);
    assert.equal(detect.body.mock, true);
    assert.equal(detect.body.actuatorControl, false);
    assert.equal(detect.body.persisted, true);

    console.log('[sim2real-smoke] verifying deployment preflight is blocked by mock board agent');
    const deployment = await fetchJson(`${base}/api/v1/duck/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        modelId,
        deviceId: 'x5-smoke',
        mode: 'preflight',
      }),
    });
    assert.equal(deployment.response.status, 201);
    const deploymentId = deployment.body.deployment.id;
    const preflight = await fetchJson(`${base}/api/v1/duck/deployments/${encodeURIComponent(deploymentId)}/preflight`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    assert.equal(preflight.response.status, 409);
    assert.equal(preflight.body.code, 'SIM2REAL_PREFLIGHT_MOCK_ONLY');
    assert.equal(preflight.body.preflight.passed, false);
    assert.equal(preflight.body.preflight.mock, true);

    console.log('[sim2real-smoke] reading final overview');
    const postOverview = await fetchJson(`${base}/api/v1/duck/overview?productId=rdk-duck`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(postOverview.response.status, 200);
    assert.equal(postOverview.body.selectedProductId, 'rdk-duck');
    assert.equal(postOverview.body.selectedContract.id, manifest.contract.id);
    assert.equal(
      postOverview.body.models.some((model) => model.id === modelId),
      true,
    );
    assert.equal(postOverview.body.runs.some((run) => run.id === runId && run.status === 'completed'), true);
    assert.equal(
      postOverview.body.devices.some((device) => device.id === 'x5-smoke' && device.boardPlatform === 'rdk-x5'),
      true,
    );

    console.log(
      '[sim2real-smoke] PASS overview -> local run completion -> idempotent replay -> mock board preflight blocked',
    );
  } finally {
    await Promise.all([web, boardAgent, worker].map((child) => terminate(child)));
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[sim2real-smoke] FAIL', error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
