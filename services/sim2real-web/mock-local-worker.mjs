#!/usr/bin/env node

/**
 * Protocol-only local worker for CUDA-less MVP validation.
 *
 * This worker deliberately never executes a training command. It validates the
 * MicroDuck contract, persists a small job receipt, and returns a clearly
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

const CONTRACT_ID = 'microduck-policy-v1';
const DATA_DIR = String(
  process.env.RDK_SIM2REAL_MOCK_DATA_DIR || '/opt/sim2real-web/mock-worker-data',
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

function validateRequest(body) {
  const source = record(body);
  if (source.schemaVersion !== 1) throw validationError('schemaVersion must be 1');
  if (source.contractId !== CONTRACT_ID)
    throw validationError('contractId must be microduck-policy-v1');
  const model = record(source.model);
  if (!text(model.modelId, 64) || !text(model.version, 64)) {
    throw validationError('model.modelId and model.version are required');
  }
  const contract = record(source.contract);
  if (
    contract.id !== CONTRACT_ID ||
    contract.observationSize !== 61 ||
    contract.actionSize !== 14 ||
    contract.controlHz !== 50
  ) {
    throw validationError('MicroDuck policy contract does not match 61D/14D/50Hz');
  }
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
    if (!/^artifact:\/\/[a-zA-Z0-9._/-]{1,240}$/.test(artifactRef) || artifactRef.includes('..')) {
      throw validationError('resumeFrom.artifactRef is invalid');
    }
  }
  const taskId = text(source.taskId, 32).toLowerCase();
  if (taskId && !/^[a-z][a-z0-9_-]{0,31}$/.test(taskId)) {
    throw validationError('taskId is invalid');
  }
  return {
    modelId: text(model.modelId, 64),
    version: text(model.version, 64),
    ...(taskId ? { taskId } : {}),
    training: { profile, numEnvs, maxIterations, video: training.video },
    resumeFrom,
  };
}

function checkpointFor(job) {
  const checkpointId = `${job.runId}-checkpoint-${job.training.maxIterations}`;
  return {
    checkpointId,
    artifactRef: `artifact://mock/microduck/${job.runId}/checkpoint-${job.training.maxIterations}`,
    iteration: job.training.maxIterations,
  };
}

function completedMetadata(job) {
  const checkpoint = checkpointFor(job);
  const artifactId = `${job.runId}-policy`;
  const artifactRef = `artifact://mock/microduck/${job.runId}/policy.onnx`;
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
      observationSize: 61,
      actionSize: 14,
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
  const parsed = validateRequest(await readBody(request));
  const runId = `mock-microduck-${randomUUID()}`;
  const job = {
    runId,
    status: 'queued',
    mock: true,
    cuda: false,
    deployable: false,
    contractId: CONTRACT_ID,
    modelId: parsed.modelId,
    version: parsed.version,
    ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
    training: parsed.training,
    ...(parsed.resumeFrom ? { resumeFrom: parsed.resumeFrom } : {}),
    createdAt: new Date().toISOString(),
  };
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeFile(path.join(DATA_DIR, `${runId}.json`), JSON.stringify(job, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  json(response, 202, {
    ...job,
    message: `Mock 任务已排队，将在约 ${Math.ceil(QUEUE_DELAY_MS / 100) / 10}s 后进入运行状态。`,
  });
}

async function handleStatus(request, response, runId) {
  const job = await readJob(runId);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  const next = materializeJob(job);
  if (JSON.stringify(next) !== JSON.stringify(job)) {
    await writeFile(path.join(DATA_DIR, `${runId}.json`), JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  json(response, 200, next);
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
          contractId: CONTRACT_ID,
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
        error: status === 400 ? 'invalid_training_request' : 'mock_worker_failed',
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
