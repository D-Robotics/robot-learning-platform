import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';

import type { Sim2RealDatasetRecord, Sim2RealProjectRecord } from '../../shared/sim2real.js';
import {
  createSim2RealDataset,
  createSim2RealProject,
  getSim2RealProject,
  listSim2RealDatasets,
  listSim2RealRuns,
  listSim2RealModels,
  listSim2RealProjects,
  updateSim2RealProject,
} from '../sim2real/sim2real-store.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';

type WorkspaceDeps = {
  requestOwner: (request: Request, response: Response) => string | undefined | null;
  storageError: (request: Request, response: Response, error: unknown, scope: string) => void;
};

function cleanText(value: unknown, max: number): string {
  return (Array.isArray(value) ? value[0] : value == null ? '' : String(value)).trim().slice(0, max);
}

function listOfStrings(value: unknown, max: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result = value.map((item) => String(item).trim()).filter(Boolean).slice(0, max);
  return result.length === value.length ? result : null;
}

function generatedSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56);
  return slug || `project-${randomUUID().slice(0, 8)}`;
}

function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

function projectPayload(body: Record<string, unknown>):
  | { value: Omit<Sim2RealProjectRecord, 'id' | 'createdAt' | 'updatedAt'> }
  | { error: string } {
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
      ...(cleanText(body.description, 4_000) ? { description: cleanText(body.description, 4_000) } : {}),
      modelIds,
      datasetIds,
    },
  };
}

function datasetPayload(body: Record<string, unknown>):
  | { value: Omit<Sim2RealDatasetRecord, 'id' | 'createdAt' | 'updatedAt'> }
  | { error: string } {
  const name = cleanText(body.name, 160);
  const sampleCount = body.sampleCount === undefined ? undefined : Number(body.sampleCount);
  const sizeBytes = body.sizeBytes === undefined ? undefined : Number(body.sizeBytes);
  const tags = listOfStrings(body.tags, 32);
  if (!name) return { error: '数据集名称不能为空。' };
  if ((sampleCount !== undefined && (!Number.isSafeInteger(sampleCount) || sampleCount < 0)) || (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0))) return { error: 'sampleCount 和 sizeBytes 必须是非负整数。' };
  if (!tags) return { error: 'tags 必须是字符串数组。' };
  return {
    value: {
      name,
      ...(cleanText(body.description, 4_000) ? { description: cleanText(body.description, 4_000) } : {}),
      ...(cleanText(body.uri, 2_048) ? { uri: cleanText(body.uri, 2_048) } : {}),
      ...(cleanText(body.format, 32) ? { format: cleanText(body.format, 32).toLowerCase() } : {}),
      ...(sampleCount !== undefined ? { sampleCount } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(tags.length ? { tags } : {}),
    },
  };
}

async function referencesVisible(
  project: Pick<Sim2RealProjectRecord, 'modelIds' | 'datasetIds'>,
  owner?: string,
): Promise<boolean> {
  const [models, datasets] = await Promise.all([listSim2RealModels(owner), listSim2RealDatasets(owner)]);
  const modelIds = new Set(models.map((item) => item.id));
  const datasetIds = new Set(datasets.map((item) => item.id));
  return project.modelIds.every((id) => modelIds.has(id)) && project.datasetIds.every((id) => datasetIds.has(id));
}

export function registerSim2RealWorkspaceRoutes(
  router: Router,
  deps: WorkspaceDeps,
  options: { prefix: string },
): void {
  const api = (suffix: string) => `${options.prefix}${suffix}`;
  router.get(api('/projects'), wrapAsync(async (request, response) => {
    const owner = deps.requestOwner(request, response); if (owner === null) return;
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, projects: await listSim2RealProjects(owner) });
  }));

  router.post(api('/projects'), wrapAsync(async (request, response) => {
    const owner = deps.requestOwner(request, response); if (owner === null) return;
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const parsed = projectPayload(body);
    if ('error' in parsed) { sendApiError(response, 400, 'SIM2REAL_INVALID_PROJECT', parsed.error, { retryable: false }); return; }
    if (!(await referencesVisible(parsed.value, owner ?? undefined))) { sendApiError(response, 422, 'SIM2REAL_PROJECT_REFERENCE_INVALID', '项目引用的模型或数据集不存在，或不属于当前账号。', { retryable: false }); return; }
    try {
      response.status(201).json({ ok: true, project: await createSim2RealProject(parsed.value, owner) });
    } catch (error) {
      if (error instanceof Error && error.message === 'sim2real_project_slug_exists') { sendApiError(response, 409, 'SIM2REAL_PROJECT_EXISTS', '当前账号已有相同 slug 的项目。', { retryable: false }); return; }
      deps.storageError(request, response, error, 'sim2real-project-create');
    }
  }));

  router.get(api('/projects/:id'), wrapAsync(async (request, response) => {
    const owner = deps.requestOwner(request, response); if (owner === null) return;
    const project = await getSim2RealProject(cleanText(request.params.id, 120), owner);
    if (!project) { response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' }); return; }
    const [datasets, runs] = await Promise.all([listSim2RealDatasets(owner), listSim2RealRuns(owner)]);
    response.json({ ok: true, project, datasets: datasets.filter((item) => project.datasetIds.includes(item.id)), runs: runs.filter((item) => item.projectId === project.id) });
  }));

  router.patch(api('/projects/:id'), wrapAsync(async (request, response) => {
    const owner = deps.requestOwner(request, response); if (owner === null) return;
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const patch: Partial<Pick<Sim2RealProjectRecord, 'name' | 'slug' | 'description' | 'modelIds' | 'datasetIds'>> = {};
    if (body.name !== undefined) patch.name = cleanText(body.name, 160);
    if (body.slug !== undefined) patch.slug = cleanText(body.slug, 64).toLowerCase();
    if (body.description !== undefined) patch.description = cleanText(body.description, 4_000);
    if (body.modelIds !== undefined) patch.modelIds = listOfStrings(body.modelIds, 100) ?? [];
    if (body.datasetIds !== undefined) patch.datasetIds = listOfStrings(body.datasetIds, 500) ?? [];
    if (patch.slug !== undefined && !validSlug(patch.slug)) { sendApiError(response, 400, 'SIM2REAL_INVALID_PROJECT', 'slug 格式无效。', { retryable: false }); return; }
    const current = await getSim2RealProject(cleanText(request.params.id, 120), owner);
    if (!current) { response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' }); return; }
    if (!(await referencesVisible({ modelIds: patch.modelIds ?? current.modelIds, datasetIds: patch.datasetIds ?? current.datasetIds }, owner ?? undefined))) { sendApiError(response, 422, 'SIM2REAL_PROJECT_REFERENCE_INVALID', '项目引用的模型或数据集不存在，或不属于当前账号。', { retryable: false }); return; }
    try {
      const project = await updateSim2RealProject(cleanText(request.params.id, 120), patch, owner);
      if (!project) { response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' }); return; }
      response.json({ ok: true, project });
    } catch (error) {
      if (error instanceof Error && error.message === 'sim2real_project_slug_exists') { sendApiError(response, 409, 'SIM2REAL_PROJECT_EXISTS', '当前账号已有相同 slug 的项目。', { retryable: false }); return; }
      deps.storageError(request, response, error, 'sim2real-project-update');
    }
  }));

  router.get(api('/projects/:id/runs/compare'), wrapAsync(async (request, response) => {
    const owner = deps.requestOwner(request, response); if (owner === null) return;
    const project = await getSim2RealProject(cleanText(request.params.id, 120), owner);
    if (!project) { response.status(404).json({ ok: false, error: 'SIM2REAL_PROJECT_NOT_FOUND' }); return; }
    const all = (await listSim2RealRuns(owner)).filter((item) => item.projectId === project.id);
    const ids = cleanText(request.query.runIds, 1_024).split(',').map((item) => item.trim()).filter(Boolean);
    if (ids.length > 20) { sendApiError(response, 400, 'SIM2REAL_TOO_MANY_RUNS', '一次最多比较 20 个运行。', { retryable: false }); return; }
    const runs = ids.length ? all.filter((item) => ids.includes(item.id)) : all.slice(0, 20);
    response.json({ ok: true, projectId: project.id, runs, comparison: runs.map((run) => ({ id: run.id, label: run.label ?? run.experimentId ?? run.id, experimentId: run.experimentId, status: run.status, createdAt: run.createdAt, metrics: run.metrics ?? null })) });
  }));

  router.get(api('/datasets'), wrapAsync(async (request, response) => {
    const owner = deps.requestOwner(request, response); if (owner === null) return;
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, datasets: await listSim2RealDatasets(owner) });
  }));

  router.post(api('/datasets'), wrapAsync(async (request, response) => {
    const owner = deps.requestOwner(request, response); if (owner === null) return;
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const parsed = datasetPayload(body);
    if ('error' in parsed) { sendApiError(response, 400, 'SIM2REAL_INVALID_DATASET', parsed.error, { retryable: false }); return; }
    try { response.status(201).json({ ok: true, dataset: await createSim2RealDataset(parsed.value, owner) }); }
    catch (error) { deps.storageError(request, response, error, 'sim2real-dataset-create'); }
  }));
}
