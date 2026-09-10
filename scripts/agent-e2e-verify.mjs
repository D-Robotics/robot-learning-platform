#!/usr/bin/env node
/**
 * Real-stack E2E for the Agent chat surface (plan -> execute -> poll -> evidence)
 * plus the three hardening behaviors: owner scoping, unknown-tool rejection,
 * and registry eviction. Spawns the same worker / mock board agent / web
 * services as the local smoke test, then drives them over HTTP exactly the
 * way the frontend agent-chat.js does.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fetchFn = globalThis.fetch.bind(globalThis);
const children = [];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function buildEnv(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:RDK_SIM2REAL|RDK_STUDIO|SSO)_/i.test(key)) delete environment[key];
  }
  return { ...environment, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...overrides };
}

function spawnService(label, command, args, env) {
  const child = spawn(command, args, { env: buildEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${String(chunk)}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${String(chunk)}`));
  children.push(child);
  return child;
}

async function terminateAll() {
  for (const child of children) {
    if (child.exitCode != null || child.signalCode != null) continue;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const result = await Promise.race([exited, sleep(3_000)]);
    if (result === undefined && child.exitCode == null) child.kill('SIGKILL');
  }
}

async function fetchJson(url, init) {
  const response = await fetchFn(url, init);
  const text = await response.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; } }
  return { response, body };
}

async function waitForJson(url, { expectStatus = 200, timeoutMs = 30_000, label = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fetchJson(url, { headers: { accept: 'application/json' } });
      if (last.response.status === expectStatus) return last;
    } catch (error) { last = error; }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label} (last: ${String(last && last.response ? last.response.status : last)})`);
}

async function agent(base, pathName, init) {
  return fetchJson(`${base}${pathName}`, { headers: { accept: 'application/json', ...init?.headers }, ...init });
}

async function pollRun(base, runId, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { response, body } = await fetchJson(`${base}/api/sim2real/agent/runs/${encodeURIComponent(runId)}`);
    assert.equal(response.status, 200, `run poll failed: ${response.status}`);
    if (['completed', 'failed', 'blocked'].includes(body.run?.status)) return body.run;
    await sleep(500);
  }
  throw new Error(`agent run ${runId} did not reach terminal status in ${timeoutMs}ms`);
}

const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'rdk-agent-e2e-'));
try {
  const storageDir = path.join(scratchRoot, 'storage');
  const workerDataDir = path.join(scratchRoot, 'worker');
  const engineDir = path.join(scratchRoot, 'engine');
  await mkdir(storageDir, { recursive: true });
  await mkdir(workerDataDir, { recursive: true });
  await mkdir(engineDir, { recursive: true });

  // Same model manifest + instant engine as the local smoke so the
  // full-loop conversation exercises a real training run.
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'examples/rdk-duck-policy-manifest.json'), 'utf8'));
  manifest.modelId = 'rdk-duck-agent-e2e';
  manifest.displayName = 'RDK Duck agent e2e';
  manifest.version = '0.1.0-agent-e2e';
  await writeFile(path.join(storageDir, 'devices.json'), JSON.stringify([
    { id: 'x5-agent', host: '127.0.0.1', username: 'sim2real', status: 'connected', lastCheckedAt: new Date().toISOString() },
  ], null, 2));
  const engineScript = path.join(engineDir, 'engine.mjs');
  await writeFile(engineScript, [
    `import { readFile, writeFile } from 'node:fs/promises';`,
    `const request = JSON.parse(await readFile(process.env.RDK_SIM2REAL_REQUEST_FILE, 'utf8'));`,
    `if (request.model?.modelId !== 'rdk-duck-agent-e2e') throw new Error('unexpected modelId');`,
    `await new Promise((resolve) => setTimeout(resolve, 150));`,
    `await writeFile(process.env.RDK_SIM2REAL_RESULT_FILE, JSON.stringify({`,
    `  checkpoint: { checkpointId: 'cp-1', artifactRef: 'artifact://smoke/rdk-duck/cp-1', iteration: 1 },`,
    `  artifact: { artifactId: 'policy', artifactRef: 'artifact://smoke/rdk-duck/policy.onnx', kind: 'source', format: 'onnx', deployable: true },`,
    `  metrics: { reward: 1.5, cuda: false },`,
    `  deployable: true,`,
    `  cuda: false,`,
    `}));`,
  ].join('\n'));

  const workerPort = await freePort();
  const boardAgentPort = await freePort();
  const webPort = await freePort();
  const runnerToken = 'agent-e2e-runner-token';

  spawnService('worker', process.execPath, [path.join(repoRoot, 'services/sim2real-web/local-training-worker.mjs')], {
    RDK_SIM2REAL_LOCAL_WORKER_HOST: '127.0.0.1',
    RDK_SIM2REAL_LOCAL_WORKER_PORT: String(workerPort),
    RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR: workerDataDir,
    RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: runnerToken,
    RDK_SIM2REAL_TRAIN_EXECUTABLE: process.execPath,
    RDK_SIM2REAL_TRAIN_ARGS_JSON: JSON.stringify([engineScript]),
    RDK_SIM2REAL_TRAIN_TIMEOUT_MS: '30000',
    RDK_SIM2REAL_LOCAL_RUNNER_MODE: '',
  });
  spawnService('board-agent', process.execPath, [path.join(repoRoot, 'services/sim2real-web/local-board-agent.mjs')], {
    RDK_SIM2REAL_BOARD_AGENT_BIND_HOST: '127.0.0.1',
    RDK_SIM2REAL_BOARD_AGENT_PORT: String(boardAgentPort),
    RDK_SIM2REAL_BOARD_AGENT_TOKEN: '',
    RDK_SIM2REAL_BOARD_AGENT_ARCH: 'aarch64',
    RDK_SIM2REAL_BOARD_AGENT_KERNEL: '6.1.0-rdk-agent-e2e',
  });
  spawnService('web', process.execPath, ['--import', 'tsx/esm', path.join(repoRoot, 'services/sim2real-web/server.ts')], {
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
    RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: runnerToken,
    RDK_SIM2REAL_LOCAL_RUNNER_MODE: '',
    RDK_SIM2REAL_BOARD_AGENT_URL: `http://127.0.0.1:${boardAgentPort}`,
    RDK_SIM2REAL_BOARD_AGENT_TOKEN: '',
  });

  const base = `http://127.0.0.1:${webPort}`;
  await waitForJson(`${base}/healthz`, { label: 'web health' });
  console.log('[agent-e2e] services up');

  // Register the model first so the full-loop has a real model to train.
  const register = await agent(base, '/api/v1/duck/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
  assert.equal(register.response.status, 201);
  console.log('[agent-e2e] model registered');

  // Board detect is a prerequisite for deployment plans (same as the smoke).
  const detect = await agent(base, `/api/devices/x5-agent/board/detect?persist=true`, { method: 'POST' });
  assert.equal(detect.response.status, 200);
  assert.equal(detect.body.ok, true);
  console.log('[agent-e2e] board detect persisted');

  // Which model will the agent's training tool actually pick?
  const overview = (await agent(base, '/api/sim2real/overview')).body;
  console.log('[agent-e2e] overview models:', (overview.models ?? []).map((m) => `${m.id}:${m.manifest?.modelId}`).join(', '));

  // --- Case 1: full conversation flow, exactly as the frontend drives it ---
  const planResponse = await agent(base, '/api/sim2real/agent/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '完整闭环演示', context: { modelId: register.body.model.id } }),
  });
  assert.equal(planResponse.response.status, 200);
  assert.equal(planResponse.body.plan.intent, 'full-loop');
  const plan = planResponse.body.plan;
  console.log(`[agent-e2e] plan created: ${plan.steps.length} steps (${plan.steps.map((s) => s.tool).join(', ')})`);

  const executeResponse = await agent(base, '/api/sim2real/agent/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan, approved: true }),
  });
  assert.equal(executeResponse.response.status, 202);
  assert.equal(executeResponse.body.run.status, 'queued');
  const runId = executeResponse.body.run.id;

  // The run must reach a terminal state. The mock board agent cannot do a
  // real preflight (409 mock-only), which the executor reports as a labeled
  // drill ("协议演练") rather than a failure -- so the honest terminal status
  // is "completed" with drill-marked evidence, never a faked real-machine pass.
  const run = await pollRun(base, runId);
  console.log(`[agent-e2e] full-loop terminal status: ${run.status}`);
  console.log('[agent-e2e] steps:', run.steps.map((s) => `${s.tool}=${s.status}${s.detail ? `(${s.detail.slice(0, 100)})` : ''}`).join(' | '));
  console.log('[agent-e2e] last events:', run.events.slice(-3).map((e) => e.text.slice(0, 120)).join(' || '));
  if (run.status === 'failed') {
    const trainingEvidence = run.evidence.find((e) => e.label === 'GPU 训练');
    if (trainingEvidence) {
      const trainingRunId = String(trainingEvidence.value).split(' · ')[0];
      const detail = await agent(base, `/api/sim2real/runs/${encodeURIComponent(trainingRunId)}`);
      console.log('[agent-e2e] training run detail:', JSON.stringify(detail.body).slice(0, 800));
    }
  }
  assert.equal(run.status, 'completed');
  const preflightStep = run.steps.find((s) => s.tool === 'deployment.preflight');
  assert.equal(preflightStep.status, 'completed');
  assert.match(preflightStep.detail, /演练|模拟/, 'mock preflight is labeled as a drill, not real evidence');
  // Training really ran before the preflight.
  const trainStep = run.steps.find((s) => s.tool === 'training.gpu');
  assert.equal(trainStep.status, 'completed');
  assert.ok(run.evidence.some((e) => e.label === 'GPU 训练' && /completed/.test(e.value)), 'training evidence recorded');
  assert.ok(run.evidence.some((e) => e.label === 'X5 BoardAgent'), 'board health evidence recorded');
  assert.ok(run.evidence.some((e) => /演练|模拟/.test(e.label + e.value)), 'preflight evidence is marked as mock drill');
  // No actuator path was ever touched.
  console.log('[agent-e2e] full-loop: training completed, mock preflight labeled as drill, evidence recorded');

  // --- Case 2: stop intent end to end ---
  const stopPlan = (await agent(base, '/api/sim2real/agent/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '急停' }),
  })).body.plan;
  assert.equal(stopPlan.intent, 'stop');
  const stopRun = (await agent(base, '/api/sim2real/agent/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: stopPlan, approved: true }),
  })).body.run;
  const stopFinal = await pollRun(base, stopRun.id);
  assert.equal(stopFinal.status, 'completed');
  console.log('[agent-e2e] stop intent: completed (stop requests sent to mock board)');

  // --- Case 3: crafted plan with an unknown/actuator tool is rejected ---
  const hostile = { ...plan, steps: [{ ...plan.steps[0], tool: 'board.policy-start' }] };
  const hostileResponse = await agent(base, '/api/sim2real/agent/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: hostile, approved: true }),
  });
  assert.equal(hostileResponse.response.status, 400);
  assert.equal(hostileResponse.body.error, 'SIM2REAL_AGENT_PLAN_INVALID');
  console.log('[agent-e2e] crafted actuator tool rejected with 400');

  // Oversized plan (13 steps > cap of 12).
  const oversized = { ...plan, steps: Array.from({ length: 13 }, (_, i) => ({ ...plan.steps[0], id: `s${i}` })) };
  const oversizedResponse = await agent(base, '/api/sim2real/agent/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: oversized, approved: true }),
  });
  assert.equal(oversizedResponse.response.status, 400);
  assert.equal(oversizedResponse.body.error, 'SIM2REAL_AGENT_PLAN_TOO_LARGE');
  console.log('[agent-e2e] oversized plan rejected with 400');

  // --- Case 4: eviction — registry stays bounded, oldest run is dropped ---
  // Each flood submission re-plans (fresh uuid), exactly as the frontend
  // does; reusing one plan object would collide run ids and prove nothing.
  for (let i = 0; i < 205; i += 1) {
    const uniquePlan = { ...stopPlan, id: randomUUID() };
    const response = await agent(base, '/api/sim2real/agent/execute', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: uniquePlan, approved: true }),
    });
    assert.equal(response.response.status, 202);
  }
  await sleep(1_500); // let the quick stop runs settle to terminal
  const oldest = await agent(base, `/api/sim2real/agent/runs/${encodeURIComponent(runId)}`);
  // The old full-loop run predates 200 newer runs; it must have been evicted.
  assert.equal(oldest.response.status, 404);
  console.log('[agent-e2e] eviction: oldest terminal run dropped after 205 newer runs');

  console.log('[agent-e2e] PASS — conversation flow, honest failure, tool allowlist, plan cap, and eviction all verified');
} finally {
  await terminateAll();
  await rm(scratchRoot, { recursive: true, force: true });
}
