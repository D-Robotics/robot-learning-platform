import { randomUUID } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  Sim2RealDeploymentRecord,
  Sim2RealEvaluationSummary,
  Sim2RealModelManifest,
  Sim2RealModelRecord,
  Sim2RealRunRecord,
  Sim2RealTelemetryRecord,
} from '../../shared/sim2real.js';
import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import { isWebCloudDeployment, resolveDataDir } from './standalone-adapters.js';

const LEDGER_VERSION = 1 as const;
const MODEL_CAP = 100;
// Keep a longer server-side run ledger so an old idempotency key cannot
// unexpectedly launch a second billable job after the UI list is trimmed.
const RUN_CAP = 10_000;
const PUBLIC_RUN_LIST_CAP = 200;
const DEPLOYMENT_CAP = 200;
export const DEFAULT_ACTIVE_RUN_CAP = 4;
// A reservation that never receives a runner id (for example, a process
// crash between submit and ledger update) must not occupy an account slot
// forever. Keep the default generous enough for long local jobs; operators
// can tune it for their worker SLA within a bounded range.
export const DEFAULT_ACTIVE_RUN_TTL_SECONDS = 24 * 60 * 60;
export const MIN_ACTIVE_RUN_TTL_SECONDS = 5 * 60;
export const MAX_ACTIVE_RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
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
type StoredTelemetry = Sim2RealTelemetryRecord & {
  owner?: string;
  /** Internal idempotency fingerprint; never returned to clients. */
  _requestFingerprint?: string;
};

interface Sim2RealLedger {
  version: typeof LEDGER_VERSION;
  models: StoredModel[];
  runs: StoredRun[];
  deployments: StoredDeployment[];
  telemetry: StoredTelemetry[];
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
  const error = new Error('sim2real_storage_quota_exceeded');
  // Keep the public error code stable while retaining a useful diagnostic for
  // logs/debuggers without exposing filesystem details to API callers.
  error.cause = new Error(`ledger size ${size} exceeds ${SIM2REAL_LEDGER_MAX_BYTES} bytes`);
  return error;
}

function assertLedgerSize(size: number): void {
  if (size > SIM2REAL_LEDGER_MAX_BYTES) throw ledgerQuotaError(size);
}

function emptyLedger(): Sim2RealLedger {
  return { version: LEDGER_VERSION, models: [], runs: [], deployments: [], telemetry: [] };
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
  if (!validRecordArray(value.runs, ['id', 'modelId', 'backend', 'status', 'summary', 'createdAt'])) {
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
  if (!validRecordArray(value.telemetry, ['id', 'runId', 'source', 'receivedAt'], 'samples')) {
    return false;
  }
  if ((value.telemetry as unknown[]).length > SIM2REAL_TELEMETRY_RECORD_CAP) return false;
  return value.telemetry.every((item) =>
    (item.samples as unknown[]).every((sample) => isRecord(sample)),
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
    console.error(
      '[sim2real] readiness ledger stat failed:',
      error instanceof Error ? error.message : error,
    );
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
    console.error(
      '[sim2real] readiness ledger check failed:',
      error instanceof Error ? error.message : error,
    );
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
          const failure = new Error('sim2real_storage_unavailable');
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
            const failure = new Error('sim2real_storage_unavailable');
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
      };
      cache = { file, value, size: afterStat.size, mtimeMs: afterStat.mtimeMs };
      return value;
    }
    throw new Error('ledger changed while being read');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (cache?.file === file && cache.size >= 0) {
        const failure = new Error('sim2real_storage_unavailable');
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
      error instanceof Error ? error.message : error,
    );
    const failure = new Error('sim2real_storage_unavailable');
    failure.cause = error;
    throw failure;
  }
}

async function writeLedger(value: Sim2RealLedger): Promise<void> {
  const file = ledgerPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const serializedValue = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serializedValue, 'utf8') > SIM2REAL_LEDGER_MAX_BYTES) {
    throw new Error('sim2real_storage_quota_exceeded');
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

function ensureWritable(): void {
  if (!sim2RealStorageInfo().writable) throw new Error('sim2real_storage_not_configured');
}

function ownerMatches(record: { owner?: string }, owner: string | undefined): boolean {
  return (record.owner ?? '') === (owner ?? '');
}

function withoutOwner<T extends { owner?: string }>(record: T): Omit<T, 'owner'> {
  const { owner: _owner, ...publicRecord } = record;
  return publicRecord;
}

function withoutRunPrivate(record: StoredRun): Sim2RealRunRecord {
  const { _idempotencyKey: _key, _requestFingerprint: _fingerprint, ...owned } = withoutOwner(record);
  return owned as Sim2RealRunRecord;
}

function withoutTelemetryPrivate(record: StoredTelemetry): Sim2RealTelemetryRecord {
  const { _requestFingerprint: _fingerprint, ...owned } = withoutOwner(record);
  return owned as Sim2RealTelemetryRecord;
}

function withoutDeploymentPrivate(record: StoredDeployment): Sim2RealDeploymentRecord {
  const { _idempotencyKey: _key, _requestFingerprint: _fingerprint, ...owned } = withoutOwner(record);
  return owned as Sim2RealDeploymentRecord;
}

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
 * Reject a newly accepted chunk if the timeline would go backwards at a
 * chunk boundary.  The HTTP parser already validates ordering inside one
 * chunk, but the ledger is also reachable by local/board adapters and must
 * enforce the invariant at the serialized write boundary.  Sequence numbers
 * are deliberately used when present so chunks that arrive out of order can
 * still be accepted when their logical timeline is valid.
 */
function assertTelemetryTimeline(
  records: readonly StoredTelemetry[],
  incoming: StoredTelemetry,
  owner: string | undefined,
): void {
  const ordered = [...records, incoming]
    .filter((item) => item.runId === incoming.runId && ownerMatches(item, owner))
    .sort(compareTelemetryRecords);
  let previousLast: number | undefined;
  for (const record of ordered) {
    const samples = Array.isArray(record.samples) ? record.samples : [];
    if (!samples.length) continue;
    let previousInChunk: number | undefined;
    for (const sample of samples) {
      const timestamp = Number(sample?.t);
      // Legacy ledgers are allowed to contain records written before the
      // timestamp invariant existed.  Skip malformed legacy values here;
      // route-level validation still rejects malformed new input.
      if (!Number.isFinite(timestamp)) continue;
      if (previousInChunk != null && timestamp < previousInChunk) {
        throw new Error('sim2real_telemetry_timestamp_order');
      }
      previousInChunk = timestamp;
    }
    const first = Number(samples[0]?.t);
    const last = Number(samples.at(-1)?.t);
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    if (previousLast != null && first < previousLast) {
      throw new Error('sim2real_telemetry_timestamp_order');
    }
    previousLast = last;
  }
}

export async function listSim2RealModels(owner?: string): Promise<Sim2RealModelRecord[]> {
  const ledger = await readLedger();
  const custom = ledger.models
    .filter((item) => ownerMatches(item, owner))
    .slice(0, MODEL_CAP)
    .map((item) => copy(withoutOwner(item)) as Sim2RealModelRecord);
  return [copy(BUILTIN_MICRODUCK_MODEL), ...custom];
}

export async function getSim2RealModel(
  id: string,
  owner?: string,
): Promise<Sim2RealModelRecord | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  if (wanted === BUILTIN_MICRODUCK_MODEL.id) return copy(BUILTIN_MICRODUCK_MODEL);
  const ledger = await readLedger();
  const found = ledger.models.find((item) => item.id === wanted && ownerMatches(item, owner));
  return found ? (copy(withoutOwner(found)) as Sim2RealModelRecord) : null;
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
    if (duplicate || manifest.modelId === BUILTIN_MICRODUCK_MODEL.manifest.modelId) {
      throw new Error('sim2real_model_version_exists');
    }
    if (ledger.models.length >= MODEL_CAP) {
      throw new Error('sim2real_model_quota_exceeded');
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
  if (!idempotencyKey) throw new Error('sim2real_run_idempotency_required');
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
    const existing = ledger.runs.find(
      (item) => item._idempotencyKey === idempotencyKey && ownerMatches(item, owner),
    );
    if (existing) {
      if (
        options.requestFingerprint &&
        existing._requestFingerprint &&
        options.requestFingerprint !== existing._requestFingerprint
      ) {
        throw new Error('sim2real_run_idempotency_conflict');
      }
      return { run: copy(withoutRunPrivate(existing)), created: false };
    }
    const maxActiveRuns = options.maxActiveRuns;
    if (maxActiveRuns !== undefined) {
      const activeCount = ledger.runs.filter(
        (item) => ownerMatches(item, owner) && isActiveRunnerRun(item),
      ).length;
      if (activeCount >= maxActiveRuns) {
        throw new Error('sim2real_active_run_quota_exceeded');
      }
    }
    const record: StoredRun = {
      ...copy(input),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
      _idempotencyKey: idempotencyKey,
      ...(options.requestFingerprint ? { _requestFingerprint: options.requestFingerprint } : {}),
    };
    if (ledger.runs.length >= RUN_CAP) {
      throw new Error('sim2real_run_quota_exceeded');
    }
    await writeLedger({ ...ledger, runs: [record, ...ledger.runs] });
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
          throw new Error('sim2real_run_idempotency_conflict');
        }
        return copy(withoutRunPrivate(existing));
      }
    }
    const record: StoredRun = {
      ...copy(input),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
      ...(idempotencyKey ? { _idempotencyKey: idempotencyKey } : {}),
      ...(options.requestFingerprint ? { _requestFingerprint: options.requestFingerprint } : {}),
    };
    if (ledger.runs.length >= RUN_CAP) {
      throw new Error('sim2real_run_quota_exceeded');
    }
    await writeLedger({ ...ledger, runs: [record, ...ledger.runs] });
    return copy(withoutRunPrivate(record));
  });
}

export async function updateSim2RealRun(
  id: string,
  patch: Partial<
    Pick<
      Sim2RealRunRecord,
      | 'status'
      | 'summary'
      | 'launchUrl'
      | 'externalRunId'
      | 'metrics'
      | 'evaluation'
      | 'checkpoint'
      | 'finishedAt'
      | 'mock'
      | 'artifact'
    >
  >,
  owner?: string,
): Promise<Sim2RealRunRecord | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.runs.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = ledger.runs[index];
    const updated: StoredRun = {
      ...current,
      ...copy(patch),
    };
    const runs = [...ledger.runs];
    runs[index] = updated;
    await writeLedger({ ...ledger, runs });
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
  patch: Partial<
    Pick<
      Sim2RealRunRecord,
      | 'status'
      | 'summary'
      | 'launchUrl'
      | 'externalRunId'
      | 'metrics'
      | 'evaluation'
      | 'checkpoint'
      | 'finishedAt'
      | 'mock'
      | 'artifact'
    >
  >,
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
    return copy(withoutRunPrivate(updated));
  });
}

export interface Sim2RealRunEvaluationContext {
  /** A public copy of the run being evaluated; private ledger fields are omitted. */
  run: Sim2RealRunRecord;
  /** Every accepted telemetry chunk for the run, in ledger order. */
  telemetry: Sim2RealTelemetryRecord[];
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
): Promise<{ run: Sim2RealRunRecord; evaluation: Sim2RealEvaluationSummary } | null> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const index = ledger.runs.findIndex((item) => item.id === id && ownerMatches(item, owner));
    if (index < 0) return null;
    const current = ledger.runs[index];
    const context: Sim2RealRunEvaluationContext = {
      run: copy(withoutRunPrivate(current)),
      telemetry: ledger.telemetry
        .filter((item) => item.runId === id && ownerMatches(item, owner))
        .map((item) => copy(withoutTelemetryPrivate(item))),
    };
    // Copy the callback result before putting it into the ledger so a caller
    // cannot mutate the in-memory cache after this serialized operation.
    const evaluation = copy(evaluator(context));
    const updated: StoredRun = {
      ...current,
      evaluation,
    };
    const runs = [...ledger.runs];
    runs[index] = updated;
    await writeLedger({ ...ledger, runs });
    return {
      run: copy(withoutRunPrivate(updated)),
      evaluation: copy(evaluation),
    };
  });
}

export async function listSim2RealTelemetry(
  runId: string,
  owner?: string,
  limit = 200,
): Promise<Sim2RealTelemetryRecord[]> {
  const ledger = await readLedger();
  // Keep normal list responses small while allowing the evaluation endpoint
  // to inspect a longer run without silently discarding most of its chunks.
  const bounded = Math.max(
    1,
    Math.min(SIM2REAL_TELEMETRY_RECORD_CAP, Math.floor(Number(limit) || 200)),
  );
  return ledger.telemetry
    .filter((item) => item.runId === runId && ownerMatches(item, owner))
    .slice(0, bounded)
    .map((item) => copy(withoutTelemetryPrivate(item)));
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
  return found ? copy(withoutTelemetryPrivate(found)) : null;
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
    const requestFingerprint = input._requestFingerprint;
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
          throw new Error('sim2real_telemetry_idempotency_conflict');
        }
        return {
          telemetry: copy(withoutTelemetryPrivate(existing)),
          duplicate: true,
        };
      }
    }
    const { _requestFingerprint: _fingerprint, ...publicInput } = input;
    const record: StoredTelemetry = {
      ...copy(publicInput),
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
      ...(requestFingerprint ? { _requestFingerprint: requestFingerprint } : {}),
    };
    assertTelemetryTimeline(ledger.telemetry, record, owner);
    const incomingUsage = telemetryUsage([record]);
    const runUsage = telemetryUsage(
      ledger.telemetry.filter(
        (item) => item.runId === record.runId && ownerMatches(item, owner),
      ),
    );
    if (
      runUsage.samples + incomingUsage.samples > SIM2REAL_TELEMETRY_LIMITS.runSamples ||
      runUsage.bytes + incomingUsage.bytes > SIM2REAL_TELEMETRY_LIMITS.runBytes
    ) {
      throw new Error('sim2real_telemetry_quota_exceeded');
    }
    const ownerUsage = telemetryUsage(ledger.telemetry.filter((item) => ownerMatches(item, owner)));
    if (
      ownerUsage.samples + incomingUsage.samples > SIM2REAL_TELEMETRY_LIMITS.ownerSamples ||
      ownerUsage.bytes + incomingUsage.bytes > SIM2REAL_TELEMETRY_LIMITS.ownerBytes
    ) {
      throw new Error('sim2real_telemetry_quota_exceeded');
    }
    if (ledger.telemetry.length >= SIM2REAL_TELEMETRY_RECORD_CAP) {
      throw new Error('sim2real_telemetry_quota_exceeded');
    }
    // A new chunk changes the replay/evaluation input. Clear the cached
    // summary in the same serialized write so GET /replay can never return a
    // stale score after an import (and a concurrent append cannot race a
    // separate "clear evaluation" update).
    const runs = ledger.runs.map((item) =>
      item.id === record.runId && ownerMatches(item, owner)
        ? { ...item, evaluation: undefined }
        : item,
    );
    await writeLedger({
      ...ledger,
      runs,
      telemetry: [record, ...ledger.telemetry],
    });
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
          throw new Error('sim2real_deployment_idempotency_conflict');
        }
        return { deployment: copy(withoutDeploymentPrivate(existing)), duplicate: true };
      }
    }
    const now = new Date().toISOString();
    const record: StoredDeployment = {
      ...copy(input),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...(owner ? { owner } : {}),
      ...(idempotencyKey ? { _idempotencyKey: idempotencyKey } : {}),
      ...(options.requestFingerprint ? { _requestFingerprint: options.requestFingerprint } : {}),
    };
    if (ledger.deployments.length >= DEPLOYMENT_CAP) {
      throw new Error('sim2real_deployment_quota_exceeded');
    }
    await writeLedger({
      ...ledger,
      deployments: [record, ...ledger.deployments],
    });
    return { deployment: copy(withoutDeploymentPrivate(record)), duplicate: false };
  });
}

export async function createSim2RealDeployment(
  input: Omit<Sim2RealDeploymentRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner?: string,
): Promise<Sim2RealDeploymentRecord> {
  return (await createSim2RealDeploymentWithResult(input, owner)).deployment;
}

export async function updateSim2RealDeployment(
  id: string,
  patch: Partial<Pick<Sim2RealDeploymentRecord, 'status' | 'summary' | 'steps' | 'executedAt'>>,
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
    const updated: StoredDeployment = {
      ...current,
      ...copy(patch),
      updatedAt: new Date().toISOString(),
    };
    const deployments = [...ledger.deployments];
    deployments[index] = updated;
    await writeLedger({ ...ledger, deployments });
    return copy(withoutDeploymentPrivate(updated));
  });
}

/** Test hook: clears only the in-process cache; it never deletes user data. */
export function invalidateSim2RealStoreCacheForTest(): void {
  cache = null;
  readinessCache = null;
}
