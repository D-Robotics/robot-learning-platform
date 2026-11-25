import {
  originmanReferenceDigest,
  REFERENCE_DIGEST_VERSION,
} from '../sim2real/originman-reference-digest.js';
import type { OriginmanMotionProvenance } from '../../shared/originman-reference-training.js';
import {
  listOriginmanMotion,
  OriginmanMotionError,
  prepareOriginmanMotion,
  preparePinnedOriginmanMotion,
  summarizeOriginmanMotion,
} from '../sim2real/originman-motion.js';
import { getWorkshopRun } from '../sim2real/workshop-run-evidence.js';
import referenceManifest from '../../plugins/rdk-robot-learning-platform/references/originman-reference-manifest.json' with { type: 'json' };
import {
  ORIGINMAN_REFERENCE_ENGINE,
  originmanReferenceCalibration,
  originmanReferenceExample,
  validateOriginmanReferenceTrajectory,
} from '../../shared/originman-reference-training.js';
import originManDanceManifest from '../../plugins/rdk-robot-learning-platform/references/originman-dance-manifest.json' with { type: 'json' };
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import originManManifest from '../../plugins/rdk-robot-learning-platform/references/originman-manifest.json' with { type: 'json' };
import { validateSim2RealManifest } from '../../shared/sim2real.js';
import type { Request, Response, Router } from 'express';
import { createWorkshopSessions } from '../sim2real/workshop-session.js';
import { createExperimentSessions, ExperimentError } from '../sim2real/experiment-sessions.js';
import {
  createSim2RealModel,
  listSim2RealModels,
  listSim2RealComputeResources,
  getSim2RealModel,
  getSim2RealComputeResource,
  getSim2RealComputeResourceSecret,
  findSim2RealRunByIdempotency,
} from '../sim2real/sim2real-store.js';
import { isWebCloudDeployment } from '../sim2real/standalone-adapters.js';
import { wrapAsync, sendApiError } from '../sim2real/http-helpers.js';
import { screenOriginmanReferenceWithWorker } from '../sim2real/robogo-runner.js';
// The public platform validates manifest-defined robots under the custom profile.
const courseManifest =
  validateSim2RealManifest(originManManifest).manifest ??
  validateSim2RealManifest({
    ...originManManifest,
    robot: { ...originManManifest.robot, id: 'custom' },
    contract: { ...originManManifest.contract, robotId: 'custom' },
  }).manifest;

function courseEngine(engines?: string[]) {
  return engines?.includes('originman-recovery') && !engines.includes('originman-recovery-reflect')
    ? 'originman-recovery'
    : 'originman-recovery-reflect';
}

export function createPlatformWorkshopSessions() {
  const root = () => String(process.env.RDK_SIM2REAL_STORAGE_DIR ?? '').trim();
  const experiments = createExperimentSessions({ root, getRun: getWorkshopRun });
  const sessions = createWorkshopSessions({
    readExperiment: async (id, owner) => (await experiments.resume(id, owner)).view,
    root,
    getRun: getWorkshopRun,
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
        else if (e instanceof OriginmanMotionError)
          sendApiError(s, e.status, 'ORIGINMAN_MOTION_INVALID', e.message);
        else sendApiError(s, 503, 'WORKSHOP_UNAVAILABLE', '课程暂不可用，保留原实验，不重新提交。');
      }
    });
  const requireActiveCourse = () => {
    if (isWebCloudDeployment())
      throw new ExperimentError(
        'WORKSHOP_RETIRED',
        '该课程已下线，新实验请打开 OriginMan 舞蹈 Workshop。',
        410,
      );
  };
  const motionApi = options.prefix + '/originman-motion';
  router.get(
    motionApi + '/catalog',
    handle(async () => listOriginmanMotion()),
  );
  router.post(
    motionApi + '/preview',
    handle(async (request) => ({
      preview: summarizeOriginmanMotion(await prepareOriginmanMotion(request.body)),
    })),
  );
  const referenceApi = options.prefix + '/originman-reference';
  router.get(
    referenceApi,
    handle(async (_request, owner) => ({
      calibration: originmanReferenceCalibration,
      example: originmanReferenceExample(),
      resources: (await listSim2RealComputeResources(owner))
        .filter(
          ({ status, source, mock, engines }) =>
            status === 'online' &&
            source !== 'local-agent' &&
            mock === false &&
            engines?.includes(ORIGINMAN_REFERENCE_ENGINE),
        )
        .map(({ id, name, cuda }) => ({ id, name, cuda })),
    })),
  );
  router.post(
    referenceApi + '/validate',
    handle(async (request) => {
      try {
        const trajectory = validateOriginmanReferenceTrajectory(request.body?.trajectory);
        return {
          frames: trajectory.joint_pos.length,
          durationSeconds: trajectory.joint_pos.length / trajectory.fps,
          fps: trajectory.fps,
          referenceSha256: createHash('sha256').update(JSON.stringify(trajectory)).digest('hex'),
          trajectorySha256: originmanReferenceDigest(trajectory),
          trajectoryDigestVersion: REFERENCE_DIGEST_VERSION,
        };
      } catch (error) {
        throw new ExperimentError(
          'ORIGINMAN_REFERENCE_INVALID',
          error instanceof Error ? error.message : '参考轨迹无效。',
          400,
        );
      }
    }),
  );
  router.post(
    referenceApi + '/screen',
    handle(async (request, owner) => {
      let trajectory;
      let composition: OriginmanMotionProvenance | undefined;
      const input = request.body ?? {};
      try {
        if (Object.hasOwn(input, 'composition')) {
          if (input.trajectory !== undefined)
            throw new OriginmanMotionError('编排与上传轨迹只能选择其中一种。');
          const prepared = await preparePinnedOriginmanMotion(
            input.composition,
            input.expectedTrajectorySha256,
          );
          trajectory = prepared.trajectory;
          composition = prepared.provenance;
        } else {
          trajectory = validateOriginmanReferenceTrajectory(input.trajectory);
        }
      } catch (error) {
        if (error instanceof OriginmanMotionError) throw error;
        throw new ExperimentError(
          'ORIGINMAN_REFERENCE_INVALID',
          error instanceof Error ? error.message : '参考轨迹无效。',
          400,
        );
      }
      const failureLocation = (frame: number | null) => {
        if (!composition || frame === null) return {};
        const block = composition.ranges.findIndex(({ from, to }) => from < frame && frame <= to);
        if (block >= 0) return { blockNumber: block + 1, motionId: composition.ranges[block].id };
        const after = composition.ranges.findIndex(({ from }) => from >= frame);
        return after > 0
          ? {
              betweenBlocks: true,
              fromBlockNumber: after,
              toBlockNumber: after + 1,
              fromMotionId: composition.ranges[after - 1].id,
              toMotionId: composition.ranges[after].id,
            }
          : { betweenBlocks: true };
      };
      const selected = await getSim2RealComputeResourceSecret(
        String(request.body?.computeResourceId ?? ''),
        owner,
      );
      const resource = selected?.resource;
      if (
        !resource ||
        resource.status !== 'online' ||
        resource.source === 'local-agent' ||
        resource.mock !== false ||
        !resource.engines?.includes(ORIGINMAN_REFERENCE_ENGINE)
      ) {
        throw new ExperimentError(
          'ORIGINMAN_REFERENCE_WORKER_MISSING',
          '请先检查支持跟跳的 Worker 连接。',
          409,
        );
      }
      const result = await screenOriginmanReferenceWithWorker({
        runnerUrl: resource.runnerUrl,
        token: selected.runnerToken,
        accountId: owner ?? 'local-dev',
        trajectory,
      }).catch(() => {
        throw new ExperimentError(
          'ORIGINMAN_REFERENCE_SCREEN_FAILED',
          'Worker 未返回可核验的筛查结果。请检查连接后重试。',
          503,
        );
      });
      if (result.busy) {
        throw new ExperimentError(
          'ORIGINMAN_REFERENCE_SCREEN_BUSY',
          'Worker 正在处理任务，请稍后重试。',
          409,
        );
      }
      if (result.invalid) {
        if (result.violation) {
          const { frame, joint } = result.violation;
          return {
            result: {
              passed: false,
              trajectorySha256: originmanReferenceDigest(trajectory),
              framesExpected: trajectory.joint_pos.length,
              framesEvaluated: 0,
              firstFailedFrame: frame,
              limitViolation: result.violation,
              failureLocation: failureLocation(frame),
              message: `第 ${frame} 帧的 ${joint} 目标角度超出所选场景的执行器限位。`,
            },
          };
        }
        throw new ExperimentError('ORIGINMAN_REFERENCE_SCREEN_INVALID', result.invalid, 422);
      }
      return {
        result: { ...result, failureLocation: failureLocation(result.firstFailedFrame ?? null) },
      };
    }),
  );
  router.post(
    referenceApi + '/model',
    handle(async (request, owner) => {
      const resource = await getSim2RealComputeResource(
        String(request.body?.computeResourceId ?? ''),
        owner,
      );
      if (
        !resource ||
        resource.status !== 'online' ||
        resource.mock !== false ||
        resource.source === 'local-agent' ||
        !resource.engines?.includes(ORIGINMAN_REFERENCE_ENGINE)
      )
        throw new ExperimentError(
          'ORIGINMAN_REFERENCE_WORKER_MISSING',
          '请选择已连接且支持参考轨迹跟跳的训练 Worker。',
          409,
        );
      const manifest = validateSim2RealManifest(referenceManifest).manifest;
      if (!manifest)
        throw new ExperimentError(
          'ORIGINMAN_REFERENCE_CONTRACT_INVALID',
          '专用策略契约暂不可用。',
          503,
        );
      const find = async () =>
        (await listSim2RealModels(owner)).find(
          ({ manifest: stored }) =>
            stored.modelId === manifest.modelId && stored.version === manifest.version,
        );
      let model = await find();
      if (!model) {
        try {
          model = await createSim2RealModel(manifest, owner);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'sim2real_model_version_exists')
            throw error;
          model = await find();
          if (!model) throw error;
        }
      }
      if (!isDeepStrictEqual(model.manifest, manifest))
        throw new ExperimentError(
          'ORIGINMAN_REFERENCE_CONTRACT_MISMATCH',
          '账号下的同名策略契约与跟跳任务不匹配。',
          409,
        );
      return { modelId: model.id };
    }),
  );
  router.get(
    options.prefix + '/model-templates/originman',
    handle(async () => ({
      templates: [
        { id: 'dance', name: '舞蹈编排', algorithm: 'PPO', manifest: originManDanceManifest },
      ],
    })),
  );
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
      requireActiveCourse();
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
      return { session: await sessions.create(b, owner, courseEngine(resource.engines)) };
    }),
  );
  router.get(
    api('/setup'),
    handle(async (_r, owner) => {
      requireActiveCourse();
      return {
        accountId: owner ?? null,
        resources: (await listSim2RealComputeResources(owner, { refreshShared: true }))
          .filter((resource) => resource.source !== 'local-agent')
          .map(
            ({
              id,
              name,
              status,
              engines,
              cuda,
              mock,
              activeJobs,
              queuedJobs,
              maxConcurrentJobs,
            }) => ({
              id,
              name,
              status,
              activeJobs,
              queuedJobs,
              maxConcurrentJobs,
              ...(Array.isArray(engines) ? { engines } : {}),
              ...(typeof cuda === 'boolean' ? { cuda } : {}),
              ...(typeof mock === 'boolean' ? { mock } : {}),
            }),
          ),
      };
    }),
  );
  router.post(
    api('/setup'),
    handle(async (r, owner) => {
      requireActiveCourse();
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
          courseEngine(resource.engines),
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
    handle(async (r, owner) => {
      requireActiveCourse();
      return { session: await sessions.continue(String(r.params.contextId), owner) };
    }),
  );
  router.post(
    api('/:contextId/pause'),
    handle(async (r, owner) => ({
      session: await sessions.pause(String(r.params.contextId), owner),
    })),
  );
  router.post(
    api('/:contextId/claim/:phase'),
    handle(async (r, owner) => {
      requireActiveCourse();
      return sessions.claim(
        String(r.params.contextId),
        String(r.params.phase) as 'train' | 'evaluate',
        r.body,
        owner,
      );
    }),
  );
}
