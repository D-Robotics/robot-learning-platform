import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isSim2RealError, sim2RealErrorCode } from './sim2real-errors.js';
import {
  DEFAULT_STORAGE_LEASE_STALE_SECONDS,
  MAX_STORAGE_LEASE_STALE_SECONDS,
  MIN_STORAGE_LEASE_STALE_SECONDS,
  STORAGE_LEASE_FILE_NAME,
  STORAGE_LEASE_SCHEMA_VERSION,
  acquireStorageLease,
  evaluateLease,
  isProcessAlive,
  parseStorageLease,
  releaseStorageLease,
  storageLeaseBelongsTo,
  storageLeaseCheckEnabled,
  storageLeaseFilePath,
  storageLeaseSelf,
  storageLeaseStaleSeconds,
  type StorageLeaseRecord,
} from './storage-lease.js';

const roots: string[] = [];
const previousLease = process.env.RDK_SIM2REAL_STORAGE_LEASE;
const previousLeaseStale = process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousLease === undefined) delete process.env.RDK_SIM2REAL_STORAGE_LEASE;
  else process.env.RDK_SIM2REAL_STORAGE_LEASE = previousLease;
  if (previousLeaseStale === undefined) delete process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS;
  else process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS = previousLeaseStale;
});

async function useTempStorage(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-lease-'));
  roots.push(root);
  return root;
}

const SELF = {
  host: 'host-a',
  pid: 4_242,
  startedAt: '2026-01-01T00:00:00.000Z',
} as const;
const NOW_MS = Date.parse('2026-01-01T00:10:00.000Z');
const STALE_MS = 300_000;
const alwaysAlive = () => true;
const alwaysDead = () => false;

function lease(overrides: Partial<StorageLeaseRecord> = {}): StorageLeaseRecord {
  return {
    schemaVersion: STORAGE_LEASE_SCHEMA_VERSION,
    host: SELF.host,
    pid: SELF.pid,
    startedAt: SELF.startedAt,
    heartbeatAt: '2026-01-01T00:09:30.000Z',
    ...overrides,
  };
}

describe('evaluateLease', () => {
  it('acquires when no lease exists', () => {
    expect(
      evaluateLease({
        existing: null,
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('acquire');
  });

  it('renews the same process incarnation instead of conflicting with itself', () => {
    expect(
      evaluateLease({
        existing: lease(),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('renew');
  });

  it('does not preempt a same-pid, unknown-incarnation record with a fresh heartbeat', () => {
    // Same host and pid but a different startedAt is indistinguishable between
    // a recycled pid and a container that shares the hostname, so a fresh
    // heartbeat keeps it a conflict.
    expect(
      evaluateLease({
        existing: lease({
          startedAt: '2025-12-31T00:00:00.000Z',
          heartbeatAt: '2026-01-01T00:09:59.000Z',
        }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('conflict');
  });

  it('takes over a same-pid predecessor once its heartbeat is stale', () => {
    expect(
      evaluateLease({
        existing: lease({
          startedAt: '2025-12-31T00:00:00.000Z',
          heartbeatAt: '2026-01-01T00:00:00.000Z',
        }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('takeover');
  });

  it('conflicts with a live foreign pid on the same host', () => {
    expect(
      evaluateLease({
        existing: lease({ pid: SELF.pid + 1 }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('conflict');
  });

  it('takes over a dead foreign pid on the same host even with a fresh heartbeat', () => {
    expect(
      evaluateLease({
        existing: lease({ pid: SELF.pid + 1, heartbeatAt: '2026-01-01T00:09:59.000Z' }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysDead,
        staleMs: STALE_MS,
      }),
    ).toBe('takeover');
  });

  it('conflicts with a live pid even when the heartbeat is ancient', () => {
    expect(
      evaluateLease({
        existing: lease({ pid: SELF.pid + 1, heartbeatAt: '2020-01-01T00:00:00.000Z' }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('conflict');
  });

  it('conflicts with a fresh cross-host heartbeat', () => {
    expect(
      evaluateLease({
        existing: lease({ host: 'host-b', pid: 7, heartbeatAt: '2026-01-01T00:09:59.000Z' }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('conflict');
  });

  it('takes over an expired cross-host heartbeat', () => {
    expect(
      evaluateLease({
        existing: lease({ host: 'host-b', pid: 7, heartbeatAt: '2026-01-01T00:00:00.000Z' }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('takeover');
  });

  it('treats a heartbeat exactly at the staleness threshold as still fresh', () => {
    expect(
      evaluateLease({
        existing: lease({
          host: 'host-b',
          pid: 7,
          heartbeatAt: new Date(NOW_MS - STALE_MS).toISOString(),
        }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('conflict');
  });

  it('conflicts when a cross-host heartbeat cannot be parsed', () => {
    // An undatable heartbeat cannot be proven stale, so fail closed.
    expect(
      evaluateLease({
        existing: lease({ host: 'host-b', pid: 7, heartbeatAt: 'not-a-timestamp' }),
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).toBe('conflict');
  });
});

describe('parseStorageLease', () => {
  it('accepts a complete record', () => {
    const record = lease();
    expect(parseStorageLease(JSON.stringify(record))).toEqual(record);
  });

  it('rejects malformed JSON and non-object bodies', () => {
    for (const raw of ['{', 'not json', '[]', 'null', '"lease"', '42']) {
      expect(parseStorageLease(raw)).toBeNull();
    }
  });

  it('rejects an unknown schema version or an invalid field', () => {
    const cases: Array<Record<string, unknown>> = [
      { schemaVersion: STORAGE_LEASE_SCHEMA_VERSION + 1 },
      { schemaVersion: '1' },
      { host: '   ' },
      { host: 7 },
      { pid: 0 },
      { pid: -3 },
      { pid: 1.5 },
      { pid: '123' },
      { startedAt: '' },
      { startedAt: undefined },
      { heartbeatAt: '' },
      { heartbeatAt: null },
    ];
    for (const patch of cases) {
      expect(parseStorageLease(JSON.stringify({ ...lease(), ...patch }))).toBeNull();
    }
  });
});

describe('storage lease environment switches', () => {
  it('enables the check by default and keeps it on for anything but the literal "0"', () => {
    delete process.env.RDK_SIM2REAL_STORAGE_LEASE;
    expect(storageLeaseCheckEnabled()).toBe(true);
    for (const value of ['1', 'true', 'false', 'off', 'no', '', '  ', 'oops']) {
      process.env.RDK_SIM2REAL_STORAGE_LEASE = value;
      expect(storageLeaseCheckEnabled()).toBe(true);
    }
    process.env.RDK_SIM2REAL_STORAGE_LEASE = '0';
    expect(storageLeaseCheckEnabled()).toBe(false);
  });

  it('uses a bounded cross-host staleness threshold with a 300 s default', () => {
    delete process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS;
    expect(storageLeaseStaleSeconds()).toBe(DEFAULT_STORAGE_LEASE_STALE_SECONDS);
    expect(DEFAULT_STORAGE_LEASE_STALE_SECONDS).toBe(300);
    process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS = '60';
    expect(storageLeaseStaleSeconds()).toBe(60);
    process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS = String(MIN_STORAGE_LEASE_STALE_SECONDS);
    expect(storageLeaseStaleSeconds()).toBe(MIN_STORAGE_LEASE_STALE_SECONDS);
    process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS = String(MAX_STORAGE_LEASE_STALE_SECONDS);
    expect(storageLeaseStaleSeconds()).toBe(MAX_STORAGE_LEASE_STALE_SECONDS);
    for (const invalid of [
      'abc',
      '0',
      '-1',
      '1.5',
      'Infinity',
      '99999999',
      String(MIN_STORAGE_LEASE_STALE_SECONDS - 1),
    ]) {
      process.env.RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS = invalid;
      expect(storageLeaseStaleSeconds()).toBe(DEFAULT_STORAGE_LEASE_STALE_SECONDS);
    }
  });
});

describe('isProcessAlive', () => {
  it('reports this process and an EPERM pid as alive and an ESRCH pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementation(() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });
    expect(isProcessAlive(12_345)).toBe(true);
    kill.mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });
    expect(isProcessAlive(12_345)).toBe(false);
    // An unknown probe failure is not proof of death.
    kill.mockImplementation(() => {
      throw new Error('unexpected');
    });
    expect(isProcessAlive(12_345)).toBe(true);
  });
});

describe('writer lease file lifecycle', () => {
  it('writes a complete lease when the directory has none', async () => {
    const root = await useTempStorage();
    const result = await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    });

    expect(result.verdict).toBe('acquire');
    expect(result.lease).toEqual({
      schemaVersion: STORAGE_LEASE_SCHEMA_VERSION,
      host: SELF.host,
      pid: SELF.pid,
      startedAt: SELF.startedAt,
      heartbeatAt: new Date(NOW_MS).toISOString(),
    });
    const raw = await fs.readFile(storageLeaseFilePath(root), 'utf8');
    expect(JSON.parse(raw)).toEqual(result.lease);
  });

  it('renews idempotently: keeps startedAt and refreshes heartbeatAt', async () => {
    const root = await useTempStorage();
    const first = await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    });
    const laterMs = NOW_MS + 60_000;
    const second = await acquireStorageLease(root, {
      self: SELF,
      nowMs: laterMs,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    });

    expect(first.verdict).toBe('acquire');
    expect(second.verdict).toBe('renew');
    expect(second.lease?.startedAt).toBe(SELF.startedAt);
    expect(second.lease?.heartbeatAt).toBe(new Date(laterMs).toISOString());
    expect(await fs.readFile(storageLeaseFilePath(root), 'utf8')).toContain(
      new Date(laterMs).toISOString(),
    );
  });

  it('conflicts with a live foreign pid on the same host and leaves its lease intact', async () => {
    const root = await useTempStorage();
    const foreign = lease({ pid: SELF.pid + 1 });
    const file = storageLeaseFilePath(root);
    await fs.writeFile(file, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const error = await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    }).catch((thrown: unknown) => thrown);

    expect(isSim2RealError(error)).toBe(true);
    expect(sim2RealErrorCode(error)).toBe('sim2real_storage_writer_conflict');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('另一个进程正在写这个存储目录'));
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(foreign);
  });

  it('takes over a dead foreign pid on the same host', async () => {
    const root = await useTempStorage();
    const file = storageLeaseFilePath(root);
    await fs.writeFile(file, JSON.stringify(lease({ pid: SELF.pid + 1 })), 'utf8');

    const result = await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysDead,
      staleMs: STALE_MS,
    });

    expect(result.verdict).toBe('takeover');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      host: SELF.host,
      pid: SELF.pid,
      startedAt: SELF.startedAt,
    });
    expect(await storageLeaseBelongsToSelf(root)).toBe(true);
  });

  it('treats a same-pid predecessor by heartbeat freshness, not by pid liveness', async () => {
    const root = await useTempStorage();
    const file = storageLeaseFilePath(root);
    const predecessor = lease({
      startedAt: '2025-12-31T00:00:00.000Z',
      heartbeatAt: new Date(NOW_MS - 1_000).toISOString(),
    });
    await fs.writeFile(file, JSON.stringify(predecessor), 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      acquireStorageLease(root, {
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).rejects.toThrow('sim2real_storage_writer_conflict');

    predecessor.heartbeatAt = new Date(NOW_MS - STALE_MS - 1).toISOString();
    await fs.writeFile(file, JSON.stringify(predecessor), 'utf8');
    const result = await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    });
    expect(result.verdict).toBe('takeover');
    expect(result.lease?.startedAt).toBe(SELF.startedAt);
  });

  it('conflicts with a fresh cross-host heartbeat and takes over an expired one', async () => {
    const root = await useTempStorage();
    const file = storageLeaseFilePath(root);
    const foreign = lease({
      host: 'host-b',
      pid: 7,
      heartbeatAt: new Date(NOW_MS - 1_000).toISOString(),
    });
    await fs.writeFile(file, JSON.stringify(foreign), 'utf8');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      acquireStorageLease(root, {
        self: SELF,
        nowMs: NOW_MS,
        isProcessAlive: alwaysAlive,
        staleMs: STALE_MS,
      }),
    ).rejects.toThrow('sim2real_storage_writer_conflict');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(foreign);

    const stale = lease({
      host: 'host-b',
      pid: 7,
      heartbeatAt: new Date(NOW_MS - STALE_MS - 1).toISOString(),
    });
    await fs.writeFile(file, JSON.stringify(stale), 'utf8');
    const result = await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    });
    expect(result.verdict).toBe('takeover');
    expect(logged).toHaveBeenCalled();
  });

  it('never treats a corrupt lease file as "no lease"', async () => {
    const root = await useTempStorage();
    const file = storageLeaseFilePath(root);
    const corrupt = '{"schemaVersion":1,"host":"host-a","pid":';
    await fs.writeFile(file, corrupt, 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const error = await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    }).catch((thrown: unknown) => thrown);

    expect(sim2RealErrorCode(error)).toBe('sim2real_storage_writer_conflict');
    expect(await fs.readFile(file, 'utf8')).toBe(corrupt);
  });

  it('skips the file entirely when RDK_SIM2REAL_STORAGE_LEASE=0', async () => {
    const root = await useTempStorage();
    const file = storageLeaseFilePath(root);
    const foreign = lease({ pid: SELF.pid + 1 });
    await fs.writeFile(file, JSON.stringify(foreign), 'utf8');
    process.env.RDK_SIM2REAL_STORAGE_LEASE = '0';

    const result = await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    });

    expect(result).toEqual({ verdict: 'disabled', lease: null });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(foreign);
  });

  it('releases only a lease this exact process incarnation still holds', async () => {
    const root = await useTempStorage();
    const file = storageLeaseFilePath(root);
    await acquireStorageLease(root, {
      self: SELF,
      nowMs: NOW_MS,
      isProcessAlive: alwaysAlive,
      staleMs: STALE_MS,
    });

    // A different incarnation (same host and pid, new start time) must not
    // delete the lease of the process that actually holds it.
    const successor = { ...SELF, startedAt: '2026-02-02T00:00:00.000Z' };
    await expect(releaseStorageLease(root, { self: successor })).resolves.toBe(false);
    await expect(fs.readFile(file, 'utf8')).resolves.toContain(SELF.startedAt);

    await expect(releaseStorageLease(root, { self: SELF })).resolves.toBe(true);
    await expect(fs.readFile(file, 'utf8')).rejects.toThrow();
    // Releasing twice is a no-op, not an error.
    await expect(releaseStorageLease(root, { self: SELF })).resolves.toBe(false);
  });
});

/** True when the on-disk lease is owned by the injected fake `SELF` identity. */
async function storageLeaseBelongsToSelf(root: string): Promise<boolean> {
  const raw = await fs.readFile(storageLeaseFilePath(root), 'utf8');
  const record = parseStorageLease(raw);
  return record !== null && storageLeaseBelongsTo(record, SELF);
}

describe('storage lease helpers', () => {
  it('uses the documented file name and a stable self identity', () => {
    expect(STORAGE_LEASE_FILE_NAME).toBe('writer-lease.json');
    expect(storageLeaseFilePath('/tmp/example')).toBe('/tmp/example/writer-lease.json');
    const self = storageLeaseSelf();
    expect(self.host).toBe(os.hostname());
    expect(self.pid).toBe(process.pid);
    expect(Number.isFinite(Date.parse(self.startedAt))).toBe(true);
    expect(storageLeaseSelf()).toEqual(self);
  });
});
