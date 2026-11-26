#!/usr/bin/env node

/**
 * Controlled local training worker.
 *
 * This is the bridge between the platform runner protocol and an existing
 * training engine (MicroDuck RL, Isaac Lab, or an organisation-owned script).
 * It never invokes a shell. The executable and argument template are supplied
 * by the deployment administrator, while request values are passed through
 * bounded JSON files and environment variables. The engine must write a
 * result.json containing a checkpoint/artifact reference before the run can be
 * marked completed. If no engine is configured this worker returns 503 instead
 * of pretending that RL ran.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  accessSync,
  constants,
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HOST =
  String(process.env.RDK_SIM2REAL_LOCAL_WORKER_HOST || '127.0.0.1').trim() || '127.0.0.1';
const portValue = Number(process.env.RDK_SIM2REAL_LOCAL_WORKER_PORT || 19091);
const PORT =
  Number.isInteger(portValue) && portValue >= 1024 && portValue <= 65535 ? portValue : 19091;
const DATA_DIR = path.resolve(
  String(
    process.env.RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR ||
      path.join(process.cwd(), '.data', 'local-worker'),
  ),
);
const MAX_BODY = 2 * 1024 * 1024;
const MAX_REFERENCE_BODY = 16 * 1024 * 1024;
const REFERENCE_ENGINE = 'originman-reference-ppo';
const REFERENCE_TASK = 'originman-reference-track';
const REFERENCE_SCREEN_TTL_MS = 5 * 60_000;
const MAX_REFERENCE_SCREEN_RECEIPTS = 128;
const MAX_REFERENCE_BASIS_ENTRIES = 12_000;
const MAX_RESULT = 1 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10_000_000_000;
const MAX_DANCE_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_LOG = 64 * 1024;
// Line-level engine log capture: the same stdout/stderr streams the tail
// buffers feed a bounded line ring, so /runs/:id/logs can serve incremental
// lines with a cursor while training runs (and the final log after it ends).
// The ring shares the tail's 64 KiB ceiling so a status payload or a restart
// recovery can never balloon because an engine got chatty.
const MAX_LOG_LINES = 600;
const MAX_LOG_LINE_CHARS = 2000;
const MAX_LOG_RING_BYTES = MAX_LOG;
// Live progress points are bounded so a status poll can never grow unbounded.
// Engines print one line every ~iterations/8, so 512 points covers even the
// 600-iteration high-vram profile with room to spare.
const MAX_PROGRESS_POINTS = 512;
// Both shipped engines emit the same line shape (starter-ppo runner.py and
// the mjx adapter), so one pattern keeps the worker engine-agnostic:
//   [starter-ppo] iter 12/400 meanReward=0.041 recentSuccess=0.38 goalRange=[0.80,1.20] elapsed=107.6s
const PROGRESS_LINE_RE =
  /iter (\d+)\/(\d+) meanReward=(-?\d+(?:\.\d+)?) recentSuccess=(\d+(?:\.\d+)?)(?: goalRange=\[([^\]]*)\])?(?: elapsed=(\d+(?:\.\d+)?)s)?(?: episodeSamples=(\d+))?/g;

function parseProgressLine(chunk, job) {
  for (const match of String(chunk).matchAll(PROGRESS_LINE_RE)) {
    const iteration = Number(match[1]);
    const total = Number(match[2]);
    const meanReward = Number(match[3]);
    const recentSuccess = Number(match[4]);
    if (
      !Number.isSafeInteger(iteration) ||
      iteration < 1 ||
      !Number.isSafeInteger(total) ||
      total < 1 ||
      !Number.isFinite(meanReward) ||
      !Number.isFinite(recentSuccess)
    ) {
      continue;
    }
    const elapsed = Number(match[6]);
    const samples = Number(match[7]);
    const point = {
      iteration,
      totalIterations: total,
      meanReward,
      recentSuccess,
      ...(Number.isSafeInteger(samples) && samples >= 0 && samples <= 50
        ? { episodeSamples: samples }
        : {}),
      ...(Number.isFinite(elapsed) ? { elapsedSeconds: elapsed } : {}),
      at: new Date().toISOString(),
    };
    // Engines may flush partial lines across chunk boundaries; the regex can
    // re-match an already-counted iteration from an overlapping buffer. Only
    // strictly advancing iterations become points.
    const previous = job.progress?.[job.progress.length - 1];
    if (previous && iteration <= previous.iteration) continue;
    (job.progress ??= []).push(point);
    if (job.progress.length > MAX_PROGRESS_POINTS) {
      job.progress.splice(0, job.progress.length - MAX_PROGRESS_POINTS);
    }
  }
}

function safeProgress(job) {
  if (!Array.isArray(job.progress)) return undefined;
  const points = [];
  let lastIteration = 0;
  for (const raw of job.progress) {
    if (!raw || typeof raw !== 'object') continue;
    const iteration = Number(raw.iteration);
    const total = Number(raw.totalIterations);
    const meanReward = Number(raw.meanReward);
    const recentSuccess = Number(raw.recentSuccess);
    if (
      !Number.isSafeInteger(iteration) ||
      iteration < lastIteration ||
      !Number.isSafeInteger(total) ||
      !Number.isFinite(meanReward) ||
      !Number.isFinite(recentSuccess)
    ) {
      continue;
    }
    lastIteration = iteration;
    const elapsed = Number(raw.elapsedSeconds);
    const samples = raw.episodeSamples;
    points.push({
      iteration,
      totalIterations: total,
      meanReward,
      recentSuccess,
      ...(Number.isSafeInteger(samples) && samples >= 0 && samples <= 50
        ? { episodeSamples: samples }
        : {}),
      ...(Number.isFinite(elapsed) ? { elapsedSeconds: elapsed } : {}),
      ...(typeof raw.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.at) ? { at: raw.at } : {}),
    });
  }
  return points.length ? points : undefined;
}
const MAX_OUTSTANDING_JOBS = 1000;
const MAX_CONCURRENT_JOBS_LIMIT = 32;
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const profiles = new Set(['smoke', 'low-vram', 'standard', 'high-vram']);
const jobs = new Map();
const archivedJobs = new Map();
const archivedJobKeys = new Map();
const pendingJobWrites = new WeakMap();
const queuedJobs = [];
const activeJobs = new Set();
let screening = false;
let referenceScreenRequests = 0;
const referenceScreenReceipts = new Map();
let workerShuttingDown = false;
const jobChildren = new Map();
const cancellationBarriers = new Map();
const activeChildren = new Set();
const finalizingJobs = new Set();
const finalizingJobViews = new WeakMap();
let jobsLoadPromise;
const terminalJobStatuses = new Set(['cancelled', 'completed', 'failed']);

function archivedJobKey(owner, key) {
  return JSON.stringify([owner, key]);
}

function archiveJob(job) {
  archivedJobs.set(job.runId, job.accountId);
  if (job.idempotencyKey) {
    archivedJobKeys.set(archivedJobKey(job.accountId, job.idempotencyKey), job.runId);
  }
  jobs.delete(job.runId);
}

async function readWorkerJob(runId, owner) {
  const current = jobs.get(runId);
  if (current) return current.accountId === owner ? current : null;
  if (archivedJobs.get(runId) !== owner) return null;
  const dir = path.join(DATA_DIR, runId);
  const job = JSON.parse(await readFile(path.join(dir, 'job.json'), 'utf8'));
  if (job.accountId !== owner || !terminalJobStatuses.has(job.status)) return null;
  return { ...job, dir, runId };
}

function loopbackHost(host) {
  const value = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

/**
 * The reference worker is intentionally convenient on loopback in local
 * development. Once it is exposed by a production/web-cloud process, an
 * empty token would turn the runner into an unauthenticated code-execution
 * boundary, so authorization becomes mandatory and readiness reports the
 * configuration error.
 */
const WEAK_RUNNER_TOKEN_RE =
  /^(?:replace(?:[-_ ]?with)?(?:[-_ ].*)?|change(?:[-_ ]?me)?(?:[-_ ].*)?|changeme(?:[-_ ]?.*)?|example(?:[-_ ].*)?|placeholder(?:[-_ ].*)?|default(?:[-_ ]?secret)?(?:[-_ ].*)?|dummy(?:[-_ ].*)?|password(?:[-_ ].*)?|your[-_ ]?(?:secret|key)(?:[-_ ].*)?|secret(?:[-_ ].*)?)$/i;
const REPEATED_RUNNER_TOKEN_RE = /^(.)\1{31,}$/s;

/**
 * A token is considered usable for an exposed worker only when it has the
 * same minimum entropy/placeholder protections as the production config gate.
 * Local loopback development may still use a short fixture token, but an
 * operator cannot accidentally expose that fixture token through a remote
 * bind or a production deployment.
 */
export function runnerTokenUsable(value) {
  const token = String(value ?? '').trim();
  return (
    Boolean(token) &&
    Buffer.byteLength(token, 'utf8') >= 32 &&
    Buffer.byteLength(token, 'utf8') <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(token) &&
    !WEAK_RUNNER_TOKEN_RE.test(token) &&
    !REPEATED_RUNNER_TOKEN_RE.test(token)
  );
}

export function runnerTokenRequired(host = HOST, environment = process.env) {
  return (
    !loopbackHost(host) ||
    String(environment.NODE_ENV || '')
      .trim()
      .toLowerCase() === 'production' ||
    String(environment.RDK_SIM2REAL_DEPLOYMENT || '').trim() === 'web-cloud'
  );
}

function text(value, max = 500) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';
}

function scrubLog(value, max = 2000) {
  return text(value, max)
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

/**
 * Append one engine log line to the job's bounded ring. Sequence numbers are
 * assigned in worker arrival order (stdout and stderr interleave at event
 * time, which is the only honest ordering available). Lines are scrubbed at
 * capture time, not at read time, so a secret printed mid-run is redacted
 * even if the process is killed before finish().
 */
function appendLogLine(job, stream, rawLine) {
  const lineText = scrubLog(String(rawLine), MAX_LOG_LINE_CHARS);
  if (!lineText.trim()) return;
  const ring = (job.logRing ??= []);
  const line = { n: (job.logSeq ?? 0) + 1, stream, text: lineText };
  job.logSeq = line.n;
  job.logBytes = (job.logBytes ?? 0) + Buffer.byteLength(lineText, 'utf8');
  ring.push(line);
  while (ring.length > MAX_LOG_LINES || (job.logBytes > MAX_LOG_RING_BYTES && ring.length > 1)) {
    const evicted = ring.shift();
    job.logBytes -= Buffer.byteLength(evicted.text, 'utf8');
  }
}

/**
 * Split a stream chunk into complete lines, keeping the trailing partial for
 * the next chunk. A stream that never emits a newline cannot grow the
 * partial unbounded: the front of an oversized unfinished line is dropped,
 * which keeps the ring a bounded representation of a pathological engine.
 */
function feedLogStream(job, stream, chunk) {
  const partials = (job.logPartials ??= {});
  let buffer = (partials[stream] || '') + String(chunk);
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    appendLogLine(job, stream, buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
  }
  partials[stream] = buffer.slice(-MAX_LOG_LINE_CHARS);
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function authorized(request) {
  const configured = String(process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN || '').trim();
  // In an exposed/production worker, a non-empty but weak token is just as
  // unsafe as no token. Keep the permissive empty-token behavior only for a
  // loopback development process.
  if (runnerTokenRequired() && !runnerTokenUsable(configured)) return false;
  return !configured || request.headers.authorization === `Bearer ${configured}`;
}

function fail(message, status = 400, code = 'invalid_training_request') {
  const error = new Error(message);
  error.statusCode = status;
  error.errorCode = code;
  return error;
}

async function bodyJson(request, maxBody = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBody) throw fail('training request is too large', 413, 'request_too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('object required');
    return parsed;
  } catch {
    throw fail('request body must be valid JSON');
  }
}

function requestKey(request, source) {
  const header = text(request.headers['idempotency-key'], 128);
  const value = text(source.idempotencyKey, 128);
  if (header && value && header !== value) throw fail('Idempotency-Key and idempotencyKey differ');
  const key = header || value;
  if (key && !/^[\x21-\x7e]{1,128}$/.test(key)) throw fail('idempotency key is invalid');
  return key;
}

function accountId(request, source) {
  const header = text(request.headers['x-sim2real-account'], 160);
  const body = text(source.accountId, 160);
  if (header && body && header !== body) throw fail('accountId header and body differ');
  const value = header || body;
  if (!value || /[\u0000-\u001f\u007f/]/.test(value)) throw fail('accountId is required');
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function requestFingerprint(source, owner) {
  const {
    idempotencyKey: _idempotencyKey,
    recoverableQueue: _recoverableQueue,
    launchAttemptedAt: _launchAttemptedAt,
    accountId: _accountId,
    ...requestWithoutIdentity
  } = source;
  return createHash('sha256')
    .update(canonicalJson({ accountId: owner, request: requestWithoutIdentity }))
    .digest('hex');
}

function validate(source) {
  if (source.schemaVersion !== 1) throw fail('schemaVersion must be 1');
  const contract = source.contract && typeof source.contract === 'object' ? source.contract : {};
  const model = source.model && typeof source.model === 'object' ? source.model : {};
  const contractId = text(source.contractId, 120);
  if (
    !contractId ||
    contract.id !== contractId ||
    !text(model.modelId, 64) ||
    !text(model.version, 64)
  ) {
    throw fail('contractId, contract.id, model.modelId and model.version are required');
  }
  if (
    !Number.isSafeInteger(Number(contract.observationSize)) ||
    !Number.isSafeInteger(Number(contract.actionSize))
  ) {
    throw fail('contract dimensions are invalid');
  }
  const training = source.training && typeof source.training === 'object' ? source.training : {};
  const profile = text(training.profile, 32) || 'standard';
  if (!profiles.has(profile)) throw fail('training.profile is not allowed');
  validateDemonstrationInput(source);
  return {
    contractId,
    modelId: text(model.modelId, 64),
    version: text(model.version, 64),
    profile,
  };
}

/** Fixed inline data contract; arbitrary client filesystem paths are never used. */
export function validateDemonstrationInput(source) {
  const training = source.training || {};
  const imitation = training.engine === 'act' || training.engine === 'diffusion-policy';
  const data = source.demonstrations;
  if (!imitation && !data) return;
  if (training.syntheticSmoke === true) {
    if (training.profile !== 'smoke' || data || training.demonstrationRunId)
      throw fail('syntheticSmoke requires smoke and cannot replace demonstrations');
    return;
  }
  if (source.contract?.observationLayout?.some((slot) => slot.modality === 'image'))
    throw fail(
      'recorded worker training currently supports vector observations; use the image CLI explicitly',
    );
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.sourceRunId !== 'string' ||
    !SAFE_RUN_ID.test(data.sourceRunId) ||
    data.sourceRunId !== training.demonstrationRunId ||
    typeof data.jsonl !== 'string' ||
    Buffer.byteLength(data.jsonl, 'utf8') > 512 * 1024 ||
    !/^[a-f0-9]{64}$/.test(data.sha256 || '') ||
    createHash('sha256').update(data.jsonl).digest('hex') !== data.sha256 ||
    (training.demonstrationSha256 && training.demonstrationSha256 !== data.sha256)
  )
    throw fail(
      'recorded demonstrations are required and must match their source and SHA-256',
      400,
      'demonstration_invalid',
    );
  let count = 0,
    episodes = 0,
    steps = 0;
  for (const line of data.jsonl.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw fail('demonstration JSONL is invalid');
    }
    if (
      row?.type !== 'step' ||
      typeof row.done !== 'boolean' ||
      !Array.isArray(row.observation) ||
      row.observation.length !== Number(source.contract?.observationSize) ||
      !Array.isArray(row.action) ||
      row.action.length !== Number(source.contract?.actionSize) ||
      [...row.observation, ...row.action].some(
        (value) => typeof value !== 'number' || !Number.isFinite(value),
      )
    )
      throw fail('demonstration rows must match the observation/action contract');
    count += 1;
    steps += 1;
    if (row.done) {
      if (steps < 4) throw fail('demonstration episodes need at least 4 steps');
      episodes += 1;
      steps = 0;
    }
  }
  if (
    count > 20_000 ||
    episodes < 8 ||
    steps ||
    count !== data.sampleCount ||
    episodes !== data.episodeCount
  )
    throw fail('demonstrations need at least 8 complete episodes and matching sample counts');
}

function executableConfig() {
  const executable = String(process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE || '').trim();
  if (!executable) return null;
  // An absolute path makes the deployment boundary explicit and avoids PATH
  // surprises when the service is started by systemd.
  if (!path.isAbsolute(executable) || executable.includes('\0'))
    throw fail(
      'RDK_SIM2REAL_TRAIN_EXECUTABLE must be an absolute path',
      500,
      'worker_configuration_invalid',
    );
  let args;
  const rawArgs = String(process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON || '[]').trim();
  try {
    args = JSON.parse(rawArgs);
  } catch {
    throw fail(
      'RDK_SIM2REAL_TRAIN_ARGS_JSON must be a JSON array',
      500,
      'worker_configuration_invalid',
    );
  }
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string' || item.length > 500)) {
    throw fail(
      'RDK_SIM2REAL_TRAIN_ARGS_JSON must contain strings',
      500,
      'worker_configuration_invalid',
    );
  }
  return { executable, args };
}

/**
 * Multi-engine routing table.
 *
 * The base RDK_SIM2REAL_TRAIN_EXECUTABLE keeps working unchanged: it is the
 * default engine and any request without training.engine goes there. A worker
 * that registered additional engines (e.g. the MJX contact-dynamics engine on
 * a GPU box) routes training.engine='mjx-ppo' to its own executable; unknown
 * engine ids fail closed with a clear 400 instead of silently training with
 * the wrong physics backend.
 */
function workerEngines() {
  const entries = new Map();
  const base = executableConfig();
  if (base) entries.set('default', { id: 'default', ...base });
  const raw = String(process.env.RDK_SIM2REAL_TRAIN_ENGINES_JSON || '').trim();
  if (!raw) return entries;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail(
      'RDK_SIM2REAL_TRAIN_ENGINES_JSON must be a JSON object',
      500,
      'worker_configuration_invalid',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail(
      'RDK_SIM2REAL_TRAIN_ENGINES_JSON must be a JSON object',
      500,
      'worker_configuration_invalid',
    );
  }
  for (const [id, value] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
      throw fail(
        'RDK_SIM2REAL_TRAIN_ENGINES_JSON keys must look like engine ids (lowercase, dashes)',
        500,
        'worker_configuration_invalid',
      );
    }
    if (!value || typeof value !== 'object') {
      throw fail(
        `RDK_SIM2REAL_TRAIN_ENGINES_JSON.${id} must be an object with executable and args`,
        500,
        'worker_configuration_invalid',
      );
    }
    const executable = String(value.executable || '').trim();
    if (!path.isAbsolute(executable) || executable.includes('\0')) {
      throw fail(
        `RDK_SIM2REAL_TRAIN_ENGINES_JSON.${id}.executable must be an absolute path`,
        500,
        'worker_configuration_invalid',
      );
    }
    const args = value.args;
    if (
      !Array.isArray(args) ||
      args.some((item) => typeof item !== 'string' || item.length > 500)
    ) {
      throw fail(
        `RDK_SIM2REAL_TRAIN_ENGINES_JSON.${id}.args must be an array of strings`,
        500,
        'worker_configuration_invalid',
      );
    }
    if (entries.has(id)) {
      throw fail(
        `RDK_SIM2REAL_TRAIN_ENGINES_JSON.${id} collides with a reserved engine id`,
        500,
        'worker_configuration_invalid',
      );
    }
    const preflightArgs = value.preflightArgs;
    if (
      preflightArgs !== undefined &&
      (!Array.isArray(preflightArgs) ||
        !preflightArgs.length ||
        preflightArgs.length > 128 ||
        preflightArgs.some(
          (arg) => typeof arg !== 'string' || arg.length > 500 || arg.includes('\0'),
        ))
    )
      throw fail(
        'engine preflightArgs must be a bounded array of strings',
        500,
        'worker_configuration_invalid',
      );
    entries.set(id, { id, executable, args, ...(preflightArgs ? { preflightArgs } : {}) });
  }
  return entries;
}

function engineExecutableReady(executable) {
  try {
    accessSync(executable, constants.X_OK);
    return statSync(executable).isFile();
  } catch {
    return false;
  }
}

const ENGINE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function engineFor(request) {
  const engines = workerEngines();
  const requested = String(request?.training?.engine || '').trim();
  if (!requested) {
    const fallback = engines.get('default');
    if (!fallback) return null;
    return { engineId: 'default', executable: fallback.executable, args: fallback.args };
  }
  if (!ENGINE_ID_RE.test(requested)) {
    throw fail('training.engine is not a valid engine id');
  }
  const selected = engines.get(requested);
  if (!selected) {
    const available = [...engines.keys()].sort().join(', ') || 'none';
    throw fail(
      `training engine "${requested}" is not registered on this worker (available: ${available})`,
      400,
      'engine_not_registered',
    );
  }
  return { engineId: selected.id, executable: selected.executable, args: selected.args };
}

function concurrencyLimit(name, fallback, upperBound) {
  const raw = String(process.env[name] ?? fallback).trim();
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > upperBound) {
    throw fail(
      `${name} must be an integer from 1 to ${upperBound}`,
      500,
      'worker_configuration_invalid',
    );
  }
  return value;
}

function concurrencyLimits() {
  const total = concurrencyLimit('RDK_SIM2REAL_MAX_CONCURRENT_JOBS', 1, MAX_CONCURRENT_JOBS_LIMIT);
  const perAccount = concurrencyLimit('RDK_SIM2REAL_MAX_CONCURRENT_JOBS_PER_ACCOUNT', total, total);
  return { total, perAccount };
}

function activeAccountJobs(owner) {
  let count = 0;
  for (const job of activeJobs) if (job.accountId === owner) count++;
  return count;
}

function publicJob(job) {
  const prior = finalizingJobViews.get(job);
  if (prior) return prior;
  const {
    accountId: _accountId,
    dir: _dir,
    request: _request,
    fingerprint: _fingerprint,
    idempotencyKey: _idempotencyKey,
    timeout: _timeout,
    pid: _pid,
    progress: _progress,
    logRing: _logRing,
    logSeq: _logSeq,
    logBytes: _logBytes,
    logPartials: _logPartials,
    ...visible
  } = job;
  const progress = safeProgress(job);
  if (progress) visible.progress = progress;
  // Log lines travel on their own cursor endpoint, not on every status poll:
  // the status payload stays lean and the logs route serves only the delta.
  visible.logLines = Array.isArray(job.logRing) ? job.logRing.length : 0;
  visible.logTotal = Number.isSafeInteger(job.logSeq) ? job.logSeq : 0;
  if (visible.status === 'queued') {
    const position = queuedJobs.indexOf(job);
    visible.queuePosition = position >= 0 ? position + 1 : null;
  }
  return visible;
}

function childEnvironment(job) {
  const environment = { ...process.env };
  // The worker is allowed to inherit operational settings (for example
  // CUDA_VISIBLE_DEVICES when a deployment explicitly grants one), but the
  // platform's own credentials must never be handed to an engine process or
  // accidentally exposed by its diagnostics. A runner that needs a separate
  // model-registry credential should inject it through its own wrapper.
  for (const key of Object.keys(environment)) {
    if (
      key === 'RDK_SIM2REAL_SHARED_GPU_POOL_JSON' ||
      /^(?:RDK_SIM2REAL|RDK_STUDIO|SSO)_.*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/i.test(key) ||
      /^(?:RDK_SIM2REAL|RDK_STUDIO)_.*(?:COOKIE|DATABASE_URL)$/i.test(key)
    ) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    RDK_SIM2REAL_JOB_ID: job.runId,
    RDK_SIM2REAL_JOB_DIR: job.dir,
    RDK_SIM2REAL_REQUEST_FILE: path.join(job.dir, 'request.json'),
    RDK_SIM2REAL_RESULT_FILE: path.join(job.dir, 'result.json'),
    RDK_SIM2REAL_CONTRACT_ID: job.contractId,
    RDK_SIM2REAL_TRAIN_PROFILE: job.profile,
  };
}

async function restorePersistedJobs() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  let entries;
  try {
    entries = await readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const recovered = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    const dir = path.join(DATA_DIR, entry.name);
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, 'job.json'), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const candidate = { ...parsed, runId: entry.name, dir };
      if (
        !SAFE_RUN_ID.test(candidate.runId) ||
        !text(candidate.accountId, 160) ||
        !['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed'].includes(
          candidate.status,
        ) ||
        typeof candidate.fingerprint !== 'string'
      )
        continue;
      candidate.accountId = text(candidate.accountId, 160);
      if (!candidate.accountId || /[\u0000-\u001f\u007f/]/.test(candidate.accountId)) continue;
      // Older snapshots could say queued even after spawning. Only recover jobs
      // written with the durable launch reservation protocol.
      if (
        candidate.status === 'queued' &&
        candidate.recoverableQueue === true &&
        typeof candidate.createdAt === 'string' &&
        !candidate.launchAttemptedAt &&
        !candidate.startedAt &&
        !candidate.cancelRequestedAt &&
        !candidate.finishedAt
      ) {
        validate(candidate.request);
        if (candidate.fingerprint !== requestFingerprint(candidate.request, candidate.accountId))
          continue;
        recovered.push(candidate);
      } else if (['queued', 'running', 'cancelling'].includes(candidate.status)) {
        candidate.status = 'failed';
        candidate.finishedAt = new Date().toISOString();
        candidate.errorCode = 'worker_restarted';
        candidate.message =
          'Worker 重启前任务已尝试启动，或启动状态未知。可以保留原配置并手动重试。';
      }
      delete candidate.pid;
      delete candidate.timeout;
      if (['queued', 'running', 'cancelling'].includes(parsed.status)) {
        jobs.set(candidate.runId, candidate);
        if (candidate.errorCode === 'worker_restarted')
          await persist(candidate).catch(() => undefined);
      } else {
        archiveJob(candidate);
      }
    } catch {
      // A partial/corrupt job must not make the worker unavailable. It is
      // intentionally left on disk for operator inspection.
    }
  }
  recovered.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId),
  );
  queuedJobs.push(...recovered);
}

function ensureJobsLoaded() {
  if (!jobsLoadPromise)
    jobsLoadPromise = restorePersistedJobs().then(() => {
      void pumpQueue();
    });
  return jobsLoadPromise;
}

async function readBoundedJson(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    // A trainer is trusted to produce the result, but a bounded read keeps a
    // broken plugin from making the worker allocate unbounded memory. The
    // artifact metadata is deliberately small; large model bytes belong in a
    // managed artifact store, never in result.json.
    if (!info.isFile() || info.size > MAX_RESULT) return null;
    // Read at most one byte beyond the limit as well. A result can grow after
    // the first stat call; never let that race turn into an unbounded read.
    const buffer = Buffer.allocUnsafe(MAX_RESULT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const afterRead = await handle.stat();
    if (afterRead.size > MAX_RESULT || bytesRead > MAX_RESULT) return null;
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readResult(job) {
  return readBoundedJson(path.join(job.dir, 'result.json'));
}

async function readTaskEvaluation(job, result) {
  const embedded = result?.taskEvaluation;
  const report =
    embedded && typeof embedded === 'object' && !Array.isArray(embedded)
      ? embedded
      : await readBoundedJson(path.join(job.dir, 'eval-report.json'));
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  // The digest is not a signature; it gives operators a stable correlation
  // key between the worker directory and the sanitized platform ledger row.
  const normalized = JSON.stringify(report);
  return {
    ...report,
    reportSha256: createHash('sha256').update(normalized).digest('hex'),
  };
}

async function attachLocalArtifactDigest(job, artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return artifact;
  if (text(artifact.format, 16).toLowerCase() !== 'onnx') return artifact;
  let handle;
  try {
    // Engines materialize the portable actor at this fixed job-local path;
    // never follow a runner-supplied filesystem path.
    handle = await open(path.join(job.dir, 'policy.onnx'), 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) return artifact;
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream()) {
      bytes += chunk.length;
      if (bytes > MAX_ARTIFACT_BYTES) return artifact;
      digest.update(chunk);
    }
    return { ...artifact, sizeBytes: bytes, sha256: digest.digest('hex') };
  } catch {
    return artifact;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Verifies the run's `SHA256SUMS` manifest against the files actually on disk.
 *
 * A job directory is the unit that travels: the policy, its telemetry and its
 * evaluation report were produced together, and the fact that `policy.onnx`
 * hashes to some value says nothing about whether the rest still do. The engine
 * writes this manifest, so a bundle that was partially copied, truncated or
 * edited afterwards is detected here — before the run is published as
 * completed and long before anything is staged to a board.
 *
 * Returns `{ ok, code?, detail, verified, entries }`; never throws, so a
 * malformed manifest becomes an explicit refusal rather than a crash.
 */
async function verifyJobManifest(job) {
  const directory = job.dir;
  const manifestPath = path.join(directory, 'SHA256SUMS');
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return {
      ok: false,
      code: 'artifact_manifest_missing',
      detail: '引擎未写出 SHA256SUMS，无法核验本次运行产物的完整性。',
      verified: 0,
      entries: [],
    };
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) {2}([^/\\]{1,120})$/.exec(line.trim());
    if (!match) {
      return {
        ok: false,
        code: 'artifact_manifest_malformed',
        detail: `SHA256SUMS 含无法解析的行：${line.trim().slice(0, 80)}`,
        verified: 0,
        entries: [],
      };
    }
    entries.push({ sha256: match[1], name: match[2] });
  }
  if (!entries.length) {
    return {
      ok: false,
      code: 'artifact_manifest_empty',
      detail: 'SHA256SUMS 没有记录任何产物。',
      verified: 0,
      entries: [],
    };
  }
  const verified = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    try {
      const info = await stat(target);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) {
        return {
          ok: false,
          code: 'artifact_manifest_file_invalid',
          detail: `清单中的 ${entry.name} 不是可校验的普通文件。`,
          verified: verified.length,
          entries: verified,
        };
      }
      const digest = createHash('sha256');
      const stream = createReadStream(target);
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > MAX_ARTIFACT_BYTES) break;
        digest.update(chunk);
      }
      if (digest.digest('hex') !== entry.sha256) {
        return {
          ok: false,
          code: 'artifact_manifest_mismatch',
          detail: `${entry.name} 的内容与 SHA256SUMS 记录不一致：产物在训练后被改动或未完整写入。`,
          verified: verified.length,
          entries: verified,
        };
      }
      verified.push({ name: entry.name, sha256: entry.sha256, bytes });
    } catch {
      return {
        ok: false,
        code: 'artifact_manifest_file_missing',
        detail: `清单中的 ${entry.name} 不在运行目录里。`,
        verified: verified.length,
        entries: verified,
      };
    }
  }
  return {
    ok: true,
    detail: `SHA256SUMS 全部核验通过（${verified.length} 个产物）。`,
    verified: verified.length,
    entries: verified,
  };
}

function resultArtifact(result) {
  const checkpoint =
    result.checkpoint && typeof result.checkpoint === 'object' ? result.checkpoint : null;
  const artifact = result.artifact && typeof result.artifact === 'object' ? result.artifact : null;
  const refs = [checkpoint?.artifactRef, artifact?.artifactRef, artifact?.ref];
  if (
    !refs.some(
      (ref) =>
        typeof ref === 'string' &&
        /^artifact:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}){0,8}$/.test(
          ref,
        ),
    )
  )
    return null;
  return {
    checkpoint,
    artifact,
    metrics: result.metrics && typeof result.metrics === 'object' ? result.metrics : undefined,
  };
}

async function launch(job, config) {
  validateDemonstrationInput(job.request);
  if (job.request.demonstrations) {
    await writeFile(path.join(job.dir, 'demonstrations.jsonl'), job.request.demonstrations.jsonl, {
      mode: 0o600,
    });
  }
  await writeFile(path.join(job.dir, 'request.json'), JSON.stringify(job.request, null, 2), {
    mode: 0o600,
  });
  if (job.status !== 'queued' || workerShuttingDown) return;
  job.launchAttemptedAt = new Date().toISOString();
  await persist(job);
  if (job.status !== 'queued' || workerShuttingDown) return;
  const child = spawn(config.executable, config.args, {
    cwd: job.dir,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment(job),
  });
  activeChildren.add(child);
  jobChildren.set(job, child);
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.pid = child.pid;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + String(chunk)).slice(-MAX_LOG);
    feedLogStream(job, 'stdout', chunk);
    // Live progress is parsed from the same stream the tail captures, so the
    // status route reflects training curve points while the engine runs.
    try {
      parseProgressLine(chunk, job);
    } catch {
      // A malformed line never breaks training; the tail still records it.
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-MAX_LOG);
    feedLogStream(job, 'stderr', chunk);
  });
  const requestedTimeout = Number(process.env.RDK_SIM2REAL_TRAIN_TIMEOUT_MS || 86_400_000);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(requestedTimeout, 1000), 7 * 86_400_000)
    : 86_400_000;
  job.timeout = setTimeout(() => {
    if (job.cancelRequestedAt || finalizingJobs.has(job)) return;
    job.timedOutAt = new Date().toISOString();
    job.message = '训练已超时，正在等待训练进程退出。';
    stopTrainingChild(job, child);
  }, timeoutMs);
  child.once('error', (error) => {
    feedLogStream(job, 'stderr', error.message + '\n');
    return finish(job, 1, stdout, `${stderr}\n${error.message}`);
  });
  child.once('exit', (code, signal) =>
    finish(job, code ?? 1, stdout, `${stderr}${signal ? `\nterminated:${signal}` : ''}`),
  );
}

async function finish(job, code, stdout, stderr) {
  if (job.finishedAt || finalizingJobs.has(job)) return;
  finalizingJobs.add(job);
  if (job.timeout) clearTimeout(job.timeout);
  const cancellation = cancellationBarriers.get(job);
  if (cancellation && !(await cancellation)) {
    finalizingJobs.delete(job);
    job.message = '尚未确认训练进程组已退出，请检查 Worker。训练资源仍保留。';
    await persist(job).catch(() => undefined);
    return;
  }
  const child = jobChildren.get(job);
  // Status polls must observe the previous phase until its terminal
  // snapshot is durable. A completion can otherwise race a slow rename.
  finalizingJobViews.set(job, publicJob(job));
  if (child) activeChildren.delete(child);
  jobChildren.delete(job);
  cancellationBarriers.delete(job);
  // The process is done, so no chunk can complete a partial line anymore:
  // flush what remains as the final line of each stream.
  for (const stream of Object.keys(job.logPartials || {})) {
    const partial = job.logPartials[stream];
    if (partial) appendLogLine(job, stream, partial);
  }
  job.logPartials = undefined;
  activeJobs.delete(job);
  job.timeout = undefined;
  job.finishedAt = new Date().toISOString();
  job.pid = undefined;
  try {
    if (job.cancelRequestedAt || job.timedOutAt) {
      job.status = job.timedOutAt ? 'failed' : 'cancelled';
      job.deployable = false;
      if (job.timedOutAt) job.errorCode = 'training_timeout';
      job.message = job.timedOutAt
        ? '训练超过时限，执行进程已停止。'
        : '训练已取消，执行进程已停止；未发布训练制品。';
      job.exitCode = code;
      if (stdout) job.stdoutTail = scrubLog(stdout);
      if (stderr) job.stderrTail = scrubLog(stderr);
      await persist(job);
      return;
    }
    const result = await readResult(job);
    const artifact = code === 0 && result ? resultArtifact(result) : null;
    if (artifact) {
      // Verify the produced bundle before publishing the run. An artifact whose
      // job directory does not match its own manifest is not a valid deliverable:
      // publishing it would hand the staging chain bytes of unknown provenance.
      const manifest = await verifyJobManifest(job);
      job.artifactVerification = {
        verified: manifest.ok,
        code: manifest.ok ? 'artifact_manifest_verified' : manifest.code,
        detail: manifest.detail,
        files: manifest.entries.map((entry) => entry.name),
      };
      // A missing manifest marks an engine that predates the bundle contract:
      // the run still completes (it is not corrupt, just not verifiable), and
      // `verified: false` travels with it so nothing downstream can read the
      // artifact as integrity-checked. A manifest that exists but disagrees with
      // the files on disk is corruption or tampering, and that fails closed.
      if (!manifest.ok && manifest.code !== 'artifact_manifest_missing') {
        job.status = 'failed';
        job.errorCode = manifest.code;
        job.message = `训练产物完整性核验失败：${manifest.detail}`;
        job.exitCode = code;
        if (stdout) job.stdoutTail = scrubLog(stdout);
        if (stderr) job.stderrTail = scrubLog(stderr);
        await persist(job).catch(() => undefined);
        return;
      }
      const taskEvaluation = await readTaskEvaluation(job, result);
      if (artifact.checkpoint) job.checkpoint = artifact.checkpoint;
      if (artifact.artifact) job.artifact = await attachLocalArtifactDigest(job, artifact.artifact);
      if (artifact.metrics) job.metrics = artifact.metrics;
      if (taskEvaluation) job.taskEvaluation = taskEvaluation;
      // Publish completion only after every derived field is attached. Flipping
      // status before the digest await let a status poll observe `completed`
      // with no artifact, which is exactly what the staging chain must never
      // see (the consumer reads sha256/sizeBytes off a completed run).
      job.status = 'completed';
      job.mock = false;
      job.cuda = Boolean(result.cuda);
      job.deployable = result.deployable === true;
      job.message = '本地训练引擎已完成并返回受控制品引用。';
    } else {
      job.status = 'failed';
      job.message =
        code === 0
          ? '训练进程完成，但未写入有效 artifact:// 结果；任务不会标记为成功。'
          : '本地训练进程失败。';
      job.errorCode = code === 0 ? 'training_result_missing' : 'training_process_failed';
    }
    job.exitCode = code;
    if (stdout) job.stdoutTail = scrubLog(stdout);
    if (stderr) job.stderrTail = scrubLog(stderr);
    try {
      await persist(job);
    } catch {
      // A result that cannot be durably recorded must not be reported as a
      // successful run after restart. Keep the in-memory record terminal and
      // let the next queued job proceed; operators can inspect disk health.
      job.status = 'failed';
      job.errorCode = 'worker_persist_failed';
      job.message = '本地 worker 无法保存任务结果，请检查数据目录。';
      await persist(job).catch(() => undefined);
    }
  } catch {
    job.status = 'failed';
    job.errorCode = 'worker_finalize_failed';
    job.message = '本地 worker 无法整理训练结果，请检查数据目录。';
    await persist(job).catch(() => undefined);
  } finally {
    finalizingJobViews.delete(job);
    finalizingJobs.delete(job);
    void pumpQueue();
  }
}

async function pumpQueue() {
  let limits;
  try {
    limits = concurrencyLimits();
  } catch {
    // /healthz reports invalid configuration. Keep queued work visible rather
    // than launching it with an implicit fallback or dropping it.
    return;
  }
  while (
    !workerShuttingDown &&
    activeJobs.size + Number(Boolean(preflightInFlight)) < limits.total &&
    queuedJobs.length
  ) {
    // A second job from a running account must not block the next eligible account.
    const index = queuedJobs.findIndex(
      (job) => job.status === 'queued' && activeAccountJobs(job.accountId) < limits.perAccount,
    );
    if (index < 0) return;
    const [job] = queuedJobs.splice(index, 1);
    let config;
    try {
      // Engine routing is resolved at launch time from the persisted request
      // (surviving worker restarts), not from the submit-time check alone.
      config = engineFor(job.request);
    } catch (error) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.errorCode = error?.errorCode || 'worker_configuration_invalid';
      job.message = text(error?.message) || 'worker configuration is invalid';
      await persist(job).catch(() => undefined);
      continue;
    }
    if (!config) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.errorCode = 'real_worker_not_configured';
      job.message = '未配置真实训练引擎；任务不会伪造 PPO 完成。';
      await persist(job).catch(() => undefined);
      continue;
    }
    activeJobs.add(job);
    void launch(job, config).catch(async (error) => {
      activeJobs.delete(job);
      if (!job.finishedAt) {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.message = text(error?.message) || 'worker launch failed';
        job.errorCode = 'worker_launch_failed';
        await persist(job).catch(() => undefined);
      }
      void pumpQueue();
    });
  }
}

async function persist(job) {
  const { timeout: _timeout, ...snapshot } = job;
  const data = JSON.stringify(snapshot, null, 2);
  const destination = path.join(job.dir, 'job.json');
  const temporary = path.join(job.dir, 'job.json.tmp');
  const pending = (pendingJobWrites.get(job) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      try {
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  pendingJobWrites.set(job, pending);
  try {
    await pending;
    if (terminalJobStatuses.has(snapshot.status) && jobs.get(job.runId) === job) {
      archiveJob(job);
    }
  } finally {
    if (pendingJobWrites.get(job) === pending) pendingJobWrites.delete(job);
  }
}

async function handleTrain(request, response) {
  await ensureJobsLoaded();
  const referenceUpload = request.headers['x-rdk-reference-trajectory'] === '1';
  const source = await bodyJson(request, referenceUpload ? MAX_REFERENCE_BODY : MAX_BODY);
  if (
    referenceUpload &&
    (source.taskId !== REFERENCE_TASK || source.training?.engine !== REFERENCE_ENGINE)
  ) {
    throw fail('the reference upload transport requires OriginMan reference tracking');
  }
  const engines = workerEngines();
  concurrencyLimits();
  if (!engines.size) {
    json(response, 503, {
      ok: false,
      error: 'real_worker_not_configured',
      message: '未配置真实训练引擎；当前 worker 不会伪造 PPO 完成。',
    });
    return;
  }
  const normalized = validate(source);
  // Fail an unregistered engine at submit time (400) so the caller can retry
  // with a valid one; the launch-time check stays as the durable backstop.
  const engine = engineFor(source);
  const owner = accountId(request, source);
  const key = requestKey(request, source);
  const fingerprint = requestFingerprint(source, owner);
  if (key) {
    const archivedId = archivedJobKeys.get(archivedJobKey(owner, key));
    const previous = archivedId
      ? await readWorkerJob(archivedId, owner)
      : [...jobs.values()].find((job) => job.accountId === owner && job.idempotencyKey === key);
    if (archivedId && !previous)
      throw fail('无法读取已归档的任务。', 503, 'worker_job_archive_unavailable');
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw fail(
          'Idempotency-Key was reused for a different request',
          409,
          'idempotency_conflict',
        );
      json(response, 200, { ...publicJob(previous), idempotentReplay: true });
      return;
    }
  }
  if (!engine || !engineExecutableReady(engine.executable))
    throw fail('所选训练引擎的解释器或可执行文件不可用。', 503, 'engine_executable_unavailable');
  if (jobs.size >= MAX_OUTSTANDING_JOBS)
    throw fail('worker queue limit reached', 429, 'worker_queue_full');
  const runId = `local-${normalized.modelId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48)}-${randomUUID()}`;
  const dir = path.join(DATA_DIR, runId);
  const job = {
    runId,
    status: 'queued',
    recoverableQueue: true,
    mock: false,
    cuda: null,
    deployable: false,
    accountId: owner,
    contractId: normalized.contractId,
    modelId: normalized.modelId,
    version: normalized.version,
    profile: normalized.profile,
    ...(String(source?.training?.engine || '').trim()
      ? { engine: String(source.training.engine).trim() }
      : {}),
    idempotencyKey: key,
    fingerprint,
    request: source,
    dir,
    createdAt: new Date().toISOString(),
  };
  // Reserve synchronously before the first await so two concurrent requests
  // carrying one idempotency key cannot both launch an engine process.
  jobs.set(runId, job);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await persist(job);
  } catch (error) {
    jobs.delete(runId);
    throw error;
  }
  if (job.status === 'queued') queuedJobs.push(job);
  void pumpQueue();
  json(response, 202, publicJob(job));
}

// Only the repository's file-based reference adapter has a known screening
// basis. Custom wrappers still get the original, live simulation check.
function referenceScreenBasis(engine) {
  if (
    process.platform === 'win32' ||
    ['PYTHONPATH', 'PYTHONHOME', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'MUJOCO_PLUGIN_PATH'].some(
      (key) => process.env[key],
    )
  )
    return null;
  const assignment = 'RDK_ORIGINMAN_DANCE_BUNDLE_DIR=';
  let bundle = process.env.RDK_ORIGINMAN_DANCE_BUNDLE_DIR;
  let python = engine.executable;
  let [adapter] = engine.args;
  if (engine.executable === '/usr/bin/env' && engine.args.length === 3) {
    if (!engine.args[0].startsWith(assignment)) return null;
    bundle = engine.args[0].slice(assignment.length);
    [, python, adapter] = engine.args;
  } else if (engine.args.length !== 1) return null;
  if (
    !bundle ||
    !adapter ||
    ![bundle, adapter, python].every((file) => path.isAbsolute(file)) ||
    !adapter.endsWith('/engines/originman-reference-ppo/adapter.py') ||
    !/\/bin\/python(?:3(?:\.\d+)?)?$/.test(python)
  )
    return null;

  try {
    const engineRoot = path.dirname(adapter);
    const root = path.resolve(engineRoot, '../..');
    const danceRoot = path.join(root, 'engines/originman-dance-ppo');
    const calibration = path.join(
      root,
      'plugins/rdk-robot-learning-platform/references/originman-reference-calibration.json',
    );
    const venv = path.resolve(path.dirname(python), '..');
    const pyvenv = path.join(venv, 'pyvenv.cfg');
    if (!/^include-system-site-packages\s*=\s*false\s*$/im.test(readFileSync(pyvenv, 'utf8')))
      return null;
    const lib = path.join(venv, 'lib');
    const versions = readdirSync(lib).filter((name) => /^python3\.\d+$/.test(name));
    if (versions.length !== 1) return null;
    const site = path.join(lib, versions[0], 'site-packages');
    const siteEntries = readdirSync(site);
    const profile = readFileSync(calibration);
    const maxTiltDeg = JSON.parse(profile.toString('utf8')).evaluation?.maxTiltDeg;
    if (!Number.isFinite(maxTiltDeg) || maxTiltDeg <= 0 || maxTiltDeg > 180) return null;

    const hash = createHash('sha256');
    let files = 0;
    function stamp(filename, walk = false, model = false) {
      if (++files > MAX_REFERENCE_BASIS_ENTRIES) throw Error('screen basis too large');
      const info = lstatSync(filename, { bigint: true });
      if (!info.isFile() && !info.isDirectory()) throw Error('unknown screen basis entry');
      hash.update(
        JSON.stringify([
          filename,
          String(info.dev),
          String(info.ino),
          String(info.mode),
          String(info.size),
          String(info.mtimeNs),
          String(info.ctimeNs),
        ]),
      );
      if (model && info.isFile() && filename.endsWith('.xml')) {
        const xml = readFileSync(filename, 'utf8');
        if (
          /<!DOCTYPE|<!ENTITY/i.test(xml) ||
          [...xml.matchAll(/\b(?:file|meshdir|texturedir|assetdir)\s*=\s*(["'])(.*?)\1/gi)].some(
            ([, , entry]) =>
              entry.startsWith('/') || /[:\\&]/.test(entry) || entry.split('/').includes('..'),
          )
        )
          throw Error('external screen asset');
      }
      if (!walk || !info.isDirectory()) return;
      for (const child of readdirSync(filename).sort()) {
        stamp(path.join(filename, child), true, model);
      }
    }
    hash.update(JSON.stringify([engine, python, bundle]));
    for (const file of [realpathSync(python), pyvenv, site, calibration]) stamp(file);
    if (engine.executable !== python) stamp(realpathSync(engine.executable));
    for (const folder of [engineRoot, danceRoot]) {
      stamp(folder);
      for (const name of readdirSync(folder)
        .filter((entry) => entry.endsWith('.py') || entry === '__pycache__')
        .sort())
        stamp(path.join(folder, name), name === '__pycache__');
    }
    // Wheels can keep native simulation or BLAS dependencies beside the Python folders.
    const dependencies = ['gymnasium', 'mujoco', 'numpy', 'scipy'];
    for (const folder of dependencies) stamp(path.join(site, folder), true);
    for (const name of siteEntries.sort()) {
      if (dependencies.some((dep) => name === dep + '.libs' || name.startsWith(dep + '-')))
        stamp(path.join(site, name), true);
      else if (/\.pth$|^(?:site|user)customize\.py$|^__pycache__$/.test(name))
        stamp(path.join(site, name), true);
    }
    const scene = path.join(bundle, 'model', 'scene.xml');
    stamp(bundle, true, true);
    return {
      key: hash.digest('hex'),
      maxTiltDeg,
      profile,
      sceneSha256: createHash('sha256').update(readFileSync(scene)).digest('hex'),
    };
  } catch {
    return null;
  }
}

function successfulReferenceScreen(report, trajectory, basis) {
  if (!basis || report.invalid !== undefined || report.stanceProfile !== trajectory.stanceProfile)
    return false;
  const gate = report.gate;
  const calibration = createHash('sha256').update(basis.profile);
  if (typeof report.stanceProfile === 'string') calibration.update('\0' + report.stanceProfile);
  return (
    report.sceneSha256 === basis.sceneSha256 &&
    report.calibrationSha256 === calibration.digest('hex') &&
    typeof report.trajectorySha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(report.trajectorySha256) &&
    gate?.completed === true &&
    gate.firstFailedFrame === null &&
    Number.isSafeInteger(gate.framesExpected) &&
    gate.framesExpected > 0 &&
    Array.isArray(trajectory.joint_pos) &&
    gate.framesExpected === trajectory.joint_pos.length &&
    gate.framesEvaluated === gate.framesExpected &&
    Number.isFinite(gate.maxTiltDeg) &&
    gate.maxTiltDeg >= 0 &&
    gate.maxTiltDeg < basis.maxTiltDeg
  );
}

async function handleReferenceScreen(request, response) {
  const owner = accountId(request, {});
  await ensureJobsLoaded();
  const engine = engineFor({ training: { engine: REFERENCE_ENGINE } });
  if (!engineExecutableReady(engine.executable)) {
    throw fail('reference engine executable is unavailable', 503, 'engine_executable_unavailable');
  }
  concurrencyLimits();
  // Reference screening uses a separate, single CPU process so a user can
  // validate a recipe and queue training even when all GPU slots are occupied.
  if (referenceScreenRequests >= 2) {
    throw fail('reference worker is busy', 409, 'reference_screen_busy');
  }
  referenceScreenRequests++;
  let live = false;
  try {
    const trajectory = await bodyJson(request, MAX_REFERENCE_BODY);
    const input = JSON.stringify(trajectory);
    const referenceSha256 = createHash('sha256').update(input).digest('hex');
    const resourceId = request.headers['x-sim2real-screen-resource'];
    const basis =
      typeof resourceId === 'string' && /^[A-Za-z0-9][\w.-]{0,127}$/.test(resourceId)
        ? referenceScreenBasis(engine)
        : null;
    // The input digest includes the stance. The Worker process itself and the
    // effective screening files are part of the identity, alongside the owner
    // and platform resource. A restart discards this memory-only cache.
    const cacheKey = basis ? JSON.stringify([owner, resourceId, referenceSha256]) : null;
    const previous = cacheKey && referenceScreenReceipts.get(cacheKey);
    if (
      previous &&
      previous.basis === basis.key &&
      Date.now() - previous.screenedAt >= 0 &&
      Date.now() - previous.screenedAt < REFERENCE_SCREEN_TTL_MS
    ) {
      json(response, 200, { ...previous.result, cached: true });
      return;
    }
    if (cacheKey) referenceScreenReceipts.delete(cacheKey);
    if (preflightInFlight || screening) {
      throw fail('reference worker is busy', 409, 'reference_screen_busy');
    }
    screening = live = true;
    const report = await new Promise((resolve, reject) => {
      const child = spawn(engine.executable, [...engine.args, '--screen-reference'], {
        detached: process.platform !== 'win32',
        cwd: DATA_DIR,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          ...childEnvironment({
            dir: DATA_DIR,
            runId: 'reference-screen',
            contractId: 'reference-screen',
            profile: 'smoke',
          }),
          CUDA_VISIBLE_DEVICES: '',
          ...(basis && { PYTHONDONTWRITEBYTECODE: '1' }),
        },
      });
      activeChildren.add(child);
      let stdout = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      child.stdout.on('data', (chunk) => {
        if (stdout.length + chunk.length > MAX_LOG) child.kill('SIGKILL');
        else stdout += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        activeChildren.delete(child);
        if (code !== 0) {
          reject(fail('reference screen did not finish', 503, 'reference_screen_failed'));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(fail('reference screen returned invalid results', 503, 'reference_screen_failed'));
        }
      });
    });
    const result = {
      ...report,
      ok: true,
      referenceSha256,
    };
    if (
      cacheKey &&
      successfulReferenceScreen(result, trajectory, basis) &&
      referenceScreenBasis(engine)?.key === basis.key
    ) {
      if (referenceScreenReceipts.size >= MAX_REFERENCE_SCREEN_RECEIPTS)
        referenceScreenReceipts.delete(referenceScreenReceipts.keys().next().value);
      referenceScreenReceipts.set(cacheKey, { basis: basis.key, screenedAt: Date.now(), result });
    }
    json(response, 200, result);
  } finally {
    referenceScreenRequests--;
    if (live) {
      screening = false;
      void pumpQueue();
    }
  }
}

async function handleStatus(request, response, runId) {
  await ensureJobsLoaded();
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  const job = await readWorkerJob(runId, owner);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  json(response, 200, publicJob(job));
}

const preflightCache = new Map();
const PREFLIGHT_REFRESH_MS = 15_000;
const SHARED_PREFLIGHT_MAX_AGE_MS = 60 * 60 * 1_000;

function preflightFileStamp(filename) {
  try {
    const info = statSync(filename);
    return [info.dev, info.ino, info.mtimeMs, info.size];
  } catch {
    return null;
  }
}

let preflightInFlight = null;
let originmanPreflightFlight = null;
async function handleEnginePreflight(request, response, engineId) {
  try {
    accountId(request, {});
  } catch {
    throw fail('account is required', 401, 'account_required');
  }
  if (!ENGINE_ID_RE.test(engineId)) throw fail('invalid engine id');
  const input = await bodyJson(request);
  const originman = ['originman-recovery', 'originman-recovery-reflect'].includes(engineId);
  if (
    originman &&
    (Object.keys(input).some((k) => k !== 'device') || !['cpu', 'cuda'].includes(input.device))
  )
    throw fail('invalid OriginMan preflight request', 400, 'invalid_preflight_request');
  const taskId = originman ? 'originman-recovery' : input.taskId || 'walk';
  if (typeof taskId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(taskId))
    throw fail('invalid task id');
  const config = workerEngines().get(engineId);
  if (!config) throw fail('engine is not registered', 404, 'engine_not_registered');
  if (!config.preflightArgs)
    throw fail(
      'Declare preflightArgs for this engine on the worker; no training command was executed.',
      409,
      'engine_preflight_not_configured',
    );
  await ensureJobsLoaded();
  const limits = concurrencyLimits();
  const sharedOriginman = originman && limits.total > 1;
  const hasWork = activeJobs.size > 0 || queuedJobs.length > 0 || Boolean(screening);
  const key = JSON.stringify([
    engineId,
    taskId,
    config,
    process.env.RDK_MICRODUCK_RL_DIR,
    process.env.RDK_MICRODUCK_RL_ROOT,
    ...(originman
      ? [
          input.device,
          process.env.CUDA_VISIBLE_DEVICES,
          process.env.ORIGINMAN_SCENE,
          [config.executable, process.env.ORIGINMAN_SCENE, ...config.args, ...config.preflightArgs]
            .filter((filename) => filename && path.isAbsolute(filename))
            .map(preflightFileStamp),
        ]
      : []),
  ]);
  const cached = preflightCache.get(key);
  if (
    cached &&
    Date.now() - cached.storedAt <
      (sharedOriginman && hasWork ? SHARED_PREFLIGHT_MAX_AGE_MS : PREFLIGHT_REFRESH_MS)
  ) {
    json(response, 200, { ok: true, report: cached.report, cached: true });
    return;
  }
  if (originmanPreflightFlight?.key === key && originmanPreflightFlight.waiters < 32) {
    const flight = originmanPreflightFlight;
    flight.waiters++;
    try {
      const report = await flight.promise;
      json(response, 200, { ok: true, report, cached: false, shared: true });
    } finally {
      flight.waiters--;
    }
    return;
  }
  // A live probe uses a slot while allocating CUDA; a cached report does not.
  const canProbe = sharedOriginman ? activeJobs.size < limits.total : !hasWork;
  if (preflightInFlight || screening || !canProbe)
    throw fail(
      'training or another environment check is using this worker',
      429,
      'engine_preflight_busy',
    );
  preflightInFlight = key;
  let flight;
  if (originman) {
    let resolveFlight, rejectFlight;
    const promise = new Promise((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    // A lone request has no waiter to consume a failed flight.
    promise.catch(() => {});
    flight = { key, promise, resolve: resolveFlight, reject: rejectFlight, waiters: 0 };
    originmanPreflightFlight = flight;
  }
  try {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    if (workerShuttingDown) throw fail('worker is stopping', 503, 'worker_stopping');
    const env = childEnvironment({ runId: '', dir: DATA_DIR, contractId: '', profile: '' });
    for (const name of [
      'RDK_SIM2REAL_JOB_ID',
      'RDK_SIM2REAL_JOB_DIR',
      'RDK_SIM2REAL_REQUEST_FILE',
      'RDK_SIM2REAL_RESULT_FILE',
      'RDK_SIM2REAL_CONTRACT_ID',
      'RDK_SIM2REAL_TRAIN_PROFILE',
    ])
      delete env[name];
    env.RDK_PREFLIGHT_TASK_ID = taskId;
    if (originman) {
      env.RDK_ORIGINMAN_PREFLIGHT_DEVICE = input.device;
      env.RDK_ORIGINMAN_PREFLIGHT_ENGINE = engineId;
    }
    env.PYTHONDONTWRITEBYTECODE = '1';
    const report = await new Promise((resolve, reject) => {
      const child = spawn(config.executable, config.preflightArgs, {
        cwd: DATA_DIR,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeChildren.add(child);
      child.once('close', () => activeChildren.delete(child));
      const output = [];
      let bytes = 0,
        failure;
      const stop = (code) => {
        failure ||= code;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      };
      const timer = setTimeout(() => stop('engine_preflight_timeout'), 45000);
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_LOG) stop('engine_preflight_output_limit');
        else output.push(chunk);
      });
      child.stderr.resume();
      child.once('error', () => {
        clearTimeout(timer);
        reject(fail('Environment probe could not start.', 503, 'engine_preflight_failed'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (failure || code !== 0) {
          reject(
            fail(
              'Environment probe did not finish; no training was started.',
              503,
              failure || 'engine_preflight_failed',
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (
            parsed.schemaVersion !== 1 ||
            parsed.engine !== engineId ||
            !Array.isArray(parsed.checks) ||
            !parsed.checks.length ||
            parsed.checks.length > 32 ||
            parsed.trainingPerformed !== false ||
            parsed.checks.some(
              (check) =>
                !check ||
                typeof check.id !== 'string' ||
                !['passed', 'blocked', 'unverified'].includes(check.status),
            )
          )
            throw new Error('invalid probe report');
          if (originman) {
            const expected = [
              'dependency-numpy',
              'dependency-mujoco',
              'dependency-torch',
              'dependency-stable_baselines3',
              'dependency-gymnasium',
              'training-entrypoint',
              'training-config',
              'scene-contract',
              'training-device',
            ];
            if (
              parsed.taskId !== taskId ||
              parsed.device !== input.device ||
              parsed.checks.length !== expected.length ||
              new Set(parsed.checks.map((check) => check.id)).size !== expected.length ||
              parsed.checks.some((check) => !expected.includes(check.id)) ||
              !Number.isFinite(Date.parse(parsed.checkedAt)) ||
              Math.abs(Date.now() - Date.parse(parsed.checkedAt)) > 120000
            )
              throw new Error('invalid OriginMan report');
            parsed.checks = parsed.checks.map((check) => ({ id: check.id, status: check.status }));
          }
          parsed.readyForSmokeTraining =
            parsed.checks.every((check) => check.status === 'passed') &&
            (originman || parsed.readyForSmokeTraining === true);
          resolve(parsed);
        } catch {
          reject(
            fail(
              'Environment probe returned an invalid report.',
              503,
              'engine_preflight_invalid_report',
            ),
          );
        }
      });
    });
    preflightCache.delete(key);
    if (!originman || (sharedOriginman && report.readyForSmokeTraining)) {
      if (preflightCache.size >= 8) preflightCache.delete(preflightCache.keys().next().value);
      preflightCache.set(key, { report, storedAt: Date.now() });
    }
    if (flight) flight.resolve(report);
    json(response, 200, { ok: true, report, cached: false });
  } catch (error) {
    if (flight) flight.reject(error);
    throw error;
  } finally {
    if (flight && originmanPreflightFlight === flight) originmanPreflightFlight = null;
    preflightInFlight = null;
    void pumpQueue();
  }
}

/** Cancel only a job owned by the authenticated account. */

/** kill(0) includes Linux zombies. They have exited and cannot execute work. */
async function hasLiveProcessGroup(
  group,
  {
    platform = process.platform,
    kill = process.kill.bind(process),
    list = () => readdir('/proc'),
    read = (pid) => readFile(`/proc/${pid}/stat`, 'utf8'),
  } = {},
) {
  try {
    kill(-group, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
  if (platform !== 'linux') return true;
  let seen = 0;
  try {
    for (const pid of await list()) {
      if (!/^\d+$/.test(pid)) continue;
      let stat;
      try {
        stat = await read(pid);
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
        throw error;
      }
      const boundary = stat.lastIndexOf(')');
      const fields = stat
        .slice(boundary + 2)
        .trim()
        .split(/\s+/);
      if (boundary < 0 || fields.length < 3 || !/^[0-9]+$/.test(fields[2])) return true;
      if (Number(fields[2]) !== group) continue;
      seen++;
      if (!['Z', 'X'].includes(fields[0])) return true;
    }
    // No visible members while kill(0) succeeds is ambiguous (namespaces,
    // permissions or a fork race). Only positive all-exited evidence passes.
    return seen === 0;
  } catch {
    return true;
  }
}
// Running jobs own a POSIX process group, including subprocesses launched
// by the training engine. Keep the slot until the group has shut down.
function stopTrainingChild(job, child) {
  const group = process.platform !== 'win32' && child.pid;
  const signal = (name) => {
    try {
      if (group) process.kill(-group, name);
      else child.kill(name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  cancellationBarriers.set(
    job,
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        signal('SIGKILL');
        for (let attempt = 0; attempt < 40; attempt++) {
          const running = group
            ? await hasLiveProcessGroup(group)
            : child.exitCode === null && child.signalCode === null;
          if (!running) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } catch {
        // An uncertain shutdown retains its reservation for operator review.
      }
      return false;
    })(),
  );
  try {
    signal('SIGTERM');
  } catch {
    // The bounded forced-stop path still attempts to reclaim the process.
  }
}

async function handleCancel(request, response, runId) {
  await ensureJobsLoaded();
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  const job = await readWorkerJob(runId, owner);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  if (['cancelled', 'completed', 'failed'].includes(job.status)) {
    json(response, 200, publicJob(job));
    return;
  }
  if (job.status === 'cancelling' || job.timedOutAt) {
    json(response, 202, publicJob(job));
    return;
  }
  if (finalizingJobs.has(job) || job.finishedAt) {
    json(response, 409, {
      ok: false,
      error: 'run_finalizing',
      message: '任务正在结束，请查询最终状态。',
    });
    return;
  }
  const child = jobChildren.get(job);
  if (child && process.platform === 'win32') {
    json(response, 501, {
      ok: false,
      error: 'process_tree_cancel_unsupported',
      message: '此 worker 尚不支持 Windows 训练进程树取消。',
    });
    return;
  }
  job.cancelRequestedAt = new Date().toISOString();
  if (!child) {
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    job.message = '排队训练已取消，未启动执行进程。';
    const position = queuedJobs.indexOf(job);
    if (position >= 0) queuedJobs.splice(position, 1);
    activeJobs.delete(job);
    await persist(job);
    void pumpQueue();
    json(response, 200, publicJob(job));
    return;
  }
  job.status = 'cancelling';
  job.message = '已请求取消，正在等待训练进程退出。';
  if (job.timeout) clearTimeout(job.timeout);
  stopTrainingChild(job, child);
  await persist(job);
  json(response, 202, publicJob(job));
}

/**
 * GET /runs/:id/artifact — the completed run's policy.onnx bytes.
 *
 * The engine writes the portable actor at the fixed job-local path; this
 * endpoint streams exactly those bytes so the platform can stage a
 * deployment without ever following a runner-supplied filesystem path.
 * Only completed non-mock jobs with an ONNX artifact serve bytes; anything
 * else is 404/409 with an honest reason. The bytes never leave loopback
 * and the bearer-token gate above already applied.
 */
async function handleArtifact(request, response) {
  await ensureJobsLoaded();
  const runId = decodeURIComponent((request.url || '').slice('/runs/'.length, -'/artifact'.length));
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  const job = await readWorkerJob(runId, owner);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  if (job.status !== 'completed') {
    json(response, 409, {
      ok: false,
      error: 'run_not_completed',
      message: '只有已完成的任务才能读取制品字节。',
    });
    return;
  }
  if (job.mock) {
    json(response, 409, {
      ok: false,
      error: 'mock_run_has_no_artifact',
      message: 'mock 任务不产生可部署制品。',
    });
    return;
  }
  if (job.artifact?.format?.toLowerCase() !== 'onnx') {
    json(response, 409, {
      ok: false,
      error: 'artifact_not_onnx',
      message: '该任务没有 ONNX 制品可下发。',
    });
    return;
  }
  const filePath = path.join(job.dir, 'policy.onnx');
  let info;
  try {
    info = await stat(filePath);
  } catch {
    json(response, 409, {
      ok: false,
      error: 'artifact_file_missing',
      message: '制品文件缺失（引擎导出失败或已被清理）。',
    });
    return;
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) {
    json(response, 409, { ok: false, error: 'artifact_file_invalid', message: '制品文件无效。' });
    return;
  }
  // Verify the bytes still hash to the digest recorded at completion: a
  // corrupted or swapped file must never be staged as the trained policy.
  if (job.artifact?.sha256) {
    const digest = createHash('sha256');
    let bytes = 0;
    let handle;
    try {
      handle = await open(filePath, 'r');
      for await (const chunk of handle.createReadStream()) {
        bytes += chunk.length;
        if (bytes > MAX_ARTIFACT_BYTES) break;
        digest.update(chunk);
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (digest.digest('hex') !== job.artifact.sha256 || bytes !== info.size) {
      json(response, 409, {
        ok: false,
        error: 'artifact_digest_mismatch',
        message: '制品字节与完成时记录的 SHA-256 不一致，拒绝下发。',
      });
      return;
    }
  }
  const stream = createReadStream(filePath);
  response.statusCode = 200;
  response.setHeader('content-type', 'application/octet-stream');
  response.setHeader('content-length', info.size);
  response.setHeader('x-artifact-sha256', String(job.artifact?.sha256 || ''));
  response.setHeader('x-artifact-bytes', String(info.size));
  response.setHeader('cache-control', 'no-store');
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

// A recovery renders the already recorded simulation, using the original engine environment.
const recoveredReplayDir = 'reference-replay-recovery';
let replayRecovery;
let replayRecoveryFailure;

async function handleReferenceReplay(request, response, runId) {
  await ensureJobsLoaded();
  const job = await readWorkerJob(runId, accountId(request, {}));
  const evidence = job?.metrics?.originmanReference;
  const validDigest = (value) => /^[a-f0-9]{64}$/.test(value ?? '');
  if (
    !job ||
    job.engine !== REFERENCE_ENGINE ||
    job.status !== 'completed' ||
    job.mock !== false ||
    !validDigest(job.artifact?.sha256) ||
    !validDigest(evidence?.replay?.sha256) ||
    !validDigest(evidence?.sceneSha256) ||
    evidence.video
  ) {
    json(response, 404, { ok: false, error: 'reference_replay_unavailable' });
    return;
  }
  const completedDir = path.join(job.dir, recoveredReplayDir);
  const video = await readBoundedJson(path.join(completedDir, 'video.json'));
  if (video) {
    json(response, 200, { ok: true, state: 'completed', video });
    return;
  }
  if (replayRecovery?.runId === runId) {
    json(response, 202, { ok: true, state: 'rendering' });
    return;
  }
  if (request.method === 'GET') {
    json(response, 200, { ok: true, state: replayRecoveryFailure === runId ? 'failed' : 'idle' });
    return;
  }
  if (replayRecovery) {
    json(response, 409, { ok: false, error: 'reference_replay_busy' });
    return;
  }
  const config = workerEngines().get(REFERENCE_ENGINE);
  const environment = childEnvironment(job);
  const assignment = 'RDK_ORIGINMAN_DANCE_BUNDLE_DIR=';
  const wrapped =
    config?.executable === '/usr/bin/env' &&
    config.args.length === 3 &&
    config.args[0].startsWith(assignment);
  const python = wrapped ? config.args[1] : config?.executable;
  const adapter = wrapped ? config.args[2] : config?.args[0];
  const bundle = wrapped
    ? config.args[0].slice(assignment.length)
    : environment.RDK_ORIGINMAN_DANCE_BUNDLE_DIR;
  if (
    !python ||
    !adapter?.endsWith('/engines/originman-reference-ppo/adapter.py') ||
    !bundle ||
    !path.isAbsolute(python) ||
    !path.isAbsolute(adapter) ||
    (!wrapped && config.args.length !== 1)
  ) {
    json(response, 409, { ok: false, error: 'reference_replay_renderer_unavailable' });
    return;
  }
  const source = path.join(job.dir, 'reference-replay.npz');
  const scene = path.resolve(bundle, 'model/scene.xml');
  const renderer = path.resolve(path.dirname(adapter), '../originman-dance-ppo/render_replay.py');
  replayRecovery = { runId };
  if (replayRecoveryFailure === runId) replayRecoveryFailure = undefined;
  json(response, 202, { ok: true, state: 'rendering' });
  void (async () => {
    let output;
    try {
      // Verify the retained inputs before allowing the renderer to consume them.
      const hashInput = async (file, maxBytes) => {
        const info = await stat(file);
        if (!info.isFile() || info.size < 1 || info.size > maxBytes)
          throw Error('invalid retained file');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        return hash.digest('hex');
      };
      const [sourceSha, sceneSha] = await Promise.all([
        hashInput(source, 32 * 1024 * 1024),
        hashInput(scene, 8 * 1024 * 1024),
      ]);
      if (sourceSha !== evidence.replay.sha256 || sceneSha !== evidence.sceneSha256)
        throw Error('stored replay or scene does not match this run');
      output = await mkdtemp(path.join(job.dir, '.replay-'));
      const filename = 'dance-replay.mp4';
      const target = path.join(output, filename);
      await new Promise((resolve, reject) => {
        const child = spawn(
          python,
          [renderer, '--scene', scene, '--replay', source, '--output', target],
          {
            env: environment,
            stdio: 'ignore',
            signal: AbortSignal.timeout(1_200_000),
          },
        );
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(Error('renderer exited without a video'));
        });
      });
      const receipt = await readBoundedJson(path.join(output, 'dance-replay.receipt.json'));
      const sha256 = await hashInput(target, MAX_DANCE_VIDEO_BYTES);
      const sizeBytes = (await stat(target)).size;
      if (
        receipt?.replaySha256 !== sourceSha ||
        receipt.sceneSha256 !== sceneSha ||
        receipt.videoSha256 !== sha256 ||
        receipt.fps !== 50 ||
        !Number.isFinite(receipt.durationSeconds) ||
        receipt.durationSeconds <= 0 ||
        receipt.durationSeconds > 241
      )
        throw Error('invalid recovered video receipt');
      await writeFile(
        path.join(output, 'video.json'),
        JSON.stringify({
          file: filename,
          sha256,
          sizeBytes,
          policySha256: job.artifact.sha256,
          sourceReplaySha256: sourceSha,
          fps: receipt.fps,
          durationSeconds: receipt.durationSeconds,
        }),
        { mode: 0o600 },
      );
      await rename(output, completedDir);
      output = undefined;
    } catch (error) {
      replayRecoveryFailure = runId;
      console.warn(
        '[sim2real-local] reference replay recovery failed:',
        error?.code ?? error?.message,
      );
    } finally {
      if (output) await rm(output, { recursive: true, force: true }).catch(() => {});
      replayRecovery = undefined;
    }
  })();
}

async function handleRunVideo(request, response, kind) {
  await ensureJobsLoaded();
  const runId = decodeURIComponent(request.url.slice('/runs/'.length, -(kind.length + 1)));
  const job = await readWorkerJob(runId, accountId(request, {}));
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  const taskId = job.request?.task?.id ?? job.request?.taskId;
  const errorPrefix = kind === 'workshop-video' ? 'workshop_video' : 'dance_video';
  const workshop = kind === 'workshop-video' && taskId === 'originman-recovery';
  const evidence = workshop
    ? job.metrics?.originmanWorkshop
    : kind !== 'dance-video'
      ? undefined
      : taskId === 'originman-reference-track'
        ? job.metrics?.originmanReference
        : taskId === 'originman-dance'
          ? job.metrics?.originmanDance
          : undefined;
  const recovered =
    !evidence?.video && taskId === REFERENCE_TASK && kind === 'dance-video'
      ? await readBoundedJson(path.join(job.dir, recoveredReplayDir, 'video.json'))
      : null;
  const video = evidence?.video ?? recovered;
  const size = workshop ? video?.bytes : video?.sizeBytes;
  const validSha = (value) => /^[a-f0-9]{64}$/.test(value ?? '');
  const authentic = workshop
    ? evidence?.phase === 'evaluate' &&
      validSha(evidence.policySha256) &&
      ['originman-recovery', 'originman-recovery-reflect'].includes(job.engine)
    : video?.file === 'dance-replay.mp4' &&
      validSha(video.policySha256) &&
      validSha(video.sourceReplaySha256) &&
      video.policySha256 === job.artifact?.sha256 &&
      video.sourceReplaySha256 === evidence.replay?.sha256;
  if (
    job.status !== 'completed' ||
    job.mock !== false ||
    !validSha(video?.sha256) ||
    !authentic ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_DANCE_VIDEO_BYTES
  ) {
    json(response, 409, { ok: false, error: errorPrefix + '_unavailable' });
    return;
  }
  const file = workshop ? 'comparison.mp4' : 'dance-replay.mp4';
  const directory = recovered ? path.join(job.dir, recoveredReplayDir) : job.dir;
  const handle = await open(path.join(directory, file), 'r').catch(() => null);
  if (!handle) {
    json(response, 404, { ok: false, error: errorPrefix + '_missing' });
    return;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== size) {
      json(response, 409, { ok: false, error: errorPrefix + '_size_mismatch' });
      return;
    }
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const body = bytes.subarray(0, bytesRead);
    if (
      bytesRead !== info.size ||
      createHash('sha256').update(body).digest('hex') !== video.sha256
    ) {
      json(response, 409, { ok: false, error: errorPrefix + '_digest_mismatch' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': body.length,
      'x-artifact-sha256': video.sha256,
      'cache-control': 'no-store',
    });
    response.end(body);
  } finally {
    await handle.close();
  }
}

/**
 * GET /runs/:id/telemetry — the completed run's evaluation telemetry.jsonl
 * bytes (hard-envelope policy rollouts the engine already produced).
 *
 * This lets the platform auto-attach the run's evaluation evidence to the
 * existing replay pipeline without the browser re-simulating anything. Same
 * ownership gate as handleArtifact; only completed non-mock jobs serve
 * bytes, and the payload stays under the same ceiling as artifacts.
 */
async function handleTelemetry(request, response) {
  await ensureJobsLoaded();
  const runId = decodeURIComponent(
    (request.url || '').slice('/runs/'.length, -'/telemetry'.length),
  );
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  const job = await readWorkerJob(runId, owner);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  if (job.status !== 'completed') {
    json(response, 409, {
      ok: false,
      error: 'run_not_completed',
      message: '只有已完成的任务才能读取评测遥测。',
    });
    return;
  }
  if (job.mock) {
    json(response, 409, {
      ok: false,
      error: 'mock_run_has_no_telemetry',
      message: 'mock 任务不产生评测遥测。',
    });
    return;
  }
  const filePath = path.join(job.dir, 'telemetry.jsonl');
  let info;
  try {
    info = await stat(filePath);
  } catch {
    json(response, 409, {
      ok: false,
      error: 'telemetry_file_missing',
      message: '评测遥测文件缺失（引擎未写出或已被清理）。',
    });
    return;
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) {
    json(response, 409, {
      ok: false,
      error: 'telemetry_file_invalid',
      message: '评测遥测文件无效。',
    });
    return;
  }
  const stream = createReadStream(filePath);
  response.statusCode = 200;
  response.setHeader('content-type', 'application/x-ndjson');
  response.setHeader('content-length', info.size);
  response.setHeader('x-telemetry-bytes', String(info.size));
  response.setHeader('cache-control', 'no-store');
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

/**
 * GET /runs/:id/logs?after=N — incremental engine stdout/stderr lines.
 *
 * Lines are numbered in worker arrival order; `after` is a cursor so the
 * platform can poll only the new tail instead of re-reading the whole log.
 * The ring is bounded (64 KiB / 600 lines), so a cursor from far in the past
 * is answered from the oldest retained line with `truncated: true` rather
 * than inventing the gap. Any job status may be queried: queued runs simply
 * have no lines yet, and terminal runs keep their final log — which is the
 * engine's own record of why it failed when it did.
 */
async function handleLogs(request, response) {
  await ensureJobsLoaded();
  let url;
  try {
    url = new URL(request.url || '/', 'http://localhost');
  } catch {
    json(response, 400, { ok: false, error: 'invalid_log_request' });
    return;
  }
  const runId = decodeURIComponent(url.pathname.slice('/runs/'.length, -'/logs'.length));
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  const job = await readWorkerJob(runId, owner);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  const afterRaw = Number(url.searchParams.get('after'));
  const after = Number.isSafeInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
  const ring = Array.isArray(job.logRing) ? job.logRing : [];
  const total = Number.isSafeInteger(job.logSeq) ? job.logSeq : 0;
  const retainedFrom = ring.length ? ring[0].n : 0;
  const lines = ring.filter((line) => line && line.n > after).slice(0, MAX_LOG_LINES);
  const truncated = after + 1 < retainedFrom;
  json(response, 200, {
    ok: true,
    runId,
    status: job.status,
    total,
    retainedFrom,
    ...(truncated
      ? { truncated: true, message: '请求的游标早于保留窗口，仅返回最近保留的日志行。' }
      : {}),
    lines: lines.map((line) => ({
      n: line.n,
      stream: line.stream === 'stderr' ? 'stderr' : 'stdout',
      text: line.text,
    })),
  });
}

export function createLocalTrainingWorkerServer() {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        let configured = false;
        let engineIds = [];
        let limits;
        try {
          const engines = workerEngines();
          configured = engines.size > 0;
          engineIds = [...engines.values()]
            .filter((engine) => engineExecutableReady(engine.executable))
            .map((engine) => engine.id)
            .sort();
          limits = concurrencyLimits();
          await ensureJobsLoaded();
        } catch (error) {
          json(response, 503, {
            ok: false,
            worker: 'sim2real-local',
            mode: 'external-engine',
            configured: false,
            error: error?.errorCode || 'worker_configuration_invalid',
            message: text(error?.message) || '训练引擎配置无效。',
            cuda: null,
            contracts: ['microduck-policy-v1', 'rdk-duck-policy-v1', 'originbot-policy-v1'],
          });
          return;
        }
        const tokenValue = String(process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN || '').trim();
        const tokenConfigured = Boolean(tokenValue);
        const tokenUsable = runnerTokenUsable(tokenValue);
        const authReady = !runnerTokenRequired() || tokenUsable;
        const ready = engineIds.length > 0 && authReady;
        json(response, ready ? 200 : 503, {
          ok: ready,
          worker: 'sim2real-local',
          mode: 'external-engine',
          configured,
          engines: engineIds,
          mock: false,
          authConfigured: tokenConfigured,
          authTokenUsable: tokenUsable,
          ...(!authReady
            ? { error: 'worker_auth_not_configured' }
            : configured && !engineIds.length
              ? { error: 'engine_executable_unavailable' }
              : {}),
          maxConcurrentJobs: limits.total,
          maxConcurrentJobsPerAccount: limits.perAccount,
          activeJobs: activeJobs.size,
          queuedJobs: queuedJobs.length,
          cuda: null,
          contracts: ['microduck-policy-v1', 'rdk-duck-policy-v1', 'originbot-policy-v1'],
        });
        return;
      }
      if (!authorized(request)) {
        json(response, 401, { ok: false, error: 'local_worker_unauthorized' });
        return;
      }
      const preflightRoute = /^\/engines\/([a-z][a-z0-9-]{1,31})\/preflight$/.exec(
        request.url || '',
      );
      if (request.method === 'POST' && preflightRoute) {
        await handleEnginePreflight(request, response, preflightRoute[1]);
        return;
      }
      if (request.method === 'POST' && /^\/runs\/[^/]+\/cancel$/.test(request.url || '')) {
        await handleCancel(
          request,
          response,
          decodeURIComponent(request.url.slice('/runs/'.length, -'/cancel'.length)),
        );
        return;
      }
      if (request.method === 'POST' && request.url === '/train') {
        await handleTrain(request, response);
        return;
      }
      if (request.method === 'POST' && request.url === '/originman-reference/screen') {
        await handleReferenceScreen(request, response);
        return;
      }
      const replayRoute = /^\/runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reference-replay$/.exec(
        request.url ?? '',
      );
      if (replayRoute && (request.method === 'GET' || request.method === 'POST')) {
        await handleReferenceReplay(request, response, replayRoute[1]);
        return;
      }
      const videoRoute = /^\/runs\/[^/]+\/(dance-video|workshop-video)$/.exec(request.url ?? '');
      if (request.method === 'GET' && videoRoute) {
        await handleRunVideo(request, response, videoRoute[1]);
        return;
      }
      if (
        request.method === 'GET' &&
        request.url?.startsWith('/runs/') &&
        request.url.endsWith('/artifact')
      ) {
        await handleArtifact(request, response);
        return;
      }
      if (
        request.method === 'GET' &&
        request.url?.startsWith('/runs/') &&
        request.url.split('?')[0].endsWith('/telemetry')
      ) {
        await handleTelemetry(request, response);
        return;
      }
      if (
        request.method === 'GET' &&
        request.url?.startsWith('/runs/') &&
        request.url.split('?')[0].endsWith('/logs')
      ) {
        await handleLogs(request, response);
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
        error: error?.errorCode || 'local_worker_failed',
        message: text(error?.message),
      });
    }
  });
  server.once('listening', () => {
    void ensureJobsLoaded().catch(() =>
      console.error('[sim2real-local] could not restore job records'),
    );
  });
  return server;
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
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const server = createLocalTrainingWorkerServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(PORT, HOST, () =>
    console.log(`[sim2real-local] listening on http://${HOST}:${PORT}`),
  );
  const close = async () => {
    if (workerShuttingDown) return;
    workerShuttingDown = true;
    // An unconfirmed cancellation intentionally keeps its reservation, but
    // its day-long job timer must not keep an already-closed Worker alive.
    for (const job of jobs.values()) {
      if (job.timeout) clearTimeout(job.timeout);
      job.timeout = undefined;
    }
    const owned = [...activeChildren];
    const exited = owned.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once('close', resolve);
        }),
    );
    const signalOwned = (signal) => {
      for (const child of owned) {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* this owned process group has already exited */
        }
      }
    };
    const forceExit = setTimeout(() => process.exit(1), 5000);
    forceExit.unref();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    const serverClosed = new Promise((resolve) => server.close(resolve));
    signalOwned('SIGTERM');
    // Even if a launcher exits first, its process group may still contain
    // multiprocessing or probe children that must not survive the worker.
    await new Promise((resolve) => setTimeout(resolve, owned.length ? 1500 : 0));
    signalOwned('SIGKILL');
    await Promise.all([serverClosed, ...exited]);
    clearTimeout(forceExit);
    process.exitCode = 0;
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
