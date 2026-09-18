import { createHash, randomUUID } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type {
  Sim2RealDeploymentEventType,
  Sim2RealDeploymentApprovalStatus,
  Sim2RealDeploymentRecord,
  Sim2RealEvaluationSummary,
  Sim2RealEvaluationRecord,
  Sim2RealArtifactRecord,
  Sim2RealArtifactLifecycleStatus,
  Sim2RealModelManifest,
  Sim2RealModelRecord,
  Sim2RealProjectRecord,
  Sim2RealDatasetRecord,
  Sim2RealDatasetStatus,
  Sim2RealComputeResource,
  Sim2RealRunRecord,
  Sim2RealRunStatus,
  Sim2RealTelemetryRecord,
  Sim2RealEvaluationStatus,
} from '../../shared/sim2real.js';
import { BUILTIN_MICRODUCK_MODEL, BUILTIN_ORIGINBOT_MODEL } from '../../shared/sim2real.js';
import { Sim2RealError } from './sim2real-errors.js';
import { emitSim2RealEvent } from './sim2real-events.js';
import {
  appendSim2RealFeedback,
  isSim2RealFeedbackRecord,
  listSim2RealFeedback,
  summarizeSim2RealFeedback,
  type Sim2RealFeedbackRecord,
} from './workspace-feedback.js';
import { redactInternalError } from './http-helpers.js';
import { validateRunForDeployment } from './release-evidence.js';
import { isWebCloudDeployment, resolveDataDir } from './standalone-adapters.js';
import { acquireStorageLease } from './storage-lease.js';

const LEDGER_VERSION = 1 as const;
const MODEL_CAP = 100;
// Keep a longer server-side run ledger so an old idempotency key cannot
// unexpectedly launch a second billable job after the UI list is trimmed.
const RUN_CAP = 10_000;
const PUBLIC_RUN_LIST_CAP = 200;
const DEPLOYMENT_CAP = 200;
const PROJECT_CAP = 100;
const DATASET_CAP = 500;
const ARTIFACT_CAP = 2_000;
const EVALUATION_CAP = 2_000;
// Granular user feedback (G15): small, bounded, FIFO-trimmed in the ledger.
const FEEDBACK_CAP = 500;
export const DEFAULT_ACTIVE_RUN_CAP = 4;
// A reservation that never receives a runner id (for example, a process
// crash between submit and ledger update) must not occupy an account slot
// forever. Keep the default generous enough for long local jobs; operators
// can tune it for their worker SLA within a bounded range.
export const DEFAULT_ACTIVE_RUN_TTL_SECONDS = 24 * 60 * 60;
export const MIN_ACTIVE_RUN_TTL_SECONDS = 5 * 60;
export const MAX_ACTIVE_RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A worker health result is a lease for a bounded period, never a permanent fact. */
export const DEFAULT_COMPUTE_HEALTH_TTL_SECONDS = 10 * 60;
export const MIN_COMPUTE_HEALTH_TTL_SECONDS = 30;
export const MAX_COMPUTE_HEALTH_TTL_SECONDS = 24 * 60 * 60;
/** JSON ledger guard for the single-instance MVP store. */
export const SIM2REAL_LEDGER_MAX_BYTES = 768 * 1024 * 1024;
const READINESS_CACHE_TTL_MS = 5_000;
// Keep an explicit ledger guard, but reject once it is reached. Never trim
// accepted telemetry silently: replay/evaluation must either see the whole
// accepted history or receive a clear quota error.
export const SIM2REAL_TELEMETRY_RECORD_CAP = 100_000;
// A JSON ledger is intentionally a single-instance MVP store. Bound both
// sample count and serialized bytes so one tenant cannot grow a run (or the
// whole account ledger) without limit through many individually valid chunks.
export const SIM2REAL_TELEMETRY_LIMITS = Object.freeze({
  runSamples: 100_000,
  runBytes: 128 * 1024 * 1024,
  ownerSamples: 500_000,
  ownerBytes: 512 * 1024 * 1024,
});

/**
 * Billable/local runner launches are deliberately bounded per owner.  The
 * limit is configurable for a deployment, but malformed values fall back to
 * a small safe default instead of disabling the guard accidentally.
 */
export function sim2RealActiveRunLimit(): number {
  const raw = String(process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS ?? '').trim();
  if (!raw) return DEFAULT_ACTIVE_RUN_CAP;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : DEFAULT_ACTIVE_RUN_CAP;
}

export function sim2RealActiveRunTtlSeconds(): number {
  const raw = String(process.env.RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS ?? '').trim();
  if (!raw) return DEFAULT_ACTIVE_RUN_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed >= MIN_ACTIVE_RUN_TTL_SECONDS &&
    parsed <= MAX_ACTIVE_RUN_TTL_SECONDS
    ? parsed
    : DEFAULT_ACTIVE_RUN_TTL_SECONDS;
}

/**
 * Maximum age of a successful GPU worker health probe. Invalid values fall
 * back to the safe default rather than disabling the freshness gate.
 */
export function sim2RealComputeHealthTtlSeconds(): number {
  const raw = String(process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS ?? '').trim();
  if (!raw) return DEFAULT_COMPUTE_HEALTH_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed >= MIN_COMPUTE_HEALTH_TTL_SECONDS &&
    parsed <= MAX_COMPUTE_HEALTH_TTL_SECONDS
    ? parsed
    : DEFAULT_COMPUTE_HEALTH_TTL_SECONDS;
}

/** Whether an account-owned worker has a recent, successful health lease. */
export function isSim2RealComputeResourceHealthFresh(
  resource: Pick<Sim2RealComputeResource, 'status' | 'lastCheckedAt'>,
  nowMs = Date.now(),
): boolean {
  if (resource.status !== 'online' || !resource.lastCheckedAt) return false;
  const checkedAtMs = Date.parse(resource.lastCheckedAt);
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > nowMs) return false;
  return nowMs - checkedAtMs <= sim2RealComputeHealthTtlSeconds() * 1_000;
}

/** Hard upper bound for the retention window: ten years, in days. */
export const MAX_SIM2REAL_TELEMETRY_RETENTION_DAYS = 3_650;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
let retentionWarningLogged = false;

/**
 * Telemetry retention window in days. `0` disables pruning entirely and is the
 * default, so existing deployments keep every accepted chunk. A non-finite,
 * non-integer, non-positive or absurdly large value is also treated as `0`.
 * Malformed input is reported once instead of throwing: retention is an
 * operator policy and must never turn a normal ingest into a request error.
 */
export function sim2RealTelemetryRetentionDays(): number {
  const raw = String(process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS ?? '').trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_SIM2REAL_TELEMETRY_RETENTION_DAYS
  ) {
    if (!retentionWarningLogged) {
      retentionWarningLogged = true;
      console.error(
        `[sim2real] RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS=${raw} is invalid; ` +
          `telemetry retention stays disabled (expected an integer in 1..${MAX_SIM2REAL_TELEMETRY_RETENTION_DAYS}).`,
      );
    }
    return 0;
  }
  return parsed;
}

type StoredModel = Sim2RealModelRecord & { owner?: string };
type StoredRun = Sim2RealRunRecord & {
  owner?: string;
  /** Internal request dedupe metadata; never returned to a client. */
  _idempotencyKey?: string;
  _requestFingerprint?: string;
};
type StoredDeployment = Sim2RealDeploymentRecord & {
  owner?: string;
  /** Internal request dedupe metadata; never returned to a client. */
  _idempotencyKey?: string;
  _requestFingerprint?: string;
};
type StoredProject = Sim2RealProjectRecord & { owner?: string };
type StoredDataset = Sim2RealDatasetRecord & { owner?: string };
type StoredArtifact = Sim2RealArtifactRecord & {
  owner?: string;
  /** Internal request dedupe metadata; never returned to clients. */
  _idempotencyKey?: string;
  _requestFingerprint?: string;
};
type StoredEvaluation = Sim2RealEvaluationRecord & {
  owner?: string;
  /** Internal request dedupe metadata; never returned to clients. */
  _idempotencyKey?: string;
  _requestFingerprint?: string;
};
type StoredComputeResource = Sim2RealComputeResource & { owner?: string; runnerToken?: string };
type StoredTelemetry = Sim2RealTelemetryRecord & {
  owner?: string;
  /** Internal idempotency fingerprint; never returned to clients. */
  _requestFingerprint?: string;
  /** Fingerprint of the accepted chunk independent of transport sequence. */
  _contentFingerprint?: string;
};

/**
 * Telemetry chunk rows are stored WITHOUT their samples array in the JSON
 * ledger; the full records live in per-run NDJSON shards under
 * <storage>/telemetry/<runId>.jsonl. Every ingest previously re-serialized
 * the whole ledger (samples included), making N appended chunks O(N^2)
 * bytes of writes and pinning the ledger against its 768 MB cap. Shards are
 * append-only and owned by the same serialized write chain as the ledger,
 * so the split cannot interleave with a concurrent rename.
 */
type TelemetryShardRecord = Sim2RealTelemetryRecord & {
  owner?: string;
  _requestFingerprint?: string;
  _contentFingerprint?: string;
};

interface Sim2RealLedger {
  version: typeof LEDGER_VERSION;
  models: StoredModel[];
  runs: StoredRun[];
  deployments: StoredDeployment[];
  telemetry: StoredTelemetry[];
  projects: StoredProject[];
  datasets: StoredDataset[];
  artifacts: StoredArtifact[];
  evaluations: StoredEvaluation[];
  computeResources: StoredComputeResource[];
  feedback: unknown[];
}

export interface Sim2RealStorageInfo {
  mode: 'local-server' | 'external-required';
  writable: boolean;
  message: string;
}

function configuredStorageRoot(): string {
  return String(process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim();
}

export function sim2RealStorageInfo(): Sim2RealStorageInfo {
  const root = configuredStorageRoot();
  if (isWebCloudDeployment() && !root) {
    return {
      mode: 'external-required',
      writable: false,
      message:
        'Web Cloud requires an explicit RDK_SIM2REAL_STORAGE_DIR or a future object-store adapter; no shared disk is used implicitly.',
    };
  }
  if (!root) {
    return {
      mode: 'local-server',
      writable: false,
      message: '未配置 sim2real 台账目录；请设置 RDK_SIM2REAL_STORAGE_DIR。',
    };
  }
  try {
    // Probe the exact directory used by the ledger rather than assuming an
    // env var is writable. This catches read-only mounts before a user starts
    // a run and keeps `/readyz` meaningful.
    fsSync.mkdirSync(root, { recursive: true, mode: 0o700 });
    fsSync.accessSync(root, fsSync.constants.R_OK | fsSync.constants.W_OK);
  } catch {
    return {
      mode: isWebCloudDeployment() ? 'external-required' : 'local-server',
      writable: false,
      message: 'sim2real 台账目录不可读写；请检查挂载点和服务用户权限。',
    };
  }
  return {
    mode: 'local-server',
    writable: true,
    message:
      'Metadata is stored in an owner-scoped local ledger; model binaries are not executed by this service.',
  };
}

function ledgerPath(): string {
  const root = configuredStorageRoot() || resolveDataDir();
  return path.join(root, 'sim2real.json');
}

type LedgerCache = {
  file: string;
  value: Sim2RealLedger;
  /** File metadata captured after parsing; used to detect external replaces. */
  size: number;
  mtimeMs: number;
};

let cache: LedgerCache | null = null;
let readinessCache: {
  file: string;
  size: number;
  mtimeMs: number;
  checkedAt: number;
  info: Sim2RealStorageInfo;
} | null = null;
let writeChain: Promise<void> = Promise.resolve();

function ledgerQuotaError(size: number): Error {
  const error = new Sim2RealError('sim2real_storage_quota_exceeded');
  // Keep the public error code stable while retaining a useful diagnostic for
  // logs/debuggers without exposing filesystem details to API callers.
  error.cause = new Error(`ledger size ${size} exceeds ${SIM2REAL_LEDGER_MAX_BYTES} bytes`);
  return error;
}

function assertLedgerSize(size: number): void {
  if (size > SIM2REAL_LEDGER_MAX_BYTES) throw ledgerQuotaError(size);
}

function emptyLedger(): Sim2RealLedger {
  return {
    version: LEDGER_VERSION,
    models: [],
    runs: [],
    deployments: [],
    telemetry: [],
    projects: [],
    datasets: [],
    artifacts: [],
    evaluations: [],
    computeResources: [],
    feedback: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function validRecordArray(
  value: unknown,
  required: readonly string[],
  nestedArray?: string,
): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!isRecord(item)) return false;
      if (required.some((key) => typeof item[key] !== 'string' || !String(item[key]).trim())) {
        return false;
      }
      return nestedArray ? Array.isArray(item[nestedArray]) : true;
    })
  );
}

function validLedgerShape(value: Record<string, unknown>): boolean {
  if (value.version !== LEDGER_VERSION) return false;
  // `manifest` is a nested object, not an array; validate its shape in the
  // explicit check below. Passing it as `nestedArray` would reject every
  // otherwise valid ledger as soon as a custom model was persisted.
  if (!validRecordArray(value.models, ['id', 'createdAt', 'updatedAt'])) return false;
  if ((value.models as unknown[]).length > MODEL_CAP) return false;
  if (!value.models.every((item) => isRecord(item.manifest))) return false;
  if (
    !validRecordArray(value.runs, ['id', 'modelId', 'backend', 'status', 'summary', 'createdAt'])
  ) {
    return false;
  }
  if ((value.runs as unknown[]).length > RUN_CAP) return false;
  if (
    !validRecordArray(value.deployments, [
      'id',
      'modelId',
      'deviceId',
      'targetPlatform',
      'mode',
      'status',
      'summary',
      'createdAt',
      'updatedAt',
    ])
  ) {
    return false;
  }
  if ((value.deployments as unknown[]).length > DEPLOYMENT_CAP) return false;
  if (
    !(value.deployments as Array<Record<string, unknown>>).every((deployment) => {
      if (deployment.history === undefined) return true;
      return (
        Array.isArray(deployment.history) &&
        deployment.history.length <= 100 &&
        deployment.history.every(
          (event) =>
            isRecord(event) &&
            ['id', 'type', 'status', 'summary', 'createdAt'].every(
              (key) => typeof event[key] === 'string' && String(event[key]).trim(),
            ),
        )
      );
    })
  )
    return false;
  if (
    !(value.deployments as Array<Record<string, unknown>>).every((deployment) => {
      if (deployment.approval === undefined) return true;
      if (!isRecord(deployment.approval)) return false;
      const approval = deployment.approval;
      return (
        ['pending', 'approved', 'rejected'].includes(String(approval.status)) &&
        typeof approval.requestedAt === 'string' &&
        (approval.requestedBy === undefined || typeof approval.requestedBy === 'string') &&
        (approval.decidedAt === undefined || typeof approval.decidedAt === 'string') &&
        (approval.decidedBy === undefined || typeof approval.decidedBy === 'string') &&
        (approval.note === undefined || typeof approval.note === 'string')
      );
    })
  )
    return false;
  // Telemetry rows come in two shapes: legacy inline rows carry their samples
  // array; shard-backed index rows deliberately omit it. Accept either.
  const telemetryRowsOk =
    Array.isArray(value.telemetry) &&
    value.telemetry.every((item) => {
      if (!isRecord(item)) return false;
      if (
        ['id', 'runId', 'source', 'receivedAt'].some(
          (key) => typeof item[key] !== 'string' || !String(item[key]).trim(),
        )
      ) {
        return false;
      }
      // Attestation is a server-derived provenance bit.  Keep the ledger
      // parser strict so a hand-edited/corrupt row cannot turn into release
      // evidence by carrying a truthy string or number.
      if (item.attested !== undefined && typeof item.attested !== 'boolean') return false;
      return item.samples === undefined || Array.isArray(item.samples);
    });
  if (!telemetryRowsOk) {
    return false;
  }
  if ((value.telemetry as unknown[]).length > SIM2REAL_TELEMETRY_RECORD_CAP) return false;
  if (value.projects !== undefined && !Array.isArray(value.projects)) return false;
  if (value.datasets !== undefined && !Array.isArray(value.datasets)) return false;
  if (value.artifacts !== undefined && !Array.isArray(value.artifacts)) return false;
  if (value.evaluations !== undefined && !Array.isArray(value.evaluations)) return false;
  if (value.computeResources !== undefined && !Array.isArray(value.computeResources)) return false;
  // Feedback (G15) is optional in ledger shape so pre-existing ledgers keep
  // parsing; entries are filtered by the closed-shape guard at read/write time.
  if (value.feedback !== undefined && !Array.isArray(value.feedback)) return false;
  if (Array.isArray(value.projects) && value.projects.length > PROJECT_CAP) return false;
  if (Array.isArray(value.datasets) && value.datasets.length > DATASET_CAP) return false;
  if (Array.isArray(value.artifacts) && value.artifacts.length > ARTIFACT_CAP) return false;
  if (Array.isArray(value.evaluations) && value.evaluations.length > EVALUATION_CAP) return false;
  if (Array.isArray(value.feedback) && value.feedback.length > FEEDBACK_CAP) return false;
  if (Array.isArray(value.computeResources) && value.computeResources.length > 100) return false;
  if (Array.isArray(value.projects)) {
    if (!validRecordArray(value.projects, ['id', 'name', 'slug', 'createdAt', 'updatedAt']))
      return false;
    if (
      !(value.projects as Array<Record<string, unknown>>).every(
        (item) =>
          Array.isArray(item.modelIds) &&
          Array.isArray(item.datasetIds) &&
          (item.modelIds as unknown[]).every((id) => typeof id === 'string') &&
          (item.datasetIds as unknown[]).every((id) => typeof id === 'string'),
      )
    )
      return false;
  }
  if (
    Array.isArray(value.datasets) &&
    !validRecordArray(value.datasets, ['id', 'name', 'createdAt', 'updatedAt'])
  )
    return false;
  if (
    Array.isArray(value.datasets) &&
    !(value.datasets as Array<Record<string, unknown>>).every(
      (item) =>
        item.status === undefined ||
        ['registered', 'ready', 'revoked'].includes(String(item.status)),
    )
  )
    return false;
  if (
    Array.isArray(value.artifacts) &&
    !validRecordArray(value.artifacts, [
      'id',
      'artifactId',
      'version',
      'name',
      'role',
      'kind',
      'format',
      'ref',
      'sha256',
      'status',
      'createdAt',
      'updatedAt',
    ])
  )
    return false;
  if (
    Array.isArray(value.artifacts) &&
    !(value.artifacts as Array<Record<string, unknown>>).every(
      (item) =>
        Array.isArray(item.datasetIds) &&
        Array.isArray(item.evaluationIds) &&
        (item.datasetIds as unknown[]).every((id) => typeof id === 'string') &&
        (item.evaluationIds as unknown[]).every((id) => typeof id === 'string'),
    )
  )
    return false;
  if (
    Array.isArray(value.artifacts) &&
    !(value.artifacts as Array<Record<string, unknown>>).every((item) =>
      ['draft', 'validated', 'published', 'revoked'].includes(String(item.status)),
    )
  )
    return false;
  if (
    Array.isArray(value.evaluations) &&
    !validRecordArray(value.evaluations, [
      'id',
      'runId',
      'modelId',
      'status',
      'summary',
      'source',
      'createdAt',
      'updatedAt',
    ])
  )
    return false;
  if (
    Array.isArray(value.evaluations) &&
    !(value.evaluations as Array<Record<string, unknown>>).every(
      (item) =>
        Array.isArray(item.datasetIds) &&
        (item.datasetIds as unknown[]).every((id) => typeof id === 'string'),
    )
  )
    return false;
  if (
    Array.isArray(value.evaluations) &&
    !(value.evaluations as Array<Record<string, unknown>>).every((item) =>
      ['pending', 'running', 'passed', 'failed', 'invalid'].includes(String(item.status)),
    )
  )
    return false;
  // Freshness metadata is server-owned. Keep the parser strict so a hand
  // edited ledger cannot make an old evaluation look current or attach an
  // invalid revision to a run.
  if (
    !(value.runs as Array<Record<string, unknown>>).every(
      (item) =>
        (item.telemetryRevision === undefined ||
          (typeof item.telemetryRevision === 'string' &&
            /^[a-f0-9]{64}$/i.test(item.telemetryRevision))) &&
        (item.evaluationId === undefined || typeof item.evaluationId === 'string'),
    )
  )
    return false;
  if (
    Array.isArray(value.evaluations) &&
    !(value.evaluations as Array<Record<string, unknown>>).every(
      (item) =>
        (item.telemetryRevision === undefined ||
          (typeof item.telemetryRevision === 'string' &&
            /^[a-f0-9]{64}$/i.test(item.telemetryRevision))) &&
        (item.stale === undefined || typeof item.stale === 'boolean') &&
        (item.staleAt === undefined || typeof item.staleAt === 'string') &&
        (item.staleReason === undefined || typeof item.staleReason === 'string'),
    )
  )
    return false;
  if (
    Array.isArray(value.computeResources) &&
    !validRecordArray(value.computeResources, [
      'id',
      'name',
      'kind',
      'runnerUrl',
      'status',
      'createdAt',
      'updatedAt',
    ])
  )
    return false;
  // Sample-level validation applies only to legacy inline rows; shard-backed
  // index rows have no samples here.
  return (value.telemetry as Array<Record<string, unknown>>).every(
    (item) =>
      item.samples === undefined || (item.samples as unknown[]).every((sample) => isRecord(sample)),
  );
}

/**
 * Readiness-only validation for the JSON ledger. The normal storage probe is
 * intentionally synchronous and cheap because routes call it frequently; the
 * health endpoint can afford this asynchronous parse so a corrupt ledger is
 * not advertised as ready.
 */
export async function sim2RealStorageReadiness(): Promise<Sim2RealStorageInfo> {
  const info = sim2RealStorageInfo();
  if (!info.writable) return info;
  const file = ledgerPath();
  const now = Date.now();
  let stat: { size: number; mtimeMs: number };
  try {
    const fileStat = await fs.stat(file);
    stat = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const result = info;
      readinessCache = { file, size: -1, mtimeMs: 0, checkedAt: now, info: result };
      return result;
    }
    console.error('[sim2real] readiness ledger stat failed:', redactInternalError(error));
    return {
      ...info,
      writable: false,
      message: 'sim2real 台账文件不可读或格式无效；请修复后再接收新任务。',
    };
  }
  if (stat.size > SIM2REAL_LEDGER_MAX_BYTES) {
    const result = {
      ...info,
      writable: false,
      message: 'sim2real 台账超过单实例大小上限；请迁移到对象存储 adapter。',
    };
    readinessCache = { file, ...stat, checkedAt: now, info: result };
    return result;
  }
  if (
    readinessCache &&
    readinessCache.file === file &&
    readinessCache.size === stat.size &&
    readinessCache.mtimeMs === stat.mtimeMs &&
    now - readinessCache.checkedAt < READINESS_CACHE_TTL_MS
  ) {
    return readinessCache.info;
  }
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !validLedgerShape(parsed)) {
      throw new Error('ledger schema invalid');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      readinessCache = { file, size: -1, mtimeMs: 0, checkedAt: now, info };
      return info;
    }
    console.error('[sim2real] readiness ledger check failed:', redactInternalError(error));
    const result = {
      ...info,
      writable: false,
      message: 'sim2real 台账文件不可读或格式无效；请修复后再接收新任务。',
    };
    readinessCache = { file, ...stat, checkedAt: now, info: result };
    return result;
  }
  readinessCache = { file, ...stat, checkedAt: now, info };
  return info;
}

async function readLedger(): Promise<Sim2RealLedger> {
  const file = ledgerPath();
  // A shared Web Cloud process must not silently read a process-local ledger.
  // The overview remains useful with the built-in reference model, while user
  // metadata becomes available only after an explicit shared storage mount.
  if (!sim2RealStorageInfo().writable) {
    // Do not cache this empty view. A transient permission/mount failure must
    // not poison the path after an operator repairs it, otherwise the first
    // subsequent write could overwrite a ledger that was present all along.
    return emptyLedger();
  }
  // The service is intentionally single-instance, but operators may still
  // atomically replace a ledger during backup/restore. A path-only cache would
  // return the old value and a subsequent write could overwrite the restored
  // records. Check cheap file metadata before every cache hit.
  if (cache?.file === file) {
    try {
      const stat = await fs.stat(file);
      // Check the guard before returning a cached value. An operator can
      // replace the file in-place with an oversized ledger while preserving
      // the same path; parsing it would defeat the single-instance bound.
      assertLedgerSize(stat.size);
      if (stat.size === cache.size && stat.mtimeMs === cache.mtimeMs) return cache.value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        // A previously existing ledger disappearing is not an empty database;
        // fail closed so a later write cannot recreate it over an operator's
        // in-progress restore/deletion.
        if (cache.size >= 0) {
          const failure = new Sim2RealError('sim2real_storage_unavailable');
          failure.cause = error;
          throw failure;
        }
        return cache.value;
      }
      // Drop an unverifiable cache entry and let the normal disk-read path
      // convert the underlying permission/I/O failure into the stable
      // `sim2real_storage_unavailable` error used by HTTP routes.
      cache = null;
    }
  }

  try {
    // Read and validate against metadata captured both before and after the
    // read. This closes the small race where another process replaces the
    // file between stat() and readFile(). The second attempt is enough for an
    // atomic operator rename while keeping normal reads bounded.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let before: { size: number; mtimeMs: number };
      try {
        const stat = await fs.stat(file);
        before = { size: stat.size, mtimeMs: stat.mtimeMs };
        // Reject before readFile/JSON.parse so a corrupted or oversized
        // ledger cannot cause an unbounded allocation in the normal request
        // path. Readiness performs the same check for /readyz.
        assertLedgerSize(before.size);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          if (cache?.file === file && cache.size >= 0) {
            const failure = new Sim2RealError('sim2real_storage_unavailable');
            failure.cause = error;
            throw failure;
          }
          const value = emptyLedger();
          cache = { file, value, size: -1, mtimeMs: 0 };
          return value;
        }
        throw error;
      }
      const raw = await fs.readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !validLedgerShape(parsed)) {
        throw new Error('ledger schema invalid');
      }
      const afterStat = await fs.stat(file);
      assertLedgerSize(afterStat.size);
      if (before.size !== afterStat.size || before.mtimeMs !== afterStat.mtimeMs) continue;
      const value: Sim2RealLedger = {
        version: LEDGER_VERSION,
        models: arrayOf<StoredModel>(parsed.models),
        runs: arrayOf<StoredRun>(parsed.runs),
        deployments: arrayOf<StoredDeployment>(parsed.deployments),
        telemetry: arrayOf<StoredTelemetry>(parsed.telemetry),
        projects: arrayOf<StoredProject>(parsed.projects),
        datasets: arrayOf<StoredDataset>(parsed.datasets),
        artifacts: arrayOf<StoredArtifact>(parsed.artifacts),
        evaluations: arrayOf<StoredEvaluation>(parsed.evaluations),
        computeResources: arrayOf<StoredComputeResource>(parsed.computeResources),
        feedback: arrayOf<unknown>(parsed.feedback),
      };
      cache = { file, value, size: afterStat.size, mtimeMs: afterStat.mtimeMs };
      return value;
    }
    throw new Error('ledger changed while being read');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (cache?.file === file && cache.size >= 0) {
        const failure = new Sim2RealError('sim2real_storage_unavailable');
        failure.cause = error;
        throw failure;
      }
      const value = emptyLedger();
      cache = { file, value, size: -1, mtimeMs: 0 };
      return value;
    }
    if (error instanceof Error && error.message === 'sim2real_storage_quota_exceeded') {
      // Preserve the explicit 507-class error from the pre-read size guard;
      // callers need to distinguish a full ledger from an unreadable one.
      throw error;
    }
    // A permission error or malformed ledger must never be treated as an
    // empty database: doing so would make the next write overwrite existing
    // records. Surface a stable 503-class error and keep the original cause
    // in the process log for operators.
    console.error(
      '[sim2real] ledger unreadable; refusing to continue:',
      redactInternalError(error),
    );
    const failure = new Sim2RealError('sim2real_storage_unavailable');
    failure.cause = error;
    throw failure;
  }
}

async function writeLedger(value: Sim2RealLedger): Promise<void> {
  const file = ledgerPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Cross-process writer lease: every ledger write funnels through this
  // function from inside `serialized(...)`, so this is the one choke point
  // that (a) makes a second instance sharing the storage directory fail fast
  // instead of overwriting the ledger and (b) refreshes the heartbeat on
  // every successful write so a long-lived process is never mistaken for a
  // dead one. A conflict throws before the first durable change is made.
  await acquireStorageLease(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const serializedValue = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serializedValue, 'utf8') > SIM2REAL_LEDGER_MAX_BYTES) {
    throw new Sim2RealError('sim2real_storage_quota_exceeded');
  }
  try {
    const handle = await fs.open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(serializedValue, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  // Capture the metadata of the newly renamed file so subsequent reads can
  // safely use the cache. If stat fails after a successful write, discard the
  // cache; the next operation will re-read the durable file instead of
  // trusting an unverifiable value.
  try {
    const stat = await fs.stat(file);
    cache = { file, value, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    cache = null;
  }
  readinessCache = null;
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- telemetry NDJSON shards ----------------------------------------------
// Full telemetry records (samples included) live in per-run append-only
// shards; the JSON ledger keeps only lightweight index rows. Shards are only
// touched from inside `serialized(...)` operations, so the ledger write and
// the shard append cannot interleave.

function telemetryShardDir(): string {
  return path.join(path.dirname(ledgerPath()), 'telemetry');
}

function telemetryShardPath(runId: string): string | null {
  // runId is generated by this service (createSim2RealRun) but reaches the
  // store through ingest bodies, so bound it before using it as a filename.
  return /^[\w-]{1,128}$/.test(runId) ? path.join(telemetryShardDir(), `${runId}.jsonl`) : null;
}

/**
 * Parse one NDJSON shard line into a full telemetry record. A line whose JSON
 * is malformed deliberately propagates its `JSON.parse` error: an unreadable
 * shard must fail loudly rather than silently drop accepted evidence.
 */
function parseTelemetryShardLine(
  line: string,
  owner: string | undefined,
): TelemetryShardRecord | null {
  if (!line.trim()) return null;
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) return null;
  const record = parsed as unknown as TelemetryShardRecord;
  return ownerMatches(record, owner) && Array.isArray(record.samples) ? record : null;
}

/**
 * Read the full telemetry chunks for one run. Rows still carrying inline
 * samples (written by ledger versions before the split) come from the ledger
 * itself, so old data keeps working without a migration pass.
 */
async function readTelemetryShard(
  runId: string,
  owner?: string,
  indexedIds?: ReadonlySet<string>,
): Promise<TelemetryShardRecord[]> {
  const shard = telemetryShardPath(runId);
  if (!shard) return [];
  let raw: string;
  try {
    raw = await fs.readFile(shard, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const records: TelemetryShardRecord[] = [];
  for (const line of raw.split('\n')) {
    const record = parseTelemetryShardLine(line, owner);
    // Shards are append-first and the ledger index is the commit marker. A
    // process crash between those writes can leave an orphan line; never let
    // that line become visible after restart. Callers that have a ledger pass
    // the committed id set. The optional form preserves the low-level reader's
    // utility for migration/diagnostic callers that intentionally inspect all
    // lines.
    if (record && (!indexedIds || indexedIds.has(record.id))) records.push(record);
  }
  return records;
}

/**
 * Bounded head read of one run shard, used by the list endpoint. It reads the
 * file in fixed-size chunks and returns as soon as `maxRecords` owner-matching
 * rows have been parsed, so a small `limit` no longer pays for the whole
 * (potentially 100k-row, sample-heavy) file. Rows are returned in append order,
 * which is the order `readTelemetryShard` observes. The full reader above stays
 * unchanged for replay/evaluation and idempotency lookups.
 */
async function readTelemetryShardBounded(
  runId: string,
  owner: string | undefined,
  maxRecords: number,
  indexedIds?: ReadonlySet<string>,
): Promise<TelemetryShardRecord[]> {
  if (!Number.isFinite(maxRecords) || maxRecords <= 0) return [];
  const shard = telemetryShardPath(runId);
  if (!shard) return [];
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(shard, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const records: TelemetryShardRecord[] = [];
  // A fixed 64 KiB window bounds peak memory independently of file size, and
  // the decoder keeps a multi-byte code point split across two reads intact.
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let position = 0;
  try {
    readChunks: for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const record = parseTelemetryShardLine(line, owner);
        if (record && (!indexedIds || indexedIds.has(record.id))) {
          records.push(record);
          if (records.length >= maxRecords) break readChunks;
        }
        newline = pending.indexOf('\n');
      }
    }
    // The writer always terminates a line with "\n", but tolerate a truncated
    // tail so a partial final write cannot hide every earlier record.
    if (records.length < maxRecords) {
      const tail = `${pending}${decoder.end()}`;
      const record = parseTelemetryShardLine(tail, owner);
      if (record && (!indexedIds || indexedIds.has(record.id))) records.push(record);
    }
  } finally {
    await handle.close();
  }
  return records;
}

/**
 * Append one full telemetry record to its run shard. Called inside the same
 * serialized operation that writes the ledger index row, so the shard and the
 * ledger commit together (shard first: a crash then leaves an orphan line the
 * index does not reference, which is invisible, rather than a dangling index).
 */
async function appendTelemetryShard(record: TelemetryShardRecord): Promise<void> {
  const shard = telemetryShardPath(record.runId);
  if (!shard) throw new Sim2RealError('sim2real_telemetry_run_id_invalid');
  await fs.mkdir(telemetryShardDir(), { recursive: true, mode: 0o700 });
  const handle = await fs.open(shard, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Ledger index rows for one run whose shard record is older than the retention
 * cutoff. Legacy inline rows are self-contained and deliberately skipped: only
 * shard-backed rows are pruned, so a shard line and its index row always
 * disappear together. An unparseable `receivedAt` is kept (fail safe: never
 * delete evidence this process cannot date).
 */
function expiredTelemetryIndexIds(
  ledger: Sim2RealLedger,
  runId: string,
  owner: string | undefined,
  cutoffMs: number,
): Set<string> {
  const expired = new Set<string>();
  for (const row of ledger.telemetry) {
    if (row.runId !== runId || !ownerMatches(row, owner)) continue;
    if (Array.isArray(row.samples)) continue;
    const received = Date.parse(String(row.receivedAt ?? ''));
    if (Number.isFinite(received) && received < cutoffMs) expired.add(row.id);
  }
  return expired;
}

/**
 * Drop the given ids from a run shard by rewriting it through a temporary file
 * and an atomic `rename`, so a reader always sees either the old or the new
 * complete file. Surviving rows keep their original append order and the file
 * stays mode 0o600 in the 0o700 telemetry directory. A malformed line is kept
 * verbatim because this process cannot prove it is safe to discard.
 */
async function rewriteTelemetryShardWithout(
  shard: string,
  removedIds: ReadonlySet<string>,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(shard, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  const kept: string[] = [];
  let changed = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      kept.push(line);
      continue;
    }
    if (isRecord(parsed) && typeof parsed.id === 'string' && removedIds.has(parsed.id)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  if (!changed) return;
  const temporary = `${shard}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(kept.map((line) => `${line}\n`).join(''), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, shard);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function ensureWritable(): void {
  if (!sim2RealStorageInfo().writable) throw new Sim2RealError('sim2real_storage_not_configured');
}

function ownerMatches(record: { owner?: string }, owner: string | undefined): boolean {
  return (record.owner ?? '') === (owner ?? '');
}

/**
 * The ledger index is the commit marker for a shard line. Keep the lookup in
 * one helper so every read path (full, bounded, idempotency and quota checks)
 * applies the same owner/run boundary and cannot accidentally expose an
 * append-first orphan after a crash.
 */
function committedTelemetryIds(
  ledger: Sim2RealLedger,
  runId: string,
  owner: string | undefined,
): ReadonlySet<string> {
  return new Set(
    ledger.telemetry
      .filter((item) => item.runId === runId && ownerMatches(item, owner))
      .map((item) => item.id),
  );
}

function withoutOwner<T extends { owner?: string }>(record: T): Omit<T, 'owner'> {
  const { owner: _owner, ...publicRecord } = record;
  return publicRecord;
}

function withoutRunPrivate(record: StoredRun): Sim2RealRunRecord {
  const {
    _idempotencyKey: _key,
    _requestFingerprint: _fingerprint,
    ...owned
  } = withoutOwner(record);
  return owned as Sim2RealRunRecord;
}

function withoutTelemetryPrivate(record: StoredTelemetry): Sim2RealTelemetryRecord {
  const {
    _requestFingerprint: _fingerprint,
    _contentFingerprint: _contentFingerprint,
    ...owned
  } = withoutOwner(record);
  return owned as Sim2RealTelemetryRecord;
}

function withoutDeploymentPrivate(record: StoredDeployment): Sim2RealDeploymentRecord {
  const {
    _idempotencyKey: _key,
    _requestFingerprint: _fingerprint,
    ...owned
  } = withoutOwner(record);
  return owned as Sim2RealDeploymentRecord;
}

function withoutProjectPrivate(record: StoredProject): Sim2RealProjectRecord {
  return withoutOwner(record) as Sim2RealProjectRecord;
}

function withoutDatasetPrivate(record: StoredDataset): Sim2RealDatasetRecord {
  return withoutOwner(record) as Sim2RealDatasetRecord;
}

function withoutArtifactPrivate(record: StoredArtifact): Sim2RealArtifactRecord {
  const {
    _idempotencyKey: _key,
    _requestFingerprint: _fingerprint,
    ...owned
  } = withoutOwner(record);
  return owned as Sim2RealArtifactRecord;
}

function withoutEvaluationPrivate(record: StoredEvaluation): Sim2RealEvaluationRecord {
  const {
    _idempotencyKey: _key,
    _requestFingerprint: _fingerprint,
    ...owned
  } = withoutOwner(record);
  return owned as Sim2RealEvaluationRecord;
}

function withoutComputeResourcePrivate(record: StoredComputeResource): Sim2RealComputeResource {
  const { runnerToken: _token, ...publicRecord } = withoutOwner(record);
  return {
    ...publicRecord,
    // Do not advertise an old "online" result as executable. The durable
    // row stays intact for audit/history, while every public read re-evaluates
    // the bounded health lease against the current TTL policy.
    status:
      record.status === 'online' && !isSim2RealComputeResourceHealthFresh(record)
        ? 'unknown'
        : record.status,
    tokenConfigured: Boolean(record.runnerToken),
  } as Sim2RealComputeResource;
}

const DEPLOYMENT_STATUS_TRANSITIONS: Readonly<
  Record<Sim2RealDeploymentRecord['status'], readonly Sim2RealDeploymentRecord['status'][]>
> = Object.freeze({
  planned: ['planned', 'running', 'ready', 'blocked', 'failed', 'cancelled'],
  running: ['running', 'ready', 'blocked', 'failed', 'cancelled'],
  ready: ['ready', 'running', 'completed', 'blocked', 'cancelled'],
  blocked: ['blocked', 'planned', 'running', 'failed', 'cancelled'],
  failed: ['failed', 'planned', 'cancelled'],
  completed: ['completed'],
  cancelled: ['cancelled'],
});

/** Dataset snapshots move forward through registration and readiness. */
const DATASET_STATUS_TRANSITIONS: Readonly<
  Record<Sim2RealDatasetStatus, readonly Sim2RealDatasetStatus[]>
> = Object.freeze({
  registered: ['registered', 'ready', 'revoked'],
  ready: ['ready', 'revoked'],
  revoked: ['revoked'],
});

/** Evaluation evidence is append-only once a terminal result is recorded. */
const EVALUATION_STATUS_TRANSITIONS: Readonly<
  Record<Sim2RealEvaluationStatus, readonly Sim2RealEvaluationStatus[]>
> = Object.freeze({
  pending: ['pending', 'running', 'failed', 'invalid'],
  running: ['running', 'passed', 'failed', 'invalid'],
  passed: ['passed'],
  failed: ['failed'],
  invalid: ['invalid'],
});

const ARTIFACT_STATUS_TRANSITIONS: Readonly<
  Record<Sim2RealArtifactLifecycleStatus, readonly Sim2RealArtifactLifecycleStatus[]>
> = Object.freeze({
  draft: ['draft', 'validated', 'revoked'],
  validated: ['validated', 'published', 'revoked'],
  published: ['published', 'revoked'],
  revoked: ['revoked'],
});

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function telemetryUsage(records: readonly StoredTelemetry[]): { samples: number; bytes: number } {
  let samples = 0;
  let bytes = 0;
  for (const record of records) {
    samples += Array.isArray(record.samples) ? record.samples.length : 0;
    // The byte estimate is deliberately based on the JSON representation
    // that is persisted. It is conservative enough to protect the ledger and
    // avoids maintaining a second mutable accounting table.
    bytes += Buffer.byteLength(JSON.stringify(record), 'utf8');
  }
  return { samples, bytes };
}

/**
 * Stable content identity for a telemetry chunk. Keep this digest private in
 * the ledger; it is only a deduplication primitive, never a release credential.
 */
function telemetryContentFingerprint(
  input: Pick<
    Sim2RealTelemetryRecord,
    | 'runId'
    | 'modelId'
    | 'source'
    | 'deviceId'
    | 'contractId'
    | 'attested'
    | 'droppedCount'
    | 'samples'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: input.runId,
        modelId: input.modelId,
        source: input.source,
        deviceId: input.deviceId ?? null,
        contractId: input.contractId ?? null,
        attested: input.attested === true,
        droppedCount: input.droppedCount ?? null,
        samples: input.samples,
      }),
    )
    .digest('hex');
}

function telemetryRequestFingerprint(
  input: Pick<
    Sim2RealTelemetryRecord,
    | 'runId'
    | 'modelId'
    | 'source'
    | 'deviceId'
    | 'contractId'
    | 'attested'
    | 'sequence'
    | 'droppedCount'
    | 'samples'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: input.runId,
        modelId: input.modelId,
        source: input.source,
        deviceId: input.deviceId ?? null,
        contractId: input.contractId ?? null,
        attested: input.attested === true,
        sequence: input.sequence ?? null,
        droppedCount: input.droppedCount ?? null,
        samples: input.samples,
      }),
    )
    .digest('hex');
}

/**
 * Stable identity for the exact accepted telemetry set used by an
 * evaluation.  The digest deliberately includes chunk ids and private
 * content fingerprints when available; it is a freshness marker, not a
 * bearer credential.  If a process crashes after appending a shard line but
 * before committing its ledger index, the indexed read path below excludes
 * that line and therefore excludes it from this revision too.
 */
function telemetryRevision(records: readonly Sim2RealTelemetryRecord[]): string {
  const rows = [...records].sort(compareTelemetryRecords).map((record) => ({
    id: record.id,
    sequence: record.sequence ?? null,
    receivedAt: record.receivedAt,
    content: (record as StoredTelemetry)._contentFingerprint ?? telemetryContentFingerprint(record),
  }));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * Keep telemetry chunks in the same deterministic order used by replay and
 * evaluation.  A board agent normally supplies a sequence number; imported
 * browser files may omit it, in which case the durable receive timestamp is
 * the only ordering signal available.
 */
function compareTelemetryRecords(
  left: Pick<Sim2RealTelemetryRecord, 'sequence' | 'receivedAt' | 'id'>,
  right: Pick<Sim2RealTelemetryRecord, 'sequence' | 'receivedAt' | 'id'>,
): number {
  return (
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
    left.receivedAt.localeCompare(right.receivedAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Reject a newly accepted chunk if the timeline would go backwards.  The
 * check walks one flat, sequence-ordered sample stream (the run's chunk
 * history plus the incoming chunk), so the invariant holds identically
 * inside a chunk and across chunk boundaries.  Sequence numbers are
 * deliberately used when present so chunks that arrive out of order can
 * still be accepted when their logical timeline is valid.
 *
 * The board runtime resets its per-session clock at every session-started
 * marker: a timestamp regression that lands exactly on such a marker is the
 * documented start of a new policy session, not disorder, so the scan
 * restarts there.  Any other regression is rejected.
 */
function assertTelemetryTimeline(
  records: readonly StoredTelemetry[],
  incoming: StoredTelemetry,
  owner: string | undefined,
): void {
  const ordered = [...records, incoming]
    .filter((item) => item.runId === incoming.runId && ownerMatches(item, owner))
    .sort(compareTelemetryRecords);
  let previousT: number | undefined;
  for (const record of ordered) {
    const samples = Array.isArray(record.samples) ? record.samples : [];
    for (const sample of samples) {
      // A new policy session restarts the board's clock, so the next
      // session's samples legitimately begin near zero again.
      if (sample?.event?.kind === 'session-started') {
        previousT = undefined;
        continue;
      }
      const timestamp = Number(sample?.t);
      // Legacy ledgers are allowed to contain records written before the
      // timestamp invariant existed.  Skip malformed legacy values here;
      // route-level validation still rejects malformed new input.
      if (!Number.isFinite(timestamp)) continue;
      if (previousT != null && timestamp < previousT) {
        throw new Sim2RealError('sim2real_telemetry_timestamp_order');
      }
      previousT = timestamp;
    }
  }
}

export async function listSim2RealModels(owner?: string): Promise<Sim2RealModelRecord[]> {
  const ledger = await readLedger();
  const custom = ledger.models
    .filter((item) => ownerMatches(item, owner))
    .slice(0, MODEL_CAP)
    .map((item) => copy(withoutOwner(item)) as Sim2RealModelRecord);
  return [copy(BUILTIN_MICRODUCK_MODEL), copy(BUILTIN_ORIGINBOT_MODEL), ...custom];
}

export async function listSim2RealProjects(owner?: string): Promise<Sim2RealProjectRecord[]> {
  const ledger = await readLedger();
  return ledger.projects
    .filter((item) => ownerMatches(item, owner))
    .slice(0, PROJECT_CAP)
    .map((item) => copy(withoutProjectPrivate(item)));
}

export async function getSim2RealProject(
  id: string,
  owner?: string,
): Promise<Sim2RealProjectRecord | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const ledger = await readLedger();
  const found = ledger.projects.find((item) => item.id === wanted && ownerMatches(item, owner));
  return found ? copy(withoutProjectPrivate(found)) : null;
}

export async function createSim2RealProject(
  input: Omit<Sim2RealProjectRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner?: string,
): Promise<Sim2RealProjectRecord> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    if (ledger.projects.length >= PROJECT_CAP)
      throw new Sim2RealError('sim2real_storage_quota_exceeded');
    const duplicate = ledger.projects.some(
      (item) => ownerMatches(item, owner) && item.slug === input.slug,
    );
    if (duplicate) throw new Error('sim2real_project_slug_exists');
    const now = new Date().toISOString();
    const record: StoredProject = {
      ...copy(input),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...(owner ? { owner } : {}),
    };
    await writeLedger({ ...ledger, projects: [record, ...ledger.projects] });
    void emitSim2RealEvent('project.created', record.id, withoutProjectPrivate(record), owner);
    return copy(withoutProjectPrivate(record));
  });
}

export async function updateSim2RealProject(
  id: string,
  patch: Partial<
    Pick<Sim2RealProjectRecord, 'name' | 'slug' | 'description' | 'modelIds' | 'datasetIds'>
  >,
  owner?: string,
): Promise<Sim2RealProjectRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.projects.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    if (
      patch.slug &&
      ledger.projects.some(
        (item) => item.id !== id && ownerMatches(item, owner) && item.slug === patch.slug,
      )
    ) {
      throw new Error('sim2real_project_slug_exists');
    }
    const updated: StoredProject = {
      ...ledger.projects[index],
      ...copy(patch),
      updatedAt: new Date().toISOString(),
    };
    const projects = [...ledger.projects];
    projects[index] = updated;
    await writeLedger({ ...ledger, projects });
    void emitSim2RealEvent('project.updated', updated.id, withoutProjectPrivate(updated), owner);
    return copy(withoutProjectPrivate(updated));
  });
}

export async function listSim2RealDatasets(owner?: string): Promise<Sim2RealDatasetRecord[]> {
  const ledger = await readLedger();
  return ledger.datasets
    .filter((item) => ownerMatches(item, owner))
    .slice(0, DATASET_CAP)
    .map((item) => copy(withoutDatasetPrivate(item)));
}

export async function createSim2RealDataset(
  input: Omit<Sim2RealDatasetRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner?: string,
): Promise<Sim2RealDatasetRecord> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    // Registration is deliberately a separate step from readiness. A client
    // cannot self-attest that an imported snapshot is ready at creation time;
    // promotion goes through updateSim2RealDatasetStatus after validation.
    const status = input.status ?? 'registered';
    if (status !== 'registered') {
      throw new Sim2RealError('sim2real_dataset_transition_invalid');
    }
    if (!DATASET_STATUS_TRANSITIONS[status]) {
      throw new Sim2RealError('sim2real_dataset_transition_invalid');
    }
    if (input.sourceRunId) {
      const sourceRun = ledger.runs.find(
        (item) => item.id === input.sourceRunId && ownerMatches(item, owner),
      );
      if (!sourceRun) throw new Sim2RealError('sim2real_run_lineage_invalid');
      if (input.contractId) {
        const sourceModel =
          sourceRun.modelId === BUILTIN_MICRODUCK_MODEL.id
            ? BUILTIN_MICRODUCK_MODEL
            : sourceRun.modelId === BUILTIN_ORIGINBOT_MODEL.id
              ? BUILTIN_ORIGINBOT_MODEL
              : ledger.models.find(
                  (item) => item.id === sourceRun.modelId && ownerMatches(item, owner),
                );
        if (
          sourceModel?.manifest.contract.id &&
          sourceModel.manifest.contract.id !== input.contractId
        ) {
          throw new Sim2RealError('sim2real_run_lineage_invalid');
        }
      }
    }
    if (ledger.datasets.length >= DATASET_CAP)
      throw new Sim2RealError('sim2real_storage_quota_exceeded');
    // A versioned dataset is an immutable snapshot.  Keep legacy unversioned
    // imports permissive, but never allow the same logical name/version to be
    // silently replaced by a second payload.
    if (
      input.version &&
      ledger.datasets.some(
        (item) =>
          ownerMatches(item, owner) && item.name === input.name && item.version === input.version,
      )
    ) {
      throw new Sim2RealError('sim2real_dataset_version_exists');
    }
    const now = new Date().toISOString();
    const record: StoredDataset = {
      ...copy(input),
      status,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...(owner ? { owner } : {}),
    };
    await writeLedger({ ...ledger, datasets: [record, ...ledger.datasets] });
    void emitSim2RealEvent('dataset.created', record.id, withoutDatasetPrivate(record), owner);
    return copy(withoutDatasetPrivate(record));
  });
}

export async function getSim2RealDataset(
  id: string,
  owner?: string,
): Promise<Sim2RealDatasetRecord | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const ledger = await readLedger();
  const found = ledger.datasets.find((item) => item.id === wanted && ownerMatches(item, owner));
  return found ? copy(withoutDatasetPrivate(found)) : null;
}

/**
 * Change only the lifecycle marker of an immutable dataset snapshot. Payload
 * metadata (digest, URI, sample count, contract and tags) is intentionally
 * excluded from this API; a correction must be registered as a new version.
 */
export async function updateSim2RealDatasetStatus(
  id: string,
  status: Sim2RealDatasetStatus,
  owner?: string,
): Promise<Sim2RealDatasetRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.datasets.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = ledger.datasets[index];
    if ((current.status ?? 'ready') === 'revoked' && status !== 'revoked') {
      throw new Sim2RealError('sim2real_dataset_not_mutable');
    }
    const currentStatus = current.status ?? 'ready';
    if (!DATASET_STATUS_TRANSITIONS[currentStatus]?.includes(status)) {
      throw new Sim2RealError('sim2real_dataset_transition_invalid');
    }
    if (status === currentStatus && current.status === status) {
      return copy(withoutDatasetPrivate(current));
    }
    const updated: StoredDataset = {
      ...current,
      status,
      updatedAt: new Date().toISOString(),
    };
    const datasets = [...ledger.datasets];
    datasets[index] = updated;
    await writeLedger({ ...ledger, datasets });
    void emitSim2RealEvent('dataset.updated', updated.id, withoutDatasetPrivate(updated), owner);
    return copy(withoutDatasetPrivate(updated));
  });
}

export async function revokeSim2RealDataset(
  id: string,
  owner?: string,
): Promise<Sim2RealDatasetRecord | null> {
  return updateSim2RealDatasetStatus(id, 'revoked', owner);
}

export interface Sim2RealArtifactCreateResult {
  artifact: Sim2RealArtifactRecord;
  duplicate: boolean;
}

export interface Sim2RealArtifactCreateOptions {
  idempotencyKey?: string;
  requestFingerprint?: string;
}

function artifactImmutableFingerprint(
  input: Omit<Sim2RealArtifactRecord, 'id' | 'createdAt' | 'updatedAt'>,
): string {
  // Status/timestamps are lifecycle metadata; the payload identity is the
  // logical version, digest, and all lineage/compatibility fields.
  return JSON.stringify({
    artifactId: input.artifactId,
    version: input.version,
    name: input.name,
    role: input.role,
    kind: input.kind,
    format: input.format,
    runtime: input.runtime ?? null,
    workload: input.workload ?? null,
    threads: input.threads ?? null,
    targetPlatforms: input.targetPlatforms ?? [],
    toolchainTarget: input.toolchainTarget ?? null,
    acceleratorArchitecture: input.acceleratorArchitecture ?? null,
    runtimePackage: input.runtimePackage ?? null,
    ref: input.ref,
    sha256: input.sha256.toLowerCase(),
    sizeBytes: input.sizeBytes ?? null,
    modelId: input.modelId ?? null,
    runId: input.runId ?? null,
    datasetIds: [...(input.datasetIds ?? [])].sort(),
    evaluationIds: [...(input.evaluationIds ?? [])].sort(),
    contractId: input.contractId ?? null,
    metadata: input.metadata ?? null,
  });
}

function visibleModelInLedger(ledger: Sim2RealLedger, modelId: string, owner?: string): boolean {
  return (
    modelId === BUILTIN_MICRODUCK_MODEL.id ||
    modelId === BUILTIN_ORIGINBOT_MODEL.id ||
    ledger.models.some((item) => item.id === modelId && ownerMatches(item, owner))
  );
}

function modelForRunLineage(
  ledger: Sim2RealLedger,
  modelId: string,
  owner?: string,
): Sim2RealModelRecord | StoredModel | null {
  if (modelId === BUILTIN_MICRODUCK_MODEL.id) return BUILTIN_MICRODUCK_MODEL;
  if (modelId === BUILTIN_ORIGINBOT_MODEL.id) return BUILTIN_ORIGINBOT_MODEL;
  return ledger.models.find((item) => item.id === modelId && ownerMatches(item, owner)) ?? null;
}

function artifactLineageError(detail: string): Sim2RealError {
  return new Sim2RealError('sim2real_artifact_lineage_invalid', { detail });
}

/**
 * Register one immutable artifact version.  The JSON ledger stores metadata
 * only; bytes are owned by the configured artifact/object-store adapter and
 * are addressed exclusively through the opaque artifact:// ref.
 */
export async function createSim2RealArtifactWithResult(
  input: Omit<Sim2RealArtifactRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner: string | undefined,
  options: Sim2RealArtifactCreateOptions = {},
): Promise<Sim2RealArtifactCreateResult> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const artifactId = String(input.artifactId ?? '').trim();
    const version = String(input.version ?? '').trim();
    if (!artifactId || !version || version.toLowerCase() === 'latest') {
      throw artifactLineageError('artifactId/version is required and version=latest is forbidden');
    }
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(artifactId)) {
      throw artifactLineageError('artifactId format is invalid');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) {
      throw artifactLineageError('version format is invalid');
    }
    const datasetIds = [
      ...new Set((input.datasetIds ?? []).map((id) => String(id).trim()).filter(Boolean)),
    ];
    const evaluationIds = [
      ...new Set((input.evaluationIds ?? []).map((id) => String(id).trim()).filter(Boolean)),
    ];
    for (const datasetId of datasetIds) {
      if (!ledger.datasets.some((item) => item.id === datasetId && ownerMatches(item, owner))) {
        throw artifactLineageError(`dataset ${datasetId} does not belong to this account`);
      }
    }
    for (const evaluationId of evaluationIds) {
      if (
        !ledger.evaluations.some((item) => item.id === evaluationId && ownerMatches(item, owner))
      ) {
        throw artifactLineageError(`evaluation ${evaluationId} does not belong to this account`);
      }
    }
    let modelId = input.modelId?.trim() || undefined;
    const runId = input.runId?.trim() || undefined;
    if (runId) {
      const run = ledger.runs.find((item) => item.id === runId && ownerMatches(item, owner));
      if (!run) throw artifactLineageError(`run ${runId} does not belong to this account`);
      if (modelId && modelId !== run.modelId) {
        throw artifactLineageError('artifact modelId does not match run.modelId');
      }
      modelId = run.modelId;
    }
    if (modelId && !visibleModelInLedger(ledger, modelId, owner)) {
      throw artifactLineageError(`model ${modelId} does not belong to this account`);
    }
    if (input.contractId && modelId) {
      const model =
        modelId === BUILTIN_MICRODUCK_MODEL.id
          ? BUILTIN_MICRODUCK_MODEL
          : modelId === BUILTIN_ORIGINBOT_MODEL.id
            ? BUILTIN_ORIGINBOT_MODEL
            : ledger.models.find((item) => item.id === modelId && ownerMatches(item, owner));
      if (model && model.manifest.contract.id !== input.contractId) {
        throw artifactLineageError('artifact contractId does not match model contract');
      }
    }
    for (const evaluationId of evaluationIds) {
      const evaluation = ledger.evaluations.find(
        (item) => item.id === evaluationId && ownerMatches(item, owner),
      );
      if (
        !evaluation ||
        (modelId && evaluation.modelId !== modelId) ||
        (runId && evaluation.runId !== runId) ||
        (evaluation.status === 'passed' &&
          (evaluation.attested !== true || evaluation.report?.replay?.attested !== true))
      ) {
        throw artifactLineageError(`evaluation ${evaluationId} does not match artifact lineage`);
      }
    }
    const canonicalModel = modelId ? modelForRunLineage(ledger, modelId, owner) : null;
    const canonicalContractId = canonicalModel?.manifest.contract.id;
    // New registry rows always begin in draft. Publication is an explicit,
    // auditable transition through updateSim2RealArtifactStatus; accepting a
    // terminal status here would let an importer bypass validation entirely.
    if (input.status !== undefined && input.status !== 'draft') {
      throw artifactLineageError('new artifacts must start in draft status');
    }
    const normalized: Omit<Sim2RealArtifactRecord, 'id' | 'createdAt' | 'updatedAt'> = {
      ...copy(input),
      artifactId,
      version,
      ...(modelId ? { modelId } : {}),
      ...(runId ? { runId } : {}),
      datasetIds,
      evaluationIds,
      ...(input.contractId || !canonicalContractId ? {} : { contractId: canonicalContractId }),
      sha256: String(input.sha256 ?? '').toLowerCase(),
      status: 'draft',
    };
    if (!ARTIFACT_STATUS_TRANSITIONS[normalized.status]) {
      throw new Sim2RealError('sim2real_artifact_lineage_invalid');
    }
    if (normalized.status === 'revoked') {
      throw new Sim2RealError('sim2real_artifact_not_mutable');
    }
    const idempotencyKey = String(options.idempotencyKey ?? '').trim();
    if (idempotencyKey) {
      const byKey = ledger.artifacts.find(
        (item) => item._idempotencyKey === idempotencyKey && ownerMatches(item, owner),
      );
      if (byKey) {
        if (
          options.requestFingerprint &&
          byKey._requestFingerprint &&
          options.requestFingerprint !== byKey._requestFingerprint
        ) {
          throw new Sim2RealError('sim2real_artifact_idempotency_conflict');
        }
        return { artifact: copy(withoutArtifactPrivate(byKey)), duplicate: true };
      }
    }
    const sameVersion = ledger.artifacts.find(
      (item) =>
        ownerMatches(item, owner) && item.artifactId === artifactId && item.version === version,
    );
    if (sameVersion) {
      if (artifactImmutableFingerprint(sameVersion) !== artifactImmutableFingerprint(normalized)) {
        throw new Sim2RealError('sim2real_artifact_version_exists');
      }
      return { artifact: copy(withoutArtifactPrivate(sameVersion)), duplicate: true };
    }
    if (ledger.artifacts.length >= ARTIFACT_CAP) {
      throw new Sim2RealError('sim2real_storage_quota_exceeded');
    }
    const now = new Date().toISOString();
    const status = normalized.status;
    if (status === 'published' && !normalized.sha256) {
      throw artifactLineageError('published artifacts require sha256');
    }
    const record: StoredArtifact = {
      ...normalized,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...(status === 'published' ? { publishedAt: now } : {}),
      ...(owner ? { owner } : {}),
      ...(idempotencyKey ? { _idempotencyKey: idempotencyKey } : {}),
      ...(options.requestFingerprint ? { _requestFingerprint: options.requestFingerprint } : {}),
    };
    let runs = ledger.runs;
    if (runId) {
      runs = ledger.runs.map((run) =>
        run.id === runId && ownerMatches(run, owner)
          ? { ...run, artifactIds: [...new Set([...(run.artifactIds ?? []), record.id])] }
          : run,
      );
    }
    await writeLedger({
      ...ledger,
      runs,
      artifacts: [record, ...ledger.artifacts],
    });
    void emitSim2RealEvent('artifact.created', record.id, withoutArtifactPrivate(record), owner);
    return { artifact: copy(withoutArtifactPrivate(record)), duplicate: false };
  });
}

export async function createSim2RealArtifact(
  input: Omit<Sim2RealArtifactRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner?: string,
): Promise<Sim2RealArtifactRecord> {
  return (await createSim2RealArtifactWithResult(input, owner)).artifact;
}

export async function listSim2RealArtifacts(owner?: string): Promise<Sim2RealArtifactRecord[]> {
  const ledger = await readLedger();
  return ledger.artifacts
    .filter((item) => ownerMatches(item, owner))
    .slice(0, ARTIFACT_CAP)
    .map((item) => copy(withoutArtifactPrivate(item)));
}

export async function getSim2RealArtifact(
  id: string,
  owner?: string,
): Promise<Sim2RealArtifactRecord | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const ledger = await readLedger();
  const found = ledger.artifacts.find((item) => item.id === wanted && ownerMatches(item, owner));
  return found ? copy(withoutArtifactPrivate(found)) : null;
}

/** Advance an artifact lifecycle marker without changing immutable payload. */
export async function updateSim2RealArtifactStatus(
  id: string,
  status: Sim2RealArtifactLifecycleStatus,
  owner?: string,
  reason = '',
): Promise<Sim2RealArtifactRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.artifacts.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = ledger.artifacts[index];
    if (!ARTIFACT_STATUS_TRANSITIONS[current.status]?.includes(status)) {
      if (current.status === 'revoked' && status !== 'revoked') {
        throw new Sim2RealError('sim2real_artifact_not_mutable');
      }
      throw new Sim2RealError('sim2real_artifact_lineage_invalid');
    }
    if (current.status === 'revoked' && status !== 'revoked') {
      throw new Sim2RealError('sim2real_artifact_not_mutable');
    }
    if (status === 'published' && !current.sha256) {
      throw artifactLineageError('published artifacts require sha256');
    }
    if (status === 'published' && current.evaluationIds.length) {
      for (const evaluationId of current.evaluationIds) {
        const evaluation = ledger.evaluations.find(
          (item) => item.id === evaluationId && ownerMatches(item, owner),
        );
        if (
          !evaluation ||
          evaluation.status !== 'passed' ||
          evaluation.attested !== true ||
          evaluation.report?.replay?.attested !== true ||
          (current.modelId && evaluation.modelId !== current.modelId) ||
          (current.runId && evaluation.runId !== current.runId)
        ) {
          throw artifactLineageError('published artifacts require passed, attested evaluations');
        }
      }
    }
    if (status === current.status) return copy(withoutArtifactPrivate(current));
    const now = new Date().toISOString();
    const updated: StoredArtifact = {
      ...current,
      status,
      updatedAt: now,
      ...(status === 'published' && !current.publishedAt ? { publishedAt: now } : {}),
      ...(status === 'revoked'
        ? {
            revokedAt: current.revokedAt ?? now,
            ...(reason.trim() ? { revocationReason: reason.trim().slice(0, 500) } : {}),
          }
        : {}),
    };
    const artifacts = [...ledger.artifacts];
    artifacts[index] = updated;
    await writeLedger({ ...ledger, artifacts });
    void emitSim2RealEvent(
      status === 'revoked' ? 'artifact.revoked' : 'artifact.updated',
      updated.id,
      withoutArtifactPrivate(updated),
      owner,
    );
    return copy(withoutArtifactPrivate(updated));
  });
}

export async function validateSim2RealArtifact(
  id: string,
  owner?: string,
): Promise<Sim2RealArtifactRecord | null> {
  return updateSim2RealArtifactStatus(id, 'validated', owner);
}

export async function publishSim2RealArtifact(
  id: string,
  owner?: string,
): Promise<Sim2RealArtifactRecord | null> {
  return updateSim2RealArtifactStatus(id, 'published', owner);
}

/** Revoke an artifact version while preserving all historical evidence. */
export async function revokeSim2RealArtifact(
  id: string,
  reason: string,
  owner?: string,
): Promise<Sim2RealArtifactRecord | null> {
  return updateSim2RealArtifactStatus(id, 'revoked', owner, reason);
}

export async function listSim2RealEvaluations(owner?: string): Promise<Sim2RealEvaluationRecord[]> {
  const ledger = await readLedger();
  return ledger.evaluations
    .filter((item) => ownerMatches(item, owner))
    .slice(0, EVALUATION_CAP)
    .map((item) => copy(withoutEvaluationPrivate(item)));
}

export async function getSim2RealEvaluation(
  id: string,
  owner?: string,
): Promise<Sim2RealEvaluationRecord | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const ledger = await readLedger();
  const found = ledger.evaluations.find((item) => item.id === wanted && ownerMatches(item, owner));
  return found ? copy(withoutEvaluationPrivate(found)) : null;
}

export interface Sim2RealEvaluationCreateResult {
  evaluation: Sim2RealEvaluationRecord;
  duplicate: boolean;
}

export interface Sim2RealEvaluationCreateOptions {
  idempotencyKey?: string;
  requestFingerprint?: string;
  /** Internal server path for a freshly computed, independently attested result. */
  allowInitialTerminal?: boolean;
}

export async function createSim2RealEvaluationWithResult(
  input: Omit<Sim2RealEvaluationRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner: string | undefined,
  options: Sim2RealEvaluationCreateOptions = {},
): Promise<Sim2RealEvaluationCreateResult> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    if (!EVALUATION_STATUS_TRANSITIONS[input.status]) {
      throw new Sim2RealError('sim2real_evaluation_transition_invalid');
    }
    // Public registration is intentionally two-phase: a row starts pending,
    // then a trusted evaluator advances it. The telemetry route may opt into
    // an independently computed terminal result via the internal flag below.
    if (!options.allowInitialTerminal && input.status !== 'pending') {
      throw new Sim2RealError('sim2real_evaluation_transition_invalid');
    }
    if (!['platform', 'runner', 'import'].includes(input.source)) {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    if (input.source === 'import' && input.status === 'passed') {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    const run = ledger.runs.find((item) => item.id === input.runId && ownerMatches(item, owner));
    if (!run || input.modelId !== run.modelId) {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    const requestedTelemetryRevision = String(input.telemetryRevision ?? '').trim();
    if (requestedTelemetryRevision) {
      if (!/^[a-f0-9]{64}$/i.test(requestedTelemetryRevision)) {
        throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
      }
      // The evaluator and materializer are separate API operations for
      // backwards compatibility, so bind a terminal record to the exact
      // snapshot that the serialized evaluator observed. If ingest won the
      // race in between, the run revision is cleared and this operation fails
      // closed instead of publishing a result for an older snapshot.
      if (run.telemetryRevision !== requestedTelemetryRevision) {
        throw new Sim2RealError('sim2real_evaluation_stale');
      }
    } else if (
      options.allowInitialTerminal &&
      input.source === 'platform' &&
      (input.status === 'passed' || input.status === 'failed') &&
      run.telemetryRevision
    ) {
      // A platform terminal result for a run that already has a revision must
      // carry that revision. This prevents a caller from bypassing the
      // freshness binding by omitting the field.
      throw new Sim2RealError('sim2real_evaluation_stale');
    }
    if (input.projectId && input.projectId !== run.projectId) {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    if (input.taskId && run.taskId && input.taskId !== run.taskId) {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    const model = modelForRunLineage(ledger, run.modelId, owner);
    const canonicalContractId = model?.manifest.contract.id;
    if (input.contractId && canonicalContractId && input.contractId !== canonicalContractId) {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    const datasetIds = [
      ...new Set((input.datasetIds ?? []).map((id) => String(id).trim()).filter(Boolean)),
    ];
    for (const datasetId of datasetIds) {
      const dataset = ledger.datasets.find(
        (item) => item.id === datasetId && ownerMatches(item, owner),
      );
      if (!dataset || (dataset.status ?? 'ready') === 'revoked') {
        throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
      }
      if (canonicalContractId && dataset.contractId && dataset.contractId !== canonicalContractId) {
        throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
      }
    }
    let artifact: StoredArtifact | undefined;
    if (input.artifactId) {
      artifact = ledger.artifacts.find(
        (item) => item.id === input.artifactId && ownerMatches(item, owner),
      );
      if (
        !artifact ||
        artifact.status === 'revoked' ||
        (artifact.modelId && artifact.modelId !== run.modelId) ||
        (artifact.runId && artifact.runId !== run.id)
      ) {
        throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
      }
    }
    if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0)) {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    // `stale*` is server-owned metadata. Never accept it from a public body,
    // even when an adapter forwards an object with extra properties.
    const {
      stale: _stale,
      staleAt: _staleAt,
      staleReason: _staleReason,
      telemetryRevision: _telemetryRevision,
      ...safeInput
    } = copy(input) as Omit<Sim2RealEvaluationRecord, 'id' | 'createdAt' | 'updatedAt'>;
    const normalized: Omit<Sim2RealEvaluationRecord, 'id' | 'createdAt' | 'updatedAt'> = {
      ...safeInput,
      runId: run.id,
      modelId: run.modelId,
      datasetIds,
      ...(input.projectId || run.projectId ? { projectId: input.projectId ?? run.projectId } : {}),
      ...(input.taskId || run.taskId ? { taskId: input.taskId ?? run.taskId } : {}),
      ...(input.contractId || !canonicalContractId ? {} : { contractId: canonicalContractId }),
      ...(requestedTelemetryRevision ? { telemetryRevision: requestedTelemetryRevision } : {}),
      summary:
        String(input.summary ?? '')
          .trim()
          .slice(0, 500) || '评测记录已登记。',
    };
    if (normalized.attested !== undefined && typeof normalized.attested !== 'boolean') {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    const idempotencyKey = String(options.idempotencyKey ?? '').trim();
    if (idempotencyKey) {
      const existing = ledger.evaluations.find(
        (item) => item._idempotencyKey === idempotencyKey && ownerMatches(item, owner),
      );
      if (existing) {
        if (
          options.requestFingerprint &&
          existing._requestFingerprint &&
          options.requestFingerprint !== existing._requestFingerprint
        ) {
          throw new Sim2RealError('sim2real_evaluation_idempotency_conflict');
        }
        return { evaluation: copy(withoutEvaluationPrivate(existing)), duplicate: true };
      }
    }
    if (ledger.evaluations.length >= EVALUATION_CAP) {
      throw new Sim2RealError('sim2real_storage_quota_exceeded');
    }
    const now = new Date().toISOString();
    const status = normalized.status;
    const record: StoredEvaluation = {
      ...normalized,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...(status === 'passed' || status === 'failed' || status === 'invalid'
        ? { completedAt: input.completedAt ?? now }
        : {}),
      ...(owner ? { owner } : {}),
      ...(idempotencyKey ? { _idempotencyKey: idempotencyKey } : {}),
      ...(options.requestFingerprint ? { _requestFingerprint: options.requestFingerprint } : {}),
    };
    const runs = ledger.runs.map((item) =>
      item.id === run.id && ownerMatches(item, owner) ? { ...item, evaluationId: record.id } : item,
    );
    const artifacts = artifact
      ? ledger.artifacts.map((item) =>
          item.id === artifact!.id && ownerMatches(item, owner)
            ? { ...item, evaluationIds: [...new Set([...(item.evaluationIds ?? []), record.id])] }
            : item,
        )
      : ledger.artifacts;
    await writeLedger({ ...ledger, runs, artifacts, evaluations: [record, ...ledger.evaluations] });
    void emitSim2RealEvent(
      'evaluation.created',
      record.id,
      withoutEvaluationPrivate(record),
      owner,
    );
    return { evaluation: copy(withoutEvaluationPrivate(record)), duplicate: false };
  });
}

export async function createSim2RealEvaluation(
  input: Omit<Sim2RealEvaluationRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner?: string,
): Promise<Sim2RealEvaluationRecord> {
  return (await createSim2RealEvaluationWithResult(input, owner)).evaluation;
}

/** Update mutable evaluation evidence while enforcing a forward-only state machine. */
export async function updateSim2RealEvaluation(
  id: string,
  patch: Partial<
    Pick<
      Sim2RealEvaluationRecord,
      'status' | 'summary' | 'report' | 'taskEvaluation' | 'deviceId' | 'completedAt'
    >
  >,
  owner?: string,
  options: { trusted?: boolean } = {},
): Promise<Sim2RealEvaluationRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.evaluations.findIndex(
      (item) => item.id === id && ownerMatches(item, owner),
    );
    if (index < 0) return null;
    const current = ledger.evaluations[index];
    const nextStatus = patch.status ?? current.status;
    if (!EVALUATION_STATUS_TRANSITIONS[current.status]?.includes(nextStatus)) {
      throw new Sim2RealError('sim2real_evaluation_transition_invalid');
    }
    if (
      current.status !== nextStatus &&
      (current.status === 'passed' || current.status === 'failed' || current.status === 'invalid')
    ) {
      throw new Sim2RealError('sim2real_evaluation_transition_invalid');
    }
    // A passed result must come from a server-side evaluator (or a future
    // signed runner adapter). The public PATCH route never sets `trusted`, so
    // a caller cannot self-attest arbitrary report fields as release evidence.
    if (nextStatus === 'passed' && options.trusted !== true) {
      throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
    }
    const now = new Date().toISOString();
    const updated: StoredEvaluation = {
      ...current,
      ...copy(patch),
      status: nextStatus,
      summary:
        patch.summary === undefined ? current.summary : String(patch.summary).trim().slice(0, 500),
      updatedAt: now,
      ...(nextStatus === 'passed' || nextStatus === 'failed' || nextStatus === 'invalid'
        ? { completedAt: patch.completedAt ?? current.completedAt ?? now }
        : {}),
    };
    const evaluations = [...ledger.evaluations];
    evaluations[index] = updated;
    await writeLedger({ ...ledger, evaluations });
    void emitSim2RealEvent(
      'evaluation.updated',
      updated.id,
      withoutEvaluationPrivate(updated),
      owner,
    );
    return copy(withoutEvaluationPrivate(updated));
  });
}

export interface Sim2RealLineage {
  project: Sim2RealProjectRecord | null;
  datasets: Sim2RealDatasetRecord[];
  run: Sim2RealRunRecord | null;
  /** All runs in the selected project; `run` is the anchor when one exists. */
  runs: Sim2RealRunRecord[];
  artifacts: Sim2RealArtifactRecord[];
  evaluations: Sim2RealEvaluationRecord[];
  deployments: Sim2RealDeploymentRecord[];
}

/** Return one owner-scoped, bidirectionally linked evidence graph. */
export async function getSim2RealLineage(
  input: { runId?: string; artifactId?: string; evaluationId?: string; projectId?: string },
  owner?: string,
): Promise<Sim2RealLineage | null> {
  const ledger = await readLedger();
  const ownedRuns = ledger.runs.filter((item) => ownerMatches(item, owner));
  const ownedArtifacts = ledger.artifacts.filter((item) => ownerMatches(item, owner));
  const ownedEvaluations = ledger.evaluations.filter((item) => ownerMatches(item, owner));
  const anchorArtifact = input.artifactId
    ? ownedArtifacts.find((item) => item.id === input.artifactId)
    : undefined;
  const anchorEvaluation = input.evaluationId
    ? ownedEvaluations.find((item) => item.id === input.evaluationId)
    : undefined;
  if (input.artifactId && !anchorArtifact) return null;
  if (input.evaluationId && !anchorEvaluation) return null;
  const anchorRun = input.runId
    ? ownedRuns.find((item) => item.id === input.runId)
    : anchorArtifact?.runId
      ? ownedRuns.find((item) => item.id === anchorArtifact.runId)
      : anchorEvaluation
        ? ownedRuns.find((item) => item.id === anchorEvaluation.runId)
        : undefined;
  if (input.runId && !anchorRun) return null;
  const projectId = input.projectId ?? anchorRun?.projectId;
  const project = projectId
    ? ledger.projects.find((item) => item.id === projectId && ownerMatches(item, owner))
    : undefined;
  if (input.projectId && !project) return null;
  const projectRuns = project ? ownedRuns.filter((item) => item.projectId === project.id) : [];
  const runs = [
    ...new Map(
      [...projectRuns, ...(anchorRun ? [anchorRun] : [])].map((item) => [item.id, item]),
    ).values(),
  ];
  const runIds = new Set(runs.map((item) => item.id));
  if (anchorArtifact?.runId) runIds.add(anchorArtifact.runId);
  if (anchorEvaluation?.runId) runIds.add(anchorEvaluation.runId);
  const modelIds = new Set<string>([
    ...(project?.modelIds ?? []),
    ...runs.map((item) => item.modelId),
    ...(anchorArtifact?.modelId ? [anchorArtifact.modelId] : []),
    ...(anchorEvaluation?.modelId ? [anchorEvaluation.modelId] : []),
  ]);
  const artifacts = ownedArtifacts.filter(
    (item) =>
      item.id === input.artifactId ||
      runIds.has(item.runId ?? '') ||
      (!!item.modelId && modelIds.has(item.modelId)),
  );
  const evaluationIds = new Set<string>([
    ...runs.flatMap((item) => (item.evaluationId ? [item.evaluationId] : [])),
    ...artifacts.flatMap((item) => item.evaluationIds ?? []),
    ...(input.evaluationId ? [input.evaluationId] : []),
  ]);
  const evaluations = ownedEvaluations.filter(
    (item) => evaluationIds.has(item.id) || runIds.has(item.runId),
  );
  const datasetIds = new Set<string>([
    ...(project?.datasetIds ?? []),
    ...runs.flatMap((item) => item.datasetIds ?? []),
    ...artifacts.flatMap((item) => item.datasetIds ?? []),
    ...evaluations.flatMap((item) => item.datasetIds ?? []),
  ]);
  const datasets = ledger.datasets.filter(
    (item) => ownerMatches(item, owner) && datasetIds.has(item.id),
  );
  const deployments = ledger.deployments.filter(
    (item) =>
      ownerMatches(item, owner) &&
      (runIds.has(item.runId ?? '') ||
        (!!item.artifactId && artifacts.some((artifact) => artifact.id === item.artifactId)) ||
        (!!item.evaluationId &&
          evaluations.some((evaluation) => evaluation.id === item.evaluationId)) ||
        modelIds.has(item.modelId)),
  );
  return {
    project: project ? copy(withoutProjectPrivate(project)) : null,
    datasets: datasets.map((item) => copy(withoutDatasetPrivate(item))),
    run: anchorRun ? copy(withoutRunPrivate(anchorRun)) : null,
    runs: runs.map((item) => copy(withoutRunPrivate(item))),
    artifacts: artifacts.map((item) => copy(withoutArtifactPrivate(item))),
    evaluations: evaluations.map((item) => copy(withoutEvaluationPrivate(item))),
    deployments: deployments.map((item) => copy(withoutDeploymentPrivate(item))),
  };
}

export async function listSim2RealComputeResources(
  owner?: string,
): Promise<Sim2RealComputeResource[]> {
  const ledger = await readLedger();
  return (ledger.computeResources ?? [])
    .filter((item) => ownerMatches(item, owner))
    .slice(0, 100)
    .map((item) => copy(withoutComputeResourcePrivate(item)));
}

export async function getSim2RealComputeResource(
  id: string,
  owner?: string,
): Promise<Sim2RealComputeResource | null> {
  const ledger = await readLedger();
  const found = (ledger.computeResources ?? []).find(
    (item) => item.id === id && ownerMatches(item, owner),
  );
  return found ? copy(withoutComputeResourcePrivate(found)) : null;
}

export async function getSim2RealComputeResourceSecret(
  id: string,
  owner?: string,
): Promise<{ resource: Sim2RealComputeResource; runnerToken?: string } | null> {
  const ledger = await readLedger();
  const found = (ledger.computeResources ?? []).find(
    (item) => item.id === id && ownerMatches(item, owner),
  );
  return found
    ? {
        resource: copy(withoutComputeResourcePrivate(found)),
        ...(found.runnerToken ? { runnerToken: found.runnerToken } : {}),
      }
    : null;
}

export async function createSim2RealComputeResource(
  input: Omit<Sim2RealComputeResource, 'id' | 'createdAt' | 'updatedAt' | 'tokenConfigured'> & {
    runnerToken?: string;
  },
  owner?: string,
): Promise<Sim2RealComputeResource> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const resources = ledger.computeResources ?? [];
    if (resources.length >= 100) throw new Sim2RealError('sim2real_storage_quota_exceeded');
    const now = new Date().toISOString();
    const record: StoredComputeResource = {
      ...copy(input),
      id: randomUUID(),
      tokenConfigured: Boolean(input.runnerToken),
      createdAt: now,
      updatedAt: now,
      ...(owner ? { owner } : {}),
    };
    await writeLedger({ ...ledger, computeResources: [record, ...resources] });
    return copy(withoutComputeResourcePrivate(record));
  });
}

export async function updateSim2RealComputeResource(
  id: string,
  patch: Partial<
    Pick<
      Sim2RealComputeResource,
      | 'name'
      | 'runnerUrl'
      | 'status'
      | 'gpuName'
      | 'cuda'
      | 'vramMb'
      | 'maxConcurrentJobs'
      | 'message'
      | 'lastCheckedAt'
    >
  > & { runnerToken?: string },
  owner?: string,
): Promise<Sim2RealComputeResource | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const resources = ledger.computeResources ?? [];
    const index = resources.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = resources[index];
    const updated: StoredComputeResource = {
      ...current,
      ...copy(patch),
      ...(patch.runnerToken !== undefined ? { runnerToken: patch.runnerToken } : {}),
      tokenConfigured:
        patch.runnerToken !== undefined ? Boolean(patch.runnerToken) : Boolean(current.runnerToken),
      updatedAt: new Date().toISOString(),
    };
    // A worker's health evidence is bound to the exact endpoint and bearer
    // that were tested. Editing either credential invalidates that evidence;
    // retain the operator's configured concurrency cap, but force a fresh
    // connection test before the resource can launch another run.
    if (patch.runnerUrl !== undefined || patch.runnerToken !== undefined) {
      updated.status = 'unknown';
      updated.message = '尚未重新测试。';
      delete updated.gpuName;
      delete updated.cuda;
      delete updated.vramMb;
      delete updated.lastCheckedAt;
    }
    const next = [...resources];
    next[index] = updated;
    await writeLedger({ ...ledger, computeResources: next });
    return copy(withoutComputeResourcePrivate(updated));
  });
}

export async function deleteSim2RealComputeResource(id: string, owner?: string): Promise<boolean> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const resources = ledger.computeResources ?? [];
    const next = resources.filter((item) => !(item.id === id && ownerMatches(item, owner)));
    if (next.length === resources.length) return false;
    await writeLedger({ ...ledger, computeResources: next });
    return true;
  });
}

export async function getSim2RealModel(
  id: string,
  owner?: string,
): Promise<Sim2RealModelRecord | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  if (wanted === BUILTIN_MICRODUCK_MODEL.id) return copy(BUILTIN_MICRODUCK_MODEL);
  if (wanted === BUILTIN_ORIGINBOT_MODEL.id) return copy(BUILTIN_ORIGINBOT_MODEL);
  const ledger = await readLedger();
  const found = ledger.models.find((item) => item.id === wanted && ownerMatches(item, owner));
  return found ? (copy(withoutOwner(found)) as Sim2RealModelRecord) : null;
}

function normalizeLineageIds(value: unknown): string[] {
  return [
    ...new Set(Array.isArray(value) ? value.map((id) => String(id).trim()).filter(Boolean) : []),
  ];
}

function assertRunLineage(
  ledger: Sim2RealLedger,
  input: Pick<Sim2RealRunRecord, 'modelId' | 'projectId' | 'datasetIds' | 'artifactIds'>,
  owner?: string,
): void {
  if (!visibleModelInLedger(ledger, input.modelId, owner)) {
    throw new Sim2RealError('sim2real_run_lineage_invalid');
  }
  if (
    input.projectId &&
    !ledger.projects.some((item) => item.id === input.projectId && ownerMatches(item, owner))
  ) {
    throw new Sim2RealError('sim2real_run_lineage_invalid');
  }
  const project = input.projectId
    ? ledger.projects.find((item) => item.id === input.projectId && ownerMatches(item, owner))
    : undefined;
  if (project && project.modelIds.length && !project.modelIds.includes(input.modelId)) {
    throw new Sim2RealError('sim2real_run_lineage_invalid');
  }
  const model =
    input.modelId === BUILTIN_MICRODUCK_MODEL.id
      ? BUILTIN_MICRODUCK_MODEL
      : input.modelId === BUILTIN_ORIGINBOT_MODEL.id
        ? BUILTIN_ORIGINBOT_MODEL
        : ledger.models.find((item) => item.id === input.modelId && ownerMatches(item, owner));
  const contractId = model?.manifest.contract.id;
  for (const datasetId of normalizeLineageIds(input.datasetIds)) {
    const dataset = ledger.datasets.find(
      (item) => item.id === datasetId && ownerMatches(item, owner),
    );
    if (!dataset || (dataset.status ?? 'ready') === 'revoked') {
      throw new Sim2RealError('sim2real_run_lineage_invalid');
    }
    if (contractId && dataset.contractId && dataset.contractId !== contractId) {
      throw new Sim2RealError('sim2real_run_lineage_invalid');
    }
  }
  for (const artifactId of normalizeLineageIds(input.artifactIds)) {
    const artifact = ledger.artifacts.find(
      (item) => item.id === artifactId && ownerMatches(item, owner),
    );
    if (
      !artifact ||
      artifact.status === 'revoked' ||
      (artifact.modelId && artifact.modelId !== input.modelId) ||
      (contractId && artifact.contractId && artifact.contractId !== contractId)
    ) {
      throw new Sim2RealError('sim2real_run_lineage_invalid');
    }
  }
}

export async function createSim2RealModel(
  manifest: Sim2RealModelManifest,
  owner?: string,
): Promise<Sim2RealModelRecord> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const duplicate = ledger.models.some(
      (item) =>
        ownerMatches(item, owner) &&
        item.manifest.modelId === manifest.modelId &&
        item.manifest.version === manifest.version,
    );
    if (
      duplicate ||
      manifest.modelId === BUILTIN_MICRODUCK_MODEL.manifest.modelId ||
      manifest.modelId === BUILTIN_ORIGINBOT_MODEL.manifest.modelId
    ) {
      throw new Sim2RealError('sim2real_model_version_exists');
    }
    if (ledger.models.length >= MODEL_CAP) {
      throw new Sim2RealError('sim2real_model_quota_exceeded');
    }
    const now = new Date().toISOString();
    const record: StoredModel = {
      id: randomUUID(),
      manifest: copy(manifest),
      createdAt: now,
      updatedAt: now,
      ...(owner ? { owner } : {}),
    };
    const next: Sim2RealLedger = {
      ...ledger,
      // Keep every idempotency/version record; never evict one tenant's
      // history when another tenant writes. The global cap is checked above.
      models: [record, ...ledger.models],
    };
    await writeLedger(next);
    void emitSim2RealEvent('model.created', record.id, withoutOwner(record), owner);
    return copy(withoutOwner(record)) as Sim2RealModelRecord;
  });
}

export async function listSim2RealRuns(owner?: string): Promise<Sim2RealRunRecord[]> {
  const ledger = await readLedger();
  return ledger.runs
    .filter((item) => ownerMatches(item, owner))
    .slice(0, PUBLIC_RUN_LIST_CAP)
    .map((item) => copy(withoutRunPrivate(item)));
}

export async function getSim2RealRun(
  id: string,
  owner?: string,
): Promise<Sim2RealRunRecord | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const ledger = await readLedger();
  const found = ledger.runs.find((item) => item.id === wanted && ownerMatches(item, owner));
  return found ? copy(withoutRunPrivate(found)) : null;
}

export interface Sim2RealRunIdempotencyMatch {
  run: Sim2RealRunRecord;
  /** Internal fingerprint used by the route to reject key reuse for another request. */
  requestFingerprint?: string;
}

export interface Sim2RealRunReservation {
  run: Sim2RealRunRecord;
  /** True only for the request that atomically inserted the queued record. */
  created: boolean;
}

function isActiveRunnerRun(run: Pick<Sim2RealRunRecord, 'backend' | 'status'>): boolean {
  return (
    (run.backend === 'local' || run.backend === 'robogo') &&
    (run.status === 'queued' || run.status === 'running')
  );
}

/**
 * Terminal run states are immutable from the perspective of runner polling.
 * Two concurrent GET /runs/:id requests can observe different runner
 * snapshots; without this guard a late `running` response could resurrect a
 * completed job (and make the UI show a finished training as active again).
 *
 * `blocked` is deliberately included: a blocked run is set at creation time
 * (missing account token, misconfigured backend, absent GPU resource) and
 * never owns an externalRunId, so no runner poll can legitimately move it.
 * Re-running the task creates a fresh run record with a new idempotency key
 * instead of unblocking the old one.
 */
function isTerminalRunStatus(status: Sim2RealRunStatus): boolean {
  return (
    status === 'ready' || status === 'completed' || status === 'blocked' || status === 'failed'
  );
}

function expireStaleActiveRunnerRuns(
  ledger: Sim2RealLedger,
  nowMs = Date.now(),
): { ledger: Sim2RealLedger; changed: boolean } {
  const ttlMs = sim2RealActiveRunTtlSeconds() * 1_000;
  const cutoff = nowMs - ttlMs;
  const finishedAt = new Date(nowMs).toISOString();
  let changed = false;
  const runs = ledger.runs.map((run) => {
    const createdAtMs = Date.parse(run.createdAt);
    if (
      !isActiveRunnerRun(run) ||
      // A run that already has an external id is a real runner job.  Its
      // duration is controlled by the runner, not by this crash-window TTL;
      // expiring it here would make a long RL job look failed while it is
      // still consuming compute.
      run.externalRunId ||
      run.finishedAt ||
      !Number.isFinite(createdAtMs) ||
      createdAtMs > cutoff
    ) {
      return run;
    }
    changed = true;
    return {
      ...run,
      status: 'failed' as const,
      summary:
        '训练预留超过有效时限且未收到 runner 状态，平台已自动终止并释放并发名额；如需继续请重新提交。',
      finishedAt,
    };
  });
  return changed ? { ledger: { ...ledger, runs }, changed } : { ledger, changed: false };
}

export async function findSim2RealRunByIdempotency(
  idempotencyKey: string,
  owner?: string,
): Promise<Sim2RealRunIdempotencyMatch | null> {
  const key = String(idempotencyKey ?? '').trim();
  if (!key) return null;
  const ledger = await readLedger();
  const found = ledger.runs.find(
    (item) => item._idempotencyKey === key && ownerMatches(item, owner),
  );
  return found
    ? {
        run: copy(withoutRunPrivate(found)),
        ...(found._requestFingerprint ? { requestFingerprint: found._requestFingerprint } : {}),
      }
    : null;
}

/**
 * Atomically claim an idempotent run before calling an external runner.
 *
 * A normal read followed by a runner call is racy: two HTTP requests can both
 * observe no existing run and charge/launch the runner twice.  The ledger's
 * serialized write chain gives the standalone service a small, deterministic
 * reservation point.  The caller updates the reserved record after the
 * runner responds; if the process dies in between, the queued record remains
 * visible for an operator to reconcile rather than silently creating a second
 * job on retry.
 */
export async function reserveSim2RealRun(
  input: Omit<Sim2RealRunRecord, 'id' | 'createdAt'>,
  owner: string | undefined,
  options: {
    idempotencyKey: string;
    requestFingerprint?: string;
    /** Maximum queued/running local+RoboGo jobs for this owner. */
    maxActiveRuns?: number;
  },
): Promise<Sim2RealRunReservation> {
  ensureWritable();
  const idempotencyKey = String(options.idempotencyKey ?? '').trim();
  if (!idempotencyKey) throw new Sim2RealError('sim2real_run_idempotency_required');
  return serialized(async () => {
    // A process crash can leave a queued reservation without an external
    // runner id. Reap only that narrow crash window before counting active
    // jobs, otherwise one lost request can permanently consume a quota slot.
    // Persist the sweep even when this call later returns a quota error so a
    // subsequent retry observes the released slot.
    const loaded = await readLedger();
    const expired = expireStaleActiveRunnerRuns(loaded);
    const ledger = expired.changed ? expired.ledger : loaded;
    if (expired.changed) await writeLedger(ledger);
    assertRunLineage(ledger, input, owner);
    const existing = ledger.runs.find(
      (item) => item._idempotencyKey === idempotencyKey && ownerMatches(item, owner),
    );
    if (existing) {
      if (
        options.requestFingerprint &&
        existing._requestFingerprint &&
        options.requestFingerprint !== existing._requestFingerprint
      ) {
        throw new Sim2RealError('sim2real_run_idempotency_conflict');
      }
      return { run: copy(withoutRunPrivate(existing)), created: false };
    }
    const maxActiveRuns = options.maxActiveRuns;
    if (maxActiveRuns !== undefined) {
      const activeCount = ledger.runs.filter(
        (item) => ownerMatches(item, owner) && isActiveRunnerRun(item),
      ).length;
      if (activeCount >= maxActiveRuns) {
        throw new Sim2RealError('sim2real_active_run_quota_exceeded');
      }
    }
    const record: StoredRun = {
      ...copy(input),
      ...(input.productId
        ? {}
        : modelForRunLineage(ledger, input.modelId, owner)?.manifest.robot.id
          ? { productId: modelForRunLineage(ledger, input.modelId, owner)!.manifest.robot.id }
          : {}),
      ...(input.contractId
        ? {}
        : modelForRunLineage(ledger, input.modelId, owner)?.manifest.contract.id
          ? { contractId: modelForRunLineage(ledger, input.modelId, owner)!.manifest.contract.id }
          : {}),
      ...(input.datasetIds ? { datasetIds: normalizeLineageIds(input.datasetIds) } : {}),
      ...(input.artifactIds ? { artifactIds: normalizeLineageIds(input.artifactIds) } : {}),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
      _idempotencyKey: idempotencyKey,
      ...(options.requestFingerprint ? { _requestFingerprint: options.requestFingerprint } : {}),
    };
    if (ledger.runs.length >= RUN_CAP) {
      throw new Sim2RealError('sim2real_run_quota_exceeded');
    }
    await writeLedger({ ...ledger, runs: [record, ...ledger.runs] });
    void emitSim2RealEvent('run.created', record.id, withoutRunPrivate(record), owner);
    return { run: copy(withoutRunPrivate(record)), created: true };
  });
}

export async function createSim2RealRun(
  input: Omit<Sim2RealRunRecord, 'id' | 'createdAt'>,
  owner?: string,
  options: { idempotencyKey?: string; requestFingerprint?: string } = {},
): Promise<Sim2RealRunRecord> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    assertRunLineage(ledger, input, owner);
    const idempotencyKey = String(options.idempotencyKey ?? '').trim();
    if (idempotencyKey) {
      const existing = ledger.runs.find(
        (item) => item._idempotencyKey === idempotencyKey && ownerMatches(item, owner),
      );
      if (existing) {
        if (
          options.requestFingerprint &&
          existing._requestFingerprint &&
          options.requestFingerprint !== existing._requestFingerprint
        ) {
          throw new Sim2RealError('sim2real_run_idempotency_conflict');
        }
        return copy(withoutRunPrivate(existing));
      }
    }
    const record: StoredRun = {
      ...copy(input),
      ...(input.productId
        ? {}
        : modelForRunLineage(ledger, input.modelId, owner)?.manifest.robot.id
          ? { productId: modelForRunLineage(ledger, input.modelId, owner)!.manifest.robot.id }
          : {}),
      ...(input.contractId
        ? {}
        : modelForRunLineage(ledger, input.modelId, owner)?.manifest.contract.id
          ? { contractId: modelForRunLineage(ledger, input.modelId, owner)!.manifest.contract.id }
          : {}),
      ...(input.datasetIds ? { datasetIds: normalizeLineageIds(input.datasetIds) } : {}),
      ...(input.artifactIds ? { artifactIds: normalizeLineageIds(input.artifactIds) } : {}),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
      ...(idempotencyKey ? { _idempotencyKey: idempotencyKey } : {}),
      ...(options.requestFingerprint ? { _requestFingerprint: options.requestFingerprint } : {}),
    };
    if (ledger.runs.length >= RUN_CAP) {
      throw new Sim2RealError('sim2real_run_quota_exceeded');
    }
    await writeLedger({ ...ledger, runs: [record, ...ledger.runs] });
    void emitSim2RealEvent('run.created', record.id, withoutRunPrivate(record), owner);
    return copy(withoutRunPrivate(record));
  });
}

type RunPatch = Partial<
  Pick<
    Sim2RealRunRecord,
    | 'status'
    | 'summary'
    | 'launchUrl'
    | 'externalRunId'
    | 'metrics'
    | 'taskEvaluation'
    | 'evaluation'
    | 'checkpoint'
    | 'progress'
    | 'finishedAt'
    | 'mock'
    | 'artifact'
    | 'relayLastSeenAt'
  >
>;

export async function updateSim2RealRun(
  id: string,
  patch: RunPatch,
  owner?: string,
): Promise<Sim2RealRunRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.runs.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = ledger.runs[index];
    // Runner status polling is inherently out of order. Once a run reaches a
    // terminal state, ignore a late active/other status update instead of
    // allowing stale observations to move it backwards in the lifecycle.
    if (
      isTerminalRunStatus(current.status) &&
      patch.status !== undefined &&
      patch.status !== current.status
    ) {
      return copy(withoutRunPrivate(current));
    }
    const updated: StoredRun = {
      ...current,
      ...copy(patch),
    };
    const runs = [...ledger.runs];
    runs[index] = updated;
    await writeLedger({ ...ledger, runs });
    void emitSim2RealEvent('run.updated', updated.id, withoutRunPrivate(updated), owner);
    return copy(withoutRunPrivate(updated));
  });
}

/**
 * Attach a runner id during the reconciliation crash window.
 *
 * Reconciliation first performs an intentionally slow, read-only runner
 * lookup.  Two operators can therefore read the same queued record before
 * either lookup returns.  Keep the final attach as a compare-and-set inside
 * the store's serialized write chain: only an active local/RoboGo run that
 * still has no external id may be claimed.  A null result means another
 * request won the claim (or the run changed state), so callers must not
 * overwrite the winner.
 */
export async function updateSim2RealRunForReconcile(
  id: string,
  patch: RunPatch,
  owner?: string,
): Promise<Sim2RealRunRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.runs.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = ledger.runs[index];
    const hasExternalRunId = String(current.externalRunId ?? '').trim().length > 0;
    if (!isActiveRunnerRun(current) || hasExternalRunId) return null;
    const updated: StoredRun = {
      ...current,
      ...copy(patch),
    };
    const runs = [...ledger.runs];
    runs[index] = updated;
    await writeLedger({ ...ledger, runs });
    void emitSim2RealEvent('run.updated', updated.id, withoutRunPrivate(updated), owner);
    return copy(withoutRunPrivate(updated));
  });
}

/**
 * Browser-relay claim: attach the worker's runId to a queued relay run.
 *
 * The browser submits the job to its loopback agent and then claims the
 * ledger run with the worker's `runId`. Two tabs can submit the same
 * idempotent run; only an active relay run (backend `local`, status queued,
 * relay agent URL set, no external id yet) may be claimed, so the first
 * reporter wins and later ones see the winner's answer instead of racing.
 * A null result means the run was already claimed, terminal, or not a relay
 * run — callers must surface that, not overwrite it.
 */
export async function claimSim2RealRunRelay(
  id: string,
  externalRunId: string,
  owner?: string,
): Promise<Sim2RealRunRecord | null> {
  const external = String(externalRunId ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(external)) return null;
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.runs.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = ledger.runs[index];
    const hasExternalRunId = String(current.externalRunId ?? '').trim().length > 0;
    if (
      current.backend !== 'local' ||
      !current.relayAgentUrl ||
      !(current.status === 'queued' || current.status === 'running') ||
      hasExternalRunId
    ) {
      return null;
    }
    const updated: StoredRun = {
      ...current,
      externalRunId: external,
      status: 'running',
      relayLastSeenAt: new Date().toISOString(),
    };
    const runs = [...ledger.runs];
    runs[index] = updated;
    await writeLedger({ ...ledger, runs });
    void emitSim2RealEvent('run.updated', updated.id, withoutRunPrivate(updated), owner);
    return copy(withoutRunPrivate(updated));
  });
}

// ---- relay artifact byte store ---------------------------------------------
// Browser-relayed runs cannot serve policy.onnx lazily from a worker the
// server cannot reach. The browser uploads the verified bytes once; they are
// stored on disk keyed by content digest (same verify-before-serve chain the
// worker itself uses) and every read re-hashes them.

function relayArtifactDir(): string {
  return path.join(path.dirname(ledgerPath()), 'relay-artifacts');
}

function relayArtifactPath(sha256: string): string | null {
  return /^[a-f0-9]{64}$/.test(sha256) ? path.join(relayArtifactDir(), `${sha256}.onnx`) : null;
}

/**
 * Persist an uploaded relay artifact. The digest must already be the
 * server-computed hash of exactly these bytes (callers verify before calling
 * so a mismatch never reaches disk). Idempotent: a second upload of the same
 * content is a no-op.
 */
export async function storeSim2RealRelayArtifact(sha256: string, bytes: Buffer): Promise<void> {
  const file = relayArtifactPath(sha256);
  if (!file) throw new Sim2RealError('sim2real_relay_artifact_digest_invalid');
  ensureWritable();
  await fs.mkdir(relayArtifactDir(), { recursive: true });
  await fs.writeFile(file, bytes, { mode: 0o600 });
}

/**
 * Read a stored relay artifact, re-verifying the content digest. A missing
 * file, an unreadable file, or a tampered file all return null — callers
 * fail closed rather than serving unverified bytes.
 */
export async function readSim2RealRelayArtifact(sha256: string): Promise<Buffer | null> {
  const file = relayArtifactPath(sha256);
  if (!file) return null;
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch {
    return null;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
  return bytes;
}

export interface Sim2RealRunEvaluationContext {
  /** A public copy of the run being evaluated; private ledger fields are omitted. */
  run: Sim2RealRunRecord;
  /** Every accepted telemetry chunk for the run, in ledger order. */
  telemetry: Sim2RealTelemetryRecord[];
  /** Stable identity of the accepted telemetry snapshot. */
  telemetryRevision: string;
}

/**
 * Compute and persist a run evaluation as one serialized ledger operation.
 *
 * Reading telemetry, calculating a summary, and then calling
 * `updateSim2RealRun` from a route leaves a stale-write window: an ingest can
 * append a newer chunk (and clear the cached evaluation) between the read and
 * the update, after which the old summary would be written back.  Keep the
 * read/compute/write sequence inside the same write chain instead.  An
 * append that wins first clears the old summary and is then observed by this
 * callback; an append that follows this operation clears the freshly written
 * summary.  In neither order can an older evaluation overwrite newer data.
 */
export async function evaluateSim2RealRun(
  id: string,
  owner: string | undefined,
  evaluator: (context: Sim2RealRunEvaluationContext) => Sim2RealEvaluationSummary,
): Promise<{
  run: Sim2RealRunRecord;
  evaluation: Sim2RealEvaluationSummary;
  telemetryRevision: string;
} | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.runs.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = ledger.runs[index];
    const telemetry = (await loadRunTelemetry(id, owner)).map((item) =>
      copy(withoutTelemetryPrivate(item as StoredTelemetry)),
    );
    const revision = telemetryRevision(telemetry);
    const context: Sim2RealRunEvaluationContext = {
      run: copy(withoutRunPrivate(current)),
      // Full chunks (samples) come from the run shard; the ledger keeps only
      // index rows now. Legacy inline rows are merged in by loadRunTelemetry.
      telemetry,
      telemetryRevision: revision,
    };
    // Copy the callback result before putting it into the ledger so a caller
    // cannot mutate the in-memory cache after this serialized operation.
    const evaluation = copy(evaluator(context));
    const updated: StoredRun = {
      ...current,
      evaluation,
      telemetryRevision: revision,
    };
    const runs = [...ledger.runs];
    runs[index] = updated;
    await writeLedger({ ...ledger, runs });
    void emitSim2RealEvent('run.updated', updated.id, withoutRunPrivate(updated), owner);
    return {
      run: copy(withoutRunPrivate(updated)),
      evaluation: copy(evaluation),
      telemetryRevision: revision,
    };
  });
}

/**
 * Full chunks for one run: shard records plus any legacy ledger rows that
 * still carry inline samples, in the deterministic replay order.
 */
async function loadRunTelemetry(runId: string, owner?: string): Promise<TelemetryShardRecord[]> {
  const ledger = await readLedger();
  const indexedIds = committedTelemetryIds(ledger, runId, owner);
  const inlineLegacy = ledger.telemetry.filter(
    (item) => item.runId === runId && ownerMatches(item, owner) && Array.isArray(item.samples),
  ) as unknown as TelemetryShardRecord[];
  const merged = [...(await readTelemetryShard(runId, owner, indexedIds)), ...inlineLegacy];
  return merged.sort(compareTelemetryRecords);
}

/**
 * Bounded counterpart of `loadRunTelemetry` for the list endpoint.
 *
 * The caller wants the first `maxRecords` rows of `shard ∪ inlineLegacy`.
 * Shard rows are stored in append order; while chunks are accepted in sequence
 * order that is also `compareTelemetryRecords` order, so the smallest rows sit
 * at the head of the file. Legacy inline rows live in the ledger and can sort
 * anywhere in that union: at most `inlineLegacy.length` of them can rank ahead
 * of a shard row that belongs in the answer, which is why the head read asks
 * for `maxRecords + inlineLegacy.length` rows rather than just `maxRecords`.
 *
 * That head size alone is only exact while append order matches sort order, so
 * the result is verified against the lightweight ledger index rows (which hold
 * the same sequence/receivedAt/id, minus samples) before it is trusted. A chunk
 * accepted out of sequence — allowed when its logical timeline is still
 * monotonic — or a same-millisecond `receivedAt` tie makes the head miss a row
 * that belongs in the answer; the check detects that and falls back to the
 * complete reader, so correctness never depends on the ordering assumption.
 */
async function loadRunTelemetryBounded(
  runId: string,
  owner: string | undefined,
  maxRecords: number,
): Promise<TelemetryShardRecord[]> {
  const ledger = await readLedger();
  const inlineLegacy = ledger.telemetry.filter(
    (item) => item.runId === runId && ownerMatches(item, owner) && Array.isArray(item.samples),
  ) as unknown as TelemetryShardRecord[];
  const headSize = maxRecords + inlineLegacy.length;
  const indexedIds = committedTelemetryIds(ledger, runId, owner);
  const head = await readTelemetryShardBounded(runId, owner, headSize, indexedIds);
  // A short head means the bounded read already reached the end of the shard,
  // so it is the whole shard and needs no verification. Otherwise every
  // shard-backed row in the ledger's top `headSize` must be present in it.
  if (head.length === headSize && !headCoversIndexedTop(runId, owner, ledger, head, headSize)) {
    return loadRunTelemetry(runId, owner);
  }
  return [...head, ...inlineLegacy].sort(compareTelemetryRecords).slice(0, maxRecords);
}

/**
 * Whether `head` already contains every shard-backed row among the ledger's
 * first `headSize` rows for this run. Legacy inline rows are checked directly
 * by the caller, so only shard-backed index rows need to be present in `head`.
 */
function headCoversIndexedTop(
  runId: string,
  owner: string | undefined,
  ledger: Sim2RealLedger,
  head: readonly TelemetryShardRecord[],
  headSize: number,
): boolean {
  const candidates = ledger.telemetry
    .filter((item) => item.runId === runId && ownerMatches(item, owner))
    .sort(compareTelemetryRecords);
  const headIds = new Set(head.map((record) => record.id));
  for (const row of candidates.slice(0, headSize)) {
    if (Array.isArray(row.samples)) continue;
    if (!headIds.has(row.id)) return false;
  }
  return true;
}

export async function listSim2RealTelemetry(
  runId: string,
  owner?: string,
  limit = 200,
): Promise<Sim2RealTelemetryRecord[]> {
  // Keep normal list responses small while allowing the evaluation endpoint
  // to inspect a longer run without silently discarding most of its chunks.
  const bounded = Math.max(
    1,
    Math.min(SIM2REAL_TELEMETRY_RECORD_CAP, Math.floor(Number(limit) || 200)),
  );
  // Replay/evaluation request the full cap and must keep the complete,
  // unchanged read path; every smaller limit reads only a bounded shard head.
  const records =
    bounded < SIM2REAL_TELEMETRY_RECORD_CAP
      ? await loadRunTelemetryBounded(runId, owner, bounded)
      : await loadRunTelemetry(runId, owner);
  return records
    .slice(0, bounded)
    .map((item) => copy(withoutTelemetryPrivate(item as StoredTelemetry)));
}

export async function findSim2RealTelemetryByIdempotency(
  runId: string,
  idempotencyKey: string,
  owner?: string,
): Promise<Sim2RealTelemetryRecord | null> {
  const ledger = await readLedger();
  const found = ledger.telemetry.find(
    (item) =>
      item.runId === runId && item.idempotencyKey === idempotencyKey && ownerMatches(item, owner),
  );
  if (!found) return null;
  // Index rows carry no samples; rehydrate from the shard when the caller
  // needs the full record.
  const full = (
    await readTelemetryShard(runId, owner, committedTelemetryIds(ledger, runId, owner))
  ).find((item) => item.id === found.id);
  const resolved = full ?? found;
  return resolved ? copy(withoutTelemetryPrivate(resolved as StoredTelemetry)) : null;
}

export interface Sim2RealTelemetryAppendResult {
  telemetry: Sim2RealTelemetryRecord;
  duplicate: boolean;
}

/** Append a telemetry chunk with an atomic idempotency check. */
export async function appendSim2RealTelemetryWithResult(
  input: Omit<Sim2RealTelemetryRecord, 'id' | 'receivedAt'> & {
    /** Internal route-only value used to reject key reuse with another payload. */
    _requestFingerprint?: string;
  },
  owner?: string,
): Promise<Sim2RealTelemetryAppendResult> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const requestFingerprint = input._requestFingerprint || telemetryRequestFingerprint(input);
    const contentFingerprint = telemetryContentFingerprint(input);
    if (input.idempotencyKey) {
      const existing = ledger.telemetry.find(
        (item) =>
          item.runId === input.runId &&
          item.idempotencyKey === input.idempotencyKey &&
          ownerMatches(item, owner),
      );
      if (existing) {
        if (
          requestFingerprint &&
          existing._requestFingerprint &&
          requestFingerprint !== existing._requestFingerprint
        ) {
          throw new Sim2RealError('sim2real_telemetry_idempotency_conflict');
        }
        const full = (
          await readTelemetryShard(
            input.runId,
            owner,
            committedTelemetryIds(ledger, input.runId, owner),
          )
        ).find((item) => item.id === existing.id);
        const resolved = full ?? existing;
        return {
          telemetry: copy(withoutTelemetryPrivate(resolved as StoredTelemetry)),
          duplicate: true,
        };
      }
    }
    // Signed board uploads may be retried after a network timeout with a new
    // HTTP idempotency key. A sequence is the durable chunk identity: the same
    // sequence and digest is a duplicate, while reusing a sequence with other
    // bytes is rejected. Do not deduplicate solely by content because a real
    // robot can legitimately emit two identical stationary chunks.
    if (input.attested === true && input.source === 'board-agent') {
      if (input.sequence === undefined) {
        throw new Sim2RealError('sim2real_telemetry_attestation_sequence_required');
      }
      const sameSequence = ledger.telemetry.find(
        (item) =>
          item.runId === input.runId &&
          item.deviceId === input.deviceId &&
          item.source === 'board-agent' &&
          item.sequence === input.sequence &&
          ownerMatches(item, owner) &&
          item.attested === true,
      );
      if (sameSequence) {
        const full = (
          await readTelemetryShard(
            input.runId,
            owner,
            committedTelemetryIds(ledger, input.runId, owner),
          )
        ).find((item) => item.id === sameSequence.id);
        const existingContent =
          sameSequence._contentFingerprint ||
          (full ? telemetryContentFingerprint(full) : undefined);
        if (existingContent === contentFingerprint) {
          const resolved = full ?? sameSequence;
          return {
            telemetry: copy(withoutTelemetryPrivate(resolved as StoredTelemetry)),
            duplicate: true,
          };
        }
        throw new Sim2RealError('sim2real_telemetry_idempotency_conflict');
      }
    }
    const { _requestFingerprint: _fingerprint, ...publicInput } = input;
    const record: StoredTelemetry = {
      ...copy(publicInput),
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
      ...(requestFingerprint ? { _requestFingerprint: requestFingerprint } : {}),
      ...(contentFingerprint ? { _contentFingerprint: contentFingerprint } : {}),
    };
    // Retention is evaluated before quota accounting.  Otherwise rows that
    // are about to be removed from this run still consume the owner/run byte
    // and sample budgets, making an enabled retention policy unable to free
    // capacity.  Physical pruning remains scoped to the run being appended;
    // untouched historical runs are reclaimed on their next append (or by the
    // explicit storage maintenance job).
    const retentionDays = sim2RealTelemetryRetentionDays();
    const expiredIndexIds =
      retentionDays > 0
        ? expiredTelemetryIndexIds(
            ledger,
            input.runId,
            owner,
            Date.now() - retentionDays * MS_PER_DAY,
          )
        : new Set<string>();

    // Quota and timeline checks run over the full chunk history (shard plus
    // legacy inline rows), not the sample-stripped index rows. Rows selected
    // for this append's retention prune are excluded from both checks.
    const runHistory = (await loadRunTelemetry(input.runId, owner)).filter(
      (item) => !expiredIndexIds.has(item.id),
    );
    const ownerHistory: TelemetryShardRecord[] = [];
    const loadedShardRuns = new Set<string>();
    for (const item of ledger.telemetry) {
      if (!ownerMatches(item, owner)) continue;
      // Inline rows and shard-backed rows can coexist for a run after an
      // upgrade/import. Count each inline row, while loading that run's shard
      // exactly once even when the first index row still carries samples.
      if (Array.isArray(item.samples) && item.samples.length && !expiredIndexIds.has(item.id)) {
        ownerHistory.push(item as unknown as TelemetryShardRecord);
      }
      if (!loadedShardRuns.has(item.runId)) {
        loadedShardRuns.add(item.runId);
        ownerHistory.push(
          ...(
            await readTelemetryShard(
              item.runId,
              owner,
              committedTelemetryIds(ledger, item.runId, owner),
            )
          ).filter(
            (shardItem) => ownerMatches(shardItem, owner) && !expiredIndexIds.has(shardItem.id),
          ),
        );
      }
    }
    assertTelemetryTimeline(runHistory as unknown as StoredTelemetry[], record, owner);
    const incomingUsage = telemetryUsage([record]);
    const runUsage = telemetryUsage(runHistory as unknown as StoredTelemetry[]);
    if (
      runUsage.samples + incomingUsage.samples > SIM2REAL_TELEMETRY_LIMITS.runSamples ||
      runUsage.bytes + incomingUsage.bytes > SIM2REAL_TELEMETRY_LIMITS.runBytes
    ) {
      throw new Sim2RealError('sim2real_telemetry_quota_exceeded');
    }
    const ownerUsage = telemetryUsage(ownerHistory as unknown as StoredTelemetry[]);
    if (
      ownerUsage.samples + incomingUsage.samples > SIM2REAL_TELEMETRY_LIMITS.ownerSamples ||
      ownerUsage.bytes + incomingUsage.bytes > SIM2REAL_TELEMETRY_LIMITS.ownerBytes
    ) {
      throw new Sim2RealError('sim2real_telemetry_quota_exceeded');
    }
    // Count the record cap against the index rows that will remain after the
    // prune, so retention actually frees room instead of permanently pinning
    // the store at its limit.
    if (ledger.telemetry.length - expiredIndexIds.size >= SIM2REAL_TELEMETRY_RECORD_CAP) {
      throw new Sim2RealError('sim2real_telemetry_quota_exceeded');
    }
    // Shard first, then the index row: a crash between the two leaves an
    // orphan shard line the ledger does not reference (invisible), never a
    // dangling index row pointing at missing samples.
    await appendTelemetryShard(record);
    // A new chunk changes the replay/evaluation input. Clear the cached
    // summary in the same serialized write so GET /replay can never return a
    // stale score after an import (and a concurrent append cannot race a
    // separate "clear evaluation" update).
    const now = new Date().toISOString();
    const evaluations = ledger.evaluations.map((item) =>
      item.runId === record.runId &&
      ownerMatches(item, owner) &&
      item.status === 'passed' &&
      item.stale !== true
        ? {
            ...item,
            stale: true,
            staleAt: now,
            staleReason: 'new telemetry appended; rerun evaluation',
            updatedAt: now,
          }
        : item,
    );
    const runs = ledger.runs.map((item) =>
      item.id === record.runId && ownerMatches(item, owner)
        ? {
            ...item,
            evaluation: undefined,
            evaluationId: undefined,
            telemetryRevision: undefined,
          }
        : item,
    );
    const { samples: _samples, ...indexRow } = record;
    const retainedIndexRows = expiredIndexIds.size
      ? ledger.telemetry.filter((item) => !expiredIndexIds.has(item.id))
      : ledger.telemetry;
    await writeLedger({
      ...ledger,
      runs,
      evaluations,
      telemetry: [indexRow as StoredTelemetry, ...retainedIndexRows],
    });
    // The shard is rewritten after the index rows are durable. A crash in
    // between leaves expired lines the ledger no longer indexes (a read may
    // still merge them until the next successful prune), never an index row
    // whose samples no longer exist anywhere.
    if (expiredIndexIds.size) {
      const shard = telemetryShardPath(record.runId);
      if (shard) await rewriteTelemetryShardWithout(shard, expiredIndexIds);
    }
    void emitSim2RealEvent(
      'telemetry.appended',
      record.runId,
      {
        telemetryId: record.id,
        sequence: record.sequence,
        sampleCount: Array.isArray(record.samples) ? record.samples.length : 0,
        ...(record.attested === true ? { attested: true } : {}),
      },
      owner,
    );
    return {
      telemetry: copy(withoutTelemetryPrivate(record)),
      duplicate: false,
    };
  });
}

/** Backwards-compatible record-only helper for adapters that do not need the flag. */
export async function appendSim2RealTelemetry(
  input: Omit<Sim2RealTelemetryRecord, 'id' | 'receivedAt'> & {
    _requestFingerprint?: string;
  },
  owner?: string,
): Promise<Sim2RealTelemetryRecord> {
  return (await appendSim2RealTelemetryWithResult(input, owner)).telemetry;
}

export async function listSim2RealDeployments(owner?: string): Promise<Sim2RealDeploymentRecord[]> {
  const ledger = await readLedger();
  return ledger.deployments
    .filter((item) => ownerMatches(item, owner))
    .slice(0, DEPLOYMENT_CAP)
    .map((item) => copy(withoutDeploymentPrivate(item)));
}

export async function getSim2RealDeployment(
  id: string,
  owner?: string,
): Promise<Sim2RealDeploymentRecord | null> {
  const ledger = await readLedger();
  const found = ledger.deployments.find((item) => item.id === id && ownerMatches(item, owner));
  return found ? copy(withoutDeploymentPrivate(found)) : null;
}

export interface Sim2RealDeploymentCreateResult {
  deployment: Sim2RealDeploymentRecord;
  duplicate: boolean;
}

/** Atomically create or replay a deployment plan for a client idempotency key. */
export async function createSim2RealDeploymentWithResult(
  input: Omit<Sim2RealDeploymentRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner: string | undefined,
  options: { idempotencyKey?: string; requestFingerprint?: string } = {},
): Promise<Sim2RealDeploymentCreateResult> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    if (input.mode !== 'preflight' && (!input.runId || !input.artifactId || !input.evaluationId)) {
      // A canary/live plan is a release record, not merely a device command.
      // Require all three first-class lineage anchors so an old embedded-only
      // run cannot bypass immutable artifact/evaluation provenance.
      throw new Sim2RealError('sim2real_artifact_lineage_invalid');
    }
    if (input.artifactId) {
      const artifact = ledger.artifacts.find(
        (item) => item.id === input.artifactId && ownerMatches(item, owner),
      );
      if (!artifact || artifact.status !== 'published') {
        throw new Sim2RealError('sim2real_artifact_lineage_invalid');
      }
      if (
        input.mode !== 'preflight' &&
        (artifact.modelId !== input.modelId || artifact.runId !== input.runId)
      ) {
        throw new Sim2RealError('sim2real_artifact_lineage_invalid');
      }
      if (artifact.modelId && artifact.modelId !== input.modelId) {
        throw new Sim2RealError('sim2real_artifact_lineage_invalid');
      }
      if (input.runId && artifact.runId && artifact.runId !== input.runId) {
        throw new Sim2RealError('sim2real_artifact_lineage_invalid');
      }
    }
    if (input.evaluationId) {
      const evaluation = ledger.evaluations.find(
        (item) => item.id === input.evaluationId && ownerMatches(item, owner),
      );
      const releaseRun = input.runId
        ? ledger.runs.find((item) => item.id === input.runId && ownerMatches(item, owner))
        : undefined;
      if (
        evaluation?.stale === true ||
        (evaluation?.telemetryRevision &&
          (!releaseRun ||
            releaseRun.telemetryRevision !== evaluation.telemetryRevision ||
            releaseRun.evaluationId !== evaluation.id))
      ) {
        throw new Sim2RealError('sim2real_evaluation_stale');
      }
      if (
        !evaluation ||
        evaluation.status !== 'passed' ||
        evaluation.attested !== true ||
        evaluation.report?.replay?.attested !== true
      ) {
        throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
      }
      if (evaluation.modelId !== input.modelId || evaluation.runId !== input.runId) {
        throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
      }
      if (input.artifactId && evaluation.artifactId && evaluation.artifactId !== input.artifactId) {
        throw new Sim2RealError('sim2real_evaluation_lineage_invalid');
      }
    }
    const idempotencyKey = String(options.idempotencyKey ?? '').trim();
    if (idempotencyKey) {
      const existing = ledger.deployments.find(
        (item) => item._idempotencyKey === idempotencyKey && ownerMatches(item, owner),
      );
      if (existing) {
        if (
          options.requestFingerprint &&
          existing._requestFingerprint &&
          options.requestFingerprint !== existing._requestFingerprint
        ) {
          throw new Sim2RealError('sim2real_deployment_idempotency_conflict');
        }
        return { deployment: copy(withoutDeploymentPrivate(existing)), duplicate: true };
      }
    }
    const now = new Date().toISOString();
    // Approval is server-owned. A client may request a canary/live plan, but
    // it can never smuggle an already-approved decision through the create
    // endpoint. The explicit approval operation below is the only transition.
    const { approval: _approval, ...safeInput } = copy(input);
    const approval =
      input.mode === 'preflight'
        ? undefined
        : {
            status: 'pending' as const,
            requestedAt: now,
            ...(owner ? { requestedBy: owner } : {}),
          };
    const record: StoredDeployment = {
      ...safeInput,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...(approval ? { approval } : {}),
      history: [
        {
          id: randomUUID(),
          type: 'created',
          status: input.status,
          summary: input.summary,
          createdAt: now,
        },
      ],
      ...(owner ? { owner } : {}),
      ...(idempotencyKey ? { _idempotencyKey: idempotencyKey } : {}),
      ...(options.requestFingerprint ? { _requestFingerprint: options.requestFingerprint } : {}),
    };
    if (ledger.deployments.length >= DEPLOYMENT_CAP) {
      throw new Sim2RealError('sim2real_deployment_quota_exceeded');
    }
    await writeLedger({
      ...ledger,
      deployments: [record, ...ledger.deployments],
    });
    void emitSim2RealEvent(
      'deployment.created',
      record.id,
      withoutDeploymentPrivate(record),
      owner,
    );
    return { deployment: copy(withoutDeploymentPrivate(record)), duplicate: false };
  });
}

export async function createSim2RealDeployment(
  input: Omit<Sim2RealDeploymentRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner?: string,
): Promise<Sim2RealDeploymentRecord> {
  return (await createSim2RealDeploymentWithResult(input, owner)).deployment;
}

/**
 * Record the human decision that authorizes a canary/live plan. This changes
 * only the durable control-plane state; a separate board-agent executor must
 * consume a ready plan before any model is sent to hardware.
 */
export async function decideSim2RealDeploymentApproval(
  id: string,
  decision: Extract<Sim2RealDeploymentApprovalStatus, 'approved' | 'rejected'>,
  owner?: string,
  actor?: string,
  note?: string,
): Promise<Sim2RealDeploymentRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.deployments.findIndex(
      (item) => item.id === id && ownerMatches(item, owner),
    );
    if (index < 0) return null;
    const current = ledger.deployments[index];
    if (current.mode === 'preflight' || !['planned', 'blocked', 'ready'].includes(current.status)) {
      throw new Sim2RealError('sim2real_deployment_transition_invalid');
    }
    const existing = current.approval;
    if (existing?.status === decision) {
      return copy(withoutDeploymentPrivate(current));
    }
    if (decision === 'approved') {
      if (existing?.status === 'rejected') {
        throw new Sim2RealError('sim2real_deployment_transition_invalid');
      }
      if (
        current.releaseGate?.passed !== true ||
        current.compatibility.deployable !== true ||
        !current.runId ||
        !current.artifactId ||
        !current.evaluationId
      ) {
        throw new Sim2RealError('sim2real_deployment_transition_invalid');
      }

      // Re-read the evidence graph at the approval boundary. A deployment
      // plan can sit in pending for hours while a board agent appends newer
      // telemetry, an evaluator revokes a result, or an artifact is
      // withdrawn. The release gate stored on the plan is an audit snapshot;
      // it is not an approval credential. Approval must bind to the current
      // run/artifact/evaluation rows or fail closed.
      const approvalRun = ledger.runs.find(
        (item) => item.id === current.runId && ownerMatches(item, owner),
      );
      const approvalArtifact = ledger.artifacts.find(
        (item) => item.id === current.artifactId && ownerMatches(item, owner),
      );
      const approvalEvaluation = ledger.evaluations.find(
        (item) => item.id === current.evaluationId && ownerMatches(item, owner),
      );
      if (
        approvalEvaluation?.stale === true ||
        (approvalEvaluation?.telemetryRevision &&
          (!approvalRun || approvalRun.telemetryRevision !== approvalEvaluation.telemetryRevision))
      ) {
        throw new Sim2RealError('sim2real_evaluation_stale');
      }
      if (
        !approvalRun ||
        !approvalArtifact ||
        approvalArtifact.status !== 'published' ||
        approvalArtifact.modelId !== current.modelId ||
        approvalArtifact.runId !== approvalRun.id ||
        !approvalEvaluation ||
        approvalEvaluation.status !== 'passed' ||
        approvalEvaluation.attested !== true ||
        approvalEvaluation.report?.replay?.attested !== true ||
        approvalEvaluation.modelId !== current.modelId ||
        approvalEvaluation.runId !== approvalRun.id ||
        approvalRun.evaluationId !== approvalEvaluation.id
      ) {
        throw new Sim2RealError('sim2real_deployment_transition_invalid');
      }
      const currentGateRun = approvalEvaluation.report
        ? { ...approvalRun, evaluation: approvalEvaluation.report }
        : approvalRun;
      const currentGate = validateRunForDeployment({
        mode: current.mode,
        modelId: current.modelId,
        run: currentGateRun,
      });
      if (!currentGate.passed) {
        throw new Sim2RealError('sim2real_deployment_transition_invalid', {
          detail: currentGate.errors.join('; '),
        });
      }
    }
    const now = new Date().toISOString();
    const normalizedActor = String(actor ?? owner ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 160);
    const normalizedNote = String(note ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 500);
    const nextStatus: Sim2RealDeploymentRecord['status'] =
      decision === 'approved' ? 'ready' : 'blocked';
    const nextApproval = {
      ...(existing ?? {
        status: 'pending' as const,
        requestedAt: current.createdAt,
        ...(owner ? { requestedBy: owner } : {}),
      }),
      status: decision,
      decidedAt: now,
      ...(normalizedActor ? { decidedBy: normalizedActor } : {}),
      ...(normalizedNote ? { note: normalizedNote } : {}),
    };
    const history = [
      ...(current.history ?? []),
      {
        id: randomUUID(),
        type:
          decision === 'approved' ? ('approval_approved' as const) : ('approval_rejected' as const),
        status: nextStatus,
        summary:
          decision === 'approved'
            ? '人工审批已通过；计划已进入 ready，等待受控 board agent 执行。'
            : normalizedNote || '人工审批已拒绝；未执行模型下发或电机动作。',
        createdAt: now,
      },
    ].slice(-100);
    const updated: StoredDeployment = {
      ...current,
      status: nextStatus,
      approval: nextApproval,
      summary:
        decision === 'approved'
          ? '人工审批已通过；等待受控 board agent 执行。'
          : normalizedNote || '人工审批已拒绝；未执行模型下发或电机动作。',
      history,
      updatedAt: now,
    };
    const deployments = [...ledger.deployments];
    deployments[index] = updated;
    await writeLedger({ ...ledger, deployments });
    void emitSim2RealEvent(
      'deployment.updated',
      updated.id,
      withoutDeploymentPrivate(updated),
      owner,
    );
    return copy(withoutDeploymentPrivate(updated));
  });
}

export async function updateSim2RealDeployment(
  id: string,
  patch: Partial<
    Pick<
      Sim2RealDeploymentRecord,
      'status' | 'summary' | 'steps' | 'executedAt' | 'verification' | 'versionSwitchFrom'
    >
  >,
  owner?: string,
): Promise<Sim2RealDeploymentRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.deployments.findIndex(
      (item) => item.id === id && ownerMatches(item, owner),
    );
    if (index < 0) return null;
    const current = ledger.deployments[index];
    // A read-only probe may return after the user cancelled its plan. Never
    // let that late completion resurrect the cancelled lifecycle.
    if (current.status === 'cancelled' && patch.status !== 'cancelled') {
      return copy(withoutDeploymentPrivate(current));
    }
    if (patch.status && !DEPLOYMENT_STATUS_TRANSITIONS[current.status].includes(patch.status)) {
      throw new Sim2RealError('sim2real_deployment_transition_invalid');
    }
    // `ready` is the hand-off point at which an external board executor may
    // act. Preflight plans can become ready after their read-only probe; a
    // canary/live plan must first carry the explicit human approval recorded
    // by decideSim2RealDeploymentApproval. Keep this invariant in the store,
    // rather than trusting every future adapter to remember the route guard.
    if (
      patch.status === 'ready' &&
      current.mode !== 'preflight' &&
      current.approval?.status !== 'approved'
    ) {
      throw new Sim2RealError('sim2real_deployment_transition_invalid');
    }
    const now = new Date().toISOString();
    const statusChanged = patch.status && patch.status !== current.status;
    const eventType: Sim2RealDeploymentEventType =
      patch.status === 'cancelled'
        ? 'cancelled'
        : patch.verification
          ? 'preflight'
          : statusChanged
            ? 'status_changed'
            : 'updated';
    const history = [
      ...(current.history ?? []),
      {
        id: randomUUID(),
        type: eventType,
        status: patch.status ?? current.status,
        summary: patch.summary ?? current.summary,
        createdAt: now,
      },
    ].slice(-100);
    const updated: StoredDeployment = {
      ...current,
      ...copy(patch),
      history,
      updatedAt: now,
    };
    const deployments = [...ledger.deployments];
    deployments[index] = updated;
    await writeLedger({ ...ledger, deployments });
    void emitSim2RealEvent(
      'deployment.updated',
      updated.id,
      withoutDeploymentPrivate(updated),
      owner,
    );
    return copy(withoutDeploymentPrivate(updated));
  });
}

// ---- granular user feedback (Amershi G15) -----------------------------------
// Feedback is operational telemetry only: nothing here can influence the
// promotion/release gates. Storage follows the same ledger discipline as every
// other collection — serialized writes, owner scoping, bounded size.

export async function createSim2RealFeedback(
  input: Omit<Sim2RealFeedbackRecord, 'id' | 'createdAt'>,
  owner?: string,
): Promise<Sim2RealFeedbackRecord> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    return appendSim2RealFeedback(ledger.feedback ?? [], input, owner, async (next) => {
      await writeLedger({ ...ledger, feedback: next });
    });
  });
}

export async function listSim2RealFeedbackRecords(
  owner?: string,
): Promise<Sim2RealFeedbackRecord[]> {
  const ledger = await readLedger();
  return listSim2RealFeedback(ledger.feedback ?? [], owner);
}

/** Reliance summary (Bakusevych #38 / G17): aggregate view of the same
 *  owner-scoped feedback — counts and accuracy share, never identities. */
export async function summarizeSim2RealFeedbackRecords(owner?: string) {
  const ledger = await readLedger();
  return summarizeSim2RealFeedback(ledger.feedback ?? [], owner);
}

/** Shape guard re-export so routes can validate ledger-loaded rows cheaply. */
export { isSim2RealFeedbackRecord };

/** Test hook: clears only the in-process cache; it never deletes user data. */
export function invalidateSim2RealStoreCacheForTest(): void {
  cache = null;
  readinessCache = null;
}
