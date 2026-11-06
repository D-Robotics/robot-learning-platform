import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkshopSessions } from './workshop-session.js';
describe('Workshop button workflow', () => {
  it('requires explicit budget, serializes claims and never retries an uncertain write', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-test-'));
    const store = createWorkshopSessions({
      root: () => root,
      getRun: async () => null,
      findRun: async () => null,
      remember: async () => {},
    });
    try {
      const draft = await store.create({ modelId: 'm', computeResourceId: 'r' }, 'alice');
      expect(draft.training).toBeNull();
      await expect(store.claim(draft.contextId, 'train', {}, 'alice')).rejects.toThrow();
      const args = { timesteps: 8192, seed: 7, pushMaxForce: 8.1, reference: 'skipped' };
      const claims = await Promise.allSettled([
        store.claim(draft.contextId, 'train', args, 'alice'),
        store.claim(draft.contextId, 'train', args, 'alice'),
      ]);
      expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
      expect((await store.read(draft.contextId, 'alice')).stage).toBe('unknown');
      const pending = await store.read(draft.contextId, 'alice');
      expect(pending).toMatchObject({ stage: 'unknown', recoveryPhase: 'train' });
      const original = claims.find((claim) => claim.status === 'fulfilled');
      expect(await store.claim(draft.contextId, 'train', { recover: true }, 'alice')).toEqual(
        original?.status === 'fulfilled' ? original.value : undefined,
      );
      await expect(
        store.claim(draft.contextId, 'train', { recover: true, seed: 8 }, 'alice'),
      ).rejects.toThrow();
      await expect(
        store.claim(draft.contextId, 'train', { recover: true }, 'bob'),
      ).rejects.toThrow();
      await expect(store.claim(draft.contextId, 'train', args, 'alice')).rejects.toThrow();
      await expect(store.read(draft.contextId, 'bob')).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('keeps account current selection explicit and shared across fresh instances', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-current-'));
    const deps = {
      root: () => root,
      getRun: async () => null,
      findRun: async () => null,
      remember: async () => {},
    };
    try {
      const a = createWorkshopSessions(deps);
      const one = await a.create({ modelId: 'm', computeResourceId: 'r' }, 'alice');
      await a.create({ modelId: 'm', computeResourceId: 'r' }, 'bob');
      const fresh = createWorkshopSessions(deps);
      expect((await fresh.current('alice'))?.contextId).toBe(one.contextId);
      expect(await fresh.current('nobody')).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('restoration and consent', () => {
  it('recovers a lost reference from its exact owner-scoped idempotency key and preserves a paused evaluation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-recover-'));
    const runs = new Map<string, any>();
    const keys = new Map<string, any>();
    const saved: any[] = [];
    const deps = {
      root: () => root,
      getRun: async (id: string) => runs.get(id) ?? null,
      findRun: async (key: string) => keys.get(key) ?? null,
      remember: async (x: any) => {
        saved.push(x);
      },
    };
    try {
      const store = createWorkshopSessions(deps),
        draft = await store.create({ modelId: 'm', computeResourceId: 'r' }, 'alice');
      await store.reference(draft.contextId, 'observed', 'alice');
      expect((await createWorkshopSessions(deps).current('alice'))?.reference).toBe('observed');
      const claim = await store.claim(
        draft.contextId,
        'train',
        { timesteps: 8192, seed: 7, pushMaxForce: 8.1, reference: 'observed' },
        'alice',
      );
      const run = {
        id: 't',
        modelId: 'm',
        computeResourceId: 'r',
        taskId: 'originman-recovery',
        status: 'completed',
        mock: false,
        training: claim.submission.training,
        metrics: { originmanWorkshop: { phase: 'train', policySha256: 'a'.repeat(64) } },
      };
      runs.set('t', run);
      keys.set(draft.contextId + '-train', run);
      expect((await store.read(draft.contextId, 'alice')).training?.runId).toBe('t');
      await expect(
        store.claim(draft.contextId, 'train', { recover: true }, 'alice'),
      ).rejects.toThrow();
      await store.pause(draft.contextId, 'alice');
      await expect(store.claim(draft.contextId, 'evaluate', {}, 'alice')).rejects.toThrow();
      await store.continue(draft.contextId, 'alice');
      const evaluation = await store.claim(draft.contextId, 'evaluate', {}, 'alice');
      expect(evaluation.submission.training.originmanWorkshop.sourceRunId).toBe('t');
      expect(evaluation.submission.training.originmanWorkshop.timesteps).toBe(8192);
      expect((await store.read(draft.contextId, 'alice')).recoveryPhase).toBe('evaluate');
      expect(await store.claim(draft.contextId, 'evaluate', { recover: true }, 'alice')).toEqual(
        evaluation,
      );
      expect(saved.some((s) => s.runId === 't')).toBe(true);
      await expect(store.claim(draft.contextId, 'evaluate', {}, 'alice')).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('cannot evaluate mock, failed, nonterminal or unverified training', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-reject-'));
    let run: any = null;
    const store = createWorkshopSessions({
      root: () => root,
      getRun: async () => run,
      findRun: async () => run,
      remember: async () => {},
    });
    try {
      const d = await store.create({ modelId: 'm', computeResourceId: 'r' }, 'alice');
      const c = await store.claim(
        d.contextId,
        'train',
        { timesteps: 8192, seed: 7, pushMaxForce: 8.1, reference: 'skipped' },
        'alice',
      );
      for (const state of [
        { status: 'running', mock: false },
        { status: 'failed', mock: false },
        { status: 'completed', mock: true },
        { status: 'completed', mock: false },
      ]) {
        run = {
          id: 't',
          modelId: 'm',
          computeResourceId: 'r',
          taskId: 'originman-recovery',
          training: c.submission.training,
          ...state,
        };
        await expect(store.claim(d.contextId, 'evaluate', {}, 'alice')).rejects.toThrow();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

it('compares a durable three-round chain and rejects foreign or incomparable evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-compare-'));
  const runs = new Map<string, any>();
  const keys = new Map<string, any>();
  const deps = {
    root: () => root,
    getRun: async (id: string) => runs.get(id) ?? null,
    findRun: async (key: string) => keys.get(key) ?? null,
    remember: async () => {},
  };
  const store = createWorkshopSessions(deps);
  const owner = 'alice';
  const hash = 'a'.repeat(64);
  const protocol = Object.fromEntries(
    [
      'modelSha256',
      'evaluatorSha256',
      'runtimeSha256',
      'physicalConfigSha256',
      'conditionsSha256',
      'controllerSha256',
    ].map((key) => [key, hash]),
  );
  const finish = async (context: string, timesteps: number, recovered: number) => {
    const recipe = { timesteps, seed: 7, pushMaxForce: 8.1, reference: 'skipped' as const };
    for (const phase of ['train', 'evaluate'] as const) {
      await store.claim(context, phase, phase === 'train' ? recipe : {}, owner);
      const run = {
        id: context + '-' + phase,
        modelId: 'm',
        computeResourceId: 'r',
        taskId: 'originman-recovery',
        mock: false,
        status: 'completed',
        training: {
          engine: 'originman-recovery-reflect',
          algorithm: 'sac',
          numEnvs: 4,
          originmanWorkshop: {
            ...recipe,
            groupId: context,
            phase,
            ...(phase === 'evaluate' ? { sourceRunId: context + '-train' } : {}),
          },
        },
        metrics: {
          originmanWorkshop: {
            phase,
            policySha256: hash,
            actorRecipe: 'reflection-equivariant',
            trainingDevice: 'cuda',
            actualTimesteps: timesteps,
            ...(phase === 'evaluate'
              ? {
                  sourceRunId: context + '-train',
                  feedbackComparison: {
                    protocol: { ...protocol },
                    baselineSha256: hash,
                    suites: ['historical', 'additional'].map((id) => ({
                      id,
                      cases: Array.from({ length: 31 }, (_, index) => ({
                        index,
                        force: 7,
                        start: 2,
                        duration: 0.2,
                        original: index < 13,
                        tuned: index < 17,
                        rl: index < recovered,
                      })),
                    })),
                  },
                }
              : {}),
          },
        },
      };
      runs.set(run.id, run);
      keys.set(run.id, run);
      await store.read(context, owner);
    }
  };
  try {
    const base = await store.create({ modelId: 'm', computeResourceId: 'r' }, owner);
    await finish(base.contextId, 8192, 1);
    const second = await store.create(
      { modelId: 'm', computeResourceId: 'r', comparisonBaseId: base.contextId },
      owner,
    );
    expect(second).toMatchObject({
      reference: 'skipped',
      comparisonBase: { contextId: base.contextId, recipe: { timesteps: 8192 } },
    });
    await finish(second.contextId, 16384, 2);
    const third = await store.create(
      { modelId: 'm', computeResourceId: 'r', comparisonBaseId: second.contextId },
      owner,
    );
    await finish(third.contextId, 500000, 27);
    const fresh = createWorkshopSessions(deps);
    const result = await fresh.compare(third.contextId, undefined, owner);
    expect(result).toMatchObject({ comparable: true, sameTrainingSetup: true });
    expect(result.rounds.map((r) => [r.recipe.timesteps, r.suites[0].recovered])).toEqual([
      [8192, 1],
      [16384, 2],
      [500000, 27],
    ]);
    await expect(fresh.compare(third.contextId, base.contextId, 'bob')).rejects.toThrow();
    await expect(
      fresh.create(
        { modelId: 'm', computeResourceId: 'r', comparisonBaseId: base.contextId },
        'bob',
      ),
    ).rejects.toThrow();
    runs.get(
      third.contextId + '-evaluate',
    ).metrics.originmanWorkshop.feedbackComparison.protocol.conditionsSha256 = 'b'.repeat(64);
    expect((await fresh.compare(third.contextId, undefined, owner)).comparable).toBe(false);
    runs.get(third.contextId + '-evaluate').metrics.originmanWorkshop.policySha256 = 'c'.repeat(64);
    await expect(fresh.compare(third.contextId, undefined, owner)).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
