import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  Sim2RealDeploymentRecord,
  Sim2RealModelManifest,
  Sim2RealModelRecord,
  Sim2RealRunRecord,
  Sim2RealTelemetryRecord,
} from '../../shared/sim2real.js';
import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import { isWebCloudDeployment, resolveDataDir } from './standalone-adapters.js';

const LEDGER_VERSION = 1 as const;
const MODEL_CAP = 100;
const RUN_CAP = 200;
const DEPLOYMENT_CAP = 200;
const TELEMETRY_CAP = 20_000;

type StoredModel = Sim2RealModelRecord & { owner?: string };
type StoredRun = Sim2RealRunRecord & { owner?: string };
type StoredDeployment = Sim2RealDeploymentRecord & { owner?: string };
type StoredTelemetry = Sim2RealTelemetryRecord & { owner?: string };

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
  if (isWebCloudDeployment() && !configuredStorageRoot()) {
    return {
      mode: 'external-required',
      writable: false,
      message:
        'Web Cloud requires an explicit RDK_SIM2REAL_STORAGE_DIR or a future object-store adapter; no shared disk is used implicitly.',
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

let cache: { file: string; value: Sim2RealLedger } | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyLedger(): Sim2RealLedger {
  return { version: LEDGER_VERSION, models: [], runs: [], deployments: [], telemetry: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function readLedger(): Promise<Sim2RealLedger> {
  const file = ledgerPath();
  if (cache?.file === file) return cache.value;
  // A shared Web Cloud process must not silently read a process-local ledger.
  // The overview remains useful with the built-in reference model, while user
  // metadata becomes available only after an explicit shared storage mount.
  if (!sim2RealStorageInfo().writable) {
    const value = emptyLedger();
    cache = { file, value };
    return value;
  }
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('ledger is not an object');
    const value: Sim2RealLedger = {
      version: LEDGER_VERSION,
      models: arrayOf<StoredModel>(parsed.models),
      runs: arrayOf<StoredRun>(parsed.runs),
      deployments: arrayOf<StoredDeployment>(parsed.deployments),
      telemetry: arrayOf<StoredTelemetry>(parsed.telemetry),
    };
    cache = { file, value };
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(
        '[sim2real] ledger unreadable; starting with an empty ledger:',
        error instanceof Error ? error.message : error,
      );
    }
    const value = emptyLedger();
    cache = { file, value };
    return value;
  }
}

async function writeLedger(value: Sim2RealLedger): Promise<void> {
  const file = ledgerPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
  cache = { file, value };
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

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    const now = new Date().toISOString();
    const record: StoredModel = {
      id: randomUUID(),
      manifest: copy(manifest),
      createdAt: now,
      updatedAt: now,
      ...(owner ? { owner } : {}),
    };
    const owned = ledger.models.filter((item) => ownerMatches(item, owner));
    const others = ledger.models.filter((item) => !ownerMatches(item, owner));
    const next: Sim2RealLedger = {
      ...ledger,
      models: [record, ...owned].slice(0, MODEL_CAP).concat(others),
    };
    await writeLedger(next);
    return copy(withoutOwner(record)) as Sim2RealModelRecord;
  });
}

export async function listSim2RealRuns(owner?: string): Promise<Sim2RealRunRecord[]> {
  const ledger = await readLedger();
  return ledger.runs
    .filter((item) => ownerMatches(item, owner))
    .slice(0, RUN_CAP)
    .map((item) => copy(withoutOwner(item)) as Sim2RealRunRecord);
}

export async function getSim2RealRun(
  id: string,
  owner?: string,
): Promise<Sim2RealRunRecord | null> {
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  const ledger = await readLedger();
  const found = ledger.runs.find((item) => item.id === wanted && ownerMatches(item, owner));
  return found ? (copy(withoutOwner(found)) as Sim2RealRunRecord) : null;
}

export async function createSim2RealRun(
  input: Omit<Sim2RealRunRecord, 'id' | 'createdAt'>,
  owner?: string,
): Promise<Sim2RealRunRecord> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const record: StoredRun = {
      ...copy(input),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
    };
    const owned = ledger.runs.filter((item) => ownerMatches(item, owner));
    const others = ledger.runs.filter((item) => !ownerMatches(item, owner));
    await writeLedger({ ...ledger, runs: [record, ...owned].slice(0, RUN_CAP).concat(others) });
    return copy(withoutOwner(record)) as Sim2RealRunRecord;
  });
}

export async function updateSim2RealRun(
  id: string,
  patch: Partial<
    Pick<
      Sim2RealRunRecord,
      | 'status'
      | 'summary'
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
    return copy(withoutOwner(updated)) as Sim2RealRunRecord;
  });
}

export async function listSim2RealTelemetry(
  runId: string,
  owner?: string,
  limit = 200,
): Promise<Sim2RealTelemetryRecord[]> {
  const ledger = await readLedger();
  const bounded = Math.max(1, Math.min(500, Math.floor(Number(limit) || 200)));
  return ledger.telemetry
    .filter((item) => item.runId === runId && ownerMatches(item, owner))
    .slice(0, bounded)
    .map((item) => copy(withoutOwner(item)) as Sim2RealTelemetryRecord);
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
  return found ? (copy(withoutOwner(found)) as Sim2RealTelemetryRecord) : null;
}

export async function appendSim2RealTelemetry(
  input: Omit<Sim2RealTelemetryRecord, 'id' | 'receivedAt'>,
  owner?: string,
): Promise<Sim2RealTelemetryRecord> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const record: StoredTelemetry = {
      ...copy(input),
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
    };
    const owned = ledger.telemetry.filter((item) => ownerMatches(item, owner));
    const others = ledger.telemetry.filter((item) => !ownerMatches(item, owner));
    await writeLedger({
      ...ledger,
      telemetry: [record, ...owned].slice(0, TELEMETRY_CAP).concat(others),
    });
    return copy(withoutOwner(record)) as Sim2RealTelemetryRecord;
  });
}

export async function listSim2RealDeployments(owner?: string): Promise<Sim2RealDeploymentRecord[]> {
  const ledger = await readLedger();
  return ledger.deployments
    .filter((item) => ownerMatches(item, owner))
    .slice(0, DEPLOYMENT_CAP)
    .map((item) => copy(withoutOwner(item)) as Sim2RealDeploymentRecord);
}

export async function getSim2RealDeployment(
  id: string,
  owner?: string,
): Promise<Sim2RealDeploymentRecord | null> {
  const ledger = await readLedger();
  const found = ledger.deployments.find((item) => item.id === id && ownerMatches(item, owner));
  return found ? (copy(withoutOwner(found)) as Sim2RealDeploymentRecord) : null;
}

export async function createSim2RealDeployment(
  input: Omit<Sim2RealDeploymentRecord, 'id' | 'createdAt' | 'updatedAt'>,
  owner?: string,
): Promise<Sim2RealDeploymentRecord> {
  ensureWritable();
  return serialized(async () => {
    const ledger = await readLedger();
    const now = new Date().toISOString();
    const record: StoredDeployment = {
      ...copy(input),
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...(owner ? { owner } : {}),
    };
    const owned = ledger.deployments.filter((item) => ownerMatches(item, owner));
    const others = ledger.deployments.filter((item) => !ownerMatches(item, owner));
    await writeLedger({
      ...ledger,
      deployments: [record, ...owned].slice(0, DEPLOYMENT_CAP).concat(others),
    });
    return copy(withoutOwner(record)) as Sim2RealDeploymentRecord;
  });
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
    return copy(withoutOwner(updated)) as Sim2RealDeploymentRecord;
  });
}

/** Test hook: clears only the in-process cache; it never deletes user data. */
export function invalidateSim2RealStoreCacheForTest(): void {
  cache = null;
}
