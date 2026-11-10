import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it, expect } from 'vitest';
import { createSim2RealRouter } from './sim2real-routes.js';
import {
  createSim2RealComputeResource,
  invalidateSim2RealStoreCacheForTest,
} from '../sim2real/sim2real-store.js';
it('workshop routes use normal authentication, viewer mutation denial and isolated account state', async () => {
  const previous = process.env.RDK_SIM2REAL_STORAGE_DIR,
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-rbac-'));
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  const app = express();
  app.use(express.json());
  app.use(
    createSim2RealRouter(
      {
        auth: {
          isMultiUserDeployment: () => true,
          resolveAccessToken: () => null,
          resolvePrincipal: (r) =>
            r.headers['x-owner']
              ? {
                  accountId: String(r.headers['x-owner']),
                  roles: [String(r.headers['x-role'] ?? 'editor')],
                }
              : null,
        },
      },
      { prefix: '/api/v1/duck' },
    ),
  );
  app.get('/api/v1/duck/workshops/originman', (_r, s) =>
    s.json({ ok: true, course: 'existing-course' }),
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base =
    'http://127.0.0.1:' +
    (server.address() as { port: number }).port +
    '/api/v1/duck/workshop-sessions';
  try {
    expect((await fetch(base)).status).toBe(401);
    expect(
      await (
        await fetch(base.replace('/workshop-sessions', '/workshops/originman'), {
          headers: { 'x-owner': 'A' },
        })
      ).json(),
    ).toMatchObject({ course: 'existing-course' });
    for (const suffix of [
      '',
      '/setup',
      '/ws-test/claim/train',
      '/ws-test/select',
      '/ws-test/pause',
      '/ws-test/continue',
      '/ws-test/reference',
    ]) {
      const r = await fetch(base + suffix, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-owner': 'A', 'x-role': 'viewer' },
        body: '{}',
      });
      expect(r.status).toBe(403);
    }
    const empty = await fetch(base, { headers: { 'x-owner': 'A' } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ sessions: [], experiments: [], current: null });
    const setup = base + '/setup';
    expect((await fetch(setup)).status).toBe(401);
    const gpu = await createSim2RealComputeResource(
      {
        name: 'Course GPU',
        engines: ['originman-recovery-reflect'],
        kind: 'local-gpu',
        source: 'server-runner',
        runnerUrl: 'http://127.0.0.1:12345/train',
        runnerToken: 'private',
        status: 'unknown',
      },
      'A',
    );
    const headers = { 'content-type': 'application/json', 'x-owner': 'A' };
    await createSim2RealComputeResource(
      {
        name: 'Incompatible GPU',
        kind: 'local-gpu',
        source: 'server-runner',
        runnerUrl: 'http://127.0.0.1:12346/train',
        runnerToken: 'private',
        status: 'online',
        engines: ['microduck-rl'],
      },
      'A',
    );
    const options = await (await fetch(setup, { headers })).json();
    expect(options.resources).toHaveLength(1);
    expect(options).toMatchObject({ accountId: 'A', resources: [{ id: gpu.id, name: gpu.name }] });
    expect(Object.keys(options.resources[0]).sort()).toEqual(['engines', 'id', 'name', 'status']);
    const select = (accountId: string, owner: string) =>
      fetch(setup, {
        method: 'POST',
        headers: { ...headers, 'x-owner': owner },
        body: JSON.stringify({ accountId, computeResourceId: gpu.id }),
      });
    expect((await select('A', 'B')).status).toBe(400);
    expect((await select('B', 'B')).status).toBe(404);
    const draft = await (await select('A', 'A')).json();
    expect(draft).toMatchObject({
      session: { computeResourceId: gpu.id, stage: 'ready', training: null, evaluation: null },
    });
    const next = await (await select('A', 'A')).json();
    expect(next.session.modelId).toBe(draft.session.modelId);
    expect(next.session.contextId).not.toBe(draft.session.contextId);
    const foreign = await fetch(base + '/ws-00000000000000000000', { headers: { 'x-owner': 'B' } });
    expect(foreign.status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    invalidateSim2RealStoreCacheForTest();
    if (previous === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
    else process.env.RDK_SIM2REAL_STORAGE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
