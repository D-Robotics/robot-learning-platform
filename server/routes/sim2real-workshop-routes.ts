import { isDeepStrictEqual } from 'node:util';
import originManManifest from '../../plugins/rdk-robot-learning-platform/references/originman-manifest.json' with { type: 'json' };
import { validateSim2RealManifest } from '../../shared/sim2real.js';
import type { Request, Response, Router } from 'express';
import { createWorkshopSessions } from '../sim2real/workshop-session.js';
import { createExperimentSessions, ExperimentError } from '../sim2real/experiment-sessions.js';
import {
  createSim2RealModel,
  listSim2RealModels,
  listSim2RealComputeResources,
  getSim2RealRun,
  getSim2RealModel,
  getSim2RealComputeResource,
  findSim2RealRunByIdempotency,
} from '../sim2real/sim2real-store.js';
import { wrapAsync, sendApiError } from '../sim2real/http-helpers.js';
// The public platform validates manifest-defined robots under the custom profile.
const courseManifest =
  validateSim2RealManifest(originManManifest).manifest ??
  validateSim2RealManifest({
    ...originManManifest,
    robot: { ...originManManifest.robot, id: 'custom' },
    contract: { ...originManManifest.contract, robotId: 'custom' },
  }).manifest;

export function createPlatformWorkshopSessions() {
  const root = () => String(process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim();
  const experiments = createExperimentSessions({ root, getRun: getSim2RealRun });
  const sessions = createWorkshopSessions({
    readExperiment: async (id, owner) => (await experiments.resume(id, owner)).view,
    root,
    getRun: getSim2RealRun,
    findRun: async (key, owner) => (await findSim2RealRunByIdempotency(key, owner))?.run ?? null,
    remember: experiments.remember,
  });
  return { sessions, experiments };
}

export function registerSim2RealWorkshopRoutes(
  router: Router,
  deps: { requestOwner: (r: Request, s: Response) => string | undefined | null },
  options: { prefix: string },
) {
  const { sessions, experiments } = createPlatformWorkshopSessions();
  const api = (p: string) => options.prefix + '/workshop-sessions' + p;
  const handle = (fn: (r: Request, owner: string | undefined) => Promise<unknown>) =>
    wrapAsync(async (r, s) => {
      const owner = deps.requestOwner(r, s);
      if (owner === null) return;
      s.setHeader('Cache-Control', 'no-store');
      try {
        s.json({ ok: true, schemaVersion: 1, ...((await fn(r, owner)) as object) });
      } catch (e) {
        if (e instanceof ExperimentError) sendApiError(s, e.status, e.code, e.message);
        else sendApiError(s, 503, 'WORKSHOP_UNAVAILABLE', '课程暂不可用，保留原实验，不重新提交。');
      }
    });
  router.get(
    api(''),
    handle(async (_r, owner) => ({
      sessions: await sessions.list(owner),
      experiments: (await experiments.list(owner)).filter(
        (s) => !/^ws-[a-f0-9]{20}$/.test(s.contextId),
      ),
      current: await sessions.current(owner),
    })),
  );
  router.post(
    api(''),
    handle(async (r, owner) => {
      const b = r.body ?? {};
      const model = await getSim2RealModel(String(b.modelId ?? ''), owner);
      const resource = await getSim2RealComputeResource(String(b.computeResourceId ?? ''), owner);
      const isCourse =
        model &&
        (String(model.manifest.robot.id) === 'originman' ||
          (model.manifest.modelId === courseManifest?.modelId &&
            model.manifest.version === courseManifest.version &&
            isDeepStrictEqual(model.manifest.contract, courseManifest.contract) &&
            isDeepStrictEqual(model.manifest.robot, courseManifest.robot)));
      if (!isCourse || !resource)
        throw new ExperimentError(
          'WORKSHOP_ASSET_NOT_FOUND',
          '课程模型或算力不属于当前账号。',
          404,
        );
      return { session: await sessions.create(b, owner) };
    }),
  );
  router.get(
    api('/setup'),
    handle(async (_r, owner) => ({
      accountId: owner ?? null,
      resources: (await listSim2RealComputeResources(owner))
        .filter((resource) => resource.source !== 'local-agent')
        .map(({ id, name, status }) => ({ id, name, status })),
    })),
  );
  router.post(
    api('/setup'),
    handle(async (r, owner) => {
      const b = r.body ?? {};
      if (
        Object.keys(b).some((key) => !['accountId', 'computeResourceId'].includes(key)) ||
        typeof b.computeResourceId !== 'string' ||
        !b.computeResourceId ||
        b.computeResourceId.length > 160 ||
        b.accountId !== (owner ?? null)
      )
        throw new ExperimentError('WORKSHOP_SETUP_INVALID', '请在当前账号下重新选择算力机。', 400);
      const resource = await getSim2RealComputeResource(b.computeResourceId, owner);
      if (!resource || resource.source === 'local-agent')
        throw new ExperimentError('WORKSHOP_ASSET_NOT_FOUND', '这台算力机当前不可选。', 404);

      const manifest = courseManifest;
      if (!manifest)
        throw new ExperimentError(
          'WORKSHOP_MANIFEST_INVALID',
          '课程模型暂不可用，请联系课程维护者。',
          503,
        );
      const findModel = async () => {
        const model = (await listSim2RealModels(owner)).find(
          (record) =>
            record.manifest.modelId === manifest.modelId &&
            record.manifest.version === manifest.version,
        );
        if (
          model &&
          (!isDeepStrictEqual(model.manifest.contract, manifest.contract) ||
            !isDeepStrictEqual(model.manifest.robot, manifest.robot) ||
            !model.manifest.simulator.backends.includes('local'))
        )
          throw new ExperimentError(
            'WORKSHOP_MODEL_CONTRACT_MISMATCH',
            '课程模型契约不匹配，请联系课程维护者。',
            409,
          );
        return model;
      };
      let model = await findModel();
      if (!model) {
        try {
          model = await createSim2RealModel(manifest, owner);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'sim2real_model_version_exists')
            throw error;
          model = await findModel();
          if (!model) throw error;
        }
      }
      return {
        session: await sessions.create(
          { modelId: model.id, computeResourceId: resource.id },
          owner,
        ),
      };
    }),
  );
  router.get(
    api('/:contextId/comparison'),
    handle(async (r, owner) => ({
      comparison: await sessions.compare(String(r.params.contextId), r.query.with, owner),
    })),
  );
  router.get(
    api('/:contextId'),
    handle(async (r, owner) => ({
      session: await sessions.read(String(r.params.contextId), owner),
    })),
  );
  router.post(
    api('/:contextId/select'),
    handle(async (r, owner) => {
      if (Object.keys(r.body ?? {}).length)
        throw new ExperimentError('WORKSHOP_INPUT_INVALID', '仅选择已有实验。', 400);
      await sessions.select(String(r.params.contextId), owner);
      return { session: await sessions.read(String(r.params.contextId), owner) };
    }),
  );
  router.post(
    api('/:contextId/reference'),
    handle(async (r, owner) => {
      if (Object.keys(r.body ?? {}).some((k) => k !== 'reference'))
        throw new ExperimentError('WORKSHOP_INPUT_INVALID', '参考记录无效。', 400);
      return {
        session: await sessions.reference(String(r.params.contextId), r.body?.reference, owner),
      };
    }),
  );
  router.post(
    api('/:contextId/continue'),
    handle(async (r, owner) => ({
      session: await sessions.continue(String(r.params.contextId), owner),
    })),
  );
  router.post(
    api('/:contextId/pause'),
    handle(async (r, owner) => ({
      session: await sessions.pause(String(r.params.contextId), owner),
    })),
  );
  router.post(
    api('/:contextId/claim/:phase'),
    handle(async (r, owner) =>
      sessions.claim(
        String(r.params.contextId),
        String(r.params.phase) as 'train' | 'evaluate',
        r.body,
        owner,
      ),
    ),
  );
}
