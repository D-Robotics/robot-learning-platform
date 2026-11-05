import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExperimentSessions, type ExperimentRun } from './experiment-sessions.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-session-'));
  directories.push(root);
  const sha = 'a'.repeat(64);
  const runs: Record<string, ExperimentRun> = {
    train: {
      id: 'train',
      modelId: 'model',
      status: 'running',
      metrics: { originmanWorkshop: { phase: 'train', policySha256: sha } },
    },
    eval: {
      id: 'eval',
      modelId: 'model',
      status: 'queued',
      training: { originmanWorkshop: { phase: 'evaluate', sourceRunId: 'train' } },
    },
  };
  let calls = 0;
  const options = {
    root: () => root,
    getRun: async (id: string, owner?: string) => {
      calls++;
      return owner === 'A' ? (runs[id] ?? null) : null;
    },
  };
  return { root, runs, sha, store: createExperimentSessions(options), options, calls: () => calls };
}
describe('durable experiment sessions', () => {
  it('restores the same experiment through a new client instance and journals only changed facts', async () => {
    const f = await fixture();
    const first = await f.store.remember({ contextId: 'lesson', runId: 'train' }, 'A');
    expect(first.revision).toBe(1);
    const client = createExperimentSessions(f.options);
    expect((await client.resume('lesson', 'A')).revision).toBe(1);
    f.runs.train.status = 'completed';
    const next = await client.resume('lesson', 'A');
    expect(next.revision).toBe(2);
    expect(next.view.stage).toBe('evaluation');
    expect((await client.events('lesson', 1, 'A')).events.map((e) => e.id)).toEqual([2]);
    expect(f.calls()).toBe(4);
  });
  it('revalidates access for every read; never returns cached facts to another owner', async () => {
    const f = await fixture();
    await f.store.remember({ contextId: 'lesson', runId: 'train' }, 'A');
    await expect(f.store.resume('lesson', 'B')).rejects.toMatchObject({
      code: 'EXPERIMENT_NOT_FOUND',
    });
    delete f.runs.train;
    await expect(f.store.resume('lesson', 'A')).rejects.toMatchObject({
      code: 'EXPERIMENT_RUN_NOT_FOUND',
    });
  });
  it('saves a queued evaluation, later verifies real weights, and separates quality from completion', async () => {
    const f = await fixture();
    f.runs.train.status = 'completed';
    f.runs.train.mock = false;
    f.runs.eval.mock = false;
    const input = { contextId: 'lesson', runId: 'train', evaluationRunId: 'eval' };
    expect((await f.store.remember(input, 'A')).view.associationVerified).toBe(false);
    f.runs.eval.status = 'completed';
    f.runs.eval.metrics = {
      originmanWorkshop: {
        phase: 'evaluate',
        sourceRunId: 'train',
        policySha256: f.sha,
        clearGain: false,
        video: { sha256: 'b'.repeat(64), bytes: 2048 },
      },
    };
    const state = await f.store.resume('lesson', 'A');
    expect(state.view).toMatchObject({
      stage: 'results',
      associationVerified: true,
      clearGain: false,
      videoRecorded: true,
      hardwareVerified: false,
    });
  });
  it('rejects contradictory parents and mismatched policies before persisting an evaluation', async () => {
    const f = await fixture();
    await f.store.remember({ contextId: 'lesson', runId: 'train' }, 'A');
    f.runs.eval.metrics = { originmanWorkshop: { phase: 'evaluate', sourceRunId: 'foreign' } };
    await expect(
      f.store.remember({ contextId: 'lesson', runId: 'train', evaluationRunId: 'eval' }, 'A'),
    ).rejects.toMatchObject({ code: 'EXPERIMENT_PARENT_MISMATCH' });
    expect((await f.store.resume('lesson', 'A')).view.evaluation).toBeNull();
    f.runs.eval.metrics = {
      originmanWorkshop: { phase: 'evaluate', sourceRunId: 'train', policySha256: 'c'.repeat(64) },
    };
    await expect(
      f.store.remember({ contextId: 'lesson', runId: 'train', evaluationRunId: 'eval' }, 'A'),
    ).rejects.toMatchObject({ code: 'EXPERIMENT_POLICY_MISMATCH' });
  });
  it('serializes duplicate clicks and refuses to rebind the same experiment', async () => {
    const f = await fixture();
    const input = { contextId: 'lesson', runId: 'train' };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.store.remember(input, 'A')),
    );
    expect(results.map((r) => r.revision)).toEqual(Array(8).fill(1));
    await expect(f.store.remember({ ...input, runId: 'other' }, 'A')).rejects.toMatchObject({
      code: 'EXPERIMENT_ALREADY_BOUND',
    });
  });
  it('fails closed on bad identifiers, extra inputs and future event cursors', async () => {
    const f = await fixture();
    await expect(
      f.store.remember({ contextId: '../x', runId: 'train' }, 'A'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.store.remember({ contextId: 'lesson', runId: 'train', token: 'secret' } as never, 'A'),
    ).rejects.toMatchObject({ status: 400 });
    await f.store.remember({ contextId: 'lesson', runId: 'train' }, 'A');
    await expect(f.store.events('lesson', 99, 'A')).rejects.toMatchObject({
      code: 'EXPERIMENT_CURSOR_INVALID',
    });
  });
  it('replays retained events and explicitly resets an expired cursor to the current snapshot', async () => {
    const f = await fixture();
    await f.store.remember({ contextId: 'lesson', runId: 'train' }, 'A');
    for (let i = 0; i < 131; i++) {
      f.runs.train.status = i % 2 ? 'running' : 'queued';
      await f.store.resume('lesson', 'A');
    }
    const batch = await f.store.events('lesson', 1, 'A');
    expect(batch.reset).toBe(true);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].id).toBe(batch.revision);
  });
  it('keeps blocked runs and never advertises a missing video as playable', async () => {
    const f = await fixture();
    f.runs.train.status = 'failed';
    const state = await f.store.remember({ contextId: 'lesson', runId: 'train' }, 'A');
    expect(state.view).toMatchObject({ stage: 'blocked', videoRecorded: false });
    expect(state.view.nextAction).toContain('原任务');
  });
});
