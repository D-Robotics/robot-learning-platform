import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { clearStationSwitch, setStationSwitch, stationSwitchEnabled } from './station-switches.js';

const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousDrive = process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
const previousPolicy = process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousDrive === undefined) delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
  else process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = previousDrive;
  if (previousPolicy === undefined) delete process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;
  else process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = previousPolicy;
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-station-switches-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
  delete process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;
  return root;
}

describe('station switch registry safety', () => {
  it('fails closed on corrupt state instead of falling back to an enabled env flag', async () => {
    const root = await fixture();
    process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = '1';
    const file = path.join(root, 'station-switches.json');
    const corrupt = '{"drive": tru';
    await fs.writeFile(file, corrupt, { mode: 0o600 });

    expect(() => stationSwitchEnabled('drive')).toThrowError('sim2real_storage_unavailable');
    expect(() => setStationSwitch('drive', false)).toThrowError('sim2real_storage_unavailable');
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(corrupt);
  });

  it('rejects a symlinked override without touching its target', async () => {
    const root = await fixture();
    const file = path.join(root, 'station-switches.json');
    const target = path.join(root, 'outside.json');
    await fs.writeFile(target, '{"drive":true}\n', { mode: 0o600 });
    await fs.symlink(target, file);

    expect(() => stationSwitchEnabled('drive')).toThrowError('sim2real_storage_unavailable');
    expect(() => clearStationSwitch('drive')).toThrowError('sim2real_storage_unavailable');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('{"drive":true}\n');
  });

  it('rejects an override whose group/world mode could change motion state', async () => {
    const root = await fixture();
    const file = path.join(root, 'station-switches.json');
    await fs.writeFile(file, '{"drive":false}\n', { mode: 0o600 });
    await fs.chmod(file, 0o644);
    const before = await fs.readFile(file, 'utf8');

    expect(() => stationSwitchEnabled('drive')).toThrowError('sim2real_storage_unavailable');
    expect(() => setStationSwitch('drive', true)).toThrowError('sim2real_storage_unavailable');
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(before);
  });

  it('keeps the normal env and explicit override behavior', async () => {
    await fixture();
    process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
    expect(stationSwitchEnabled('policy')).toBe(true);
    setStationSwitch('policy', false);
    expect(stationSwitchEnabled('policy')).toBe(false);
    clearStationSwitch('policy');
    expect(stationSwitchEnabled('policy')).toBe(true);
  });
});
