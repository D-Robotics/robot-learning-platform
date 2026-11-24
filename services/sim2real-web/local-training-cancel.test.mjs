import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') {
  console.log('[local-training-cancel] SKIP POSIX process-group test on Windows');
  process.exit(0);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'duck-worker-cancel-'));
const engine = path.join(root, 'engine.mjs');
await writeFile(
  engine,
  `import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.RDK_SIM2REAL_JOB_DIR + '/engine.pid', String(process.pid));
const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:'ignore'});
await writeFile(process.env.RDK_SIM2REAL_JOB_DIR + '/child.pid', String(descendant.pid));
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
`,
);
process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE = process.execPath;
process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON = JSON.stringify([engine]);
process.env.RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR = root;
process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = 'cancel-worker-test';
process.env.RDK_SIM2REAL_MAX_CONCURRENT_JOBS = '1';
process.env.NODE_ENV = 'development';
delete process.env.RDK_SIM2REAL_DEPLOYMENT;
delete process.env.RDK_STUDIO_DEPLOYMENT_PROFILE;
const { createLocalTrainingWorkerServer } = await import('./local-training-worker.mjs');
const server = createLocalTrainingWorkerServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = {
  authorization: 'Bearer cancel-worker-test',
  'x-sim2real-account': 'alice',
  'content-type': 'application/json',
};
const request = {
  schemaVersion: 1,
  accountId: 'alice',
  contractId: 'microduck-policy-v1',
  model: { modelId: 'microduck-walk', version: 'v1' },
  contract: { id: 'microduck-policy-v1', observationSize: 61, actionSize: 14 },
  training: { profile: 'smoke', maxIterations: 10 },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cancel = (id, options = {}) =>
  fetch(`${base}/runs/${id}/cancel`, { method: 'POST', headers, ...options });
let running, descendantPid;
try {
  running = await (
    await fetch(`${base}/train`, { method: 'POST', headers, body: JSON.stringify(request) })
  ).json();
  assert.ok(running.runId);
  // Authorization rejection must happen before revealing or altering the job.
  assert.equal((await cancel(running.runId, { headers: {} })).status, 401);
  assert.equal(
    (await cancel(running.runId, { headers: { ...headers, 'x-sim2real-account': 'bob' } })).status,
    404,
  );
  for (let i = 0; i < 80; i++) {
    try {
      descendantPid = Number(await readFile(path.join(root, running.runId, 'child.pid'), 'utf8'));
      break;
    } catch {
      await sleep(25);
    }
  }
  assert.ok(descendantPid, 'actual engine child must start');
  const secondOwner = { ...headers, 'x-sim2real-account': 'bob' };
  const queued = await (
    await fetch(`${base}/train`, {
      method: 'POST',
      headers: { ...secondOwner, 'idempotency-key': 'queued-cancel' },
      body: JSON.stringify({ ...request, accountId: 'bob' }),
    })
  ).json();
  assert.equal(queued.status, 'queued');
  assert.equal((await cancel(queued.runId)).status, 404);
  for (const subpath of ['', '/logs', '/artifact', '/telemetry']) {
    assert.equal(
      (await fetch(base + '/runs/' + running.runId + subpath, { headers: secondOwner })).status,
      404,
    );
  }
  const cancelledQueue = await cancel(queued.runId, { headers: secondOwner });
  assert.equal(cancelledQueue.status, 200);
  assert.equal((await cancelledQueue.json()).status, 'cancelled');
  assert.equal(
    (await (await cancel(queued.runId, { headers: secondOwner })).json()).status,
    'cancelled',
  );
  const ack = await cancel(running.runId);
  assert.equal(ack.status, 202);
  assert.equal((await ack.json()).status, 'cancelling');
  assert.equal((await (await cancel(running.runId)).json()).status, 'cancelling');
  let status;
  for (let i = 0; i < 160; i++) {
    status = await (await fetch(`${base}/runs/${running.runId}`, { headers })).json();
    if (status.status !== 'cancelling') break;
    await sleep(25);
  }
  assert.equal(status.status, 'cancelled', JSON.stringify(status));
  assert.ok(status.finishedAt);
  assert.equal(status.deployable, false);
  assert.equal(status.artifact, undefined);
  assert.throws(
    () => process.kill(descendantPid, 0),
    /ESRCH/,
    'cancellation must terminate descendants too',
  );
  const saved = JSON.parse(await readFile(path.join(root, running.runId, 'job.json'), 'utf8'));
  assert.equal(saved.status, 'cancelled');
  assert.equal((await (await cancel(running.runId)).json()).status, 'cancelled');
  const replay = await (
    await fetch(`${base}/train`, {
      method: 'POST',
      headers: { ...secondOwner, 'idempotency-key': 'queued-cancel' },
      body: JSON.stringify({ ...request, accountId: 'bob' }),
    })
  ).json();
  assert.equal(replay.runId, queued.runId);
  assert.equal(replay.status, 'cancelled');
  await assert.rejects(readFile(path.join(root, queued.runId, 'child.pid')), { code: 'ENOENT' });
  console.log(
    '[local-training-cancel] PASS: owned process tree stopped, queued work never launched, auth and repeat cancellation, durable terminal state',
  );
} finally {
  // Only this fixture's engine descendants are eligible for cleanup.
  if (running) {
    try {
      await cancel(running.runId);
    } catch {
      /* preserve test error */
    }
  }
  if (running) {
    try {
      const enginePid = Number(
        await readFile(path.join(root, running.runId, 'engine.pid'), 'utf8'),
      );
      if (Number.isSafeInteger(enginePid) && enginePid > 1) {
        try {
          process.kill(-enginePid, 'SIGKILL');
        } catch {
          process.kill(enginePid, 'SIGKILL');
        }
      }
    } catch {
      /* the fixture process has already exited */
    }
  }
  if (descendantPid) {
    try {
      process.kill(descendantPid, 'SIGKILL');
    } catch {
      /* already stopped */
    }
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
