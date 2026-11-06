import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { createExperimentSessions } from '../sim2real/experiment-sessions.js';
import { createWorkshopSessions } from '../sim2real/workshop-session.js';
import { registerSim2RealExperimentRoutes } from './sim2real-experiment-routes.js';

const { runs, keys } = vi.hoisted(() => ({
  runs: new Map<string, unknown>(),
  keys: new Map<string, unknown>(),
}));
vi.mock('../sim2real/sim2real-store.js', () => ({
  getSim2RealRun: async (id: string, owner: string) =>
    owner === 'A' ? (runs.get(id) ?? null) : null,
  findSim2RealRunByIdempotency: async (key: string, owner: string) =>
    owner === 'A' && keys.has(key) ? { run: keys.get(key) } : null,
}));

it('restores the already-submitted evaluation when opening the result link before the course refreshes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-direct-results-'));
  const previous = process.env.RDK_SIM2REAL_STORAGE_DIR;
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  const { getSim2RealRun, findSim2RealRunByIdempotency } =
    await import('../sim2real/sim2real-store.js');
  const deps = { root: () => root, getRun: getSim2RealRun };
  const experiments = createExperimentSessions(deps);
  const course = createWorkshopSessions({
    ...deps,
    findRun: async (key, owner) => (await findSim2RealRunByIdempotency(key, owner))?.run ?? null,
    remember: experiments.remember,
  });
  const app = express();
  registerSim2RealExperimentRoutes(
    app,
    {
      requestOwner: (request) => String(request.headers['x-owner'] ?? 'A'),
    },
    { prefix: '/api/v1/duck' },
  );
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const draft = await course.create({ modelId: 'm', computeResourceId: 'r' }, 'A');
    const context = draft.contextId;
    const train = await course.claim(
      context,
      'train',
      {
        timesteps: 8192,
        seed: 7,
        pushMaxForce: 8.1,
        reference: 'skipped',
      },
      'A',
    );
    const digest = 'a'.repeat(64);
    const trained = {
      ...train.submission,
      id: 'training',
      status: 'completed',
      mock: false,
      metrics: { originmanWorkshop: { phase: 'train', policySha256: digest } },
    };
    runs.set(trained.id, trained);
    keys.set(train.submission.idempotencyKey, trained);
    const evaluate = await course.claim(context, 'evaluate', {}, 'A');
    const evaluated = {
      ...evaluate.submission,
      id: 'evaluation',
      status: 'completed',
      mock: false,
      metrics: {
        originmanWorkshop: { phase: 'evaluate', sourceRunId: trained.id, policySha256: digest },
      },
    };
    runs.set(evaluated.id, evaluated);
    keys.set(evaluate.submission.idempotencyKey, evaluated);

    const url =
      'http://127.0.0.1:' +
      (server.address() as AddressInfo).port +
      '/api/v1/duck/experiments/' +
      context;
    expect((await fetch(url, { headers: { 'x-owner': 'B' } })).status).toBe(404);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect((await response.json()).view).toMatchObject({
      associationVerified: true,
      stage: 'results',
      evaluation: { runId: evaluated.id },
    });
    expect(runs.size).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
    else process.env.RDK_SIM2REAL_STORAGE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
