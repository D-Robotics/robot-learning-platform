import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL, type Sim2RealModelManifest } from '../../shared/sim2real.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import { createSim2RealRouter } from './sim2real-routes.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousData = process.env.RDK_DATA_DIR;
const previousRunner = process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL;
const previousLocalRunner = process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL;

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

describe('Sim2Real HTTP routes', () => {
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
        JSON.stringify({ t: 0, observation: [0, 1], action: [0], reward: 1 }),
        JSON.stringify({ t: 0.02, observation: [1, 1], action: [1], reward: 2, done: true }),
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
          { t: 0, observation: [0, 0], action: [0] },
          { t: 0.02, observation: [0, 0], action: [0] },
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

  it('rejects an invalid deployment mode instead of silently downgrading it to preflight', async () => {
    const router = await fixture();
    const response = await invoke(router, 'post', '/api/sim2real/deployments', {
      body: { modelId: BUILTIN_MICRODUCK_MODEL.id, deviceId: 'device-1', mode: 'delete' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'SIM2REAL_INVALID_DEPLOYMENT' });
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
    process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = 'http://127.0.0.1:18199/train';
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
    process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL = 'http://127.0.0.1:18199/train';
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
        body: { modelId: registered.model.id, backend: 'local' },
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
});
