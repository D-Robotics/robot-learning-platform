import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { expect, it } from 'vitest';
import { setupDanceGoals } from './dance-goals.mjs';
import { wrapAsync } from './http-helpers.js';
import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { readFile } from 'node:fs/promises';

it('keeps driving without a client, starts each round once, and isolates experiments by account', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dance-goals-test-'));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const callerAuth = {
    isMultiUserDeployment: () => true,
    resolvePrincipal: (request: express.Request) => {
      const id = request.headers['x-test-user'];
      return typeof id === 'string' ? { accountId: id } : null;
    },
    resolveAccessToken: () => null,
  };
  const prefix = '/api/v1/duck';
  const submissions = new Map<string, Sim2RealRunRecord>();
  const ids = () => [...submissions.values()].map((r) => r.id);
  const worker = {
    id: 'c97b5541-ee8a-4393-8094-e4694e60bc6e',
    cuda: true,
    gpuName: 'NVIDIA RTX 4090',
    engines: ['originman-dance-ppo'],
    mock: false,
  };
  const manifest = JSON.parse(
    await readFile(
      new URL(
        '../../plugins/rdk-robot-learning-platform/references/originman-dance-manifest.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const contractId = manifest.contract.id;
  const { auth, register } = setupDanceGoals({
    callerAuth,
    prefix,
    storageDirectory: directory,
    defaultPort: 18102,
    async findRun(key, owner) {
      const run = submissions.get(key);
      return run && owner === 'owner' ? { run } : null;
    },
  });
  const readOwner = (request: express.Request, response: express.Response) => {
    const p = auth.resolvePrincipal(request);
    if (p) return p.accountId;
    response.status(401).json({ ok: false });
    return null;
  };
  register(router, readOwner, wrapAsync);
  const guarded =
    (handler: (req: express.Request, res: express.Response) => void): express.RequestHandler =>
    (req, res) => {
      if (readOwner(req, res) === 'owner') handler(req, res);
      else if (!res.headersSent) res.status(403).end();
    };
  router.post(
    prefix + '/models/validate',
    guarded((_, res) => res.json({ ok: true, validation: { valid: true } })),
  );
  router.get(
    prefix + '/models',
    guarded((_, res) => res.json({ ok: true, models: [{ id: 'model', manifest }] })),
  );
  router.get(
    prefix + '/compute-resources',
    guarded((_, res) => res.json({ ok: true, computeResources: [worker] })),
  );
  router.post(
    prefix + '/compute-resources/:id/test',
    guarded((_, res) => res.json({ ok: true, connected: true, computeResource: worker })),
  );
  router.post(
    prefix + '/runs',
    guarded((req, res) => {
      const key = String(req.headers['idempotency-key']);
      expect(key).toMatch(/^auto-[a-f0-9]{19}-train$/);
      expect(submissions.has(key)).toBe(false);
      expect(req.body.training.numEnvs).toBe(64);
      const { originmanDance } = req.body.training;
      const run = {
        ...req.body,
        id: 'run-' + (submissions.size + 1),
        status: 'completed',
        mock: false,
        contractId,
        artifact: { format: 'onnx', sha256: 'a'.repeat(64) },
        metrics: {
          trainingDevice: 'cuda',
          trainingDeviceName: worker.gpuName,
          trainingSteps: Math.ceil(originmanDance.trainingSteps / 4096) * 4096,
          originmanDance: {
            qualityGatePassed: false,
            sceneProvenance: { sceneSha256: 'b'.repeat(64) },
            evaluations: [95, 100, 105].map((bpm) => ({
              bpm,
              sections: [
                {
                  type: 'weight-shift',
                  clean: true,
                  passed: false,
                  stylePassed: false,
                  measurements: { lateralRangeM: 0.01, lateralTrackingFraction: 0.1 },
                },
              ],
            })),
          },
        },
      } as Sim2RealRunRecord;
      submissions.set(key, run);
      res.status(201).json({ ok: true, run });
    }),
  );
  router.get(
    prefix + '/runs/:id',
    guarded((req, res) =>
      res.json({
        ok: true,
        run: [...submissions.values()].find((r) => r.id === req.params.id),
      }),
    ),
  );
  router.get(
    prefix + '/runs/:id/dance-evaluation',
    guarded((req, res) => {
      const run = [...submissions.values()].find((r) => r.id === req.params.id)!;
      res.json({
        ok: true,
        evaluation: {
          ...run.metrics?.originmanDance,
          source: {
            runId: run.id,
            policySha256: 'a'.repeat(64),
            sceneSha256: 'b'.repeat(64),
            contractId,
          },
        },
      });
    }),
  );
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Unexpected server address');
  const base = `http://127.0.0.1:${address.port}${prefix}`;
  const draft = {
    contextId: 'first-goal',
    totalSteps: 524288,
    computeResourceId: worker.id,
    dance: {
      schemaVersion: 1,
      title: '换重心',
      bpm: 100,
      sections: [{ type: 'weight-shift', beats: 8, intensity: 0.9 }],
    },
  };
  const post = (body: unknown) =>
    fetch(base + '/dance-goals', {
      method: 'POST',
      headers: { 'x-test-user': 'owner', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const first = await post(draft);
    expect(first.status).toBe(202);
    expect((await first.json()).goal.id).toBe('first-goal');
    const duplicate = await post({ ...draft, contextId: 'repeat-after-reopen' });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).goal.id).toBe('first-goal');
    expect((await post({ ...draft, totalSteps: 528384 })).status).toBe(409);
    await expect.poll(() => ids().length, { timeout: 12000 }).toBe(3);
    // The queue has finished all training without fetching the goal from any browser.
    await expect
      .poll(
        async () => {
          const response = await fetch(base + '/dance-goals/first-goal', {
            headers: { 'x-test-user': 'owner' },
          });
          const data = await response.json();
          return data.goal?.state;
        },
        { timeout: 7000 },
      )
      .toBe('budget-exhausted');
    expect(
      (await fetch(base + '/dance-goals/first-goal', { headers: { 'x-test-user': 'other' } }))
        .status,
    ).toBe(404);
    expect((await fetch(base + '/dance-goals/first-goal')).status).toBe(401);
    const done = await (await post(draft)).json();
    expect(done.goal.remainingSteps).toBe(4096);
    expect(done.goal.rounds[1].change).toMatch(/3.4 → 3.8/);
    expect(ids()).toEqual(['run-1', 'run-2', 'run-3']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 24000);
