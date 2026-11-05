import type { Request, Response, Router } from 'express';
import { createWorkshopSessions } from '../sim2real/workshop-session.js';
import { createExperimentSessions, ExperimentError } from '../sim2real/experiment-sessions.js';
import {
  getSim2RealRun,
  getSim2RealModel,
  getSim2RealComputeResource,
  findSim2RealRunByIdempotency,
} from '../sim2real/sim2real-store.js';
import { wrapAsync, sendApiError } from '../sim2real/http-helpers.js';
export function registerSim2RealWorkshopRoutes(
  router: Router,
  deps: { requestOwner: (r: Request, s: Response) => string | undefined | null },
  options: { prefix: string },
) {
  const root = () => String(process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim();
  const experiments = createExperimentSessions({ root, getRun: getSim2RealRun });
  const sessions = createWorkshopSessions({
    readExperiment: async (id, owner) => (await experiments.resume(id, owner)).view,
    root,
    getRun: getSim2RealRun,
    findRun: async (key, owner) => (await findSim2RealRunByIdempotency(key, owner))?.run ?? null,
    remember: experiments.remember,
  });
  const api = (p: string) => options.prefix + '/workshops' + p;
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
      if (!model || String(model.manifest.robot.id) !== 'originman' || !resource)
        throw new ExperimentError(
          'WORKSHOP_ASSET_NOT_FOUND',
          '课程模型或算力不属于当前账号。',
          404,
        );
      return { session: await sessions.create(b, owner) };
    }),
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
