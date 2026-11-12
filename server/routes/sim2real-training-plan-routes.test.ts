import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import express from 'express';
import { createSim2RealRouter } from './sim2real-routes.js';

test('plans survive server recreation, isolate owners and never submit runs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sim2real-training-plans-'));
  const previous = process.env.RDK_SIM2REAL_STORAGE_DIR;
  process.env.RDK_SIM2REAL_STORAGE_DIR = dir;
  let runWrites = 0;
  const open = async () => {
    const app = express();
    app.use(express.json());
    const prefix = '/api/v1/duck';
    app.post(prefix + '/runs', (_req, res) => {
      runWrites++;
      res.sendStatus(500);
    });
    app.use(
      createSim2RealRouter(
        {
          auth: {
            isMultiUserDeployment: () => true,
            resolveAccessToken: () => null,
            resolvePrincipal: (req) => {
              const owner = req.header('x-fixture-account');
              return owner
                ? { accountId: owner, roles: [req.header('x-fixture-role') || 'operator'] }
                : null;
            },
          },
        },
        { prefix },
      ),
    );
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const root = 'http://127.0.0.1:' + addr.port + prefix + '/training-plans';
    return { server, root };
  };
  let { server, root } = await open();
  async function call(
    method: string,
    suffix = '',
    body?: object,
    owner = 'alice',
    role = 'operator',
  ) {
    const response = await fetch(root + suffix, {
      method,
      headers: {
        'x-fixture-account': owner,
        'x-fixture-role': role,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return [response.status, await response.json().catch(() => null)] as const;
  }
  const config = {
    productId: 'originman',
    training: { profile: 'smoke', algorithm: 'ppo', numEnvs: 8, maxIterations: 4 },
  };
  try {
    assert.equal((await call('GET', '', undefined, ''))[0], 401);
    assert.equal((await call('POST', '', { name: '禁止写入', config }, 'alice', 'viewer'))[0], 403);
    const [, saved] = await call('POST', '', { name: 'PPO 快检', config });
    assert.equal(saved.trainingSubmitted, false);
    assert.deepEqual(saved.plan.config, config);
    const id = '/' + saved.plan.id;
    assert.equal((await call('GET', id, undefined, 'bob'))[0], 404);
    assert.deepEqual((await call('GET', '', undefined, 'bob'))[1].plans, []);
    assert.equal((await call('PUT', id, { name: '禁止覆盖', config, revision: 1 }, 'bob'))[0], 404);
    assert.equal((await call('POST', '', { name: 'PPO 快检', config }))[0], 409);
    assert.equal(
      (await call('POST', '', { name: '恶意字段', config: { ...config, token: 'x' } }))[0],
      400,
    );
    const [, copied] = await call('POST', '', {
      name: 'SAC 正式',
      config: { ...config, training: { ...config.training, algorithm: 'sac' } },
    });
    assert.notEqual(copied.plan.id, saved.plan.id);
    const competing = await Promise.all([
      call('PUT', id, { name: 'PPO 快检 A', config, revision: 1 }),
      call('PUT', id, { name: 'PPO 快检 B', config, revision: 1 }),
    ]);
    assert.deepEqual(competing.map(([code]) => code).sort(), [200, 409]);
    assert.equal(runWrites, 0);
    server.close();
    await once(server, 'close');
    ({ server, root } = await open());
    const [, list] = await call('GET');
    assert.equal(list.plans.length, 2);
    assert.equal((await call('GET', id))[1].plan.revision, 2);
    assert.equal(
      (await call('GET', '/' + copied.plan.id))[1].plan.config.training.algorithm,
      'sac',
    );
  } finally {
    server.close();
    await once(server, 'close');
    if (previous === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
    else process.env.RDK_SIM2REAL_STORAGE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
