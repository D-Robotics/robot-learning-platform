import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_MICRODUCK_MODEL, type Sim2RealTrainingData } from '../../shared/sim2real.js';
import {
  createSim2RealRun,
  getSim2RealRun,
  invalidateSim2RealStoreCacheForTest,
  sim2RealStorageReadiness,
} from './sim2real-store.js';

let root: string;
const trainingData: Sim2RealTrainingData = {
  sourceRunId: 'recording-1',
  telemetryRevision: 'a'.repeat(64),
  source: 'browser',
  rows: 12,
  sha256: 'b'.repeat(64),
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-training-data-store-'));
  vi.stubEnv('RDK_SIM2REAL_STORAGE_DIR', root);
  vi.stubEnv('RDK_SIM2REAL_DEPLOYMENT', 'local');
  invalidateSim2RealStoreCacheForTest();
});
afterEach(async () => {
  invalidateSim2RealStoreCacheForTest();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function create(trainingData?: Sim2RealTrainingData) {
  return createSim2RealRun(
    {
      modelId: BUILTIN_MICRODUCK_MODEL.id,
      backend: 'local',
      status: 'completed',
      summary: 'training snapshot',
      ...(trainingData ? { trainingData } : {}),
    },
    'alice',
  );
}
describe('durable training snapshot metadata', () => {
  it('preserves the complete frozen identity across a real process restart', async () => {
    const run = await create(trainingData);
    const moduleUrl = new URL('./sim2real-store.ts', import.meta.url).href;
    const restarted = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '-e',
        `import { getSim2RealRun } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await getSim2RealRun(${JSON.stringify(run.id)}, 'alice')));`,
      ],
      { env: { ...process.env }, encoding: 'utf8', timeout: 10_000 },
    );
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout).trainingData).toEqual(trainingData);
    expect(JSON.parse(restarted.stdout)).not.toHaveProperty('owner');
  });
  it('continues reading pre-feature ledger Runs without trainingData', async () => {
    const run = await create();
    invalidateSim2RealStoreCacheForTest();
    expect((await getSim2RealRun(run.id, 'alice'))?.trainingData).toBeUndefined();
  });
  it.each([
    null,
    [],
    {},
    { ...trainingData, sourceRunId: '../another-owner' },
    { ...trainingData, telemetryRevision: 'not-a-digest' },
    { ...trainingData, sha256: 'z'.repeat(64) },
    { ...trainingData, source: 'demo-fixture' },
    { ...trainingData, source: ['browser'] },
    { ...trainingData, rows: 11 },
    { ...trainingData, rows: 12.5 },
    { ...trainingData, rows: 2_000_001 },
    { ...trainingData, jsonl: '{"observation":[1]}\n' },
  ])(
    'fails closed on corrupt snapshot metadata %# without overwriting the ledger',
    async (invalid) => {
      const run = await create(trainingData);
      const file = path.join(root, 'sim2real.json');
      const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
      ledger.runs.find((item: { id: string }) => item.id === run.id).trainingData = invalid;
      const bytes = JSON.stringify(ledger);
      await fs.writeFile(file, bytes);
      invalidateSim2RealStoreCacheForTest();
      await expect(getSim2RealRun(run.id, 'alice')).rejects.toThrow('sim2real_storage_unavailable');
      await expect(sim2RealStorageReadiness()).resolves.toMatchObject({ writable: false });
      expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    },
  );
});
