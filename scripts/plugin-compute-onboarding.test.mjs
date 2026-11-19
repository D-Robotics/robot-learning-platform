import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registerExistingWorker,
  readWorkerConnection,
} from '../plugins/rdk-robot-learning-platform/scripts/compute-onboarding.mjs';
import { developmentTargets } from '../plugins/rdk-robot-learning-platform/scripts/development-targets.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-registration-'));
  const file = path.join(root, 'worker.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      name: 'Test Worker',
      runnerUrl: 'https://worker.example.test/train',
      runnerToken: 'private-test-token',
    }),
    { mode: 0o600 },
  );
  return { file, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('registers an existing Worker and tests exactly the returned resource without exposing credentials', async () => {
  const f = fixture();
  try {
    let registered;
    const operations = [];
    const deps = {
      authentication: { status: async () => ({ authenticated: true, accountId: 'alice' }) },
      request: async (operation, args) => {
        operations.push(operation);
        assert.equal(args.accountId, 'alice');
        if (operation === 'compute') return { computeResources: registered ? [registered] : [] };
        if (operation === 'register-compute') {
          assert.equal(args.input.runnerToken, 'private-test-token');
          registered = { id: 'worker-a', name: args.input.name, runnerUrl: args.input.runnerUrl };
          return { computeResource: registered };
        }
        assert.equal(operation, 'test-compute');
        assert.equal(args.targetId, 'worker-a');
        return { connected: true, computeResource: { ...registered, engines: ['starter-ppo'] } };
      },
    };
    const args = { action: 'register-compute', connectionFile: f.file };
    const first = await developmentTargets(args, deps);
    const repeated = await developmentTargets(args, deps);
    assert.equal(first.computeResourceId, repeated.computeResourceId);
    assert.equal(first.connected, true);
    assert.deepEqual(operations, [
      'compute',
      'register-compute',
      'test-compute',
      'compute',
      'test-compute',
    ]);
    assert.ok(!JSON.stringify(first).includes('private-test-token'));
    assert.ok(!JSON.stringify(first).includes('worker.example.test'));
  } finally {
    f.close();
  }
});

test('refuses unsafe credential files and an account switch before a registration mutation', async () => {
  const f = fixture();
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(f.file, 0o644);
      assert.throws(() => readWorkerConnection(f.file), /私有常规文件/);
      fs.chmodSync(f.file, 0o600);
    }
    const linked = path.join(path.dirname(f.file), 'linked.json');
    fs.symlinkSync(f.file, linked);
    assert.throws(() => readWorkerConnection(linked));
    let calls = 0;
    await assert.rejects(
      registerExistingWorker(f.file, {
        authentication: {
          status: async () => ({ authenticated: true, accountId: ++calls === 1 ? 'alice' : 'bob' }),
        },
        request: async (operation) => {
          assert.equal(operation, 'compute');
          return { computeResources: [] };
        },
      }),
      /账号已变化/,
    );
  } finally {
    f.close();
  }
});

test('Studio deployment resumes by original ID, tests the original resource and reports unreachable workers honestly', async () => {
  const id = 'f'.repeat(64);
  const operations = [];
  let ready = false;
  const deps = {
    authentication: { status: async () => ({ authenticated: true, accountId: 'alice' }) },
    request: async (operation, args) => {
      operations.push(operation);
      assert.equal(args.accountId, 'alice');
      if (operation === 'deploy-compute') return { deploymentId: id, state: 'starting' };
      if (operation === 'deployment-status') {
        assert.equal(args.deploymentId, id);
        return {
          deploymentId: id,
          state: ready ? 'registered' : 'installing',
          computeResourceId: 'original',
        };
      }
      assert.equal(operation, 'test-compute');
      assert.equal(args.targetId, 'original');
      return { computeResource: { id: 'original', engines: ['starter-ppo'] }, connected: false };
    },
  };
  const start = await developmentTargets(
    {
      action: 'deploy-compute',
      targetId: 'studio-one',
      name: 'CPU',
      runnerUrl: 'https://worker.example.test/train',
    },
    deps,
  );
  assert.deepEqual(start.nextArguments, { action: 'deployment-status', deploymentId: id });
  const waiting = await developmentTargets(start.nextArguments, deps);
  assert.equal(waiting.state, 'installing');
  ready = true;
  const result = await developmentTargets(waiting.nextArguments, deps);
  assert.equal(result.computeResourceId, 'original');
  assert.equal(result.connected, false);
  assert.match(result.studentReply, /未通过/);
  assert.deepEqual(operations, [
    'deploy-compute',
    'deployment-status',
    'deployment-status',
    'test-compute',
  ]);
});

test('an account change after deployment polling never tests a resource under the replacement account', async () => {
  let accountId = 'alice';
  await assert.rejects(
    developmentTargets(
      { action: 'deployment-status', deploymentId: 'f'.repeat(64) },
      {
        authentication: { status: async () => ({ authenticated: true, accountId }) },
        request: async (operation) => {
          assert.equal(operation, 'deployment-status');
          accountId = 'bob';
          return {
            deploymentId: 'f'.repeat(64),
            state: 'registered',
            computeResourceId: 'original',
          };
        },
      },
    ),
    /账号已变化/,
  );
});

test('authenticated Studio adapter reconnects the original device and forwards its memory-only cookie after restart', async () => {
  const { connectAuthenticatedCore } =
    await import('../plugins/rdk-robot-learning-platform/scripts/authenticated-core.mjs');
  const id = 'f'.repeat(64);
  const device = {
    id: 'studio-one',
    provider: 'studio-local-bridge',
    bridgeDeviceId: 'native-one',
    host: 'fixture-host',
  };
  const seen = [];
  let connects = 0;
  const authentication = {
    audience: 'https://studio.example.test/robotics-learning',
    cookie: async () => 'account=fixture',
    status: async () => ({ authenticated: true, accountId: 'alice' }),
  };
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname.replace('/robotics-learning', '');
    seen.push([route, options.method, options.headers.cookie]);
    let value;
    const headers = { 'content-type': 'application/json' };
    if (route.endsWith('/device-connections')) value = { ok: true, studioDevices: [device] };
    else if (route.endsWith('/local-bridge/status'))
      value = { ok: true, bridges: [{ online: true, bridgeId: 'bridge-one', devices: [device] }] };
    else if (route.endsWith('/native-one/connect')) {
      connects++;
      assert.equal(JSON.parse(options.body).bridgeId, 'bridge-one');
      headers['set-cookie'] = 'rdk_studio_devices=private-fixture; HttpOnly; Secure; Path=/';
      value = { ok: true, device };
    } else if (route.endsWith('/deployments/' + id))
      value = { ok: true, deploymentId: id, deviceId: device.id };
    else if (route.endsWith('/deployments/' + id + '/poll')) {
      assert.match(options.headers.cookie, /account=fixture; rdk_studio_devices=private-fixture/);
      value = { ok: true, deploymentId: id, state: 'installing' };
    } else throw Error('unexpected route ' + route);
    return new Response(JSON.stringify(value), { headers });
  };
  for (let restart = 0; restart < 2; restart++) {
    const core = await connectAuthenticatedCore({
      authentication,
      fetchImpl,
      connect: () => ({ close: async () => {} }),
    });
    try {
      const result = await core.developmentTarget('deployment-status', {
        accountId: 'alice',
        deploymentId: id,
      });
      assert.equal(result.deploymentId, id);
      assert.equal(result.state, 'installing');
      assert.ok(!JSON.stringify(result).includes('private-fixture'));
    } finally {
      await core.close();
    }
  }
  assert.equal(connects, 2);
  assert.ok(!seen.some(([route]) => route.endsWith('/deployments')));
});
