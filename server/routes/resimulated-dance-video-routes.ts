import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response, Router } from 'express';
import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import { wrapAsync } from '../sim2real/http-helpers.js';

const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function readBoundedFile(file: string, maxBytes: number, expectedBytes?: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maxBytes ||
      (expectedBytes !== undefined && stat.size !== expectedBytes)
    )
      return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readResimulatedVideo(run: Sim2RealRunRecord) {
  const root = process.env.RDK_SIM2REAL_STORAGE_DIR?.trim();
  const dance = run.metrics?.originmanDance;
  const originalReplaySha256 = dance?.replay?.sha256;
  const policySha256 = run.artifact?.sha256;
  if (
    !root ||
    !RUN_ID.test(run.id) ||
    run.status !== 'completed' ||
    run.mock !== false ||
    run.taskId !== 'originman-dance' ||
    !SHA256.test(originalReplaySha256 ?? '') ||
    !SHA256.test(policySha256 ?? '')
  )
    return null;
  const dir = path.join(root, 'resimulated-dance-videos');
  try {
    const receipt = await readBoundedFile(path.join(dir, `${run.id}.json`), 4096);
    if (!receipt) return null;
    const manifest = JSON.parse(receipt.toString('utf8'));
    if (
      manifest?.source !== 'resimulated-onnx' ||
      manifest.runId !== run.id ||
      manifest.policySha256 !== policySha256 ||
      manifest.originalReplaySha256 !== originalReplaySha256 ||
      !SHA256.test(manifest.replaySha256 ?? '') ||
      manifest.replaySha256 === originalReplaySha256 ||
      !SHA256.test(manifest.sceneSha256 ?? '') ||
      !SHA256.test(manifest.videoSha256 ?? '') ||
      manifest.videoSha256 === dance?.video?.sha256 ||
      !Number.isSafeInteger(manifest.sizeBytes)
    )
      return null;
    const bytes = await readBoundedFile(
      path.join(dir, `${manifest.videoSha256}.mp4`),
      50 * 1024 * 1024,
      manifest.sizeBytes,
    );
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.videoSha256)
      return null;
    return { bytes, sha256: manifest.videoSha256 as string };
  } catch {
    return null;
  }
}

export function registerResimulatedDanceVideoRoute(
  router: Router,
  deps: {
    prefix: string;
    requestOwner: (request: Request, response: Response) => string | null | undefined;
    getRun: (
      id: string,
      owner: string | undefined,
    ) => Promise<Sim2RealRunRecord | null | undefined>;
  },
) {
  router.get(
    `${deps.prefix}/runs/:id/resimulated-dance-video`,
    wrapAsync(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const run = await deps.getRun(String(request.params.id), owner);
      const media = run && (await readResimulatedVideo(run));
      if (!media) {
        response.status(404).json({ ok: false, error: 'RESIMULATED_DANCE_VIDEO_UNAVAILABLE' });
        return;
      }
      const { bytes, sha256 } = media;
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Type', 'video/mp4');
      response.setHeader('Content-Disposition', 'inline; filename="originman-resimulated.mp4"');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Replay-Source', 'resimulated-onnx');
      response.setHeader('X-Replay-Video-Sha256', sha256);
      const range = request.headers.range ? request.range(bytes.length) : undefined;
      if (range === -1) {
        response.setHeader('Content-Range', `bytes */${bytes.length}`);
        response.status(416).end();
        return;
      }
      if (Array.isArray(range) && range.type === 'bytes' && range.length === 1) {
        const { start, end } = range[0];
        response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
        response.setHeader('Content-Length', end - start + 1);
        response
          .status(206)
          .end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
        return;
      }
      response.setHeader('Content-Length', bytes.length);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    }),
  );
}
