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
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HOST = String(process.env.RDK_SIM2REAL_LOCAL_WORKER_HOST || '127.0.0.1').trim() || '127.0.0.1';
const portValue = Number(process.env.RDK_SIM2REAL_LOCAL_WORKER_PORT || 19091);
const PORT = Number.isInteger(portValue) && portValue >= 1024 && portValue <= 65535 ? portValue : 19091;
const DATA_DIR = path.resolve(String(process.env.RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR || path.join(process.cwd(), '.data', 'local-worker')));
const MAX_BODY = 2 * 1024 * 1024;
const MAX_RESULT = 1 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10_000_000_000;
const MAX_LOG = 64 * 1024;
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

function text(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function scrubLog(value, max = 2000) {
  return text(value, max)
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
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
  const { idempotencyKey: _idempotencyKey, accountId: _accountId, ...requestWithoutIdentity } = source;
  return createHash('sha256')
    .update(canonicalJson({ accountId: owner, request: requestWithoutIdentity }))
    .digest('hex');
}

function validate(source) {
  if (source.schemaVersion !== 1) throw fail('schemaVersion must be 1');
  const contract = source.contract && typeof source.contract === 'object' ? source.contract : {};
  const model = source.model && typeof source.model === 'object' ? source.model : {};
  const contractId = text(source.contractId, 120);
  if (!contractId || contract.id !== contractId || !text(model.modelId, 64) || !text(model.version, 64)) {
    throw fail('contractId, contract.id, model.modelId and model.version are required');
  }
  if (!Number.isSafeInteger(Number(contract.observationSize)) || !Number.isSafeInteger(Number(contract.actionSize))) {
    throw fail('contract dimensions are invalid');
  }
  const training = source.training && typeof source.training === 'object' ? source.training : {};
  const profile = text(training.profile, 32) || 'standard';
  if (!profiles.has(profile)) throw fail('training.profile is not allowed');
  return { contractId, modelId: text(model.modelId, 64), version: text(model.version, 64), profile };
}

function executableConfig() {
  const executable = String(process.env.RDK_SIM2REAL_TRAIN_EXECUTABLE || '').trim();
  if (!executable) return null;
  // An absolute path makes the deployment boundary explicit and avoids PATH
  // surprises when the service is started by systemd.
  if (!path.isAbsolute(executable) || executable.includes('\0')) throw fail('RDK_SIM2REAL_TRAIN_EXECUTABLE must be an absolute path', 500, 'worker_configuration_invalid');
  let args = [];
  const rawArgs = String(process.env.RDK_SIM2REAL_TRAIN_ARGS_JSON || '[]').trim();
  try {
    args = JSON.parse(rawArgs);
  } catch {
    throw fail('RDK_SIM2REAL_TRAIN_ARGS_JSON must be a JSON array', 500, 'worker_configuration_invalid');
  }
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string' || item.length > 500)) {
    throw fail('RDK_SIM2REAL_TRAIN_ARGS_JSON must contain strings', 500, 'worker_configuration_invalid');
  }
  return { executable, args };
}

function maxConcurrentJobs() {
  const raw = String(process.env.RDK_SIM2REAL_MAX_CONCURRENT_JOBS || '1').trim();
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENT_JOBS_LIMIT) {
    throw fail(`RDK_SIM2REAL_MAX_CONCURRENT_JOBS must be an integer from 1 to ${MAX_CONCURRENT_JOBS_LIMIT}`, 500, 'worker_configuration_invalid');
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
    ...visible
  } = job;
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
      ) continue;
      candidate.accountId = text(candidate.accountId, 160);
      if (!candidate.accountId || /[\u0000-\u001f\u007f/]/.test(candidate.accountId)) continue;
      // A process restart terminates children through systemd's cgroup. Keep
      // the record visible, but close the stale reservation explicitly rather
      // than relaunching user work or reporting a false running state.
      if (candidate.status === 'queued' || candidate.status === 'running') {
        candidate.status = 'failed';
        candidate.finishedAt = new Date().toISOString();
        candidate.errorCode = 'worker_restarted';
        candidate.message = '本地 worker 重启后任务状态未知；未自动重启训练，请检查任务目录中的结果。';
      }
      delete candidate.pid;
      delete candidate.timeout;
      jobs.set(candidate.runId, candidate);
      if (candidate.errorCode === 'worker_restarted') await persist(candidate).catch(() => undefined);
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

function resultArtifact(result) {
  const checkpoint = result.checkpoint && typeof result.checkpoint === 'object' ? result.checkpoint : null;
  const artifact = result.artifact && typeof result.artifact === 'object' ? result.artifact : null;
  const refs = [checkpoint?.artifactRef, artifact?.artifactRef, artifact?.ref];
  if (!refs.some((ref) => typeof ref === 'string' && /^artifact:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}){0,8}$/.test(ref))) return null;
  return { checkpoint, artifact, metrics: result.metrics && typeof result.metrics === 'object' ? result.metrics : undefined };
}

async function launch(job, config) {
  await writeFile(path.join(job.dir, 'request.json'), JSON.stringify(job.request, null, 2), { mode: 0o600 });
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
  child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-MAX_LOG); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-MAX_LOG); });
  const timeoutMs = Math.min(Math.max(Number(process.env.RDK_SIM2REAL_TRAIN_TIMEOUT_MS || 86_400_000), 1000), 7 * 86_400_000);
  job.timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.once('error', (error) => finish(job, 1, stdout, `${stderr}\n${error.message}`));
  child.once('exit', (code, signal) => finish(job, code ?? 1, stdout, `${stderr}${signal ? `\nterminated:${signal}` : ''}`));
}

async function finish(job, code, stdout, stderr) {
  if (job.finishedAt || finalizingJobs.has(job)) return;
  finalizingJobs.add(job);
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
      const taskEvaluation = await readTaskEvaluation(job, result);
      job.status = 'completed';
      job.mock = false;
      job.cuda = Boolean(result.cuda);
      job.deployable = result.deployable === true;
      if (artifact.checkpoint) job.checkpoint = artifact.checkpoint;
      if (artifact.artifact) job.artifact = await attachLocalArtifactDigest(job, artifact.artifact);
      if (artifact.metrics) job.metrics = artifact.metrics;
      if (taskEvaluation) job.taskEvaluation = taskEvaluation;
      job.message = '本地训练引擎已完成并返回受控制品引用。';
    } else {
      job.status = 'failed';
      job.message = code === 0 ? '训练进程完成，但未写入有效 artifact:// 结果；任务不会标记为成功。' : '本地训练进程失败。';
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
      config = executableConfig();
    } catch (error) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.errorCode = error?.errorCode || 'worker_configuration_invalid';
      job.message = text(error?.message) || 'worker configuration is invalid';
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
  await writeFile(path.join(job.dir, 'job.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
}

async function handleTrain(request, response) {
  await ensureJobsLoaded();
  const source = await bodyJson(request);
  const config = executableConfig();
  maxConcurrentJobs();
  if (!config) {
    json(response, 503, { ok: false, error: 'real_worker_not_configured', message: '未配置真实训练引擎；当前 worker 不会伪造 PPO 完成。' });
    return;
  }
  const normalized = validate(source);
  const owner = accountId(request, source);
  const key = requestKey(request, source);
  const fingerprint = requestFingerprint(source, owner);
  for (const job of jobs.values()) {
    if (key && job.accountId === owner && job.idempotencyKey === key) {
      if (job.fingerprint !== fingerprint) throw fail('Idempotency-Key was reused for a different request', 409, 'idempotency_conflict');
      json(response, 200, { ...publicJob(job), idempotentReplay: true });
      return;
    }
  }
  if (jobs.size >= MAX_JOBS) throw fail('worker job retention limit reached', 429, 'worker_queue_full');
  const runId = `local-${normalized.modelId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48)}-${randomUUID()}`;
  const dir = path.join(DATA_DIR, runId);
  const job = { runId, status: 'queued', mock: false, cuda: null, deployable: false, accountId: owner, contractId: normalized.contractId, modelId: normalized.modelId, version: normalized.version, profile: normalized.profile, idempotencyKey: key, fingerprint, request: source, dir, createdAt: new Date().toISOString() };
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
  if (!job) { json(response, 404, { ok: false, error: 'run_not_found' }); return; }
  let owner;
  try { owner = accountId(request, {}); } catch { json(response, 401, { ok: false, error: 'account_required' }); return; }
  if (owner !== job.accountId) { json(response, 404, { ok: false, error: 'run_not_found' }); return; }
  json(response, 200, publicJob(job));
}

export function createLocalTrainingWorkerServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        let configured = false;
        try {
          configured = Boolean(executableConfig());
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
        json(response, configured ? 200 : 503, {
          ok: configured,
          worker: 'sim2real-local',
          mode: 'external-engine',
          configured,
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
      if (request.method === 'POST' && request.url === '/train') { await handleTrain(request, response); return; }
      if (request.method === 'GET' && request.url?.startsWith('/runs/')) { await handleStatus(request, response, decodeURIComponent(request.url.slice('/runs/'.length))); return; }
      json(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      json(response, status, { ok: false, error: error?.errorCode || 'local_worker_failed', message: text(error?.message) });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const server = createLocalTrainingWorkerServer();
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(PORT, HOST, () => console.log(`[sim2real-local] listening on http://${HOST}:${PORT}`));
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
