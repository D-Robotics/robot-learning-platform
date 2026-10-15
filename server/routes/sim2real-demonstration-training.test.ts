import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_MICRODUCK_MODEL,
  validateSim2RealManifest,
  type Sim2RealRunRecord,
  type Sim2RealTelemetryRecord,
} from '../../shared/sim2real.js';
import {
  appendSim2RealTelemetry,
  createSim2RealRun,
  createSim2RealModel,
  createSim2RealComputeResource,
  getSim2RealRun,
  listSim2RealRuns,
} from '../sim2real/sim2real-store.js';
import { createSim2RealRouter } from './sim2real-routes.js';

let root: string;
let router: ReturnType<typeof createSim2RealRouter>;
let workerCalls: Record<string, unknown>[];
const contract = BUILTIN_MICRODUCK_MODEL.manifest.contract;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-demonstration-training-'));
  vi.stubEnv('RDK_SIM2REAL_STORAGE_DIR', path.join(root, 'ledger'));
  vi.stubEnv('RDK_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('RDK_SIM2REAL_DEPLOYMENT', 'local');
  vi.stubEnv('RDK_SIM2REAL_LOCAL_RUNNER_URL', 'http://127.0.0.1:19091/train');
  vi.stubEnv('RDK_SIM2REAL_LOCAL_RUNNER_TOKEN', '');
  router = createSim2RealRouter({
    auth: {
      isMultiUserDeployment: () => true,
      resolvePrincipal: (request) => ({
        accountId: String(request.headers['x-test-account'] || 'alice'),
      }),
      resolveAccessToken: () => null,
    },
  });
  workerCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      workerCalls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: 'queued', runId: 'worker-real-bc-1' }), {
        status: 202,
      });
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function invoke(body: Record<string, unknown>, key = 'training-key', account = 'alice') {
  const handler = router.stack.find(
    (entry) => entry.route?.path === '/api/sim2real/runs' && entry.route.methods.post,
  )?.route?.stack[0]?.handle;
  return new Promise<{ status: number; body: { run?: Sim2RealRunRecord; code?: string } }>(
    (resolve, reject) => {
      let status = 200;
      const response = {
        locals: {},
        status(value: number) {
          status = value;
          return this;
        },
        setHeader() {
          return this;
        },
        json(value: { run?: Sim2RealRunRecord; code?: string }) {
          resolve({ status, body: value });
          return this;
        },
      } as unknown as Response;
      handler!(
        {
          body,
          headers: { 'idempotency-key': key, 'x-test-account': account },
          params: {},
          query: {},
        } as unknown as Request,
        response,
        ((error?: unknown) => {
          if (error) reject(error);
        }) as NextFunction,
      );
    },
  );
}
async function recording(
  options: {
    owner?: string;
    mock?: boolean;
    source?: Sim2RealTelemetryRecord['source'];
    width?: number;
    rows?: number;
    pairing?: boolean;
  } = {},
) {
  const owner = options.owner || 'alice';
  const run = await createSim2RealRun(
    {
      modelId: BUILTIN_MICRODUCK_MODEL.id,
      backend: 'browser',
      status: 'ready',
      summary: 'recording',
      ...(options.mock ? { mock: true } : {}),
    },
    owner,
  );
  await appendSim2RealTelemetry(
    {
      runId: run.id,
      modelId: run.modelId,
      source: options.source || 'browser',
      contractId: contract.id,
      samples: Array.from({ length: options.rows ?? 12 }, (_, i) => ({
        t: i / 50,
        ...(options.pairing === false ? {} : { pairing: 'policy-inference-v1' as const }),
        observation: Array(options.width ?? contract.observationSize).fill(i / 10),
        action: Array(contract.actionSize).fill(i / 20),
      })),
    },
    owner,
  );
  return run;
}
function request(sourceRunId: string) {
  return {
    modelId: BUILTIN_MICRODUCK_MODEL.id,
    backend: 'local',
    demonstrationRunId: sourceRunId,
    training: {
      profile: 'smoke',
      engine: 'offline-bc',
      maxIterations: 10,
      video: false,
    },
  };
}
describe('real demonstration training submission', () => {
  it('rejects legacy browser frames without launching a training worker', async () => {
    const source = await recording({ pairing: false });
    const result = await invoke(request(source.id));
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('SIM2REAL_DEMONSTRATION_PAIRING_UNVERIFIED');
    expect(workerCalls).toHaveLength(0);
  });
  it('refuses declared recurrent source or target contracts before flattening them to vector BC', async () => {
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'microduck-recurrent-recording';
    manifest.version = '1.0.0';
    manifest.contract.inputs = {
      observation: 'obs',
      stateInputs: ['h_in', 'c_in'],
      stateOutputs: ['h_out', 'c_out'],
    };
    manifest.contract.state = { kind: 'lstm', layers: 1, hiddenSize: 256, reset: 'on-activation' };
    expect(validateSim2RealManifest(manifest).errors).toEqual([]);
    const model = await createSim2RealModel(manifest, 'alice');
    const recurrent = await createSim2RealRun(
      { modelId: model.id, backend: 'browser', status: 'ready', summary: 'recurrent recording' },
      'alice',
    );
    const sourceRejected = await invoke(request(recurrent.id));
    expect(sourceRejected.status).toBe(422);
    expect(sourceRejected.body).toMatchObject({
      code: 'SIM2REAL_DEMONSTRATION_CONTRACT_UNSUPPORTED',
      message: expect.stringContaining('图像或循环策略'),
    });
    const vector = await recording();
    const targetRejected = await invoke({ ...request(vector.id), modelId: model.id });
    expect(targetRejected.status).toBe(422);
    expect(targetRejected.body.code).toBe('SIM2REAL_DEMONSTRATION_CONTRACT_UNSUPPORTED');
    expect(workerCalls).toHaveLength(0);
  });
  it('uses a 100-epoch BC budget when no iteration count was supplied', async () => {
    const source = await recording();
    const result = await invoke({
      ...request(source.id),
      training: { engine: 'offline-bc', profile: 'standard' },
    });
    expect(result.status).toBe(201);
    expect(result.body.run?.training).toMatchObject({ maxIterations: 100, numEnvs: 1 });
    expect(workerCalls[0].training).toMatchObject({ maxIterations: 100, numEnvs: 1 });
  });
  it('returns actionable errors for RL knobs and excessive BC epochs before worker launch', async () => {
    const source = await recording();
    for (const knob of [
      { numEnvs: 64 },
      { algorithm: 'ppo' },
      { algorithm: 'sac' },
      { maxIterations: 100_000 },
    ]) {
      const result = await invoke({
        ...request(source.id),
        training: { engine: 'offline-bc', ...knob },
      });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        code: 'SIM2REAL_INVALID_TRAINING',
        message: expect.stringContaining('offline-bc'),
      });
    }
    expect(workerCalls).toHaveLength(0);
  });
  it('submits owner-scoped real vectors and persists only the immutable training identity', async () => {
    const source = await recording();
    const result = await invoke(request(source.id));
    expect(result.status).toBe(201);
    expect(workerCalls).toHaveLength(1);
    const data = workerCalls[0].demonstrations as {
      sha256: string;
      jsonl: string;
      sourceRunId: string;
    };
    expect(data.sourceRunId).toBe(source.id);
    expect(data.jsonl.trimEnd().split('\n')).toHaveLength(12);
    expect(result.body.run?.trainingData).toMatchObject({
      sourceRunId: source.id,
      rows: 12,
      sha256: data.sha256,
      source: 'browser',
    });
    expect(result.body.run?.trainingData).not.toHaveProperty('jsonl');
    expect((await getSim2RealRun(result.body.run!.id, 'alice'))?.trainingData).toEqual(
      result.body.run?.trainingData,
    );
  });
  it('replays the original frozen training Run after source telemetry changes', async () => {
    const source = await recording();
    const first = await invoke(request(source.id));
    await appendSim2RealTelemetry(
      {
        runId: source.id,
        modelId: source.modelId,
        source: 'browser',
        contractId: contract.id,
        samples: [
          {
            t: 1,
            pairing: 'policy-inference-v1',
            observation: Array(contract.observationSize).fill(9),
            action: Array(contract.actionSize).fill(8),
          },
        ],
      },
      'alice',
    );
    const replay = await invoke(request(source.id));
    expect(replay.status).toBe(200);
    expect(replay.body.run).toEqual(first.body.run);
    expect(workerCalls).toHaveLength(1);
    const fresh = await invoke(request(source.id), 'new-training-key');
    expect(fresh.body.run?.trainingData?.rows).toBe(13);
    expect(fresh.body.run?.trainingData?.sha256).not.toBe(first.body.run?.trainingData?.sha256);
  });
  it('rejects same-key reuse for another demonstration Run', async () => {
    const first = await recording();
    const second = await recording();
    await invoke(request(first.id));
    expect((await invoke(request(second.id))).status).toBe(409);
    expect(workerCalls).toHaveLength(1);
  });
  it('launches only one worker when matching submissions arrive concurrently', async () => {
    const source = await recording();
    const [first, second] = await Promise.all([
      invoke(request(source.id)),
      invoke(request(source.id)),
    ]);
    expect(first.body.run?.id).toBe(second.body.run?.id);
    expect(first.body.run?.trainingData).toEqual(second.body.run?.trainingData);
    expect(workerCalls).toHaveLength(1);
  });
  it('hides missing or another account source Run and makes no worker call', async () => {
    const bob = await recording({ owner: 'bob' });
    for (const id of [bob.id, 'missing-source']) {
      const result = await invoke(request(id));
      expect(result.status).toBe(404);
      expect(result.body.code).toBe('SIM2REAL_DEMONSTRATION_NOT_FOUND');
    }
    expect(workerCalls).toHaveLength(0);
    expect(await listSim2RealRuns('alice')).toHaveLength(0);
  });
  it('refuses mock, demo-fixture, malformed and too-short recordings before Run reservation', async () => {
    for (const options of [
      { mock: true },
      { source: 'demo-fixture' as const },
      { width: 1 },
      { rows: 11 },
    ]) {
      const source = await recording(options);
      const result = await invoke(request(source.id), `reject-${source.id}`);
      expect(result.status).toBe(422);
    }
    expect(workerCalls).toHaveLength(0);
    expect((await listSim2RealRuns('alice')).filter((run) => run.backend === 'local')).toHaveLength(
      0,
    );
  });
  it('rejects unsupported engine/backend/resume combinations and invalid source identifiers', async () => {
    const source = await recording();
    for (const patch of [
      { backend: 'robogo' },
      { training: { profile: 'smoke', engine: 'act' } },
      { resumeFrom: { checkpointId: 'checkpoint-1', artifactRef: 'artifact://policy.onnx' } },
      { demonstrationRunId: '' },
      { demonstrationRunId: 123 },
    ]) {
      expect((await invoke({ ...request(source.id), ...patch })).status).toBe(400);
    }
    expect(workerCalls).toHaveLength(0);
  });
  it('rejects a recording from another model contract before contacting the worker', async () => {
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'another-recording-contract';
    manifest.version = '1.0.0';
    manifest.contract.id = 'other-policy-v1';
    const model = await createSim2RealModel(manifest, 'alice');
    const source = await createSim2RealRun(
      { modelId: model.id, backend: 'browser', status: 'ready', summary: 'other contract' },
      'alice',
    );
    const result = await invoke(request(source.id));
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('SIM2REAL_DEMONSTRATION_CONTRACT_MISMATCH');
    expect(workerCalls).toHaveLength(0);
  });
  it('rejects oversized accepted recordings instead of silently truncating the dataset', async () => {
    const source = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'browser',
        status: 'ready',
        summary: 'large recording',
      },
      'alice',
    );
    await appendSim2RealTelemetry(
      {
        runId: source.id,
        modelId: source.modelId,
        source: 'browser',
        contractId: contract.id,
        samples: Array.from({ length: 4000 }, (_, t) => ({
          t,
          pairing: 'policy-inference-v1',
          observation: Array(contract.observationSize).fill(0.1234567891234567),
          action: Array(contract.actionSize).fill(0.1234567891234567),
        })),
      },
      'alice',
    );
    const result = await invoke(request(source.id));
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('SIM2REAL_DEMONSTRATION_TOO_LARGE');
    expect(workerCalls).toHaveLength(0);
  });
  it('refuses browser-relayed resources until they support frozen demonstration transport', async () => {
    const source = await recording();
    const resource = await createSim2RealComputeResource(
      {
        name: 'browser local agent',
        kind: 'local-gpu',
        source: 'local-agent',
        runnerUrl: 'http://127.0.0.1:19092/train',
        status: 'online',
        lastCheckedAt: new Date().toISOString(),
      },
      'alice',
    );
    const result = await invoke({ ...request(source.id), computeResourceId: resource.id });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('SIM2REAL_DEMONSTRATION_RELAY_UNSUPPORTED');
    expect(workerCalls).toHaveLength(0);
    expect((await listSim2RealRuns('alice')).filter((run) => run.backend === 'local')).toHaveLength(
      0,
    );
  });
});
