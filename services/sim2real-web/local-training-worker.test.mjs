import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'rdk-local-worker-'));
const fixture = path.join(fixtureDir, 'engine.mjs');
await writeFile(
  fixture,
  `import { writeFile } from 'node:fs/promises';\nconsole.error('Bearer fake-secret token=should-hide');\nawait writeFile(process.env.RDK_SIM2REAL_RESULT_FILE, JSON.stringify({ checkpoint: { checkpointId: 'cp-1', artifactRef: 'artifact://microduck/cp-1', iteration: 1 }, metrics: { reward: 3.5, platformTokenLeaked: Boolean(process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN) }, deployable: false }));\n`,
  { mode: 0o600 },
);
process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE = process.execPath;
process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON = JSON.stringify([fixture]);
process.env.RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR = fixtureDir;
process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = 'worker-test-token';

const { createLocalTrainingWorkerServer } = await import('./local-training-worker.mjs');
const server = createLocalTrainingWorkerServer();
let serverToClose = server;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const request = {
  schemaVersion: 1,
  accountId: 'alice',
  contractId: 'microduck-policy-v1',
  model: { modelId: 'microduck-walk', version: 'v1' },
  contract: { id: 'microduck-policy-v1', observationSize: 61, actionSize: 14 },
  training: { profile: 'smoke', maxIterations: 10 },
};
try {
  const unauthorized = await fetch(`${base}/train`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim2real-account': 'alice' },
    body: JSON.stringify(request),
  });
  assert.equal(unauthorized.status, 401);
  const launch = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
      'idempotency-key': 'same-job',
    },
    body: JSON.stringify(request),
  });
  assert.equal(launch.status, 202);
  const launched = await launch.json();
  assert.equal(launched.mock, false);
  const replay = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
      'idempotency-key': 'same-job',
    },
    body: JSON.stringify(request),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).runId, launched.runId);
  const conflict = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
      'idempotency-key': 'same-job',
    },
    body: JSON.stringify({ ...request, training: { profile: 'smoke', maxIterations: 11 } }),
  });
  assert.equal(conflict.status, 409);
  let status = launched;
  for (let index = 0; index < 30 && (status.status === 'queued' || status.status === 'running'); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const statusResponse = await fetch(`${base}/runs/${encodeURIComponent(launched.runId)}`, { headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' } });
    status = await statusResponse.json();
    if (statusResponse.status !== 200) throw new Error(`status response ${statusResponse.status}: ${JSON.stringify(status)}`);
  }
  assert.equal(status.status, 'completed', JSON.stringify(status));
  assert.equal(status.checkpoint.artifactRef, 'artifact://microduck/cp-1');
  assert.equal(status.metrics.platformTokenLeaked, false);
  assert.match(status.stderrTail, /Bearer \[redacted\]/);
  assert.doesNotMatch(status.stderrTail, /should-hide/);

  process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON = 'not-json';
  const invalidHealth = await fetch(`${base}/healthz`);
  assert.equal(invalidHealth.status, 503);
  assert.equal((await invalidHealth.json()).error, 'worker_configuration_invalid');
  process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON = JSON.stringify([fixture]);

  process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE = '';
  const blocked = await fetch(`${base}/train`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' },
    body: JSON.stringify({ ...request, model: { modelId: 'microduck-blocked', version: 'v1' } }),
  });
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error, 'real_worker_not_configured');
  const persistedEntries = await readdir(fixtureDir, { withFileTypes: true });
  assert.equal(persistedEntries.filter((entry) => entry.isDirectory()).length, 1);

  // A fresh worker process must recover terminal records so polling and
  // idempotency do not silently forget a completed run after a restart.
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  const reloaded = await import(`./local-training-worker.mjs?restart=${Date.now()}`);
  const recoveredServer = reloaded.createLocalTrainingWorkerServer();
  serverToClose = recoveredServer;
  await new Promise((resolve) => recoveredServer.listen(0, '127.0.0.1', resolve));
  const recoveredAddress = recoveredServer.address();
  const recoveredStatus = await fetch(
    `http://127.0.0.1:${recoveredAddress.port}/runs/${encodeURIComponent(launched.runId)}`,
    { headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' } },
  );
  assert.equal(recoveredStatus.status, 200);
  assert.equal((await recoveredStatus.json()).status, 'completed');
  console.log('[local-training-worker] PASS — external engine result is required; unconfigured mode fails closed');
} finally {
  // Node's fetch keeps an idle connection alive; explicitly drain it so this
  // standalone contract test never leaves the test runner hanging.
  serverToClose.closeIdleConnections?.();
  serverToClose.closeAllConnections?.();
  if (serverToClose.listening) await new Promise((resolve) => serverToClose.close(resolve));
  await rm(fixtureDir, { recursive: true, force: true });
  delete process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE;
  delete process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON;
  delete process.env.RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR;
  delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN;
}
