import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'rdk-local-worker-'));
const fixture = path.join(fixtureDir, 'engine.mjs');
await writeFile(
  fixture,
  `import { writeFile } from 'node:fs/promises';\nconsole.error('Bearer fake-secret token=should-hide');\nconsole.log('[engine] engine=start task=goal-navigation profile=smoke iters=4 envs=16 device=cuda');\nconsole.log('[engine] iter 1/4 meanReward=-0.004 recentSuccess=0.00 goalRange=[0.80,1.20] elapsed=0.7s');\nconsole.log('[engine] iter 2/4 meanReward=-0.006 recentSuccess=0.01 goalRange=[0.80,1.20] elapsed=1.1s');\nawait new Promise((resolve) => setTimeout(resolve, 30));\n// A partially-flushed duplicate must not create a backward or duplicate point.\nconsole.log('[engine] iter 2/4 meanReward=-0.006 recentSuccess=0.01 goalRange=[0.80,1.20] elapsed=1.1s iter 3/4 meanReward=0.003 recentSuccess=0.04 goalRange=[0.80,1.20] elapsed=1.4s');\nconsole.log('[engine] iter 4/4 meanReward=0.012 recentSuccess=0.06 goalRange=[0.80,1.20] elapsed=1.8s');\nawait new Promise((resolve) => setTimeout(resolve, 90));\nconst result = { checkpoint: { checkpointId: 'cp-1', artifactRef: 'artifact://microduck/cp-1', iteration: 1 }, artifact: { artifactId: 'policy-1', artifactRef: 'artifact://microduck/policy-1', kind: 'source', format: 'onnx', deployable: true }, metrics: { reward: 3.5, platformTokenLeaked: Boolean(process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN) }, deployable: true };\nconst evalReport = { schemaVersion: 1, taskId: 'originbot-goal-navigation', trained: { envelopes: { nominal: { successRate: 0.88, collisionRate: 0, episodes: 50, successRateCiLow: 0.756, collisionRateCiHigh: 0.071 } } }, qualityGate: { criteria: { minSuccessRate: 0.7, maxCollisionRate: 0.15, gateOn: 'ciLowerBound' } } };\nif (process.env.RDK_SIM2REAL_TEST_LARGE_RESULT === '1') result.padding = 'x'.repeat(1_100_000);\nawait writeFile(process.env.RDK_SIM2REAL_JOB_DIR + '/policy.onnx', 'onnx-fixture');\nawait writeFile(process.env.RDK_SIM2REAL_RESULT_FILE, JSON.stringify(result));\nawait writeFile(process.env.RDK_SIM2REAL_JOB_DIR + '/eval-report.json', JSON.stringify(evalReport));\n// The bundle manifest is opt-in so one fixture can exercise the legacy path\n// (no manifest), the verified path, and a tampered bundle.\nconst mode = process.env.RDK_SIM2REAL_TEST_MANIFEST;\nif (mode === 'good' || mode === 'tampered') {\n  const { createHash } = await import('node:crypto');\n  const names = ['policy.onnx', 'eval-report.json'];\n  const lines = [];\n  for (const name of names) {\n    const bytes = await (await import('node:fs/promises')).readFile(process.env.RDK_SIM2REAL_JOB_DIR + '/' + name);\n    lines.push(createHash('sha256').update(bytes).digest('hex') + '  ' + name);\n  }\n  if (mode === 'tampered') {\n    // Record a digest for content that is not what policy.onnx holds.\n    lines[0] = 'f'.repeat(64) + '  policy.onnx';\n  }\n  await writeFile(process.env.RDK_SIM2REAL_JOB_DIR + '/SHA256SUMS', lines.join('\\n') + '\\n');\n}\n`,
  { mode: 0o600 },
);
process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE = process.execPath;
process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON = JSON.stringify([fixture]);
process.env.RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR = fixtureDir;
process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = 'worker-test-token';
process.env.RDK_SIM2REAL_MAX_CONCURRENT_JOBS = '1';

const { createLocalTrainingWorkerServer, runnerTokenRequired, runnerTokenUsable } =
  await import('./local-training-worker.mjs');
const previousNodeEnv = process.env.NODE_ENV;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;
process.env.NODE_ENV = 'development';
delete process.env.RDK_SIM2REAL_DEPLOYMENT;
assert.equal(runnerTokenUsable('worker-test-token'), false);
assert.equal(runnerTokenUsable('a'.repeat(32)), false);
assert.equal(runnerTokenUsable('ab'.repeat(16)), true);
assert.equal(runnerTokenRequired('0.0.0.0', { NODE_ENV: 'development' }), true);
assert.equal(runnerTokenRequired('127.0.0.1', { NODE_ENV: 'development' }), false);
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
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.maxConcurrentJobs, 1);
  assert.equal(healthBody.activeJobs, 0);

  // A production process must reject both a missing and a weak token even on
  // loopback. The development fixture token remains accepted by the local
  // loopback server after the environment is restored below.
  process.env.NODE_ENV = 'production';
  delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN;
  const productionHealth = await fetch(`${base}/healthz`);
  assert.equal(productionHealth.status, 503);
  assert.equal((await productionHealth.json()).error, 'worker_auth_not_configured');
  process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = 'worker-test-token';
  const weakProductionHealth = await fetch(`${base}/healthz`);
  assert.equal(weakProductionHealth.status, 503);
  assert.equal((await weakProductionHealth.json()).authTokenUsable, false);
  process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = 'ab'.repeat(16);
  const strongProductionHealth = await fetch(`${base}/healthz`);
  assert.equal(strongProductionHealth.status, 200);
  assert.equal((await strongProductionHealth.json()).authTokenUsable, true);
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
  process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = 'worker-test-token';

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

  const secondLaunch = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
      'idempotency-key': 'second-job',
    },
    body: JSON.stringify({ ...request, model: { modelId: 'microduck-turn', version: 'v1' } }),
  });
  assert.equal(secondLaunch.status, 202);
  const second = await secondLaunch.json();
  assert.equal(second.status, 'queued');
  assert.equal(second.queuePosition, 1);
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
  for (
    let index = 0;
    index < 30 && (status.status === 'queued' || status.status === 'running');
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const statusResponse = await fetch(`${base}/runs/${encodeURIComponent(launched.runId)}`, {
      headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' },
    });
    status = await statusResponse.json();
    if (statusResponse.status !== 200)
      throw new Error(`status response ${statusResponse.status}: ${JSON.stringify(status)}`);
  }
  assert.equal(status.status, 'completed', JSON.stringify(status));
  assert.equal(status.checkpoint.artifactRef, 'artifact://microduck/cp-1');
  assert.equal(status.artifact.sizeBytes, 12);
  assert.match(status.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(status.metrics.platformTokenLeaked, false);
  assert.equal(status.taskEvaluation.taskId, 'originbot-goal-navigation');
  assert.equal(status.taskEvaluation.trained.envelopes.nominal.episodes, 50);
  assert.match(status.taskEvaluation.reportSha256, /^[a-f0-9]{64}$/);
  assert.match(status.stderrTail, /Bearer \[redacted\]/);
  assert.doesNotMatch(status.stderrTail, /should-hide/);
  // Live progress: stdout lines parsed into strictly-advancing points, and
  // the completed view keeps them for the run detail chart. The duplicated
  // iter-2 line (partial flush overlap) must not produce a 5th point.
  assert.ok(Array.isArray(status.progress), 'completed job must expose progress array');
  assert.equal(status.progress.length, 4);
  assert.deepEqual(
    status.progress.map((point) => point.iteration),
    [1, 2, 3, 4],
  );
  assert.equal(status.progress[0].totalIterations, 4);
  assert.equal(status.progress[3].meanReward, 0.012);
  assert.equal(status.progress[3].recentSuccess, 0.06);
  assert.equal(status.progress[3].elapsedSeconds, 1.8);
  assert.match(status.progress[0].at, /^\d{4}-\d{2}-\d{2}T/);

  // ---- artifact bytes endpoint (staging source for the board) ----
  const artifactWrongOwner = await fetch(
    `${base}/runs/${encodeURIComponent(launched.runId)}/artifact`,
    {
      headers: { 'x-sim2real-account': 'bob', authorization: 'Bearer worker-test-token' },
    },
  );
  assert.equal(artifactWrongOwner.status, 404);

  const artifactNoAuth = await fetch(`${base}/runs/${encodeURIComponent(launched.runId)}/artifact`);
  assert.equal(artifactNoAuth.status, 401);

  const artifact = await fetch(`${base}/runs/${encodeURIComponent(launched.runId)}/artifact`, {
    headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' },
  });
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get('content-type'), 'application/octet-stream');
  assert.equal(artifact.headers.get('x-artifact-bytes'), '12');
  assert.equal(artifact.headers.get('x-artifact-sha256'), status.artifact.sha256);
  const artifactBytes = Buffer.from(await artifact.arrayBuffer());
  assert.equal(artifactBytes.toString('utf8'), 'onnx-fixture');

  const artifactMissing = await fetch(`${base}/runs/nonexistent-run/artifact`, {
    headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' },
  });
  assert.equal(artifactMissing.status, 404);

  // Corrupting the bytes after completion must fail the digest re-check
  // fail-closed instead of serving swapped bytes.
  const jobDir = path.join(fixtureDir, launched.runId);
  await writeFile(path.join(jobDir, 'policy.onnx'), 'swapped-bytes');
  const artifactCorrupted = await fetch(
    `${base}/runs/${encodeURIComponent(launched.runId)}/artifact`,
    {
      headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' },
    },
  );
  assert.equal(artifactCorrupted.status, 409);
  assert.equal((await artifactCorrupted.json()).error, 'artifact_digest_mismatch');
  await writeFile(path.join(jobDir, 'policy.onnx'), 'onnx-fixture');

  let secondStatus = second;
  for (
    let index = 0;
    index < 100 && (secondStatus.status === 'queued' || secondStatus.status === 'running');
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const statusResponse = await fetch(`${base}/runs/${encodeURIComponent(second.runId)}`, {
      headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' },
    });
    secondStatus = await statusResponse.json();
    if (statusResponse.status !== 200)
      throw new Error(
        `second status response ${statusResponse.status}: ${JSON.stringify(secondStatus)}`,
      );
  }
  assert.equal(secondStatus.status, 'completed', JSON.stringify(secondStatus));

  process.env.RDK_SIM2REAL_TEST_LARGE_RESULT = '1';
  const oversizedLaunch = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
      'idempotency-key': 'oversized-result',
    },
    body: JSON.stringify({
      ...request,
      model: { modelId: 'microduck-large-result', version: 'v1' },
    }),
  });
  assert.equal(oversizedLaunch.status, 202);
  let oversizedStatus = await oversizedLaunch.json();
  for (
    let index = 0;
    index < 100 && (oversizedStatus.status === 'queued' || oversizedStatus.status === 'running');
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const statusResponse = await fetch(
      `${base}/runs/${encodeURIComponent(oversizedStatus.runId)}`,
      { headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' } },
    );
    oversizedStatus = await statusResponse.json();
  }
  assert.equal(oversizedStatus.status, 'failed', JSON.stringify(oversizedStatus));
  assert.equal(oversizedStatus.errorCode, 'training_result_missing');
  delete process.env.RDK_SIM2REAL_TEST_LARGE_RESULT;
  delete process.env.RDK_SIM2REAL_TEST_MANIFEST;

  process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON = 'not-json';
  const invalidHealth = await fetch(`${base}/healthz`);
  assert.equal(invalidHealth.status, 503);
  assert.equal((await invalidHealth.json()).error, 'worker_configuration_invalid');
  process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON = JSON.stringify([fixture]);

  process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE = '';
  const blocked = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
    },
    body: JSON.stringify({ ...request, model: { modelId: 'microduck-blocked', version: 'v1' } }),
  });
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error, 'real_worker_not_configured');
  const persistedEntries = await readdir(fixtureDir, { withFileTypes: true });
  assert.equal(persistedEntries.filter((entry) => entry.isDirectory()).length, 3);

  // ---- multi-engine routing: RDK_SIM2REAL_TRAIN_ENGINES_JSON ----
  // A second fixture engine is registered under 'mjx-ppo' and writes a
  // distinct marker into the result so the test proves the request really
  // reached the routed engine, not the default one.
  const mjxFixture = path.join(fixtureDir, 'mjx-engine.mjs');
  await writeFile(
    mjxFixture,
    `import { writeFile } from 'node:fs/promises';\n` +
      `import { readFile } from 'node:fs/promises';\n` +
      `const request = JSON.parse(await readFile(process.env.RDK_SIM2REAL_REQUEST_FILE, 'utf8'));\n` +
      `if (request.training?.engine !== 'mjx-ppo') throw new Error('mjx engine received wrong routing');\n` +
      `console.log('[mjx-engine] iter 1/2 meanReward=0.01 recentSuccess=0.10 elapsed=0.1s');\n` +
      `await writeFile(process.env.RDK_SIM2REAL_RESULT_FILE, JSON.stringify({\n` +
      `  checkpoint: { checkpointId: 'mjx-cp-1', artifactRef: 'artifact://microduck/mjx-cp-1', iteration: 1 },\n` +
      `  artifact: { artifactId: 'mjx-policy', artifactRef: 'artifact://microduck/mjx-policy', kind: 'source', format: 'onnx', deployable: false },\n` +
      `  metrics: { reward: 0.5, engine: 'mjx-ppo', physicsBackend: 'mjx' },\n` +
      `  deployable: false,\n` +
      `}));\n`,
    { mode: 0o600 },
  );
  process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE = process.execPath;
  process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON = JSON.stringify([fixture]);
  process.env.RDK_SIM2REAL_TRAIN_ENGINES_JSON = JSON.stringify({
    'mjx-ppo': { executable: process.execPath, args: [mjxFixture] },
  });
  const enginesHealth = await fetch(`${base}/healthz`);
  assert.equal(enginesHealth.status, 200);
  const enginesBody = await enginesHealth.json();
  assert.deepEqual(enginesBody.engines, ['default', 'mjx-ppo']);

  const unregistered = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
      'idempotency-key': 'engine-unregistered',
    },
    body: JSON.stringify({
      ...request,
      model: { modelId: 'microduck-engine-typo', version: 'v1' },
      training: { profile: 'smoke', engine: 'mjx' },
    }),
  });
  assert.equal(unregistered.status, 400);
  assert.equal((await unregistered.json()).error, 'engine_not_registered');

  const mjxLaunch = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
      'idempotency-key': 'engine-mjx-run',
    },
    body: JSON.stringify({
      ...request,
      model: { modelId: 'microduck-mjx-run', version: 'v1' },
      training: { profile: 'smoke', engine: 'mjx-ppo' },
    }),
  });
  assert.equal(mjxLaunch.status, 202);
  const mjxLaunched = await mjxLaunch.json();
  assert.equal(mjxLaunched.engine, 'mjx-ppo');
  let mjxStatus = mjxLaunched;
  for (
    let index = 0;
    index < 30 && (mjxStatus.status === 'queued' || mjxStatus.status === 'running');
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const statusResponse = await fetch(`${base}/runs/${encodeURIComponent(mjxLaunched.runId)}`, {
      headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' },
    });
    mjxStatus = await statusResponse.json();
  }
  assert.equal(mjxStatus.status, 'completed', JSON.stringify(mjxStatus));
  assert.equal(mjxStatus.metrics.engine, 'mjx-ppo');
  assert.equal(mjxStatus.metrics.physicsBackend, 'mjx');
  assert.equal(mjxStatus.deployable, false);

  // Default routing is untouched when no engine is selected: the job goes to
  // the base RDK_SIM2REAL_TRAIN_EXECUTABLE engine even with the registry set.
  const defaultLaunch = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sim2real-account': 'alice',
      authorization: 'Bearer worker-test-token',
      'idempotency-key': 'engine-default-run',
    },
    body: JSON.stringify({
      ...request,
      model: { modelId: 'microduck-default-engine', version: 'v1' },
    }),
  });
  assert.equal(defaultLaunch.status, 202);
  let defaultStatus = await defaultLaunch.json();
  for (
    let index = 0;
    index < 100 && (defaultStatus.status === 'queued' || defaultStatus.status === 'running');
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const statusResponse = await fetch(`${base}/runs/${encodeURIComponent(defaultStatus.runId)}`, {
      headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' },
    });
    defaultStatus = await statusResponse.json();
  }
  assert.equal(defaultStatus.status, 'completed', JSON.stringify(defaultStatus));
  assert.equal(defaultStatus.checkpoint.artifactRef, 'artifact://microduck/cp-1');

  process.env.RDK_SIM2REAL_TRAIN_ENGINES_JSON = 'not-json';
  const invalidEnginesHealth = await fetch(`${base}/healthz`);
  assert.equal(invalidEnginesHealth.status, 503);
  assert.equal((await invalidEnginesHealth.json()).error, 'worker_configuration_invalid');
  delete process.env.RDK_SIM2REAL_TRAIN_ENGINES_JSON;

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
  // ---- artifact bundle integrity -----------------------------------------
  // A verified bundle is published with `verified: true`; a manifest that
  // disagrees with the files on disk fails the run closed, because publishing it
  // would hand the staging chain bytes of unknown provenance.
  const submit = async (modelId, key) => {
    const response = await fetch(`http://127.0.0.1:${recoveredAddress.port}/train`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sim2real-account': 'alice',
        authorization: 'Bearer worker-test-token',
        'idempotency-key': key,
      },
      body: JSON.stringify({ ...request, model: { modelId, version: 'v1' } }),
    });
    assert.equal(response.status, 202);
    return (await response.json()).runId;
  };
  const awaitTerminal = async (runId) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(
        `http://127.0.0.1:${recoveredAddress.port}/runs/${encodeURIComponent(runId)}`,
        { headers: { 'x-sim2real-account': 'alice', authorization: 'Bearer worker-test-token' } },
      );
      const body = await response.json();
      if (body.status === 'completed' || body.status === 'failed') return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`run ${runId} did not settle`);
  };

  process.env.RDK_SIM2REAL_TEST_MANIFEST = 'good';
  const verifiedRun = await awaitTerminal(await submit('manifest-good', 'manifest-good'));
  assert.equal(verifiedRun.status, 'completed');
  assert.equal(verifiedRun.artifactVerification.verified, true);
  assert.equal(verifiedRun.artifactVerification.code, 'artifact_manifest_verified');
  assert.deepEqual(verifiedRun.artifactVerification.files, ['policy.onnx', 'eval-report.json']);

  process.env.RDK_SIM2REAL_TEST_MANIFEST = 'tampered';
  const tamperedRun = await awaitTerminal(await submit('manifest-bad', 'manifest-bad'));
  assert.equal(tamperedRun.status, 'failed');
  assert.equal(tamperedRun.errorCode, 'artifact_manifest_mismatch');
  assert.equal(tamperedRun.artifactVerification.verified, false);
  assert.equal(tamperedRun.artifact, undefined);
  delete process.env.RDK_SIM2REAL_TEST_MANIFEST;
  console.log(
    '[local-training-worker] PASS — SHA256SUMS bundle verified (' +
      verifiedRun.artifactVerification.files.length +
      ' files), tampered bundle failed closed (' +
      tamperedRun.errorCode +
      ')',
  );

  console.log(
    '[local-training-worker] PASS — external engine result is required; unconfigured mode fails closed',
  );
} finally {
  // Node's fetch keeps an idle connection alive; explicitly drain it so this
  // standalone contract test never leaves the test runner hanging.
  serverToClose.closeIdleConnections?.();
  serverToClose.closeAllConnections?.();
  if (serverToClose.listening) await new Promise((resolve) => serverToClose.close(resolve));
  await rm(fixtureDir, { recursive: true, force: true });
  delete process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE;
  delete process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON;
  delete process.env.RDK_SIM2REAL_TRAIN_ENGINES_JSON;
  delete process.env.RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR;
  delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN;
  delete process.env.RDK_SIM2REAL_MAX_CONCURRENT_JOBS;
  delete process.env.RDK_SIM2REAL_TEST_LARGE_RESULT;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
}
