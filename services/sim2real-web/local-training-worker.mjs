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
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
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
const MAX_RESULT = 1 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10_000_000_000;
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
  /iter (\d+)\/(\d+) meanReward=(-?\d+(?:\.\d+)?) recentSuccess=(\d+(?:\.\d+)?)(?: goalRange=\[([^\]]*)\])?(?: elapsed=(\d+(?:\.\d+)?)s)?/g;

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
    const point = {
      iteration,
      totalIterations: total,
      meanReward,
      recentSuccess,
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
    points.push({
      iteration,
      totalIterations: total,
      meanReward,
      recentSuccess,
      ...(Number.isFinite(elapsed) ? { elapsedSeconds: elapsed } : {}),
      ...(typeof raw.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.at) ? { at: raw.at } : {}),
    });
  }
  return points.length ? points : undefined;
}
const MAX_JOBS = 1000;
const MAX_CONCURRENT_JOBS_LIMIT = 32;
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const profiles = new Set(['smoke', 'low-vram', 'standard', 'high-vram']);
const jobs = new Map();
const queuedJobs = [];
const activeJobs = new Set();
const activeChildren = new Set();
const finalizingJobs = new Set();
let jobsLoadPromise;

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

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw fail('training request is too large', 413, 'request_too_large');
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
  return {
    contractId,
    modelId: text(model.modelId, 64),
    version: text(model.version, 64),
    profile,
  };
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
    entries.set(id, { id, executable, args });
  }
  return entries;
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

function maxConcurrentJobs() {
  const raw = String(process.env.RDK_SIM2REAL_MAX_CONCURRENT_JOBS || '1').trim();
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONCURRENT_JOBS_LIMIT
  ) {
    throw fail(
      `RDK_SIM2REAL_MAX_CONCURRENT_JOBS must be an integer from 1 to ${MAX_CONCURRENT_JOBS_LIMIT}`,
      500,
      'worker_configuration_invalid',
    );
  }
  return value;
}

function publicJob(job) {
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
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name) || jobs.size >= MAX_JOBS) continue;
    const dir = path.join(DATA_DIR, entry.name);
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, 'job.json'), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const candidate = { ...parsed, runId: entry.name, dir };
      if (
        !SAFE_RUN_ID.test(candidate.runId) ||
        !text(candidate.accountId, 160) ||
        !['queued', 'running', 'completed', 'failed'].includes(candidate.status) ||
        typeof candidate.fingerprint !== 'string'
      )
        continue;
      candidate.accountId = text(candidate.accountId, 160);
      if (!candidate.accountId || /[\u0000-\u001f\u007f/]/.test(candidate.accountId)) continue;
      // A process restart terminates children through systemd's cgroup. Keep
      // the record visible, but close the stale reservation explicitly rather
      // than relaunching user work or reporting a false running state.
      if (candidate.status === 'queued' || candidate.status === 'running') {
        candidate.status = 'failed';
        candidate.finishedAt = new Date().toISOString();
        candidate.errorCode = 'worker_restarted';
        candidate.message =
          '本地 worker 重启后任务状态未知；未自动重启训练，请检查任务目录中的结果。';
      }
      delete candidate.pid;
      delete candidate.timeout;
      jobs.set(candidate.runId, candidate);
      if (candidate.errorCode === 'worker_restarted')
        await persist(candidate).catch(() => undefined);
    } catch {
      // A partial/corrupt job must not make the worker unavailable. It is
      // intentionally left on disk for operator inspection.
    }
  }
}

function ensureJobsLoaded() {
  if (!jobsLoadPromise) jobsLoadPromise = restorePersistedJobs();
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
  await writeFile(path.join(job.dir, 'request.json'), JSON.stringify(job.request, null, 2), {
    mode: 0o600,
  });
  const child = spawn(config.executable, config.args, {
    cwd: job.dir,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment(job),
  });
  activeChildren.add(child);
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
  const timeoutMs = Math.min(
    Math.max(Number(process.env.RDK_SIM2REAL_TRAIN_TIMEOUT_MS || 86_400_000), 1000),
    7 * 86_400_000,
  );
  job.timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.once('error', (error) => finish(job, 1, stdout, `${stderr}\n${error.message}`));
  child.once('exit', (code, signal) =>
    finish(job, code ?? 1, stdout, `${stderr}${signal ? `\nterminated:${signal}` : ''}`),
  );
}

async function finish(job, code, stdout, stderr) {
  if (job.finishedAt || finalizingJobs.has(job)) return;
  finalizingJobs.add(job);
  // The process is done, so no chunk can complete a partial line anymore:
  // flush what remains as the final line of each stream.
  for (const stream of Object.keys(job.logPartials || {})) {
    const partial = job.logPartials[stream];
    if (partial) appendLogLine(job, stream, partial);
  }
  job.logPartials = undefined;
  if (job.timeout) clearTimeout(job.timeout);
  const childPid = job.pid;
  for (const child of activeChildren) {
    if (childPid != null && child.pid === childPid) activeChildren.delete(child);
  }
  activeJobs.delete(job);
  job.timeout = undefined;
  job.finishedAt = new Date().toISOString();
  job.pid = undefined;
  try {
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
    finalizingJobs.delete(job);
    void pumpQueue();
  }
}

async function pumpQueue() {
  let limit;
  try {
    limit = maxConcurrentJobs();
  } catch {
    // /healthz reports invalid configuration. Keep queued work visible rather
    // than launching it with an implicit fallback or dropping it.
    return;
  }
  while (activeJobs.size < limit && queuedJobs.length) {
    const job = queuedJobs.shift();
    if (!job || job.status !== 'queued') continue;
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
  // Timeout handles are process-local and circular; never serialize runtime
  // state into the durable job snapshot exposed to status readers.
  const { timeout: _timeout, ...snapshot } = job;
  await writeFile(path.join(job.dir, 'job.json'), JSON.stringify(snapshot, null, 2), {
    mode: 0o600,
  });
}

async function handleTrain(request, response) {
  await ensureJobsLoaded();
  const source = await bodyJson(request);
  const engines = workerEngines();
  maxConcurrentJobs();
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
  engineFor(source);
  const owner = accountId(request, source);
  const key = requestKey(request, source);
  const fingerprint = requestFingerprint(source, owner);
  for (const job of jobs.values()) {
    if (key && job.accountId === owner && job.idempotencyKey === key) {
      if (job.fingerprint !== fingerprint)
        throw fail(
          'Idempotency-Key was reused for a different request',
          409,
          'idempotency_conflict',
        );
      json(response, 200, { ...publicJob(job), idempotentReplay: true });
      return;
    }
  }
  if (jobs.size >= MAX_JOBS)
    throw fail('worker job retention limit reached', 429, 'worker_queue_full');
  const runId = `local-${normalized.modelId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48)}-${randomUUID()}`;
  const dir = path.join(DATA_DIR, runId);
  const job = {
    runId,
    status: 'queued',
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
  queuedJobs.push(job);
  void pumpQueue();
  json(response, 202, publicJob(job));
}

async function handleStatus(request, response, runId) {
  await ensureJobsLoaded();
  const job = jobs.get(runId);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  if (owner !== job.accountId) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  json(response, 200, publicJob(job));
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
  const job = jobs.get(runId);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  if (owner !== job.accountId) {
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
  const job = jobs.get(runId);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  if (owner !== job.accountId) {
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
  const job = jobs.get(runId);
  if (!job) {
    json(response, 404, { ok: false, error: 'run_not_found' });
    return;
  }
  let owner;
  try {
    owner = accountId(request, {});
  } catch {
    json(response, 401, { ok: false, error: 'account_required' });
    return;
  }
  if (owner !== job.accountId) {
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
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        let configured = false;
        let engineIds = [];
        try {
          const engines = workerEngines();
          configured = engines.size > 0;
          engineIds = [...engines.keys()].sort();
          maxConcurrentJobs();
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
        json(response, configured && authReady ? 200 : 503, {
          ok: configured && authReady,
          worker: 'sim2real-local',
          mode: 'external-engine',
          configured,
          engines: engineIds,
          authConfigured: tokenConfigured,
          authTokenUsable: tokenUsable,
          ...(authReady ? {} : { error: 'worker_auth_not_configured' }),
          maxConcurrentJobs: maxConcurrentJobs(),
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
      if (request.method === 'POST' && request.url === '/train') {
        await handleTrain(request, response);
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const server = createLocalTrainingWorkerServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(PORT, HOST, () =>
    console.log(`[sim2real-local] listening on http://${HOST}:${PORT}`),
  );
  const close = () => {
    for (const child of activeChildren) child.kill('SIGTERM');
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    const forceExit = setTimeout(() => process.exit(1), 5_000);
    forceExit.unref();
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
