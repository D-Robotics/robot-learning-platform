import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import { updateSim2RealEvaluation } from '../sim2real/sim2real-store.js';
import { createSim2RealRouter } from './sim2real-routes.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousData = process.env.RDK_DATA_DIR;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousData === undefined) delete process.env.RDK_DATA_DIR;
  else process.env.RDK_DATA_DIR = previousData;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
});

type RecordedResponse = Response & {
  statusCode: number;
  body?: unknown;
  headers: Record<string, string>;
};

function responseRecorder(resolve: (response: RecordedResponse) => void): RecordedResponse {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
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
  } as unknown as RecordedResponse;
  return response;
}

async function invoke(
  router: ReturnType<typeof createSim2RealRouter>,
  method: string,
  routePath: string,
  input: Partial<Request> = {},
): Promise<RecordedResponse> {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) throw new Error(`route not registered: ${method} ${routePath}`);
  return new Promise((resolve, reject) => {
    const response = responseRecorder(resolve);
    const request = {
      body: {},
      params: {},
      query: {},
      headers: {},
      ...input,
    } as unknown as Request;
    try {
      handler(request, response, ((error?: unknown) => {
        if (error) reject(error);
      }) as NextFunction);
    } catch (error) {
      reject(error);
    }
  });
}

describe('Sim2Real lifecycle registry routes', () => {
  it('registers and promotes immutable artifacts, materializes evaluations, and serves lineage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-route-lifecycle-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
    process.env.RDK_DATA_DIR = path.join(root, 'data');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    const router = createSim2RealRouter();

    const dataset = await invoke(router, 'post', '/api/sim2real/datasets', {
      body: {
        name: 'walk',
        version: 'v1',
        status: 'registered',
        contractId: 'microduck-policy-v1',
      },
    });
    expect(dataset.statusCode).toBe(201);
    const datasetId = (dataset.body as { dataset: { id: string } }).dataset.id;
    const run = await invoke(router, 'post', '/api/sim2real/runs', {
      body: {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        datasetIds: [datasetId],
      },
    });
    expect(run.statusCode).toBe(201);
    const runId = (run.body as { run: { id: string } }).run.id;
    const artifact = await invoke(router, 'post', '/api/sim2real/artifacts', {
      headers: { 'idempotency-key': 'route-artifact-1' },
      body: {
        artifactId: 'walk-policy',
        version: 'v1',
        name: 'Walk policy',
        role: 'compiled-policy',
        kind: 'compiled',
        format: 'onnx',
        runtime: 'cpu-onnx',
        workload: 'locomotion',
        ref: 'artifact://walk-policy/v1',
        sha256: 'a'.repeat(64),
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        runId,
        datasetIds: [datasetId],
        evaluationIds: [],
        status: 'draft',
      },
    });
    expect(artifact.statusCode).toBe(201);
    const artifactId = (artifact.body as { artifact: { id: string } }).artifact.id;
    expect(
      (
        await invoke(router, 'post', '/api/sim2real/artifacts/:id/validate', {
          params: { id: artifactId },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await invoke(router, 'post', '/api/sim2real/artifacts/:id/publish', {
          params: { id: artifactId },
        })
      ).statusCode,
    ).toBe(200);
    const evaluation = await invoke(router, 'post', '/api/sim2real/evaluations', {
      headers: { 'idempotency-key': 'route-evaluation-1' },
      body: {
        runId,
        artifactId,
        datasetIds: [datasetId],
        status: 'pending',
        source: 'runner',
      },
    });
    expect(evaluation.statusCode).toBe(201);
    const evaluationId = (evaluation.body as { evaluation: { id: string } }).evaluation.id;
    const passed = await invoke(router, 'patch', '/api/sim2real/evaluations/:id', {
      params: { id: evaluationId },
      body: { status: 'running' },
    });
    expect(passed.statusCode).toBe(200);
    const rejected = await invoke(router, 'patch', '/api/sim2real/evaluations/:id', {
      params: { id: evaluationId },
      body: { status: 'passed', summary: 'quality gate passed' },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body).toMatchObject({ code: 'SIM2REAL_EVALUATION_ATTESTATION_REQUIRED' });
    // Public PATCH cannot self-attest release evidence. A trusted evaluator
    // materializes the terminal result after independently checking replay.
    const completed = await updateSim2RealEvaluation(
      evaluationId,
      { status: 'passed', summary: 'quality gate passed' },
      undefined,
      { trusted: true },
    );
    expect(completed).toMatchObject({ id: evaluationId, status: 'passed' });
    const lineage = await invoke(router, 'get', '/api/sim2real/lineage', {
      query: { runId },
    });
    expect(lineage.statusCode).toBe(200);
    expect(lineage.body).toMatchObject({
      ok: true,
      lineage: {
        run: { id: runId },
        artifacts: [expect.objectContaining({ id: artifactId, status: 'published' })],
        evaluations: [expect.objectContaining({ id: evaluationId, status: 'passed' })],
      },
    });
    const replay = await invoke(router, 'post', '/api/sim2real/evaluations', {
      headers: { 'idempotency-key': 'route-evaluation-1' },
      body: {
        runId,
        artifactId,
        datasetIds: [datasetId],
        status: 'pending',
        source: 'runner',
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ idempotentReplay: true });
  });

  it('exposes first-class artifacts and evaluations in the overview payload for the promotion flow', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-overview-promotion-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
    process.env.RDK_DATA_DIR = path.join(root, 'data');
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    const router = createSim2RealRouter();

    const run = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, backend: 'contract' },
    });
    expect(run.statusCode).toBe(201);
    const runId = (run.body as { run: { id: string } }).run.id;
    const artifact = await invoke(router, 'post', '/api/sim2real/artifacts', {
      headers: { 'idempotency-key': 'overview-artifact-1' },
      body: {
        artifactId: 'overview-policy',
        version: 'v1',
        name: 'Overview policy',
        role: 'policy',
        kind: 'source',
        format: 'onnx',
        ref: 'artifact://overview-policy/v1',
        sha256: 'b'.repeat(64),
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        runId,
        datasetIds: [],
        evaluationIds: [],
        status: 'draft',
      },
    });
    expect(artifact.statusCode).toBe(201);
    const artifactId = (artifact.body as { artifact: { id: string } }).artifact.id;
    expect(
      (
        await invoke(router, 'post', '/api/sim2real/artifacts/:id/validate', {
          params: { id: artifactId },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await invoke(router, 'post', '/api/sim2real/artifacts/:id/publish', {
          params: { id: artifactId },
        })
      ).statusCode,
    ).toBe(200);

    const overview = await invoke(router, 'get', '/api/sim2real/overview', {
      query: { productId: 'microduck' },
    });
    expect(overview.statusCode).toBe(200);
    const payload = overview.body as {
      artifacts: Array<{ id: string; status: string; runId: string; sha256: string }>;
      evaluations: Array<{ id: string }>;
    };
    expect(Array.isArray(payload.artifacts)).toBe(true);
    expect(payload.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: artifactId, status: 'published', runId }),
      ]),
    );
    expect(Array.isArray(payload.evaluations)).toBe(true);
  });
});
