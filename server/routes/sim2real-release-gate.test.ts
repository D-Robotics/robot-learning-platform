import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL, type Sim2RealRunRecord } from '../../shared/sim2real.js';
import {
  createSim2RealArtifactWithResult,
  createSim2RealEvaluationWithResult,
  createSim2RealRun,
  getSim2RealRun,
  updateSim2RealDeployment,
  updateSim2RealArtifactStatus,
} from '../sim2real/sim2real-store.js';
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
  const run = await createSim2RealRun({
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
    evaluation: {
      evaluatedAt: new Date().toISOString(),
      sampleCount: 120,
      referenceSampleCount: 120,
      actionMae: 0.07,
      replay: {
        sampleCount: 120,
        durationSeconds: 12,
        source: 'board-agent',
        attested: true,
        deviceId: 'board-1',
        chunkCount: 1,
        droppedCount: 0,
        doneCount: 0,
        fallCount: 0,
      },
      warnings: [],
    },
    finishedAt: new Date().toISOString(),
  });
  // Canary/live plans now require first-class, immutable release evidence.
  // Build the same attested evaluation + published artifact lineage that the
  // production evaluator would materialize instead of relying on legacy
  // denormalized run fields.
  const evaluation = await createSim2RealEvaluationWithResult(
    {
      runId: run.id,
      modelId: run.modelId,
      datasetIds: [],
      status: 'passed',
      summary: 'attested board replay evaluation',
      source: 'platform',
      attested: true,
      report: run.evaluation,
      taskEvaluation: run.taskEvaluation,
      contractId: BUILTIN_MICRODUCK_MODEL.manifest.contract.id,
    },
    undefined,
    { allowInitialTerminal: true, idempotencyKey: `evaluation-${run.id}` },
  );
  const artifact = await createSim2RealArtifactWithResult(
    {
      artifactId: 'release-policy',
      version: 'v1',
      name: 'Release policy',
      role: 'compiled-policy',
      kind: 'compiled',
      format: 'onnx',
      runtime: 'cpu-onnx',
      workload: 'locomotion',
      ref: 'artifact://release-policy/v1',
      sha256: 'b'.repeat(64),
      modelId: run.modelId,
      runId: run.id,
      datasetIds: [],
      evaluationIds: [evaluation.evaluation.id],
      contractId: BUILTIN_MICRODUCK_MODEL.manifest.contract.id,
      status: 'draft',
    },
    undefined,
    { idempotencyKey: `artifact-${run.id}` },
  );
  await updateSim2RealArtifactStatus(artifact.artifact.id, 'validated');
  await updateSim2RealArtifactStatus(artifact.artifact.id, 'published');
  return (await getSim2RealRun(run.id))!;
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
      approval: { status: 'pending' },
    });
    expect(response.body.deployment.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'release-evidence', status: 'completed' }),
      ]),
    );
    await expect(
      updateSim2RealDeployment(response.body.deployment.id, { status: 'ready' }),
    ).rejects.toMatchObject({ code: 'sim2real_deployment_transition_invalid' });
    const rejected = await invoke(router, 'post', '/api/sim2real/deployments/:id/approval', {
      params: { id: response.body.deployment.id },
      body: { decision: 'rejected', note: 'compatibility review pending' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.body.deployment).toMatchObject({
      status: 'blocked',
      approval: { status: 'rejected', note: 'compatibility review pending' },
    });
  });
});
