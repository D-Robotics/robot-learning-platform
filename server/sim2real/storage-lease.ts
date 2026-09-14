/**
 * Cross-process writer lease for the single-process, file-backed sim2real
 * store.
 *
 * The ledger (`sim2real.json`) and the per-run telemetry shards are already
 * serialized inside one process, but two server instances pointed at the same
 * `RDK_SIM2REAL_STORAGE_DIR` would still overwrite each other's ledger. A
 * small `<storageDir>/writer-lease.json` makes the second writer fail fast
 * instead of silently corrupting accepted data.
 *
 * Design notes:
 * - The decision logic (`evaluateLease`) is pure and fully dependency
 *   injected: hostname, pid, clock and process-liveness probing never leak
 *   into it, so every branch can be tested deterministically. All filesystem
 *   and `process` access lives in the thin wrappers below.
 * - A lease file that exists but cannot be parsed is NEVER treated as "no
 *   lease". That would hide a live writer behind a truncated write, which is
 *   exactly the failure this guard exists to prevent. The caller receives an
 *   explicit conflict error and an operator instruction instead.
 * - `RDK_SIM2REAL_STORAGE_LEASE=0` disables the check entirely. Only that
 *   literal value disables it; any other value (including `false`, `off`, an
 *   empty string or a typo) keeps the default, because silently dropping a
 *   data-safety guard is the dangerous outcome. Disabling the check restores
 *   the documented cross-process overwrite risk: two instances sharing one
 *   storage directory can clobber the ledger, so use it only for a
 *   single-writer deployment, a migration, or a test.
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Sim2RealError } from './sim2real-errors.js';
import { redactInternalError } from './http-helpers.js';

export const STORAGE_LEASE_SCHEMA_VERSION = 1 as const;
export const STORAGE_LEASE_FILE_NAME = 'writer-lease.json';
export const DEFAULT_STORAGE_LEASE_STALE_SECONDS = 300;
/** Lower bound keeps a nonsense value from preempting a live cross-host writer instantly. */
export const MIN_STORAGE_LEASE_STALE_SECONDS = 10;
/** Upper bound keeps a typo from disabling cross-host takeover for weeks. */
export const MAX_STORAGE_LEASE_STALE_SECONDS = 24 * 60 * 60;

/** Durable contents of `<storageDir>/writer-lease.json`. */
export interface StorageLeaseRecord {
  schemaVersion: number;
  /** `os.hostname()` of the writer. */
  host: string;
  /** `process.pid` of the writer. */
  pid: number;
  /** ISO timestamp of the writer process incarnation; stable across renewals. */
  startedAt: string;
  /** ISO timestamp refreshed by every successful write (renewal). */
  heartbeatAt: string;
}

/** The identity a writer compares against a stored lease. */
export interface StorageLeaseIdentity {
  host: string;
  pid: number;
  startedAt: string;
}

/**
 * `acquire`: no lease exists. `renew`: this exact process incarnation already
 * holds it. `takeover`: the recorded writer is provably gone (dead same-host
 * pid) or unverifiably stale (cross-host heartbeat older than the threshold).
 * `conflict`: another writer is, or cannot be proven not to be, active.
 */
export type StorageLeaseVerdict = 'acquire' | 'renew' | 'conflict' | 'takeover';

export interface StorageLeaseEvaluationInput {
  /** Parsed lease on disk, or `null` when the file does not exist. */
  existing: StorageLeaseRecord | null;
  self: StorageLeaseIdentity;
  nowMs: number;
  /** Injected `process.kill(pid, 0)`-style probe; true means the pid is alive. */
  isProcessAlive: (pid: number) => boolean;
  /** Cross-host heartbeat age after which the lease may be taken over. */
  staleMs: number;
}

/**
 * Pure lease decision. `existing` must already be shape-validated (see
 * `parseStorageLease`); an unparseable file is handled by the caller as an
 * explicit conflict rather than being passed in as `null`.
 *
 * Same-host rule: a *different* pid that is still alive is a conflict, a dead
 * pid may be taken over immediately. A record with our own pid but a different
 * `startedAt` is indistinguishable between a predecessor whose pid was
 * recycled and a live writer in a container that shares the hostname but not
 * the PID namespace, so it falls back to the conservative heartbeat rule
 * rather than preempting a possibly live writer. The exact same incarnation
 * (`startedAt` matches) simply renews.
 *
 * Cross-host rule (pid liveness is not meaningful): only the heartbeat age is
 * usable. A heartbeat exactly `staleMs` old still counts as fresh; an
 * unparseable heartbeat cannot be proven stale and therefore conflicts.
 */
export function evaluateLease(input: StorageLeaseEvaluationInput): StorageLeaseVerdict {
  const { existing, self, nowMs, isProcessAlive, staleMs } = input;
  if (!existing) return 'acquire';
  if (existing.host === self.host && existing.pid === self.pid) {
    return existing.startedAt === self.startedAt
      ? 'renew'
      : heartbeatVerdict(existing, nowMs, staleMs);
  }
  if (existing.host === self.host) {
    return isProcessAlive(existing.pid) ? 'conflict' : 'takeover';
  }
  return heartbeatVerdict(existing, nowMs, staleMs);
}

/** Freshness-only fallback used whenever pid liveness cannot decide the case. */
function heartbeatVerdict(
  existing: StorageLeaseRecord,
  nowMs: number,
  staleMs: number,
): 'conflict' | 'takeover' {
  const heartbeatMs = Date.parse(existing.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return 'conflict';
  return nowMs - heartbeatMs > staleMs ? 'takeover' : 'conflict';
}

/** Whether a stored lease was written by exactly this process incarnation. */
export function storageLeaseBelongsTo(
  record: StorageLeaseRecord,
  identity: StorageLeaseIdentity,
): boolean {
  return (
    record.host === identity.host &&
    record.pid === identity.pid &&
    record.startedAt === identity.startedAt
  );
}

/**
 * Shape-validate one lease file body. Returns `null` for malformed JSON, an
 * unknown schema version, or any missing/invalid field; the caller must then
 * fail closed instead of assuming the directory is unowned.
 */
export function parseStorageLease(raw: string): StorageLeaseRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== STORAGE_LEASE_SCHEMA_VERSION) return null;
  if (typeof candidate.host !== 'string' || !candidate.host.trim()) return null;
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0) return null;
  if (typeof candidate.startedAt !== 'string' || !candidate.startedAt.trim()) return null;
  if (typeof candidate.heartbeatAt !== 'string' || !candidate.heartbeatAt.trim()) return null;
  return {
    schemaVersion: STORAGE_LEASE_SCHEMA_VERSION,
    host: candidate.host,
    pid: candidate.pid as number,
    startedAt: candidate.startedAt,
    heartbeatAt: candidate.heartbeatAt,
  };
}

/**
 * Whether the writer lease guard is active. `RDK_SIM2REAL_STORAGE_LEASE=0` is
 * the only value that disables it (see the module comment for the risk);
 * everything else, including invalid values, keeps it enabled.
 */
export function storageLeaseCheckEnabled(): boolean {
  return String(process.env.RDK_SIM2REAL_STORAGE_LEASE ?? '').trim() !== '0';
}

/**
 * Cross-host heartbeat age after which a lease may be taken over, in seconds.
 * Malformed or out-of-range values fall back to the 300 s default rather than
 * silently disabling takeover (or preempting a live writer).
 */
export function storageLeaseStaleSeconds(): number {
  const raw = String(process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS ?? '').trim();
  if (!raw) return DEFAULT_STORAGE_LEASE_STALE_SECONDS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed >= MIN_STORAGE_LEASE_STALE_SECONDS &&
    parsed <= MAX_STORAGE_LEASE_STALE_SECONDS
    ? parsed
    : DEFAULT_STORAGE_LEASE_STALE_SECONDS;
}

/**
 * Identity of this writer. `startedAt` is derived from `process.uptime()` once
 * at module load so repeated acquisitions inside one process produce the exact
 * same string; that is what makes a same-process re-acquire idempotent and
 * what keeps the release ownership check from deleting another writer's lease.
 */
const SELF_PROCESS_STARTED_AT = new Date(
  Date.now() - Math.round(process.uptime() * 1_000),
).toISOString();

export function storageLeaseSelf(): StorageLeaseIdentity {
  return { host: os.hostname(), pid: process.pid, startedAt: SELF_PROCESS_STARTED_AT };
}

/**
 * `process.kill(pid, 0)` liveness probe. `EPERM` means the pid exists but is
 * owned by another user, so it counts as alive; `ESRCH` means it is gone. Any
 * other failure is also treated as alive so an unknown error can never
 * preempt a writer that might still be running.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `ESRCH` is the only result that proves the pid is gone. `EPERM` means the
    // pid exists but is owned by another user, and any other failure is also
    // treated as alive so an unknown error can never preempt a writer that
    // might still be running.
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

export function storageLeaseFilePath(storageDir: string): string {
  return path.join(storageDir, STORAGE_LEASE_FILE_NAME);
}

export interface StorageLeaseAcquisition {
  /** `disabled` when `RDK_SIM2REAL_STORAGE_LEASE=0` skipped the check entirely. */
  verdict: StorageLeaseVerdict | 'disabled';
  /** The durable lease owned by this process, or `null` while disabled. */
  lease: StorageLeaseRecord | null;
}

/** Injectable seams for the thin wrappers; production callers omit them. */
export interface StorageLeaseDeps {
  self: StorageLeaseIdentity;
  nowMs: number;
  isProcessAlive: (pid: number) => boolean;
  staleMs: number;
}

/**
 * Storage directories whose lease this process currently holds. The `exit`
 * hook walks this set so a single listener can clean up every directory the
 * process wrote to, and never touches a lease it does not own.
 */
const heldLeaseDirs = new Set<string>();
let exitCleanupRegistered = false;

function writerConflictError(detail: string, cause?: unknown): Sim2RealError {
  // The error message stays the stable snake_case code (the Sim2RealError
  // contract relied on by log alerts and `sim2RealErrorCode`); the actionable
  // Chinese explanation travels in the documented `detail` field and is also
  // logged so an operator sees it without a debugger.
  console.error(`[sim2real] ${redactInternalError(detail)}`);
  return new Sim2RealError('sim2real_storage_writer_conflict', {
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conflictDetail(
  existing: StorageLeaseRecord | null,
  self: StorageLeaseIdentity,
  staleMs: number,
): string {
  const holder = existing
    ? existing.host === self.host
      ? `租约持有者仍在本机存活（主机 ${existing.host}，pid ${existing.pid}）`
      : `租约来自主机 ${existing.host}（pid ${existing.pid}），其心跳 ${existing.heartbeatAt} 在 ${Math.round(
          staleMs / 1_000,
        )} 秒阈值内仍然新鲜`
    : '租约状态无法确认（获取过程中被并发写入）';
  return (
    `另一个进程正在写这个存储目录：${holder}。` +
    '请更换 RDK_SIM2REAL_STORAGE_DIR 指向独立目录，或确认旧进程已退出后重试' +
    '（确认无其他写入者时可删除 writer-lease.json）。'
  );
}

/**
 * Read and validate the lease file. A missing file is `null`; an unreadable,
 * malformed or unknown-version file is an explicit conflict, because treating
 * it as "no lease" could overwrite a live writer's data.
 */
async function readStorageLease(storageDir: string): Promise<StorageLeaseRecord | null> {
  const file = storageLeaseFilePath(storageDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw writerConflictError(
      `无法读取 writer 租约文件 ${file}（${errorText(error)}），因此无法判断是否已有其他写入者。` +
        '请检查存储目录权限，或更换 RDK_SIM2REAL_STORAGE_DIR。',
      error,
    );
  }
  const record = parseStorageLease(raw);
  if (!record) {
    throw writerConflictError(
      `writer 租约文件 ${file} 已损坏或版本不受支持，无法判断是否已有其他写入者；` +
        '为避免覆盖他人数据，本次写入已停止。请确认没有其他进程正在写这个目录，' +
        '然后删除该文件再重试，或改用独立的 RDK_SIM2REAL_STORAGE_DIR。',
    );
  }
  return record;
}

/**
 * Durably write the lease: exclusive create while acquiring (so two instances
 * that both saw "no lease" cannot silently overwrite each other), atomic
 * temp-file rename while renewing or taking over.
 */
async function writeStorageLease(
  storageDir: string,
  record: StorageLeaseRecord,
  exclusive: boolean,
): Promise<void> {
  const file = storageLeaseFilePath(storageDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const target = exclusive ? file : temporary;
  let created = false;
  try {
    const handle = await fs.open(target, exclusive ? 'wx' : 'w', 0o600);
    created = true;
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!exclusive) await fs.rename(temporary, file);
  } catch (error) {
    if (!exclusive) await fs.rm(temporary, { force: true }).catch(() => undefined);
    // A partially written exclusive lease would poison every later read, so
    // remove it and let the caller re-evaluate the race.
    else if (created) await fs.rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Take or renew the writer lease for one storage directory. Called from inside
 * the store's `serialized(...)` write chain on every ledger write, so it also
 * refreshes `heartbeatAt` and a long-lived process is never mistaken for a
 * dead one.
 */
export async function acquireStorageLease(
  storageDir: string,
  deps: Partial<StorageLeaseDeps> = {},
): Promise<StorageLeaseAcquisition> {
  if (!storageLeaseCheckEnabled()) {
    return { verdict: 'disabled', lease: null };
  }
  const self = deps.self ?? storageLeaseSelf();
  const nowMs = deps.nowMs ?? Date.now();
  const alive = deps.isProcessAlive ?? isProcessAlive;
  const staleMs = deps.staleMs ?? storageLeaseStaleSeconds() * 1_000;
  // Two attempts: the first may lose the exclusive-create race to a second
  // instance that also observed "no lease". The retry re-reads, so that race
  // becomes a reported conflict instead of an overwrite.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readStorageLease(storageDir);
    const verdict = evaluateLease({ existing, self, nowMs, isProcessAlive: alive, staleMs });
    if (verdict === 'conflict') {
      throw writerConflictError(conflictDetail(existing, self, staleMs));
    }
    const lease: StorageLeaseRecord = {
      schemaVersion: STORAGE_LEASE_SCHEMA_VERSION,
      host: self.host,
      pid: self.pid,
      // A renewal keeps this incarnation's identifier unchanged; that is what
      // the release ownership check compares.
      startedAt: self.startedAt,
      heartbeatAt: new Date(nowMs).toISOString(),
    };
    try {
      await writeStorageLease(storageDir, lease, verdict === 'acquire');
    } catch (error) {
      if (verdict === 'acquire' && (error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
    heldLeaseDirs.add(path.resolve(storageDir));
    registerExitCleanup();
    return { verdict, lease };
  }
  throw writerConflictError(conflictDetail(null, self, staleMs));
}

/**
 * Release this process's lease. Deletes the file only when the stored lease
 * still carries this exact host+pid+startedAt, so a lease taken over by
 * another instance is never removed by a late release from this one.
 */
export async function releaseStorageLease(
  storageDir: string,
  deps: Partial<StorageLeaseDeps> = {},
): Promise<boolean> {
  const self = deps.self ?? storageLeaseSelf();
  const resolved = path.resolve(storageDir);
  const file = storageLeaseFilePath(storageDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    // Already gone (or unreadable): nothing this process may delete.
    heldLeaseDirs.delete(resolved);
    return false;
  }
  const record = parseStorageLease(raw);
  if (!record || !storageLeaseBelongsTo(record, self)) return false;
  try {
    await fs.rm(file, { force: true });
  } catch {
    // Keep the directory tracked so the exit hook can retry.
    return false;
  }
  heldLeaseDirs.delete(resolved);
  return true;
}

/** Synchronous best-effort release used by the `exit` hook. */
function releaseHeldLeasesSync(): void {
  if (!heldLeaseDirs.size) return;
  const self = storageLeaseSelf();
  for (const storageDir of heldLeaseDirs) {
    try {
      const file = storageLeaseFilePath(storageDir);
      const record = parseStorageLease(fsSync.readFileSync(file, 'utf8'));
      // A takeover by another instance must survive our exit.
      if (record && storageLeaseBelongsTo(record, self)) fsSync.rmSync(file, { force: true });
    } catch {
      // Best effort only; a missing or unreadable file is not an error here.
    }
  }
  heldLeaseDirs.clear();
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  // `exit` covers normal termination and process.exit(). SIGKILL cannot be
  // trapped; a lease left behind by a hard kill is resolved by the same-host
  // pid liveness check, or by the cross-host heartbeat staleness window.
  process.once('exit', releaseHeldLeasesSync);
}
