import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL, type Sim2RealModelManifest } from '../../shared/sim2real.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import { reserveSim2RealRun } from '../sim2real/sim2real-store.js';
import { createSim2RealRouter } from './sim2real-routes.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousData = process.env.RDK_DATA_DIR;
const previousRunner = process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
const previousLocalRunner = process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
const previousMaxActiveRuns = process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousData === undefined) delete process.env.RDK_DATA_DIR;
  else process.env.RDK_DATA_DIR = previousData;
  if (previousRunner === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
  else process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = previousRunner;
  if (previousLocalRunner === undefined) delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
  else process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = previousLocalRunner;
  if (previousMaxActiveRuns === undefined) delete process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS;
  else process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = previousMaxActiveRuns;
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-route-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
  process.env.RDK_DATA_DIR = path.join(root, 'data');
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  return createSim2RealRouter();
}

type RecordedResponse = Response & {
  statusCode: number;
  body?: unknown;
  headers: Record<string, string>;
};

function responseRecorder(
  resolve: (response: RecordedResponse) => void,
  reject: (error: unknown) => void,
): RecordedResponse {
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
  void reject;
  return response;
}

function routeHandler(
  router: ReturnType<typeof createSim2RealRouter>,
  method: string,
  routePath: string,
) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handler = layer?.route?.stack[0]?.handle;
  if (!handler) throw new Error(`route not registered: ${method} ${routePath}`);
  return handler;
}

async function invoke(
  router: ReturnType<typeof createSim2RealRouter>,
  method: string,
  routePath: string,
  input: Partial<Request> = {},
): Promise<RecordedResponse> {
  return new Promise<RecordedResponse>((resolve, reject) => {
    const response = responseRecorder(resolve, reject);
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

function userManifest(): Sim2RealModelManifest {
  const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
  manifest.modelId = 'route-user-policy';
  manifest.displayName = 'Route user policy';
  manifest.version = '1.0.0';
  return manifest;
}

function vector(size: number, value: number): number[] {
  return Array.from({ length: size }, () => value);
}

describe('Sim2Real HTTP routes', () => {
  it('creates an owner-scoped project and compares its experiment runs', async () => {
    const router = await fixture();
    const dataset = await invoke(router, 'post', '/api/sim2real/datasets', {
      body: { name: 'walk demos', format: 'jsonl', sampleCount: 24 },
    });
    expect(dataset.statusCode).toBe(201);
    const datasetId = (dataset.body as { dataset: { id: string } }).dataset.id;
    const project = await invoke(router, 'post', '/api/sim2real/projects', {
      body: { name: 'Walk policy', slug: 'walk-policy', datasetIds: [datasetId] },
    });
    expect(project.statusCode).toBe(201);
    const projectId = (project.body as { project: { id: string } }).project.id;
    const run = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, backend: 'contract', projectId, experimentId: 'baseline', label: 'Baseline' },
    });
    expect(run.statusCode).toBe(201);
    const compare = await invoke(router, 'get', '/api/sim2real/projects/:id/runs/compare', { params: { id: projectId } });
    expect(compare.statusCode).toBe(200);
    expect(compare.body).toMatchObject({ ok: true, projectId, comparison: [expect.objectContaining({ experimentId: 'baseline', label: 'Baseline' })] });
  });

  it('does not allow a run to reference another owner project', async () => {
    const router = await fixture();
    const project = await invoke(router, 'post', '/api/sim2real/projects', { body: { name: 'Private project', slug: 'private-project' } });
    const projectId = (project.body as { project: { id: string } }).project.id;
    const otherRouter = createSim2RealRouter({ auth: {
      ...({} as Sim2RealAuthPort),
      isMultiUserDeployment: () => true,
      resolvePrincipal: () => ({ accountId: 'other' }),
      resolveAccessToken: () => undefined,
    } });
    const run = await invoke(otherRouter, 'post', '/api/sim2real/runs', { body: { modelId: BUILTIN_MICRODUCK_MODEL.id, backend: 'contract', projectId } });
    expect(run.statusCode).toBe(404);
  });
  it('registers the versioned Duck prefix for core and telemetry routes', async () => {
    await fixture();
    const router = createSim2RealRouter({}, { prefix: '/api/v1/duck' });
    const manifest = userManifest();

    const validation = await invoke(router, 'post', '/api/v1/duck/models/validate', {
      body: { manifest },
    });
    expect(validation.statusCode).toBe(200);

    const registered = await invoke(router, 'post', '/api/v1/duck/models', {
      body: { manifest },
    });
    expect(registered.statusCode).toBe(201);
    const modelId = (registered.body as { model: { id: string } }).model.id;
    const run = await invoke(router, 'post', '/api/v1/duck/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    expect(run.statusCode).toBe(201);
    const runId = (run.body as { run: { id: string } }).run.id;

    const telemetry = await invoke(router, 'post', '/api/v1/duck/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'browser',
        samples: [{ t: 0, observation: vector(61, 0), action: vector(14, 0) }],
      },
    });
    expect(telemetry.statusCode).toBe(201);
    const replay = await invoke(router, 'get', '/api/v1/duck/runs/:id/replay', {
      params: { id: runId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, runId });
  });

  it('lists models, runs, and deployments without requiring the full overview payload', async () => {
    const router = await fixture();
    const registered = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registered.body as { model: { id: string } }).model.id;
    const createdRun = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (createdRun.body as { run: { id: string } }).run.id;

    const models = await invoke(router, 'get', '/api/sim2real/models');
    expect(models.statusCode).toBe(200);
    expect(models.body).toMatchObject({ ok: true });
    expect((models.body as { models: Array<{ id: string }> }).models).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: modelId })]),
    );
    expect(JSON.stringify(models.body)).not.toContain('owner');

    const runs = await invoke(router, 'get', '/api/sim2real/runs');
    expect(runs.statusCode).toBe(200);
    expect(runs.body).toMatchObject({ ok: true, runs: [{ id: runId, modelId }] });

    const deployments = await invoke(router, 'get', '/api/sim2real/deployments');
    expect(deployments.statusCode).toBe(200);
    expect(deployments.body).toMatchObject({ ok: true, deployments: [] });
  });

  it('serves a lightweight owner-scoped workspace summary', async () => {
    const router = await fixture();
    const registered = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registered.body as { model: { id: string } }).model.id;
    const createdRun = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    expect(createdRun.statusCode).toBe(201);

    const response = await invoke(router, 'get', '/api/sim2real/workspace-summary');
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      counts: {
        models: 2,
        runs: 1,
        activeRuns: 0,
        deployments: 0,
        devices: 0,
      },
      latest: {
        run: {
          modelId,
          taskId: 'walk',
          status: 'completed',
        },
        deployment: null,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('observationLayout');
    expect(JSON.stringify(response.body)).not.toContain('integrations');
  });

  it('validates and registers metadata, then records a contract-only run', async () => {
    const router = await fixture();
    const manifest = userManifest();

    const validationResponse = await invoke(router, 'post', '/api/sim2real/models/validate', {
      body: { manifest, platforms: ['rdk-x5'] },
    });
    const validation = validationResponse.body as {
      validation: { valid: boolean };
      compatibility: Array<{ status: string; deployable: boolean }>;
    };
    expect(validationResponse.statusCode).toBe(200);
    expect(validation.validation.valid).toBe(true);
    expect(validation.compatibility[0]).toMatchObject({
      status: 'requires-conversion',
      deployable: false,
    });

    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest },
    });
    const registered = registerResponse.body as { model: { id: string } & Record<string, unknown> };
    expect(registerResponse.statusCode).toBe(201);
    expect(registered.model).toMatchObject({ manifest: { modelId: 'route-user-policy' } });
    expect(JSON.stringify(registered)).not.toContain('owner');

    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId: registered.model.id, backend: 'contract', taskId: 'kick' },
    });
    const run = runResponse.body as { run: Record<string, unknown> };
    expect(runResponse.statusCode).toBe(201);
    expect(run.run).toMatchObject({
      backend: 'contract',
      taskId: 'kick',
      status: 'completed',
      metrics: { observationSize: 61, actionSize: 14 },
    });
    const runId = (run.run as { id: string }).id;
    const runDetails = await invoke(router, 'get', '/api/sim2real/runs/:id', {
      params: { id: runId },
    });
    expect(runDetails.statusCode).toBe(200);
    expect(runDetails.body).toMatchObject({ run: { id: runId, taskId: 'kick' } });
  });

  it('ingests owner-scoped JSONL telemetry, deduplicates chunks, and persists replay evaluation', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;

    const payload = {
      runId,
      modelId,
      source: 'import',
      sequence: 1,
      idempotencyKey: 'chunk-1',
      jsonl: [
        JSON.stringify({ t: 0, observation: vector(61, 0), action: vector(14, 0), reward: 1 }),
        JSON.stringify({
          // `time` is an exporter alias accepted at the HTTP boundary and
          // normalized to the canonical stored `t` field.
          time: 0.02,
          observation: vector(61, 1),
          action: vector(14, 1),
          reward: 2,
          done: true,
        }),
      ].join('\n'),
    };
    const ingest = await invoke(router, 'post', '/api/sim2real/telemetry', { body: payload });
    expect(ingest.statusCode).toBe(201);
    expect(ingest.body).toMatchObject({ ok: true, acceptedSamples: 2 });
    const duplicate = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: { ...payload, runId: undefined },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.body).toMatchObject({ ok: true, duplicate: true });

    const listed = await invoke(router, 'get', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toMatchObject({
      count: 1,
      telemetry: [{ samples: [{ t: 0 }, { t: 0.02 }] }],
    });

    const evaluated = await invoke(router, 'post', '/api/sim2real/runs/:id/evaluate', {
      params: { id: runId },
      body: {
        referenceSamples: [
          { t: 0, observation: vector(61, 0), action: vector(14, 0) },
          { t: 0.02, observation: vector(61, 0), action: vector(14, 0) },
        ],
      },
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.body).toMatchObject({
      evaluation: {
        sampleCount: 2,
        actionMae: 0.5,
        replay: { sampleCount: 2, durationSeconds: 0.02, doneCount: 1 },
      },
    });

    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ replay: { sampleCount: 2, chunkCount: 1 } });

    // Appending after an evaluation must invalidate the cached summary; the
    // next replay should include every accepted chunk, not the old score.
    const laterChunk = await invoke(router, 'post', '/api/sim2real/telemetry', {
      body: {
        runId,
        modelId,
        source: 'import',
        sequence: 2,
        idempotencyKey: 'chunk-2',
        samples: [
          { t: 0.04, observation: vector(61, 2), action: vector(14, 2), reward: 3 },
        ],
      },
    });
    expect(laterChunk.statusCode).toBe(201);
    const freshReplay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(freshReplay.statusCode).toBe(200);
    expect(freshReplay.body).toMatchObject({ replay: { sampleCount: 3, chunkCount: 2 } });
  });

  it('preserves the demo-fixture source so synthetic evidence stays gated after refresh', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    const ingest = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'demo-fixture',
        contractId: 'microduck-policy-v1',
        samples: [{ t: 0, observation: vector(61, 0), action: vector(14, 0) }],
      },
    });
    expect(ingest.statusCode).toBe(201);
    expect(ingest.body).toMatchObject({ telemetry: { source: 'demo-fixture' } });

    const evaluated = await invoke(router, 'post', '/api/sim2real/runs/:id/evaluate', {
      params: { id: runId },
      body: {},
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.body).toMatchObject({
      evaluation: { replay: { source: 'demo-fixture', sampleCount: 1 } },
    });

    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ replay: { source: 'demo-fixture' } });
  });

  it('classifies a mixed replay as synthetic when a later chunk is demo-fixture', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    const baseSample = (t: number, value: number) => ({
      t,
      observation: vector(61, value),
      action: vector(14, value),
    });

    const realChunk = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: { source: 'import', sequence: 0, samples: [baseSample(0, 0)] },
    });
    expect(realChunk.statusCode).toBe(201);
    const demoChunk = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: { source: 'demo-fixture', sequence: 1, samples: [baseSample(0.02, 1)] },
    });
    expect(demoChunk.statusCode).toBe(201);

    const evaluated = await invoke(router, 'post', '/api/sim2real/runs/:id/evaluate', {
      params: { id: runId },
      body: {},
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.body).toMatchObject({
      evaluation: {
        replay: { source: 'demo-fixture', sampleCount: 2, chunkCount: 2 },
      },
    });
    const evaluatedWarnings = (evaluated.body as { evaluation: { warnings: string[] } }).evaluation
      .warnings;
    expect(evaluatedWarnings).toEqual(expect.arrayContaining([expect.stringContaining('mixed sources')]));
    expect(evaluatedWarnings.join(' ')).toContain('demo-fixture');

    // GET /replay reads the persisted summary, which is the same path the
    // browser uses after a refresh when its in-memory fixture is gone.
    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({
      replay: { source: 'demo-fixture', sampleCount: 2 },
      evaluation: { warnings: [expect.stringContaining('mixed sources')] },
    });
  });

  it('rejects a cross-chunk timestamp regression without corrupting replay metrics', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    const samples = (timestamps: number[]) =>
      timestamps.map((t) => ({ t, observation: vector(61, 0), action: vector(14, 0) }));

    const first = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: { source: 'import', sequence: 0, samples: samples([0, 0.02]) },
    });
    expect(first.statusCode).toBe(201);

    const regressed = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: { source: 'import', sequence: 1, samples: samples([0.01, 0.03]) },
    });
    expect(regressed.statusCode).toBe(409);
    expect(regressed.body).toMatchObject({
      code: 'SIM2REAL_TELEMETRY_TIMESTAMP_ORDER',
    });

    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({
      replay: {
        sampleCount: 2,
        durationSeconds: 0.02,
        sampleRateHz: 50,
      },
    });
  });

  it('rejects wrong contract dimensions and idempotency-key reuse with a different chunk', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    const invalid = await invoke(router, 'post', '/api/sim2real/telemetry', {
      body: {
        runId,
        modelId,
        contractId: 'microduck-policy-v1',
        source: 'import',
        samples: [{ t: 0, observation: [0], action: [0] }],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'SIM2REAL_CONTRACT_DIMENSION_MISMATCH' });

    const first = await invoke(router, 'post', '/api/sim2real/telemetry', {
      body: {
        runId,
        modelId,
        source: 'import',
        idempotencyKey: 'same-chunk',
        samples: [{ t: 0, observation: vector(61, 0), action: vector(14, 0) }],
      },
    });
    expect(first.statusCode).toBe(201);
    const conflict = await invoke(router, 'post', '/api/sim2real/telemetry', {
      body: {
        runId,
        modelId,
        source: 'import',
        idempotencyKey: 'same-chunk',
        samples: [{ t: 0, observation: vector(61, 1), action: vector(14, 1) }],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'SIM2REAL_TELEMETRY_IDEMPOTENCY_CONFLICT' });
  });

  it('rejects board telemetry without a registered device and isolates unknown runs', async () => {
    const router = await fixture();
    const response = await invoke(router, 'post', '/api/sim2real/telemetry', {
      body: {
        runId: 'missing-run',
        source: 'board-agent',
        deviceId: 'device-1',
        samples: [{ t: 0, action: [0] }],
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({ error: 'SIM2REAL_RUN_NOT_FOUND' });
  });

  it('uses the injected SSO identity boundary for multi-user isolation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-auth-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
    process.env.RDK_DATA_DIR = path.join(root, 'data');
    const auth: Sim2RealAuthPort = {
      isMultiUserDeployment: () => true,
      resolvePrincipal: (request) => {
        const accountId = String(request.headers['x-test-account'] || '').trim();
        return accountId ? { accountId } : null;
      },
      resolveAccessToken: () => null,
    };
    const router = createSim2RealRouter({ auth });
    const anonymous = await invoke(router, 'get', '/api/sim2real/overview');
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).toMatchObject({ code: 'SIM2REAL_AUTH_REQUIRED' });
    const aliceOverview = await invoke(router, 'get', '/api/sim2real/overview', {
      headers: { 'x-test-account': 'alice' },
      query: { productId: 'rdk-duck' },
    });
    expect(aliceOverview.statusCode).toBe(200);
    expect(aliceOverview.body).toMatchObject({
      identity: { accountId: 'alice' },
      selectedProductId: 'rdk-duck',
      selectedContract: null,
    });

    const registered = await invoke(router, 'post', '/api/sim2real/models', {
      headers: { 'x-test-account': 'alice' },
      body: { manifest: userManifest() },
    });
    expect(registered.statusCode).toBe(201);
    const modelId = (registered.body as { model: { id: string } }).model.id;

    const alice = await invoke(router, 'get', '/api/sim2real/models/:id', {
      headers: { 'x-test-account': 'alice' },
      params: { id: modelId },
    });
    const bob = await invoke(router, 'get', '/api/sim2real/models/:id', {
      headers: { 'x-test-account': 'bob' },
      params: { id: modelId },
    });
    expect(alice.statusCode).toBe(200);
    expect(bob.statusCode).toBe(404);
  });

  it('rejects unsafe action-task ids before creating a run', async () => {
    const router = await fixture();
    const response = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, backend: 'contract', taskId: 'kick task' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'SIM2REAL_INVALID_TASK' });
  });

  it('registers an RDK Duck manifest without applying the MicroDuck dimensions', async () => {
    const router = await fixture();
    const manifest = userManifest();
    manifest.modelId = 'route-rdk-duck-policy';
    manifest.displayName = 'Route RDK Duck policy';
    manifest.robot = { id: 'rdk-duck', variant: 'x5-kit' };
    manifest.contract = {
      id: 'rdk-duck-policy-v1',
      robotId: 'rdk-duck',
      jointCount: 12,
      observationSize: 8,
      actionSize: 12,
      controlHz: 100,
      physicsTimestepSeconds: 0.002,
      decimation: 1,
      observationLayout: [
        { name: 'imu', size: 3 },
        { name: 'command', size: 5 },
      ],
    };
    manifest.simulator.backends = ['local'];

    const validationResponse = await invoke(router, 'post', '/api/sim2real/models/validate', {
      body: { manifest, platforms: ['rdk-x5'] },
    });
    expect(validationResponse.statusCode).toBe(200);
    expect(validationResponse.body).toMatchObject({ validation: { valid: true } });

    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest },
    });
    expect(registerResponse.statusCode).toBe(201);
    expect(registerResponse.body).toMatchObject({
      model: {
        manifest: {
          robot: { id: 'rdk-duck' },
          contract: { observationSize: 8, actionSize: 12, controlHz: 100 },
        },
      },
    });
  });

  it('accepts manifest-defined telemetry vectors above the legacy 256-value cap', async () => {
    const router = await fixture();
    const manifest = userManifest();
    manifest.modelId = 'route-rdk-large-policy';
    manifest.displayName = 'Route RDK Duck large policy';
    manifest.robot = { id: 'rdk-duck', variant: 'x5-kit' };
    manifest.contract = {
      id: 'rdk-duck-policy-large-v1',
      robotId: 'rdk-duck',
      jointCount: 32,
      observationSize: 4096,
      actionSize: 4096,
      controlHz: 100,
      physicsTimestepSeconds: 0.002,
      decimation: 1,
      observationLayout: [{ name: 'state', size: 4096 }],
    };
    manifest.simulator.backends = ['local'];
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest },
    });
    expect(registerResponse.statusCode).toBe(201);
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract' },
    });
    expect(runResponse.statusCode).toBe(201);
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    const telemetry = await invoke(router, 'post', '/api/sim2real/telemetry', {
      body: {
        runId,
        modelId,
        source: 'import',
        samples: [{ t: 0, observation: vector(4096, 0), action: vector(4096, 1) }],
      },
    });
    expect(telemetry.statusCode).toBe(201);
    expect(telemetry.body).toMatchObject({ ok: true, acceptedSamples: 1 });
  });

  it('rejects an invalid deployment mode instead of silently downgrading it to preflight', async () => {
    const router = await fixture();
    const response = await invoke(router, 'post', '/api/sim2real/deployments', {
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, deviceId: 'device-1', mode: 'delete' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'SIM2REAL_INVALID_DEPLOYMENT' });
  });

  it('keeps a mock BoardAgent preflight blocked instead of reporting hardware readiness', async () => {
    await fixture();
    const storageRoot = process.env.RDK_SIM2REAL_STORAGE_DIR as string;
    await fs.mkdir(storageRoot, { recursive: true });
    await fs.writeFile(
      path.join(storageRoot, 'devices.json'),
      JSON.stringify([
        {
          id: 'mock-x5',
          host: '127.0.0.1',
          username: 'sim2real',
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
          boardPlatform: 'rdk-x5',
        },
      ]),
      'utf8',
    );
    const output = [
      '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__',
      'arch=aarch64',
      'kernel=6.1.0-rdk',
      'python3=/usr/bin/python3',
      'tros=present',
      `disk_bytes=${2 * 1024 ** 3}`,
      '__STUDIO_SIM2REAL_PREFLIGHT_END__',
    ].join('\n');
    const router = createSim2RealRouter({
      runOnDevice: async () => ({
        device: { id: 'mock-x5', kind: 'simulated-x5' },
        output,
        exitCode: 0,
        mock: true,
        actuatorControl: false,
      }),
    });
    const planned = await invoke(router, 'post', '/api/sim2real/deployments', {
      body: {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        deviceId: 'mock-x5',
        mode: 'preflight',
      },
    });
    expect(planned.statusCode).toBe(201);
    const deploymentId = (planned.body as { deployment: { id: string } }).deployment.id;
    const preflight = await invoke(router, 'post', '/api/sim2real/deployments/:id/preflight', {
      params: { id: deploymentId },
    });
    expect(preflight.statusCode).toBe(409);
    expect(preflight.body).toMatchObject({
      code: 'SIM2REAL_PREFLIGHT_MOCK_ONLY',
      preflight: { passed: false, mock: true },
    });
    const details = await invoke(router, 'get', '/api/sim2real/deployments/:id', {
      params: { id: deploymentId },
    });
    const detailDeployment = (details.body as { deployment: { status: string; steps: Array<{ id: string; status: string }> } }).deployment;
    expect(detailDeployment.status).toBe('blocked');
    expect(detailDeployment.steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'board-passport', status: 'blocked' })]),
    );
  });

  it('keeps the built-in browser run explicit and never rewrites a user model into it', async () => {
    const router = await fixture();
    const manifest = userManifest();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest },
    });
    const registered = registerResponse.body as { model: { id: string } };
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId: registered.model.id, backend: 'browser' },
    });
    const run = runResponse.body as { run: Record<string, unknown> };

    expect(runResponse.statusCode).toBe(201);
    expect(run.run).toMatchObject({ status: 'blocked' });
    expect(run.run).not.toHaveProperty('launchUrl');
  });

  it('invokes the explicit RoboGo runner and records its external job id', async () => {
    process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = 'https://runner.example.test/train';
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          status: 'running',
          runId: 'robogo-route-run-1',
          message: 'runner accepted',
        }),
        {
          status: 202,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;
    try {
      const router = await fixture();
      const manifest = userManifest();
      manifest.simulator.backends = ['browser', 'robogo'];
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const registered = registerResponse.body as { model: { id: string } };
      const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId: registered.model.id,
          backend: 'robogo',
          idempotencyKey: 'robogo-route-run-1',
          training: { profile: 'smoke' },
          resumeFrom: {
            checkpointId: 'checkpoint-1500',
            artifactRef: 'artifact://route-user-policy/checkpoint-1500',
            iteration: 1500,
          },
        },
      });
      const run = runResponse.body as { run: Record<string, unknown> };

      expect(runResponse.statusCode).toBe(201);
      expect(run.run).toMatchObject({
        status: 'running',
        externalRunId: 'robogo-route-run-1',
        summary: 'runner accepted',
        training: { profile: 'smoke', numEnvs: 64, maxIterations: 5, video: false },
        resumeFrom: {
          checkpointId: 'checkpoint-1500',
          artifactRef: 'artifact://route-user-policy/checkpoint-1500',
          iteration: 1500,
        },
      });
      expect(requestBody).toMatchObject({
        contractId: 'microduck-policy-v1',
        training: { profile: 'smoke', numEnvs: 64, maxIterations: 5, video: false },
        resumeFrom: { checkpointId: 'checkpoint-1500' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects unsafe training and resume parameters before touching the runner', async () => {
    process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = 'https://runner.example.test/train';
    const router = await fixture();
    const manifest = userManifest();
    manifest.simulator.backends = ['robogo'];
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest },
    });
    const registered = registerResponse.body as { model: { id: string } };
    const response = await invoke(router, 'post', '/api/sim2real/runs', {
      body: {
        modelId: registered.model.id,
        backend: 'robogo',
        idempotencyKey: 'robogo-invalid-training',
        training: { profile: 'standard', numEnvs: 99_999 },
        resumeFrom: { checkpointId: 'x', artifactRef: '/tmp/model.pt' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'SIM2REAL_INVALID_TRAINING' });
  });

  it('rejects a resume path that is not an opaque managed artifact reference', async () => {
    const router = await fixture();
    const manifest = userManifest();
    manifest.simulator.backends = ['robogo'];
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest },
    });
    const registered = registerResponse.body as { model: { id: string } };
    const response = await invoke(router, 'post', '/api/sim2real/runs', {
      body: {
        modelId: registered.model.id,
        backend: 'robogo',
        idempotencyKey: 'robogo-invalid-resume',
        resumeFrom: { checkpointId: 'checkpoint-1500', artifactRef: '../model.pt' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'SIM2REAL_INVALID_RESUME' });
  });

  it('runs a local training worker without consulting the RoboGo endpoint', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    delete process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
    const originalFetch = globalThis.fetch;
    let calledUrl = '';
    globalThis.fetch = (async (input, init) => {
      calledUrl = String(input);
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      expect(body.training).toMatchObject({ profile: 'smoke', numEnvs: 64, maxIterations: 5 });
      return new Response(JSON.stringify({ status: 'queued', runId: 'local-run-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const registered = registerResponse.body as { model: { id: string } };
      const response = await invoke(router, 'post', '/api/sim2real/runs', {
      body: {
        modelId: registered.model.id,
        backend: 'local',
        idempotencyKey: 'local-route-run-1',
      },
      });
      expect(response.statusCode).toBe(201);
      expect(response.body).toMatchObject({
        run: { status: 'queued', externalRunId: 'local-run-1' },
      });
      expect(calledUrl).toBe('http://127.0.0.1:18198/train');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('enforces the active local/RoboGo run quota before launching another runner job', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = '1';
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ status: 'queued', runId: `quota-run-${calls}` }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;

      const first = await invoke(router, 'post', '/api/sim2real/runs', {
        body: { modelId, backend: 'local', idempotencyKey: 'quota-run-key-1' },
      });
      expect(first.statusCode).toBe(201);
      expect(first.body).toMatchObject({ run: { status: 'queued', externalRunId: 'quota-run-1' } });

      const second = await invoke(router, 'post', '/api/sim2real/runs', {
        body: { modelId, backend: 'local', idempotencyKey: 'quota-run-key-2' },
      });
      expect(second.statusCode).toBe(429);
      expect(second.headers['retry-after']).toBe('30');
      expect(second.body).toMatchObject({
        code: 'SIM2REAL_ACTIVE_RUN_QUOTA_EXCEEDED',
        retryable: true,
        retryAfterSeconds: 30,
      });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps a local reservation queued when the worker transport outcome is unknown', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('fetch failed: connection reset by peer');
    }) as typeof fetch;
    try {
      const router = await fixture();
      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const response = await invoke(router, 'post', '/api/sim2real/runs', {
        body: { modelId, backend: 'local', idempotencyKey: 'local-unknown-outcome' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.body).toMatchObject({
        run: {
          status: 'queued',
          summary: expect.stringContaining('对账接口'),
        },
      });
      expect((response.body as { run: Record<string, unknown> }).run.externalRunId).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks a deterministic RoboGo 4xx rejection failed so it does not consume an active slot', async () => {
    process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = 'https://runner.example.test/train';
    process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = '1';
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'invalid manifest' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const manifest = userManifest();
      manifest.simulator.backends = ['robogo'];
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const first = await invoke(router, 'post', '/api/sim2real/runs', {
        body: { modelId, backend: 'robogo', idempotencyKey: 'robogo-4xx-1' },
      });
      expect(first.statusCode).toBe(201);
      expect(first.body).toMatchObject({
        run: { status: 'failed', summary: expect.not.stringContaining('对账接口') },
      });
      const second = await invoke(router, 'post', '/api/sim2real/runs', {
        body: { modelId, backend: 'robogo', idempotencyKey: 'robogo-4xx-2' },
      });
      expect(second.statusCode).toBe(201);
      expect(second.body).toMatchObject({ run: { status: 'failed' } });
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires a request-scoped RoboGo token before polling a shared run', async () => {
    process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = 'https://runner.example.test/train';
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push(String(input));
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ status: 'running', runId: 'shared-status-run-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const auth: Sim2RealAuthPort = {
        isMultiUserDeployment: () => true,
        resolvePrincipal: (request) => {
          const accountId = String(request.headers['x-test-account'] || '').trim();
          return accountId ? { accountId } : null;
        },
        resolveAccessToken: (request) => {
          const token = String(request.headers['x-test-token'] || '').trim();
          return token || null;
        },
      };
      const sharedRouter = createSim2RealRouter({ auth });
      const manifest = userManifest();
      manifest.simulator.backends = ['robogo'];
      const registerResponse = await invoke(sharedRouter, 'post', '/api/sim2real/models', {
        headers: { 'x-test-account': 'alice' },
        body: { manifest },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const started = await invoke(sharedRouter, 'post', '/api/sim2real/runs', {
        headers: { 'x-test-account': 'alice', 'x-test-token': 'session-token' },
        body: { modelId, backend: 'robogo', idempotencyKey: 'shared-status-key' },
      });
      expect(started.statusCode).toBe(201);
      const runId = (started.body as { run: { id: string } }).run.id;
      const status = await invoke(sharedRouter, 'get', '/api/sim2real/runs/:id', {
        headers: { 'x-test-account': 'alice' },
        params: { id: runId },
      });
      expect(status.statusCode).toBe(401);
      expect(status.body).toMatchObject({
        code: 'SIM2REAL_ROBOGO_TOKEN_REQUIRED',
        retryable: false,
      });
      expect(calls).toEqual(['https://runner.example.test/train']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reconciles a reserved runner job without launching a second request', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input) => {
      calls += 1;
      expect(String(input)).toBe('http://127.0.0.1:18198/runs/external-recovered-1');
      return new Response(
        JSON.stringify({ status: 'completed', runId: 'external-recovered-1', mock: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const router = await fixture();
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest: userManifest() },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const reserved = await reserveSim2RealRun(
        {
          modelId,
          backend: 'local',
          status: 'queued',
          summary: 'reserved before runner call',
        },
        undefined,
        { idempotencyKey: 'recover-key', requestFingerprint: 'recover-fingerprint' },
      );
      const missingConfirm = await invoke(router, 'post', '/api/sim2real/runs/:id/reconcile', {
        params: { id: reserved.run.id },
        body: { externalRunId: 'external-recovered-1' },
      });
      expect(missingConfirm.statusCode).toBe(400);
      expect(calls).toBe(0);
      const reconciled = await invoke(router, 'post', '/api/sim2real/runs/:id/reconcile', {
        params: { id: reserved.run.id },
        body: { externalRunId: 'external-recovered-1', confirm: true },
      });
      expect(reconciled.statusCode).toBe(200);
      expect(reconciled.body).toMatchObject({
        reconciled: true,
        run: { externalRunId: 'external-recovered-1', status: 'completed', mock: true },
      });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('claims a reserved run at most once when reconciliation requests race', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let release!: () => void;
    const bothLookups = new Promise<void>((resolve) => {
      release = resolve;
    });
    const releaseTimer = setTimeout(release, 1_000);
    globalThis.fetch = (async (input) => {
      calls += 1;
      const externalRunId = String(input).split('/').pop() || '';
      if (calls >= 2) release();
      await bothLookups;
      return new Response(
        JSON.stringify({ status: 'completed', runId: externalRunId, mock: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const router = await fixture();
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest: userManifest() },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const reserved = await reserveSim2RealRun(
        {
          modelId,
          backend: 'local',
          status: 'queued',
          summary: 'reserved before concurrent reconcile calls',
        },
        undefined,
        { idempotencyKey: 'reconcile-race-key', requestFingerprint: 'reconcile-race' },
      );
      const [left, right] = await Promise.all([
        invoke(router, 'post', '/api/sim2real/runs/:id/reconcile', {
          params: { id: reserved.run.id },
          body: { externalRunId: 'external-race-a', confirm: true },
        }),
        invoke(router, 'post', '/api/sim2real/runs/:id/reconcile', {
          params: { id: reserved.run.id },
          body: { externalRunId: 'external-race-b', confirm: true },
        }),
      ]);

      expect(calls).toBe(2);
      expect([left.statusCode, right.statusCode].sort((a, b) => a - b)).toEqual([200, 409]);
      const successful = [left, right].find((item) => item.statusCode === 200);
      const conflicted = [left, right].find((item) => item.statusCode === 409);
      expect(successful?.body).toMatchObject({
        reconciled: true,
        run: { status: 'completed' },
      });
      expect(conflicted?.body).toMatchObject({ code: 'SIM2REAL_RUN_RECONCILE_RACE' });

      const final = await invoke(router, 'get', '/api/sim2real/runs/:id', {
        params: { id: reserved.run.id },
      });
      const finalRun = (final.body as { run: { externalRunId?: string } }).run;
      expect(['external-race-a', 'external-race-b']).toContain(finalRun.externalRunId);
    } finally {
      clearTimeout(releaseTimer);
      release();
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps a reserved run untouched when reconciliation status lookup fails', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input) => {
      calls += 1;
      expect(String(input)).toBe('http://127.0.0.1:18198/runs/external-unavailable-1');
      return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest: userManifest() },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const reserved = await reserveSim2RealRun(
        {
          modelId,
          backend: 'local',
          status: 'queued',
          summary: 'reserved before runner call',
        },
        undefined,
        { idempotencyKey: 'recover-unavailable-key', requestFingerprint: 'recover-unavailable' },
      );
      const response = await invoke(router, 'post', '/api/sim2real/runs/:id/reconcile', {
        params: { id: reserved.run.id },
        body: { externalRunId: 'external-unavailable-1', confirm: true },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).toMatchObject({
        code: 'SIM2REAL_RUN_RECONCILE_UNAVAILABLE',
        retryable: true,
        retryAfterSeconds: 15,
      });
      expect(calls).toBe(1);
      const unchanged = await invoke(router, 'get', '/api/sim2real/runs/:id', {
        params: { id: reserved.run.id },
      });
      expect(unchanged.body).toMatchObject({
        run: { id: reserved.run.id, status: 'queued' },
      });
      expect((unchanged.body as { run: Record<string, unknown> }).run.externalRunId).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
