import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_MICRODUCK_MODEL,
  type Sim2RealEvaluationSummary,
  type Sim2RealTelemetryRecord,
} from '../../shared/sim2real.js';
import { isSim2RealError } from './sim2real-errors.js';
import {
  appendSim2RealTelemetryWithResult,
  createSim2RealArtifactWithResult,
  createSim2RealDeployment,
  createSim2RealEvaluationWithResult,
  createSim2RealModel,
  createSim2RealRun,
  decideSim2RealDeploymentApproval,
  evaluateSim2RealRun,
  getSim2RealModel,
  getSim2RealRun,
  invalidateSim2RealStoreCacheForTest,
  listSim2RealTelemetry,
  listSim2RealModels,
  listSim2RealRuns,
  reserveSim2RealRun,
  updateSim2RealArtifactStatus,
  updateSim2RealRun,
  SIM2REAL_LEDGER_MAX_BYTES,
  SIM2REAL_TELEMETRY_RECORD_CAP,
  DEFAULT_COMPUTE_HEALTH_TTL_SECONDS,
  MAX_COMPUTE_HEALTH_TTL_SECONDS,
  MIN_COMPUTE_HEALTH_TTL_SECONDS,
  isSim2RealComputeResourceHealthFresh,
  sim2RealActiveRunLimit,
  sim2RealComputeHealthTtlSeconds,
  sim2RealStorageInfo,
  sim2RealStorageReadiness,
  sim2RealTelemetryRetentionDays,
} from './sim2real-store.js';

const roots: string[] = [];
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;
const previousMaxActiveRuns = process.env.RDK_SIM2REAL_MAX_ACTIVE_RUNS;
const previousActiveRunTtl = process.env.RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS;
const previousRetention = process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS;
const previousComputeHealthTtl = process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS;
const previousLease = process.env.RDK_SIM2REAL_STORAGE_LEASE;

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
  if (previousRetention === undefined) delete process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS;
  else process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS = previousRetention;
  if (previousComputeHealthTtl === undefined)
    delete process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS;
  else process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS = previousComputeHealthTtl;
  if (previousLease === undefined) delete process.env.RDK_SIM2REAL_STORAGE_LEASE;
  else process.env.RDK_SIM2REAL_STORAGE_LEASE = previousLease;
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
  it('bounds the GPU health lease and expires old online evidence', () => {
    delete process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS;
    expect(sim2RealComputeHealthTtlSeconds()).toBe(DEFAULT_COMPUTE_HEALTH_TTL_SECONDS);
    process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS = String(MIN_COMPUTE_HEALTH_TTL_SECONDS);
    expect(sim2RealComputeHealthTtlSeconds()).toBe(MIN_COMPUTE_HEALTH_TTL_SECONDS);
    process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS = String(MAX_COMPUTE_HEALTH_TTL_SECONDS);
    expect(sim2RealComputeHealthTtlSeconds()).toBe(MAX_COMPUTE_HEALTH_TTL_SECONDS);
    for (const invalid of ['0', '29', '86401', '1.5', 'not-a-number']) {
      process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS = invalid;
      expect(sim2RealComputeHealthTtlSeconds()).toBe(DEFAULT_COMPUTE_HEALTH_TTL_SECONDS);
    }

    const now = Date.parse('2026-09-13T00:00:00.000Z');
    process.env.RDK_SIM2REAL_COMPUTE_HEALTH_TTL_SECONDS = '30';
    expect(
      isSim2RealComputeResourceHealthFresh(
        { status: 'online', lastCheckedAt: new Date(now - 30_000).toISOString() },
        now,
      ),
    ).toBe(true);
    expect(
      isSim2RealComputeResourceHealthFresh(
        { status: 'online', lastCheckedAt: new Date(now - 30_001).toISOString() },
        now,
      ),
    ).toBe(false);
    expect(
      isSim2RealComputeResourceHealthFresh(
        { status: 'offline', lastCheckedAt: new Date(now).toISOString() },
        now,
      ),
    ).toBe(false);
    expect(
      isSim2RealComputeResourceHealthFresh(
        { status: 'online', lastCheckedAt: new Date(now + 1_000).toISOString() },
        now,
      ),
    ).toBe(false);
  });

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
    expect(await listSim2RealModels('bob')).toHaveLength(2);
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
    await expect(listSim2RealModels('alice')).resolves.toHaveLength(2);
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

    await expect(listSim2RealRuns('alice')).rejects.toThrow('sim2real_storage_quota_exceeded');
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
        expect.objectContaining({
          manifest: expect.objectContaining({ displayName: 'Restored display name' }),
        }),
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

  it('invalidates first-class passed evidence when newer telemetry arrives', async () => {
    await useTempStorage();
    const { modelId, runId } = await seedRun('evaluation-freshness');
    await appendSim2RealTelemetryWithResult(
      {
        runId,
        modelId,
        source: 'import',
        samples: [{ t: 0 }],
      },
      'alice',
    );
    const evaluated = await evaluateSim2RealRun(runId, 'alice', ({ telemetry }) =>
      summaryFor(telemetry),
    );
    expect(evaluated).not.toBeNull();
    const created = await createSim2RealEvaluationWithResult(
      {
        runId,
        modelId,
        datasetIds: [],
        status: 'passed',
        summary: 'attested fixture',
        report: {
          ...evaluated!.evaluation,
          replay: { ...evaluated!.evaluation.replay, attested: true },
        },
        source: 'platform',
        attested: true,
        telemetryRevision: evaluated!.telemetryRevision,
      },
      'alice',
      { allowInitialTerminal: true, idempotencyKey: 'freshness-eval' },
    );
    expect(created.evaluation).toMatchObject({
      status: 'passed',
      telemetryRevision: evaluated!.telemetryRevision,
    });
    await expect(getSim2RealRun(runId, 'alice')).resolves.toMatchObject({
      evaluationId: created.evaluation.id,
      telemetryRevision: evaluated!.telemetryRevision,
    });

    await appendSim2RealTelemetryWithResult(
      {
        runId,
        modelId,
        source: 'import',
        samples: [{ t: 1 }],
      },
      'alice',
    );
    const invalidatedRun = await getSim2RealRun(runId, 'alice');
    expect(invalidatedRun).toBeDefined();
    expect(invalidatedRun).not.toHaveProperty('evaluationId');
    expect(invalidatedRun).not.toHaveProperty('telemetryRevision');
    expect(invalidatedRun).not.toHaveProperty('evaluation');
    const ledgerFile = path.join(process.env.RDK_SIM2REAL_STORAGE_DIR!, 'sim2real.json');
    const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')) as {
      evaluations: Array<Record<string, unknown>>;
    };
    expect(ledger.evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.evaluation.id,
          stale: true,
          staleReason: 'new telemetry appended; rerun evaluation',
        }),
      ]),
    );
  });

  it('rechecks release evidence at approval and refuses a plan made stale afterwards', async () => {
    await useTempStorage();
    const { modelId, runId } = await seedRun('approval-freshness');
    const run = await getSim2RealRun(runId, 'alice');
    expect(run).toBeDefined();
    const report: Sim2RealEvaluationSummary = {
      evaluatedAt: new Date().toISOString(),
      sampleCount: 10,
      replay: {
        sampleCount: 10,
        durationSeconds: 1,
        source: 'board-agent',
        attested: true,
        deviceId: 'board-1',
        chunkCount: 1,
        droppedCount: 0,
        doneCount: 1,
        fallCount: 0,
      },
      warnings: [],
    };
    const evaluation = await createSim2RealEvaluationWithResult(
      {
        runId,
        modelId,
        datasetIds: [],
        status: 'passed',
        summary: 'board evidence',
        report,
        source: 'platform',
        attested: true,
      },
      'alice',
      { allowInitialTerminal: true, idempotencyKey: 'approval-freshness-eval' },
    );
    const artifact = await createSim2RealArtifactWithResult(
      {
        artifactId: 'approval-freshness-policy',
        version: 'v1',
        name: 'Approval freshness policy',
        role: 'compiled-policy',
        kind: 'compiled',
        format: 'bin',
        ref: 'artifact://approval-freshness/v1',
        sha256: 'c'.repeat(64),
        modelId,
        runId,
        datasetIds: [],
        evaluationIds: [evaluation.evaluation.id],
        targetPlatforms: ['rdk-x5'],
        toolchainTarget: 'rdk-x5',
        acceleratorArchitecture: 'bayes-e',
        status: 'draft',
      },
      'alice',
      { idempotencyKey: 'approval-freshness-artifact' },
    );
    await updateSim2RealArtifactStatus(artifact.artifact.id, 'validated', 'alice');
    await updateSim2RealArtifactStatus(artifact.artifact.id, 'published', 'alice');
    const deployment = await createSim2RealDeployment(
      {
        modelId,
        runId,
        artifactId: artifact.artifact.id,
        evaluationId: evaluation.evaluation.id,
        deviceId: 'board-1',
        targetPlatform: 'rdk-x5',
        mode: 'canary',
        status: 'planned',
        summary: 'awaiting approval',
        compatibility: {
          platformId: 'rdk-x5',
          status: 'compatible',
          result: {} as never,
          deployable: true,
          reason: 'compiled artifact matches board',
        },
        steps: [],
        releaseGate: {
          passed: true,
          checkedAt: new Date().toISOString(),
          runId,
          errors: [],
          checks: { boardTelemetryAttested: true, boardTelemetrySamples: 10 },
        },
      },
      'alice',
    );

    await appendSim2RealTelemetryWithResult(
      {
        runId,
        modelId,
        source: 'import',
        samples: [{ t: 0 }],
      },
      'alice',
    );
    await expect(
      decideSim2RealDeploymentApproval(deployment.id, 'approved', 'alice', 'alice'),
    ).rejects.toMatchObject({ code: 'sim2real_evaluation_stale' });
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
    await expect(append(1, [0.01, 0.03])).rejects.toThrow('sim2real_telemetry_timestamp_order');
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
        samples: [
          {
            t: 0,
            cmd_vel: { linear: 0.2, angular: -0.3 },
            actionOutput: 'normalized-twist',
            actionScale: { linear: 0.3, angular: 1, units: 'm/s,rad/s' },
            controlHz: 10,
            controlPeriodSeconds: 0.1,
          },
          { t: 0.02 },
        ],
      },
      'alice',
    );
    expect(appended.duplicate).toBe(false);

    // The ledger keeps only a sample-stripped index row; the full record
    // (samples included) lives in the run shard.
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'sim2real.json'), 'utf8')) as {
      telemetry: Array<Record<string, unknown>>;
    };
    expect(ledger.telemetry).toHaveLength(1);
    expect(ledger.telemetry[0].samples).toBeUndefined();
    const shard = await fs.readFile(path.join(root, 'telemetry', `${run.id}.jsonl`), 'utf8');
    expect(shard).toContain('"samples"');

    // Reads rehydrate the full record from the shard — and keep working after
    // the in-memory cache is dropped (simulating a process restart).
    invalidateSim2RealStoreCacheForTest();
    const restored = await listSim2RealTelemetry(run.id, 'alice', 10);
    expect(restored).toHaveLength(1);
    expect(restored[0].samples).toEqual([
      {
        t: 0,
        cmd_vel: { linear: 0.2, angular: -0.3 },
        actionOutput: 'normalized-twist',
        actionScale: { linear: 0.3, angular: 1, units: 'm/s,rad/s' },
        controlHz: 10,
        controlPeriodSeconds: 0.1,
      },
      { t: 0.02 },
    ]);

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

  it('ignores shard lines that never received a committed ledger index', async () => {
    const root = await useTempStorage();
    const { modelId, runId } = await seedRun('orphan-shard');
    const accepted = await appendSim2RealTelemetryWithResult(
      {
        runId,
        modelId,
        source: 'import',
        sequence: 0,
        samples: [{ t: 0 }],
      },
      'alice',
    );
    const orphan = {
      ...accepted.telemetry,
      id: 'orphan-shard-row',
      sequence: 1,
      samples: [{ t: 1 }],
      receivedAt: new Date().toISOString(),
    };
    // Simulate a crash after the append-first shard write but before the
    // ledger index rename. The orphan remains on disk and must be invisible
    // after a process restart/cache invalidation.
    await fs.appendFile(telemetryShardFile(root, runId), `${JSON.stringify(orphan)}\n`, 'utf8');
    invalidateSim2RealStoreCacheForTest();

    await expect(listSim2RealTelemetry(runId, 'alice', 10)).resolves.toMatchObject([
      { id: accepted.telemetry.id, sequence: 0 },
    ]);
    await expect(
      listSim2RealTelemetry(runId, 'alice', SIM2REAL_TELEMETRY_RECORD_CAP),
    ).resolves.toHaveLength(1);
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

async function seedRun(tag: string, owner = 'alice'): Promise<{ modelId: string; runId: string }> {
  const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
  manifest.modelId = `${tag}-policy`;
  manifest.displayName = `${tag} policy`;
  manifest.version = '1.0.0';
  const model = await createSim2RealModel(manifest, owner);
  const run = await createSim2RealRun(
    {
      modelId: model.id,
      backend: 'contract',
      status: 'completed',
      summary: 'bounded telemetry fixture',
    },
    owner,
  );
  return { modelId: model.id, runId: run.id };
}

function telemetryShardFile(root: string, runId: string): string {
  return path.join(root, 'telemetry', `${runId}.jsonl`);
}

async function readShardLines(
  root: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  let raw: string;
  try {
    raw = await fs.readFile(telemetryShardFile(root, runId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Insert sample-carrying legacy rows, as written by pre-shard ledgers. */
async function insertLegacyInlineRows(
  root: string,
  rows: Array<{
    id: string;
    runId: string;
    modelId: string;
    source: string;
    sequence: number;
    receivedAt: string;
    owner?: string;
  }>,
): Promise<void> {
  const file = path.join(root, 'sim2real.json');
  const ledger = JSON.parse(await fs.readFile(file, 'utf8')) as {
    telemetry: Array<Record<string, unknown>>;
  };
  for (const row of rows) ledger.telemetry.push({ ...row, samples: [{ t: row.sequence }] });
  await fs.writeFile(file, JSON.stringify(ledger, null, 2), 'utf8');
  invalidateSim2RealStoreCacheForTest();
}

/** Move every existing shard and index row for one run into the past. */
async function ageRunTelemetry(root: string, runId: string, days: number): Promise<void> {
  const iso = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  const shardFile = telemetryShardFile(root, runId);
  const aged = (await fs.readFile(shardFile, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const record = JSON.parse(line) as { receivedAt: string };
      record.receivedAt = iso;
      return JSON.stringify(record);
    });
  await fs.writeFile(shardFile, `${aged.join('\n')}\n`, 'utf8');
  const ledgerFile = path.join(root, 'sim2real.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')) as {
    telemetry: Array<{ runId: string; receivedAt: string }>;
  };
  for (const row of ledger.telemetry) {
    if (row.runId === runId) row.receivedAt = iso;
  }
  await fs.writeFile(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');
  invalidateSim2RealStoreCacheForTest();
}

describe('Sim2Real bounded telemetry reads', () => {
  it('matches the full read + sort + slice result for small and large limits', async () => {
    await useTempStorage();
    const { modelId, runId } = await seedRun('bounded-equivalence');
    for (let sequence = 0; sequence < 5; sequence += 1) {
      await appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence, samples: [{ t: sequence }] },
        'alice',
      );
    }

    // `limit = CAP` is the unchanged full read and doubles as the reference.
    const full = await listSim2RealTelemetry(runId, 'alice', SIM2REAL_TELEMETRY_RECORD_CAP);
    expect(full.map((record) => record.sequence)).toEqual([0, 1, 2, 3, 4]);
    for (const limit of [1, 2, 4, 5, 9]) {
      await expect(listSim2RealTelemetry(runId, 'alice', limit)).resolves.toEqual(
        full.slice(0, limit),
      );
    }
  });

  it('interleaves legacy inline rows that sort ahead of shard rows', async () => {
    const root = await useTempStorage();
    const { modelId, runId } = await seedRun('legacy-interleave');
    for (const sequence of [0, 2, 4]) {
      await appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence, samples: [{ t: sequence }] },
        'alice',
      );
    }
    await insertLegacyInlineRows(root, [
      {
        id: 'legacy-1',
        runId,
        modelId,
        source: 'import',
        sequence: 1,
        receivedAt: '2026-01-01T00:00:01.000Z',
        owner: 'alice',
      },
      {
        id: 'legacy-3',
        runId,
        modelId,
        source: 'import',
        sequence: 3,
        receivedAt: '2026-01-01T00:00:03.000Z',
        owner: 'alice',
      },
    ]);

    const full = await listSim2RealTelemetry(runId, 'alice', SIM2REAL_TELEMETRY_RECORD_CAP);
    expect(full.map((record) => record.sequence)).toEqual([0, 1, 2, 3, 4]);
    for (const limit of [1, 2, 3, 6]) {
      await expect(listSim2RealTelemetry(runId, 'alice', limit)).resolves.toEqual(
        full.slice(0, limit),
      );
    }
  });

  it('ignores other owners without letting them consume the bounded head', async () => {
    await useTempStorage();
    const { modelId, runId } = await seedRun('own-scoped-head');
    const append = (sequence: number, owner: string) =>
      appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence, samples: [{ t: sequence }] },
        owner,
      );
    await append(0, 'alice');
    await append(10, 'bob');
    await append(1, 'alice');
    await append(11, 'bob');
    await append(2, 'alice');

    const full = await listSim2RealTelemetry(runId, 'alice', SIM2REAL_TELEMETRY_RECORD_CAP);
    expect(full.map((record) => record.sequence)).toEqual([0, 1, 2]);
    for (const limit of [1, 2, 3, 5]) {
      const bounded = await listSim2RealTelemetry(runId, 'alice', limit);
      expect(bounded).toEqual(full.slice(0, limit));
      expect(bounded.every((record) => (record.sequence ?? -1) < 10)).toBe(true);
    }
    expect(JSON.stringify(full)).not.toContain('"owner"');
  });

  it('stops before a malformed trailing shard line that the full read still hits', async () => {
    const root = await useTempStorage();
    const { modelId, runId } = await seedRun('bounded-head-proof');
    for (let sequence = 0; sequence < 4; sequence += 1) {
      await appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence, samples: [{ t: sequence }] },
        'alice',
      );
    }
    // The bounded reader must finish before this line is ever parsed; the full
    // reader has no try/catch and must throw on it. This is the observable
    // proof that a small limit does not read (and parse) the whole shard.
    await fs.appendFile(telemetryShardFile(root, runId), '{not-json}\n', 'utf8');

    const bounded = await listSim2RealTelemetry(runId, 'alice', 2);
    expect(bounded.map((record) => record.sequence)).toEqual([0, 1]);
    await expect(
      listSim2RealTelemetry(runId, 'alice', SIM2REAL_TELEMETRY_RECORD_CAP),
    ).rejects.toThrow(SyntaxError);
  });

  it('falls back to the full read when a late chunk is appended out of order', async () => {
    await useTempStorage();
    const { modelId, runId } = await seedRun('out-of-order-head');
    const append = (sequence: number, t: number) =>
      appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence, samples: [{ t }] },
        'alice',
      );
    // Sequence 1 is accepted after sequence 2 because its sample timeline is
    // still monotonic, so the shard head is not the sorted head. The bounded
    // path must detect that and still match the full read.
    await append(0, 0);
    await append(2, 0.04);
    await append(1, 0.02);

    const full = await listSim2RealTelemetry(runId, 'alice', SIM2REAL_TELEMETRY_RECORD_CAP);
    expect(full.map((record) => record.sequence)).toEqual([0, 1, 2]);
    for (const limit of [1, 2]) {
      await expect(listSim2RealTelemetry(runId, 'alice', limit)).resolves.toEqual(
        full.slice(0, limit),
      );
    }
  });
});

describe('Sim2Real telemetry retention', () => {
  it('keeps every record when retention is disabled', async () => {
    const root = await useTempStorage();
    delete process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS;
    const { modelId, runId } = await seedRun('retention-off');
    for (let sequence = 0; sequence < 2; sequence += 1) {
      await appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence, samples: [{ t: sequence }] },
        'alice',
      );
    }
    await ageRunTelemetry(root, runId, 30);
    await appendSim2RealTelemetryWithResult(
      { runId, modelId, source: 'import', sequence: 2, samples: [{ t: 2 }] },
      'alice',
    );

    await expect(readShardLines(root, runId)).resolves.toHaveLength(3);
    await expect(listSim2RealTelemetry(runId, 'alice', 10)).resolves.toMatchObject([
      { sequence: 0 },
      { sequence: 1 },
      { sequence: 2 },
    ]);
  });

  it('prunes expired shard rows and their index rows together', async () => {
    const root = await useTempStorage();
    const { modelId, runId } = await seedRun('retention-on');
    for (let sequence = 0; sequence < 2; sequence += 1) {
      await appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence, samples: [{ t: sequence }] },
        'alice',
      );
    }
    await ageRunTelemetry(root, runId, 30);
    process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS = '1';

    await expect(
      appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence: 2, samples: [{ t: 2 }] },
        'alice',
      ),
    ).resolves.toMatchObject({ duplicate: false });

    // The shard keeps only the fresh row and stays valid NDJSON.
    const lines = await readShardLines(root, runId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sequence: 2, samples: [{ t: 2 }] });

    // The ledger index agrees: the expired rows are gone and no index row
    // survives without its shard record.
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'sim2real.json'), 'utf8')) as {
      telemetry: Array<Record<string, unknown>>;
    };
    expect(ledger.telemetry).toHaveLength(1);
    expect(ledger.telemetry[0]).toMatchObject({ sequence: 2 });
    expect(ledger.telemetry[0].samples).toBeUndefined();

    invalidateSim2RealStoreCacheForTest();
    const listed = await listSim2RealTelemetry(runId, 'alice', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sequence: 2, samples: [{ t: 2 }] });
  });

  it('releases run sample quota before admitting a fresh chunk', async () => {
    const root = await useTempStorage();
    const { modelId, runId } = await seedRun('retention-quota');
    // Fill the exact per-run sample budget with one old shard row. The next
    // chunk is only admissible when retention removes that row before quota
    // accounting; the pre-fix ordering rejected it as 100001 samples.
    const samples = Array.from({ length: 100_000 }, (_, index) => ({ t: index }));
    await appendSim2RealTelemetryWithResult(
      { runId, modelId, source: 'import', sequence: 0, samples },
      'alice',
    );
    await ageRunTelemetry(root, runId, 30);
    process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS = '1';

    await expect(
      appendSim2RealTelemetryWithResult(
        { runId, modelId, source: 'import', sequence: 1, samples: [{ t: 100_000 }] },
        'alice',
      ),
    ).resolves.toMatchObject({ duplicate: false });
    await expect(readShardLines(root, runId)).resolves.toHaveLength(1);
  });

  it('treats malformed or out-of-range retention values as disabled', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      delete process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS;
      expect(sim2RealTelemetryRetentionDays()).toBe(0);
      for (const invalid of ['abc', '-1', '0', '99999', '1.5', 'Infinity']) {
        process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS = invalid;
        expect(sim2RealTelemetryRetentionDays()).toBe(0);
      }
      process.env.RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS = '30';
      expect(sim2RealTelemetryRetentionDays()).toBe(30);
    } finally {
      error.mockRestore();
    }
  });
});

describe('Sim2Real cross-process writer lease', () => {
  function leaseFile(root: string): string {
    return path.join(root, 'writer-lease.json');
  }

  function customManifest(modelId: string) {
    const manifest = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    manifest.modelId = modelId;
    manifest.displayName = modelId;
    manifest.version = '1.0.0';
    return manifest;
  }

  /** A lease held by a writer this process cannot prove dead: another host. */
  function foreignLease(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      host: 'another-host.invalid',
      pid: 999_999,
      startedAt: '2020-01-01T00:00:00.000Z',
      heartbeatAt: new Date().toISOString(),
      ...overrides,
    };
  }

  async function captureWriteError(modelId: string): Promise<unknown> {
    return createSim2RealModel(customManifest(modelId), 'alice').catch((thrown: unknown) => thrown);
  }

  it('fails fast with a writer conflict when another writer holds a fresh lease', async () => {
    const root = await useTempStorage();
    const file = leaseFile(root);
    const foreign = foreignLease();
    await fs.writeFile(file, JSON.stringify(foreign, null, 2), 'utf8');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = await captureWriteError('lease-conflict-policy');

      expect(isSim2RealError(error)).toBe(true);
      if (!isSim2RealError(error)) throw new Error('expected a Sim2RealError');
      expect(error.code).toBe('sim2real_storage_writer_conflict');
      expect(error.detail).toContain('另一个进程正在写这个存储目录');
      // The refused write must not create a ledger or touch the other lease.
      await expect(fs.readFile(path.join(root, 'sim2real.json'), 'utf8')).rejects.toThrow();
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(foreign);
    } finally {
      logged.mockRestore();
    }
  });

  it('skips the check entirely when RDK_SIM2REAL_STORAGE_LEASE=0', async () => {
    const root = await useTempStorage();
    const file = leaseFile(root);
    const foreign = foreignLease();
    await fs.writeFile(file, JSON.stringify(foreign, null, 2), 'utf8');
    process.env.RDK_SIM2REAL_STORAGE_LEASE = '0';

    await expect(
      createSim2RealModel(customManifest('lease-disabled-policy'), 'alice'),
    ).resolves.toMatchObject({ id: expect.any(String) });
    // Disabled means no lease handling at all: the other writer's file is
    // neither validated nor rewritten.
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(foreign);
  });

  it('writes a complete lease on the first write and renews it on later writes', async () => {
    const root = await useTempStorage();
    const file = leaseFile(root);
    await createSim2RealModel(customManifest('lease-first-policy'), 'alice');

    const first = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    expect(first).toMatchObject({
      schemaVersion: 1,
      host: os.hostname(),
      pid: process.pid,
    });
    expect(Number.isFinite(Date.parse(String(first.startedAt)))).toBe(true);
    expect(Number.isFinite(Date.parse(String(first.heartbeatAt)))).toBe(true);

    // Simulate a process that has been idle for a long time: the on-disk
    // heartbeat is ancient, but the recorded incarnation is still this one, so
    // the next write must renew and refresh it instead of conflicting or
    // treating this process as gone.
    await fs.writeFile(
      file,
      JSON.stringify({ ...first, heartbeatAt: '2020-01-01T00:00:00.000Z' }),
      'utf8',
    );
    await createSim2RealModel(customManifest('lease-renew-policy'), 'alice');

    const second = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.heartbeatAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(Date.parse(String(second.heartbeatAt))).toBeGreaterThan(
      Date.parse('2020-01-01T00:00:00.000Z'),
    );
  });

  it('never treats a corrupt lease file as an unowned directory', async () => {
    const root = await useTempStorage();
    const file = leaseFile(root);
    const corrupt = '{"schemaVersion":1,"host":';
    await fs.writeFile(file, corrupt, 'utf8');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = await captureWriteError('lease-corrupt-policy');

      expect(isSim2RealError(error)).toBe(true);
      if (!isSim2RealError(error)) throw new Error('expected a Sim2RealError');
      expect(error.code).toBe('sim2real_storage_writer_conflict');
      expect(await fs.readFile(file, 'utf8')).toBe(corrupt);
      await expect(fs.readFile(path.join(root, 'sim2real.json'), 'utf8')).rejects.toThrow();
    } finally {
      logged.mockRestore();
    }
  });
});
