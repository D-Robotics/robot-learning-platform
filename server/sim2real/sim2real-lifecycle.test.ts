import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
import { isSim2RealError } from './sim2real-errors.js';
import {
  createSim2RealArtifactWithResult,
  createSim2RealDataset,
  createSim2RealEvaluationWithResult,
  createSim2RealRun,
  getSim2RealLineage,
  invalidateSim2RealStoreCacheForTest,
  updateSim2RealArtifactStatus,
  updateSim2RealDatasetStatus,
  updateSim2RealEvaluation,
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

async function useTempStorage(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-lifecycle-'));
  roots.push(root);
  process.env.RDK_SIM2REAL_STORAGE_DIR = root;
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  invalidateSim2RealStoreCacheForTest();
}

describe('Sim2Real dataset → run → artifact → evaluation lineage', () => {
  it('keeps immutable versions and enforces forward-only lifecycle transitions', async () => {
    await useTempStorage();
    const dataset = await createSim2RealDataset(
      {
        name: 'walk snapshots',
        version: 'v1',
        contractId: 'microduck-policy-v1',
        status: 'registered',
      },
      'alice',
    );
    await expect(
      createSim2RealDataset(
        { name: 'walk snapshots', version: 'v1', contractId: 'microduck-policy-v1' },
        'alice',
      ),
    ).rejects.toThrow('sim2real_dataset_version_exists');
    const registered = await updateSim2RealDatasetStatus(dataset.id, 'registered', 'alice');
    expect(registered?.status).toBe('registered');
    const ready = await updateSim2RealDatasetStatus(dataset.id, 'ready', 'alice');
    expect(ready?.status).toBe('ready');
    await expect(updateSim2RealDatasetStatus(dataset.id, 'registered', 'alice')).rejects.toThrow(
      'sim2real_dataset_transition_invalid',
    );
    const revoked = await updateSim2RealDatasetStatus(dataset.id, 'revoked', 'alice');
    expect(revoked?.status).toBe('revoked');
    await expect(updateSim2RealDatasetStatus(dataset.id, 'ready', 'alice')).rejects.toThrow(
      'sim2real_dataset_not_mutable',
    );
  });

  it('pins artifact bytes by digest, supports idempotent registration, and gates publishing', async () => {
    await useTempStorage();
    const dataset = await createSim2RealDataset(
      { name: 'walk snapshots', version: 'v1', contractId: 'microduck-policy-v1' },
      'alice',
    );
    const run = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'contract run',
        datasetIds: [dataset.id],
      },
      'alice',
    );
    const input = {
      artifactId: 'walk-policy',
      version: 'v1',
      name: 'Walk policy',
      role: 'compiled-policy' as const,
      kind: 'compiled' as const,
      format: 'onnx' as const,
      runtime: 'cpu-onnx' as const,
      workload: 'locomotion' as const,
      ref: 'artifact://walk-policy/v1',
      sha256: 'a'.repeat(64),
      modelId: BUILTIN_MICRODUCK_MODEL.id,
      runId: run.id,
      datasetIds: [dataset.id],
      evaluationIds: [],
      contractId: 'microduck-policy-v1',
      status: 'draft' as const,
    };
    const first = await createSim2RealArtifactWithResult(input, 'alice', {
      idempotencyKey: 'artifact-1',
      requestFingerprint: 'fingerprint-1',
    });
    const replay = await createSim2RealArtifactWithResult(input, 'alice', {
      idempotencyKey: 'artifact-1',
      requestFingerprint: 'fingerprint-1',
    });
    expect(first.duplicate).toBe(false);
    expect(replay).toMatchObject({ duplicate: true, artifact: { id: first.artifact.id } });
    await expect(
      createSim2RealArtifactWithResult({ ...input, sha256: 'b'.repeat(64) }, 'alice', {
        idempotencyKey: 'artifact-1',
        requestFingerprint: 'other',
      }),
    ).rejects.toThrow('sim2real_artifact_idempotency_conflict');
    await expect(
      updateSim2RealArtifactStatus(first.artifact.id, 'published', 'alice'),
    ).rejects.toThrow('sim2real_artifact_lineage_invalid');
    expect(
      (await updateSim2RealArtifactStatus(first.artifact.id, 'validated', 'alice'))?.status,
    ).toBe('validated');
    expect(
      (await updateSim2RealArtifactStatus(first.artifact.id, 'published', 'alice'))?.status,
    ).toBe('published');
    await expect(
      updateSim2RealArtifactStatus(first.artifact.id, 'validated', 'alice'),
    ).rejects.toThrow('sim2real_artifact_lineage_invalid');
  });

  it('materializes evaluation evidence and returns an owner-scoped complete graph', async () => {
    await useTempStorage();
    const dataset = await createSim2RealDataset(
      { name: 'walk snapshots', version: 'v1', contractId: 'microduck-policy-v1' },
      'alice',
    );
    const run = await createSim2RealRun(
      {
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        backend: 'contract',
        status: 'completed',
        summary: 'contract run',
        datasetIds: [dataset.id],
      },
      'alice',
    );
    const evaluation = await createSim2RealEvaluationWithResult(
      {
        runId: run.id,
        modelId: BUILTIN_MICRODUCK_MODEL.id,
        datasetIds: [dataset.id],
        status: 'pending',
        summary: 'waiting for board evidence',
        source: 'runner',
        contractId: 'microduck-policy-v1',
      },
      'alice',
      { idempotencyKey: 'eval-1', requestFingerprint: 'eval-fingerprint' },
    );
    expect(evaluation.duplicate).toBe(false);
    expect(
      (await updateSim2RealEvaluation(evaluation.evaluation.id, { status: 'running' }, 'alice'))
        ?.status,
    ).toBe('running');
    const passed = await updateSim2RealEvaluation(
      evaluation.evaluation.id,
      { status: 'passed', summary: 'quality gate passed' },
      'alice',
      { trusted: true },
    );
    expect(passed).toMatchObject({ status: 'passed', runId: run.id });
    await expect(
      updateSim2RealEvaluation(evaluation.evaluation.id, { status: 'running' }, 'alice'),
    ).rejects.toThrow('sim2real_evaluation_transition_invalid');
    const graph = await getSim2RealLineage({ evaluationId: evaluation.evaluation.id }, 'alice');
    expect(graph).toMatchObject({
      run: { id: run.id },
      runs: [expect.objectContaining({ id: run.id })],
      datasets: [expect.objectContaining({ id: dataset.id })],
      evaluations: [expect.objectContaining({ id: evaluation.evaluation.id, status: 'passed' })],
    });
    expect(await getSim2RealLineage({ evaluationId: evaluation.evaluation.id }, 'bob')).toBeNull();
    expect(isSim2RealError(new Error('sim2real_evaluation_transition_invalid'))).toBe(false);
  });
});
