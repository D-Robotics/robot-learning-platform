import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { expect, it, vi } from 'vitest';
import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { registerResimulatedDanceVideoRoute } from './resimulated-dance-video-routes.js';

it('serves a separate verified replay to the Run owner only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'resimulated-dance-video-'));
  const dir = path.join(root, 'resimulated-dance-videos');
  const runId = 'f0e78d16-c20f-4dc4-998e-9ad1df1d8741';
  const originalReplaySha256 = 'a'.repeat(64);
  const policySha256 = 'b'.repeat(64);
  const run = {
    id: runId,
    status: 'completed',
    mock: false,
    taskId: 'originman-dance',
    artifact: { sha256: policySha256 },
    metrics: { originmanDance: { replay: { sha256: originalReplaySha256 } } },
  } as Sim2RealRunRecord;
  const bytes = Buffer.from('simulated MP4 bytes');
  const videoSha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    source: 'resimulated-onnx',
    runId,
    policySha256,
    originalReplaySha256,
    replaySha256: 'c'.repeat(64),
    sceneSha256: 'd'.repeat(64),
    videoSha256,
    sizeBytes: bytes.length,
  };
  vi.stubEnv('RDK_SIM2REAL_STORAGE_DIR', root);
  const app = express();
  registerResimulatedDanceVideoRoute(app, {
    prefix: '/api',
    requestOwner(request, response) {
      const owner = request.get('test-owner');
      if (owner) return owner;
      response.status(401).end();
      return null;
    },
    async getRun(id, owner) {
      return id === runId && owner === 'owner' ? run : null;
    },
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP port');
    const url = `http://127.0.0.1:${address.port}/api/runs/${runId}/resimulated-dance-video`;
    const headers = { 'test-owner': 'owner' };
    await mkdir(dir);
    const manifestPath = path.join(dir, `${runId}.json`);
    const videoPath = path.join(dir, `${videoSha256}.mp4`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(videoPath, bytes);

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { 'test-owner': 'other' } })).status).toBe(404);
    const head = await fetch(url, { headers, method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('x-replay-source')).toBe('resimulated-onnx');
    const range = await fetch(url, { headers: { ...headers, range: 'bytes=0-3' } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('simu');

    await writeFile(manifestPath, JSON.stringify({ ...manifest, policySha256: 'e'.repeat(64) }));
    expect((await fetch(url, { headers })).status).toBe(404);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(videoPath, Buffer.alloc(bytes.length));
    expect((await fetch(url, { headers })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
