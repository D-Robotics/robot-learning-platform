import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import type { Device } from '../../shared/types.js';
import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import {
  createSim2RealRun,
  getSim2RealRun,
  invalidateSim2RealStoreCacheForTest,
  listSim2RealTelemetry,
  appendSim2RealTelemetryWithResult,
} from '../sim2real/sim2real-store.js';
import { registerSim2RealTelemetryRoutes } from './sim2real-telemetry-routes.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;

afterEach(async () => {
  invalidateSim2RealStoreCacheForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
  invalidateSim2RealStoreCacheForTest();
});

async function useTempStorage(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-replay-video-route-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  invalidateSim2RealStoreCacheForTest();
  return root;
}

type RecordedResponse = Response & {
  statusCode: number;
  body?: unknown;
  headers: Record<string, string>;
  raw?: Buffer;
};

function responseRecorder(resolve: (response: RecordedResponse) => void): RecordedResponse {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    raw: undefined as Buffer | undefined,
    headers: {} as Record<string, string>,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    setHeader(name: string, value: string) {
      response.headers[name.toLowerCase()] = String(value);
      return response;
    },
    json(payload: unknown) {
      response.body = payload;
      resolve(response as RecordedResponse);
      return response;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk))
        response.raw = Buffer.from(chunk as string);
      resolve(response as RecordedResponse);
      return response;
    },
  } as unknown as RecordedResponse;
  return response;
}

function routeHandler(router: Router, method: string, routePath: string) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) throw new Error(`route not registered: ${method} ${routePath}`);
  return handler;
}

async function invoke(
  router: Router,
  method: string,
  routePath: string,
  input: Partial<Request>,
): Promise<RecordedResponse> {
  return new Promise((resolve, reject) => {
    const response = responseRecorder(resolve);
    const request = {
      body: {},
      params: {},
      query: {},
      headers: {},
      ...input,
    } as unknown as Request;
    routeHandler(router, method, routePath)(request, response, ((error?: unknown) => {
      if (error) reject(error);
    }) as NextFunction);
  });
}

function device(owner: string): Device & { bridgeOwnerKey: string } {
  return {
    id: 'board-1',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    status: 'connected',
    lastCheckedAt: new Date().toISOString(),
    bridgeOwnerKey: `sso:${owner}:web`,
  };
}

function buildRouter(principal = 'alice'): Router {
  const router = Router();
  const auth: Sim2RealAuthPort = {
    isMultiUserDeployment: () => true,
    resolvePrincipal: () => ({ accountId: principal }),
    resolveAccessToken: () => null,
  };
  registerSim2RealTelemetryRoutes(router, {
    auth,
    requestOwner: () => principal,
    visibleDevices: async () => [device(principal)],
    storageError: (_request, response, error) => {
      response.status(500).json({ ok: false, error: String(error) });
    },
  });
  return router;
}

const POST_VIDEO = '/api/sim2real/runs/:id/replay-video';

/** 6x4 rgb8 flat frame (72 bytes; even dims so the pad filter is a no-op). */
function flatFrame(color: number, t: number) {
  return {
    t,
    observation: [0, 0, 0],
    action: [0, 0],
    cameraFrame: {
      encoding: 'rgb8',
      width: 6,
      height: 4,
      channels: 3,
      data: Buffer.alloc(72, color).toString('base64'),
    },
  };
}

function ffmpegAvailable(): boolean {
  return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
}

describe('replay video routes', () => {
  it.skipIf(!ffmpegAvailable())(
    'renders an attested single-source board run and serves the MP4 with digest headers',
    async () => {
      await useTempStorage();
      const router = buildRouter();
      const run = await createSim2RealRun(
        {
          modelId: BUILTIN_MICRODUCK_MODEL.id,
          backend: 'contract',
          status: 'completed',
          summary: 'replay video route fixture',
        },
        'alice',
      );
      const append = await appendSim2RealTelemetryWithResult(
        {
          runId: run.id,
          modelId: BUILTIN_MICRODUCK_MODEL.id,
          source: 'board-agent',
          deviceId: 'board-1',
          sequence: 1,
          idempotencyKey: 'cam-1',
          attested: true,
          samples: [flatFrame(40, 0), flatFrame(120, 1), flatFrame(200, 2)],
        },
        'alice',
      );
      expect(append).toBeTruthy();

      const rendered = await invoke(router, 'post', POST_VIDEO, {
        params: { id: run.id },
      });
      expect(rendered.statusCode).toBe(200);
      const video = (rendered.body as { video?: Record<string, unknown> }).video;
      expect(video).toMatchObject({ frameCount: 3, sizeBytes: expect.any(Number) });
      expect(String(video?.sha256)).toMatch(/^[a-f0-9]{64}$/);
      expect(String(video?.url)).toBe(`/sim2real/runs/${run.id}/replay-video`);

      // The digest landed in the run metrics the GET path re-verifies.
      const stored = await getSim2RealRun(run.id, 'alice');
      expect(stored?.metrics?.replayVideo).toMatchObject({
        sha256: String(video?.sha256),
        frameCount: 3,
      });

      const served = await invoke(router, 'get', POST_VIDEO, {
        params: { id: run.id },
      });
      expect(served.statusCode).toBe(200);
      expect(served.headers['content-type']).toBe('video/mp4');
      expect(served.headers['x-replay-video-sha256']).toBe(String(video?.sha256));
      expect(served.raw).toBeTruthy();
      // MP4 box signature.
      expect(served.raw?.subarray(4, 8).toString('ascii')).toBe('ftyp');

      // Tampering on disk must fail the digest re-check, never serve drifted bytes.
      const root = String(process.env.RDK_SIM2REAL_STORAGE_DIR);
      await fs.writeFile(path.join(root, 'replay-video', `${run.id}.mp4`), Buffer.from('swapped'));
      const drifted = await invoke(router, 'get', POST_VIDEO, {
        params: { id: run.id },
      });
      expect(drifted.statusCode).toBe(404);
      expect(drifted.body).toMatchObject({ error: 'SIM2REAL_REPLAY_VIDEO_NOT_RENDERED' });
    },
  );

  it('refuses a mixed or unattested run with the honest reason', async () => {
    await useTempStorage();
    const router = buildRouter();
    const run = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'unattested video fixture',
      },
      'alice',
    );
    // Browser-imported telemetry is never attested: the video gate must refuse.
    await appendSim2RealTelemetryWithResult(
      {
        runId: run.id,
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        source: 'browser',
        deviceId: 'board-1',
        sequence: 1,
        idempotencyKey: 'cam-1',
        samples: [flatFrame(40, 0)],
      },
      'alice',
    );

    const refused = await invoke(router, 'post', POST_VIDEO, {
      params: { id: run.id },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'SIM2REAL_REPLAY_VIDEO_NOT_AVAILABLE',
      details: { sources: ['browser'], attested: false },
    });

    // A run with no camera frames at all is also refused, before any render.
    const run2 = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'frameless video fixture',
      },
      'alice',
    );
    await appendSim2RealTelemetryWithResult(
      {
        runId: run2.id,
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        source: 'board-agent',
        deviceId: 'board-1',
        sequence: 1,
        idempotencyKey: 'cam-1',
        attested: true,
        samples: [{ t: 0, observation: [0, 0, 0], action: [0, 0] }],
      },
      'alice',
    );
    const noFrames = await invoke(router, 'post', POST_VIDEO, {
      params: { id: run2.id },
    });
    expect(noFrames.statusCode).toBe(409);
    expect(noFrames.body).toMatchObject({ error: 'SIM2REAL_REPLAY_VIDEO_NOT_AVAILABLE' });
  });

  it('keeps the video scoped to its owner and 404s before any digest exists', async () => {
    await useTempStorage();
    const router = buildRouter();
    const run = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'ownership video fixture',
      },
      'alice',
    );

    // Another account cannot even see the run, let alone its video.
    const bobRouter = buildRouter('bob');
    const foreign = await invoke(bobRouter, 'post', POST_VIDEO, {
      params: { id: run.id },
    });
    expect(foreign.statusCode).toBe(404);

    const missing = await invoke(router, 'get', POST_VIDEO, {
      params: { id: run.id },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toMatchObject({ error: 'SIM2REAL_REPLAY_VIDEO_NOT_RENDERED' });

    const noRun = await invoke(router, 'post', POST_VIDEO, {
      params: { id: 'run-does-not-exist' },
    });
    expect(noRun.statusCode).toBe(404);
  });

  it('telemetry list helper still sees the appended chunks (harness sanity)', async () => {
    const root = await useTempStorage();
    const run = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'harness sanity fixture',
      },
      'alice',
    );
    await appendSim2RealTelemetryWithResult(
      {
        runId: run.id,
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        source: 'board-agent',
        deviceId: 'board-1',
        sequence: 1,
        idempotencyKey: 'cam-1',
        attested: true,
        samples: [flatFrame(40, 0)],
      },
      'alice',
    );
    const records = await listSim2RealTelemetry(run.id, 'alice', 10);
    expect(records).toHaveLength(1);
    expect(records[0]?.attested).toBe(true);
    expect(root).toBeTruthy();
  });
});
