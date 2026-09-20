import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Sim2RealError } from './sim2real-errors.js';
import { resolveDataDir } from './standalone-adapters.js';

/**
 * Runtime platform switches for the station drive/policy surfaces.
 *
 * The env flags (RDK_SIM2REAL_STATION_DRIVE_ENABLED / _POLICY_ENABLED) stay
 * the deploy-time default and remain the answer when no runtime override has
 * ever been written. A web toggle persists an explicit override into
 * `<dataDir>/station-switches.json` (0600, atomic rename) so it survives
 * restarts; `npm run dev` operators can still flip the env and delete the
 * override file. The safety semantics are unchanged: every motion path still
 * requires BOTH this platform switch and the board agent switch, and the
 * emergency-stop endpoints never consult either.
 */

export type StationSwitch = 'drive' | 'policy' | 'arm';

const ENV_FLAG: Record<StationSwitch, string> = {
  drive: 'RDK_SIM2REAL_STATION_DRIVE_ENABLED',
  policy: 'RDK_SIM2REAL_STATION_POLICY_ENABLED',
  arm: 'RDK_SIM2REAL_STATION_ARM_ENABLED',
};

function switchesFile(): string {
  return path.join(resolveDataDir(), 'station-switches.json');
}

interface StoredSwitches {
  drive?: boolean;
  policy?: boolean;
  arm?: boolean;
}

const MAX_SWITCHES_FILE_BYTES = 16 * 1024;
const NO_FOLLOW = Number(fsConstants.O_NOFOLLOW ?? 0);
// Avoid blocking forever if an override path is replaced with a FIFO before
// the regular-file check. O_NONBLOCK has no effect on normal files.
const NO_BLOCK = Number(fsConstants.O_NONBLOCK ?? 0);

function storageUnavailable(detail: string, cause?: unknown): Sim2RealError {
  return new Sim2RealError('sim2real_storage_unavailable', {
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function readOverrides(): StoredSwitches {
  const file = switchesFile();
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW prevents a symlinked override from changing the effective
    // safety state.  Keep an lstat fallback for a platform whose Node runtime
    // does not expose the flag; supported Unix hosts take the race-resistant
    // descriptor path below.
    if (!NO_FOLLOW) {
      const linkStat = lstatSync(file);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
        throw new Error('station switch registry is not a regular file');
      }
    }
    descriptor = openSync(file, fsConstants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('station switch registry is not a regular file');
    if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      throw new Error('station switch registry permissions are unsafe');
    }
    if (stat.size > MAX_SWITCHES_FILE_BYTES) {
      throw new Error('station switch registry exceeds the size limit');
    }
    const parsed: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('station switch registry shape is invalid');
    }
    const source = parsed as Record<string, unknown>;
    const unknownKeys = Object.keys(source).filter(
      (key) => key !== 'drive' && key !== 'policy' && key !== 'arm',
    );
    if (unknownKeys.length) throw new Error('station switch registry contains unknown keys');
    if (
      (source.drive !== undefined && typeof source.drive !== 'boolean') ||
      (source.policy !== undefined && typeof source.policy !== 'boolean') ||
      (source.arm !== undefined && typeof source.arm !== 'boolean')
    ) {
      throw new Error('station switch registry contains a non-boolean override');
    }
    return {
      drive: typeof source.drive === 'boolean' ? source.drive : undefined,
      policy: typeof source.policy === 'boolean' ? source.policy : undefined,
      arm: typeof source.arm === 'boolean' ? source.arm : undefined,
    };
  } catch (error) {
    // A missing override file is the documented state in which env defaults
    // apply. Any other failure is different: falling back to an env value can
    // accidentally turn motion on after the durable state became corrupt.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    if (error instanceof Sim2RealError) throw error;
    throw storageUnavailable(
      'station switch registry is unreadable; refusing to infer an enabled motion state',
      error,
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Preserve the read result/error; a close failure never enables a switch. */
      }
    }
  }
}

function writeOverrides(next: StoredSwitches): void {
  const file = switchesFile();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const dir = resolveDataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* best-effort cleanup; preserve the original write failure */
    }
    if (error instanceof Sim2RealError) throw error;
    throw storageUnavailable(
      'station switch registry could not be persisted; refusing to report a successful toggle',
      error,
    );
  }
}

/** Current state of one platform switch (runtime override > env default). */
export function stationSwitchEnabled(name: StationSwitch): boolean {
  const override = readOverrides()[name];
  if (typeof override === 'boolean') return override;
  return String(process.env[ENV_FLAG[name]] ?? '').trim() === '1';
}

/** Persist an explicit override for one switch. */
export function setStationSwitch(name: StationSwitch, enabled: boolean): void {
  const next = { ...readOverrides(), [name]: enabled === true };
  writeOverrides(next);
}

/** Drop one switch's override, falling back to the env default. */
export function clearStationSwitch(name: StationSwitch): void {
  const current = readOverrides();
  if (!(name in current)) return;
  delete current[name];
  writeOverrides(current);
}
