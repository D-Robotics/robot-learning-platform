/** Opt-in Linux acceptance: isolated ledger and owned Worker, synthetic Studio transport.
 * Build first; run with RDK_SSH_ACCEPTANCE=1. Does not use real Studio credentials or robots.
 */
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { registerComputeSshRoutes } from '../dist-server/server/routes/sim2real-compute-ssh-routes.js';
import { getSim2RealComputeResourceSecret } from '../dist-server/server/sim2real/sim2real-store.js';
import { probeComputeWorker } from '../dist-server/server/sim2real/compute-worker-health.js';
import { connectAuthenticatedCore } from '../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs';
import { developmentTargets } from '../plugins/rdk-robot-learning-platform/scripts/development-targets.mjs';
assert.equal(process.platform, 'linux');
assert.equal(process.env.RDK_SSH_ACCEPTANCE, '1');
const execute = promisify(execFile);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-worker-ledger-'));
process.env.RDK_SIM2REAL_STORAGE_DIR = scratch;
const owner = 'fixture-' + randomUUID();
const device = {
  id: 'fixture-studio',
  host: '127.0.0.1',
  bridgeDeviceId: 'native-fixture',
  provider: 'studio-local-bridge',
  name: 'Isolated Linux',
};
let deploymentId, server, core;
let installations = 0,
  checks = 0,
  connects = 0;
const app = express();
app.use(express.json());
app.get('/api/v1/duck/device-connections', (_q, r) =>
  r.json({ ok: true, studioDevices: [device] }),
);
app.get('/api/v1/duck/local-bridge/status', (_q, r) =>
  r.json({ ok: true, bridges: [{ bridgeId: 'fixture-bridge', online: true, devices: [device] }] }),
);
app.post('/api/v1/duck/local-bridge/devices/native-fixture/connect', (_q, r) => {
  connects++;
  r.setHeader('set-cookie', 'rdk_studio_devices=isolated-only; HttpOnly; Secure; Path=/');
  r.json({ ok: true, device });
});
app.post('/api/sim2real/compute-resources/:id/test', async (q, r) => {
  const secret = await getSim2RealComputeResourceSecret(q.params.id, owner);
  assert.ok(secret);
  const checked = await probeComputeWorker(secret.resource.runnerUrl, secret.runnerToken);
  r.json({
    ok: true,
    connected: !!checked.payload,
    computeResource: { ...secret.resource, ...checked.payload },
    diagnostic: checked.diagnostic,
  });
});
const router = express.Router();
registerComputeSshRoutes(
  router,
  {
    owner: (q, r) => {
      if (!q.headers.cookie?.includes('fixture-account')) {
        r.sendStatus(401);
        return null;
      }
      return owner;
    },
    device: async (q, r, account, id) => {
      assert.equal(account, owner);
      assert.equal(id, device.id);
      assert.ok(q.headers.cookie?.includes('rdk_studio_devices=isolated-only'));
      return device;
    },
    execute: async (_q, _r, selected, command) => {
      assert.equal(selected, device);
      assert.ok(command.length < 4000);
      const isInstall = Buffer.from(/b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(command)[1], 'base64')
        .toString()
        .includes('cfg=root/');
      if (isInstall) installations++;
      else checks++;
      const env = { ...process.env, XDG_RUNTIME_DIR: path.join(scratch, 'no-user-manager') };
      delete env.DBUS_SESSION_BUS_ADDRESS;
      const result = await execute('/bin/bash', ['-c', command], {
        env,
        timeout: 45000,
        maxBuffer: 16384,
      });
      return result.stdout;
    },
    bundleOrigin: () => `http://127.0.0.1:${server.address().port}`,
  },
  '/api/v1/duck',
);
app.use(router);
const authentication = {
  audience: '',
  cookie: async () => 'fixture-account=isolated',
  status: async () => ({ authenticated: true, accountId: owner }),
};
const makeCore = () =>
  connectAuthenticatedCore({ authentication, connect: () => ({ close: async () => {} }) });
try {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  authentication.audience = `http://127.0.0.1:${server.address().port}`;
  core = await makeCore();
  const deps = () => ({ authentication, request: (op, args) => core.developmentTarget(op, args) });
  const list = await developmentTargets({ action: 'list-ssh' }, deps());
  assert.equal(list.devices[0].id, device.id);
  const args = {
    action: 'deploy-compute',
    targetId: device.id,
    name: 'Isolated CPU',
    runnerUrl: 'http://127.0.0.1:18881/train',
    port: 18881,
  };
  const started = await developmentTargets(args, deps());
  deploymentId = started.deploymentId;
  assert.equal(started.state, 'starting');
  await core.close();
  core = await makeCore(); // new plugin process memory, reconnect original Studio device
  let result;
  for (let i = 0; i < 600; i++) {
    result = await developmentTargets({ action: 'deployment-status', deploymentId }, deps());
    if (result.state === 'registered') break;
    assert.ok(['starting', 'installing'].includes(result.state), JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.equal(result.state, 'registered');
  assert.equal(result.connected, true);
  assert.ok(result.engines.includes('starter-ppo'));
  const repeated = await developmentTargets({ action: 'deployment-status', deploymentId }, deps());
  assert.equal(repeated.computeResourceId, result.computeResourceId);
  assert.equal(installations, 1);
  assert.ok(connects > 1);
  const deploymentRoot = path.join(os.homedir(), '.local/share/rdk-learning/workers', deploymentId);
  const originalProcess = await fs.readFile(path.join(deploymentRoot, 'process.json'), 'utf8');
  const originalSecret = await fs.readFile(path.join(deploymentRoot, 'worker-secret.json'), 'utf8');
  const retry = await developmentTargets(args, deps());
  assert.equal(retry.deploymentId, deploymentId);
  const recovered = await developmentTargets({ action: 'deployment-status', deploymentId }, deps());
  assert.equal(recovered.computeResourceId, result.computeResourceId);
  assert.equal(recovered.connected, true);
  assert.equal(
    await fs.readFile(path.join(deploymentRoot, 'process.json'), 'utf8'),
    originalProcess,
  );
  assert.equal(
    await fs.readFile(path.join(deploymentRoot, 'worker-secret.json'), 'utf8'),
    originalSecret,
  );
  const secret = await getSim2RealComputeResourceSecret(result.computeResourceId, owner);
  assert.ok(!JSON.stringify(result).includes(secret.runnerToken));
  const headers = {
    authorization: 'Bearer ' + secret.runnerToken,
    'content-type': 'application/json',
    'x-sim2real-account': owner,
    'idempotency-key': 'isolated-smoke',
  };
  const request = {
    schemaVersion: 1,
    contractId: 'rdk-duck-policy-starter-v1',
    contract: {
      id: 'rdk-duck-policy-starter-v1',
      robotId: 'rdk-duck',
      jointCount: 12,
      observationSize: 42,
      actionSize: 12,
      controlHz: 50,
      physicsTimestepSeconds: 0.002,
      decimation: 10,
    },
    model: { modelId: 'starter-ppo-gate', version: '0.1.0-gate' },
    training: {
      engine: 'starter-ppo',
      profile: 'smoke',
      numEnvs: 4,
      maxIterations: 2,
      video: false,
    },
  };
  const response = await fetch(secret.resource.runnerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  const initial = await response.json();
  assert.ok(response.ok, JSON.stringify(initial));
  let job = initial;
  for (let i = 0; i < 180; i++) {
    job = await (await fetch('http://127.0.0.1:18881/runs/' + initial.runId, { headers })).json();
    if (['completed', 'failed'].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(job.status, 'completed', JSON.stringify(job));
  assert.equal(job.mock, false);
  assert.equal(job.artifact.format, 'onnx');
  assert.equal(job.deployable, false);
  const bytes = Buffer.from(
    await (
      await fetch('http://127.0.0.1:18881/runs/' + initial.runId + '/artifact', { headers })
    ).arrayBuffer(),
  );
  assert.equal(createHash('sha256').update(bytes).digest('hex'), job.artifact.sha256);
  const report = {
    ok: true,
    scope:
      'isolated Linux, mocked Studio transport, actual fixed SSH bootstrap, dependency installation, encrypted receipt, plugin restart, registration, real health probe and CPU training',
    deploymentId,
    resourceId: result.computeResourceId,
    installationRequests: installations,
    workerStarts: 1,
    checks,
    connects,
    runId: job.runId,
    artifactSha256: job.artifact.sha256,
    artifactBytes: bytes.length,
    engine: 'starter-ppo',
    trainingDevice: 'cpu',
    mock: false,
    deployable: false,
  };
  await fs.writeFile('acceptance-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (core) await core.close();
  if (deploymentId) {
    const root = path.join(os.homedir(), '.local/share/rdk-learning/workers', deploymentId);
    try {
      const process = JSON.parse(await fs.readFile(path.join(root, 'process.json')));
      if (process.pid) {
        const cmd = await fs.readFile('/proc/' + process.pid + '/cmdline', 'utf8');
        assert.ok(cmd.includes(path.join(root, 'worker.mjs')));
        globalThis.process.kill(process.pid, 'SIGTERM');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('Owned acceptance Worker cleanup failed.');
        process.exitCode = 1;
      }
    }
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
