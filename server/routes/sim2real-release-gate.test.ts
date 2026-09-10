import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL, type Sim2RealRunRecord } from '../../shared/sim2real.js';
import { createSim2RealRun } from '../sim2real/sim2real-store.js';
import { createSim2RealRouter } from './sim2real-routes.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  delete process.env.RDK_DATA_DIR;
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-release-route-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
  process.env.RDK_DATA_DIR = path.join(root, 'data');
  await fs.mkdir(process.env.RDK_SIM2REAL_STORAGE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(process.env.RDK_SIM2REAL_STORAGE_DIR, 'devices.json'),
    JSON.stringify([
      {
        id: 'board-1',
        host: '127.0.0.1',
        username: 'rdk',
        status: 'connected',
        lastCheckedAt: new Date().toISOString(),
        boardPlatform: 'rdk-x5',
      },
    ]),
  );
  return createSim2RealRouter();
}

async function invoke(
  router: ReturnType<typeof createSim2RealRouter>,
  method: string,
  routePath: string,
  input: Partial<Request> = {},
) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) throw new Error(`route not registered: ${method} ${routePath}`);
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const response = {
      statusCode: 200,
      body: undefined as any,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {
        return this;
      },
      json(body: unknown) {
        this.body = body;
        resolve(this);
        return this;
      },
    } as unknown as Response & { statusCode: number; body: any };
    handler(
      { body: {}, params: {}, query: {}, headers: {}, ...input } as Request,
      response,
      ((error?: unknown) => error && reject(error)) as NextFunction,
    );
  });
}

function taskEvaluation(successRate = 0.88): NonNullable<Sim2RealRunRecord['taskEvaluation']> {
  return {
    taskId: 'originbot-goal-navigation',
    qualityGate: {
      criteria: {
        minSuccessRate: 0.7,
        maxCollisionRate: 0.15,
        gateOn: 'ciLowerBound',
      },
    },
    trained: {
      envelopes: {
        nominal: {
          successRate,
          collisionRate: 0,
          episodes: 50,
          successRateCiLow: successRate === 0.88 ? 0.7562 : 0.5833,
          successRateCiHigh: successRate === 0.88 ? 0.9438 : 0.8253,
          collisionRateCiLow: 0,
          collisionRateCiHigh: 0.0713,
        },
        hard: {
          successRate: 0.7,
          collisionRate: 0.02,
          episodes: 50,
        },
      },
    },
    baseline: {
      envelopes: { nominal: { successRate: 0, collisionRate: 0, episodes: 50 } },
    },
  };
}

async function completedRun(successRate = 0.88) {
  return createSim2RealRun({
    modelId: BUILTIN_MICRODUCK_MODEL.id,
    taskId: 'originbot-goal-navigation',
    backend: 'local',
    status: 'completed',
    summary: 'quality-gated training completed',
    metrics: {
      contractValid: true,
      observationSize: 61,
      actionSize: 14,
      successRate,
    },
    artifact: {
      artifactId: 'release-policy',
      artifactRef: 'artifact://starter/release/policy.onnx',
      kind: 'source',
      format: 'onnx',
      sha256: 'b'.repeat(64),
      deployable: true,
    },
    taskEvaluation: taskEvaluation(successRate),
    finishedAt: new Date().toISOString(),
  });
}

describe('deployment route release evidence gate', () => {
  it('requires a run binding for canary while leaving preflight unchanged', async () => {
    const router = await fixture();
    const preflight = await invoke(router, 'post', '/api/sim2real/deployments', {
      body: {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        deviceId: 'board-1',
        mode: 'preflight',
      },
    });
    expect(preflight.statusCode).toBe(201);

    const canary = await invoke(router, 'post', '/api/sim2real/deployments', {
      headers: { 'idempotency-key': 'canary-missing-run' },
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, deviceId: 'board-1', mode: 'canary' },
    });
    expect(canary.statusCode).toBe(400);
    expect(canary.body).toMatchObject({ code: 'SIM2REAL_RELEASE_RUN_REQUIRED' });
  });

  it('rejects a forged engine PASS when the confidence floor is below the task gate', async () => {
    const router = await fixture();
    const run = await completedRun(0.72);
    const response = await invoke(router, 'post', '/api/sim2real/deployments', {
      headers: { 'idempotency-key': 'canary-weak-evidence' },
      body: {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        deviceId: 'board-1',
        mode: 'canary',
        runId: run.id,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: 'SIM2REAL_RELEASE_EVIDENCE_REJECTED',
      details: { releaseGate: { passed: false, runId: run.id } },
    });
  });

  it('persists the independently verified run and gate on an accepted canary plan', async () => {
    const router = await fixture();
    const run = await completedRun();
    const response = await invoke(router, 'post', '/api/sim2real/deployments', {
      headers: { 'idempotency-key': 'canary-strong-evidence' },
      body: {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        deviceId: 'board-1',
        mode: 'canary',
        runId: run.id,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body.deployment).toMatchObject({
      mode: 'canary',
      // The training evidence passes independently; the built-in source ONNX
      // still lacks a target-compiled artifact, so compatibility stays closed.
      status: 'blocked',
      runId: run.id,
      releaseGate: { passed: true, runId: run.id },
    });
    expect(response.body.deployment.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'release-evidence', status: 'completed' }),
      ]),
    );
  });
});
