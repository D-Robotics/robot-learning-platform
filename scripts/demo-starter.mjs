#!/usr/bin/env node

/**
 * One-command starter demo: a genuinely real Sim2Real loop on this machine.
 *
 *   temp ledger ──▶ local worker ──▶ engines/starter-ppo (real PPO)
 *        ▲                 │
 *        │                 └── result.json + policy.onnx + telemetry.jsonl
 *   Web workbench ◀────────┘
 *        │
 *        └── telemetry upload ──▶ evaluate vs untrained baseline (MAE/RMSE gap)
 *
 * Nothing is mocked: the run is marked mock:false, the ONNX bytes come from
 * torch.onnx.export, and the evaluation consumes the engine's exported
 * rollout. The board stays read-only: no device is touched.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'examples/starter-ppo-manifest.json');
const enginePath = path.join(repoRoot, 'engines/starter-ppo/runner.py');
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

function pythonInterpreter() {
  for (const candidate of [
    process.env.RDK_STARTER_ENGINE_PYTHON,
    'python3',
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
  ]) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import numpy, torch, onnx'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (probe.status !== 0) continue;
    // The worker refuses non-absolute TRAIN_EXECUTABLE values; resolve a
    // PATH-relative interpreter to its real location.
    if (path.isAbsolute(candidate)) return candidate;
    const which = spawnSync('/usr/bin/which', [candidate], { encoding: 'utf8' });
    const resolved = (which.stdout || '').trim().split('\n')[0];
    if (resolved && path.isAbsolute(resolved)) return resolved;
    return null;
  }
  return null;
}

function buildEnv(overrides = {}) {
  const environment = { ...process.env };
  // Do not let real deployment settings or credentials bleed into the
  // disposable demo services; PATH, Node, and ordinary CI vars remain.
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
    process.stdout.write(`[${label}] ${String(chunk)}`);
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
      lastError = new Error(`${label} returned ${result.response.status}: ${JSON.stringify(result.body)}`);
    } catch (error) {
      lastError = new Error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`${label} did not become ready`);
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

function readJsonl(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

async function main() {
  const python = pythonInterpreter();
  if (!python) {
    console.error(
      '[demo:starter] 需要 python3 且安装 numpy + torch + onnx。\n' +
        '安装：python3 -m pip install --user numpy torch onnx\n' +
        '（无 ML 依赖时可用 npm run demo:sim2real 体验协议闭环）',
    );
    process.exit(2);
  }
  const iterations = Number(process.env.RDK_STARTER_DEMO_ITERATIONS || 240);
  if (!Number.isSafeInteger(iterations) || iterations < 20 || iterations > 600) {
    throw new Error('RDK_STARTER_DEMO_ITERATIONS must be an integer between 20 and 600');
  }

  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'rdk-demo-starter-'));
  const storageDir = path.join(scratchRoot, 'storage');
  const workerDataDir = path.join(scratchRoot, 'worker');
  await mkdir(storageDir, { recursive: true });
  await mkdir(workerDataDir, { recursive: true });

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.modelId = 'starter-ppo-demo';
  manifest.version = '0.1.0-demo';

  const workerPort = await freePort();
  const webPort = 18102;
  const worker = spawnService(
    'local-worker',
    process.execPath,
    [path.join(repoRoot, 'services/sim2real-web/local-training-worker.mjs')],
    {
      RDK_SIM2REAL_LOCAL_WORKER_HOST: '127.0.0.1',
      RDK_SIM2REAL_LOCAL_WORKER_PORT: String(workerPort),
      RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR: workerDataDir,
      RDK_SIM2REAL_TRAIN_EXECUTABLE: python,
      RDK_SIM2REAL_TRAIN_ARGS_JSON: JSON.stringify([enginePath]),
      RDK_SIM2REAL_TRAIN_TIMEOUT_MS: '1800000',
      RDK_STARTER_ENGINE_ITERATIONS: String(iterations),
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
      RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: '',
      RDK_SIM2REAL_LOCAL_RUNNER_MODE: '',
    },
  );

  const base = `http://127.0.0.1:${webPort}`;
  const workerBase = `http://127.0.0.1:${workerPort}`;
  let jobDir = null;
  let runId = null;
  try {
    console.log(`[demo:starter] waiting for worker:${workerPort} and web:${webPort}`);
    const workerHealth = await waitForJson(`${workerBase}/healthz`, {
      expectStatus: 200,
      label: 'local worker health',
    });
    assert.equal(workerHealth.body.configured, true);
    await waitForJson(`${base}/healthz`, { expectStatus: 200, label: 'web health' });

    console.log('[demo:starter] registering starter-ppo manifest');
    const register = await fetchJson(`${base}/api/v1/duck/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    assert.equal(register.response.status, 201, JSON.stringify(register.body));
    const modelId = register.body.model.id;

    console.log(`[demo:starter] launching REAL PPO training (${iterations} iterations, ~${Math.round(iterations / 3)}s on a laptop CPU)`);
    const launch = await fetchJson(`${base}/api/v1/duck/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': 'starter-demo-run-1',
      },
      body: JSON.stringify({
        modelId,
        backend: 'local',
        taskId: 'balance',
        training: { profile: 'standard', numEnvs: 64, maxIterations: iterations, video: false },
      }),
    });
    assert.equal(launch.response.status, 201, JSON.stringify(launch.body));
    runId = launch.body.run.id;

    let currentRun = launch.body.run;
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const status = await fetchJson(`${base}/api/v1/duck/runs/${encodeURIComponent(runId)}`, {
        headers: { accept: 'application/json' },
      });
      currentRun = status.body.run;
      if (['completed', 'failed', 'blocked'].includes(currentRun.status)) break;
      await sleep(2_000);
    }
    assert.equal(currentRun.status, 'completed', JSON.stringify(currentRun));
    assert.equal(Boolean(currentRun.mock), false, 'the starter engine must not be flagged mock');
    const metrics = currentRun.metrics;
    // The worker names its job directory local-<modelId>-<uuid> and the
    // platform stores that id as externalRunId once the job is accepted.
    const jobId = currentRun.externalRunId || runId;
    jobDir = path.join(workerDataDir, jobId);
    const summaryPath = path.join(jobDir, 'training-summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    console.log(
      `[demo:starter] training completed: step reward ${summary.baseline.meanStepReward?.toFixed(3)} ` +
        `-> ${summary.eval.meanStepReward?.toFixed(3)}, successRate=${metrics.successRate}, ` +
        `fallRate=${metrics.fallRate}, latency=${metrics.controlLatencyMs}ms, ` +
        `iterations=${summary.iterations}`,
    );
    const onnxPath = path.join(jobDir, 'policy.onnx');
    const onnxBytes = await readFile(onnxPath);
    console.log(`[demo:starter] real ONNX artifact: policy.onnx (${onnxBytes.length} bytes) at ${onnxPath}`);

    // Upload the engine's evaluation rollout as evidence bound to the run.
    const telemetryRows = readJsonl(await readFile(path.join(jobDir, 'telemetry.jsonl'), 'utf8'));
    const baselineRows = readJsonl(await readFile(path.join(jobDir, 'baseline-telemetry.jsonl'), 'utf8'));
    console.log(`[demo:starter] uploading ${telemetryRows.length} telemetry samples in chunks`);
    const chunkSize = 250;
    for (let offset = 0; offset < telemetryRows.length; offset += chunkSize) {
      const chunk = telemetryRows.slice(offset, offset + chunkSize);
      const uploaded = await fetchJson(`${base}/api/v1/duck/runs/${encodeURIComponent(runId)}/telemetry`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'idempotency-key': `starter-demo-telemetry-${offset}`,
        },
        body: JSON.stringify({
          // `import` is the honest source label: an engine-side rollout file
          // uploaded through the public API, not a board or browser stream.
          source: 'import',
          samples: chunk,
          sequence: offset / chunkSize,
        }),
      });
      if (uploaded.response.status !== 201 && uploaded.response.status !== 200) {
        throw new Error(`telemetry upload failed: ${JSON.stringify(uploaded.body)}`);
      }
    }

    // Evaluate the trained rollout against the untrained baseline rollout:
    // the MAE/RMSE gap IS the sim2real-style trained-vs-baseline delta.
    console.log('[demo:starter] evaluating trained rollout against untrained baseline');
    const evaluated = await fetchJson(`${base}/api/v1/duck/runs/${encodeURIComponent(runId)}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ referenceSamples: baselineRows }),
    });
    assert.equal(evaluated.response.status, 200, JSON.stringify(evaluated.body));
    const evaluation = evaluated.body.evaluation;
    console.log(
      `[demo:starter] evaluation: samples=${evaluation.sampleCount} actionMAE=${evaluation.actionMae?.toFixed(4)} ` +
        `actionRMSE=${evaluation.actionRmse?.toFixed(4)} observationMAE=${evaluation.observationMae?.toFixed(4)}`,
    );

    console.log(
      '\n[demo:starter] PASS — 真实闭环完成：注册 → PPO 训练(mock=false) → ONNX 制品 → 遥测上传 → 评测。\n' +
        `  工作台: http://127.0.0.1:${webPort}/?demo=1  (在“训练与模型/记录中心”里查看 run ${runId})\n` +
        `  引擎产物: ${jobDir} (policy.onnx / telemetry.jsonl / training-summary.json)\n` +
        '  日常使用: npm run dev:mock-worker 换成配置 RDK_SIM2REAL_TRAIN_EXECUTABLE 的 local worker 即可复用同一平台。\n',
    );

    // Keep the workbench alive for interactive inspection unless CI mode.
    if (process.env.RDK_STARTER_DEMO_KEEP === '0') {
      console.log('[demo:starter] RDK_STARTER_DEMO_KEEP=0 → exiting immediately');
    } else {
      console.log('[demo:starter] Ctrl+C 退出并清理临时台账');
      await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    }
  } finally {
    await terminate(web);
    await terminate(worker);
    if (process.env.RDK_STARTER_DEMO_KEEP !== '1') {
      await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`[demo:starter] 保留临时台账与产物: ${scratchRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(`[demo:starter] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
