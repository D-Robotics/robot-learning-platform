/** Protocol/security fixture only: the bytes below are not an RL policy or a physical replay. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'originman-worker-fixture-'));
const previous = { ...process.env };
const engine = path.join(directory, 'fixture.mjs');
await writeFile(
  engine,
  `
import {writeFile} from 'node:fs/promises'; import {createHash} from 'node:crypto';
const policy=Buffer.from('fixture-policy-only'), video=Buffer.from('fixture-replay-only');
const digest=b=>createHash('sha256').update(b).digest('hex');
await writeFile('policy.onnx',policy); await writeFile('comparison.mp4',video);
await writeFile('SHA256SUMS',digest(policy)+'  policy.onnx\\n'+digest(video)+'  comparison.mp4\\n');
await writeFile(process.env.RDK_SIM2REAL_RESULT_FILE,JSON.stringify({artifact:{artifactId:'fixture-policy',ref:'artifact://fixture/originman/policy.onnx',kind:'source',format:'onnx'},metrics:{contractValid:true,observationSize:14,actionSize:2,originmanWorkshop:{video:{sha256:digest(video),bytes:video.length}}},deployable:false}));
`,
);
Object.assign(process.env, {
  NODE_ENV: 'test',
  RDK_SIM2REAL_DEPLOYMENT: 'local',
  RDK_SIM2REAL_LOCAL_WORKER_HOST: '127.0.0.1',
  RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR: path.join(directory, 'jobs'),
  RDK_SIM2REAL_LOCAL_RUNNER_TOKEN: 'originman-worker-protocol-fixture-token-2026',
  RDK_SIM2REAL_TRAIN_ENGINES_JSON: JSON.stringify({
    'originman-recovery': { executable: process.execPath, args: [engine] },
  }),
});
const { createLocalTrainingWorkerServer } = await import('./local-training-worker.mjs');
const server = createLocalTrainingWorkerServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = {
  authorization: 'Bearer originman-worker-protocol-fixture-token-2026',
  'x-sim2real-account': 'alice',
};
try {
  const response = await fetch(`${base}/train`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      'idempotency-key': 'workshop-fixture',
    },
    body: JSON.stringify({
      schemaVersion: 1,
      contractId: 'custom-policy-originman-recovery-v1',
      contract: { id: 'custom-policy-originman-recovery-v1', observationSize: 14, actionSize: 2 },
      model: { modelId: 'originman-fixture', version: 'v1' },
      training: { profile: 'smoke', engine: 'originman-recovery' },
    }),
  });
  assert.equal(response.status, 202);
  const launched = await response.json();
  let terminal;
  for (let i = 0; i < 100; i++) {
    terminal = await (await fetch(`${base}/runs/${launched.runId}`, { headers })).json();
    if (['completed', 'failed'].includes(terminal.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(terminal.status, 'completed', JSON.stringify(terminal));
  const url = `${base}/runs/${launched.runId}/workshop-video`;
  assert.equal(
    (await fetch(url, { headers: { ...headers, 'x-sim2real-account': 'bob' } })).status,
    404,
  );
  const replay = await fetch(url, { headers });
  assert.equal(replay.status, 200);
  assert.equal(await replay.text(), 'fixture-replay-only');
  assert.equal(
    replay.headers.get('x-artifact-sha256'),
    terminal.metrics.originmanWorkshop.video.sha256,
  );
  await writeFile(
    path.join(directory, 'jobs', launched.runId, 'comparison.mp4'),
    Buffer.alloc('fixture-replay-only'.length),
  );
  const tampered = await fetch(url, { headers });
  assert.equal(tampered.status, 409);
  assert.equal((await tampered.json()).error, 'workshop_video_digest_mismatch');
  console.log(
    '[originman-workshop-worker] PASS — scoped video read and altered bytes refused (protocol fixture, not RL evidence)',
  );
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  process.env = previous;
  await rm(directory, { recursive: true, force: true });
}
