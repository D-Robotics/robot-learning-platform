import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import { createSim2RealRun, listSim2RealTelemetry } from '../sim2real/sim2real-store.js';
import { registerSim2RealTelemetryRoutes } from './sim2real-telemetry-routes.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
});

async function fixture(taskId?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-telemetry-scene-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  const run = await createSim2RealRun({
    modelId: BUILTIN_MICRODUCK_MODEL.id,
    backend: 'contract',
    status: 'completed',
    summary: 'scene replay fixture',
    ...(taskId ? { taskId } : {}),
  });
  const router = Router();
  registerSim2RealTelemetryRoutes(router, {
    auth: {
      isMultiUserDeployment: () => false,
      resolvePrincipal: () => null,
      resolveAccessToken: () => null,
    },
    requestOwner: () => undefined,
    visibleDevices: async () => [],
    storageError: (_req, res, error) => {
      res.status(500).json({ error: String(error) });
    },
  });
  return { router, run };
}

function invoke(
  router: Router,
  method: 'post' | 'get',
  routePath: string,
  input: Partial<Request>,
) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) throw new Error(`Missing route ${routePath}`);
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    let statusCode = 200;
    const response = {
      locals: {},
      setHeader: () => response,
      status(code: number) {
        statusCode = code;
        return response;
      },
      json(body: unknown) {
        resolve({ statusCode, body });
        return response;
      },
    } as unknown as Response;
    handler({ body: {}, params: {}, query: {}, headers: {}, ...input } as Request, response, ((
      error?: unknown,
    ) => {
      if (error) reject(error);
    }) as NextFunction);
  });
}

const snapshot = {
  taskId: 'balance-stilts',
  qpos: [1, 0, 0, 0],
  qvel: [0, 0, 0],
  integrationState: [0.02, 1, 0, 0, 0, 0, 0, 0],
  time: 0.02,
  stepCount: 1,
  action: Array(14).fill(0.1),
  reward: 0.98,
  done: false,
  posture: Array(14).fill(0.035),
  prevPosture: Array(14).fill(0),
  lastAction: Array(14).fill(0.1),
  command: Array(13).fill(0),
};

describe('simulator telemetry replay state', () => {
  it('rejects a different task frame before writing any part of the uploaded chunk', async () => {
    const { router, run } = await fixture('balance-stilts');
    const samples = [
      { t: 0.02, taskId: 'balance-stilts', replay: snapshot },
      {
        t: 0.04,
        taskId: 'balance-basketball',
        replay: { ...snapshot, taskId: 'balance-basketball' },
      },
    ];
    for (const payload of [
      { samples },
      { jsonl: samples.map((sample) => JSON.stringify(sample)).join('\n') },
    ]) {
      const rejected = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
        params: { id: run.id },
        body: { source: 'import', ...payload },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).toMatchObject({ code: 'SIM2REAL_INVALID_TELEMETRY' });
      expect(rejected.body.message).toContain('samples[1].taskId');
      expect(await listSim2RealTelemetry(run.id)).toHaveLength(0);
    }
  });

  it('preserves matching task imports and legacy samples without promoting simulator evidence', async () => {
    const { router, run } = await fixture('balance-stilts');
    const samples = [
      { t: 0.02, taskId: 'balance-stilts', replay: snapshot },
      { t: 0.04, observation: Array(61).fill(0), action: Array(14).fill(0) },
    ];
    const accepted = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: run.id },
      body: { source: 'import', attested: true, samples },
    });
    expect(accepted.statusCode).toBe(201);
    const records = await listSim2RealTelemetry(run.id);
    expect(records).toHaveLength(1);
    expect(records[0].source).toBe('import');
    expect(records[0].attested).not.toBe(true);
    expect(records[0].samples).toEqual(samples);
    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: run.id },
    });
    expect(replay.body.frames).toEqual(samples);
    expect(replay.body.replay.attested).toBe(false);
  });

  it('binds the OriginBot action task while retaining its distinct simulator model identity', async () => {
    const { router, run } = await fixture('goal-navigation');
    const sample = {
      t: 0.02,
      taskId: 'goal-navigation',
      replay: { ...snapshot, taskId: 'originbot' },
    };
    const accepted = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: run.id },
      body: { source: 'import', samples: [sample] },
    });
    expect(accepted.statusCode).toBe(201);
    expect((await listSim2RealTelemetry(run.id))[0].samples[0]).toEqual(sample);
  });

  it('preserves exact task pose and hidden state through ingestion, storage and replay without attestation', async () => {
    const { router, run } = await fixture();
    const sample = {
      t: 0.02,
      observation: Array(61).fill(0),
      action: Array(14).fill(0.1),
      taskId: 'balance-stilts',
      sceneId: 'balance-stilts',
      qpos: snapshot.qpos,
      qvel: snapshot.qvel,
      replay: snapshot,
    };
    const ingested = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: run.id },
      body: { source: 'browser', attested: true, samples: [sample] },
    });
    expect(ingested.statusCode).toBe(201);
    const records = await listSim2RealTelemetry(run.id);
    expect(records).toHaveLength(1);
    expect(records[0].source).toBe('browser');
    expect(records[0].attested).not.toBe(true);
    expect(records[0].samples[0]).toEqual(sample);
    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: run.id },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.frames[0]).toMatchObject(sample);
    expect(replay.body.replay.attested).toBe(false);
  });

  it('preserves a football team snapshot and OriginBot controls in imported JSONL', async () => {
    const { router, run } = await fixture();
    const team = {
      taskId: 'football-3v3',
      qpos: [0, 0, 0.2, 1, 0, 0, 0],
      qvel: Array(6).fill(0),
      integrationState: [0.08],
      time: 0.08,
      stepCount: 1,
      action: [
        [0.1, 0, 0, 1],
        [0, 0.2, 0, 0],
        [0, 0, 0, 0],
      ],
      reward: [0.01, 0.01, 0.01],
      done: false,
      lastBallDistance: 1.2,
      lastGoalDistance: 2.7,
      scored: false,
    };
    const originbot = {
      taskId: 'originbot',
      qpos: [0, 0, 0.1, 1, 0, 0, 0],
      qvel: Array(6).fill(0),
      integrationState: [0.1],
      time: 0.1,
      stepCount: 10,
      action: [0.2, 0.3],
      reward: 0,
      done: false,
      command: [0.2, 0.1, 0.2, 0.1, 2, 3, 2, 3, 2, 3, 0.01, 0.02, 0],
    };
    const samples = [
      { t: 0.08, taskId: 'football-3v3', replay: team },
      { t: 0.1, taskId: 'goal-navigation', replay: originbot },
    ];
    const accepted = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: run.id },
      body: { source: 'import', jsonl: samples.map((sample) => JSON.stringify(sample)).join('\n') },
    });
    expect(accepted.statusCode).toBe(201);
    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: run.id },
    });
    expect(replay.body.frames.map((frame: Record<string, unknown>) => frame.replay)).toEqual([
      team,
      originbot,
    ]);
    expect(replay.body.replay.attested).toBe(false);
  });

  it('rejects supplied invalid pose or snapshots instead of silently discarding them', async () => {
    const { router, run } = await fixture();
    const invalid = [
      { qpos: [Number.NaN] },
      { qvel: Array(4097).fill(0) },
      { qpos: ['1'] },
      { taskId: '../scene' },
      { sceneId: 'x'.repeat(97) },
      { replay: null },
      { replay: { ...snapshot, arbitraryState: { attested: true } } },
      { replay: { ...snapshot, command: [Infinity] } },
      { replay: { ...snapshot, action: Array(7).fill([0, 0, 0, 0]) } },
      { replay: { ...snapshot, action: [[0, 0], [0]] } },
      { replay: { ...snapshot, done: 'false' } },
      { replay: { ...snapshot, stepCount: 1.5 } },
      {
        replay: {
          ...snapshot,
          qpos: Array(4096).fill(0),
          qvel: Array(4096).fill(0),
          integrationState: Array(4096).fill(0),
          posture: Array(4096).fill(0),
          command: [0],
        },
      },
      { event: { kind: 'session-started', sessionId: 'fixture' }, replay: snapshot },
    ];
    for (const fields of invalid) {
      const rejected = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
        params: { id: run.id },
        body: { source: 'browser', samples: [{ t: 0, ...fields }] },
      });
      expect(rejected.statusCode, JSON.stringify(fields)).toBe(400);
      expect(rejected.body).toMatchObject({ code: 'SIM2REAL_INVALID_TELEMETRY' });
    }
    expect(await listSim2RealTelemetry(run.id)).toHaveLength(0);
  });
});
