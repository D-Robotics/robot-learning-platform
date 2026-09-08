import type {
  Sim2RealCheckpointRef,
  Sim2RealModelManifest,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealTrainingSpec,
} from '../../shared/sim2real.js';
import { SAFE_ARTIFACT_REF } from '../../shared/sim2real.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
export interface Sim2RealRobogoRunResult {
  status: 'queued' | 'running' | 'completed' | 'failed';
  externalRunId?: string;
  /** Propagated by the server-side mock worker; never implies a deployable model. */
  mock?: boolean;
  launchUrl?: string;
  message?: string;
  checkpoint?: Sim2RealCheckpointRef;
  artifact?: Sim2RealRunArtifactMetadata;
  metrics?: Sim2RealRunMetrics;
}

/**
 * Whether a runner request may have been accepted even though the caller did
 * not receive a trustworthy response.  The route uses this bit to keep an
 * idempotent reservation reconcilable instead of marking it terminal and
 * encouraging a duplicate retry.
 */
export function isSim2RealRunnerOutcomeUnknown(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { outcomeUnknown?: unknown }).outcomeUnknown === true,
  );
}

/**
 * A status lookup can deterministically prove that a previously submitted
 * runner job no longer exists.  Keep this marker separate from transport
 * failures: a missing job is terminal and must release the platform's active
 * run reservation, while a timeout/5xx remains retryable.
 */
export function isSim2RealRunnerNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { runnerNotFound?: unknown }).runnerNotFound === true,
  );
}

function runnerNotFoundError(status: number): Error {
  const error = new Error(`sim2real_robogo_runner_http_${status}`);
  Object.defineProperty(error, 'runnerNotFound', {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return error;
}

function unknownOutcomeError(error: unknown): Error {
  if (isSim2RealRunnerOutcomeUnknown(error)) return error as Error;
  const wrapped = new Error(error instanceof Error ? error.message : String(error ?? 'runner request failed'));
  wrapped.name = 'Sim2RealRunnerOutcomeUnknownError';
  wrapped.cause = error;
  Object.defineProperty(wrapped, 'outcomeUnknown', {
    value: true,
    enumerable: false,
    configurable: false,
  });
  return wrapped;
}

function isUnknownHttpOutcome(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, maxLength)
    : '';
}

function isPrivateHttpHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return true;
  const octets = host.split('.').map((item) => Number(item));
  if (
    octets.length === 4 &&
    octets.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  // RFC 1918-style private IPv6 (ULA) is acceptable for a local worker; link
  // local addresses are deliberately excluded because they are often
  // interface-specific and can be rebound unexpectedly.
  return /^fc[0-9a-f]{2}:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host);
}

export function normalizeRunnerUrl(raw: string | undefined, options: { localHttp?: boolean } = {}): string {
  const value = String(raw ?? process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!value) {
    throw new Error('sim2real_robogo_runner_not_configured');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('sim2real_robogo_runner_url_invalid');
  }
  const localHttp =
    parsed.protocol === 'http:' &&
    options.localHttp === true &&
    isPrivateHttpHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error('sim2real_robogo_runner_url_must_be_https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('sim2real_robogo_runner_url_invalid');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function runnerUrl(raw?: string): string {
  return normalizeRunnerUrl(raw);
}

export function isRobogoRunnerConfigured(raw?: string): boolean {
  try {
    runnerUrl(raw);
    return true;
  } catch {
    return false;
  }
}

export function isLocalRunnerConfigured(raw?: string): boolean {
  try {
    normalizeRunnerUrl(raw ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '', { localHttp: true });
    return true;
  } catch {
    return false;
  }
}

function sameOriginOrHttps(value: string): boolean {
  try {
    const parsed = new URL(value);
    const localHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
    return (
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && localHost))
    );
  } catch {
    return false;
  }
}

function safeToken(raw: unknown): string {
  const token = String(raw ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '');
  if (token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error('sim2real_runner_token_invalid');
  }
  return token;
}

function safeAccountId(raw: string): string {
  const accountId = String(raw ?? '').trim();
  if (!accountId || accountId.length > 160 || /[\u0000-\u001f\u007f/]/.test(accountId)) {
    throw new Error('sim2real_runner_account_invalid');
  }
  return accountId;
}

function safeIdempotencyKey(raw: unknown): string | undefined {
  if (raw == null || raw === '') return undefined;
  const key = String(raw).trim();
  if (!SAFE_IDEMPOTENCY_KEY.test(key)) throw new Error('sim2real_runner_idempotency_invalid');
  return key;
}

function boundedTimeout(raw: unknown): number {
  const value = Number(raw ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) ? Math.min(60_000, Math.max(3_000, Math.round(value))) : DEFAULT_TIMEOUT_MS;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
      throw new Error('sim2real_runner_response_too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('sim2real_runner_response_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function safeCheckpoint(value: unknown): Sim2RealCheckpointRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const checkpointId = safeText(source.checkpointId, 80);
  const artifactRef = safeText(source.artifactRef, 260);
  const rawIteration = source.iteration == null ? undefined : Number(source.iteration);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(checkpointId)) return undefined;
  if (!SAFE_ARTIFACT_REF.test(artifactRef))
    return undefined;
  if (
    rawIteration != null &&
    (!Number.isSafeInteger(rawIteration) || rawIteration < 0 || rawIteration > 2_000_000)
  )
    return undefined;
  return {
    checkpointId,
    artifactRef,
    ...(rawIteration == null ? {} : { iteration: rawIteration }),
  };
}

function safeArtifact(value: unknown): Sim2RealRunArtifactMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const artifactId = safeText(source.artifactId ?? source.id, 120);
  const artifactRef = safeText(source.artifactRef ?? source.ref, 260);
  const kind = safeText(source.kind, 16);
  const format = safeText(source.format, 16);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(artifactId)) return undefined;
  if (!SAFE_ARTIFACT_REF.test(artifactRef)) {
    return undefined;
  }
  if (kind !== 'source' && kind !== 'compiled') return undefined;
  if (!['pytorch', 'onnx', 'bin', 'hbm', 'gguf', 'unknown'].includes(format)) return undefined;
  const deployable = source.deployable === true;
  const sizeBytes = source.sizeBytes == null ? undefined : Number(source.sizeBytes);
  if (
    sizeBytes != null &&
    (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 10_000_000_000)
  ) {
    return undefined;
  }
  const threads = source.threads == null ? undefined : Number(source.threads);
  if (threads != null && (!Number.isSafeInteger(threads) || threads < 1 || threads > 128)) {
    return undefined;
  }
  const sha256 = safeText(source.sha256, 64);
  if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) return undefined;
  return {
    artifactId,
    artifactRef,
    kind: kind as Sim2RealRunArtifactMetadata['kind'],
    format: format as Sim2RealRunArtifactMetadata['format'],
    ...(safeText(source.runtime, 16)
      ? { runtime: safeText(source.runtime, 16) as Sim2RealRunArtifactMetadata['runtime'] }
      : {}),
    ...(safeText(source.workload, 24)
      ? { workload: safeText(source.workload, 24) as Sim2RealRunArtifactMetadata['workload'] }
      : {}),
    ...(threads == null ? {} : { threads }),
    ...(sha256 ? { sha256 } : {}),
    ...(sizeBytes == null ? {} : { sizeBytes }),
    deployable,
  };
}

function safeMetrics(value: unknown): Sim2RealRunMetrics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const contractValid =
    source.contractValid === true || source.contractValid === false
      ? source.contractValid
      : undefined;
  const observationSize = Number(source.observationSize);
  const actionSize = Number(source.actionSize);
  if (
    contractValid == null ||
    !Number.isSafeInteger(observationSize) ||
    observationSize < 1 ||
    observationSize > 4096 ||
    !Number.isSafeInteger(actionSize) ||
    actionSize < 1 ||
    actionSize > 4096
  )
    return undefined;
  const bounded = (key: string, min: number, max: number): number | undefined => {
    if (source[key] == null) return undefined;
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
  };
  return {
    contractValid,
    observationSize,
    actionSize,
    ...(bounded('reward', -1_000_000, 1_000_000) == null
      ? {}
      : { reward: bounded('reward', -1_000_000, 1_000_000) }),
    ...(bounded('successRate', 0, 1) == null ? {} : { successRate: bounded('successRate', 0, 1) }),
    ...(bounded('fallRate', 0, 1) == null ? {} : { fallRate: bounded('fallRate', 0, 1) }),
    ...(bounded('episodeLength', 0, 2_000_000) == null
      ? {}
      : { episodeLength: bounded('episodeLength', 0, 2_000_000) }),
    ...(bounded('controlLatencyMs', 0, 10_000) == null
      ? {}
      : { controlLatencyMs: bounded('controlLatencyMs', 0, 10_000) }),
    ...(bounded('iterations', 0, 2_000_000) == null
      ? {}
      : { iterations: bounded('iterations', 0, 2_000_000) }),
    ...(source.cuda === true ? { cuda: true } : source.cuda === false ? { cuda: false } : {}),
  };
}

function parseRunResult(payload: unknown): Sim2RealRobogoRunResult {
  const source =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const requestedStatus = safeText(source.status ?? source.state, 24).toLowerCase();
  if (!requestedStatus) throw new Error('sim2real_robogo_runner_status_invalid');
  const status =
    requestedStatus === 'queued' || requestedStatus === 'pending'
      ? 'queued'
      : requestedStatus === 'running'
      ? 'running'
      : requestedStatus === 'completed' ||
          requestedStatus === 'success' ||
          requestedStatus === 'succeeded' ||
          requestedStatus === 'done'
        ? 'completed'
        : requestedStatus === 'failed' ||
            requestedStatus === 'error' ||
            requestedStatus === 'cancelled' ||
            requestedStatus === 'canceled'
          ? 'failed'
      : null;
  if (!status) throw new Error('sim2real_robogo_runner_status_invalid');
  const launchUrlValue = safeText(source.launchUrl ?? source.url, 500);
  const launchUrl =
    launchUrlValue && sameOriginOrHttps(launchUrlValue) ? launchUrlValue : undefined;
  const externalRunId = safeText(source.externalRunId ?? source.runId ?? source.id, 120);
  const validExternalRunId =
    !externalRunId || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(externalRunId)
      ? externalRunId
      : '';
  if ((status === 'queued' || status === 'running') && !validExternalRunId) {
    throw new Error('sim2real_robogo_runner_run_id_missing');
  }
  const message =
    safeText(source.message, 500) ||
    (status === 'failed' ? '训练 runner 报告任务失败或已取消。' : '');
  const mock = source.mock === true;
  const checkpoint = safeCheckpoint(source.checkpoint);
  const artifact = safeArtifact(source.artifact);
  const metrics = safeMetrics(source.metrics);
  // Local workers report the honest device fact at the top level of the job
  // view (job.cuda), not inside metrics. Merge it in so the platform run
  // record can surface GPU usage; only an explicit boolean is trusted.
  const runnerCuda = source.cuda === true || source.cuda === false ? source.cuda : undefined;
  const metricsWithCuda =
    metrics && runnerCuda != null && metrics.cuda == null ? { ...metrics, cuda: runnerCuda } : metrics;
  return {
    status,
    ...(validExternalRunId ? { externalRunId: validExternalRunId } : {}),
    ...(mock ? { mock: true } : {}),
    ...(launchUrl ? { launchUrl } : {}),
    ...(message ? { message } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(artifact ? { artifact } : {}),
    ...(metricsWithCuda ? { metrics: metricsWithCuda } : {}),
  };
}

function runnerPayload(
  accountId: string,
  manifest: Sim2RealModelManifest,
  training?: Sim2RealTrainingSpec,
  resumeFrom?: Sim2RealCheckpointRef,
  taskId?: string,
  idempotencyKey?: string,
): Record<string, unknown> {
  return {
    accountId,
    schemaVersion: manifest.schemaVersion,
    contractId: manifest.contract.id,
    model: {
      modelId: manifest.modelId,
      displayName: manifest.displayName,
      version: manifest.version,
    },
    robot: manifest.robot,
    contract: manifest.contract,
    simulator: manifest.simulator,
    artifacts: manifest.artifacts,
    ...(taskId ? { taskId } : {}),
    ...(training ? { training } : {}),
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/**
 * Call an explicitly configured, server-side RoboGo runner.
 *
 * The runner receives only the normalized manifest and opaque managed-artifact
 * references. It never receives shell/Python/XML source and is never inferred
 * from a user supplied URL. When the adapter is not configured the caller can
 * keep the run in the visible queued/not-started state.
 */
export async function requestRobogoTraining(input: {
  accountId: string;
  requestToken?: string | null;
  manifest: Sim2RealModelManifest;
  training?: Sim2RealTrainingSpec;
  resumeFrom?: Sim2RealCheckpointRef;
  taskId?: string;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  timeoutMs?: number;
  /** Local worker mode may use an RFC1918 HTTP endpoint; RoboGo stays HTTPS-only. */
  allowPrivateHttp?: boolean;
  /** Permit the process-wide token only in a private single-user deployment. */
  allowEnvironmentToken?: boolean;
}): Promise<Sim2RealRobogoRunResult> {
  const accountId = safeAccountId(input.accountId);
  const url = normalizeRunnerUrl(input.runnerUrl, { localHttp: input.allowPrivateHttp === true });
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const token = safeToken(
    input.requestToken ||
      (input.allowEnvironmentToken ? process.env.RDK_SIM2REAL_ROBOGO_TOKEN : '') ||
      '',
  );
  const idempotencyKey = safeIdempotencyKey(input.idempotencyKey);
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          'X-Sim2Real-Account': accountId,
          'User-Agent': 'RDKStudio/1.0 (+sim2real-runner)',
        },
        body: JSON.stringify(
          runnerPayload(
            accountId,
            input.manifest,
            input.training,
            input.resumeFrom,
            input.taskId,
            idempotencyKey,
          ),
        ),
      });
    } catch (error) {
      throw unknownOutcomeError(error);
    }
    let text: string;
    try {
      text = await boundedResponseText(response);
    } catch (error) {
      // A response body that is truncated or malformed after a 2xx/5xx
      // response cannot tell us whether the runner committed the job.
      if (response.ok || isUnknownHttpOutcome(response.status)) {
        throw unknownOutcomeError(error);
      }
      throw error;
    }
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        const parseError = new Error('sim2real_robogo_runner_invalid_json:' + response.status);
        // A malformed body from a deterministic 4xx response is still a
        // rejection: the runner could not have accepted this request.  Keep
        // the reservation terminal so it does not occupy the active quota.
        // For 2xx/408/429/5xx, the body may be truncated after the runner
        // committed the job, so preserve the outcome-unknown marker.
        if (response.ok || isUnknownHttpOutcome(response.status)) {
          throw unknownOutcomeError(parseError);
        }
        throw parseError;
      }
    }
    if (!response.ok) {
      const failure = new Error('sim2real_robogo_runner_http_' + response.status);
      if (isUnknownHttpOutcome(response.status)) throw unknownOutcomeError(failure);
      throw failure;
    }
    try {
      return parseRunResult(payload);
    } catch (error) {
      // A 2xx response with an unusable body is still ambiguous: the service
      // could have committed the job before serializing its response.
      throw unknownOutcomeError(error);
    }
  } finally {
    clearTimeout(timer);
  }
}

function statusUrl(rawRunnerUrl: string, externalRunId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(externalRunId)) {
    throw new Error('sim2real_robogo_run_id_invalid');
  }
  const parsed = new URL(rawRunnerUrl);
  const pathName = parsed.pathname.replace(/\/+$/, '');
  if (pathName.endsWith('/train'))
    parsed.pathname = pathName.slice(0, -6) + '/runs/' + encodeURIComponent(externalRunId);
  else parsed.pathname = pathName + '/runs/' + encodeURIComponent(externalRunId);
  parsed.search = '';
  return parsed.toString();
}

function safeStatusOverride(raw: string, configuredRunnerUrl: string): string {
  let candidate: URL;
  let base: URL;
  try {
    candidate = new URL(raw);
    base = new URL(configuredRunnerUrl);
  } catch {
    throw new Error('sim2real_robogo_status_url_invalid');
  }
  if (
    candidate.origin !== base.origin ||
    candidate.username ||
    candidate.password ||
    candidate.search ||
    candidate.hash ||
    !sameOriginOrHttps(candidate.toString())
  ) {
    throw new Error('sim2real_robogo_status_url_invalid');
  }
  return candidate.toString();
}

/** Query a previously submitted runner job without executing anything locally. */
export async function requestRobogoTrainingStatus(input: {
  accountId: string;
  requestToken?: string | null;
  externalRunId: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  statusUrl?: string;
  timeoutMs?: number;
  allowPrivateHttp?: boolean;
  /** Permit the process-wide token only in a private single-user deployment. */
  allowEnvironmentToken?: boolean;
}): Promise<Sim2RealRobogoRunResult> {
  const accountId = safeAccountId(input.accountId);
  const configuredRunnerUrl = normalizeRunnerUrl(input.runnerUrl, {
    localHttp: input.allowPrivateHttp === true,
  });
  const url = input.statusUrl?.trim()
    ? safeStatusOverride(input.statusUrl.trim(), configuredRunnerUrl)
    : statusUrl(configuredRunnerUrl, input.externalRunId);
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const token = safeToken(
    input.requestToken ||
      (input.allowEnvironmentToken ? process.env.RDK_SIM2REAL_ROBOGO_TOKEN : '') ||
      '',
  );
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'X-Sim2Real-Account': accountId,
        'User-Agent': 'RDKStudio/1.0 (+sim2real-runner)',
      },
    });
    // A 404/410 from the runner is not a network failure: the remote job is
    // definitively gone. Consume the body best-effort, then expose a typed
    // terminal marker so the HTTP route can close the local reservation.
    if (response.status === 404 || response.status === 410) {
      await boundedResponseText(response).catch(() => undefined);
      throw runnerNotFoundError(response.status);
    }
    const text = await boundedResponseText(response);
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new Error('sim2real_robogo_runner_invalid_json:' + response.status);
      }
    }
    if (!response.ok) throw new Error('sim2real_robogo_runner_http_' + response.status);
    return parseRunResult(payload);
  } finally {
    clearTimeout(timer);
  }
}
