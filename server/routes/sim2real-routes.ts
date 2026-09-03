import { Router, type Request, type Response } from 'express';

import type { Device } from '../../shared/types.js';
import type {
  Sim2RealDeploymentMode,
  Sim2RealDeploymentRecord,
  Sim2RealDeploymentStep,
  Sim2RealModelManifest,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealRunBackend,
  Sim2RealRunStatus,
} from '../../shared/sim2real.js';
import {
  MICRODUCK_SIM2REAL_CONTRACT,
  normalizeTrainingSpec,
  SIM2REAL_PRODUCT_PROFILES,
  SIM2REAL_SCHEMA_VERSION,
  type Sim2RealCheckpointRef,
  type Sim2RealTrainingSpec,
  type Sim2RealRobotId,
  validateSim2RealManifest,
} from '../../shared/sim2real.js';
import { sendApiError, sendInternalApiError, wrapAsync } from '../sim2real/http-helpers.js';
import {
  isForeignOwnedDevice,
  readDevices,
  requestOwnsDevice,
} from '../sim2real/standalone-adapters.js';
import {
  compatibilityForManifest,
  compatibilityForPlatforms,
  deploymentStepsFor,
  probeRobogoIntegration,
  publicDeviceSummary,
  simulatorIntegration,
  storageIntegration,
  supportedRdkPlatforms,
} from '../sim2real/sim2real-service.js';
import {
  createSim2RealDeployment,
  createSim2RealModel,
  createSim2RealRun,
  getSim2RealRun,
  getSim2RealDeployment,
  getSim2RealModel,
  listSim2RealDeployments,
  listSim2RealModels,
  listSim2RealRuns,
  updateSim2RealRun,
  updateSim2RealDeployment,
} from '../sim2real/sim2real-store.js';
import { requestLocalTraining, requestLocalTrainingStatus } from '../sim2real/local-runner.js';
import { requestRobogoTraining, requestRobogoTrainingStatus } from '../sim2real/robogo-runner.js';
import { LOCAL_SIM2REAL_AUTH, type Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import { registerSim2RealTelemetryRoutes } from './sim2real-telemetry-routes.js';

type RunOnDevice = (
  request: Request,
  response: Response,
  id: string,
  commands: string[],
  options?: {
    timeoutMs?: number;
    usePool?: boolean;
    rejectOnNonZeroExit?: boolean;
    stdoutCharLimit?: number;
    abortSignal?: AbortSignal;
  },
) => Promise<{ device: unknown; output: string } | null>;

type OwnedDevice = Device & { bridgeOwnerKey?: string };

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

/** Shared deployments fail closed when no SSO owner is present. */
function requestOwner(
  request: Request,
  response: Response,
  auth: Sim2RealAuthPort,
): string | undefined | null {
  if (!auth.isMultiUserDeployment()) return undefined;
  const principal = auth.resolvePrincipal(request);
  const id = String(principal?.accountId ?? '').trim();
  if (!id) {
    noStore(response);
    sendApiError(
      response,
      401,
      'SIM2REAL_AUTH_REQUIRED',
      '请先登录 RDK Studio 再使用 sim2real 工作流',
      {
        retryable: false,
      },
    );
    return null;
  }
  return id;
}

function manifestFromBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const source = body as Record<string, unknown>;
  return source.manifest && typeof source.manifest === 'object' ? source.manifest : body;
}

function platformsFromBody(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const raw = (body as Record<string, unknown>).platforms;
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 12)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function safeMode(value: unknown): Sim2RealDeploymentMode | null {
  const mode = String(value ?? '').trim();
  return mode === 'preflight' || mode === 'canary' || mode === 'live' ? mode : null;
}

function safeBackend(value: unknown): Sim2RealRunBackend | null {
  const backend = String(value ?? '').trim();
  return backend === 'browser' ||
    backend === 'robogo' ||
    backend === 'local' ||
    backend === 'contract'
    ? backend
    : null;
}

function requestedProduct(value: unknown): Sim2RealRobotId {
  return value === 'rdk-duck' ? 'rdk-duck' : 'microduck';
}

function normalizeResumeFrom(value: unknown): { value?: Sim2RealCheckpointRef; error?: string } {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'resumeFrom must be an object with checkpointId and artifactRef' };
  }
  const source = value as Record<string, unknown>;
  const checkpointId = String(source.checkpointId ?? '').trim();
  const artifactRef = String(source.artifactRef ?? '').trim();
  const rawIteration = source.iteration == null ? undefined : Number(source.iteration);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(checkpointId)) {
    return { error: 'resumeFrom.checkpointId is invalid' };
  }
  if (!/^artifact:\/\/[a-zA-Z0-9._/-]{1,240}$/.test(artifactRef) || artifactRef.includes('..')) {
    return { error: 'resumeFrom.artifactRef must be an opaque artifact:// reference' };
  }
  if (
    rawIteration != null &&
    (!Number.isSafeInteger(rawIteration) || rawIteration < 0 || rawIteration > 2_000_000)
  ) {
    return { error: 'resumeFrom.iteration must be an integer between 0 and 2000000' };
  }
  return {
    value: {
      checkpointId,
      artifactRef,
      ...(rawIteration == null ? {} : { iteration: rawIteration }),
    },
  };
}

function ownerKey(owner: string | undefined): string | null {
  return owner ? `sso:${owner}:web` : null;
}

async function visibleDevices(owner: string | undefined): Promise<OwnedDevice[]> {
  const devices = (await readDevices()) as OwnedDevice[];
  const key = ownerKey(owner);
  return devices.filter((device) => !isForeignOwnedDevice(device, key));
}

function findVisibleDevice(devices: readonly OwnedDevice[], id: string): OwnedDevice | null {
  const wanted = id.trim();
  return devices.find((device) => device.id === wanted) ?? null;
}

function validationPayload(input: unknown, platforms: readonly string[]) {
  const validation = validateSim2RealManifest(input);
  return {
    validation,
    compatibility: validation.manifest
      ? compatibilityForPlatforms(validation.manifest, platforms)
      : [],
  };
}

function storageError(request: Request, response: Response, error: unknown, scope: string): void {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message === 'sim2real_storage_not_configured') {
    sendApiError(
      response,
      503,
      'SIM2REAL_STORAGE_NOT_CONFIGURED',
      '当前 Web Cloud 尚未配置 sim2real 持久化存储；只读仿真入口仍可使用。',
      { retryable: false },
    );
    return;
  }
  if (message === 'sim2real_model_version_exists') {
    sendApiError(
      response,
      409,
      'SIM2REAL_MODEL_EXISTS',
      '同一模型版本已登记，请修改 modelId 或 version。',
      {
        retryable: false,
      },
    );
    return;
  }
  sendInternalApiError(response, error, {
    code: 'SIM2REAL_STORE_FAILED',
    message: 'sim2real 状态保存失败，请稍后重试。',
    messageEn: 'The sim2real state store failed. Try again later.',
    request,
    scope,
  });
}

function deploymentSummary(mode: Sim2RealDeploymentMode, deployable: boolean): string {
  if (mode === 'preflight') {
    return deployable
      ? '只读板端预检计划已生成；通过后仍需显式批准 canary。'
      : '预检计划已生成，但当前模型还没有可用于该板型的编译制品。';
  }
  if (mode === 'canary') {
    return deployable
      ? 'Canary 请求已登记；真实制品下发与执行必须由受控 board agent 完成。'
      : 'Canary 被阻止：先为目标板型准备匹配的编译制品。';
  }
  return 'Live 执行被阻止：RDK Studio 网页层不会直接开启电机控制。';
}

function preflightCommand(): string {
  return [
    'set +e',
    'printf "__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__\\n"',
    'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
    'printf "kernel=%s\\n" "$(uname -r 2>/dev/null || echo unknown)"',
    'printf "python3=%s\\n" "$(command -v python3 2>/dev/null || echo missing)"',
    'printf "tros=%s\\n" "$(if test -d /opt/tros || test -d /opt/ros; then echo present; else echo missing; fi)"',
    'printf "disk_bytes=%s\\n" "$(df -Pk /tmp 2>/dev/null | awk \'NR==2 {print $4 * 1024}\' || echo unknown)"',
    'printf "__STUDIO_SIM2REAL_PREFLIGHT_END__\\n"',
  ].join('; ');
}

function markStep(
  steps: readonly Sim2RealDeploymentStep[],
  id: string,
  status: Sim2RealDeploymentStep['status'],
  detail?: string,
): Sim2RealDeploymentStep[] {
  return steps.map((step) =>
    step.id === id ? { ...step, status, ...(detail ? { detail } : {}) } : { ...step },
  );
}

export function createSim2RealRouter(
  deps: { runOnDevice?: RunOnDevice; auth?: Sim2RealAuthPort } = {},
): Router {
  const router = Router();
  const auth = deps.auth ?? LOCAL_SIM2REAL_AUTH;

  router.get(
    '/api/sim2real/overview',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const principal = auth.resolvePrincipal(request);
      const selectedProductId = requestedProduct(request.query.productId);
      noStore(response);
      const [models, runs, deployments, devices, robogo] = await Promise.all([
        listSim2RealModels(owner),
        listSim2RealRuns(owner),
        listSim2RealDeployments(owner),
        visibleDevices(owner),
        probeRobogoIntegration(
          String(auth.resolvePrincipal(request)?.accountId ?? owner ?? ''),
          auth.resolveAccessToken(request),
        ),
      ]);
      response.json({
        ok: true,
        schemaVersion: SIM2REAL_SCHEMA_VERSION,
        identity: principal
          ? {
              accountId: principal.accountId,
              ...(principal.displayName ? { displayName: principal.displayName } : {}),
              ...(principal.email ? { email: principal.email } : {}),
            }
          : null,
        productProfiles: Object.values(SIM2REAL_PRODUCT_PROFILES),
        selectedProductId,
        selectedContract: selectedProductId === 'microduck' ? MICRODUCK_SIM2REAL_CONTRACT : null,
        contract: MICRODUCK_SIM2REAL_CONTRACT,
        models,
        runs,
        deployments,
        devices: devices.map(publicDeviceSummary),
        integrations: {
          simulator: simulatorIntegration(),
          robogo,
          storage: storageIntegration(),
        },
        supportedPlatforms: supportedRdkPlatforms(),
      });
    }),
  );

  registerSim2RealTelemetryRoutes(router, {
    auth,
    requestOwner: (request, response) => requestOwner(request, response, auth),
    visibleDevices,
    storageError,
  });

  router.post(
    '/api/sim2real/models/validate',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      void owner;
      noStore(response);
      const payload = validationPayload(
        manifestFromBody(request.body),
        platformsFromBody(request.body),
      );
      response.json({ ok: true, ...payload });
    }),
  );

  router.get(
    '/api/sim2real/runs/:id',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const run = await getSim2RealRun(String(request.params.id || ''), owner);
      if (!run) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_RUN_NOT_FOUND' });
        return;
      }
      let current = run;
      if (
        (run.backend === 'local' || run.backend === 'robogo') &&
        (run.status === 'queued' || run.status === 'running') &&
        run.externalRunId
      ) {
        const accountId = String(
          auth.resolvePrincipal(request)?.accountId ??
            owner ??
            (!auth.isMultiUserDeployment() ? 'local-dev' : ''),
        ).trim();
        if (accountId) {
          try {
            const latest =
              run.backend === 'local'
                ? await requestLocalTrainingStatus({
                    accountId,
                    externalRunId: run.externalRunId,
                  })
                : await requestRobogoTrainingStatus({
                    accountId,
                    requestToken: auth.resolveAccessToken(request),
                    externalRunId: run.externalRunId,
                  });
            const update = {
              status: latest.status,
              ...(latest.message ? { summary: latest.message } : {}),
              ...(latest.mock ? { mock: true } : {}),
              ...(latest.checkpoint ? { checkpoint: latest.checkpoint } : {}),
              ...(latest.artifact ? { artifact: latest.artifact } : {}),
              ...(latest.metrics ? { metrics: latest.metrics } : {}),
              ...(latest.status === 'completed' && !run.finishedAt
                ? { finishedAt: new Date().toISOString() }
                : {}),
            };
            current = (await updateSim2RealRun(run.id, update, owner)) ?? run;
          } catch {}
        }
      }
      response.json({ ok: true, run: current });
    }),
  );

  router.post(
    '/api/sim2real/models',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const payload = validationPayload(manifestFromBody(request.body), []);
      if (!payload.validation.valid || !payload.validation.manifest) {
        response.status(400).json({
          ok: false,
          error: 'SIM2REAL_INVALID_MANIFEST',
          validation: payload.validation,
        });
        return;
      }
      try {
        const model = await createSim2RealModel(payload.validation.manifest, owner);
        response
          .status(201)
          .json({ ok: true, model, compatibility: compatibilityForPlatforms(model.manifest) });
      } catch (error) {
        storageError(request, response, error, 'sim2real-model-create');
      }
    }),
  );

  router.get(
    '/api/sim2real/models/:id',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const model = await getSim2RealModel(String(request.params.id || ''), owner);
      if (!model) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_MODEL_NOT_FOUND' });
        return;
      }
      response.json({ ok: true, model, compatibility: compatibilityForPlatforms(model.manifest) });
    }),
  );

  router.post(
    '/api/sim2real/runs',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const modelId = String(body.modelId ?? '').trim();
      const taskId = String(body.taskId ?? '')
        .trim()
        .toLowerCase();
      const backend = safeBackend(body.backend);
      if (!modelId || !backend) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_RUN',
          'modelId 和 backend(browser、local、robogo 或 contract) 必填',
          {
            retryable: false,
          },
        );
        return;
      }
      if (taskId && !/^[a-z][a-z0-9_-]{0,31}$/.test(taskId)) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_TASK', 'taskId 格式无效', {
          retryable: false,
        });
        return;
      }
      const hasTraining = Object.prototype.hasOwnProperty.call(body, 'training');
      let training: Sim2RealTrainingSpec | undefined;
      if (backend === 'robogo' || backend === 'local' || hasTraining) {
        const trainingResult = normalizeTrainingSpec(
          hasTraining ? body.training : { profile: 'smoke' },
        );
        if (trainingResult.errors.length || !trainingResult.spec) {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_TRAINING',
            trainingResult.errors[0] || '训练参数无效',
            {
              retryable: false,
            },
          );
          return;
        }
        training = trainingResult.spec;
      }
      const resumeResult = normalizeResumeFrom(body.resumeFrom);
      if (resumeResult.error) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_RESUME', resumeResult.error, {
          retryable: false,
        });
        return;
      }
      const resumeFrom = resumeResult.value;
      const model = await getSim2RealModel(modelId, owner);
      if (!model) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_MODEL_NOT_FOUND' });
        return;
      }
      const browserSupported = model.manifest.simulator.backends.includes('browser');
      const robogoSupported = model.manifest.simulator.backends.includes('robogo');
      const localSupported = model.manifest.simulator.backends.includes('local');
      const integrations = simulatorIntegration();
      const robogoRunnerAvailable = integrations.robogo.available;
      const localRunnerAvailable = integrations.local.available;
      const isBuiltin = model.builtin === true;
      const now = new Date().toISOString();
      let status: Sim2RealRunStatus = 'blocked';
      let summary = '';
      let launchUrl: string | undefined;
      let externalRunId: string | undefined;
      let mock = false;
      let checkpoint: Sim2RealCheckpointRef | undefined;
      let artifact: Sim2RealRunArtifactMetadata | undefined;
      let metrics: Sim2RealRunMetrics | undefined;
      if (backend === 'contract') {
        status = 'completed';
        summary = '模型契约校验完成；这一步不运行模型，也不接触设备。';
        metrics = {
          contractValid: true,
          observationSize: model.manifest.contract.observationSize,
          actionSize: model.manifest.contract.actionSize,
        };
      } else if (backend === 'browser' && browserSupported && isBuiltin) {
        status = 'ready';
        summary = '官方参考策略已准备好在浏览器 MicroDuck 仿真中运行。';
        launchUrl = model.manifest.simulator.entryUrl || '/mujoco/microduck/';
      } else if (backend === 'browser' && browserSupported) {
        status = 'blocked';
        summary = '该用户模型已登记，但当前网页仿真仍使用固定官方策略，尚未允许动态替换制品。';
      } else if (backend === 'robogo' && robogoSupported && robogoRunnerAvailable) {
        const accountId = String(
          auth.resolvePrincipal(request)?.accountId ??
            owner ??
            (!auth.isMultiUserDeployment() ? 'local-dev' : ''),
        ).trim();
        if (!accountId) {
          status = 'queued';
          summary = 'RoboGo runner 已配置，但当前会话没有可用账号；任务只登记，未启动训练。';
        } else {
          try {
            const launched = await requestRobogoTraining({
              accountId,
              requestToken: auth.resolveAccessToken(request),
              manifest: model.manifest,
              training,
              resumeFrom,
              taskId: taskId || undefined,
            });
            status = launched.status;
            externalRunId = launched.externalRunId;
            mock = launched.mock === true;
            launchUrl = launched.launchUrl;
            checkpoint = launched.checkpoint;
            artifact = launched.artifact;
            metrics = launched.metrics;
            summary =
              launched.message ||
              'RoboGo 训练已' +
                (launched.status === 'completed'
                  ? '完成'
                  : launched.status === 'running'
                    ? '启动'
                    : '排队') +
                '；不会在网页层直接驱动电机。';
          } catch {
            status = 'failed';
            summary = 'RoboGo runner 已配置，但训练请求未确认成功；不会自动重试，避免重复计费。';
          }
        }
      } else if (backend === 'local' && localSupported && localRunnerAvailable) {
        const accountId = String(
          auth.resolvePrincipal(request)?.accountId ??
            owner ??
            (!auth.isMultiUserDeployment() ? 'local-dev' : ''),
        ).trim();
        if (!accountId) {
          status = 'queued';
          summary = '本地训练 runner 已配置，但当前会话没有可用账号；任务只登记，未启动训练。';
        } else {
          try {
            const launched = await requestLocalTraining({
              accountId,
              manifest: model.manifest,
              training,
              resumeFrom,
              taskId: taskId || undefined,
            });
            status = launched.status;
            externalRunId = launched.externalRunId;
            mock = launched.mock === true;
            launchUrl = launched.launchUrl;
            checkpoint = launched.checkpoint;
            artifact = launched.artifact;
            metrics = launched.metrics;
            summary =
              launched.message ||
              '本地服务器训练已' +
                (launched.status === 'completed'
                  ? '完成'
                  : launched.status === 'running'
                    ? '启动'
                    : '排队') +
                '；训练进程由受控 worker 管理。';
          } catch {
            status = 'failed';
            summary = '本地训练 runner 已配置，但训练请求未确认成功；不会自动重试。';
          }
        }
      } else {
        summary =
          backend === 'robogo'
            ? 'RoboGo runner 尚未配置，任务未启动。'
            : backend === 'local'
              ? '本地训练 runner 尚未配置，任务未启动。'
              : '该模型没有声明 browser 仿真后端。';
      }
      try {
        const run = await createSim2RealRun(
          {
            modelId: model.id,
            ...(taskId ? { taskId } : {}),
            backend,
            status,
            summary,
            ...(launchUrl ? { launchUrl } : {}),
            ...(externalRunId ? { externalRunId } : {}),
            ...(mock ? { mock: true } : {}),
            ...(training ? { training } : {}),
            ...(resumeFrom ? { resumeFrom } : {}),
            ...(checkpoint ? { checkpoint } : {}),
            ...(artifact ? { artifact } : {}),
            ...(metrics ? { metrics } : {}),
            ...(status === 'completed' ? { finishedAt: now } : {}),
          },
          owner,
        );
        response.status(201).json({ ok: true, run });
      } catch (error) {
        storageError(request, response, error, 'sim2real-run-create');
      }
    }),
  );

  router.post(
    '/api/sim2real/deployments',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const modelId = String(body.modelId ?? '').trim();
      const deviceId = String(body.deviceId ?? '').trim();
      const mode = body.mode == null ? 'preflight' : safeMode(body.mode);
      if (!modelId || !deviceId || !mode) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_DEPLOYMENT',
          'modelId、deviceId 和合法的 mode(preflight、canary 或 live) 必填',
          { retryable: false },
        );
        return;
      }
      const model = await getSim2RealModel(modelId, owner);
      if (!model) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_MODEL_NOT_FOUND' });
        return;
      }
      const devices = await visibleDevices(owner);
      const device = findVisibleDevice(devices, deviceId);
      if (!device || !requestOwnsDevice(request, device)) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_DEVICE_NOT_FOUND' });
        return;
      }
      const targetPlatform = String(device.boardPlatform ?? '').trim();
      if (!targetPlatform) {
        response.status(409).json({
          ok: false,
          error: 'SIM2REAL_BOARD_DETECTION_REQUIRED',
          message: '请先完成板卡探测，再生成部署计划。',
        });
        return;
      }
      const compatibility = compatibilityForManifest(model.manifest, targetPlatform);
      const status = mode === 'live' ? 'blocked' : compatibility.deployable ? 'planned' : 'blocked';
      const deployment: Omit<Sim2RealDeploymentRecord, 'id' | 'createdAt' | 'updatedAt'> = {
        modelId: model.id,
        deviceId: device.id,
        targetPlatform,
        mode,
        status,
        summary: deploymentSummary(mode, compatibility.deployable),
        compatibility,
        steps: deploymentStepsFor(compatibility),
      };
      try {
        const created = await createSim2RealDeployment(deployment, owner);
        response.status(201).json({ ok: true, deployment: created });
      } catch (error) {
        storageError(request, response, error, 'sim2real-deployment-create');
      }
    }),
  );

  router.get(
    '/api/sim2real/deployments/:id',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const deployment = await getSim2RealDeployment(String(request.params.id || ''), owner);
      if (!deployment) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_DEPLOYMENT_NOT_FOUND' });
        return;
      }
      response.json({ ok: true, deployment });
    }),
  );

  router.post(
    '/api/sim2real/deployments/:id/preflight',
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const id = String(request.params.id || '').trim();
      const deployment = await getSim2RealDeployment(id, owner);
      if (!deployment) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_DEPLOYMENT_NOT_FOUND' });
        return;
      }
      if (deployment.mode !== 'preflight') {
        response.status(409).json({
          ok: false,
          error: 'SIM2REAL_MUTATION_GATED',
          message: '当前入口只允许执行只读 preflight；canary/live 由受控 board agent 接管。',
        });
        return;
      }
      if (!deps.runOnDevice) {
        sendApiError(
          response,
          503,
          'SIM2REAL_DEVICE_RUNNER_UNAVAILABLE',
          '当前部署没有可用的板端执行适配器',
          {
            retryable: false,
          },
        );
        return;
      }
      const devices = await visibleDevices(owner);
      const device = findVisibleDevice(devices, deployment.deviceId);
      if (!device || !requestOwnsDevice(request, device)) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_DEVICE_NOT_FOUND' });
        return;
      }
      const runningSteps = markStep(deployment.steps, 'board-passport', 'running');
      await updateSim2RealDeployment(
        id,
        {
          status: 'running',
          summary: '正在执行只读板端预检；不会上传模型、启动进程或驱动电机。',
          steps: runningSteps,
        },
        owner,
      );
      try {
        const executed = await deps.runOnDevice(
          request,
          response,
          device.id,
          [preflightCommand()],
          {
            timeoutMs: 45_000,
            usePool: true,
            rejectOnNonZeroExit: false,
            stdoutCharLimit: 12_000,
          },
        );
        if (!executed) {
          await updateSim2RealDeployment(
            id,
            {
              status: 'failed',
              summary: '板端只读预检未完成；未执行模型下发或电机动作。',
              steps: markStep(
                runningSteps,
                'board-passport',
                'failed',
                'The device runner did not return a probe result.',
              ),
            },
            owner,
          ).catch(() => null);
          return;
        }
        const finalSteps = markStep(
          runningSteps,
          'board-passport',
          'completed',
          'Read-only board probe completed; raw shell output is intentionally not persisted.',
        );
        const finalStatus = deployment.compatibility.deployable ? 'ready' : 'blocked';
        const finalSummary = deployment.compatibility.deployable
          ? '板端只读预检通过；下一步仍需显式批准并由 board agent 执行 canary。'
          : '板端只读预检通过，但模型仍缺少匹配的编译制品，不能进入 canary。';
        const updated = await updateSim2RealDeployment(
          id,
          {
            status: finalStatus,
            summary: finalSummary,
            steps: finalSteps,
            executedAt: new Date().toISOString(),
          },
          owner,
        );
        response.json({ ok: true, deployment: updated, preflight: { passed: true } });
      } catch (error) {
        const failed = markStep(
          runningSteps,
          'board-passport',
          'failed',
          'The read-only board probe failed; no model or actuator action was attempted.',
        );
        await updateSim2RealDeployment(
          id,
          {
            status: 'failed',
            summary: '板端只读预检失败；未执行模型下发或电机动作。',
            steps: failed,
          },
          owner,
        ).catch(() => null);
        sendInternalApiError(response, error, {
          code: 'SIM2REAL_PREFLIGHT_FAILED',
          message: '板端只读预检失败，请检查设备连接后重试。',
          messageEn: 'The read-only board preflight failed. Check the device connection and retry.',
          request,
          scope: 'sim2real-preflight',
        });
      }
    }),
  );

  return router;
}
