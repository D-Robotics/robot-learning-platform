import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createSim2RealRouter } from './sim2real-routes.js';
import {
  createSim2RealModel,
  createSim2RealRun,
  invalidateSim2RealStoreCacheForTest,
  listSim2RealRuns,
} from '../sim2real/sim2real-store.js';
import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';

const roots: string[] = [];
const servers: http.Server[] = [];
const previousRoot = process.env.RDK_SIM2REAL_STORAGE_DIR;
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  invalidateSim2RealStoreCacheForTest();
  if (previousRoot === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousRoot;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-session-http-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
  manifest.modelId = 'experiment-fixture';
  const model = await createSim2RealModel(manifest, 'A');
  const run = await createSim2RealRun(
    { modelId: model.id, backend: 'contract', status: 'running', summary: 'fixture only' },
    'A',
  );
  const app = express();
  app.use(express.json());
  app.use(
    createSim2RealRouter(
      {
        auth: {
          isMultiUserDeployment: () => true,
          resolveAccessToken: () => null,
          resolvePrincipal: (request) =>
            request.headers['x-owner']
              ? {
                  accountId: String(request.headers['x-owner']),
                  roles: [String(request.headers['x-role'] ?? 'editor')],
                }
              : null,
        },
      },
      { prefix: '/api/v1/duck' },
    ),
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No fixture address');
  const base = `http://127.0.0.1:${address.port}/api/v1/duck/experiments`;
  const headers = { 'x-owner': 'A', 'content-type': 'application/json' };
  return { base, headers, run, server };
}
describe('experiment HTTP and event boundary', () => {
  it('registers references through the versioned API and resumes without creating a Run', async () => {
    const f = await fixture();
    const before = (await listSim2RealRuns('A')).length;
    const saved = await fetch(f.base, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ contextId: 'lesson', runId: f.run.id }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      ok: true,
      revision: 1,
      view: { training: { runId: f.run.id } },
    });
    const resumed = await fetch(f.base + '/lesson', { headers: f.headers });
    expect(resumed.headers.get('cache-control')).toBe('no-store');
    expect(await resumed.json()).toMatchObject({ ok: true, revision: 1 });
    expect((await listSim2RealRuns('A')).length).toBe(before);
  });
  it('requires authentication, isolates owners and denies viewer writes at the real common RBAC guard', async () => {
    const f = await fixture();
    const body = JSON.stringify({ contextId: 'lesson', runId: f.run.id });
    expect((await fetch(f.base, { method: 'POST', headers: f.headers, body })).status).toBe(200);
    expect((await fetch(f.base + '/lesson')).status).toBe(401);
    expect((await fetch(f.base + '/lesson', { headers: { 'x-owner': 'B' } })).status).toBe(404);
    const viewer = await fetch(f.base, {
      method: 'POST',
      headers: { ...f.headers, 'x-role': 'viewer' },
      body,
    });
    expect(viewer.status).toBe(403);
    expect(
      (await fetch(f.base + '/lesson', { headers: { ...f.headers, 'x-role': 'viewer' } })).status,
    ).toBe(200);
    expect(
      (await fetch(f.base + '/lesson', { headers: { ...f.headers, 'x-role': 'unknown' } })).status,
    ).toBe(403);
  });
  it('returns resumable SSE snapshots and closes cleanly on disconnect', async () => {
    const f = await fixture();
    await fetch(f.base, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ contextId: 'lesson', runId: f.run.id }),
    });
    const abort = new AbortController();
    const response = await fetch(f.base + '/lesson/events?after=0', {
      headers: f.headers,
      signal: abort.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('id: 1');
    expect(first).toContain('event: snapshot');
    expect(first).toContain(f.run.id);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    const resumedAbort = new AbortController();
    const resumed = await fetch(f.base + '/lesson/events', {
      headers: { ...f.headers, 'last-event-id': '1' },
      signal: resumedAbort.signal,
    });
    const resumedReader = resumed.body!.getReader();
    expect(new TextDecoder().decode((await resumedReader.read()).value)).toContain(': current');
    resumedAbort.abort();
    await resumedReader.cancel().catch(() => undefined);
  });
  it('does not accept a foreign future cursor or expose references in capability discovery', async () => {
    const f = await fixture();
    await fetch(f.base, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ contextId: 'lesson', runId: f.run.id }),
    });
    expect((await fetch(f.base + '/lesson/events?after=999', { headers: f.headers })).status).toBe(
      400,
    );
    expect((await fetch(f.base + '/lesson/events?after=-1', { headers: f.headers })).status).toBe(
      400,
    );
    const caps = await (await fetch(f.base + '/capabilities', { headers: f.headers })).json();
    expect(caps).toMatchObject({
      ok: true,
      schemaVersion: 1,
      ownerScoped: true,
      submission: false,
    });
    expect(JSON.stringify(caps)).not.toContain(f.run.id);
  });
});
