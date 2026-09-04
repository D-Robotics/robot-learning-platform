#!/usr/bin/env node

/**
 * Protocol-only local worker for CUDA-less MVP validation.
 *
 * This worker deliberately never executes a training command. It validates the
 * MicroDuck or RDK Duck manifest-defined contract, persists a small job receipt, and returns a clearly
 * labelled mock checkpoint reference so the Studio flow can be exercised
 * without pretending that RL completed or that a deployable model exists.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONTRACT_ID = 'microduck-policy-v1';
const MICRODUCK_CONTRACT = Object.freeze({
  robotId: 'microduck',
  contractId: DEFAULT_CONTRACT_ID,
  jointCount: 14,
  observationSize: 61,
  actionSize: 14,
  controlHz: 50,
});
const RDK_DUCK_CONTRACT_PREFIX = 'rdk-duck-policy-';
// Keep this protocol-only worker aligned with the shared manifest validator.
// It runs as a plain Node process, so it cannot import the TypeScript module
// directly; changing these values requires updating shared/sim2real.ts too.
const CONTRACT_LIMITS = Object.freeze({
  maxJointCount: 256,
  maxObservationSize: 4096,
  maxActionSize: 4096,
  maxControlHz: 1000,
});
const SAFE_ARTIFACT_REF =
  /^artifact:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}){0,8}$/;
const DATA_DIR = String(
  process.env.RDK_SIM2REAL_MOCK_DATA_DIR || path.join(process.cwd(), '.data', 'mock-worker'),
).trim();
const HOST = String(process.env.RDK_SIM2REAL_MOCK_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1';
const PORT_VALUE = Number(process.env.RDK_SIM2REAL_MOCK_PORT || 19090);
const PORT =
  Number.isInteger(PORT_VALUE) && PORT_VALUE >= 1024 && PORT_VALUE <= 65535 ? PORT_VALUE : 19090;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const QUEUE_DELAY_MS = boundedDelay(process.env.RDK_SIM2REAL_MOCK_QUEUE_DELAY_MS, 250, 0, 60_000);
const RUN_DURATION_MS = boundedDelay(
  process.env.RDK_SIM2REAL_MOCK_RUN_DURATION_MS,
  1_200,
  100,
  300_000,
);
const PROFILE_LIMITS = Object.freeze({
  smoke: { numEnvs: 16384, maxIterations: 2000000 },
  'low-vram': { numEnvs: 16384, maxIterations: 2000000 },
  standard: { numEnvs: 16384, maxIterations: 2000000 },
  'high-vram': { numEnvs: 16384, maxIterations: 2000000 },
});
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
const IDEMPOTENCY_INDEX_FILE = 'idempotency-index.json';
let mutationChain = Promise.resolve();

function boundedDelay(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.round(parsed) : fallback;
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function text(value, max = 240) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function idempotencyError(message, statusCode = 400) {
  const error = validationError(message);
  error.statusCode = statusCode;
  error.errorCode = statusCode === 409 ? 'idempotency_conflict' : 'invalid_idempotency_key';
  return error;
}

function requestIdempotencyKey(request, body) {
  const rawHeader = request.headers['idempotency-key'];
  const header = Array.isArray(rawHeader) ? rawHeader.join(',') : String(rawHeader || '').trim();
  const bodyKey = body?.idempotencyKey == null ? '' : String(body.idempotencyKey).trim();
  if (header && !SAFE_IDEMPOTENCY_KEY.test(header)) throw idempotencyError('Idempotency-Key is invalid');
  if (bodyKey && !SAFE_IDEMPOTENCY_KEY.test(bodyKey)) throw idempotencyError('idempotencyKey is invalid');
  if (header && bodyKey && header !== bodyKey)
    throw idempotencyError('Idempotency-Key header and body value differ');
  return header || bodyKey || '';
}

function idempotencyHash(key) {
  return createHash('sha256').update(key).digest('hex');
}

function safeAccountId(value) {
  const accountId = String(value ?? '').trim();
  if (!accountId || accountId.length > 160 || /[\u0000-\u001f\u007f/]/.test(accountId)) {
    throw validationError('accountId is invalid');
  }
  return accountId;
}

function requestAccountId(request, body) {
  const rawHeader = request.headers['x-sim2real-account'];
  const header = Array.isArray(rawHeader) ? rawHeader.join(',') : String(rawHeader || '').trim();
  const bodyValue = body?.accountId == null ? '' : String(body.accountId).trim();
  if (header && bodyValue && header !== bodyValue)
    throw validationError('X-Sim2Real-Account and accountId differ');
  return safeAccountId(header || bodyValue);
}

function publicJob(job) {
  if (!job || typeof job !== 'object') return job;
  const { accountId: _accountId, ...visible } = job;
  return visible;
}

async function readIdempotencyIndex() {
  try {
    const parsed = JSON.parse(await readFile(path.join(DATA_DIR, IDEMPOTENCY_INDEX_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {};
  }
}

async function writeIdempotencyIndex(index) {
  await writeFile(path.join(DATA_DIR, IDEMPOTENCY_INDEX_FILE), JSON.stringify(index, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function serialized(task) {
  const next = mutationChain.then(task, task);
  mutationChain = next.then(() => undefined, () => undefined);
  return next;
}

function validateRequest(body) {
  const source = record(body);
  if (source.schemaVersion !== 1) throw validationError('schemaVersion must be 1');
  const contractId = text(source.contractId, 120);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(contractId))
    throw validationError('contractId is invalid');
  const model = record(source.model);
  if (!text(model.modelId, 64) || !text(model.version, 64)) {
    throw validationError('model.modelId and model.version are required');
  }
  const contract = record(source.contract);
  const robotId = text(contract.robotId, 120);
  const jointCount = Number(contract.jointCount);
  const observationSize = Number(contract.observationSize);
  const actionSize = Number(contract.actionSize);
  const controlHz = Number(contract.controlHz);
  const layout = Array.isArray(contract.observationLayout) ? contract.observationLayout : [];
  const layoutTotal = layout.reduce((sum, item) => {
    const part = record(item);
    const size = Number(part.size);
    return sum + (Number.isSafeInteger(size) && size > 0 ? size : 0);
  }, 0);
  if (
    contract.id !== contractId ||
    !['microduck', 'rdk-duck'].includes(robotId) ||
    !Number.isSafeInteger(jointCount) ||
    jointCount < 1 ||
    jointCount > CONTRACT_LIMITS.maxJointCount ||
    !Number.isSafeInteger(observationSize) ||
    observationSize < 1 ||
    observationSize > CONTRACT_LIMITS.maxObservationSize ||
    !Number.isSafeInteger(actionSize) ||
    actionSize < 1 ||
    actionSize > CONTRACT_LIMITS.maxActionSize ||
    !Number.isSafeInteger(controlHz) ||
    controlHz < 1 ||
    controlHz > CONTRACT_LIMITS.maxControlHz ||
    !layout.length ||
    layoutTotal !== observationSize
  ) {
    throw validationError('policy contract dimensions or controlHz are invalid');
  }
  if (robotId === 'microduck') {
    if (
      contractId !== MICRODUCK_CONTRACT.contractId ||
      jointCount !== MICRODUCK_CONTRACT.jointCount ||
      observationSize !== MICRODUCK_CONTRACT.observationSize ||
      actionSize !== MICRODUCK_CONTRACT.actionSize ||
      controlHz !== MICRODUCK_CONTRACT.controlHz
    ) {
      throw validationError('microduck contract dimensions do not match microduck-policy-v1');
    }
  } else if (!contractId.startsWith(RDK_DUCK_CONTRACT_PREFIX)) {
    throw validationError('rdk-duck contract.id must start with rdk-duck-policy-');
  }
  const accountId = safeAccountId(source.accountId);
  const training = record(source.training);
  const profile = text(training.profile, 24);
  const limits = PROFILE_LIMITS[profile];
  if (!limits) throw validationError('training.profile is not allowed');
  const numEnvs = Number(training.numEnvs);
  const maxIterations = Number(training.maxIterations);
  if (!Number.isSafeInteger(numEnvs) || numEnvs < 1 || numEnvs > limits.numEnvs) {
    throw validationError('training.numEnvs is out of bounds');
  }
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > limits.maxIterations
  ) {
    throw validationError('training.maxIterations is out of bounds');
  }
  if (typeof training.video !== 'boolean') throw validationError('training.video must be boolean');
  const resumeFrom = source.resumeFrom == null ? undefined : record(source.resumeFrom);
  if (resumeFrom) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(text(resumeFrom.checkpointId, 80))) {
      throw validationError('resumeFrom.checkpointId is invalid');
    }
    const artifactRef = text(resumeFrom.artifactRef, 260);
    if (!SAFE_ARTIFACT_REF.test(artifactRef)) {
      throw validationError('resumeFrom.artifactRef is invalid');
    }
  }
  const taskId = text(source.taskId, 32).toLowerCase();
  if (taskId && !/^[a-z][a-z0-9_-]{0,31}$/.test(taskId)) {
    throw validationError('taskId is invalid');
  }
  return {
    contractId,
    accountId,
    robotId,
    observationSize,
    actionSize,
    controlHz,
    modelId: text(model.modelId, 64),
    version: text(model.version, 64),
    ...(taskId ? { taskId } : {}),
    training: { profile, numEnvs, maxIterations, video: training.video },
    resumeFrom,
    idempotencyKey: requestIdempotencyKey({ headers: {} }, source),
  };
}

function checkpointFor(job) {
  const checkpointId = `${job.runId}-checkpoint-${job.training.maxIterations}`;
  return {
    checkpointId,
    artifactRef: `artifact://mock/${job.robotId}/${job.runId}/checkpoint-${job.training.maxIterations}`,
    iteration: job.training.maxIterations,
  };
}

function completedMetadata(job) {
  const checkpoint = checkpointFor(job);
  const artifactId = `${job.runId}-policy`;
  const artifactRef = `artifact://mock/${job.robotId}/${job.runId}/policy.onnx`;
  const digest = createHash('sha256')
    .update(JSON.stringify({ artifactId, artifactRef, checkpoint, contractId: job.contractId }))
    .digest('hex');
  return {
    checkpoint,
    artifact: {
      artifactId,
      artifactRef,
      kind: 'source',
      format: 'onnx',
      runtime: 'cpu-onnx',
      workload: 'locomotion',
      threads: 1,
      sha256: digest,
      sizeBytes: 0,
      deployable: false,
    },
    metrics: {
      contractValid: true,
      observationSize: job.observationSize,
      actionSize: job.actionSize,
      reward: 0.72,
      successRate: 0.72,
      fallRate: 0.18,
      episodeLength: 320,
      controlLatencyMs: 1.6,
      iterations: job.training.maxIterations,
    },
  };
}

function materializeJob(job) {
  const createdMs = Date.parse(job.createdAt);
  const elapsed = Number.isFinite(createdMs) ? Math.max(0, Date.now() - createdMs) : 0;
  if (elapsed < QUEUE_DELAY_MS) return job.status === 'queued' ? job : { ...job, status: 'queued' };
  const startedAt = job.startedAt || new Date(createdMs + QUEUE_DELAY_MS).toISOString();
  if (elapsed < QUEUE_DELAY_MS + RUN_DURATION_MS) {
    return { ...job, status: 'running', startedAt };
  }
  if (job.status === 'completed' && job.finishedAt && job.artifact && job.metrics) return job;
  return {
    ...job,
    status: 'completed',
    startedAt,
    finishedAt: new Date(createdMs + QUEUE_DELAY_MS + RUN_DURATION_MS).toISOString(),
    ...completedMetadata(job),
    message: 'Mock 训练流程已完成：仅验证契约与台账，未执行真实 RL，也没有生成可部署模型。',
  };
}

async function readJob(runId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(runId)) return null;
  try {
    const parsed = JSON.parse(await readFile(path.join(DATA_DIR, `${runId}.json`), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw validationError('request body is too large');
    chunks.push(chunk);
  }
  if (!size) throw validationError('request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw validationError('request body must be valid JSON');
  }
}

async function handleTrain(request, response) {
  const body = await readBody(request);
  const parsed = validateRequest(body);
  // Keep the key in the request-derived object, but never persist the raw key.
  const requestKey = requestIdempotencyKey(request, body);
  const accountId = requestAccountId(request, body);
  if (accountId !== parsed.accountId) throw validationError('accountId is invalid');
  await serialized(async () => {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const index = await readIdempotencyIndex();
    const fingerprint = JSON.stringify({
      accountId: parsed.accountId,
      contractId: parsed.contractId,
      robotId: parsed.robotId,
      observationSize: parsed.observationSize,
      actionSize: parsed.actionSize,
      controlHz: parsed.controlHz,
      modelId: parsed.modelId,
      version: parsed.version,
      taskId: parsed.taskId || null,
      training: parsed.training,
      resumeFrom: parsed.resumeFrom || null,
    });
    if (requestKey) {
      const hash = idempotencyHash(`${accountId}\u0000${requestKey}`);
      const previous = index[hash];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw idempotencyError('Idempotency-Key was reused for a different request', 409);
        const existing = await readJob(previous.runId);
        if (existing) {
          const current = materializeJob(existing);
          if (JSON.stringify(current) !== JSON.stringify(existing)) {
            await writeFile(
              path.join(DATA_DIR, `${previous.runId}.json`),
              JSON.stringify(current, null, 2),
              { encoding: 'utf8', mode: 0o600 },
            );
          }
          json(response, 200, { ...publicJob(current), idempotentReplay: true });
          return;
        }
        delete index[hash];
      }
    }
    const robotSlug = text(parsed.robotId, 48).toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'robot';
    const runId = `mock-${robotSlug}-${randomUUID()}`;
    const job = {
      runId,
      status: 'queued',
      mock: true,
      cuda: false,
      deployable: false,
      accountId,
      contractId: parsed.contractId,
      robotId: parsed.robotId,
      observationSize: parsed.observationSize,
      actionSize: parsed.actionSize,
      controlHz: parsed.controlHz,
      modelId: parsed.modelId,
      version: parsed.version,
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      training: parsed.training,
      ...(parsed.resumeFrom ? { resumeFrom: parsed.resumeFrom } : {}),
      createdAt: new Date().toISOString(),
    };
    await writeFile(path.join(DATA_DIR, `${runId}.json`), JSON.stringify(job, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (requestKey) {
      const hash = idempotencyHash(`${accountId}\u0000${requestKey}`);
      index[hash] = { runId, fingerprint, createdAt: job.createdAt };
      const keys = Object.keys(index);
      for (const old of keys.slice(0, Math.max(0, keys.length - 10_000))) delete index[old];
      await writeIdempotencyIndex(index);
    }
    json(response, 202, {
      ...publicJob(job),
      message: `Mock 任务已排队，将在约 ${Math.ceil(QUEUE_DELAY_MS / 100) / 10}s 后进入运行状态。`,
    });
  });
}

async function handleStatus(request, response, runId) {
  const job = await readJob(runId);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  try {
    const accountId = requestAccountId(request, {});
    if (accountId !== job.accountId) {
      json(response, 404, { ok: false, error: 'run_not_found' });
      return;
    }
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  const next = materializeJob(job);
  if (JSON.stringify(next) !== JSON.stringify(job)) {
    await writeFile(path.join(DATA_DIR, `${runId}.json`), JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  json(response, 200, publicJob(next));
}

export function createMockLocalWorkerServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        json(response, 200, {
          ok: true,
          worker: 'sim2real-mock',
          mode: 'mock',
          cuda: false,
          contractId: DEFAULT_CONTRACT_ID,
          contracts: ['microduck-policy-v1', 'rdk-duck-policy-v1'],
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/train') {
        await handleTrain(request, response);
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/runs/')) {
        await handleStatus(
          request,
          response,
          decodeURIComponent(request.url.slice('/runs/'.length)),
        );
        return;
      }
      json(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      json(response, status, {
        ok: false,
        error:
          status === 400
            ? 'invalid_training_request'
            : status === 409 && error?.errorCode === 'idempotency_conflict'
              ? 'idempotency_conflict'
              : 'mock_worker_failed',
        ...(error?.errorCode ? { errorCode: error.errorCode } : {}),
        message: text(error?.message, 500),
      });
    }
  });
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isDirectEntry()) {
  const server = createMockLocalWorkerServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(PORT, HOST, () =>
    console.log(`[sim2real-mock] listening on http://${HOST}:${PORT} (cuda=false)`),
  );
  const close = () => server.close(() => process.exit(0));
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
