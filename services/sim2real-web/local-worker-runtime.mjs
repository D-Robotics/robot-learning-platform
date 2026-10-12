import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

/** Atomic replacement; an error after rename means uncertain durability.
 * Callers must retain the reservation and pause admissions on any failure. */
export async function writeDurableWorkerJson(file, value, io = fs) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await io.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.rename(temporary, file);
    // Persist the replacement directory entry as well as the file bytes.
    // macOS/Linux support syncing a directory opened for reading.
    const directory = await io.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await io.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function workerKillGraceMs(raw = process.env.RDK_SIM2REAL_TRAIN_KILL_GRACE_MS) {
  const value = Number(raw ?? 2000);
  return Number.isSafeInteger(value) && value >= 100 && value <= 30_000 ? value : 2000;
}

/**
 * Only accepts a ChildProcess spawned by this worker. On macOS/Linux it owns
 * a new process group (spawn's detached option); negative PID signals are
 * confined to that group and also reach non-detached engine subprocesses.
 */
export async function terminateWorkerChild(child, { grouped, graceMs = workerKillGraceMs() }) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  const signal = (name) => {
    try {
      if (grouped) process.kill(-child.pid, name);
      else child.kill(name);
      return true;
    } catch (error) {
      if (error?.code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!signal('SIGTERM')) return;
  // Reclaim lingering descendants even if the group leader exits on TERM.
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  signal('SIGKILL');
}
