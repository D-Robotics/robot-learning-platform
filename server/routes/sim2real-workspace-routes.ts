import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';

import type {
  ModelArtifactFormat,
  ModelArtifactKind,
  ModelArtifactRuntime,
  ModelArtifactWorkload,
} from '../../shared/model-artifacts.js';
import type {
  Sim2RealArtifactLifecycleStatus,
  Sim2RealArtifactRecord,
  Sim2RealDatasetRecord,
  Sim2RealEvaluationRecord,
  Sim2RealEvaluationStatus,
  Sim2RealProjectRecord,
} from '../../shared/sim2real.js';
import { SAFE_ARTIFACT_REF } from '../../shared/sim2real.js';
import {
  createSim2RealArtifactWithResult,
  createSim2RealDataset,
  createSim2RealEvaluationWithResult,
  createSim2RealProject,
  getSim2RealArtifact,
  getSim2RealDataset,
  getSim2RealEvaluation,
  getSim2RealLineage,
  getSim2RealProject,
  getSim2RealRun,
  listSim2RealArtifacts,
  listSim2RealDatasets,
  listSim2RealEvaluations,
  listSim2RealRuns,
  listSim2RealModels,
  listSim2RealDeployments,
  listSim2RealProjects,
  revokeSim2RealArtifact,
  updateSim2RealDatasetStatus,
  updateSim2RealArtifactStatus,
  updateSim2RealEvaluation,
  updateSim2RealProject,
} from '../sim2real/sim2real-store.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import { deriveRdkGoldenPath } from '../../shared/rdk-golden-path.js';

type WorkspaceDeps = {
  requestOwner: (request: Request, response: Response) => string | undefined | null;
  storageError: (request: Request, response: Response, error: unknown, scope: string) => void;
};

export type Sim2RealArtifactCatalogRecord = {
  id: string;
  type: 'model' | 'checkpoint' | 'recording' | 'dataset' | 'deployment' | 'artifact';
  name: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  modelId?: string;
  runId?: string;
  projectId?: string;
  taskId?: string;
  format?: string;
  uri?: string;
  sizeBytes?: number;
  sampleCount?: number;
  metadata?: Record<string, unknown>;
};

function registryArtifactCatalogRecord(
  artifact: Sim2RealArtifactRecord,
): Sim2RealArtifactCatalogRecord {
  return {
    id: `artifact:${artifact.id}`,
    type: 'artifact',
    name: `${artifact.name} · ${artifact.version}`,
    status: artifact.status,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    modelId: artifact.modelId,
    runId: artifact.runId,
    format: artifact.format,
    uri: artifact.ref,
    sizeBytes: artifact.sizeBytes,
    metadata: {
      artifactId: artifact.artifactId,
      version: artifact.version,
      role: artifact.role,
      kind: artifact.kind,
      sha256: artifact.sha256,
      contractId: artifact.contractId,
      datasetIds: artifact.datasetIds,
      evaluationIds: artifact.evaluationIds,
      targetPlatforms: artifact.targetPlatforms,
    },
  };
}

function queryValue(value: unknown): string {
  return cleanText(value, 160).toLowerCase();
}

/** Build a single, traceable catalog from the different persisted artifact types. */
export function buildArtifactCatalog(input: {
  models: Awaited<ReturnType<typeof listSim2RealModels>>;
  runs: Awaited<ReturnType<typeof listSim2RealRuns>>;
  datasets: Awaited<ReturnType<typeof listSim2RealDatasets>>;
  deployments: Awaited<ReturnType<typeof listSim2RealDeployments>>;
}): Sim2RealArtifactCatalogRecord[] {
  const records: Sim2RealArtifactCatalogRecord[] = [];
  for (const model of input.models) {
    for (const artifact of model.manifest.artifacts ?? []) {
      records.push({
        id: `model:${model.id}:${artifact.id}`,
        type: 'model',
        name: artifact.name || artifact.id,
        status: 'ready',
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
        modelId: model.id,
        format: artifact.format,
        uri: artifact.ref,
        sizeBytes: artifact.sizeBytes,
        metadata: { role: artifact.role, runtime: artifact.runtime, workload: artifact.workload },
      });
    }
  }
  for (const run of input.runs) {
    if (run.checkpoint) {
      records.push({
        id: `checkpoint:${run.id}:${run.checkpoint.checkpointId}`,
        type: 'checkpoint',
        name: run.checkpoint.checkpointId,
        status: run.status,
        createdAt: run.finishedAt ?? run.createdAt,
        modelId: run.modelId,
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        uri: run.checkpoint.artifactRef,
        metadata: { iteration: run.checkpoint.iteration, experimentId: run.experimentId },
      });
    }
    const replay = run.evaluation?.replay;
    if (replay && Number(replay.sampleCount) > 0) {
      records.push({
        id: `recording:${run.id}`,
        type: 'recording',
        name: run.label || `仿真录制 ${run.id.slice(0, 8)}`,
        status: run.status,
        createdAt: run.createdAt,
        modelId: run.modelId,
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        uri: `/runs/${encodeURIComponent(run.id)}/replay`,
        sampleCount: Number(replay.sampleCount),
        metadata: { source: replay.source, durationSeconds: replay.durationSeconds },
      });
    }
  }
  for (const dataset of input.datasets) {
    records.push({
      id: `dataset:${dataset.id}`,
      type: 'dataset',
      name: dataset.name,
      status: dataset.status ?? 'ready',
      createdAt: dataset.createdAt,
      updatedAt: dataset.updatedAt,
      format: dataset.format,
      uri: dataset.uri,
      sizeBytes: dataset.sizeBytes,
      sampleCount: dataset.sampleCount,
      runId: dataset.sourceRunId,
      metadata: { version: dataset.version, contractId: dataset.contractId, tags: dataset.tags },
    });
  }
  for (const deployment of input.deployments) {
    records.push({
      id: `deployment:${deployment.id}`,
      type: 'deployment',
      name: `部署 ${deployment.deviceId}`,
      status: deployment.status,
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
      modelId: deployment.modelId,
      runId: deployment.runId,
      metadata: {
        deviceId: deployment.deviceId,
        mode: deployment.mode,
        targetPlatform: deployment.targetPlatform,
      },
    });
  }
  return records.sort(
    (a, b) => Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt),
  );
}

function cleanText(value: unknown, max: number): string {
  return (Array.isArray(value) ? value[0] : value == null ? '' : String(value))
    .trim()
    .slice(0, max);
}

function listOfStrings(value: unknown, max: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result = value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, max);
  return result.length === value.length ? result : null;
}

function generatedSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56);
  return slug || `project-${randomUUID().slice(0, 8)}`;
}

function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

function projectPayload(
  body: Record<string, unknown>,
): { value: Omit<Sim2RealProjectRecord, 'id' | 'createdAt' | 'updatedAt'> } | { error: string } {
  const name = cleanText(body.name, 160);
  const slug = cleanText(body.slug, 64).toLowerCase() || generatedSlug(name);
  const modelIds = listOfStrings(body.modelIds, 100);
  const datasetIds = listOfStrings(body.datasetIds, 500);
  if (!name) return { error: '项目名称不能为空。' };
  if (!validSlug(slug)) return { error: 'slug 需为 2-64 位小写字母、数字或短横线。' };
  if (!modelIds || !datasetIds) return { error: 'modelIds 和 datasetIds 必须是字符串数组。' };
  return {
    value: {
      name,
      slug,
      ...(cleanText(body.description, 4_000)
        ? { description: cleanText(body.description, 4_000) }
        : {}),
      modelIds,
      datasetIds,
    },
  };
}

function datasetPayload(
  body: Record<string, unknown>,
): { value: Omit<Sim2RealDatasetRecord, 'id' | 'createdAt' | 'updatedAt'> } | { error: string } {
  const name = cleanText(body.name, 160);
  const version = cleanText(body.version, 64);
  const sha256 = cleanText(body.sha256, 64).toLowerCase();
  const contractId = cleanText(body.contractId, 128);
  const sourceRunId = cleanText(body.sourceRunId, 128);
  const status = cleanText(body.status, 16) as Sim2RealDatasetRecord['status'];
  const sampleCount = body.sampleCount === undefined ? undefined : Number(body.sampleCount);
  const sizeBytes = body.sizeBytes === undefined ? undefined : Number(body.sizeBytes);
  const tags = listOfStrings(body.tags, 32);
  if (!name) return { error: '数据集名称不能为空。' };
  if (version && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version))
    return { error: 'version 格式无效。' };
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256))
    return { error: 'sha256 必须是 64 位十六进制摘要。' };
  if (contractId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(contractId))
    return { error: 'contractId 格式无效。' };
  if (sourceRunId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceRunId))
    return { error: 'sourceRunId 格式无效。' };
  if (status && status !== 'registered')
    return { error: '新数据集只能以 registered 状态登记；ready 请使用状态推进操作。' };
  if (
    (sampleCount !== undefined && (!Number.isSafeInteger(sampleCount) || sampleCount < 0)) ||
    (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0))
  )
    return { error: 'sampleCount 和 sizeBytes 必须是非负整数。' };
  if (!tags) return { error: 'tags 必须是字符串数组。' };
  return {
    value: {
      name,
      ...(version ? { version } : {}),
      ...(cleanText(body.description, 4_000)
        ? { description: cleanText(body.description, 4_000) }
        : {}),
      ...(cleanText(body.uri, 2_048) ? { uri: cleanText(body.uri, 2_048) } : {}),
      ...(cleanText(body.format, 32) ? { format: cleanText(body.format, 32).toLowerCase() } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(contractId ? { contractId } : {}),
      ...(sourceRunId ? { sourceRunId } : {}),
      ...(status ? { status } : {}),
      ...(sampleCount !== undefined ? { sampleCount } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(tags.length ? { tags } : {}),
    },
  };
}

function artifactPayload(
  body: Record<string, unknown>,
): { value: Omit<Sim2RealArtifactRecord, 'id' | 'createdAt' | 'updatedAt'> } | { error: string } {
  const source =
    body.artifact && typeof body.artifact === 'object' && !Array.isArray(body.artifact)
      ? (body.artifact as Record<string, unknown>)
      : body;
  const artifactId = cleanText(source.artifactId ?? source.id, 128);
  const version = cleanText(source.version, 64);
  const name = cleanText(source.name, 180);
  const role = cleanText(source.role, 32) as Sim2RealArtifactRecord['role'];
  const kind = cleanText(source.kind, 16) as ModelArtifactKind;
  const format = cleanText(source.format, 16).toLowerCase() as ModelArtifactFormat;
  const ref = cleanText(source.ref ?? source.artifactRef, 500);
  const sha256 = cleanText(source.sha256, 64).toLowerCase();
  const status = (cleanText(source.status, 16) || 'draft') as Sim2RealArtifactLifecycleStatus;
  const runtime = cleanText(source.runtime, 24).toLowerCase() as ModelArtifactRuntime;
  const workload = cleanText(source.workload, 24).toLowerCase() as ModelArtifactWorkload;
  const modelId = cleanText(source.modelId, 128);
  const runId = cleanText(source.runId, 128);
  const contractId = cleanText(source.contractId, 128);
  const datasetIds = listOfStrings(source.datasetIds, 500);
  const evaluationIds = listOfStrings(source.evaluationIds, 500);
  const targetPlatforms = listOfStrings(source.targetPlatforms, 16);
  const sizeBytes = source.sizeBytes == null ? undefined : Number(source.sizeBytes);
  const threads = source.threads == null ? undefined : Number(source.threads);
  const metadata = source.metadata;
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(artifactId))
    return { error: 'artifactId 必须是 1-128 位字母、数字、点、下划线或短横线。' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) || version.toLowerCase() === 'latest')
    return { error: 'version 格式无效，且不能使用 latest。' };
  if (!name) return { error: '制品名称不能为空。' };
  if (!['policy', 'compiled-policy', 'calibration'].includes(role))
    return { error: 'role 必须是 policy、compiled-policy 或 calibration。' };
  if (!['source', 'compiled'].includes(kind)) return { error: 'kind 必须是 source 或 compiled。' };
  if (!['pytorch', 'onnx', 'bin', 'hbm', 'gguf', 'unknown'].includes(format))
    return { error: 'format 无效。' };
  if (!SAFE_ARTIFACT_REF.test(ref)) return { error: 'ref 必须是不透明 artifact:// 引用。' };
  if (!/^[a-f0-9]{64}$/.test(sha256)) return { error: 'sha256 必须是 64 位十六进制摘要。' };
  if (status !== 'draft')
    return { error: '新制品只能以 draft 状态登记；validated/published 请使用状态推进操作。' };
  if (runtime && !['cpu-onnx', 'bpu'].includes(runtime)) return { error: 'runtime 无效。' };
  if (
    workload &&
    !['locomotion', 'perception', 'navigation', 'speech', 'multimodal'].includes(workload)
  )
    return { error: 'workload 无效。' };
  if (!datasetIds || !evaluationIds || !targetPlatforms)
    return { error: 'datasetIds、evaluationIds 和 targetPlatforms 必须是字符串数组。' };
  if (
    (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) ||
    (threads !== undefined && (!Number.isSafeInteger(threads) || threads < 1 || threads > 128))
  )
    return { error: 'sizeBytes 必须是非负整数，threads 必须是 1-128 的整数。' };
  let safeMetadata: Sim2RealArtifactRecord['metadata'] | undefined;
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      return { error: 'metadata 必须是标量字段对象。' };
    const entries = Object.entries(metadata as Record<string, unknown>);
    if (entries.length > 32) return { error: 'metadata 最多 32 个字段。' };
    safeMetadata = {};
    for (const [key, value] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key)) return { error: 'metadata 字段名无效。' };
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      )
        return { error: 'metadata 只能包含字符串、数字、布尔值或 null。' };
      if (typeof value === 'string' && value.length > 500)
        return { error: 'metadata 字符串过长。' };
      safeMetadata[key] = value;
    }
  }
  return {
    value: {
      artifactId,
      version,
      name,
      role,
      kind,
      format,
      ...(runtime ? { runtime } : {}),
      ...(workload ? { workload } : {}),
      ...(threads === undefined ? {} : { threads }),
      ...(targetPlatforms.length ? { targetPlatforms } : {}),
      ref,
      sha256,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(modelId ? { modelId } : {}),
      ...(runId ? { runId } : {}),
      datasetIds,
      evaluationIds,
      ...(contractId ? { contractId } : {}),
      status,
      ...(safeMetadata && Object.keys(safeMetadata).length ? { metadata: safeMetadata } : {}),
    },
  };
}

function evaluationPayload(body: Record<string, unknown>): {
  value: Omit<Sim2RealEvaluationRecord, 'id' | 'createdAt' | 'updatedAt' | 'modelId'> & {
    modelId?: string;
  };
  error?: string;
} {
  const runId = cleanText(body.runId, 128);
  if (!runId) return { value: {} as never, error: 'runId 必填。' };
  const status = (cleanText(body.status, 16) || 'pending') as Sim2RealEvaluationStatus;
  const source = (cleanText(body.source, 16) || 'import') as Sim2RealEvaluationRecord['source'];
  if (status !== 'pending')
    return {
      value: {} as never,
      error: '新评测只能以 pending 状态登记；终态必须由评测推进接口产生。',
    };
  if (!['platform', 'runner', 'import'].includes(source))
    return { value: {} as never, error: '评测 source 无效。' };
  const datasetIds = listOfStrings(body.datasetIds, 500);
  if (!datasetIds) return { value: {} as never, error: 'datasetIds 必须是字符串数组。' };
  const report = body.report ?? body.evaluation;
  if (report !== undefined && (!report || typeof report !== 'object' || Array.isArray(report)))
    return { value: {} as never, error: 'report 必须是对象。' };
  const taskEvaluation = body.taskEvaluation;
  if (
    taskEvaluation !== undefined &&
    (!taskEvaluation || typeof taskEvaluation !== 'object' || Array.isArray(taskEvaluation))
  )
    return { value: {} as never, error: 'taskEvaluation 必须是对象。' };
  const summary = cleanText(body.summary, 500) || '评测记录已登记，等待结果。';
  return {
    value: {
      runId,
      datasetIds,
      status,
      summary,
      source,
      ...(cleanText(body.artifactId, 128) ? { artifactId: cleanText(body.artifactId, 128) } : {}),
      ...(cleanText(body.projectId, 128) ? { projectId: cleanText(body.projectId, 128) } : {}),
      ...(cleanText(body.taskId, 64) ? { taskId: cleanText(body.taskId, 64) } : {}),
      ...(cleanText(body.deviceId, 128) ? { deviceId: cleanText(body.deviceId, 128) } : {}),
      ...(cleanText(body.contractId, 128) ? { contractId: cleanText(body.contractId, 128) } : {}),
      ...(body.seed == null ? {} : { seed: Number(body.seed) }),
      ...(report !== undefined ? { report: report as Sim2RealEvaluationRecord['report'] } : {}),
      ...(taskEvaluation !== undefined
        ? { taskEvaluation: taskEvaluation as Sim2RealEvaluationRecord['taskEvaluation'] }
        : {}),
    },
  };
}

async function referencesVisible(
  project: Pick<Sim2RealProjectRecord, 'modelIds' | 'datasetIds'>,
  owner?: string,
): Promise<boolean> {
  const [models, datasets] = await Promise.all([
    listSim2RealModels(owner),
    listSim2RealDatasets(owner),
  ]);
  const modelIds = new Set(models.map((item) => item.id));
  const datasetIds = new Set(datasets.map((item) => item.id));
  return (
    project.modelIds.every((id) => modelIds.has(id)) &&
    project.datasetIds.every((id) => datasetIds.has(id))
  );
}

export function registerSim2RealWorkspaceRoutes(
  router: Router,
  deps: WorkspaceDeps,
  options: { prefix: string },
): void {
  const api = (suffix: string) => `${options.prefix}${suffix}`;
  router.get(
    api('/projects'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      response.json({ ok: true, projects: await listSim2RealProjects(owner) });
    }),
  );

  router.post(
    api('/projects'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const parsed = projectPayload(body);
      if ('error' in parsed) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_PROJECT', parsed.error, { retryable: false });
        return;
      }
      if (!(await referencesVisible(parsed.value, owner ?? undefined))) {
        sendApiError(
          response,
          422,
          'SIM2REAL_PROJECT_REFERENCE_INVALID',
          '项目引用的模型或数据集不存在，或不属于当前账号。',
          { retryable: false },
        );
        return;
      }
      try {
        response
          .status(201)
          .json({ ok: true, project: await createSim2RealProject(parsed.value, owner) });
      } catch (error) {
        if (error instanceof Error && error.message === 'sim2real_project_slug_exists') {
          sendApiError(response, 409, 'SIM2REAL_PROJECT_EXISTS', '当前账号已有相同 slug 的项目。', {
            retryable: false,
          });
          return;
        }
        deps.storageError(request, response, error, 'sim2real-project-create');
      }
    }),
  );

  router.get(
    api('/projects/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const project = await getSim2RealProject(cleanText(request.params.id, 120), owner);
      if (!project) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' });
        return;
      }
      const [datasets, runs] = await Promise.all([
        listSim2RealDatasets(owner),
        listSim2RealRuns(owner),
      ]);
      response.json({
        ok: true,
        project,
        datasets: datasets.filter((item) => project.datasetIds.includes(item.id)),
        runs: runs.filter((item) => item.projectId === project.id),
      });
    }),
  );

  router.patch(
    api('/projects/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const patch: Partial<
        Pick<Sim2RealProjectRecord, 'name' | 'slug' | 'description' | 'modelIds' | 'datasetIds'>
      > = {};
      if (body.name !== undefined) patch.name = cleanText(body.name, 160);
      if (body.slug !== undefined) patch.slug = cleanText(body.slug, 64).toLowerCase();
      if (body.description !== undefined) patch.description = cleanText(body.description, 4_000);
      if (body.modelIds !== undefined) patch.modelIds = listOfStrings(body.modelIds, 100) ?? [];
      if (body.datasetIds !== undefined)
        patch.datasetIds = listOfStrings(body.datasetIds, 500) ?? [];
      if (patch.slug !== undefined && !validSlug(patch.slug)) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_PROJECT', 'slug 格式无效。', {
          retryable: false,
        });
        return;
      }
      const current = await getSim2RealProject(cleanText(request.params.id, 120), owner);
      if (!current) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' });
        return;
      }
      if (
        !(await referencesVisible(
          {
            modelIds: patch.modelIds ?? current.modelIds,
            datasetIds: patch.datasetIds ?? current.datasetIds,
          },
          owner ?? undefined,
        ))
      ) {
        sendApiError(
          response,
          422,
          'SIM2REAL_PROJECT_REFERENCE_INVALID',
          '项目引用的模型或数据集不存在，或不属于当前账号。',
          { retryable: false },
        );
        return;
      }
      try {
        const project = await updateSim2RealProject(
          cleanText(request.params.id, 120),
          patch,
          owner,
        );
        if (!project) {
          response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' });
          return;
        }
        response.json({ ok: true, project });
      } catch (error) {
        if (error instanceof Error && error.message === 'sim2real_project_slug_exists') {
          sendApiError(response, 409, 'SIM2REAL_PROJECT_EXISTS', '当前账号已有相同 slug 的项目。', {
            retryable: false,
          });
          return;
        }
        deps.storageError(request, response, error, 'sim2real-project-update');
      }
    }),
  );

  router.get(
    api('/projects/:id/runs/compare'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const project = await getSim2RealProject(cleanText(request.params.id, 120), owner);
      if (!project) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' });
        return;
      }
      const all = (await listSim2RealRuns(owner)).filter((item) => item.projectId === project.id);
      const ids = cleanText(request.query.runIds, 1_024)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (ids.length > 20) {
        sendApiError(response, 400, 'SIM2REAL_TOO_MANY_RUNS', '一次最多比较 20 个运行。', {
          retryable: false,
        });
        return;
      }
      const runs = ids.length ? all.filter((item) => ids.includes(item.id)) : all.slice(0, 20);
      response.json({
        ok: true,
        projectId: project.id,
        runs,
        comparison: runs.map((run) => ({
          id: run.id,
          label: run.label ?? run.experimentId ?? run.id,
          experimentId: run.experimentId,
          status: run.status,
          createdAt: run.createdAt,
          metrics: run.metrics ?? null,
        })),
      });
    }),
  );

  /**
   * One canonical read model for the RDK Golden Path. The browser workbench,
   * CLI clients, and future RDK Studio integrations should consume this
   * endpoint instead of independently guessing which record is the next step.
   * It is read-only and therefore safe to poll while a worker or BoardAgent is
   * progressing.
   */
  router.get(
    api('/golden-path'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const projectId = cleanText(request.query.projectId, 160);
      const modelId = cleanText(request.query.modelId, 160);
      const taskId = cleanText(request.query.taskId, 160);
      const [projects, datasets, runs, evaluations, deployments] = await Promise.all([
        listSim2RealProjects(owner),
        listSim2RealDatasets(owner),
        listSim2RealRuns(owner),
        listSim2RealEvaluations(owner),
        listSim2RealDeployments(owner),
      ]);
      const project = projectId ? projects.find((item) => item.id === projectId) : undefined;
      if (projectId && !project) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' });
        return;
      }
      const snapshot = deriveRdkGoldenPath({
        ...(project ? { project } : {}),
        ...(modelId ? { modelId } : {}),
        ...(taskId ? { taskId } : {}),
        datasets,
        runs,
        evaluations,
        deployments,
      });
      response.setHeader('Cache-Control', 'no-store');
      response.json({ ok: true, goldenPath: snapshot });
    }),
  );

  router.get(
    api('/artifacts'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const [models, runs, datasets, deployments, registryArtifacts] = await Promise.all([
        listSim2RealModels(owner),
        listSim2RealRuns(owner),
        listSim2RealDatasets(owner),
        listSim2RealDeployments(owner),
        listSim2RealArtifacts(owner),
      ]);
      const type = queryValue(request.query.type);
      const allowedTypes = new Set([
        'model',
        'checkpoint',
        'recording',
        'dataset',
        'deployment',
        'artifact',
      ]);
      if (type && !allowedTypes.has(type)) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_ARTIFACT_TYPE',
          'type 必须是 model、checkpoint、recording、dataset、deployment 或 artifact。',
          { retryable: false },
        );
        return;
      }
      const modelId = queryValue(request.query.modelId);
      const runId = queryValue(request.query.runId);
      const projectId = queryValue(request.query.projectId);
      const taskId = queryValue(request.query.taskId);
      const search = queryValue(request.query.q ?? request.query.search);
      const statuses = queryValue(request.query.status)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const rawLimit = Number(request.query.limit ?? 200);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(500, Math.trunc(rawLimit)))
        : 200;
      const all = [
        ...buildArtifactCatalog({ models, runs, datasets, deployments }),
        ...registryArtifacts.map(registryArtifactCatalogRecord),
      ].sort(
        (a, b) => Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt),
      );
      const artifacts = all
        .filter(
          (item) =>
            (!type || item.type === type) &&
            (!modelId || item.modelId?.toLowerCase() === modelId) &&
            (!runId || item.runId?.toLowerCase() === runId) &&
            (!projectId || item.projectId?.toLowerCase() === projectId) &&
            (!taskId || item.taskId?.toLowerCase() === taskId) &&
            (!statuses.length || statuses.includes(item.status.toLowerCase())) &&
            (!search ||
              `${item.name} ${item.id} ${item.format ?? ''}`.toLowerCase().includes(search)),
        )
        .slice(0, limit);
      response.json({ ok: true, artifacts, total: artifacts.length, available: all.length });
    }),
  );

  // First-class immutable artifact registry.  The legacy catalog above keeps
  // synthetic model/checkpoint/recording rows for older clients; these routes
  // expose the durable release unit used by lineage and deployment gates.
  router.post(
    api('/artifacts'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const parsed = artifactPayload(body);
      if ('error' in parsed) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_ARTIFACT', parsed.error, {
          retryable: false,
        });
        return;
      }
      const header = request.headers['idempotency-key'];
      const headerKey = Array.isArray(header) ? header[0] : String(header ?? '').trim();
      const bodyKey = cleanText(body.idempotencyKey, 128);
      if (
        (headerKey && !/^[\x21-\x7e]{1,128}$/.test(headerKey)) ||
        (bodyKey && !/^[\x21-\x7e]{1,128}$/.test(bodyKey)) ||
        (headerKey && bodyKey && headerKey !== bodyKey)
      ) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_ARTIFACT',
          'Idempotency-Key 格式无效或与 body 不一致。',
          {
            retryable: false,
          },
        );
        return;
      }
      const idempotencyKey = headerKey || bodyKey || undefined;
      const requestFingerprint = JSON.stringify(parsed.value);
      try {
        const created = await createSim2RealArtifactWithResult(parsed.value, owner, {
          ...(idempotencyKey ? { idempotencyKey, requestFingerprint } : {}),
        });
        if (idempotencyKey) response.setHeader('Idempotency-Key', idempotencyKey);
        response.status(created.duplicate ? 200 : 201).json({
          ok: true,
          artifact: created.artifact,
          ...(created.duplicate ? { idempotentReplay: true } : {}),
        });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-artifact-create');
      }
    }),
  );

  router.get(
    api('/artifacts/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const artifact = await getSim2RealArtifact(cleanText(request.params.id, 160), owner);
      if (!artifact) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_ARTIFACT_NOT_FOUND',
          message: '制品不存在，或不属于当前账号。',
        });
        return;
      }
      response.json({ ok: true, artifact });
    }),
  );

  router.patch(
    api('/artifacts/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const status = cleanText(body.status, 16) as Sim2RealArtifactLifecycleStatus;
      if (!['validated', 'published', 'revoked'].includes(status)) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_ARTIFACT',
          'status 只能是 validated、published 或 revoked；制品元数据不可原地修改。',
          { retryable: false },
        );
        return;
      }
      try {
        const artifact = await updateSim2RealArtifactStatus(
          cleanText(request.params.id, 160),
          status,
          owner,
          cleanText(body.reason, 500),
        );
        if (!artifact) {
          response.status(404).json({
            ok: false,
            error: 'SIM2REAL_ARTIFACT_NOT_FOUND',
            message: '制品不存在，或不属于当前账号。',
          });
          return;
        }
        response.json({ ok: true, artifact });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-artifact-update');
      }
    }),
  );

  router.post(
    api('/artifacts/:id/validate'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      try {
        const artifact = await updateSim2RealArtifactStatus(
          cleanText(request.params.id, 160),
          'validated',
          owner,
        );
        if (!artifact) {
          response.status(404).json({ ok: false, error: 'SIM2REAL_ARTIFACT_NOT_FOUND' });
          return;
        }
        response.json({ ok: true, artifact });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-artifact-validate');
      }
    }),
  );

  router.post(
    api('/artifacts/:id/publish'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      try {
        const artifact = await updateSim2RealArtifactStatus(
          cleanText(request.params.id, 160),
          'published',
          owner,
        );
        if (!artifact) {
          response.status(404).json({ ok: false, error: 'SIM2REAL_ARTIFACT_NOT_FOUND' });
          return;
        }
        response.json({ ok: true, artifact });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-artifact-publish');
      }
    }),
  );

  router.post(
    api('/artifacts/:id/revoke'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const reason = cleanText(body.reason, 500) || '操作员撤销制品版本。';
      try {
        const artifact = await revokeSim2RealArtifact(
          cleanText(request.params.id, 160),
          reason,
          owner,
        );
        if (!artifact) {
          response.status(404).json({
            ok: false,
            error: 'SIM2REAL_ARTIFACT_NOT_FOUND',
            message: '制品不存在，或不属于当前账号。',
          });
          return;
        }
        response.json({ ok: true, artifact, revoked: true });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-artifact-revoke');
      }
    }),
  );

  router.get(
    api('/evaluations'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const all = await listSim2RealEvaluations(owner);
      const runId = cleanText(request.query.runId, 128);
      const artifactId = cleanText(request.query.artifactId, 128);
      const status = cleanText(request.query.status, 32).toLowerCase();
      const rawLimit = Number(request.query.limit ?? 200);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(500, Math.trunc(rawLimit)))
        : 200;
      const evaluations = all
        .filter(
          (item) =>
            (!runId || item.runId === runId) &&
            (!artifactId || item.artifactId === artifactId) &&
            (!status || item.status === status),
        )
        .slice(0, limit);
      response.json({ ok: true, evaluations, total: evaluations.length, available: all.length });
    }),
  );

  router.post(
    api('/evaluations'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const parsed = evaluationPayload(body);
      if (parsed.error) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_EVALUATION', parsed.error, {
          retryable: false,
        });
        return;
      }
      const run = await getSim2RealRun(parsed.value.runId, owner);
      if (!run) {
        sendApiError(
          response,
          422,
          'SIM2REAL_EVALUATION_LINEAGE_INVALID',
          'runId 不存在，或不属于当前账号。',
          {
            retryable: false,
          },
        );
        return;
      }
      // Run rows created by older servers do not carry a denormalized
      // contractId. Resolve the canonical contract from the owner-scoped
      // model manifest so imported evaluations receive the same provenance as
      // evaluations materialized by the telemetry route.
      const runModel = await listSim2RealModels(owner);
      const runModelRecord = runModel.find((item) => item.id === run.modelId);
      const canonicalContractId = runModelRecord?.manifest.contract.id;
      const header = request.headers['idempotency-key'];
      const headerKey = Array.isArray(header) ? header[0]?.trim() : String(header ?? '').trim();
      const bodyKey = cleanText(body.idempotencyKey, 128);
      if (
        (headerKey && !/^[\x21-\x7e]{1,128}$/.test(headerKey)) ||
        (bodyKey && !/^[\x21-\x7e]{1,128}$/.test(bodyKey)) ||
        (headerKey && bodyKey && headerKey !== bodyKey)
      ) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_EVALUATION',
          'Idempotency-Key 格式无效或与 body 不一致。',
          {
            retryable: false,
          },
        );
        return;
      }
      const idempotencyKey = headerKey || bodyKey || undefined;
      const requestFingerprint = JSON.stringify({
        ...parsed.value,
        modelId: run.modelId,
        ...(canonicalContractId
          ? { contractId: parsed.value.contractId ?? canonicalContractId }
          : {}),
      });
      try {
        const created = await createSim2RealEvaluationWithResult(
          {
            ...parsed.value,
            modelId: run.modelId,
            ...(parsed.value.projectId ? {} : run.projectId ? { projectId: run.projectId } : {}),
            ...(parsed.value.taskId ? {} : run.taskId ? { taskId: run.taskId } : {}),
            ...(parsed.value.contractId
              ? {}
              : canonicalContractId
                ? { contractId: canonicalContractId }
                : {}),
          } as Omit<Sim2RealEvaluationRecord, 'id' | 'createdAt' | 'updatedAt'>,
          owner,
          {
            ...(idempotencyKey ? { idempotencyKey, requestFingerprint } : {}),
          },
        );
        if (idempotencyKey) response.setHeader('Idempotency-Key', idempotencyKey);
        response.status(created.duplicate ? 200 : 201).json({
          ok: true,
          evaluation: created.evaluation,
          ...(created.duplicate ? { idempotentReplay: true } : {}),
        });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-evaluation-create');
      }
    }),
  );

  router.get(
    api('/evaluations/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const evaluation = await getSim2RealEvaluation(cleanText(request.params.id, 160), owner);
      if (!evaluation) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_EVALUATION_NOT_FOUND',
          message: '评测记录不存在，或不属于当前账号。',
        });
        return;
      }
      response.json({ ok: true, evaluation });
    }),
  );

  router.patch(
    api('/evaluations/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const statusValue = body.status === undefined ? undefined : cleanText(body.status, 16);
      const allowedStatuses = new Set(['pending', 'running', 'passed', 'failed', 'invalid']);
      if (statusValue !== undefined && !allowedStatuses.has(statusValue)) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_EVALUATION', '评测 status 无效。', {
          retryable: false,
        });
        return;
      }
      if (statusValue === 'passed') {
        sendApiError(
          response,
          409,
          'SIM2REAL_EVALUATION_ATTESTATION_REQUIRED',
          'passed 只能由服务端评测器或受信 runner 生成；请调用运行评测接口或提交受信证明。',
          { retryable: false },
        );
        return;
      }
      const report = body.report ?? body.evaluation;
      if (
        report !== undefined &&
        (!report || typeof report !== 'object' || Array.isArray(report))
      ) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_EVALUATION', 'report 必须是对象。', {
          retryable: false,
        });
        return;
      }
      const taskEvaluation = body.taskEvaluation;
      if (
        taskEvaluation !== undefined &&
        (!taskEvaluation || typeof taskEvaluation !== 'object' || Array.isArray(taskEvaluation))
      ) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_EVALUATION', 'taskEvaluation 必须是对象。', {
          retryable: false,
        });
        return;
      }
      const patch: Parameters<typeof updateSim2RealEvaluation>[1] = {
        ...(statusValue ? { status: statusValue as Sim2RealEvaluationStatus } : {}),
        ...(body.summary === undefined ? {} : { summary: cleanText(body.summary, 500) }),
        ...(report === undefined ? {} : { report: report as Sim2RealEvaluationRecord['report'] }),
        ...(taskEvaluation === undefined
          ? {}
          : { taskEvaluation: taskEvaluation as Sim2RealEvaluationRecord['taskEvaluation'] }),
        ...(body.deviceId === undefined ? {} : { deviceId: cleanText(body.deviceId, 128) }),
      };
      try {
        const evaluation = await updateSim2RealEvaluation(
          cleanText(request.params.id, 160),
          patch,
          owner,
        );
        if (!evaluation) {
          response.status(404).json({
            ok: false,
            error: 'SIM2REAL_EVALUATION_NOT_FOUND',
            message: '评测记录不存在，或不属于当前账号。',
          });
          return;
        }
        response.json({ ok: true, evaluation });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-evaluation-update');
      }
    }),
  );

  const lineageHandler = wrapAsync(async (request, response) => {
    const owner = deps.requestOwner(request, response);
    if (owner === null) return;
    response.setHeader('Cache-Control', 'no-store');
    const query = request.query as Record<string, unknown>;
    const params = {
      ...(cleanText(query.runId, 128) ? { runId: cleanText(query.runId, 128) } : {}),
      ...(cleanText(query.artifactId, 128) ? { artifactId: cleanText(query.artifactId, 128) } : {}),
      ...(cleanText(query.evaluationId, 128)
        ? { evaluationId: cleanText(query.evaluationId, 128) }
        : {}),
      ...(cleanText(query.projectId, 128) ? { projectId: cleanText(query.projectId, 128) } : {}),
    };
    if (Object.keys(params).length !== 1) {
      sendApiError(
        response,
        400,
        'SIM2REAL_LINEAGE_SELECTOR_REQUIRED',
        '必须且只能提供一个 runId、artifactId、evaluationId 或 projectId。',
        {
          retryable: false,
        },
      );
      return;
    }
    const lineage = await getSim2RealLineage(params, owner);
    if (!lineage) {
      response.status(404).json({
        ok: false,
        error: 'SIM2REAL_LINEAGE_NOT_FOUND',
        message: '血缘资源不存在，或不属于当前账号。',
      });
      return;
    }
    response.json({ ok: true, lineage });
  });
  router.get(api('/lineage'), lineageHandler);
  router.get(
    api('/runs/:id/lineage'),
    wrapAsync(async (request, response) => {
      // Keep a path-shaped convenience endpoint while sharing the exact same
      // owner-scoped graph implementation and response shape.
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const lineage = await getSim2RealLineage({ runId: cleanText(request.params.id, 160) }, owner);
      if (!lineage) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_LINEAGE_NOT_FOUND',
          message: '运行血缘不存在，或不属于当前账号。',
        });
        return;
      }
      response.json({ ok: true, lineage });
    }),
  );

  router.get(
    api('/datasets'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      response.json({ ok: true, datasets: await listSim2RealDatasets(owner) });
    }),
  );

  router.get(
    api('/datasets/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const dataset = await getSim2RealDataset(cleanText(request.params.id, 160), owner);
      if (!dataset) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_DATASET_NOT_FOUND',
          message: '数据集不存在，或不属于当前账号。',
        });
        return;
      }
      response.json({ ok: true, dataset });
    }),
  );

  router.post(
    api('/datasets'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const parsed = datasetPayload(body);
      if ('error' in parsed) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_DATASET', parsed.error, { retryable: false });
        return;
      }
      if (parsed.value.sourceRunId) {
        const sourceRun = await getSim2RealRun(parsed.value.sourceRunId, owner);
        if (!sourceRun) {
          sendApiError(
            response,
            422,
            'SIM2REAL_DATASET_SOURCE_RUN_INVALID',
            'sourceRunId 不存在，或不属于当前账号。',
            { retryable: false },
          );
          return;
        }
        if (parsed.value.contractId) {
          const sourceModel = await listSim2RealModels(owner);
          const model = sourceModel.find((item) => item.id === sourceRun.modelId);
          const contractId = model?.manifest?.contract?.id;
          if (contractId && contractId !== parsed.value.contractId) {
            sendApiError(
              response,
              422,
              'SIM2REAL_DATASET_CONTRACT_MISMATCH',
              '数据集 contractId 与来源运行的模型契约不一致。',
              { retryable: false },
            );
            return;
          }
        }
      }
      try {
        response
          .status(201)
          .json({ ok: true, dataset: await createSim2RealDataset(parsed.value, owner) });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-dataset-create');
      }
    }),
  );

  router.patch(
    api('/datasets/:id'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const status = cleanText(body.status, 16) as Sim2RealDatasetRecord['status'];
      if (!status || !['registered', 'ready', 'revoked'].includes(status)) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_DATASET',
          'status 必须是 registered、ready 或 revoked。',
          {
            retryable: false,
          },
        );
        return;
      }
      try {
        const dataset = await updateSim2RealDatasetStatus(
          cleanText(request.params.id, 160),
          status,
          owner,
        );
        if (!dataset) {
          response.status(404).json({ ok: false, error: 'SIM2REAL_DATASET_NOT_FOUND' });
          return;
        }
        response.json({ ok: true, dataset });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-dataset-update');
      }
    }),
  );

  router.post(
    api('/datasets/:id/revoke'),
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      try {
        const dataset = await updateSim2RealDatasetStatus(
          cleanText(request.params.id, 160),
          'revoked',
          owner,
        );
        if (!dataset) {
          response.status(404).json({ ok: false, error: 'SIM2REAL_DATASET_NOT_FOUND' });
          return;
        }
        response.json({ ok: true, dataset, revoked: true });
      } catch (error) {
        deps.storageError(request, response, error, 'sim2real-dataset-revoke');
      }
    }),
  );
}
