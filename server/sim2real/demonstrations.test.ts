import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_MICRODUCK_MODEL, trainingSpecForProfile } from '../../shared/sim2real.js';
import { appendSim2RealTelemetry, createSim2RealRun } from './sim2real-store.js';
import { resolveRecordedDemonstrations } from './demonstrations.js';

const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
let root = '';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-demonstrations-'));
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
});
afterEach(async () => {
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  await fs.rm(root, { recursive: true, force: true });
});

function samples(episodes = 8) {
  return Array.from({ length: episodes * 4 }, (_, i) => ({
    t: i / 50,
    observation: Array(61).fill(i / 100),
    action: Array(14).fill(0.25),
    done: i % 4 === 3,
  }));
}
async function recording(
  owner = 'alice',
  options: { mock?: boolean; episodes?: number; source?: 'import' | 'demo-fixture' } = {},
) {
  const run = await createSim2RealRun(
    {
      modelId: BUILTIN_MICRODUCK_MODEL.id,
      backend: 'contract',
      status: 'completed',
      summary: 'Imported demonstrations',
      ...(options.mock ? { mock: true } : {}),
    },
    owner,
  );
  await appendSim2RealTelemetry(
    {
      runId: run.id,
      modelId: run.modelId,
      source: options.source || 'import',
      contractId: 'microduck-policy-v1',
      sequence: 0,
      samples: samples(options.episodes),
    },
    owner,
  );
  return run;
}
const input = (runId: string, engine: 'act' | 'diffusion-policy' = 'act') => ({
  model: BUILTIN_MICRODUCK_MODEL,
  owner: 'alice',
  training: { ...trainingSpecForProfile('smoke'), engine, demonstrationRunId: runId },
});

describe('recorded demonstration resolution', () => {
  it.each(['act', 'diffusion-policy'] as const)(
    'pins all accepted %s rows without replacing actions',
    async (engine) => {
      const run = await recording();
      const data = await resolveRecordedDemonstrations(input(run.id, engine));
      expect(data).toMatchObject({ sourceRunId: run.id, sampleCount: 32, episodeCount: 8 });
      expect(data!.sha256).toBe(createHash('sha256').update(data!.jsonl).digest('hex'));
      expect(data!.jsonl.trim().split('\n')).toHaveLength(32);
      expect(JSON.parse(data!.jsonl.split('\n')[0]).action).toEqual(Array(14).fill(0.25));
    },
  );
  it('refuses another account, Mock runs, demo fixtures and cross-project input', async () => {
    for (const run of [
      await recording('bob'),
      await recording('alice', { mock: true }),
      await recording('alice', { source: 'demo-fixture' }),
    ])
      await expect(resolveRecordedDemonstrations(input(run.id))).rejects.toMatchObject({
        code: 'SIM2REAL_DEMONSTRATION_SOURCE_INVALID',
      });
    const run = await recording();
    await expect(
      resolveRecordedDemonstrations({ ...input(run.id), projectId: 'another-project' }),
    ).rejects.toMatchObject({ code: 'SIM2REAL_DEMONSTRATION_PROJECT_MISMATCH' });
  });
  it('refuses insufficient episodes instead of manufacturing boundaries', async () => {
    const run = await recording('alice', { episodes: 1 });
    await expect(resolveRecordedDemonstrations(input(run.id))).rejects.toMatchObject({
      code: 'SIM2REAL_DEMONSTRATION_EPISODES_INVALID',
    });
  });
  it('refuses contract dimensions and empty sources', async () => {
    const run = await recording();
    const model = structuredClone(BUILTIN_MICRODUCK_MODEL);
    model.manifest.contract.observationSize = 60;
    await expect(resolveRecordedDemonstrations({ ...input(run.id), model })).rejects.toMatchObject({
      code: 'SIM2REAL_DEMONSTRATION_CONTRACT_MISMATCH',
    });
    const empty = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'No data',
      },
      'alice',
    );
    await expect(resolveRecordedDemonstrations(input(empty.id))).rejects.toMatchObject({
      code: 'SIM2REAL_DEMONSTRATION_EPISODES_INVALID',
    });
  });
  it('refuses data outside the byte or shard budget instead of truncating it', async () => {
    const large = await recording('alice', { episodes: 1000 });
    await expect(resolveRecordedDemonstrations(input(large.id))).rejects.toMatchObject({
      code: 'SIM2REAL_DEMONSTRATION_TOO_LARGE',
    });
    const fragmented = await recording();
    for (let sequence = 1; sequence <= 16; sequence += 1)
      await appendSim2RealTelemetry(
        {
          runId: fragmented.id,
          modelId: fragmented.modelId,
          source: 'import',
          sequence,
          samples: samples().map((sample) => ({ ...sample, t: sample.t + sequence * 2 })),
        },
        'alice',
      );
    await expect(resolveRecordedDemonstrations(input(fragmented.id))).rejects.toMatchObject({
      code: 'SIM2REAL_DEMONSTRATION_TOO_LARGE',
    });
  });
});
