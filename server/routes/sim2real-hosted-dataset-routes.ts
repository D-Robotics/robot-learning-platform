import type { Request, Response, Router } from 'express';
import { pipeline } from 'node:stream/promises';
import type { Sim2RealDatasetRecord } from '../../shared/sim2real.js';
import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import {
  HOSTED_DATASET_LIMIT,
  HostedDatasetError,
  hostedDatasetReference,
  openHostedDataset,
  parseHostedDatasetReference,
  stageHostedDataset,
  validDatasetFilename,
} from '../sim2real/hosted-dataset.js';
import {
  createSim2RealDataset,
  getSim2RealDataset,
  getSim2RealRun,
  listSim2RealDatasets,
  listSim2RealModels,
} from '../sim2real/sim2real-store.js';

type DatasetInput = Omit<Sim2RealDatasetRecord, 'id' | 'createdAt' | 'updatedAt'>;
type Dependencies = {
  requestOwner(request: Request, response: Response): string | undefined | null;
  storageError(request: Request, response: Response, error: unknown, scope: string): void;
};

export function registerHostedDatasetRoutes(
  router: Router,
  deps: Dependencies,
  prefix: string,
  parse: (input: Record<string, unknown>) => { value: DatasetInput } | { error: string },
): void {
  const handleError = (request: Request, response: Response, error: unknown) => {
    if (response.headersSent) {
      response.destroy();
    } else if (error instanceof HostedDatasetError) {
      sendApiError(response, error.status, error.code, error.message, {
        retryable: error.status >= 500,
      });
    } else {
      deps.storageError(request, response, error, 'sim2real-hosted-dataset');
    }
  };

  router.post(
    prefix + '/datasets/upload',
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'no-store');
      if (
        !request.is('application/octet-stream') ||
        (request.get('content-encoding') && request.get('content-encoding') !== 'identity')
      ) {
        sendApiError(
          response,
          415,
          'SIM2REAL_DATASET_CONTENT_TYPE',
          '请以 application/octet-stream 上传原始文件。',
        );
        return;
      }
      if (Number(request.get('content-length')) > HOSTED_DATASET_LIMIT) {
        sendApiError(response, 413, 'SIM2REAL_DATASET_TOO_LARGE', '数据文件不能超过 50 MiB。');
        return;
      }
      const { filename, name, version, format, contractId, sourceRunId, sampleCount } =
        request.query;
      if (
        ![name, version, format, contractId, sourceRunId, sampleCount].every(
          (v) => v === undefined || typeof v === 'string',
        ) ||
        !validDatasetFilename(filename) ||
        typeof name !== 'string' ||
        name.length > 160 ||
        typeof version !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)
      ) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_DATASET',
          '请填写有效的数据集名称、版本和文件名。',
        );
        return;
      }
      const parsed = parse({ name, version, format, contractId, sourceRunId, sampleCount });
      if ('error' in parsed) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_DATASET', parsed.error);
        return;
      }
      try {
        if (parsed.value.sourceRunId) {
          const run = await getSim2RealRun(parsed.value.sourceRunId, owner);
          if (!run) {
            sendApiError(
              response,
              422,
              'SIM2REAL_DATASET_SOURCE_RUN_INVALID',
              '找不到当前账号下的来源 Run。',
            );
            return;
          }
          if (parsed.value.contractId) {
            const model = (await listSim2RealModels(owner)).find((item) => item.id === run.modelId);
            if (
              model?.manifest.contract.id &&
              model.manifest.contract.id !== parsed.value.contractId
            ) {
              sendApiError(
                response,
                422,
                'SIM2REAL_DATASET_CONTRACT_MISMATCH',
                '策略契约与来源 Run 不一致。',
              );
              return;
            }
          }
        }
        const staged = await stageHostedDataset(request, owner);
        try {
          const uri = hostedDatasetReference(staged.sha256, filename);
          const previous = () =>
            listSim2RealDatasets(owner).then((items) =>
              items.find(
                (item) => item.name === parsed.value.name && item.version === parsed.value.version,
              ),
            );
          const replay = async (existing: Sim2RealDatasetRecord) => {
            if (
              existing.status !== 'revoked' &&
              existing.uri === uri &&
              existing.sha256 === staged.sha256 &&
              existing.sizeBytes === staged.sizeBytes &&
              existing.format === parsed.value.format &&
              existing.contractId === parsed.value.contractId &&
              existing.sourceRunId === parsed.value.sourceRunId &&
              existing.sampleCount === parsed.value.sampleCount
            ) {
              await staged.publish();
              response.status(200).json({ ok: true, dataset: existing, replay: true });
            } else {
              sendApiError(
                response,
                409,
                'SIM2REAL_DATASET_VERSION_EXISTS',
                '名称和版本已存在，请使用新版本。',
              );
            }
          };
          const existing = await previous();
          if (existing) {
            await replay(existing);
            return;
          }
          await staged.publish();
          try {
            const dataset = await createSim2RealDataset(
              {
                ...parsed.value,
                uri,
                sha256: staged.sha256,
                sizeBytes: staged.sizeBytes,
              },
              owner,
            );
            response.status(201).json({ ok: true, dataset });
          } catch (error) {
            if ((error as Error).message !== 'sim2real_dataset_version_exists') throw error;
            const winner = await previous();
            if (!winner) throw error;
            await replay(winner);
          }
        } finally {
          await staged.discard();
        }
      } catch (error) {
        handleError(request, response, error);
      }
    }),
  );

  router.get(
    prefix + '/datasets/:id/file',
    wrapAsync(async (request, response) => {
      const owner = deps.requestOwner(request, response);
      if (owner === null) return;
      response.setHeader('Cache-Control', 'private, no-store');
      try {
        const dataset = await getSim2RealDataset(String(request.params.id ?? ''), owner);
        const fileRef = parseHostedDatasetReference(dataset?.uri);
        if (
          !dataset ||
          dataset.status === 'revoked' ||
          !fileRef ||
          fileRef.sha256 !== dataset.sha256 ||
          dataset.sizeBytes === undefined
        ) {
          sendApiError(
            response,
            404,
            'SIM2REAL_DATASET_FILE_MISSING',
            '当前账号没有可下载的托管文件。',
          );
          return;
        }
        const file = await openHostedDataset(owner, fileRef.sha256, dataset.sizeBytes);
        try {
          response.attachment(fileRef.filename);
          response.setHeader('Content-Type', 'application/octet-stream');
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.setHeader('Content-Length', String(dataset.sizeBytes));
          response.setHeader('X-Dataset-Sha256', fileRef.sha256);
          if (request.method === 'HEAD') response.end();
          else await pipeline(file.createReadStream({ start: 0, autoClose: false }), response);
        } finally {
          await file.close();
        }
      } catch (error) {
        handleError(request, response, error);
      }
    }),
  );
}
