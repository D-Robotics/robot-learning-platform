import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import {
  createSim2RealDeployment,
  getSim2RealDeployment,
  invalidateSim2RealStoreCacheForTest,
  updateSim2RealDeployment,
} from './sim2real-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  invalidateSim2RealStoreCacheForTest();
});

function deployment() {
  return {
    modelId: BUILTIN_MICRODUCK_MODEL.id,
    deviceId: 'board-1',
    targetPlatform: 'rdk-x5',
    mode: 'preflight' as const,
    status: 'planned' as const,
    summary: 'plan',
    compatibility: {
      platformId: 'rdk-x5',
      status: 'compatible' as const,
      result: {} as never,
      deployable: true,
      reason: 'ok',
    },
    steps: [],
  };
}

describe('deployment lifecycle ledger', () => {
  it('persists append-only history and keeps cancellation terminal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-deployment-lifecycle-'));
    roots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = root;
    const created = await createSim2RealDeployment(deployment());
    expect(created.history).toHaveLength(1);

    const cancelled = await updateSim2RealDeployment(created.id, {
      status: 'cancelled',
      summary: 'cancelled',
    });
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'created', status: 'planned' }),
      expect.objectContaining({ type: 'cancelled', status: 'cancelled' }),
    ]));

    const lateProbe = await updateSim2RealDeployment(created.id, {
      status: 'ready',
      summary: 'late probe',
    });
    expect(lateProbe?.status).toBe('cancelled');
    expect((await getSim2RealDeployment(created.id))?.status).toBe('cancelled');
  });
});
