import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import { createSim2RealRouter } from './sim2real-routes.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  delete process.env.RDK_DATA_DIR;
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-deployment-route-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
  process.env.RDK_DATA_DIR = path.join(root, 'data');
  await fs.mkdir(process.env.RDK_SIM2REAL_STORAGE_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.RDK_SIM2REAL_STORAGE_DIR, 'devices.json'), JSON.stringify([{
    id: 'board-1', host: '127.0.0.1', username: 'rdk', status: 'connected', lastCheckedAt: new Date().toISOString(), boardPlatform: 'rdk-x5',
  }]));
  return createSim2RealRouter();
}

async function invoke(router: ReturnType<typeof createSim2RealRouter>, method: string, routePath: string, input: Partial<Request> = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) throw new Error(`route not registered: ${method} ${routePath}`);
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const response = {
      statusCode: 200,
      body: undefined as any,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      json(body: unknown) { this.body = body; resolve(this); return this; },
    } as unknown as Response & { statusCode: number; body: any };
    handler({ body: {}, params: {}, query: {}, headers: {}, ...input } as Request, response, ((error?: unknown) => error && reject(error)) as NextFunction);
  });
}

describe('deployment lifecycle routes', () => {
  it('cancels a plan idempotently and records lifecycle evidence', async () => {
    const router = await fixture();
    const created = await invoke(router, 'post', '/api/sim2real/deployments', {
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, deviceId: 'board-1', mode: 'preflight' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.body.deployment.id;
    const cancelled = await invoke(router, 'post', '/api/sim2real/deployments/:id/cancel', { params: { id } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body.deployment.status).toBe('cancelled');
    expect(cancelled.body.deployment.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'created' }),
      expect.objectContaining({ type: 'cancelled' }),
    ]));
    const history = await invoke(router, 'get', '/api/sim2real/deployments/:id/history', { params: { id } });
    expect(history.statusCode).toBe(200);
    expect(history.body).toMatchObject({ ok: true, deploymentId: id, verification: null });
    const replay = await invoke(router, 'post', '/api/sim2real/deployments/:id/cancel', { params: { id } });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
  });
});
