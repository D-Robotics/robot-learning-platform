import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

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

export type StationSwitch = 'drive' | 'policy';

const ENV_FLAG: Record<StationSwitch, string> = {
  drive: 'RDK_SIM2REAL_STATION_DRIVE_ENABLED',
  policy: 'RDK_SIM2REAL_STATION_POLICY_ENABLED',
};

function switchesFile(): string {
  return path.join(resolveDataDir(), 'station-switches.json');
}

interface StoredSwitches {
  drive?: boolean;
  policy?: boolean;
}

function readOverrides(): StoredSwitches {
  try {
    const parsed: unknown = JSON.parse(readFileSync(switchesFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    return {
      drive: source.drive === true || source.drive === false ? source.drive : undefined,
      policy: source.policy === true || source.policy === false ? source.policy : undefined,
    };
  } catch {
    return {};
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
  const dir = resolveDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${switchesFile()}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(temporary, switchesFile());
}

/** Drop one switch's override, falling back to the env default. */
export function clearStationSwitch(name: StationSwitch): void {
  const current = readOverrides();
  if (!(name in current)) return;
  delete current[name];
  const dir = resolveDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${switchesFile()}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(current, null, 2), { mode: 0o600 });
  renameSync(temporary, switchesFile());
}
