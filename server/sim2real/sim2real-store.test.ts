import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_MICRODUCK_MODEL,
  type Sim2RealEvaluationSummary,
  type Sim2RealTelemetryRecord,
} from '../../shared/sim2real.js';
import {
  appendSim2RealTelemetryWithResult,
  createSim2RealModel,
  createSim2RealRun,
  evaluateSim2RealRun,
  getSim2RealModel,
  getSim2RealRun,
  invalidateSim2RealStoreCacheForTest,
  listSim2RealTelemetry,
  listSim2RealModels,
  listSim2RealRuns,
  reserveSim2RealRun,
  updateSim2RealRun,
  SIM2REAL_LEDGER_MAX_BYTES,
  sim2RealActiveRunLimit,
  sim2RealStorageInfo,
  sim2RealStorageReadiness,
} from './sim2real-store.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;
const previousMaxActiveRuns = process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS;
const previousActiveRunTtl = process.env.RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS;

afterEach(async () => {
  invalidateSim2RealStoreCacheForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
  if (previousMaxActiveRuns === undefined) delete process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS;
  else process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = previousMaxActiveRuns;
  if (previousActiveRunTtl === undefined) delete process.env.RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS;
  else process.env.RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS = previousActiveRunTtl;
});

async function useTempStorage(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-store-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  invalidateSim2RealStoreCacheForTest();
  return root;
}

function summaryFor(telemetry: readonly Sim2RealTelemetryRecord[]): Sim2RealEvaluationSummary {
  const samples = telemetry.flatMap((record) => record.samples);
  return {
    evaluatedAt: '2026-09-04T00:00:00.000Z',
    sampleCount: samples.length,
    replay: {
      sampleCount: samples.length,
      durationSeconds: 0,
      source: telemetry[0]?.source ?? 'import',
      chunkCount: telemetry.length,
      droppedCount: telemetry.reduce((total, record) => total + (record.droppedCount ?? 0), 0),
      doneCount: samples.filter((sample) => sample.done === true).length,
      fallCount: samples.filter((sample) => sample.fall === true).length,
    },
    warnings: [],
  };
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

  it('marks a corrupt ledger unready and never overwrites it as an empty database', async () => {
    const root = await useTempStorage();
    const ledgerFile = path.join(root, 'sim2real.json');
    const corrupt = '{"version":1,"models":[not-json]';
    await fs.writeFile(ledgerFile, corrupt, 'utf8');

    await expect(sim2RealStorageReadiness()).resolves.toMatchObject({
      writable: false,
      message: expect.stringContaining('台账文件不可读'),
    });
    await expect(
      createSim2RealModel(structuredClone(BUILTIN_MICRODUCK_MODEL.manifest), 'alice'),
    ).rejects.toThrow('sim2real_storage_unavailable');
    await expect(fs.readFile(ledgerFile, 'utf8')).resolves.toBe(corrupt);
  });

  it('rejects an oversized ledger before reading or parsing its contents', async () => {
    const root = await useTempStorage();
    const ledgerFile = path.join(root, 'sim2real.json');
    // A sparse file keeps this boundary test cheap while exercising the
    // stat-before-read guard. The file need not contain valid JSON because
    // readLedger must reject it before allocating/parsing the body.
    await fs.writeFile(ledgerFile, '{}', 'utf8');
    await fs.truncate(ledgerFile, SIM2REAL_LEDGER_MAX_BYTES + 1);

    await expect(listSim2RealRuns('alice')).rejects.toThrow(
      'sim2real_storage_quota_exceeded',
    );
    await expect(sim2RealStorageReadiness()).resolves.toMatchObject({
      writable: false,
      message: expect.stringContaining('超过单实例大小上限'),
    });
  });

  it('reaps only crash-window reservations before enforcing the active-run quota', async () => {
    const root = await useTempStorage();
    // The production guard has a five-minute lower bound; make the fixture
    // old enough to exercise it without relying on fake timers.
    process.env.RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS = '300';
    process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = '1';
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'ttl-policy';
    manifest.displayName = 'TTL policy';
    manifest.version = '1.0.0';
    const model = await createSim2RealModel(manifest, 'alice');
    const stale = await createSim2RealRun(
      {
        modelId: model.id,
        backend: 'local',
        status: 'queued',
        summary: 'crash-window reservation',
      },
      'alice',
    );
    const ledgerFile = path.join(root, 'sim2real.json');
    const parsed = JSON.parse(await fs.readFile(ledgerFile, 'utf8')) as {
      runs: Array<{ id: string; createdAt: string; externalRunId?: string }>;
    };
    const staleRow = parsed.runs.find((item) => item.id === stale.id);
    expect(staleRow).toBeDefined();
    staleRow!.createdAt = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    await fs.writeFile(ledgerFile, JSON.stringify(parsed, null, 2), 'utf8');
    invalidateSim2RealStoreCacheForTest();

    const reservation = await reserveSim2RealRun(
      {
        modelId: model.id,
        backend: 'local',
        status: 'queued',
        summary: 'fresh reservation',
      },
      'alice',
      { idempotencyKey: 'fresh-after-stale', maxActiveRuns: 1 },
    );
    expect(reservation.created).toBe(true);
    await expect(getSim2RealRun(stale.id, 'alice')).resolves.toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('自动终止'),
    });

    // A real runner job with an external id is not a crash-window reserve and
    // must remain active even when it is older than the local TTL.
    const active = await createSim2RealRun(
      {
        modelId: model.id,
        backend: 'local',
        status: 'running',
        summary: 'real worker job',
        externalRunId: 'worker-1',
      },
      'alice',
    );
    const nextParsed = JSON.parse(await fs.readFile(ledgerFile, 'utf8')) as {
      runs: Array<{ id: string; createdAt: string }>;
    };
    const activeRow = nextParsed.runs.find((item) => item.id === active.id);
    expect(activeRow).toBeDefined();
    activeRow!.createdAt = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    await fs.writeFile(ledgerFile, JSON.stringify(nextParsed, null, 2), 'utf8');
    invalidateSim2RealStoreCacheForTest();
    await expect(getSim2RealRun(active.id, 'alice')).resolves.toMatchObject({
      status: 'running',
      externalRunId: 'worker-1',
    });
  });

  it('invalidates a path cache when an operator atomically replaces the ledger', async () => {
    const root = await useTempStorage();
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'replaceable-policy';
    manifest.displayName = 'Original display name';
    manifest.version = '1.0.0';
    await createSim2RealModel(manifest, 'alice');
    await expect(sim2RealStorageReadiness()).resolves.toMatchObject({ writable: true });

    const ledgerFile = path.join(root, 'sim2real.json');
    const parsed = JSON.parse(await fs.readFile(ledgerFile, 'utf8')) as {
      models: Array<{ manifest: { displayName: string } }>;
    };
    parsed.models[0].manifest.displayName = 'Restored display name';
    // A direct write simulates a reviewed backup/restore replacing the file
    // while this process still has the old path cached.
    await fs.writeFile(ledgerFile, JSON.stringify(parsed, null, 2), 'utf8');

    await expect(listSim2RealModels('alice')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ manifest: expect.objectContaining({ displayName: 'Restored display name' }) }),
      ]),
    );
  });

  it('serializes evaluation with telemetry appends so stale summaries cannot be restored', async () => {
    await useTempStorage();
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'evaluation-race-policy';
    manifest.displayName = 'Evaluation race policy';
    manifest.version = '1.0.0';
    const model = await createSim2RealModel(manifest, 'alice');
    const run = await createSim2RealRun(
      {
        modelId: model.id,
        backend: 'contract',
        status: 'completed',
        summary: 'contract checked',
      },
      'alice',
    );
    const append = (t: number) =>
      appendSim2RealTelemetryWithResult(
        {
          runId: run.id,
          modelId: model.id,
          source: 'import',
          samples: [{ t }],
        },
        'alice',
      );

    await append(0);

    // Evaluation is queued first. The append that follows must clear the
    // summary after the evaluation write, rather than allowing the old route
    // pattern (read → append → update) to restore a stale result.
    const evaluationBeforeAppend = evaluateSim2RealRun(run.id, 'alice', ({ telemetry }) =>
      summaryFor(telemetry),
    );
    const appendAfterEvaluation = append(1);
    await Promise.all([evaluationBeforeAppend, appendAfterEvaluation]);
    const afterAppend = await getSim2RealRun(run.id, 'alice');
    expect(afterAppend?.evaluation).toBeUndefined();

    // Conversely, when the append wins first, the evaluator must observe the
    // newest chunk and persist a summary for both chunks.
    const appendBeforeEvaluation = append(2);
    const evaluationAfterAppend = evaluateSim2RealRun(run.id, 'alice', ({ telemetry }) =>
      summaryFor(telemetry),
    );
    await Promise.all([appendBeforeEvaluation, evaluationAfterAppend]);
    await expect(getSim2RealRun(run.id, 'alice')).resolves.toMatchObject({
      evaluation: { sampleCount: 3, replay: { sampleCount: 3, chunkCount: 3 } },
    });
  });

  it('keeps terminal run states from being resurrected by stale runner polling', async () => {
    await useTempStorage();
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'terminal-status-policy';
    manifest.displayName = 'Terminal status policy';
    manifest.version = '1.0.0';
    const model = await createSim2RealModel(manifest, 'alice');
    const run = await createSim2RealRun(
      {
        modelId: model.id,
        backend: 'local',
        status: 'running',
        summary: 'runner active',
        externalRunId: 'runner-1',
      },
      'alice',
    );

    await updateSim2RealRun(
      run.id,
      { status: 'completed', summary: 'runner completed', finishedAt: '2026-09-10T00:00:00.000Z' },
      'alice',
    );
    const stale = await updateSim2RealRun(
      run.id,
      { status: 'running', summary: 'late stale runner snapshot' },
      'alice',
    );

    expect(stale).toMatchObject({ status: 'completed', summary: 'runner completed' });
    await expect(getSim2RealRun(run.id, 'alice')).resolves.toMatchObject({
      status: 'completed',
      summary: 'runner completed',
      finishedAt: '2026-09-10T00:00:00.000Z',
    });
  });

  it('keeps creation-time blocked runs terminal while allowing same-status metadata updates', async () => {
    await useTempStorage();
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'blocked-terminal-policy';
    manifest.displayName = 'Blocked terminal policy';
    manifest.version = '1.0.0';
    const model = await createSim2RealModel(manifest, 'alice');
    const run = await createSim2RealRun(
      {
        modelId: model.id,
        backend: 'robogo',
        status: 'blocked',
        summary: '共享部署未收到当前账号的 RoboGo 短期令牌；任务只登记，未向 runner 发送请求。',
      },
      'alice',
    );

    // A blocked run has no runner, so nothing may transition it to an active
    // state; re-running the task creates a new run instead.
    const resurrected = await updateSim2RealRun(
      run.id,
      { status: 'queued', summary: 'late poll claims a runner accepted the job' },
      'alice',
    );
    expect(resurrected).toMatchObject({ status: 'blocked' });
    await expect(getSim2RealRun(run.id, 'alice')).resolves.toMatchObject({ status: 'blocked' });

    // Same-status patches (e.g. an operator note) are still applied — the
    // guard only freezes the lifecycle, not the record.
    const annotated = await updateSim2RealRun(
      run.id,
      { status: 'blocked', summary: '操作员备注：等待账号令牌后重新发起。' },
      'alice',
    );
    expect(annotated).toMatchObject({
      status: 'blocked',
      summary: '操作员备注：等待账号令牌后重新发起。',
    });
  });

  it('rejects cross-chunk timestamp regressions while allowing ordered late chunks', async () => {
    await useTempStorage();
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'telemetry-order-policy';
    manifest.displayName = 'Telemetry order policy';
    manifest.version = '1.0.0';
    const model = await createSim2RealModel(manifest, 'alice');
    const run = await createSim2RealRun(
      {
        modelId: model.id,
        backend: 'contract',
        status: 'completed',
        summary: 'contract checked',
      },
      'alice',
    );
    const append = (sequence: number, timestamps: number[]) =>
      appendSim2RealTelemetryWithResult(
        {
          runId: run.id,
          modelId: model.id,
          source: 'import',
          sequence,
          samples: timestamps.map((t) => ({ t })),
        },
        'alice',
      );

    await append(0, [0, 0.02]);
    await expect(append(1, [0.01, 0.03])).rejects.toThrow(
      'sim2real_telemetry_timestamp_order',
    );
    await expect(listSim2RealTelemetry(run.id, 'alice', 10)).resolves.toHaveLength(1);

    // A later sequence may arrive first (for example after a retry), as long
    // as inserting the missing chunk still produces a monotonic logical
    // timeline for replay/evaluation.
    await append(2, [0.04, 0.06]);
    await append(1, [0.02, 0.04]);
    await expect(listSim2RealTelemetry(run.id, 'alice', 10)).resolves.toHaveLength(3);
  });

  it('stores telemetry samples in per-run NDJSON shards, not the ledger', async () => {
    const root = await useTempStorage();
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = 'shard-policy';
    manifest.displayName = 'Shard policy';
    manifest.version = '1.0.0';
    const model = await createSim2RealModel(manifest, 'alice');
    const run = await createSim2RealRun(
      {
        modelId: model.id,
        backend: 'contract',
        status: 'completed',
        summary: 'contract checked',
      },
      'alice',
    );

    const appended = await appendSim2RealTelemetryWithResult(
      {
        runId: run.id,
        modelId: model.id,
        source: 'import',
        samples: [{ t: 0 }, { t: 0.02 }],
      },
      'alice',
    );
    expect(appended.duplicate).toBe(false);

    // The ledger keeps only a sample-stripped index row; the full record
    // (samples included) lives in the run shard.
    const ledger = JSON.parse(
      await fs.readFile(path.join(root, 'sim2real.json'), 'utf8'),
    ) as { telemetry: Array<Record<string, unknown>> };
    expect(ledger.telemetry).toHaveLength(1);
    expect(ledger.telemetry[0].samples).toBeUndefined();
    const shard = await fs.readFile(path.join(root, 'telemetry', `${run.id}.jsonl`), 'utf8');
    expect(shard).toContain('"samples"');

    // Reads rehydrate the full record from the shard — and keep working after
    // the in-memory cache is dropped (simulating a process restart).
    invalidateSim2RealStoreCacheForTest();
    const restored = await listSim2RealTelemetry(run.id, 'alice', 10);
    expect(restored).toHaveLength(1);
    expect(restored[0].samples).toEqual([{ t: 0 }, { t: 0.02 }]);

    // Idempotent replay rehydrates the full record too, not the bare index row.
    const replay = await appendSim2RealTelemetryWithResult(
      {
        runId: run.id,
        modelId: model.id,
        source: 'import',
        idempotencyKey: 'key-1',
        samples: [{ t: 1 }],
      },
      'alice',
    );
    expect(replay.duplicate).toBe(false);
    const duplicate = await appendSim2RealTelemetryWithResult(
      {
        runId: run.id,
        modelId: model.id,
        source: 'import',
        idempotencyKey: 'key-1',
        samples: [{ t: 1 }],
      },
      'alice',
    );
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.telemetry.samples).toEqual([{ t: 1 }]);
  });

  it('uses a bounded active-run default when the environment value is invalid', () => {
    delete process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS;
    expect(sim2RealActiveRunLimit()).toBe(4);
    process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = '0';
    expect(sim2RealActiveRunLimit()).toBe(4);
    process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = '101';
    expect(sim2RealActiveRunLimit()).toBe(4);
    process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS = '7';
    expect(sim2RealActiveRunLimit()).toBe(7);
  });
});
