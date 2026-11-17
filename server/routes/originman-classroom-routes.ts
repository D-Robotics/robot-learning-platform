import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { Request, Response, Router } from 'express';
import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import {
  isOriginmanWorkshopEngine,
  ORIGINMAN_WORKSHOP_MANIFEST,
} from '../../shared/originman-workshop.js';
import { readOriginmanReference } from '../sim2real/originman-reference.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import { verifiedVideoWebm } from '../sim2real/verified-video.js';

type Owner = string | undefined;
type Artifact = { bytes: Buffer; sha256: string };

export function registerOriginmanClassroomRoutes(
  router: Router,
  deps: {
    api: (path: string) => string;
    owner: (request: Request, response: Response) => Owner | null;
    run: (id: string, owner: Owner) => Promise<Sim2RealRunRecord | null | undefined>;
    video: (run: Sim2RealRunRecord, owner: Owner) => Promise<Artifact | null>;
  },
) {
  const noStore = (response: Response) => response.setHeader('Cache-Control', 'no-store');
  const sendVideo = async (
    request: Request,
    response: Response,
    bytes: Buffer,
    sourceSha: string,
  ) => {
    const format = request.query.format ?? 'mp4';
    if (format !== 'mp4' && format !== 'webm') {
      sendApiError(response, 400, 'SIM2REAL_VIDEO_FORMAT_INVALID', '回放格式无效。');
      return;
    }
    let presentation = bytes;
    try {
      if (format === 'webm') presentation = await verifiedVideoWebm(bytes);
    } catch {
      sendApiError(
        response,
        503,
        'SIM2REAL_VIDEO_PRESENTATION_UNAVAILABLE',
        '回放兼容格式暂不可用。',
      );
      return;
    }
    response.type(format === 'webm' ? 'video/webm' : 'video/mp4');
    response.setHeader('X-Source-Artifact-Sha256', sourceSha);
    response.setHeader(
      'X-Artifact-Sha256',
      createHash('sha256').update(presentation).digest('hex'),
    );
    response.send(presentation);
  };

  router.get(
    deps.api('/workshops/originman'),
    wrapAsync(async (request, response) => {
      if (deps.owner(request, response) === null) return;
      noStore(response);
      const reference = await readOriginmanReference();
      response.json({
        ok: true,
        manifest: ORIGINMAN_WORKSHOP_MANIFEST,
        defaults: { phase: 'train', timesteps: 500000, seed: 7, pushMaxForce: 8.1, device: 'cuda' },
        simulationOnly: true,
        modelPreviewUrl: process.env.RDK_ORIGINMAN_PREVIEW_PATH
          ? '/sim2real/workshops/originman/model-preview'
          : null,
        capabilities: {
          engines: ['originman-recovery'],
          conditionCount: 62,
          videoFormats: ['mp4', 'webm'],
        },
        reference: reference.available ? { available: true, ...reference.metadata } : reference,
      });
    }),
  );

  router.get(
    deps.api('/workshops/originman/model-preview'),
    wrapAsync(async (request, response) => {
      if (deps.owner(request, response) === null) return;
      noStore(response);
      const file = process.env.RDK_ORIGINMAN_PREVIEW_PATH;
      const handle = file && (await open(file, 'r').catch(() => null));
      try {
        if (handle) {
          const info = await handle.stat();
          if (info.isFile() && info.size <= 2 * 1024 * 1024) {
            const buffer = Buffer.alloc(info.size + 1);
            const { bytesRead } = await handle.read(buffer);
            if (
              bytesRead === info.size &&
              buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ) {
              response.type('image/png').send(buffer.subarray(0, bytesRead));
              return;
            }
          }
        }
      } finally {
        if (handle) await handle.close();
      }
      sendApiError(response, 409, 'SIM2REAL_ORIGINMAN_PREVIEW_UNAVAILABLE', '场景预览暂不可用。');
    }),
  );

  router.get(
    deps.api('/workshops/originman/reference-video'),
    wrapAsync(async (request, response) => {
      if (deps.owner(request, response) === null) return;
      noStore(response);
      const reference = await readOriginmanReference();
      if (!reference.available) {
        sendApiError(
          response,
          409,
          'SIM2REAL_REFERENCE_UNVERIFIED',
          '课前参考视频未配置或校验未通过。',
        );
        return;
      }
      await sendVideo(request, response, reference.bytes, reference.metadata.video.sha256);
    }),
  );

  router.get(
    deps.api('/runs/:id/workshop-video'),
    wrapAsync(async (request, response) => {
      const owner = deps.owner(request, response);
      if (owner === null) return;
      noStore(response);
      const run = await deps.run(String(request.params.id), owner);
      if (!run) {
        sendApiError(response, 404, 'SIM2REAL_RUN_NOT_FOUND', '运行记录不存在。');
        return;
      }
      const receipt = run.metrics?.originmanWorkshop;
      const video = receipt?.video;
      const sourceId = run.training?.originmanWorkshop?.sourceRunId;
      const source = sourceId ? await deps.run(sourceId, owner) : undefined;
      if (
        run.status !== 'completed' ||
        run.backend !== 'local' ||
        run.mock !== false ||
        !isOriginmanWorkshopEngine(run.training?.engine) ||
        !video ||
        run.training?.originmanWorkshop?.phase !== 'evaluate' ||
        !source ||
        receipt.sourceRunId !== source.id ||
        source.status !== 'completed' ||
        source.mock !== false ||
        source.training?.originmanWorkshop?.phase !== 'train' ||
        receipt.policySha256 !== source.artifact?.sha256
      ) {
        sendApiError(
          response,
          409,
          'SIM2REAL_WORKSHOP_VIDEO_UNAVAILABLE',
          '本次评测尚无可核验的同源回放。',
        );
        return;
      }
      const artifact = await deps.video(run, owner);
      if (!artifact || artifact.sha256 !== video.sha256 || artifact.bytes.length !== video.bytes) {
        sendApiError(response, 503, 'SIM2REAL_WORKSHOP_VIDEO_UNVERIFIED', '本次评测回放校验失败。');
        return;
      }
      await sendVideo(request, response, artifact.bytes, video.sha256);
    }),
  );
}
