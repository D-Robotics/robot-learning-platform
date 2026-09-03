import type {
  Sim2RealCheckpointRef,
  Sim2RealModelManifest,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealTrainingSpec,
} from '../../shared/sim2real.js';

const DEFAULT_TIMEOUT_MS = 30_000;
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

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, maxLength)
    : '';
}

function runnerUrl(raw?: string): string {
  const value = String(raw ?? process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!value || !/^https?:\/\//i.test(value)) {
    throw new Error('sim2real_robogo_runner_not_configured');
  }
  return value;
}

export function isRobogoRunnerConfigured(raw?: string): boolean {
  try {
    runnerUrl(raw);
    return true;
  } catch {
    return false;
  }
}

function sameOriginOrHttps(value: string): boolean {
  return (
    /^https:\/\//i.test(value) ||
    /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(value)
  );
}

function safeCheckpoint(value: unknown): Sim2RealCheckpointRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const checkpointId = safeText(source.checkpointId, 80);
  const artifactRef = safeText(source.artifactRef, 260);
  const rawIteration = source.iteration == null ? undefined : Number(source.iteration);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(checkpointId)) return undefined;
  if (!/^artifact:\/\/[a-zA-Z0-9._/-]{1,240}$/.test(artifactRef) || artifactRef.includes('..'))
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
  if (!/^artifact:\/\/[a-zA-Z0-9._/-]{1,240}$/.test(artifactRef) || artifactRef.includes('..')) {
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
  };
}

function parseRunResult(payload: unknown): Sim2RealRobogoRunResult {
  const source =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const requestedStatus = safeText(source.status ?? source.state, 24).toLowerCase();
  const status =
    requestedStatus === 'running'
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
          : 'queued';
  const launchUrlValue = safeText(source.launchUrl ?? source.url, 500);
  const launchUrl =
    launchUrlValue && sameOriginOrHttps(launchUrlValue) ? launchUrlValue : undefined;
  const externalRunId = safeText(source.externalRunId ?? source.runId ?? source.id, 120);
  const message =
    safeText(source.message, 500) ||
    (status === 'failed' ? '训练 runner 报告任务失败或已取消。' : '');
  const mock = source.mock === true;
  const checkpoint = safeCheckpoint(source.checkpoint);
  const artifact = safeArtifact(source.artifact);
  const metrics = safeMetrics(source.metrics);
  return {
    status,
    ...(externalRunId ? { externalRunId } : {}),
    ...(mock ? { mock: true } : {}),
    ...(launchUrl ? { launchUrl } : {}),
    ...(message ? { message } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(artifact ? { artifact } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

function runnerPayload(
  manifest: Sim2RealModelManifest,
  training?: Sim2RealTrainingSpec,
  resumeFrom?: Sim2RealCheckpointRef,
  taskId?: string,
): Record<string, unknown> {
  return {
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
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  timeoutMs?: number;
}): Promise<Sim2RealRobogoRunResult> {
  if (!input.accountId.trim()) {
    throw new Error('sim2real_robogo_account_required');
  }
  const url = runnerUrl(input.runnerUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = Math.max(3_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = String(input.requestToken ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '');
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'User-Agent': 'RDKStudio/1.0 (+sim2real-runner)',
      },
      body: JSON.stringify(
        runnerPayload(input.manifest, input.training, input.resumeFrom, input.taskId),
      ),
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new Error('sim2real_robogo_runner_invalid_json:' + response.status);
      }
    }
    if (!response.ok) {
      throw new Error('sim2real_robogo_runner_http_' + response.status);
    }
    return parseRunResult(payload);
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

/** Query a previously submitted runner job without executing anything locally. */
export async function requestRobogoTrainingStatus(input: {
  accountId: string;
  requestToken?: string | null;
  externalRunId: string;
  fetchImpl?: typeof fetch;
  runnerUrl?: string;
  statusUrl?: string;
  timeoutMs?: number;
}): Promise<Sim2RealRobogoRunResult> {
  if (!input.accountId.trim()) throw new Error('sim2real_robogo_account_required');
  const configuredRunnerUrl = runnerUrl(input.runnerUrl);
  const url = input.statusUrl?.trim() || statusUrl(configuredRunnerUrl, input.externalRunId);
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = Math.max(3_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = String(input.requestToken ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '');
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'User-Agent': 'RDKStudio/1.0 (+sim2real-runner)',
      },
    });
    const text = await response.text();
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
