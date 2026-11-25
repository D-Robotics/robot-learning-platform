import { originmanReferenceDigest } from './originman-reference-digest.js';
import {
  isOriginmanWorkshopEngine,
  normalizeOriginmanWorkshopResult,
} from '../../shared/originman-workshop.js';
import {
  originmanReferenceCalibration,
  ORIGINMAN_REFERENCE_ENGINE,
  ORIGINMAN_REFERENCE_TASK,
  ORIGINMAN_SOURCE_STANCE,
  type OriginmanReferenceTrajectory,
} from '../../shared/originman-reference-training.js';
import type {
  Sim2RealCheckpointRef,
  Sim2RealModelManifest,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealRunProgressPoint,
  Sim2RealTaskEvaluationEvidence,
  Sim2RealTrainingSpec,
} from '../../shared/sim2real.js';
import { ORIGINMAN_DANCE_SECTION_TYPES } from '../../shared/originman-dance-training.js';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { normalizeLatencyMeasurementStage } from '../../shared/board-rehearsal.js';
import { SAFE_ARTIFACT_REF } from '../../shared/sim2real.js';
import { normalizeTaskEvaluationEvidence } from '../../shared/task-evaluation.js';
import { Sim2RealError } from './sim2real-errors.js';
import { resolveTaskPack } from '../../scripts/resolve-task-pack.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

/**
 * Resolve a declarative task pack for the runner payload, best-effort.
 *
 * The platform, not the engine, owns task/adapter resolution: when the
 * submitted taskId names a pack under tasks/, the merged spec (reward,
 * termination, curriculum, domain randomization, quality gate) is embedded
 * into the request so a worker-side engine trains the declared task instead
 * of whatever default it would pick. Unknown taskIds (RoboGo remote tasks,
 * legacy ids) are left untouched — the extra field is additive and older
 * runners ignore it.
 */
export function resolvedTaskPack(taskId?: string): Record<string, unknown> | null {
  if (!taskId || !/^[a-z][a-z0-9_-]{0,63}$/.test(taskId)) return null;
  try {
    const pack = resolveTaskPack(taskId) as unknown as Record<string, unknown>;
    return pack && typeof pack === 'object' ? pack : null;
  } catch {
    return null;
  }
}
export interface Sim2RealRobogoRunResult {
  status: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
  externalRunId?: string;
  /** Propagated by the server-side mock worker; never implies a deployable model. */
  mock?: boolean;
  launchUrl?: string;
  message?: string;
  checkpoint?: Sim2RealCheckpointRef;
  artifact?: Sim2RealRunArtifactMetadata;
  metrics?: Sim2RealRunMetrics;
  taskEvaluation?: Sim2RealTaskEvaluationEvidence;
  /** Live training curve points reported by the worker while the engine runs. */
  progress?: Sim2RealRunProgressPoint[];
  /** Bounded engine-failure diagnostics reported by local workers. */
  failureDetail?: {
    errorCode?: string;
    exitCode?: number;
    stderrTail?: string;
    stdoutTail?: string;
  };
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
  const wrapped = new Error(
    error instanceof Error ? error.message : String(error ?? 'runner request failed'),
  );
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

/**
 * A user-owned runner URL is an outbound request primitive.  HTTPS is the
 * normal transport for remote workers, but allowing a literal private target
 * would let a shared deployment probe loopback, cloud metadata, or another
 * tenant's RFC1918 service.  Keep the check literal-host based so existing
 * private HTTP/SSH-tunnel workers remain valid; operators that intentionally
 * expose a private HTTPS worker can opt it in with an exact host allowlist.
 */
function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1') return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = host.split('.').map((item) => Number(item));
    if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item))) return true;
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (ipVersion === 6) {
    return (
      host === '::' ||
      host === '::1' ||
      // WHATWG URL canonicalizes IPv4-mapped IPv6 literals to hexadecimal
      // (`::ffff:7f00:1`), so reject the whole mapped range rather than
      // attempting a second, lossy IPv4 parser here.
      host.startsWith('::ffff:') ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    );
  }
  return false;
}

function privateHttpsHostAllowed(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const configured = String(process.env.RDK_SIM2REAL_COMPUTE_ALLOW_PRIVATE_HTTPS_HOSTS ?? '');
  return configured
    .split(',')
    .map((item) =>
      item
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, ''),
    )
    .filter(Boolean)
    .some((item) => item === host);
}

export function normalizeRunnerUrl(
  raw: string | undefined,
  options: { localHttp?: boolean } = {},
): string {
  const value = String(raw ?? process.env.RDK_SIM2REAL_ROBOGO_RUNNER_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!value) {
    throw new Sim2RealError('sim2real_robogo_runner_not_configured');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Sim2RealError('sim2real_robogo_runner_url_invalid');
  }
  const localHttp =
    parsed.protocol === 'http:' && options.localHttp === true && isPrivateHttpHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Sim2RealError('sim2real_robogo_runner_url_must_be_https');
  }
  if (
    parsed.protocol === 'https:' &&
    isPrivateNetworkHost(parsed.hostname) &&
    !privateHttpsHostAllowed(parsed.hostname)
  ) {
    throw new Sim2RealError('sim2real_robogo_runner_url_invalid');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Sim2RealError('sim2real_robogo_runner_url_invalid');
  }
  return parsed.toString().replace(/\/+$/, '');
}

/** Present the existing URL policy using actionable validation errors. */
export function normalizeComputeRunnerUrl(
  value: string,
  source: 'local-agent' | 'server-runner',
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      'Runner 地址格式无效，请填写完整的 URL，例如 https://worker.example.com/train。',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Runner 地址不能包含账号、密码、查询参数或片段。请在 token 字段填写凭据。');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  let path = parsed.pathname.replace(/\/+$/, '');
  if (source === 'local-agent') {
    if (!loopback)
      throw new Error('本地 Agent 必须使用回环地址，例如 http://127.0.0.1:19091/proxy/train。');
    if (path === '/proxy') path = '/proxy/train';
    if (path !== '/proxy/train') throw new Error('本地 Agent 的路径必须为 /proxy/train。');
  } else {
    if (
      parsed.protocol === 'https:' &&
      isPrivateNetworkHost(host) &&
      !privateHttpsHostAllowed(host)
    )
      throw new Error(
        '服务端 Worker 不允许使用未获准的回环、私网或保留地址。请使用公网 HTTPS 域名。',
      );
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isPrivateHttpHost(host)))
      throw new Error('公网 Worker 必须使用 HTTPS。受支持的本地 Worker 才可使用 HTTP。');
    if (!path.endsWith('/train'))
      throw new Error('Runner 地址的路径必须以 /train 结尾，例如 /worker/train。');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('Runner 地址必须使用 HTTPS 或受支持的本地 HTTP。');
  if (parsed.protocol === 'https:' && isPrivateNetworkHost(host) && !privateHttpsHostAllowed(host))
    throw new Error(
      '此 HTTPS 回环地址没有配置允许项。请使用本地 Agent 的 HTTP /proxy/train 地址。',
    );
  parsed.pathname = path;
  return normalizeRunnerUrl(parsed.href, { localHttp: true });
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
    throw new Sim2RealError('sim2real_runner_token_invalid');
  }
  return token;
}

export function safeAccountId(raw: string): string {
  const accountId = String(raw ?? '').trim();
  if (!accountId || accountId.length > 160 || /[\u0000-\u001f\u007f/]/.test(accountId)) {
    throw new Sim2RealError('sim2real_runner_account_invalid');
  }
  return accountId;
}

function safeIdempotencyKey(raw: unknown): string | undefined {
  if (raw == null || raw === '') return undefined;
  const key = String(raw).trim();
  if (!SAFE_IDEMPOTENCY_KEY.test(key))
    throw new Sim2RealError('sim2real_runner_idempotency_invalid');
  return key;
}

function boundedTimeout(raw: unknown): number {
  const value = Number(raw ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value)
    ? Math.min(60_000, Math.max(3_000, Math.round(value)))
    : DEFAULT_TIMEOUT_MS;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredRaw = response.headers.get('content-length');
  if (declaredRaw != null && declaredRaw.trim() !== '') {
    const normalized = declaredRaw.trim();
    if (!/^\d+$/.test(normalized)) {
      throw new Sim2RealError('sim2real_runner_response_too_large');
    }
    const declared = Number(normalized);
    if (!Number.isSafeInteger(declared) || declared > MAX_RESPONSE_BYTES) {
      throw new Sim2RealError('sim2real_runner_response_too_large');
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
      throw new Sim2RealError('sim2real_runner_response_too_large');
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
        throw new Sim2RealError('sim2real_runner_response_too_large');
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
  if (!SAFE_ARTIFACT_REF.test(artifactRef)) return undefined;
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

/** Bounded `{library: version}` map from an untrusted engine result. */
function dependencyVersions(value: unknown): { dependencyVersions: Record<string, string> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized: Record<string, string> = {};
  for (const [name, version] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name)) continue;
    if (typeof version !== 'string' || !/^[0-9][0-9a-z.+-]{0,31}$/i.test(version)) continue;
    normalized[name] = version;
  }
  return Object.keys(normalized).length ? { dependencyVersions: normalized } : null;
}

function safeDanceMetrics(value: unknown): Sim2RealRunMetrics['originmanDance'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const asRecord = (item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};
  const digest = (item: unknown): item is string =>
    typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  const replay = asRecord(source.replay);
  const video = asRecord(source.video);
  const evaluations = (
    Array.isArray(source.evaluations) ? source.evaluations.slice(0, 3) : []
  ).flatMap((item) => {
    const row = asRecord(item);
    if (typeof row.bpm !== 'number' || !Number.isFinite(row.bpm) || row.bpm < 80 || row.bpm > 140)
      return [];
    const sections = (Array.isArray(row.sections) ? row.sections.slice(0, 8) : []).flatMap(
      (entry) => {
        const section = asRecord(entry);
        if (
          typeof section.type !== 'string' ||
          !ORIGINMAN_DANCE_SECTION_TYPES.some((type) => type === section.type)
        )
          return [];
        const measurements = Object.fromEntries(
          Object.entries(asRecord(section.measurements))
            .slice(0, 40)
            .filter(
              ([key, n]) =>
                /^[a-z][a-z0-9]{0,63}$/i.test(key) && typeof n === 'number' && Number.isFinite(n),
            ),
        ) as Record<string, number>;
        return [
          {
            type: section.type,
            ...(typeof section.passed === 'boolean' ? { passed: section.passed } : {}),
            ...(typeof section.clean === 'boolean' ? { clean: section.clean } : {}),
            ...(typeof section.stylePassed === 'boolean'
              ? { stylePassed: section.stylePassed }
              : {}),
            measurements,
          },
        ];
      },
    );
    return [{ bpm: row.bpm, sections }];
  });
  return {
    evaluations,
    ...(typeof source.qualityGatePassed === 'boolean'
      ? { qualityGatePassed: source.qualityGatePassed }
      : {}),
    ...(digest(replay.sha256) ? { replay: { sha256: replay.sha256 } } : {}),
    ...(video.file === 'dance-replay.mp4' &&
    digest(video.sha256) &&
    digest(video.policySha256) &&
    digest(video.sourceReplaySha256) &&
    video.sourceReplaySha256 === replay.sha256 &&
    typeof video.sizeBytes === 'number' &&
    Number.isSafeInteger(video.sizeBytes) &&
    video.sizeBytes > 0 &&
    video.sizeBytes <= 50 * 1024 * 1024
      ? {
          video: {
            file: 'dance-replay.mp4' as const,
            sha256: video.sha256,
            sizeBytes: video.sizeBytes,
            policySha256: video.policySha256,
            sourceReplaySha256: video.sourceReplaySha256,
          },
        }
      : {}),
  };
}

function safeReferenceSections(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 90) return undefined;
  const rows: NonNullable<NonNullable<Sim2RealRunMetrics['originmanReference']>['sections']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const { id, framesExpected, framesEvaluated, completed } = item;
    if (
      typeof id !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ||
      !Number.isSafeInteger(framesExpected) ||
      framesExpected < 50 ||
      framesExpected > 4500 ||
      !Number.isSafeInteger(framesEvaluated) ||
      framesEvaluated < 0 ||
      framesEvaluated > framesExpected ||
      typeof completed !== 'boolean'
    )
      return undefined;
    const row: (typeof rows)[number] = {
      id,
      framesExpected,
      framesEvaluated,
      completed: completed && framesEvaluated === framesExpected,
    };
    for (const [key, maximum] of [
      ['trackingRmseRad', 20],
      ['maxTiltDeg', 180],
      ['squatDescentM', 10],
    ] as const) {
      const metric = item[key];
      if (typeof metric === 'number' && Number.isFinite(metric) && metric >= 0 && metric <= maximum)
        row[key] = metric;
    }
    rows.push(row);
  }
  return rows;
}

function safeReferenceMetrics(value: unknown): Sim2RealRunMetrics['originmanReference'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { replay, video: safeVideo } = safeDanceMetrics(value) ?? {};
  const rawVideo = (value as Record<string, unknown>).video as Record<string, unknown> | undefined;
  const video =
    safeVideo &&
    rawVideo?.fps === 50 &&
    typeof rawVideo.durationSeconds === 'number' &&
    Number.isFinite(rawVideo.durationSeconds) &&
    rawVideo.durationSeconds > 0 &&
    rawVideo.durationSeconds <= 241
      ? { ...safeVideo, fps: rawVideo.fps, durationSeconds: rawVideo.durationSeconds }
      : undefined;
  const limits = originmanReferenceCalibration.evaluation;
  const {
    framesExpected,
    framesEvaluated,
    trackingMaeRad,
    trackingRmseRad,
    zeroResidualRmseRad,
    zeroResidualFramesEvaluated,
    trajectorySha256,
    onnxMaxAbsError,
    sections: rawSections,
    maxTiltDeg,
    finalYawDeg,
    qualityGatePassed,
    referenceSha256,
    sceneSha256,
    stanceProfile,
    calibrationSha256,
    checkpointEvaluations,
  } = value as Record<string, unknown>;
  if (
    typeof framesExpected !== 'number' ||
    !Number.isSafeInteger(framesExpected) ||
    typeof framesEvaluated !== 'number' ||
    !Number.isSafeInteger(framesEvaluated) ||
    framesExpected < 50 ||
    framesExpected > 12_000 ||
    framesEvaluated < 1 ||
    framesEvaluated > framesExpected ||
    typeof trackingMaeRad !== 'number' ||
    !Number.isFinite(trackingMaeRad) ||
    trackingMaeRad < 0 ||
    typeof maxTiltDeg !== 'number' ||
    !Number.isFinite(maxTiltDeg) ||
    maxTiltDeg < 0 ||
    maxTiltDeg > 180 ||
    typeof finalYawDeg !== 'number' ||
    !Number.isFinite(finalYawDeg) ||
    Math.abs(finalYawDeg) > 180 ||
    typeof qualityGatePassed !== 'boolean' ||
    typeof referenceSha256 !== 'string' ||
    typeof sceneSha256 !== 'string' ||
    ![referenceSha256, sceneSha256].every((digest) => /^[a-f0-9]{64}$/.test(digest))
  )
    return undefined;
  const sections = safeReferenceSections(rawSections);
  return {
    framesExpected,
    framesEvaluated,
    trackingMaeRad,
    ...(typeof trackingRmseRad === 'number' &&
      Number.isFinite(trackingRmseRad) &&
      trackingRmseRad >= 0 &&
      trackingRmseRad <= 20 && { trackingRmseRad }),
    ...(typeof onnxMaxAbsError === 'number' &&
      Number.isFinite(onnxMaxAbsError) &&
      onnxMaxAbsError >= 0 &&
      onnxMaxAbsError < 1e-6 && { onnxMaxAbsError }),
    ...(typeof trajectorySha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(trajectorySha256) && { trajectorySha256 }),
    ...(typeof zeroResidualRmseRad === 'number' &&
      Number.isFinite(zeroResidualRmseRad) &&
      zeroResidualRmseRad >= 0 &&
      zeroResidualRmseRad <= 20 &&
      typeof zeroResidualFramesEvaluated === 'number' &&
      Number.isSafeInteger(zeroResidualFramesEvaluated) &&
      zeroResidualFramesEvaluated > 0 &&
      zeroResidualFramesEvaluated <= framesExpected && {
        zeroResidualRmseRad,
        zeroResidualFramesEvaluated,
      }),
    ...(sections && { sections }),
    maxTiltDeg,
    finalYawDeg,
    qualityGatePassed:
      qualityGatePassed &&
      framesEvaluated === framesExpected &&
      maxTiltDeg < limits.maxTiltDeg &&
      Math.abs(finalYawDeg) < limits.maxAbsFinalYawDeg,
    referenceSha256,
    sceneSha256,
    ...(stanceProfile === ORIGINMAN_SOURCE_STANCE &&
      typeof calibrationSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(calibrationSha256) && { stanceProfile, calibrationSha256 }),
    ...(typeof checkpointEvaluations === 'number' &&
    Number.isSafeInteger(checkpointEvaluations) &&
    checkpointEvaluations >= 1 &&
    checkpointEvaluations <= 64
      ? { checkpointEvaluations }
      : {}),
    ...(replay && { replay }),
    ...(video && { video }),
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
  // Engine self-labeling (which physics trained the policy, which engine
  // produced the run) — bounded to a safe identifier charset so a hostile
  // worker cannot smuggle markup through the ledger/UI path.
  const safeLabel = (key: string): string | undefined => {
    const value = source[key];
    if (value == null) return undefined;
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)
      ? value
      : undefined;
  };
  const physicsBackend = safeLabel('physicsBackend');
  const engine = safeLabel('engine');
  const trainingDevice =
    typeof source.trainingDevice === 'string' &&
    /^(cpu|mps|cuda(:[0-9]{1,3})?)$/.test(source.trainingDevice)
      ? source.trainingDevice
      : undefined;
  const deviceName =
    typeof source.trainingDeviceName === 'string' ? source.trainingDeviceName.trim() : '';
  const trainingDeviceName =
    trainingDevice && /^[a-zA-Z0-9][a-zA-Z0-9 ._()+-]{0,95}$/.test(deviceName)
      ? deviceName
      : undefined;
  const workshop = isOriginmanWorkshopEngine(engine)
    ? normalizeOriginmanWorkshopResult(source.originmanWorkshop)
    : undefined;
  const originmanDance =
    engine === 'originman-dance-ppo' ? safeDanceMetrics(source.originmanDance) : undefined;
  return {
    contractValid,
    observationSize,
    actionSize,
    ...(bounded('reward', -1_000_000, 1_000_000) == null
      ? {}
      : { reward: bounded('reward', -1_000_000, 1_000_000) }),
    ...(bounded('successRate', 0, 1) == null ? {} : { successRate: bounded('successRate', 0, 1) }),
    ...(bounded('evaluationEpisodes', 1, 2_000_000) == null
      ? {}
      : { evaluationEpisodes: Math.floor(bounded('evaluationEpisodes', 1, 2_000_000) as number) }),
    ...(bounded('meanReturn', -1_000_000, 1_000_000) == null
      ? {}
      : { meanReturn: bounded('meanReturn', -1_000_000, 1_000_000) }),
    ...(bounded('fallRate', 0, 1) == null ? {} : { fallRate: bounded('fallRate', 0, 1) }),
    ...(bounded('episodeLength', 0, 2_000_000) == null
      ? {}
      : { episodeLength: bounded('episodeLength', 0, 2_000_000) }),
    ...(bounded('controlLatencyMs', 0, 10_000) == null
      ? {}
      : { controlLatencyMs: bounded('controlLatencyMs', 0, 10_000) }),
    // A latency figure without a declared stage is reported as "unknown" rather
    // than silently presented as a control-loop budget.
    ...(source.measurementStage === undefined
      ? {}
      : { measurementStage: normalizeLatencyMeasurementStage(source.measurementStage) }),
    // Source provenance is an audit field, so a malformed value is dropped
    // rather than displayed as if it identified a revision.
    ...(typeof source.sourceCommit === 'string' && /^[a-f0-9]{40}$/i.test(source.sourceCommit)
      ? { sourceCommit: source.sourceCommit.toLowerCase() }
      : {}),
    // Library versions are an untrusted boundary like any other: keep only
    // plausible names and concrete versions, capped in count and length.
    ...(dependencyVersions(source.dependencyVersions) ?? {}),
    ...(bounded('iterations', 0, 2_000_000) == null
      ? {}
      : { iterations: bounded('iterations', 0, 2_000_000) }),
    ...(physicsBackend == null ? {} : { physicsBackend }),
    ...(engine == null ? {} : { engine }),
    ...(workshop ? { originmanWorkshop: workshop } : {}),
    ...(originmanDance ? { originmanDance } : {}),
    ...(engine === ORIGINMAN_REFERENCE_ENGINE
      ? { originmanReference: safeReferenceMetrics(source.originmanReference) }
      : {}),
    ...(bounded('trainingSteps', 1, 10_000_000) == null
      ? {}
      : { trainingSteps: bounded('trainingSteps', 1, 10_000_000) }),
    ...(trainingDevice ? { trainingDevice } : {}),
    ...(trainingDeviceName ? { trainingDeviceName } : {}),
    ...(bounded('trainChunkMse', 0, 1_000_000) == null
      ? {}
      : { trainChunkMse: bounded('trainChunkMse', 0, 1_000_000) }),
    ...(bounded('validationChunkMse', 0, 1_000_000) == null
      ? {}
      : { validationChunkMse: bounded('validationChunkMse', 0, 1_000_000) }),
    ...(typeof source.demonstrationSourceRunId === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(source.demonstrationSourceRunId)
      ? { demonstrationSourceRunId: source.demonstrationSourceRunId }
      : {}),
    ...(typeof source.demonstrationSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(source.demonstrationSha256)
      ? { demonstrationSha256: source.demonstrationSha256 }
      : {}),
    ...(typeof source.syntheticData === 'boolean' ? { syntheticData: source.syntheticData } : {}),
    ...(source.cuda === true ? { cuda: true } : source.cuda === false ? { cuda: false } : {}),
  };
}

function safeProgressPoints(value: unknown): Sim2RealRunProgressPoint[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const points: Sim2RealRunProgressPoint[] = [];
  let lastIteration = 0;
  for (const entry of value.slice(0, 512)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const point = entry as Record<string, unknown>;
    const iteration = Number(point.iteration);
    const totalIterations = Number(point.totalIterations);
    const meanReward = Number(point.meanReward);
    const recentSuccess = Number(point.recentSuccess);
    if (
      !Number.isSafeInteger(iteration) ||
      iteration < 1 ||
      iteration <= lastIteration ||
      !Number.isSafeInteger(totalIterations) ||
      totalIterations < 1 ||
      !Number.isFinite(meanReward) ||
      !Number.isFinite(recentSuccess)
    ) {
      continue;
    }
    lastIteration = iteration;
    const elapsedSeconds = Number(point.elapsedSeconds);
    const samples = Number(point.episodeSamples);
    const at = safeText(point.at, 40);
    points.push({
      iteration,
      totalIterations,
      meanReward,
      recentSuccess,
      ...(Number.isSafeInteger(samples) &&
        samples >= 0 &&
        samples <= 50 && { episodeSamples: samples }),
      ...(Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0 ? { elapsedSeconds } : {}),
      ...(at ? { at } : {}),
    });
  }
  return points.length ? points : undefined;
}

function parseRunResult(payload: unknown): Sim2RealRobogoRunResult {
  const source =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const requestedStatus = safeText(source.status ?? source.state, 24).toLowerCase();
  if (!requestedStatus) throw new Sim2RealError('sim2real_robogo_runner_status_invalid');
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
          : requestedStatus === 'cancelled' || requestedStatus === 'canceled'
            ? 'cancelled'
            : requestedStatus === 'cancelling' || requestedStatus === 'canceling'
              ? 'cancelling'
              : requestedStatus === 'failed' || requestedStatus === 'error'
                ? 'failed'
                : null;
  if (!status) throw new Sim2RealError('sim2real_robogo_runner_status_invalid');
  const launchUrlValue = safeText(source.launchUrl ?? source.url, 500);
  const launchUrl =
    launchUrlValue && sameOriginOrHttps(launchUrlValue) ? launchUrlValue : undefined;
  const externalRunId = safeText(source.externalRunId ?? source.runId ?? source.id, 120);
  const validExternalRunId =
    !externalRunId || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(externalRunId) ? externalRunId : '';
  if (
    (status === 'queued' || status === 'running' || status === 'cancelling') &&
    !validExternalRunId
  ) {
    throw new Sim2RealError('sim2real_robogo_runner_run_id_missing');
  }
  const message =
    safeText(source.message, 500) ||
    (status === 'failed' ? '训练 runner 报告任务失败或已取消。' : '');
  const mock = typeof source.mock === 'boolean' ? source.mock : undefined;
  const checkpoint = safeCheckpoint(source.checkpoint);
  const artifact = safeArtifact(source.artifact);
  const metrics = safeMetrics(source.metrics);
  const taskEvaluation = normalizeTaskEvaluationEvidence(source.taskEvaluation);
  // Live progress points: local workers parse engine stdout while running and
  // expose a bounded array. Only strictly-advancing, numerically sane points
  // pass; anything else is dropped so a hostile runner cannot bloat the run
  // record or the status response.
  const progress = safeProgressPoints(source.progress);
  const failureDetail = safeFailureDetail(source);
  // Local workers report the honest device fact at the top level of the job
  // view (job.cuda), not inside metrics. Merge it in so the platform run
  // record can surface GPU usage; only an explicit boolean is trusted.
  const runnerCuda = source.cuda === true || source.cuda === false ? source.cuda : undefined;
  const metricsWithCuda =
    metrics && runnerCuda != null && metrics.cuda == null
      ? { ...metrics, cuda: runnerCuda }
      : metrics;
  return {
    status,
    ...(validExternalRunId ? { externalRunId: validExternalRunId } : {}),
    ...(mock !== undefined ? { mock } : {}),
    ...(launchUrl ? { launchUrl } : {}),
    ...(message ? { message } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(artifact ? { artifact } : {}),
    ...(metricsWithCuda ? { metrics: metricsWithCuda } : {}),
    ...(taskEvaluation ? { taskEvaluation } : {}),
    ...(progress ? { progress } : {}),
    ...(failureDetail ? { failureDetail } : {}),
  };
}

/**
 * Bounded failure diagnostics from a local worker job view. The worker's own
 * scrubLog already caps the tails; re-clamp here so a hostile or buggy runner
 * cannot bloat the run record, and only an explicit integer exit code passes.
 */
function safeFailureDetail(
  source: Record<string, unknown>,
): Sim2RealRobogoRunResult['failureDetail'] {
  const errorCode = safeText(source.errorCode, 80) || undefined;
  const exitCodeRaw = source.exitCode;
  const exitCode =
    typeof exitCodeRaw === 'number' && Number.isSafeInteger(exitCodeRaw) ? exitCodeRaw : undefined;
  const stderrTail = safeText(source.stderrTail, 2000) || undefined;
  const stdoutTail = safeText(source.stdoutTail, 2000) || undefined;
  if (errorCode === undefined && exitCode === undefined && !stderrTail && !stdoutTail) {
    return undefined;
  }
  return {
    ...(errorCode ? { errorCode } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(stderrTail ? { stderrTail } : {}),
    ...(stdoutTail ? { stdoutTail } : {}),
  };
}

function runnerPayload(
  accountId: string,
  manifest: Sim2RealModelManifest,
  training?: Sim2RealTrainingSpec,
  resumeFrom?: Sim2RealCheckpointRef,
  taskId?: string,
  idempotencyKey?: string,
  demonstrations?: import('../../shared/sim2real.js').Sim2RealDemonstrations,
): Record<string, unknown> {
  let workerTraining = training;
  if (training?.originmanDance?.compositionMode) {
    // The composition mode is for the workbench and ledger. Existing workers consume the original recipe schema.
    const { compositionMode, ...originmanDance } = training.originmanDance;
    workerTraining = { ...training, originmanDance };
  }
  const task =
    taskId === 'originman-dance' && workerTraining?.originmanDance
      ? { id: taskId, originmanDance: workerTraining.originmanDance }
      : taskId === ORIGINMAN_REFERENCE_TASK
        ? { id: taskId }
        : resolvedTaskPack(taskId);
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
    ...(task ? { task } : {}),
    ...(workerTraining ? { training: workerTraining } : {}),
    ...(demonstrations ? { demonstrations } : {}),
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
  demonstrations?: import('../../shared/sim2real.js').Sim2RealDemonstrations;
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
          ...(input.allowPrivateHttp === true &&
          input.taskId === ORIGINMAN_REFERENCE_TASK &&
          input.training?.engine === ORIGINMAN_REFERENCE_ENGINE
            ? { 'X-RDK-Reference-Trajectory': '1' }
            : {}),
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
            input.demonstrations,
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

function referenceFailure(value: unknown) {
  const entry = value as Partial<{
    nonFootContacts: unknown;
    tilt: { actualDeg: number; limitDeg: number };
    height: { actualM: number; limitM: number };
  }> | null;
  if (!entry || typeof entry !== 'object') return undefined;
  const names = entry.nonFootContacts;
  const nonFootContacts =
    Array.isArray(names) &&
    names.length > 0 &&
    names.length <= 64 &&
    names.every((name) => typeof name === 'string' && /^[\w.-]{1,80}$/.test(name))
      ? (names as string[])
      : undefined;
  const { tilt, height } = entry;
  return {
    ...(nonFootContacts && { nonFootContacts }),
    ...(tilt &&
      [tilt.actualDeg, tilt.limitDeg].every((n) => Number.isFinite(n) && n >= 0 && n <= 180) &&
      tilt.actualDeg >= tilt.limitDeg && {
        tilt: { actualDeg: tilt.actualDeg, limitDeg: tilt.limitDeg },
      }),
    ...(height &&
      [height.actualM, height.limitM].every((n) => Number.isFinite(n) && Math.abs(n) <= 10) &&
      height.actualM < height.limitM && {
        height: { actualM: height.actualM, limitM: height.limitM },
      }),
  };
}

export async function screenOriginmanReferenceWithWorker(input: {
  runnerUrl: string;
  token?: string;
  accountId: string;
  trajectory: OriginmanReferenceTrajectory;
  stanceProfile?: typeof ORIGINMAN_SOURCE_STANCE;
}) {
  const url = new URL(normalizeComputeRunnerUrl(input.runnerUrl, 'server-runner'));
  url.pathname = url.pathname.slice(0, -'/train'.length) + '/originman-reference/screen';
  const token = safeToken(input.token);
  const serialized = JSON.stringify({
    ...input.trajectory,
    ...(input.stanceProfile && { stanceProfile: input.stanceProfile }),
  });
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(50_000),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Sim2Real-Account': safeAccountId(input.accountId),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: serialized,
  });
  const report = JSON.parse(await boundedResponseText(response));
  if (response.status === 409) return { busy: true } as const;
  if (!response.ok || report?.ok !== true) throw Error('reference screen unavailable');
  const referenceSha256 = createHash('sha256').update(serialized).digest('hex');
  if (report.referenceSha256 !== referenceSha256) throw Error('invalid reference screen receipt');
  if (input.stanceProfile && report.stanceProfile !== input.stanceProfile)
    return { unsupportedStance: true } as const;
  const stance = input.stanceProfile ? { stanceProfile: input.stanceProfile } : {};
  if (typeof report.invalid === 'string') {
    const violation = report.violation;
    const validViolation =
      violation &&
      input.trajectory.joint_names.includes(violation.joint) &&
      Number.isSafeInteger(violation.frame) &&
      violation.frame >= 1 &&
      violation.frame <= input.trajectory.joint_pos.length &&
      Number.isSafeInteger(violation.framesOutside) &&
      violation.framesOutside >= 1 &&
      violation.framesOutside <= input.trajectory.joint_pos.length &&
      [violation.targetRad, violation.minRad, violation.maxRad].every(
        (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 100,
      ) &&
      violation.minRad <= violation.maxRad;
    return {
      ...stance,
      invalid: safeText(report.invalid, 300),
      ...(validViolation && {
        violation: {
          joint: String(violation.joint),
          frame: Number(violation.frame),
          framesOutside: Number(violation.framesOutside),
          targetRad: Number(violation.targetRad),
          minRad: Number(violation.minRad),
          maxRad: Number(violation.maxRad),
        },
      }),
    };
  }
  const trajectorySha256 = originmanReferenceDigest(input.trajectory);
  const gate = report.gate;
  if (
    (report.trajectorySha256 !== undefined && report.trajectorySha256 !== trajectorySha256) ||
    !/^[a-f0-9]{64}$/.test(report.sceneSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(report.calibrationSha256 ?? '') ||
    gate?.framesExpected !== input.trajectory.joint_pos.length ||
    !Number.isSafeInteger(gate.framesEvaluated) ||
    gate.framesEvaluated < 1 ||
    gate.framesEvaluated > gate.framesExpected ||
    typeof gate.maxTiltDeg !== 'number' ||
    !Number.isFinite(gate.maxTiltDeg) ||
    gate.maxTiltDeg < 0 ||
    gate.maxTiltDeg > 180 ||
    typeof gate.completed !== 'boolean' ||
    (gate.completed
      ? gate.firstFailedFrame !== null
      : gate.firstFailedFrame !== gate.framesEvaluated)
  ) {
    throw Error('invalid reference screen receipt');
  }
  return {
    ...stance,
    referenceSha256,
    trajectorySha256,
    sceneSha256: String(report.sceneSha256),
    calibrationSha256: String(report.calibrationSha256),
    framesExpected: Number(gate.framesExpected),
    framesEvaluated: Number(gate.framesEvaluated),
    maxTiltDeg: Number(gate.maxTiltDeg),
    firstFailedFrame: gate.completed ? null : Number(gate.firstFailedFrame),
    ...(!gate.completed && { failure: referenceFailure(gate.failure) }),
    passed:
      gate.completed &&
      gate.framesEvaluated === gate.framesExpected &&
      gate.maxTiltDeg < originmanReferenceCalibration.evaluation.maxTiltDeg,
  };
}

function statusUrl(rawRunnerUrl: string, externalRunId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(externalRunId)) {
    throw new Sim2RealError('sim2real_robogo_run_id_invalid');
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
    throw new Sim2RealError('sim2real_robogo_status_url_invalid');
  }
  if (
    candidate.origin !== base.origin ||
    candidate.username ||
    candidate.password ||
    candidate.search ||
    candidate.hash ||
    !sameOriginOrHttps(candidate.toString())
  ) {
    throw new Sim2RealError('sim2real_robogo_status_url_invalid');
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
  operation?: 'cancel';
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
    const response = await fetchImpl(input.operation === 'cancel' ? url + '/cancel' : url, {
      method: input.operation === 'cancel' ? 'POST' : 'GET',
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
