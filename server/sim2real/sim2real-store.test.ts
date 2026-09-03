import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import {
  createSim2RealModel,
  createSim2RealRun,
  getSim2RealModel,
  invalidateSim2RealStoreCacheForTest,
  listSim2RealModels,
  listSim2RealRuns,
  sim2RealStorageInfo,
} from './sim2real-store.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;

afterEach(async () => {
  invalidateSim2RealStoreCacheForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
});

async function useTempStorage(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-store-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  invalidateSim2RealStoreCacheForTest();
  return root;
}

describe('Sim2Real owner-scoped ledger', () => {
  it('keeps models and run history isolated by owner and omits owner fields from responses', async () => {
    const root = await useTempStorage();
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'alice-policy';
    manifest.displayName = 'Alice policy';
    manifest.version = '1.0.0';

    const model = await createSim2RealModel(manifest, 'alice');
    await createSim2RealRun(
      {
        modelId: model.id,
        backend: 'contract',
        status: 'completed',
        summary: 'contract checked',
        metrics: { contractValid: true, observationSize: 61, actionSize: 14 },
      },
      'alice',
    );

    expect(await listSim2RealModels('alice')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: model.id,
          manifest: expect.objectContaining({ modelId: 'alice-policy' }),
        }),
      ]),
    );
    expect(await listSim2RealModels('bob')).toHaveLength(1);
    expect(await getSim2RealModel(model.id, 'bob')).toBeNull();
    expect(await listSim2RealRuns('bob')).toHaveLength(0);
    expect(await listSim2RealRuns('alice')).toHaveLength(1);

    const raw = await fs.readFile(path.join(root, 'sim2real.json'), 'utf8');
    expect(raw).toContain('alice');
    expect(JSON.stringify(await listSim2RealModels('alice'))).not.toContain('"owner"');
  });

  it('fails closed for Web Cloud when no explicit shared storage is configured', async () => {
    delete process.env.RDK_SIM2REAL_STORAGE_DIR;
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'web-cloud';
    invalidateSim2RealStoreCacheForTest();

    expect(sim2RealStorageInfo()).toMatchObject({ mode: 'external-required', writable: false });
    await expect(
      createSim2RealModel(structuredClone(BUILTIN_MICRODUCK_MODEL.manifest), 'alice'),
    ).rejects.toThrow('sim2real_storage_not_configured');
    await expect(listSim2RealModels('alice')).resolves.toHaveLength(1);
  });
});
