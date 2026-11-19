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
