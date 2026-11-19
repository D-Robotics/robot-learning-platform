import { createHash, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request, Response, Router } from 'express';
import type { Device } from '../../shared/types.js';
import { wrapAsync, sendApiError } from '../sim2real/http-helpers.js';
import {
  createSim2RealComputeResource,
  listSim2RealComputeResources,
  getSim2RealComputeResourceSecret,
} from '../sim2real/sim2real-store.js';
import { normalizeComputeRunnerUrl } from '../sim2real/robogo-runner.js';
import { resolveDataDir } from '../sim2real/standalone-adapters.js';
import {
  workerBootstrapBundle,
  workerDeployCommand,
  workerStatusCommand,
} from '../sim2real/worker-bootstrap.js';

type OwnedDevice = Device & { bridgeOwnerKey?: string };
type Record = {
  id: string;
  owner: string;
  deviceId: string;
  name: string;
  runnerUrl: string;
  port: number;
  listenHost: string;
  sha256: string;
  privateKey: string;
  publicKey: string;
};
type Deps = {
  owner(request: Request, response: Response): string | undefined | null;
  device(
    request: Request,
    response: Response,
    owner: string | undefined,
    deviceId: string,
  ): Promise<OwnedDevice | null>;
  execute(
    request: Request,
    response: Response,
    device: OwnedDevice,
    command: string,
  ): Promise<string | null>;
  bundleOrigin(): string | null;
};
const pending = new Map<string, Promise<void>>();
async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(action);
  const tail = operation.then(
    () => {},
    () => {},
  );
  pending.set(key, tail);
  try {
    return await operation;
  } finally {
    if (pending.get(key) === tail) pending.delete(key);
  }
}

export function registerComputeSshRoutes(router: Router, deps: Deps, prefix: string) {
  const bundle = workerBootstrapBundle();
  const bundlePath = '/compute-ssh/bundles/' + bundle.sha256;
  router.get(prefix + '/compute-ssh/bundles/:sha', (request, response) => {
    if (request.params.sha !== bundle.sha256) {
      response.sendStatus(404);
      return;
    }
    response.setHeader('cache-control', 'public, max-age=31536000, immutable');
    response.type('application/gzip').send(bundle.bytes);
  });
  const directory = () => path.join(resolveDataDir(), 'compute-ssh');
  const filename = (id: string) => path.join(directory(), id + '.json');
  async function read(id: string): Promise<Record | null> {
    try {
      const stat = await fs.lstat(filename(id));
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 16384 ||
        (process.platform !== 'win32' && stat.mode & 0o077)
      )
        throw Error('private deployment record required');
      return JSON.parse(await fs.readFile(filename(id), 'utf8')) as Record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  const publicResult = (record: Record, state: string, details = {}) => ({
    ok: true,
    deploymentId: record.id,
    deviceId: record.deviceId,
    name: record.name,
    engine: 'starter-ppo',
    trainingDevice: 'cpu',
    state,
    ...details,
  });

  router.post(
    prefix + '/compute-ssh/deployments',
    wrapAsync(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      const owner = deps.owner(request, response);
      if (owner === null) return;
      const body = request.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['deviceId', 'name', 'runnerUrl', 'port'].includes(key)) ||
        typeof body.deviceId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.deviceId) ||
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.length > 120 ||
        [...body.name].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }) ||
        typeof body.runnerUrl !== 'string' ||
        body.runnerUrl.length > 2048 ||
        (body.port !== undefined &&
          (!Number.isInteger(body.port) || body.port < 1024 || body.port > 65535))
      ) {
        sendApiError(
          response,
          400,
          'COMPUTE_SSH_INVALID_INPUT',
          '请指定 Studio 中的设备、算力名称和平台可访问的 Worker 地址。',
          { retryable: false },
        );
        return;
      }
      let runnerUrl: string;
      try {
        runnerUrl = normalizeComputeRunnerUrl(body.runnerUrl, 'server-runner');
      } catch {
        sendApiError(
          response,
          400,
          'COMPUTE_SSH_INVALID_RUNNER_URL',
          'Worker 地址未通过平台网络校验。',
          { retryable: false },
        );
        return;
      }
      const device = await deps.device(request, response, owner, body.deviceId);
      if (!device) return;
      const origin = deps.bundleOrigin();
      if (!origin) {
        sendApiError(
          response,
          503,
          'COMPUTE_SSH_PUBLIC_ORIGIN_REQUIRED',
          '请配置平台的正式 HTTPS 地址，以便开发机下载已校验的 Worker。',
          { retryable: false },
        );
        return;
      }
      const shape = {
        owner: owner ?? 'local-dev',
        deviceId: device.id,
        name: body.name.trim(),
        runnerUrl,
        port: body.port ?? 19091,
        listenHost: new URL(runnerUrl).hostname === device.host ? '0.0.0.0' : '127.0.0.1',
        sha256: bundle.sha256,
      };
      const id = createHash('sha256').update(JSON.stringify(shape)).digest('hex');
      await serialized(filename(id), async () => {
        let record = await read(id);
        if (!record) {
          await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
          const keys = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          });
          record = { ...shape, id, ...keys };
          await fs.writeFile(filename(id), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        }
        const command = workerDeployCommand({ ...record, bundleUrl: origin + prefix + bundlePath });
        response.setHeader('x-rdk-compute-deployment-id', id);
        const output = await deps.execute(request, response, device, command);
        if (output === null) return;
        if (!output.includes('RDK_WORKER_DEPLOYMENT=')) {
          sendApiError(
            response,
            502,
            'COMPUTE_SSH_START_UNCONFIRMED',
            '尚未确认安装启动。请查询原部署状态。',
            { retryable: false, deploymentId: id },
          );
          return;
        }
        response.status(202).json(publicResult(record, 'starting'));
      });
    }),
  );

  router.get(
    prefix + '/compute-ssh/deployments/:id',
    wrapAsync(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      const owner = deps.owner(request, response);
      if (owner === null) return;
      const id = String(request.params.id);
      if (!/^[a-f0-9]{64}$/.test(id)) {
        response.sendStatus(404);
        return;
      }
      const record = await read(id);
      if (!record || record.owner !== (owner ?? 'local-dev')) {
        response.sendStatus(404);
        return;
      }
      response.json(publicResult(record, 'pending-check'));
    }),
  );

  router.post(
    prefix + '/compute-ssh/deployments/:id/poll',
    wrapAsync(async (request, response) => {
      response.setHeader('cache-control', 'no-store');
      const owner = deps.owner(request, response);
      if (owner === null) return;
      const id = String(request.params.id);
      if (!/^[a-f0-9]{64}$/.test(id)) {
        response.sendStatus(404);
        return;
      }
      await serialized(filename(id), async () => {
        const record = await read(id);
        if (!record || record.owner !== (owner ?? 'local-dev')) {
          response.sendStatus(404);
          return;
        }
        const device = await deps.device(request, response, owner, record.deviceId);
        if (!device) return;
        const output = await deps.execute(request, response, device, workerStatusCommand(id));
        if (output === null) return;
        let result;
        try {
          const line = output
            .split(/\r?\n/)
            .find((row) => row.startsWith('RDK_WORKER_DEPLOYMENT='));
          result = JSON.parse(line?.slice('RDK_WORKER_DEPLOYMENT='.length) ?? '');
        } catch {
          sendApiError(
            response,
            502,
            'COMPUTE_SSH_INVALID_RECEIPT',
            '无法读取原部署回执，请保留部署标识。',
            { retryable: true },
          );
          return;
        }
        if (
          !['starting', 'installing', 'ready', 'failed', 'offline', 'missing'].includes(
            result?.state,
          )
        ) {
          response.status(502).json({ ok: false, error: 'COMPUTE_SSH_INVALID_RECEIPT' });
          return;
        }
        if (result.state !== 'ready') {
          response.json(
            publicResult(record, result.state, {
              ...(typeof result.code === 'string' && /^[A-Za-z_]{1,100}$/.test(result.code)
                ? { code: result.code }
                : {}),
            }),
          );
          return;
        }
        let token: string;
        try {
          if (typeof result.sealedToken !== 'string' || result.sealedToken.length > 1024)
            throw Error();
          token = privateDecrypt(
            {
              key: record.privateKey,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: 'sha256',
            },
            Buffer.from(result.sealedToken, 'base64'),
          ).toString();
          if (!/^[A-Za-z0-9_-]{64}$/.test(token)) throw Error();
        } catch {
          response.status(502).json({ ok: false, error: 'COMPUTE_SSH_INVALID_SECRET_RECEIPT' });
          return;
        }
        const resources = (await listSim2RealComputeResources(owner)).filter(
          (item) => item.runnerUrl === record.runnerUrl,
        );
        let resource = resources[0];
        if (resources.length > 1) {
          response.status(409).json({ ok: false, error: 'COMPUTE_SSH_RESOURCE_AMBIGUOUS' });
          return;
        }
        if (resource) {
          const secret = await getSim2RealComputeResourceSecret(resource.id, owner);
          if (secret?.runnerToken !== token) {
            response.status(409).json({ ok: false, error: 'COMPUTE_SSH_RESOURCE_CONFLICT' });
            return;
          }
        } else {
          resource = await createSim2RealComputeResource(
            {
              name: record.name,
              kind: 'local-gpu',
              source: 'server-runner',
              runnerUrl: record.runnerUrl,
              runnerToken: token,
              maxConcurrentJobs: 1,
              status: 'unknown',
              message: 'Studio SSH 安装已完成，等待平台测试连接。',
            },
            owner,
          );
        }
        response.json(publicResult(record, 'registered', { computeResourceId: resource.id }));
      });
    }),
  );
}
