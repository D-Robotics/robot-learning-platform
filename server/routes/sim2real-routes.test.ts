import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL, type Sim2RealModelManifest } from '../../shared/sim2real.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import { reserveSim2RealRun, updateSim2RealComputeResource } from '../sim2real/sim2real-store.js';
import { createSim2RealRouter, workspacePackageVersion } from './sim2real-routes.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousData = process.env.RDK_DATA_DIR;
const previousRunner = process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
const previousLocalRunner = process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
const previousLocalRunnerToken = process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN;
const previousNodeEnv = process.env.NODE_ENV;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;
const previousComputeHealthTtl = process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS;
const previousMaxActiveRuns = process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS;
const previousStudioOrigin = process.env.RDK_SIM2REAL_STUDIO_ORIGIN;
const previousStudioExecOrigin = process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
const previousStudioTimeout = process.env.RDK_SIM2REAL_STUDIO_UPSTREAM_TIMEOUT_MS;

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
  if (previousLocalRunnerToken === undefined) delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN;
  else process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN = previousLocalRunnerToken;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
  if (previousComputeHealthTtl === undefined)
    delete process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS;
  else process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS = previousComputeHealthTtl;
  if (previousMaxActiveRuns === undefined) delete process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS;
  else process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = previousMaxActiveRuns;
  if (previousStudioOrigin === undefined) delete process.env.RDK_SIM2REAL_STUDIO_ORIGIN;
  else process.env.RDK_SIM2REAL_STUDIO_ORIGIN = previousStudioOrigin;
  if (previousStudioExecOrigin === undefined) delete process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
  else process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = previousStudioExecOrigin;
  if (previousStudioTimeout === undefined)
    delete process.env.RDK_SIM2REAL_STUDIO_UPSTREAM_TIMEOUT_MS;
  else process.env.RDK_SIM2REAL_STUDIO_UPSTREAM_TIMEOUT_MS = previousStudioTimeout;
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-route-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'sim2real');
  process.env.RDK_DATA_DIR = path.join(root, 'data');
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  return createSim2RealRouter();
}

/**
 * Board-agent telemetry is only accepted for a visible device, so tests that
 * upload board chunks need a registry row. Write the minimal standalone
 * device shape directly (no credentials; the registry is a shared local
 * JSON file owned by the device manager).
 */
async function registerFixtureDevice(id: string) {
  const file = path.join(process.env.RDK_SIM2REAL_STORAGE_DIR as string, 'devices.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify([
      {
        id,
        name: `${id} fixture`,
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        status: 'connected',
        lastCheckedAt: new Date().toISOString(),
      },
    ]),
  );
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
    // Binary endpoints (policy bytes) finish with end(); record the chunk so
    // byte-serving routes stay testable without a real HTTP server.
    end(chunk?: unknown) {
      if (chunk != null) response.body = chunk;
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
  it('persists dataset version, digest and validated run lineage', async () => {
    const router = await fixture();
    const run = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, backend: 'contract' },
    });
    expect(run.statusCode).toBe(201);
    const runId = (run.body as { run: { id: string } }).run.id;
    const dataset = await invoke(router, 'post', '/api/sim2real/datasets', {
      body: {
        name: 'walk-v1',
        version: 'v1.2.0',
        sha256: 'a'.repeat(64),
        contractId: 'microduck-policy-v1',
        sourceRunId: runId,
        sampleCount: 100,
      },
    });
    expect(dataset.statusCode).toBe(201);
    expect(dataset.body).toMatchObject({
      dataset: {
        version: 'v1.2.0',
        sha256: 'a'.repeat(64),
        contractId: 'microduck-policy-v1',
        sourceRunId: runId,
      },
    });
    const invalid = await invoke(router, 'post', '/api/sim2real/datasets', {
      body: { name: 'bad', sourceRunId: 'missing-run' },
    });
    expect(invalid.statusCode).toBe(422);
  });

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
      body: {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        projectId,
        experimentId: 'baseline',
        label: 'Baseline',
      },
    });
    expect(run.statusCode).toBe(201);
    const compare = await invoke(router, 'get', '/api/sim2real/projects/:id/runs/compare', {
      params: { id: projectId },
    });
    expect(compare.statusCode).toBe(200);
    expect(compare.body).toMatchObject({
      ok: true,
      projectId,
      comparison: [expect.objectContaining({ experimentId: 'baseline', label: 'Baseline' })],
    });
  });

  it('does not allow a run to reference another owner project', async () => {
    const router = await fixture();
    const project = await invoke(router, 'post', '/api/sim2real/projects', {
      body: { name: 'Private project', slug: 'private-project' },
    });
    const projectId = (project.body as { project: { id: string } }).project.id;
    const otherRouter = createSim2RealRouter({
      auth: {
        ...({} as Sim2RealAuthPort),
        isMultiUserDeployment: () => true,
        resolvePrincipal: () => ({ accountId: 'other' }),
        resolveAccessToken: () => undefined,
      },
    });
    const run = await invoke(otherRouter, 'post', '/api/sim2real/runs', {
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, backend: 'contract', projectId },
    });
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

  it('returns a unified artifact catalog with task and model filters', async () => {
    const router = await fixture();
    const registered = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registered.body as { model: { id: string } }).model.id;
    const createdRun = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'turn' },
    });
    expect(createdRun.statusCode).toBe(201);

    const all = await invoke(router, 'get', '/api/sim2real/artifacts');
    expect(all.statusCode).toBe(200);
    expect(all.body).toMatchObject({ ok: true });
    const artifacts = (all.body as { artifacts: Array<{ type: string; modelId?: string }> })
      .artifacts;
    expect(artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'model', modelId })]),
    );

    const filtered = await invoke(router, 'get', '/api/sim2real/artifacts', {
      query: { type: 'model', modelId, limit: '1' },
    });
    expect(filtered.statusCode).toBe(200);
    expect(
      (filtered.body as { artifacts: Array<{ type: string; modelId?: string }> }).artifacts,
    ).toHaveLength(1);
    expect(
      (filtered.body as { artifacts: Array<{ type: string; modelId?: string }> }).artifacts[0],
    ).toMatchObject({ type: 'model', modelId });
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
        models: 3,
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
        JSON.stringify({
          t: 0,
          observation: vector(61, 0),
          action: vector(14, 0),
          reward: 1,
          cmd_vel: { linear: 0.2, angular: -0.3 },
          actionOutput: 'normalized-twist',
          actionScale: { linear: 0.3, angular: 1, units: 'm/s,rad/s' },
          controlHz: 10,
          controlPeriodSeconds: 0.1,
        }),
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
      telemetry: [
        {
          samples: [
            {
              t: 0,
              cmd_vel: { linear: 0.2, angular: -0.3 },
              actionOutput: 'normalized-twist',
              actionScale: { linear: 0.3, angular: 1, units: 'm/s,rad/s' },
              controlHz: 10,
              controlPeriodSeconds: 0.1,
            },
            { t: 0.02 },
          ],
        },
      ],
    });

    const invalidMetadata = await invoke(router, 'post', '/api/sim2real/telemetry', {
      body: {
        runId,
        modelId,
        source: 'import',
        samples: [
          {
            t: 0.03,
            cmd_vel: { linear: 0.31, angular: 0 },
            actionOutput: 'unknown-output',
            controlHz: 0,
          },
        ],
      },
    });
    expect(invalidMetadata.statusCode).toBe(400);
    expect(invalidMetadata.body).toMatchObject({ code: 'SIM2REAL_INVALID_TELEMETRY' });

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
    expect(replay.body.frames).toHaveLength(2);
    expect(replay.body.frames[1]).toMatchObject({ t: 0.02, action: vector(14, 1) });

    // Appending after an evaluation must invalidate the cached summary; the
    // next replay should include every accepted chunk, not the old score.
    const laterChunk = await invoke(router, 'post', '/api/sim2real/telemetry', {
      body: {
        runId,
        modelId,
        source: 'import',
        sequence: 2,
        idempotencyKey: 'chunk-2',
        samples: [{ t: 0.04, observation: vector(61, 2), action: vector(14, 2), reward: 3 }],
      },
    });
    expect(laterChunk.statusCode).toBe(201);
    const freshReplay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(freshReplay.statusCode).toBe(200);
    expect(freshReplay.body).toMatchObject({ replay: { sampleCount: 3, chunkCount: 2 } });
    expect(freshReplay.body.frames).toHaveLength(3);
  });

  it('serves read-only retraining advice for an evaluated run (flywheel never auto-fires)', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        runId,
        modelId,
        source: 'import',
        sequence: 1,
        idempotencyKey: 'adv-1',
        jsonl: [JSON.stringify({ t: 0, observation: vector(61, 0), action: vector(14, 0) })].join(
          '\n',
        ),
      },
    });

    const advice = await invoke(router, 'get', '/api/sim2real/runs/:id/retraining-advice', {
      params: { id: runId },
    });
    expect(advice.statusCode).toBe(200);
    expect(advice.body).toMatchObject({
      ok: true,
      advice: {
        runId,
        // Import-sourced replay never counts as board evidence: honest
        // insufficient-evidence, not a silent "healthy".
        verdict: 'insufficient-evidence',
        boardSamples: 0,
      },
    });
    const adviceBody = advice.body as { advice: { signals: { id: string }[]; note: string } };
    expect(adviceBody.advice.signals.map((signal) => signal.id)).toEqual([
      'action-mae',
      'done-ratio',
      'stale-observation-ratio',
    ]);
    expect(adviceBody.advice.note).toContain('绝不自动发起');

    const missing = await invoke(router, 'get', '/api/sim2real/runs/:id/retraining-advice', {
      params: { id: 'run-does-not-exist' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('carries aligned camera frames from board telemetry into replay, refusing dishonest ones', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    await registerFixtureDevice('device-1');

    // 2x2 rgb8: 12 bytes. Base64 computed from the exact bytes, so a decoder
    // that off-by-ones the padding cannot pass by accident.
    const frame = {
      encoding: 'rgb8',
      width: 2,
      height: 2,
      channels: 3,
      data: 'ChQeKDI8RlBaZG54',
    };
    const accepted = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 1,
        idempotencyKey: 'camera-frame-1',
        samples: [
          { t: 0, observation: vector(61, 0), action: vector(14, 0), cameraFrame: frame },
          { t: 0.02, observation: vector(61, 1), action: vector(14, 1) },
        ],
      },
    });
    expect(accepted.statusCode).toBe(201);

    // The evaluation page reads frames from the replay endpoint, so the frame
    // must survive ingest -> store -> replay unchanged, including the payload.
    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(replay.statusCode).toBe(200);
    const frames = (replay.body as { frames: { cameraFrame?: typeof frame }[] }).frames;
    expect(frames).toHaveLength(2);
    expect(frames[0]?.cameraFrame).toEqual(frame);
    // A vector-only sample in the same chunk must stay frame-free rather than
    // inheriting its neighbour's image.
    expect(frames[1]).not.toHaveProperty('cameraFrame');

    // A frame whose declared shape disagrees with its payload would render as a
    // sheared image while every downstream count still looked healthy.
    const shortPayload = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 2,
        samples: [
          {
            t: 0,
            observation: vector(61, 0),
            action: vector(14, 0),
            cameraFrame: { ...frame, width: 3 },
          },
        ],
      },
    });
    expect(shortPayload.statusCode).toBe(400);
    expect(shortPayload.body).toMatchObject({ code: 'SIM2REAL_INVALID_TELEMETRY' });
    expect(String((shortPayload.body as { message?: string }).message)).toMatch(
      /decodes to 12 bytes/,
    );

    // mono8 declares one byte per pixel; claiming three channels would decode to
    // three times the declared geometry.
    const encodingMismatch = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 3,
        samples: [
          {
            t: 0,
            observation: vector(61, 0),
            action: vector(14, 0),
            cameraFrame: { ...frame, encoding: 'mono8' },
          },
        ],
      },
    });
    expect(encodingMismatch.statusCode).toBe(400);

    // Frames are attestable board evidence: an imported chunk must not be able
    // to place fabricated pixels beside real control data.
    const importedFrame = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'import',
        sequence: 4,
        samples: [{ t: 0, observation: vector(61, 0), action: vector(14, 0), cameraFrame: frame }],
      },
    });
    expect(importedFrame.statusCode).toBe(400);
    expect(String((importedFrame.body as { message?: string }).message)).toMatch(
      /only accepted from board-agent/,
    );

    // Lifecycle markers carry no control data, and the replay filter excludes
    // them, so a frame there would be silently dropped evidence.
    const onEvent = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 5,
        samples: [
          {
            t: 0,
            cameraFrame: frame,
            event: { kind: 'session-started', sessionId: 'sess-camera' },
          },
        ],
      },
    });
    expect(onEvent.statusCode).toBe(400);

    // Non-base64 and otherwise malformed frames are refused up front.
    for (const bad of [
      { ...frame, data: 'not base64!!' },
      { ...frame, channels: 4 },
      { ...frame, width: 0 },
      { ...frame, encoding: 'yuv422' },
      { ...frame, data: 12345 },
    ]) {
      const rejected = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
        params: { id: runId },
        body: {
          source: 'board-agent',
          deviceId: 'device-1',
          sequence: 6,
          samples: [{ t: 0, observation: vector(61, 0), action: vector(14, 0), cameraFrame: bad }],
        },
      });
      expect(rejected.statusCode).toBe(400);
    }
  });

  it('accepts the per-session clock reset at session markers and sums replay duration per session', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    await registerFixtureDevice('device-1');

    const sessionId = 'sess-00000000-0000-0000-0000-000000000001';
    // One chunk carrying two full policy sessions back to back: the board
    // clock restarts near zero after the session-stopped marker, so the
    // second session-started sample is followed by t values below the first
    // session's last timestamp.
    const chunk = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 1,
        idempotencyKey: 'session-reset-1',
        samples: [
          { t: 0, event: { kind: 'session-started', sessionId } },
          { t: 0.1, observation: vector(61, 0), action: vector(14, 0) },
          { t: 0.2, observation: vector(61, 0), action: vector(14, 0) },
          { t: 0.21, event: { kind: 'session-stopped', sessionId } },
          {
            t: 0,
            event: {
              kind: 'session-started',
              sessionId: 'sess-00000000-0000-0000-0000-000000000002',
            },
          },
          { t: 0.05, observation: vector(61, 1), action: vector(14, 1) },
          { t: 0.15, observation: vector(61, 1), action: vector(14, 1) },
          {
            t: 0.16,
            event: {
              kind: 'session-stopped',
              sessionId: 'sess-00000000-0000-0000-0000-000000000002',
            },
          },
        ],
      },
    });
    expect(chunk.statusCode).toBe(201);

    // Regression without a session-started marker at the boundary is still
    // rejected inside one chunk.
    const disordered = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 2,
        idempotencyKey: 'session-reset-2',
        samples: [
          { t: 0.3, observation: vector(61, 0), action: vector(14, 0) },
          { t: 0.25, observation: vector(61, 0), action: vector(14, 0) },
        ],
      },
    });
    expect(disordered.statusCode).toBe(400);

    // Duration is summed per session segment (0.1 + 0.1 = 0.2), not the
    // first-to-last span (0.15) and not the marker count; sessionCount
    // reports the distinct sessions observed.
    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({
      replay: { sampleCount: 4, chunkCount: 1, durationSeconds: 0.2, sessionCount: 2 },
    });
    const warnings = (replay.body as { evaluation: { warnings: string[] } }).evaluation.warnings;
    expect(warnings.join('\n')).toContain('2 policy sessions');
  });

  it('ingests board session lifecycle markers, keeps them out of replay stats, and serves board-sessions', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    await registerFixtureDevice('device-1');

    // A board chunk mixing control samples with lifecycle markers: the
    // uploader batches whatever the spool holds between checkpoints.
    const markerChunk = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 100,
        idempotencyKey: 'board-marker-1',
        samples: [
          {
            t: 0,
            event: {
              kind: 'session-started',
              sessionId: 'sess-11111111-2222-3333-4444-555555555555',
              startedAt: '2026-09-14T00:00:01Z',
              adapterId: 'originbot-differential-drive',
              controlHz: 10,
              mock: false,
              // Goalnav sessions carry their odom-frame task target as
              // evidence: the acceptance question is "did the robot reach
              // THIS point and stop".
              goalX: 1.5,
              goalY: -0.25,
              model: {
                sha256: 'ab'.repeat(32),
                provider: 'CPUExecutionProvider',
                inputDim: 61,
                outputDim: 14,
                bytes: 95 * 1024,
              },
            },
          },
          { t: 0.1, observation: vector(61, 0), action: vector(14, 0), done: true },
          {
            t: 3.2,
            event: {
              kind: 'session-stopped',
              sessionId: 'sess-11111111-2222-3333-4444-555555555555',
              startedAt: '2026-09-14T00:00:01Z',
              stoppedAt: '2026-09-14T00:00:04Z',
              stopReason: 'operator-stop',
              inferenceCount: 31,
              durationSec: 3.0,
              inferMs: 1.4,
              published: 31,
              mock: false,
            },
          },
        ],
      },
    });
    expect(markerChunk.statusCode).toBe(201);
    expect(markerChunk.body).toMatchObject({ acceptedSamples: 3 });

    // Replay statistics describe control data only: one sample, not three.
    const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
      params: { id: runId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({
      replay: { sampleCount: 1, chunkCount: 1, doneCount: 1 },
    });

    // Lifecycle markers must not appear in the replay frames either.
    const frames = (replay.body as { frames: unknown[] }).frames;
    expect(frames).toHaveLength(1);
    expect(frames[0]).not.toHaveProperty('event');

    const sessions = await invoke(router, 'get', '/api/sim2real/runs/:id/board-sessions', {
      params: { id: runId },
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.body).toMatchObject({
      ok: true,
      runId,
      count: 1,
      sessions: [
        {
          sessionId: 'sess-11111111-2222-3333-4444-555555555555',
          startedAt: '2026-09-14T00:00:01Z',
          stoppedAt: '2026-09-14T00:00:04Z',
          stopReason: 'operator-stop',
          inferenceCount: 31,
          inferMs: 1.4,
          published: 31,
          deviceId: 'device-1',
          goalX: 1.5,
          goalY: -0.25,
          // Cookie-owner uploads are not server-attested: review-only.
          attested: false,
          chunks: 1,
          events: 2,
          model: { sha256: 'ab'.repeat(32) },
        },
      ],
    });

    const missing = await invoke(router, 'get', '/api/sim2real/runs/:id/board-sessions', {
      params: { id: 'run-does-not-exist' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects lifecycle markers that carry control data or malformed fields', async () => {
    const router = await fixture();
    const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });
    const modelId = (registerResponse.body as { model: { id: string } }).model.id;
    const runResponse = await invoke(router, 'post', '/api/sim2real/runs', {
      body: { modelId, backend: 'contract', taskId: 'walk' },
    });
    const runId = (runResponse.body as { run: { id: string } }).run.id;
    await registerFixtureDevice('device-1');

    const mixed = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 100,
        samples: [
          {
            t: 0,
            action: vector(14, 0),
            event: { kind: 'session-started', sessionId: 'sess-1' },
          },
        ],
      },
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.body).toMatchObject({ code: 'SIM2REAL_INVALID_TELEMETRY' });

    const noSessionId = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 101,
        samples: [{ t: 0, event: { kind: 'session-started' } }],
      },
    });
    expect(noSessionId.statusCode).toBe(400);

    const unknownKind = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 102,
        samples: [{ t: 0, event: { kind: 'session-restarted', sessionId: 'sess-1' } }],
      },
    });
    expect(unknownKind.statusCode).toBe(400);

    const badTimestamp = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 103,
        samples: [
          {
            t: 0,
            event: {
              kind: 'session-started',
              sessionId: 'sess-1',
              startedAt: '14/09/2026 00:00:01',
            },
          },
        ],
      },
    });
    expect(badTimestamp.statusCode).toBe(400);

    // The goalnav goal evidence is bounded like every other numeric event
    // field: out-of-range or non-numeric goals must not ride the marker.
    const badGoal = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 104,
        samples: [
          {
            t: 0,
            event: { kind: 'session-started', sessionId: 'sess-1', goalX: 5_000 },
          },
        ],
      },
    });
    expect(badGoal.statusCode).toBe(400);
    expect(badGoal.body).toMatchObject({ code: 'SIM2REAL_INVALID_TELEMETRY' });

    const nonNumericGoal = await invoke(router, 'post', '/api/sim2real/runs/:id/telemetry', {
      params: { id: runId },
      body: {
        source: 'board-agent',
        deviceId: 'device-1',
        sequence: 105,
        samples: [
          {
            t: 0,
            event: { kind: 'session-started', sessionId: 'sess-1', goalY: 'east' },
          },
        ],
      },
    });
    expect(nonNumericGoal.statusCode).toBe(400);
    expect(nonNumericGoal.body).toMatchObject({ code: 'SIM2REAL_INVALID_TELEMETRY' });
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
    expect(evaluatedWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('mixed sources')]),
    );
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
    const detailDeployment = (
      details.body as {
        deployment: { status: string; steps: Array<{ id: string; status: string }> };
      }
    ).deployment;
    expect(detailDeployment.status).toBe('blocked');
    expect(detailDeployment.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'board-passport', status: 'blocked' }),
      ]),
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

  it('routes an explicit training engine through to the local worker payload', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18199/train';
    delete process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
    const originalFetch = globalThis.fetch;
    let workerTraining: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      workerTraining = body.training as Record<string, unknown>;
      return new Response(JSON.stringify({ status: 'queued', runId: 'local-engine-run-1' }), {
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
          idempotencyKey: 'local-engine-run-1',
          training: { profile: 'smoke', engine: 'mjx-ppo' },
        },
      });
      expect(response.statusCode).toBe(201);
      const run = (response.body as { run: Record<string, unknown> }).run;
      expect(run.training).toMatchObject({ profile: 'smoke', engine: 'mjx-ppo' });
      expect(workerTraining).toMatchObject({ profile: 'smoke', engine: 'mjx-ppo' });

      // A typo'd engine is rejected at the API boundary with the same
      // code path as other invalid training parameters.
      const rejected = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId: registered.model.id,
          backend: 'local',
          idempotencyKey: 'local-engine-run-typo',
          training: { profile: 'smoke', engine: 'isaac' },
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.body).toMatchObject({ code: 'SIM2REAL_INVALID_TRAINING' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('injects a physics-dense task pack engine recommendation but never overrides an explicit choice', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18199/train';
    delete process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
    const originalFetch = globalThis.fetch;
    const workerTrainings: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      workerTrainings.push(body.training as Record<string, unknown>);
      return new Response(JSON.stringify({ status: 'queued', runId: 'local-engine-rec-1' }), {
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

      // No explicit engine: the physics-dense pack's recommendation fills in
      // mjx-ppo for both the ledger record and the worker payload.
      const recommended = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId: registered.model.id,
          backend: 'local',
          idempotencyKey: 'local-engine-rec-recommended',
          taskId: 'originbot-physics-navigation',
          training: { profile: 'smoke' },
        },
      });
      expect(recommended.statusCode).toBe(201);
      const run = (recommended.body as { run: Record<string, unknown> }).run;
      expect(run.training).toMatchObject({ profile: 'smoke', engine: 'mjx-ppo' });
      expect(workerTrainings[workerTrainings.length - 1]).toMatchObject({
        profile: 'smoke',
        engine: 'mjx-ppo',
      });

      // An explicit starter-ppo choice wins over the same recommendation.
      const explicit = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId: registered.model.id,
          backend: 'local',
          idempotencyKey: 'local-engine-rec-explicit',
          taskId: 'originbot-physics-navigation',
          training: { profile: 'smoke', engine: 'starter-ppo' },
        },
      });
      expect(explicit.statusCode).toBe(201);
      expect((explicit.body as { run: Record<string, unknown> }).run.training).toMatchObject({
        profile: 'smoke',
        engine: 'starter-ppo',
      });
      expect(workerTrainings[workerTrainings.length - 1]).toMatchObject({
        profile: 'smoke',
        engine: 'starter-ppo',
      });

      // A kinematic task pack stays engine-silent: the spec keeps the
      // platform default and the worker payload carries no engine field.
      const kinematic = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId: registered.model.id,
          backend: 'local',
          idempotencyKey: 'local-engine-rec-kinematic',
          taskId: 'originbot-goal-navigation',
          training: { profile: 'smoke' },
        },
      });
      expect(kinematic.statusCode).toBe(201);
      expect((kinematic.body as { run: Record<string, unknown> }).run.training).toMatchObject({
        profile: 'smoke',
      });
      expect((kinematic.body as { run: Record<string, unknown> }).run.training).not.toHaveProperty(
        'engine',
      );
      expect(workerTrainings[workerTrainings.length - 1]).not.toHaveProperty('engine');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires a strong token before registering a production GPU worker', async () => {
    process.env.NODE_ENV = 'production';
    const router = await fixture();
    const response = await invoke(router, 'post', '/api/sim2real/compute-resources', {
      body: {
        name: 'exposed-gpu',
        runnerUrl: 'http://10.0.0.8:19091/train',
        runnerToken: 'short-fixture-token',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'SIM2REAL_INVALID_COMPUTE_RESOURCE_TOKEN' });
  });

  it('probes a compute worker with redirect, payload, and body-size guards', async () => {
    const router = await fixture();
    const created = await invoke(router, 'post', '/api/sim2real/compute-resources', {
      body: {
        name: 'loopback-gpu',
        runnerUrl: 'http://127.0.0.1:19091/train',
      },
    });
    expect(created.statusCode).toBe(201);
    const resourceId = (created.body as { computeResource: { id: string } }).computeResource.id;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      expect(init?.redirect).toBe('error');
      if (calls === 1) {
        return new Response(JSON.stringify({ ok: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('x'.repeat(33 * 1024), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const invalidHealth = await invoke(
        router,
        'post',
        '/api/sim2real/compute-resources/:id/test',
        { params: { id: resourceId } },
      );
      expect(invalidHealth.statusCode).toBe(200);
      expect(invalidHealth.body).toMatchObject({
        connected: false,
        computeResource: { status: 'offline', message: 'Worker 返回无效健康响应。' },
      });

      const oversizedHealth = await invoke(
        router,
        'post',
        '/api/sim2real/compute-resources/:id/test',
        { params: { id: resourceId } },
      );
      expect(oversizedHealth.statusCode).toBe(200);
      expect(oversizedHealth.body).toMatchObject({
        connected: false,
        computeResource: {
          status: 'offline',
          message: 'Worker 健康响应过大或无法读取，已拒绝。',
        },
      });
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps browser-relayed GPU resources out of server-side health probes', async () => {
    const router = await fixture();
    const created = await invoke(router, 'post', '/api/sim2real/compute-resources', {
      body: {
        name: 'browser-agent-gpu',
        source: 'local-agent',
        runnerUrl: 'http://127.0.0.1:19190/proxy',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.computeResource).toMatchObject({ source: 'local-agent' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('server must not probe a user loopback agent');
    }) as typeof fetch;
    try {
      const resourceId = created.body.computeResource.id;
      const tested = await invoke(router, 'post', '/api/sim2real/compute-resources/:id/test', {
        params: { id: resourceId },
      });
      expect(tested.statusCode).toBe(200);
      expect(tested.body).toMatchObject({
        browserRelay: true,
        connected: false,
        computeResource: { source: 'local-agent' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs through an account-owned GPU resource when the global runner is absent', async () => {
    delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/healthz')) {
        return new Response(
          JSON.stringify({
            ok: true,
            worker: 'sim2real-local',
            cuda: true,
            gpuName: 'Test GPU',
            maxConcurrentJobs: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ status: 'queued', runId: 'resource-run-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const created = await invoke(router, 'post', '/api/sim2real/compute-resources', {
        body: { name: 'owned-gpu', runnerUrl: 'http://127.0.0.1:19091/train' },
      });
      expect(created.statusCode).toBe(201);
      const resourceId = (created.body as { computeResource: { id: string } }).computeResource.id;
      const tested = await invoke(router, 'post', '/api/sim2real/compute-resources/:id/test', {
        params: { id: resourceId },
      });
      expect(tested.body).toMatchObject({
        connected: true,
        computeResource: {
          status: 'online',
          cuda: true,
          gpuName: 'Test GPU',
          maxConcurrentJobs: 2,
        },
      });

      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registered = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registered.body as { model: { id: string } }).model.id;
      const run = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId,
          backend: 'local',
          computeResourceId: resourceId,
          idempotencyKey: 'owned-resource-run-1',
        },
      });
      expect(run.statusCode).toBe(201);
      expect(run.body).toMatchObject({
        run: { status: 'queued', externalRunId: 'resource-run-1', computeResourceId: resourceId },
      });
      expect(calls).toEqual(['http://127.0.0.1:19091/healthz', 'http://127.0.0.1:19091/train']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('invalidates GPU health evidence when its endpoint or token changes', async () => {
    delete process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/healthz')) {
        return new Response(JSON.stringify({ ok: true, worker: 'sim2real-local', cuda: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'queued', runId: 'must-not-launch' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const created = await invoke(router, 'post', '/api/sim2real/compute-resources', {
        body: { name: 'mutable-gpu', runnerUrl: 'http://127.0.0.1:19091/train' },
      });
      const resourceId = (created.body as { computeResource: { id: string } }).computeResource.id;
      const firstTest = await invoke(router, 'post', '/api/sim2real/compute-resources/:id/test', {
        params: { id: resourceId },
      });
      expect(firstTest.body).toMatchObject({
        connected: true,
        computeResource: { status: 'online' },
      });

      const endpointPatch = await invoke(router, 'patch', '/api/sim2real/compute-resources/:id', {
        params: { id: resourceId },
        body: { runnerUrl: 'http://127.0.0.1:19092/train' },
      });
      expect(endpointPatch.body).toMatchObject({
        computeResource: { status: 'unknown', message: '尚未重新测试。' },
      });
      expect(
        (endpointPatch.body as { computeResource: Record<string, unknown> }).computeResource,
      ).not.toHaveProperty('lastCheckedAt');

      const secondTest = await invoke(router, 'post', '/api/sim2real/compute-resources/:id/test', {
        params: { id: resourceId },
      });
      expect(secondTest.body).toMatchObject({
        connected: true,
        computeResource: { status: 'online' },
      });

      const tokenPatch = await invoke(router, 'patch', '/api/sim2real/compute-resources/:id', {
        params: { id: resourceId },
        body: { runnerToken: 'loopback-token-rotated' },
      });
      expect(tokenPatch.body).toMatchObject({
        computeResource: { status: 'unknown', message: '尚未重新测试。' },
      });

      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registered = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registered.body as { model: { id: string } }).model.id;
      const launch = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId,
          backend: 'local',
          computeResourceId: resourceId,
          idempotencyKey: 'stale-compute-health-run',
        },
      });
      expect(launch.statusCode).toBe(201);
      expect(launch.body).toMatchObject({
        run: { status: 'blocked', summary: expect.stringContaining('最近一次健康检查') },
      });
      // Two successful health checks were allowed; after the token edit the
      // stale resource must be blocked before the /train side effect.
      expect(calls).toEqual(['http://127.0.0.1:19091/healthz', 'http://127.0.0.1:19092/healthz']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never falls back to the global runner after a selected GPU resource is deleted', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/healthz')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'queued', runId: 'deleted-resource-run' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const created = await invoke(router, 'post', '/api/sim2real/compute-resources', {
        body: { name: 'temporary-gpu', runnerUrl: 'http://127.0.0.1:19091/train' },
      });
      const resourceId = (created.body as { computeResource: { id: string } }).computeResource.id;
      await invoke(router, 'post', '/api/sim2real/compute-resources/:id/test', {
        params: { id: resourceId },
      });
      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registered = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registered.body as { model: { id: string } }).model.id;
      const launched = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId,
          backend: 'local',
          computeResourceId: resourceId,
          idempotencyKey: 'deleted-resource-run-key',
        },
      });
      const runId = (launched.body as { run: { id: string } }).run.id;
      expect(launched.body).toMatchObject({ run: { status: 'queued' } });
      await invoke(router, 'delete', '/api/sim2real/compute-resources/:id', {
        params: { id: resourceId },
      });

      const status = await invoke(router, 'get', '/api/sim2real/runs/:id', {
        params: { id: runId },
      });
      expect(status.statusCode).toBe(409);
      expect(status.body).toMatchObject({ code: 'SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND' });
      expect(calls).toEqual(['http://127.0.0.1:19091/healthz', 'http://127.0.0.1:19091/train']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('expires online GPU health evidence before launch and reconciliation', async () => {
    process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS = '30';
    const router = await fixture();
    const created = await invoke(router, 'post', '/api/sim2real/compute-resources', {
      body: { name: 'stale-gpu', runnerUrl: 'http://127.0.0.1:19091/train' },
    });
    const resourceId = (created.body as { computeResource: { id: string } }).computeResource.id;
    await invoke(router, 'post', '/api/sim2real/compute-resources/:id/test', {
      params: { id: resourceId },
    });
    await updateSim2RealComputeResource(
      resourceId,
      {
        status: 'online',
        lastCheckedAt: new Date(Date.now() - 31_000).toISOString(),
      } as never,
      undefined,
    );

    const listed = await invoke(router, 'get', '/api/sim2real/compute-resources');
    expect(listed.body).toMatchObject({
      computeResources: [{ id: resourceId, status: 'unknown' }],
    });

    const manifest = userManifest();
    manifest.simulator.backends = ['local'];
    const registered = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest },
    });
    const modelId = (registered.body as { model: { id: string } }).model.id;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('stale resource must not call a runner');
    }) as typeof fetch;
    try {
      const launch = await invoke(router, 'post', '/api/sim2real/runs', {
        body: {
          modelId,
          backend: 'local',
          computeResourceId: resourceId,
          idempotencyKey: 'stale-resource-launch',
        },
      });
      expect(launch.body).toMatchObject({
        run: {
          status: 'blocked',
          summary: expect.stringContaining('超过 30 秒'),
        },
      });

      const reserved = await reserveSim2RealRun(
        {
          modelId,
          backend: 'local',
          computeResourceId: resourceId,
          status: 'queued',
          summary: 'reserved before stale reconcile',
        },
        undefined,
        { idempotencyKey: 'stale-resource-reconcile' },
      );
      const reconcile = await invoke(router, 'post', '/api/sim2real/runs/:id/reconcile', {
        params: { id: reserved.run.id },
        body: { externalRunId: 'stale-run-1', confirm: true },
      });
      expect(reconcile.statusCode).toBe(503);
      expect(reconcile.body).toMatchObject({
        code: 'SIM2REAL_COMPUTE_RESOURCE_HEALTH_STALE',
        retryable: true,
      });
      expect(calls).toBe(0);
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

  it('auto-attaches evaluation telemetry when a status poll first observes completion', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    const originalFetch = globalThis.fetch;
    const telemetryJsonl = [
      JSON.stringify({
        t: 0,
        observation: [0, 0, 0, 1, 1, 0, 0, 0],
        action: [0.1, 0],
        reward: 0,
        done: false,
      }),
      JSON.stringify({
        t: 0.1,
        observation: [0.05, 0, 0, 1, 0.95, 0, 0.05, 0],
        action: [0.1, 0.1],
        reward: 0.05,
        done: false,
      }),
    ].join('\n');
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/telemetry')) {
        const bytes = new TextEncoder().encode(telemetryJsonl);
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/x-ndjson',
            'content-length': String(bytes.byteLength),
          },
        });
      }
      if (url.endsWith('/train')) {
        // Launch answer: the job is accepted and still queued, so the run
        // stays pollable and the completion transition happens via GET.
        return new Response(JSON.stringify({ status: 'queued', runId: 'eval-attach-run' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Worker status view: completed run with an ONNX artifact record.
      return new Response(
        JSON.stringify({
          status: 'completed',
          runId: 'eval-attach-run',
          artifact: {
            artifactRef: 'artifact://starter/eval-attach/0.1/policy.onnx',
            format: 'onnx',
            sha256: 'b'.repeat(64),
            sizeBytes: 1024,
          },
          progress: [
            {
              iteration: 1,
              totalIterations: 4,
              meanReward: -0.004,
              recentSuccess: 0,
              elapsedSeconds: 0.7,
            },
            {
              iteration: 2,
              totalIterations: 4,
              meanReward: -0.006,
              recentSuccess: 0.01,
              elapsedSeconds: 1.1,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const router = await fixture();
      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const started = await invoke(router, 'post', '/api/sim2real/runs', {
        body: { modelId, backend: 'local', idempotencyKey: 'eval-attach-key' },
      });
      expect(started.statusCode).toBe(201);
      const runId = (started.body as { run: { id: string } }).run.id;
      // The status poll transitions the run to completed and auto-attaches.
      const status = await invoke(router, 'get', '/api/sim2real/runs/:id', {
        params: { id: runId },
      });
      expect(status.statusCode).toBe(200);
      expect((status.body as { run: Record<string, unknown> }).run.status).toBe('completed');
      expect(requests.some((url) => url.endsWith('/runs/eval-attach-run/telemetry'))).toBe(true);
      // Worker-parsed live progress flows onto the run record and the status
      // view so the train page can draw the live curve.
      const progressPoints = (status.body as { run: { progress?: unknown[] } }).run.progress;
      expect(Array.isArray(progressPoints) && progressPoints.length).toBe(2);
      expect((progressPoints as Array<Record<string, unknown>>)[0]).toMatchObject({
        iteration: 1,
        totalIterations: 4,
        meanReward: -0.004,
      });
      // The replay endpoint now returns the engine's evaluation frames.
      const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
        params: { id: runId },
      });
      expect(replay.statusCode).toBe(200);
      const frames = (replay.body as { frames: unknown[] }).frames;
      expect(Array.isArray(frames) && frames.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries the auto-attach telemetry fetch when the first transport attempt fails', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    const originalFetch = globalThis.fetch;
    const telemetryJsonl = [
      JSON.stringify({
        t: 0,
        observation: [0, 0, 0, 1, 1, 0, 0, 0],
        action: [0.1, 0],
        reward: 0,
        done: false,
      }),
    ].join('\n');
    let telemetryAttempts = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/telemetry')) {
        telemetryAttempts += 1;
        // First attempt simulates a tunnel blip; the retry must recover.
        if (telemetryAttempts === 1) return new Response('gateway gone', { status: 502 });
        const bytes = new TextEncoder().encode(telemetryJsonl);
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/x-ndjson',
            'content-length': String(bytes.byteLength),
          },
        });
      }
      if (url.endsWith('/train')) {
        return new Response(JSON.stringify({ status: 'queued', runId: 'eval-retry-run' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          runId: 'eval-retry-run',
          artifact: {
            artifactRef: 'artifact://starter/eval-retry/0.1/policy.onnx',
            format: 'onnx',
            sha256: 'c'.repeat(64),
            sizeBytes: 1024,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const router = await fixture();
      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const started = await invoke(router, 'post', '/api/sim2real/runs', {
        body: { modelId, backend: 'local', idempotencyKey: 'eval-retry-key' },
      });
      expect(started.statusCode).toBe(201);
      const runId = (started.body as { run: { id: string } }).run.id;
      const status = await invoke(router, 'get', '/api/sim2real/runs/:id', {
        params: { id: runId },
      });
      expect(status.statusCode).toBe(200);
      expect((status.body as { run: Record<string, unknown> }).run.status).toBe('completed');
      expect(telemetryAttempts).toBeGreaterThanOrEqual(2);
      const replay = await invoke(router, 'get', '/api/sim2real/runs/:id/replay', {
        params: { id: runId },
      });
      expect(replay.statusCode).toBe(200);
      const frames = (replay.body as { frames: unknown[] }).frames;
      expect(Array.isArray(frames) && frames.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('serves digest-verified policy bytes for the browser trial only after completion', async () => {
    process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL = 'http://127.0.0.1:18198/train';
    const originalFetch = globalThis.fetch;
    const { createHash } = await import('node:crypto');
    const policyBytes = Buffer.from('fake-onnx-policy-bytes-for-trial');
    const digest = createHash('sha256').update(policyBytes).digest('hex');
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/artifact')) {
        return new Response(new Uint8Array(policyBytes), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(policyBytes.byteLength),
            'x-artifact-sha256': digest,
          },
        });
      }
      if (url.endsWith('/train')) {
        // Launch answer keeps the run queued so the completion transition
        // happens through the status poll below.
        return new Response(JSON.stringify({ status: 'queued', runId: 'trial-bytes-run' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          runId: 'trial-bytes-run',
          artifact: {
            artifactId: 'trial-policy',
            artifactRef: 'artifact://starter/trial/0.1/policy.onnx',
            kind: 'source',
            format: 'onnx',
            sha256: digest,
            sizeBytes: policyBytes.byteLength,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const router = await fixture();
      const manifest = userManifest();
      manifest.simulator.backends = ['local'];
      const registerResponse = await invoke(router, 'post', '/api/sim2real/models', {
        body: { manifest },
      });
      const modelId = (registerResponse.body as { model: { id: string } }).model.id;
      const started = await invoke(router, 'post', '/api/sim2real/runs', {
        body: { modelId, backend: 'local', idempotencyKey: 'trial-bytes-key' },
      });
      const runId = (started.body as { run: { id: string } }).run.id;
      // Before the completion transition the trial endpoint fails closed.
      const early = await invoke(router, 'get', '/api/sim2real/runs/:id/policy.onnx', {
        params: { id: runId },
      });
      expect(early.statusCode).toBe(409);
      expect(early.body).toMatchObject({ code: 'SIM2REAL_POLICY_TRIAL_NOT_AVAILABLE' });
      // Complete the run via the status poll.
      await invoke(router, 'get', '/api/sim2real/runs/:id', { params: { id: runId } });
      const trial = await invoke(router, 'get', '/api/sim2real/runs/:id/policy.onnx', {
        params: { id: runId },
      });
      expect(trial.statusCode).toBe(200);
      expect(trial.headers['x-artifact-sha256']).toBe(digest);
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
      await fixture();
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
      expect(
        (unchanged.body as { run: Record<string, unknown> }).run.externalRunId,
      ).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('projects Local Bridge status and forwards only the browser session cookie', async () => {
    process.env.RDK_SIM2REAL_STUDIO_ORIGIN = 'https://studio.example.test';
    const originalFetch = globalThis.fetch;
    let calledUrl = '';
    let calledInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      calledUrl = String(input);
      calledInit = init;
      return new Response(
        JSON.stringify({
          ok: true,
          secret: 'upstream-secret',
          bridges: [
            {
              bridgeId: 'bridge-a',
              online: true,
              devices: [
                {
                  id: 'device-a',
                  host: '10.0.0.2',
                  name: 'OriginBot',
                  username: 'root',
                  transport: 'ssh',
                  probeOk: true,
                  token: 'must-not-leak',
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const router = await fixture();
      const response = await invoke(router, 'get', '/api/sim2real/local-bridge/status', {
        headers: { cookie: 'studio_session=abc123' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        bridges: [
          {
            bridgeId: 'bridge-a',
            online: true,
            devices: [
              {
                bridgeDeviceId: 'device-a',
                id: 'device-a',
                host: '10.0.0.2',
                name: 'OriginBot',
                username: 'root',
                transport: 'ssh',
                probeOk: true,
              },
            ],
          },
        ],
      });
      expect(JSON.stringify(response.body)).not.toContain('upstream-secret');
      expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
      expect(calledUrl).toBe('https://studio.example.test/api/local-bridge/status');
      expect(calledInit?.redirect).toBe('error');
      expect(calledInit?.headers).toMatchObject({
        accept: 'application/json',
        cookie: 'studio_session=abc123',
      });
      expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('whitelists Local Bridge pairing and connect payloads', async () => {
    process.env.RDK_SIM2REAL_STUDIO_ORIGIN = 'https://studio.example.test';
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/pairing-code')) {
        return new Response(
          JSON.stringify({
            ok: true,
            command: '#!/bin/sh\necho connected',
            oneliner: 'echo connected',
            message: 'ready',
            secret: 'do-not-forward',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          device: {
            bridgeId: 'bridge-a',
            bridgeDeviceId: 'device-a',
            id: 'device-a',
            name: 'OriginBot',
            host: '10.0.0.2',
            port: 22,
            username: 'root',
            transport: 'ssh',
            boardPlatform: 'x5',
            boardModel: 'originbot',
            secret: 'do-not-forward',
          },
          secret: 'do-not-forward',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const router = await fixture();
      const pairing = await invoke(router, 'post', '/api/sim2real/local-bridge/pairing-code', {
        headers: { cookie: 'studio_session=abc123' },
        body: {
          host: '10.0.0.2',
          sshUser: 'root',
          sshPort: 22,
          sshPassword: 'p@ss word',
          secret: 'drop-me',
        },
      });
      expect(pairing.statusCode).toBe(200);
      expect(pairing.body).toEqual({
        ok: true,
        command: '#!/bin/sh\necho connected',
        oneliner: 'echo connected',
        message: 'ready',
      });
      expect(JSON.stringify(pairing.body)).not.toContain('do-not-forward');
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        host: '10.0.0.2',
        sshUser: 'root',
        sshPort: 22,
        sshPassword: 'p@ss word',
      });
      expect(calls[0]?.init?.redirect).toBe('error');

      const connected = await invoke(
        router,
        'post',
        '/api/sim2real/local-bridge/devices/:bridgeDeviceId/connect',
        {
          params: { bridgeDeviceId: 'device-a' },
          headers: { cookie: 'studio_session=abc123' },
          body: { bridgeId: 'bridge-a', secret: 'drop-me' },
        },
      );
      expect(connected.statusCode).toBe(200);
      expect(connected.body).toMatchObject({
        ok: true,
        device: {
          bridgeId: 'bridge-a',
          bridgeDeviceId: 'device-a',
          host: '10.0.0.2',
          boardPlatform: 'x5',
          boardModel: 'originbot',
        },
      });
      expect(JSON.stringify(connected.body)).not.toContain('do-not-forward');
      expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ bridgeId: 'bridge-a' });
      expect(calls[1]?.init?.redirect).toBe('error');
      expect(calls[1]?.init?.headers).toMatchObject({ cookie: 'studio_session=abc123' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('collapses Local Bridge transport, timeout, and oversized responses to generic 502 errors', async () => {
    process.env.RDK_SIM2REAL_STUDIO_ORIGIN = 'https://studio.example.test';
    process.env.RDK_SIM2REAL_STUDIO_UPSTREAM_TIMEOUT_MS = '100';
    const originalFetch = globalThis.fetch;
    let call = 0;
    const redirects: unknown[] = [];
    globalThis.fetch = (async (_input, init) => {
      redirects.push(init?.redirect);
      call += 1;
      if (call === 1) throw new Error('proxy body contains secret=abc');
      if (call === 2) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(70 * 1024)));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout secret=abc')), {
          once: true,
        });
      });
    }) as typeof fetch;
    try {
      const router = await fixture();
      const transport = await invoke(router, 'get', '/api/sim2real/local-bridge/status');
      expect(transport.statusCode).toBe(502);
      expect(transport.body).toMatchObject({
        code: 'SIM2REAL_STUDIO_BRIDGE_UNAVAILABLE',
        retryable: true,
      });
      expect(JSON.stringify(transport.body)).not.toContain('secret=abc');

      const oversized = await invoke(router, 'post', '/api/sim2real/local-bridge/pairing-code', {
        body: { host: '10.0.0.2', sshUser: 'root', sshPort: 22 },
      });
      expect(oversized.statusCode).toBe(502);
      expect(JSON.stringify(oversized.body)).not.toContain('x'.repeat(32));

      const timeout = await invoke(router, 'get', '/api/sim2real/local-bridge/status');
      expect(timeout.statusCode).toBe(502);
      expect(timeout.body).toMatchObject({
        code: 'SIM2REAL_STUDIO_BRIDGE_UNAVAILABLE',
        retryable: true,
      });
      expect(redirects).toEqual(['error', 'error', 'error']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps a storage writer-lease conflict to an actionable, non-retryable 503', async () => {
    const router = await fixture();
    const storageRoot = process.env.RDK_SIM2REAL_STORAGE_DIR as string;
    await fs.mkdir(storageRoot, { recursive: true });
    // Same host, live foreign pid: pid 1 always exists, and a non-root
    // process.kill(1, 0) reports EPERM, which the lease treats as alive. The
    // previous pid keeps the record from ever matching this process.
    await fs.writeFile(
      path.join(storageRoot, 'writer-lease.json'),
      JSON.stringify({
        schemaVersion: 1,
        host: os.hostname(),
        pid: process.pid === 1 ? 2 : 1,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );

    const response = await invoke(router, 'post', '/api/sim2real/models', {
      body: { manifest: userManifest() },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      code: 'SIM2REAL_STORAGE_WRITER_CONFLICT',
      retryable: false,
    });
    // The remediation advice must survive into the operator-visible message.
    expect(String((response.body as { message: string }).message)).toContain(
      'RDK_SIM2REAL_STORAGE_DIR',
    );
  });

  it('stores granular feedback with owner scoping, bounded notes and closed-contract degradation', async () => {
    const router = await fixture();

    const posted = await invoke(router, 'post', '/api/sim2real/feedback', {
      body: {
        surface: 'retraining-advice',
        verdict: 'inaccurate',
        note: '阈值太宽松，实际板上表现更差。',
        runId: 'run-feedback-1',
      },
    });
    expect(posted.statusCode).toBe(201);
    const created = (posted.body as { feedback: Record<string, unknown> }).feedback;
    expect(created.surface).toBe('retraining-advice');
    expect(created.verdict).toBe('inaccurate');
    expect(created.note).toBe('阈值太宽松，实际板上表现更差。');
    expect(created.runId).toBe('run-feedback-1');
    expect(typeof created.id).toBe('string');
    expect(typeof created.createdAt).toBe('string');
    expect(posted.body).not.toHaveProperty('degraded');

    // Stale-client values degrade instead of 4xx: unknown surface/verdict map
    // into the closed contract and the response flags the degradation.
    const degraded = await invoke(router, 'post', '/api/sim2real/feedback', {
      body: { surface: 'legacy-widget', verdict: 'kinda' },
    });
    expect(degraded.statusCode).toBe(201);
    const degradedRecord = (degraded.body as { feedback: Record<string, unknown> }).feedback;
    expect(degradedRecord.surface).toBe('run-record');
    expect(degradedRecord.verdict).toBe('inaccurate');
    expect((degraded.body as { degraded: Record<string, boolean> }).degraded).toMatchObject({
      surface: true,
      verdict: true,
    });

    const listed = await invoke(router, 'get', '/api/sim2real/feedback');
    expect(listed.statusCode).toBe(200);
    const list = listed.body as {
      feedback: Array<Record<string, unknown>>;
      surfaces: string[];
      verdicts: string[];
      noteMaxChars: number;
    };
    expect(list.feedback).toHaveLength(2);
    expect(list.surfaces).toEqual(['retraining-advice', 'agent-reply', 'run-record']);
    expect(list.verdicts).toEqual(['accurate', 'inaccurate']);
    expect(list.noteMaxChars).toBe(600);
    // Owner private marker must never leak into the API surface.
    expect(JSON.stringify(list.feedback)).not.toContain('"owner"');

    const rejected = await invoke(router, 'post', '/api/sim2real/feedback', {
      body: { surface: 'run-record', verdict: 'accurate', note: 'x'.repeat(601) },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).toMatchObject({ code: 'SIM2REAL_INVALID_FEEDBACK' });
  });

  it('summarizes feedback into reliance aggregates without leaking owners (Bakusevych #38)', async () => {
    const router = await fixture();
    // Seed: two accurate retraining-advice votes, one inaccurate agent-reply.
    for (const [surface, verdict] of [
      ['retraining-advice', 'accurate'],
      ['retraining-advice', 'accurate'],
      ['agent-reply', 'inaccurate'],
    ] as const) {
      const posted = await invoke(router, 'post', '/api/sim2real/feedback', {
        body: { surface, verdict },
      });
      expect(posted.statusCode).toBe(201);
    }

    const summarized = await invoke(router, 'get', '/api/sim2real/feedback/summary');
    expect(summarized.statusCode).toBe(200);
    const summary = (summarized.body as { summary: Record<string, unknown> }).summary;
    expect(summary.total).toBe(3);
    expect(summary.accurate).toBe(2);
    expect(summary.inaccurate).toBe(1);
    expect(summary.windowDays).toBe(30);
    expect(summary.bySurface).toEqual([
      { surface: 'retraining-advice', total: 2, accurate: 2 },
      { surface: 'agent-reply', total: 1, accurate: 0 },
    ]);
    // Aggregates only — no notes, no ids, no owners.
    expect(JSON.stringify(summary)).not.toContain('"owner"');
    expect(JSON.stringify(summary)).not.toContain('note');

    // A fresh storage dir reports an honest empty summary, not an error.
    const empty = await invoke(await fixture(), 'get', '/api/sim2real/feedback/summary');
    expect(empty.statusCode).toBe(200);
    expect(
      (empty.body as { summary: { total: number; bySurface: unknown[] } }).summary,
    ).toMatchObject({
      total: 0,
      accurate: 0,
      inaccurate: 0,
    });
    expect((empty.body as { summary: { bySurface: unknown[] } }).summary.bySurface).toEqual([]);
  });

  it('enforces the summary window: stale records drop out of "近 30 天" counts', async () => {
    // The label promises a rolling window, so the aggregation must actually
    // apply it — a record older than windowDays is excluded even though it is
    // still stored (the list endpoint keeps serving it).
    const summarize = (await import('../sim2real/workspace-feedback.js')).summarizeSim2RealFeedback;
    const now = new Date().toISOString();
    const stale = {
      id: 'fb-stale',
      surface: 'run-record',
      verdict: 'accurate',
      note: '旧投票，不该再计入近 30 天汇总',
      createdAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const fresh = {
      id: 'fb-fresh',
      surface: 'run-record',
      verdict: 'inaccurate',
      note: '新投票',
      createdAt: now,
    };
    const result = summarize([stale, fresh], undefined);
    expect(result.total).toBe(1);
    expect(result.inaccurate).toBe(1);
    expect(result.windowDays).toBe(30);
    // A record whose createdAt cannot be parsed is excluded rather than
    // relabeled into the window.
    const unparseable = summarize(
      [{ ...fresh, id: 'fb-bad-date', createdAt: 'not-a-date' }, fresh],
      undefined,
    );
    expect(unparseable.total).toBe(1);
  });

  it('serves workspace notices anonymously: package version plus degraded storage state', async () => {
    const router = await fixture();
    const notices = await invoke(router, 'get', '/api/sim2real/notices');
    expect(notices.statusCode).toBe(200);
    const payload = notices.body as {
      notices: Array<{ id: string; kind: string; title: string; detail?: string }>;
    };
    const version = payload.notices.find((item) => item.id.startsWith('platform-version:'));
    expect(version, 'version notice is always present').toBeTruthy();
    expect(version?.kind).toBe('info');
    expect(version?.title).toMatch(/^当前平台版本 /);
    // A writable fixture storage dir must not fabricate a degraded notice.
    expect(payload.notices.find((item) => item.id === 'platform-degraded')).toBeUndefined();
    expect(notices.headers['cache-control']).toContain('no-store');
  });

  it('serves the reviewed failure-case seed from the module-relative asset path', async () => {
    const router = await fixture();
    const response = await invoke(router, 'get', '/api/sim2real/task-packs/:taskId/failure-cases', {
      params: { taskId: 'goal-navigation-clear-arena' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
    expect((response.body as { cases?: unknown[] }).cases?.length).toBeGreaterThan(0);
  });

  it('resolves the package version from the release root in a compiled layout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-release-meta-'));
    roots.push(root);
    const moduleDirectory = path.join(root, 'dist-server', 'server', 'routes');
    await fs.mkdir(moduleDirectory, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
    expect(workspacePackageVersion(moduleDirectory)).toBe('9.9.9-test');
  });
});
