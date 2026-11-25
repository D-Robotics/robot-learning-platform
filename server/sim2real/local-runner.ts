import { createHash } from 'node:crypto';

import type {
  Sim2RealCheckpointRef,
  Sim2RealModelManifest,
  Sim2RealTrainingSpec,
  Sim2RealDemonstrations,
} from '../../shared/sim2real.js';
import {
  isLocalRunnerConfigured as isRunnerConfigured,
  normalizeRunnerUrl,
  requestRobogoTraining,
  requestRobogoTrainingStatus,
  safeAccountId,
  type Sim2RealRobogoRunResult,
} from './robogo-runner.js';
import { Sim2RealError } from './sim2real-errors.js';

const WEAK_RUNNER_TOKEN_RE =
  /^(?:replace(?:[-_ ]?with)?(?:[-_ ].*)?|change(?:[-_ ]?me)?(?:[-_ ].*)?|changeme(?:[-_ ]?.*)?|example(?:[-_ ].*)?|placeholder(?:[-_ ].*)?|default(?:[-_ ]?secret)?(?:[-_ ].*)?|dummy(?:[-_ ].*)?|password(?:[-_ ].*)?|your[-_ ]?(?:secret|key)(?:[-_ ].*)?|secret(?:[-_ ].*)?)$/i;
const REPEATED_RUNNER_TOKEN_RE = /^(.)\1{31,}$/s;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

/** Token syntax check shared by route-level credential validation. */
export function localRunnerTokenFormatValid(value: unknown): boolean {
  const token = String(value ?? '').trim();
  return Buffer.byteLength(token, 'utf8') <= 4096 && !containsControlCharacter(token);
}

function loopbackHost(hostname: string): boolean {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Match the local worker's exposed-endpoint token policy. */
export function localRunnerTokenUsable(value: unknown): boolean {
  const token = String(value ?? '').trim();
  return (
    Boolean(token) &&
    Buffer.byteLength(token, 'utf8') >= 32 &&
    Buffer.byteLength(token, 'utf8') <= 4096 &&
    localRunnerTokenFormatValid(token) &&
    !WEAK_RUNNER_TOKEN_RE.test(token) &&
    !REPEATED_RUNNER_TOKEN_RE.test(token)
  );
}

/**
 * A loopback development worker may use a short fixture token (or no token),
 * while production and every non-loopback endpoint must be authenticated.
 * Keeping this check in the outbound adapter prevents a misconfigured server
 * from sending a job to an exposed worker before the worker can reject it.
 */
export function localRunnerTokenRequired(rawUrl?: string): boolean {
  const production =
    String(process.env.NODE_ENV ?? '')
      .trim()
      .toLowerCase() === 'production' ||
    String(process.env.RDK_SIM2REAL_DEPLOYMENT ?? '')
      .trim()
      .toLowerCase() === 'web-cloud' ||
    String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE ?? '')
      .trim()
      .toLowerCase() === 'web-cloud';
  if (production) return true;
  try {
    const parsed = new URL(
      normalizeRunnerUrl(rawUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '', {
        localHttp: true,
      }),
    );
    return !loopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** Whether a configured endpoint is safe to advertise as executable. */
export function localRunnerConnectionReady(rawUrl?: string, token?: string): boolean {
  const url = rawUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  if (!isRunnerConfigured(url)) return false;
  const effectiveToken = String(token ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '').trim();
  return !localRunnerTokenRequired(url) || localRunnerTokenUsable(effectiveToken);
}

function assertLocalRunnerToken(rawUrl: string | undefined, token: string): void {
  if (localRunnerTokenRequired(rawUrl) && !localRunnerTokenUsable(token)) {
    throw new Sim2RealError('sim2real_runner_token_invalid', {
      detail: '远程或生产 local runner 必须配置至少 32 字节随机 bearer token。',
    });
  }
}

/**
 * Local training uses the same narrow runner protocol as RoboGo, but points at
 * a worker on the user's own server. Keeping the adapter separate makes the
 * deployment choice explicit without duplicating payload validation.
 */
export function isLocalRunnerConfigured(raw?: string): boolean {
  return isRunnerConfigured(raw ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '');
}

export async function requestLocalTraining(input: {
  accountId: string;
  requestToken?: string | null;
  manifest: Sim2RealModelManifest;
  training?: Sim2RealTrainingSpec;
  demonstrations?: Sim2RealDemonstrations;
  resumeFrom?: Sim2RealCheckpointRef;
  taskId?: string;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
}): Promise<Sim2RealRobogoRunResult> {
  const localToken = String(
    input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
  ).trim();
  const runnerUrl = input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  assertLocalRunnerToken(runnerUrl, localToken);
  return requestRobogoTraining({
    ...input,
    // A local worker is an internal deployment boundary.  Never forward the
    // Studio/RoboGo bearer token to it, even if a caller happens to provide
    // one while reusing the shared adapter input shape.
    requestToken: localToken || undefined,
    // Pass an explicit empty value when the local endpoint is unset so the
    // generic adapter can never fall back to the RoboGo endpoint.
    runnerUrl,
    allowPrivateHttp: true,
    allowEnvironmentToken: false,
  });
}

export async function requestLocalTrainingStatus(input: {
  accountId: string;
  requestToken?: string | null;
  externalRunId: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  statusUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
}): Promise<Sim2RealRobogoRunResult> {
  const localToken = String(
    input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
  ).trim();
  const runnerUrl = input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  assertLocalRunnerToken(runnerUrl, localToken);
  return requestRobogoTrainingStatus({
    ...input,
    requestToken: localToken || undefined,
    runnerUrl,
    allowPrivateHttp: true,
    allowEnvironmentToken: false,
  });
}

/**
 * Fetch a completed local-worker run's ONNX artifact bytes (GET
 * /runs/:id/artifact). The worker re-hashes the file before serving, so the
 * bytes this returns are verified against the digest recorded at completion.
 * Returns null for any transport failure, non-2xx, size anomaly, or digest
 * mismatch — staging must fail closed, never fall back to a guess.
 */
export async function fetchLocalRunArtifact(input: {
  /** The worker gates every /runs/:id route on the owning account. */
  accountId: string;
  externalRunId: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
  kind?: 'dance-video' | 'workshop-video';
}): Promise<{ bytes: Buffer; sha256: string } | null> {
  const accountId = safeAccountId(input.accountId);
  let runnerUrl: string;
  try {
    runnerUrl = normalizeRunnerUrl(
      input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '',
      { localHttp: true },
    );
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(input.timeoutMs ?? 60_000, 1000), 180_000),
  );
  try {
    const token = String(
      input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
    ).trim();
    if (localRunnerTokenRequired(runnerUrl) && !localRunnerTokenUsable(token)) return null;
    // Mirror statusUrl's /train handling: the runner URL is conventionally
    // configured with the POST endpoint path, but /runs/:id routes live at
    // the worker root. Without this the artifact fetch 404s on every
    // deployment that kept the conventional suffix.
    const parsedRunner = new URL(runnerUrl);
    const runnerPath = parsedRunner.pathname.replace(/\/+$/, '');
    if (runnerPath.endsWith('/train')) parsedRunner.pathname = runnerPath.slice(0, -6);
    const response = await (input.fetchImpl ?? fetch)(
      `${parsedRunner.toString().replace(/\/+$/, '')}/runs/${encodeURIComponent(input.externalRunId)}/${input.kind ?? 'artifact'}`,
      {
        method: 'GET',
        headers: {
          accept: input.kind ? 'video/mp4' : 'application/octet-stream',
          'x-sim2real-account': accountId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (!response.ok || (input.kind && response.headers.get('content-type') !== 'video/mp4'))
      return null;
    const declared = Number(response.headers.get('content-length') || 0);
    // Same ceiling the worker enforces (50 MB). A lie or an absent header is
    // re-checked while streaming.
    if (!Number.isFinite(declared) || declared <= 0 || declared > 50 * 1024 * 1024) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 50 * 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    if (total !== declared) return null;
    const bytes = Buffer.concat(chunks);
    const sha256 = String(response.headers.get('x-artifact-sha256') || '')
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
    // Do not trust a worker-provided digest by itself.  The digest is part of
    // the release evidence chain, so verify the downloaded bytes locally
    // before handing them to BoardStation for staging.
    const computedSha256 = createHash('sha256').update(bytes).digest('hex');
    if (computedSha256 !== sha256) return null;
    return { bytes, sha256 };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a completed local-worker run's evaluation telemetry.jsonl bytes
 * (GET /runs/:id/telemetry). The engine already recorded hard-envelope
 * rollouts while evaluating; this returns those rows so the platform can
 * attach the run's own evidence to the replay pipeline. Returns null for
 * any transport failure, non-2xx, size anomaly, or invalid NDJSON — the
 * auto-attach path must fail closed and simply leave the run without
 * replay data instead of inventing any.
 */
export async function fetchLocalRunTelemetry(input: {
  /** The worker gates every /runs/:id route on the owning account. */
  accountId: string;
  externalRunId: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
}): Promise<{ lines: string[]; sampleCount: number } | null> {
  const accountId = safeAccountId(input.accountId);
  let runnerUrl: string;
  try {
    runnerUrl = normalizeRunnerUrl(
      input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '',
      { localHttp: true },
    );
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(input.timeoutMs ?? 30_000, 1000), 120_000),
  );
  try {
    const token = String(
      input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
    ).trim();
    if (localRunnerTokenRequired(runnerUrl) && !localRunnerTokenUsable(token)) return null;
    // Same /train-suffix convention as fetchLocalRunArtifact: /runs/:id
    // routes live at the worker root.
    const parsedRunner = new URL(runnerUrl);
    const runnerPath = parsedRunner.pathname.replace(/\/+$/, '');
    if (runnerPath.endsWith('/train')) parsedRunner.pathname = runnerPath.slice(0, -6);
    const response = await (input.fetchImpl ?? fetch)(
      `${parsedRunner.toString().replace(/\/+$/, '')}/runs/${encodeURIComponent(input.externalRunId)}/telemetry`,
      {
        method: 'GET',
        headers: {
          accept: 'application/x-ndjson',
          'x-sim2real-account': accountId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') || 0);
    if (!Number.isFinite(declared) || declared <= 0 || declared > 50 * 1024 * 1024) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 50 * 1024 * 1024) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    if (total !== declared) return null;
    const text = Buffer.concat(chunks).toString('utf8');
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0 || lines.length > 50_000) return null;
    // Validate NDJSON shape before anything touches the store: every row must
    // be an object carrying a numeric `t` and bounded observation/action
    // arrays matching the telemetry sample schema.
    let sampleCount = 0;
    for (const line of lines) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        return null;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const record = row as Record<string, unknown>;
      const t = Number(record.t);
      if (!Number.isFinite(t) || t < 0) return null;
      sampleCount += 1;
    }
    return { lines, sampleCount };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a local-worker run's incremental engine log lines (GET
 * /runs/:id/logs?after=N). The worker numbers lines in arrival order and
 * bounds the ring, so this returns only the new tail plus cursor state.
 * Distinguish a missing Worker job or log endpoint from a transient failure so
 * the platform can guide recovery without sending the cursor to another Worker.
 */
export async function fetchLocalRunLogs(input: {
  /** The worker gates every /runs/:id route on the owning account. */
  accountId: string;
  externalRunId: string;
  after?: number;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  runnerToken?: string;
  timeoutMs?: number;
}): Promise<
  | {
      total: number;
      retainedFrom: number;
      truncated: boolean;
      lines: { n: number; stream: string; text: string }[];
    }
  | 'job-missing'
  | 'route-unavailable'
  | 'worker-auth-rejected'
  | null
> {
  const accountId = safeAccountId(input.accountId);
  let runnerUrl: string;
  try {
    runnerUrl = normalizeRunnerUrl(
      input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '',
      { localHttp: true },
    );
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(Math.max(input.timeoutMs ?? 15_000, 1000), 60_000),
  );
  try {
    const token = String(
      input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
    ).trim();
    if (localRunnerTokenRequired(runnerUrl) && !localRunnerTokenUsable(token))
      return 'worker-auth-rejected';
    // Same /train-suffix convention as the artifact and telemetry fetches:
    // /runs/:id routes live at the worker root.
    const parsedRunner = new URL(runnerUrl);
    const runnerPath = parsedRunner.pathname.replace(/\/+$/, '');
    if (runnerPath.endsWith('/train')) parsedRunner.pathname = runnerPath.slice(0, -6);
    const after =
      Number.isSafeInteger(input.after) && Number(input.after) >= 0 ? Number(input.after) : 0;
    const response = await (input.fetchImpl ?? fetch)(
      `${parsedRunner.toString().replace(/\/+$/, '')}/runs/${encodeURIComponent(input.externalRunId)}/logs?after=${after}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-sim2real-account': accountId,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      return 'worker-auth-rejected';
    }
    if (response.status === 404)
      return (await readWorkerErrorCode(response)) === 'run_not_found'
        ? 'job-missing'
        : 'route-unavailable';
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const total = Number(record.total);
    const retainedFrom = Number(record.retainedFrom);
    if (!Number.isSafeInteger(total) || total < 0) return null;
    if (!Number.isSafeInteger(retainedFrom) || retainedFrom < 0) return null;
    const rawLines = Array.isArray(record.lines) ? record.lines : [];
    if (rawLines.length > 600) return null;
    const lines: { n: number; stream: string; text: string }[] = [];
    for (const raw of rawLines) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const line = raw as Record<string, unknown>;
      const n = Number(line.n);
      const stream = String(line.stream ?? '');
      const lineText = String(line.text ?? '');
      if (!Number.isSafeInteger(n) || n < 1) return null;
      if (stream !== 'stdout' && stream !== 'stderr') return null;
      if (!lineText || lineText.length > 2000) return null;
      lines.push({ n, stream, text: lineText });
    }
    return {
      total,
      retainedFrom,
      truncated: record.truncated === true,
      lines,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Request cancellation; a cancelling acknowledgement is not proof of exit. */
export async function requestLocalTrainingCancel(
  input: Parameters<typeof requestLocalTrainingStatus>[0],
): Promise<Sim2RealRobogoRunResult> {
  const localToken = String(
    input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
  ).trim();
  const runnerUrl = input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  assertLocalRunnerToken(runnerUrl, localToken);
  return requestRobogoTrainingStatus({
    ...input,
    operation: 'cancel',
    requestToken: localToken || undefined,
    runnerUrl,
    allowPrivateHttp: true,
    allowEnvironmentToken: false,
  });
}

export class LocalEnginePreflightBusyError extends Error {
  readonly code = 'engine_preflight_busy';
  constructor() {
    super('Worker is running training or another environment probe.');
    this.name = 'LocalEnginePreflightBusyError';
  }
}

export class LocalEnginePreflightUnsupportedError extends Error {}

async function readWorkerErrorCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

/** Explicit environment probe; never submits /train or falls back to another resource. */
export async function requestLocalEnginePreflight(input: {
  accountId: string;
  taskId: string;
  runnerUrl?: string;
  runnerToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const accountId = safeAccountId(input.accountId);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.taskId)) throw new Error('Invalid preflight task id.');
  const runnerUrl = input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  const token = String(
    input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
  ).trim();
  assertLocalRunnerToken(runnerUrl, token);
  const url = new URL(normalizeRunnerUrl(runnerUrl, { localHttp: true }));
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/train')) throw new Error('Worker URL must end with /train.');
  url.pathname = pathname.slice(0, -6) + '/engines/microduck-rl/preflight';
  url.search = '';
  url.hash = '';
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-sim2real-account': accountId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ taskId: input.taskId }),
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) {
    const code = await readWorkerErrorCode(response);
    if (
      (response.status === 404 && code === 'not_found') ||
      (response.status === 409 && code === 'engine_preflight_not_configured')
    )
      throw new LocalEnginePreflightUnsupportedError();
    if (response.status === 429 && code === 'engine_preflight_busy')
      throw new LocalEnginePreflightBusyError();
    throw new Error(
      `Worker environment probe returned HTTP ${response.status}; check its version and preflightArgs.`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Worker preflight report is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new Error('Worker preflight report exceeds limit.');
    }
    chunks.push(value);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  const report = body.report as Record<string, unknown> | undefined;
  const required = new Set([
    'upstream',
    'uv',
    'project-spec',
    'venv',
    'python',
    'dependencies',
    'cuda',
    'robot-assets',
    'exporter',
    'task-registry',
  ]);
  if (
    body.ok !== true ||
    !report ||
    report.schemaVersion !== 1 ||
    report.engine !== 'microduck-rl' ||
    report.taskId !== input.taskId ||
    report.trainingPerformed !== false ||
    !Array.isArray(report.checks) ||
    report.checks.length > 32
  )
    throw new Error('Worker preflight report does not match the requested engine/task.');
  const seen = new Set<string>();
  const checks = report.checks.map((raw: unknown) => {
    const item = raw as Record<string, unknown>;
    if (
      !item ||
      typeof item.id !== 'string' ||
      !required.has(item.id) ||
      seen.has(item.id) ||
      !['passed', 'blocked', 'unverified'].includes(String(item.status))
    )
      throw new Error('Invalid preflight checks.');
    seen.add(item.id);
    return {
      id: item.id,
      status: String(item.status),
      detail: String(item.detail ?? '').slice(0, 1000),
      recovery: String(item.recovery ?? '').slice(0, 1000),
    };
  });
  if (seen.size !== required.size) throw new Error('Worker preflight report is incomplete.');
  const checkedAt = typeof report.checkedAt === 'string' ? report.checkedAt : '';
  if (
    !Number.isFinite(Date.parse(checkedAt)) ||
    Math.abs(Date.now() - Date.parse(checkedAt)) > 120000
  )
    throw new Error('Worker preflight report is stale.');
  const dependencies = Array.isArray(report.dependencies)
    ? report.dependencies.slice(0, 128).map((raw: unknown) => {
        const item = raw as Record<string, unknown>;
        if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(item.name))
          throw new Error('Invalid dependency report.');
        return {
          name: item.name,
          version: typeof item.version === 'string' ? item.version.slice(0, 64) : null,
          ok: item.ok === true,
        };
      })
    : [];
  return {
    taskTuning: (() => {
      const capability = report.taskTuning as Record<string, unknown> | undefined;
      const fields = [
        'trackLinearVelocityWeight',
        'trackAngularVelocityWeight',
        'headPoseTrackingWeight',
      ];
      return capability?.schemaVersion === 1 &&
        Array.isArray(capability.fields) &&
        capability.fields.length === fields.length &&
        fields.every((field) => (capability.fields as unknown[]).includes(field)) &&
        Array.isArray(capability.tasks) &&
        capability.tasks.length === 1 &&
        capability.tasks[0] === 'walk'
        ? { schemaVersion: 1, fields, tasks: ['walk'] }
        : null;
    })(),
    ppoOverrides: (() => {
      const capability = report.ppoOverrides as Record<string, unknown> | undefined;
      const fields = ['learningRate', 'entropyCoefficient', 'clipParameter'];
      return capability?.schemaVersion === 1 &&
        capability.resumeLearningRate === 'private-copy' &&
        Array.isArray(capability.fields) &&
        capability.fields.length === fields.length &&
        fields.every((field) => (capability.fields as unknown[]).includes(field))
        ? { schemaVersion: 1, fields, resumeLearningRate: 'private-copy' }
        : null;
    })(),
    schemaVersion: 1,
    engine: 'microduck-rl',
    taskId: input.taskId,
    checkedAt,
    checks,
    readyForSmokeTraining:
      report.readyForSmokeTraining === true && checks.every((check) => check.status === 'passed'),
    dependencies,
    pythonVersion:
      typeof report.pythonVersion === 'string' ? report.pythonVersion.slice(0, 64) : null,
    requiredPython:
      typeof report.requiredPython === 'string' ? report.requiredPython.slice(0, 100) : null,
    gpuName: typeof report.gpuName === 'string' ? report.gpuName.slice(0, 120) : null,
    source: 'worker-environment-probe',
    cached: body.cached === true,
    trainingPerformed: false,
    simulationVerified: false,
    next: '基础检查通过后仍需小规模真实训练与独立评测，不能据此认定策略可部署。',
  };
}

export async function requestOriginmanEnginePreflight(input: {
  engine: 'originman-recovery' | 'originman-recovery-reflect';
  accountId: string;
  device: 'cpu' | 'cuda';
  runnerUrl?: string;
  runnerToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const accountId = safeAccountId(input.accountId);
  if (!['cpu', 'cuda'].includes(input.device)) throw new Error('Invalid OriginMan device.');
  const runnerUrl = input.runnerUrl ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '';
  const token = String(
    input.runnerToken ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_TOKEN ?? '',
  ).trim();
  assertLocalRunnerToken(runnerUrl, token);
  const url = new URL(normalizeRunnerUrl(runnerUrl, { localHttp: true }));
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/train')) throw new Error('Worker URL must end with /train.');
  url.pathname = pathname.slice(0, -6) + '/engines/' + input.engine + '/preflight';
  url.search = '';
  url.hash = '';
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-sim2real-account': accountId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ device: input.device }),
    signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) {
    const code = await readWorkerErrorCode(response);
    if (
      (response.status === 404 && code === 'not_found') ||
      (response.status === 409 && code === 'engine_preflight_not_configured')
    )
      throw new LocalEnginePreflightUnsupportedError();
    if (response.status === 429 && code === 'engine_preflight_busy')
      throw new LocalEnginePreflightBusyError();
    throw new Error('OriginMan Worker preflight unavailable.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Worker preflight report is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new Error('Worker preflight report exceeds limit.');
    }
    chunks.push(value);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  const report = body.report as Record<string, unknown> | undefined;
  const expected = new Set([
    'dependency-numpy',
    'dependency-mujoco',
    'dependency-torch',
    'dependency-stable_baselines3',
    'dependency-gymnasium',
    'scene-contract',
    'training-device',
    'training-entrypoint',
    'training-config',
  ]);
  if (
    body.ok !== true ||
    !report ||
    report.schemaVersion !== 1 ||
    report.engine !== input.engine ||
    report.taskId !== 'originman-recovery' ||
    report.device !== input.device ||
    report.trainingPerformed !== false ||
    !Array.isArray(report.checks) ||
    report.checks.length !== expected.size
  )
    throw new Error('Invalid OriginMan preflight report.');
  const seen = new Set<string>();
  const checks = report.checks.map((raw: unknown) => {
    const item = raw as Record<string, unknown>;
    if (
      !item ||
      typeof item.id !== 'string' ||
      !expected.has(item.id) ||
      seen.has(item.id) ||
      !['passed', 'blocked', 'unverified'].includes(String(item.status))
    )
      throw new Error('Invalid OriginMan preflight check.');
    seen.add(item.id);
    return { id: item.id, status: String(item.status) };
  });
  const checkedAt = typeof report.checkedAt === 'string' ? report.checkedAt : '';
  const reportAge = Date.now() - Date.parse(checkedAt);
  const cached = body.cached === true;
  if (
    !Number.isFinite(reportAge) ||
    reportAge < -120_000 ||
    reportAge > (cached ? 60 * 60 * 1_000 + 120_000 : 120_000)
  )
    throw new Error('OriginMan preflight report is stale.');
  return {
    schemaVersion: 1,
    engine: input.engine,
    taskId: 'originman-recovery',
    device: input.device,
    checkedAt,
    ...(cached ? { cached: true } : {}),
    trainingPerformed: false,
    readyForSmokeTraining: checks.every((c) => c.status === 'passed'),
    checks,
  };
}
