import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { registerHostedDatasetRoutes } from './sim2real-hosted-dataset-routes.js';
import { updateSim2RealDatasetStatus } from '../sim2real/sim2real-store.js';

let root: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test('hosts immutable bytes with owner-scoped downloads, deduplication and integrity checks', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'rdk-hosted-data-'));
  vi.stubEnv('RDK_SIM2REAL_STORAGE_DIR', root);
  const app = express();
  const router = express.Router();
  registerHostedDatasetRoutes(
    router,
    {
      requestOwner(request, response) {
        const owner = request.get('x-test-identity');
        if (owner) return owner;
        response.status(401).end();
        return null;
      },
      storageError(_request, response, error) {
        response.status(500).json({ error: String(error) });
      },
    },
    '/api',
    (input) => ({ value: { name: String(input.name), version: String(input.version) } }),
  );
  app.use(router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing HTTP address');
  const base = 'http://127.0.0.1:' + address.port + '/api/datasets/';
  const one = { 'x-test-identity': 'owner-one' };
  const payload = Buffer.from('obs,action\n1,2\n');
  const upload = (body: Buffer, name = 'test') =>
    fetch(
      base +
        'upload?' +
        new URLSearchParams({
          name,
          version: 'v1',
          filename: '示教数据.csv',
        }),
      { method: 'POST', headers: { ...one, 'content-type': 'application/octet-stream' }, body },
    );

  const first = await upload(payload);
  expect(first.status).toBe(201);
  const { dataset } = await first.json();
  const sha = createHash('sha256').update(payload).digest('hex');
  expect(dataset.sha256).toBe(sha);
  expect(dataset.sizeBytes).toBe(payload.length);
  const again = await upload(payload);
  expect(again.status).toBe(200);
  expect((await again.json()).dataset.id).toBe(dataset.id);
  expect((await upload(Buffer.from('changed'))).status).toBe(409);
  expect((await upload(Buffer.alloc(0), 'empty')).status).toBe(400);

  const url = base + dataset.id + '/file';
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { 'x-test-identity': 'owner-two' } })).status).toBe(404);
  const download = await fetch(url, { headers: one });
  expect(download.headers.get('x-dataset-sha256')).toBe(sha);
  expect(download.headers.get('content-disposition')).toMatch(/^attachment/);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(payload);
  const folder = path.join(root, 'hosted-datasets');
  const ownerFolder = path.join(folder, (await readdir(folder))[0]);
  expect(await readdir(ownerFolder)).toEqual([sha + '.bin']);
  await writeFile(path.join(ownerFolder, sha + '.bin'), Buffer.alloc(payload.length));
  expect((await fetch(url, { headers: one })).status).toBe(409);
  await updateSim2RealDatasetStatus(dataset.id, 'revoked', 'owner-one');
  expect((await fetch(url, { headers: one })).status).toBe(404);
});
