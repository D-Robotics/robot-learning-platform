import { Router, type Request, type Response } from 'express';

import type { Device } from '../../shared/types.js';
import type {
  Sim2RealDeploymentMode,
  Sim2RealDeploymentRecord,
  Sim2RealDeploymentStep,
  Sim2RealAvailableContract,
  Sim2RealModelManifest,
  Sim2RealModelRecord,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealRunBackend,
  Sim2RealRunRecord,
  Sim2RealRunStatus,
} from '../../shared/sim2real.js';
import {
  MICRODUCK_SIM2REAL_CONTRACT,
  normalizeTrainingSpec,
  SIM2REAL_PRODUCT_PROFILES,
  SIM2REAL_SCHEMA_VERSION,
  SAFE_ARTIFACT_REF,
  type Sim2RealCheckpointRef,
  type Sim2RealTrainingSpec,
  type Sim2RealRobotId,
  validateSim2RealManifest,
} from '../../shared/sim2real.js';
import { sendApiError, sendInternalApiError, wrapAsync } from '../sim2real/http-helpers.js';
import {
  buildBoardPreflightCommand,
  isForeignOwnedDevice,
  readDevices,
  requestOwnsDevice,
} from '../sim2real/standalone-adapters.js';
import {
  compatibilityForManifest,
  compatibilityForPlatforms,
  deploymentStepsFor,
  probeLocalTrainingWorker,
  probeRobogoIntegration,
  publicDeviceSummary,
  simulatorIntegration,
  storageIntegration,
  supportedRdkPlatforms,
} from '../sim2real/sim2real-service.js';
import {
  createSim2RealDeploymentWithResult,
  createSim2RealModel,
  createSim2RealRun,
  findSim2RealRunByIdempotency,
  reserveSim2RealRun,
  getSim2RealRun,
  getSim2RealDeployment,
  getSim2RealModel,
  listSim2RealDeployments,
  listSim2RealModels,
  listSim2RealRuns,
  sim2RealActiveRunLimit,
  updateSim2RealRun,
  updateSim2RealRunForReconcile,
  updateSim2RealDeployment,
  sim2RealStorageInfo,
} from '../sim2real/sim2real-store.js';
import { requestLocalTraining, requestLocalTrainingStatus } from '../sim2real/local-runner.js';
import {
  isSim2RealRunnerNotFound,
  isSim2RealRunnerOutcomeUnknown,
  requestRobogoTraining,
  requestRobogoTrainingStatus,
} from '../sim2real/robogo-runner.js';
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
  ) => Promise<{ device: unknown; output: string; exitCode?: number; mock?: boolean; actuatorControl?: boolean } | null>;

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
  if (id && (!/^[^\u0000-\u001f\u007f]{1,160}$/.test(id) || id.includes('/'))) {
    noStore(response);
    sendApiError(response, 401, 'SIM2REAL_AUTH_INVALID', '当前登录账号标识无效，请重新登录', {
      retryable: false,
    });
    return null;
  }
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

const SAFE_IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

function requestIdempotencyKey(
  request: Request,
  body: Record<string, unknown>,
): { key?: string; error?: string } {
  const headerValue = request.headers['idempotency-key'];
  const header = Array.isArray(headerValue) ? headerValue.join(',') : String(headerValue ?? '').trim();
  const bodyValue = body.idempotencyKey == null ? '' : String(body.idempotencyKey).trim();
  if (header && !SAFE_IDEMPOTENCY_KEY.test(header)) return { error: 'Idempotency-Key 格式无效' };
  if (bodyValue && !SAFE_IDEMPOTENCY_KEY.test(bodyValue)) return { error: 'idempotencyKey 格式无效' };
  if (header && bodyValue && header !== bodyValue) {
    return { error: 'Idempotency-Key 请求头与 body.idempotencyKey 不一致' };
  }
  return { key: header || bodyValue || undefined };
}

function runRequestFingerprint(input: {
  modelId: string;
  backend: Sim2RealRunBackend;
  taskId?: string;
  training?: Sim2RealTrainingSpec;
  resumeFrom?: Sim2RealCheckpointRef;
}): string {
  return JSON.stringify({
    modelId: input.modelId,
    backend: input.backend,
    taskId: input.taskId || null,
    training: input.training || null,
    resumeFrom: input.resumeFrom || null,
  });
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
  if (!SAFE_ARTIFACT_REF.test(artifactRef)) {
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

async function visibleDevices(
  owner: string | undefined,
  multiUser = false,
): Promise<OwnedDevice[]> {
  const devices = (await readDevices()) as OwnedDevice[];
  const key = ownerKey(owner);
  return devices.filter((device) => !isForeignOwnedDevice(device, key, multiUser));
}

function findVisibleDevice(devices: readonly OwnedDevice[], id: string): OwnedDevice | null {
  const wanted = id.trim();
  return devices.find((device) => device.id === wanted) ?? null;
}

/**
 * Keep product/contract provenance explicit at the API boundary.  The JSON
 * ledger intentionally stores the manifest as the source of truth, so these
 * denormalized fields are derived on read and remain compatible with older
 * rows that predate the fields.
 */
function publicModel(model: Sim2RealModelRecord): Sim2RealModelRecord {
  return {
    ...model,
    productId: model.manifest.robot.id,
    contractId: model.manifest.contract.id,
  };
}

function publicRun(
  run: Sim2RealRunRecord,
  models: readonly Sim2RealModelRecord[],
): Sim2RealRunRecord {
  const model = models.find((item) => item.id === run.modelId);
  return {
    ...run,
    ...(model
      ? {
          productId: model.manifest.robot.id,
          contractId: model.manifest.contract.id,
        }
      : {}),
  };
}

function publicDeployment(
  deployment: Sim2RealDeploymentRecord,
  models: readonly Sim2RealModelRecord[],
): Sim2RealDeploymentRecord & { productId?: Sim2RealRobotId; contractId?: string } {
  const model = models.find((item) => item.id === deployment.modelId);
  return {
    ...deployment,
    ...(model
      ? {
          productId: model.manifest.robot.id,
          contractId: model.manifest.contract.id,
        }
      : {}),
  };
}

function availableContractsFor(
  models: readonly Sim2RealModelRecord[],
): {
  availableContracts: Sim2RealAvailableContract[];
  contracts: Record<Sim2RealRobotId, Sim2RealAvailableContract[]>;
} {
  const grouped: Record<Sim2RealRobotId, Sim2RealAvailableContract[]> = {
    microduck: [],
    'rdk-duck': [],
  };
  const byKey = new Map<string, Sim2RealAvailableContract>();
  for (const model of models) {
    const productId = model.manifest.robot.id;
    const contract = model.manifest.contract;
    const key = `${productId}:${contract.id}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.modelIds.includes(model.id)) existing.modelIds.push(model.id);
      // A built-in reference is the canonical source even when a user has
      // also registered a manifest for the same fixed MicroDuck contract.
      if (model.builtin) existing.source = 'builtin';
      continue;
    }
    const item: Sim2RealAvailableContract = {
      productId,
      contractId: contract.id,
      contract: {
        ...contract,
        observationLayout: contract.observationLayout.map((entry) => ({ ...entry })),
      },
      modelIds: [model.id],
      source: model.builtin ? 'builtin' : 'manifest',
    };
    byKey.set(key, item);
    grouped[productId].push(item);
  }
  return {
    availableContracts: [...grouped.microduck, ...grouped['rdk-duck']],
    contracts: grouped,
  };
}

function validationPayload(input: unknown, platforms: readonly string[]) {
  const validation = validateSim2RealManifest(input);
  return {
    validation,
    ...(validation.manifest
      ? {
          productId: validation.manifest.robot.id,
          contractId: validation.manifest.contract.id,
        }
      : {}),
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
  if (message === 'sim2real_storage_unavailable') {
    sendApiError(
      response,
      503,
      'SIM2REAL_STORAGE_UNAVAILABLE',
      'sim2real 台账当前不可读或不可写；为避免覆盖已有数据，服务已停止本次操作。',
      { retryable: true },
    );
    return;
  }
  if (message === 'sim2real_storage_quota_exceeded') {
    sendApiError(
      response,
      507,
      'SIM2REAL_STORAGE_QUOTA_EXCEEDED',
      'sim2real 台账已达到单实例大小上限，请迁移到对象存储 adapter 后再继续写入。',
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
  if (
    message === 'sim2real_model_quota_exceeded' ||
    message === 'sim2real_run_quota_exceeded' ||
    message === 'sim2real_deployment_quota_exceeded'
  ) {
    sendApiError(
      response,
      507,
      'SIM2REAL_LEDGER_QUOTA_EXCEEDED',
      'sim2real 台账记录已达到单实例上限，请迁移到数据库或对象存储 adapter 后再继续。',
      { retryable: false },
    );
    return;
  }
  if (message === 'sim2real_run_idempotency_conflict') {
    sendApiError(
      response,
      409,
      'SIM2REAL_IDEMPOTENCY_CONFLICT',
      'Idempotency-Key 已用于另一份运行请求，请更换 key。',
      { retryable: false },
    );
    return;
  }
  if (message === 'sim2real_telemetry_idempotency_conflict') {
    sendApiError(
      response,
      409,
      'SIM2REAL_TELEMETRY_IDEMPOTENCY_CONFLICT',
      '遥测 Idempotency-Key 已用于另一份数据，请更换 key。',
      { retryable: false },
    );
    return;
  }
  if (message === 'sim2real_telemetry_timestamp_order') {
    sendApiError(
      response,
      409,
      'SIM2REAL_TELEMETRY_TIMESTAMP_ORDER',
      '遥测分片时间戳必须按序连续；请检查 sequence 或从上一个分片的末尾继续上传。',
      { retryable: false },
    );
    return;
  }
  if (message === 'sim2real_telemetry_quota_exceeded') {
    sendApiError(
      response,
      413,
      'SIM2REAL_TELEMETRY_QUOTA_EXCEEDED',
      '该运行或账号的遥测配额已用尽；请分段导出、清理旧数据，或迁移到对象存储 adapter。',
      { retryable: false },
    );
    return;
  }
  if (message === 'sim2real_active_run_quota_exceeded') {
    response.setHeader('Retry-After', '30');
    sendApiError(
      response,
      429,
      'SIM2REAL_ACTIVE_RUN_QUOTA_EXCEEDED',
      '当前账号已有过多排队或运行中的训练任务，请等待任务完成后再提交。',
      { retryable: true, retryAfterSeconds: 30 },
    );
    return;
  }
  if (message === 'sim2real_deployment_idempotency_conflict') {
    sendApiError(
      response,
      409,
      'SIM2REAL_DEPLOYMENT_IDEMPOTENCY_CONFLICT',
      '部署 Idempotency-Key 已用于另一份计划，请更换 key。',
      { retryable: false },
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
  return buildBoardPreflightCommand();
}

const PREFLIGHT_BEGIN = '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__';
const PREFLIGHT_END = '__STUDIO_SIM2REAL_PREFLIGHT_END__';
const PREFLIGHT_MIN_DISK_BYTES = 100 * 1024 * 1024;

type PreflightCheck = {
  arch: string;
  kernel: string;
  python3: string;
  tros: string;
  diskBytes: number | null;
};

function parsePreflightOutput(output: string): { checks: PreflightCheck; valid: boolean; reason: string } {
  const text = String(output ?? '');
  const begin = text.indexOf(PREFLIGHT_BEGIN);
  const end = text.indexOf(PREFLIGHT_END, begin + PREFLIGHT_BEGIN.length);
  const empty: PreflightCheck = {
    arch: '',
    kernel: '',
    python3: '',
    tros: '',
    diskBytes: null,
  };
  if (begin < 0 || end < 0 || end <= begin) {
    return { checks: empty, valid: false, reason: '板端预检缺少完整的协议标记。' };
  }
  const fields = new Map<string, string>();
  for (const line of text.slice(begin + PREFLIGHT_BEGIN.length, end).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const checks: PreflightCheck = {
    arch: fields.get('arch') || '',
    kernel: fields.get('kernel') || '',
    python3: fields.get('python3') || '',
    tros: fields.get('tros') || '',
    diskBytes: Number.isFinite(Number(fields.get('disk_bytes')))
      ? Number(fields.get('disk_bytes'))
      : null,
  };
  const archOk = /^(?:aarch64|arm64)$/i.test(checks.arch);
  const kernelOk = /^[^\u0000\r\n]{1,160}$/.test(checks.kernel);
  const pythonOk = /^\/[^\s\u0000\r\n]+$/.test(checks.python3);
  const trosOk = checks.tros === 'present';
  const diskOk = checks.diskBytes !== null && checks.diskBytes >= PREFLIGHT_MIN_DISK_BYTES;
  if (!archOk || !kernelOk || !pythonOk || !trosOk || !diskOk) {
    const missing = [
      !archOk ? 'aarch64/arm64 架构' : '',
      !kernelOk ? 'kernel' : '',
      !pythonOk ? 'python3' : '',
      !trosOk ? 'TROS/ROS' : '',
      !diskOk ? '至少 100MiB 可用磁盘' : '',
    ].filter(Boolean);
    return {
      checks,
      valid: false,
      reason: `板端预检未满足：${missing.join('、')}。`,
    };
  }
  return { checks, valid: true, reason: '板端预检协议和基础环境检查通过。' };
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

export const SIM2REAL_API_PREFIX = '/api/sim2real';
export const SIM2REAL_VERSIONED_API_PREFIX = '/api/v1/duck';

export interface Sim2RealRouterOptions {
  /**
   * API prefix used by this router instance.  The default remains the legacy
   * `/api/sim2real` surface; standalone deployments also mount the stable
   * `/api/v1/duck` alias from the same router factory so there is one business
   * implementation and no drift between clients.
   */
  prefix?: string;
}

function normalizeApiPrefix(value: string | undefined): string {
  const prefix = String(value ?? SIM2REAL_API_PREFIX).trim();
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(prefix)) {
    throw new Error(`Invalid Sim2Real API prefix: ${prefix}`);
  }
  return prefix;
}

export function createSim2RealRouter(
  deps: { runOnDevice?: RunOnDevice; auth?: Sim2RealAuthPort } = {},
  options: Sim2RealRouterOptions = {},
): Router {
  const router = Router();
  const prefix = normalizeApiPrefix(options.prefix);
  const api = (suffix: string): string => `${prefix}${suffix}`;
  const auth = deps.auth ?? LOCAL_SIM2REAL_AUTH;
  const visibleDevicesForAuth = (owner?: string) =>
    visibleDevices(owner, auth.isMultiUserDeployment());

  router.get(
    api('/overview'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const principal = auth.resolvePrincipal(request);
      const selectedProductId = requestedProduct(request.query.productId);
      noStore(response);
      const simulator = simulatorIntegration();
      const [models, runs, deployments, devices, robogo, localWorker] = await Promise.all([
        listSim2RealModels(owner),
        listSim2RealRuns(owner),
        listSim2RealDeployments(owner),
        visibleDevicesForAuth(owner),
        probeRobogoIntegration(
          String(auth.resolvePrincipal(request)?.accountId ?? owner ?? ''),
          auth.resolveAccessToken(request),
          { multiUser: auth.isMultiUserDeployment() },
        ),
        probeLocalTrainingWorker(simulator.local),
      ]);
      const contractRegistry = availableContractsFor(models);
      const selectedContracts = contractRegistry.contracts[selectedProductId];
      // MicroDuck has one fixed, built-in contract.  RDK Duck is
      // manifest-defined: expose a contract only when the account has a
      // registered model and there is no ambiguity between multiple IDs.
      const selectedContract =
        selectedProductId === 'microduck'
          ? MICRODUCK_SIM2REAL_CONTRACT
          : selectedContracts.length === 1
            ? selectedContracts[0].contract
            : null;
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
        selectedContract,
        availableContracts: contractRegistry.availableContracts,
        contracts: contractRegistry.contracts,
        // `contract` is retained solely for old MicroDuck clients. New
        // clients must use selectedContract/availableContracts because RDK
        // Duck does not inherit these dimensions.
        contract: MICRODUCK_SIM2REAL_CONTRACT,
        models: models.map(publicModel),
        runs: runs.map((run) => publicRun(run, models)),
        deployments: deployments.map((deployment) => publicDeployment(deployment, models)),
        devices: devices.map(publicDeviceSummary),
        integrations: {
          simulator: { ...simulator, local: localWorker },
          robogo,
          storage: storageIntegration(),
        },
        supportedPlatforms: supportedRdkPlatforms(),
      });
    }),
  );

  registerSim2RealTelemetryRoutes(
    router,
    {
      auth,
      requestOwner: (request, response) => requestOwner(request, response, auth),
      visibleDevices: visibleDevicesForAuth,
      storageError,
    },
    { prefix },
  );

  router.post(
    api('/models/validate'),
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
    api('/runs/:id'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const run = await getSim2RealRun(String(request.params.id || ''), owner);
      if (!run) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_RUN_NOT_FOUND',
          message: '运行记录不存在，或不属于当前账号。',
        });
        return;
      }
      let current = run;
      if (
        (run.backend === 'local' || run.backend === 'robogo') &&
        (run.status === 'queued' || run.status === 'running') &&
        run.externalRunId
      ) {
        const requestToken = auth.resolveAccessToken(request);
        if (run.backend === 'robogo' && auth.isMultiUserDeployment() && !requestToken) {
          sendApiError(
            response,
            401,
            'SIM2REAL_ROBOGO_TOKEN_REQUIRED',
            '共享部署需要当前账号的 RoboGo 短期令牌才能查询任务状态。',
            { retryable: false },
          );
          return;
        }
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
                    requestToken,
                    allowEnvironmentToken: !auth.isMultiUserDeployment(),
                    externalRunId: run.externalRunId,
                  });
            const update = {
              status: latest.status,
              ...(latest.message ? { summary: latest.message } : {}),
              ...(latest.mock ? { mock: true } : {}),
              ...(latest.checkpoint ? { checkpoint: latest.checkpoint } : {}),
              ...(latest.artifact ? { artifact: latest.artifact } : {}),
              ...(latest.metrics ? { metrics: latest.metrics } : {}),
              ...((latest.status === 'completed' || latest.status === 'failed') && !run.finishedAt
                ? { finishedAt: new Date().toISOString() }
                : {}),
            };
            current = (await updateSim2RealRun(run.id, update, owner)) ?? run;
          } catch (error) {
            if (isSim2RealRunnerNotFound(error)) {
              // The platform run still exists, but the remote job is
              // deterministically gone. Close the local reservation so it no
              // longer consumes the active-run quota; a transport timeout or
              // 5xx below remains retryable and keeps the last known state.
              try {
                const failed = await updateSim2RealRun(
                  run.id,
                  {
                    status: 'failed',
                    summary: 'runner 返回 404：远端任务不存在，平台已终止本地运行记录。',
                    finishedAt: new Date().toISOString(),
                  },
                  owner,
                );
                if (!failed) {
                  storageError(
                    request,
                    response,
                    new Error('sim2real_storage_unavailable'),
                    'sim2real-run-status-not-found',
                  );
                  return;
                }
                response.json({ ok: true, run: failed });
              } catch (updateError) {
                storageError(request, response, updateError, 'sim2real-run-status-not-found');
              }
              return;
            }
            // Preserve the last known queued/running state when the runner is
            // temporarily unreachable. Return an explicit retryable response
            // instead of inventing completion or silently polling forever.
            console.warn(
              `[sim2real] status lookup failed for ${run.id}`,
              error instanceof Error ? error.message : error,
            );
            const message = error instanceof Error ? error.message : String(error ?? '');
            if (
              message === 'sim2real_storage_not_configured' ||
              message === 'sim2real_storage_unavailable' ||
              message === 'sim2real_storage_quota_exceeded'
            ) {
              storageError(request, response, error, 'sim2real-run-status');
              return;
            }
            sendApiError(
              response,
              503,
              'SIM2REAL_RUN_STATUS_UNAVAILABLE',
              '训练 runner 暂时无法返回状态，请稍后重试。',
              { retryable: true, retryAfterSeconds: 15 },
            );
            return;
          }
        }
      }
      response.json({ ok: true, run: current });
    }),
  );

  /**
   * Recover the narrow crash window between a runner accepting a job and the
   * local ledger persisting its external id. This endpoint never launches or
   * retries a job: an operator must supply the runner id and an explicit
   * confirmation, then we perform a read-only status lookup and attach the
   * result atomically to the reserved run.
   */
  router.post(
    api('/runs/:id/reconcile'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const runId = String(request.params.id || '').trim();
      const run = await getSim2RealRun(runId, owner);
      if (!run) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_RUN_NOT_FOUND',
          message: '运行记录不存在，或不属于当前账号。',
        });
        return;
      }
      if (run.backend !== 'local' && run.backend !== 'robogo') {
        sendApiError(
          response,
          409,
          'SIM2REAL_RUN_NOT_RECONCILABLE',
          '只有本地或 RoboGo runner 任务需要对账。',
          { retryable: false },
        );
        return;
      }
      // Reconciliation exists only for the reservation crash window. A
      // terminal record without an external id is not a safe target: letting
      // callers attach an arbitrary runner id to it would make the audit
      // trail ambiguous and could associate a different job's artifacts.
      if (run.status !== 'queued' && run.status !== 'running') {
        sendApiError(
          response,
          409,
          'SIM2REAL_RUN_NOT_RECONCILABLE',
          '只有排队中或运行中的 runner 任务可以对账。',
          { retryable: false },
        );
        return;
      }
      if (run.externalRunId) {
        response.json({ ok: true, run, reconciled: false, message: '该任务已有 runner id。' });
        return;
      }
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const externalRunId = String(body.externalRunId ?? '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(externalRunId)) {
        sendApiError(
          response,
          400,
          'SIM2REAL_EXTERNAL_RUN_ID_INVALID',
          '请提供合法的 runner externalRunId。',
          { retryable: false },
        );
        return;
      }
      if (body.confirm !== true) {
        sendApiError(
          response,
          400,
          'SIM2REAL_RECONCILE_CONFIRM_REQUIRED',
          '对账不会启动新任务；请确认 externalRunId 属于该运行后再提交 confirm=true。',
          { retryable: false },
        );
        return;
      }
      const accountId = String(
        auth.resolvePrincipal(request)?.accountId ??
          owner ??
          (!auth.isMultiUserDeployment() ? 'local-dev' : ''),
      ).trim();
      if (!accountId) {
        sendApiError(response, 401, 'SIM2REAL_AUTH_REQUIRED', '当前会话没有可用账号。', {
          retryable: false,
        });
        return;
      }
      const requestToken = auth.resolveAccessToken(request);
      if (run.backend === 'robogo' && auth.isMultiUserDeployment() && !requestToken) {
        sendApiError(
          response,
          401,
          'SIM2REAL_ROBOGO_TOKEN_REQUIRED',
          '共享部署需要当前账号的 RoboGo 短期令牌才能查询任务状态。',
          { retryable: false },
        );
        return;
      }
      try {
        const latest =
          run.backend === 'local'
            ? await requestLocalTrainingStatus({
                accountId,
                externalRunId,
              })
            : await requestRobogoTrainingStatus({
                accountId,
                requestToken,
                allowEnvironmentToken: !auth.isMultiUserDeployment(),
                externalRunId,
              });
        if (latest.externalRunId && latest.externalRunId !== externalRunId) {
          sendApiError(
            response,
            502,
            'SIM2REAL_RECONCILE_ID_MISMATCH',
            'runner 返回的任务 id 与提交的 externalRunId 不一致，台账未修改。',
            { retryable: false },
          );
          return;
        }
        const update = {
          externalRunId,
          status: latest.status,
          ...(latest.message ? { summary: latest.message } : {}),
          ...(latest.mock ? { mock: true } : {}),
          ...(latest.checkpoint ? { checkpoint: latest.checkpoint } : {}),
          ...(latest.artifact ? { artifact: latest.artifact } : {}),
          ...(latest.metrics ? { metrics: latest.metrics } : {}),
          ...((latest.status === 'completed' || latest.status === 'failed')
            ? { finishedAt: new Date().toISOString() }
            : {}),
        };
        const updated = await updateSim2RealRunForReconcile(run.id, update, owner);
        if (!updated) {
          sendApiError(response, 409, 'SIM2REAL_RUN_RECONCILE_RACE', '运行记录已发生变化，请刷新后重试。', {
            retryable: true,
          });
          return;
        }
        response.json({ ok: true, reconciled: true, run: updated });
      } catch (error) {
        console.warn(
          `[sim2real] reconcile status lookup failed for ${run.id}`,
          error instanceof Error ? error.message : error,
        );
        if (isSim2RealRunnerNotFound(error)) {
          // A 404 proves only that the supplied external id is absent; do not
          // attach that arbitrary id to the local record. Mark the reserved
          // run terminal and release the active quota instead.
          try {
            const failed = await updateSim2RealRun(
              run.id,
              {
                status: 'failed',
                summary: '对账时 runner 返回 404：远端任务不存在，平台已终止本地运行记录。',
                finishedAt: new Date().toISOString(),
              },
              owner,
            );
            if (!failed) {
              storageError(
                request,
                response,
                new Error('sim2real_storage_unavailable'),
                'sim2real-run-reconcile-not-found',
              );
              return;
            }
            response.json({ ok: true, reconciled: false, terminal: true, run: failed });
          } catch (updateError) {
            storageError(request, response, updateError, 'sim2real-run-reconcile-not-found');
          }
          return;
        }
        // A runner failure and a ledger failure have different recovery
        // actions.  In particular, do not tell an operator to retry a
        // reconciliation when the local ledger is read-only/corrupt: that
        // would only create noisy retries and could hide the storage outage.
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (
          message === 'sim2real_storage_not_configured' ||
          message === 'sim2real_storage_unavailable' ||
          message === 'sim2real_storage_quota_exceeded'
        ) {
          storageError(request, response, error, 'sim2real-run-reconcile');
          return;
        }
        sendApiError(
          response,
          503,
          'SIM2REAL_RUN_RECONCILE_UNAVAILABLE',
          'runner 暂时无法返回对账状态，台账未修改。',
          { retryable: true, retryAfterSeconds: 15 },
        );
      }
    }),
  );

  router.post(
    api('/models'),
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
          .json({
            ok: true,
            model: publicModel(model),
            productId: model.manifest.robot.id,
            contractId: model.manifest.contract.id,
            compatibility: compatibilityForPlatforms(model.manifest),
          });
      } catch (error) {
        storageError(request, response, error, 'sim2real-model-create');
      }
    }),
  );

  router.get(
    api('/models/:id'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const model = await getSim2RealModel(String(request.params.id || ''), owner);
      if (!model) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_MODEL_NOT_FOUND',
          message: '模型制品不存在，或不属于当前账号。',
        });
        return;
      }
      response.json({
        ok: true,
        model: publicModel(model),
        productId: model.manifest.robot.id,
        contractId: model.manifest.contract.id,
        compatibility: compatibilityForPlatforms(model.manifest),
      });
    }),
  );

  router.post(
    api('/runs'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const idempotency = requestIdempotencyKey(request, body);
      if (idempotency.error) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_IDEMPOTENCY_KEY', idempotency.error, {
          retryable: false,
        });
        return;
      }
      const idempotencyKey = idempotency.key;
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
      if ((backend === 'local' || backend === 'robogo') && !idempotencyKey) {
        sendApiError(
          response,
          400,
          'SIM2REAL_IDEMPOTENCY_REQUIRED',
          'local / RoboGo 训练必须提供 Idempotency-Key，避免网络重试重复启动或计费。',
          { retryable: false },
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
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_MODEL_NOT_FOUND',
          message: '模型制品不存在，或不属于当前账号。',
        });
        return;
      }
      const requestFingerprint = runRequestFingerprint({
        modelId: model.id,
        backend,
        taskId: taskId || undefined,
        training,
        resumeFrom,
      });
      if (idempotencyKey) {
        const existing = await findSim2RealRunByIdempotency(idempotencyKey, owner);
        if (existing) {
          if (
            existing.requestFingerprint &&
            existing.requestFingerprint !== requestFingerprint
          ) {
            sendApiError(
              response,
              409,
              'SIM2REAL_IDEMPOTENCY_CONFLICT',
              'Idempotency-Key 已用于另一份运行请求，请更换 key。',
              { retryable: false },
            );
            return;
          }
          response.status(200).json({ ok: true, run: existing.run, idempotentReplay: true });
          return;
        }
      }
      const browserSupported = model.manifest.simulator.backends.includes('browser');
      const robogoSupported = model.manifest.simulator.backends.includes('robogo');
      const localSupported = model.manifest.simulator.backends.includes('local');
      const integrations = simulatorIntegration();
      const robogoRunnerAvailable = integrations.robogo.available;
      const localRunnerAvailable = integrations.local.available;
      const isBuiltin = model.builtin === true;
      const now = new Date().toISOString();
      if ((backend === 'local' || backend === 'robogo') && !sim2RealStorageInfo().writable) {
        storageError(
          request,
          response,
          new Error('sim2real_storage_not_configured'),
          'sim2real-run-preflight',
        );
        return;
      }
      let status: Sim2RealRunStatus = 'blocked';
      let summary = '';
      let launchUrl: string | undefined;
      let externalRunId: string | undefined;
      let mock = false;
      let checkpoint: Sim2RealCheckpointRef | undefined;
      let artifact: Sim2RealRunArtifactMetadata | undefined;
      let metrics: Sim2RealRunMetrics | undefined;
      let reservedRun: Sim2RealRunRecord | undefined;

      // Reserve before any external side effect.  The reservation is an
      // atomic ledger operation, so concurrent retries carrying the same key
      // cannot both reach RoboGo/local runner and accidentally start two jobs.
      if (idempotencyKey) {
        try {
          const reservation = await reserveSim2RealRun(
            {
              modelId: model.id,
              ...(taskId ? { taskId } : {}),
              backend,
              status: 'queued',
              summary:
                backend === 'robogo'
                  ? 'RoboGo 训练请求已受理，正在联系 runner。'
                  : backend === 'local'
                    ? '本地训练请求已受理，正在联系 runner。'
                    : '运行请求已受理，正在准备结果。',
              ...(training ? { training } : {}),
              ...(resumeFrom ? { resumeFrom } : {}),
            },
            owner,
            {
              idempotencyKey,
              requestFingerprint,
              maxActiveRuns:
                backend === 'local' || backend === 'robogo' ? sim2RealActiveRunLimit() : undefined,
            },
          );
          if (!reservation.created) {
            response.setHeader('Idempotency-Key', idempotencyKey);
            response.status(200).json({
              ok: true,
              run: reservation.run,
              idempotentReplay: true,
            });
            return;
          }
          reservedRun = reservation.run;
        } catch (error) {
          storageError(request, response, error, 'sim2real-run-reservation');
          return;
        }
      }
      if (backend === 'contract') {
        status = 'completed';
        summary = '模型契约校验完成；这一步不运行模型，也不接触设备。';
        metrics = {
          contractValid: true,
          observationSize: model.manifest.contract.observationSize,
          actionSize: model.manifest.contract.actionSize,
        };
      } else if (
        backend === 'browser' &&
        browserSupported &&
        isBuiltin &&
        integrations.browser.available
      ) {
        status = 'ready';
        summary = '官方参考策略已准备好在浏览器 MicroDuck 仿真中运行。';
        // Use the integration's public entry so a reverse-proxy prefix such
        // as /sim2real is preserved for API/CLI consumers as well as the SPA.
        launchUrl = integrations.browser.entryUrl || model.manifest.simulator.entryUrl || '/mujoco/microduck/';
      } else if (backend === 'browser' && browserSupported && isBuiltin) {
        status = 'blocked';
        summary = integrations.browser.reason || '浏览器 MicroDuck 仿真资源尚未挂载。';
      } else if (backend === 'browser' && browserSupported) {
        status = 'blocked';
        summary = '该用户模型已登记，但当前网页仿真仍使用固定官方策略，尚未允许动态替换制品。';
      } else if (backend === 'robogo' && robogoSupported && robogoRunnerAvailable) {
        const accountId = String(
          auth.resolvePrincipal(request)?.accountId ??
            owner ??
            (!auth.isMultiUserDeployment() ? 'local-dev' : ''),
        ).trim();
        const requestToken = auth.resolveAccessToken(request);
        if (!accountId) {
          status = 'queued';
          summary = 'RoboGo runner 已配置，但当前会话没有可用账号；任务只登记，未启动训练。';
        } else if (auth.isMultiUserDeployment() && !requestToken) {
          status = 'blocked';
          summary = '共享部署未收到当前账号的 RoboGo 短期令牌；任务只登记，未向 runner 发送请求。';
        } else {
          try {
            const launched = await requestRobogoTraining({
              accountId,
              requestToken,
              allowEnvironmentToken: !auth.isMultiUserDeployment(),
              manifest: model.manifest,
              training,
              resumeFrom,
              taskId: taskId || undefined,
              idempotencyKey,
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
          } catch (error) {
            // A timeout/connection reset is ambiguous: the runner may have
            // accepted the job even though its response never reached us.
            // Keep only that class of failure queued so an operator can
            // reconcile the external id instead of making a duplicate retry.
            if (isSim2RealRunnerOutcomeUnknown(error)) {
              status = 'queued';
              summary =
                'RoboGo runner 请求结果未确认；任务保留排队状态以避免重复计费。若 runner 可能已受理，请确认 externalRunId 后使用对账接口。';
            } else {
              status = 'failed';
              summary = 'RoboGo runner 拒绝或无法启动训练；不会自动重试，避免重复计费。';
            }
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
              idempotencyKey,
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
          } catch (error) {
            // Treat only transport/ambiguous responses as outcome-unknown;
            // deterministic configuration or 4xx rejection can be terminal.
            if (isSim2RealRunnerOutcomeUnknown(error)) {
              status = 'queued';
              summary =
                '本地训练 runner 请求结果未确认；任务保留排队状态以避免重复启动。若 worker 可能已受理，请确认 externalRunId 后使用对账接口。';
            } else {
              status = 'failed';
              summary = '本地训练 runner 拒绝或无法启动训练；不会自动重试。';
            }
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
        const finalRunInput = {
          status,
          summary,
          ...(launchUrl ? { launchUrl } : {}),
          ...(externalRunId ? { externalRunId } : {}),
          ...(mock ? { mock: true } : {}),
          ...(checkpoint ? { checkpoint } : {}),
          ...(artifact ? { artifact } : {}),
          ...(metrics ? { metrics } : {}),
          ...(status === 'completed' || status === 'failed' ? { finishedAt: now } : {}),
        };
        const run = reservedRun
          ? await updateSim2RealRun(reservedRun.id, finalRunInput, owner)
          : await createSim2RealRun(
              {
                modelId: model.id,
                ...(taskId ? { taskId } : {}),
                backend,
                ...finalRunInput,
                ...(training ? { training } : {}),
                ...(resumeFrom ? { resumeFrom } : {}),
              },
              owner,
              { idempotencyKey, requestFingerprint },
            );
        if (!run) throw new Error('sim2real_run_reservation_lost');
        if (idempotencyKey) response.setHeader('Idempotency-Key', idempotencyKey);
        response.status(201).json({ ok: true, run });
      } catch (error) {
        storageError(request, response, error, 'sim2real-run-create');
      }
    }),
  );

  router.post(
    api('/deployments'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const idempotency = requestIdempotencyKey(request, body);
      if (idempotency.error) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_DEPLOYMENT', idempotency.error, {
          retryable: false,
        });
        return;
      }
      const idempotencyKey = idempotency.key;
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
      if ((mode === 'canary' || mode === 'live') && !idempotencyKey) {
        sendApiError(
          response,
          400,
          'SIM2REAL_IDEMPOTENCY_REQUIRED',
          'Canary / Live 部署计划必须提供 Idempotency-Key，避免重复下发。',
          { retryable: false },
        );
        return;
      }
      const model = await getSim2RealModel(modelId, owner);
      if (!model) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_MODEL_NOT_FOUND',
          message: '模型制品不存在，或不属于当前账号。',
        });
        return;
      }
      const devices = await visibleDevicesForAuth(owner);
      const device = findVisibleDevice(devices, deviceId);
      if (
        !device ||
        !requestOwnsDevice(
          request,
          device,
          owner ? `sso:${owner}:web` : null,
          auth.isMultiUserDeployment(),
        )
      ) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_DEVICE_NOT_FOUND',
          message: '设备不存在，或不属于当前账号。',
        });
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
      const requestFingerprint = JSON.stringify({ modelId: model.id, deviceId: device.id, mode });
      try {
        const created = await createSim2RealDeploymentWithResult(deployment, owner, {
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(idempotencyKey ? { requestFingerprint } : {}),
        });
        if (idempotencyKey) response.setHeader('Idempotency-Key', idempotencyKey);
        response.status(created.duplicate ? 200 : 201).json({
          ok: true,
          deployment: created.deployment,
          ...(created.duplicate ? { idempotentReplay: true } : {}),
        });
      } catch (error) {
        storageError(request, response, error, 'sim2real-deployment-create');
      }
    }),
  );

  router.get(
    api('/deployments/:id'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const deployment = await getSim2RealDeployment(String(request.params.id || ''), owner);
      if (!deployment) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_DEPLOYMENT_NOT_FOUND',
          message: '部署计划不存在，或不属于当前账号。',
        });
        return;
      }
      response.json({ ok: true, deployment });
    }),
  );

  router.post(
    api('/deployments/:id/preflight'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const id = String(request.params.id || '').trim();
      const deployment = await getSim2RealDeployment(id, owner);
      if (!deployment) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_DEPLOYMENT_NOT_FOUND',
          message: '部署计划不存在，或不属于当前账号。',
        });
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
      const devices = await visibleDevicesForAuth(owner);
      const device = findVisibleDevice(devices, deployment.deviceId);
      if (
        !device ||
        !requestOwnsDevice(
          request,
          device,
          owner ? `sso:${owner}:web` : null,
          auth.isMultiUserDeployment(),
        )
      ) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_DEVICE_NOT_FOUND',
          message: '设备不存在，或不属于当前账号。',
        });
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
          response.status(503).json({
            ok: false,
            error: 'SIM2REAL_DEVICE_RUNNER_UNAVAILABLE',
            message: '板端只读预检未返回结果；未执行模型下发或电机动作。',
            retryable: true,
          });
          return;
        }
        const parsedPreflight = parsePreflightOutput(executed.output);
        const exitCode = executed.exitCode;
        if (!parsedPreflight.valid || (exitCode != null && exitCode !== 0)) {
          const detail =
            exitCode != null && exitCode !== 0
              ? `板端预检命令返回非零退出码（${exitCode}）。`
              : parsedPreflight.reason;
          const blockedSteps = markStep(runningSteps, 'board-passport', 'blocked', detail);
          await updateSim2RealDeployment(
            id,
            {
              status: 'blocked',
              summary: '板端只读预检未通过；未执行模型下发或电机动作。',
              steps: blockedSteps,
            },
            owner,
          ).catch(() => null);
          response.status(409).json({
            ok: false,
            error: 'SIM2REAL_PREFLIGHT_NOT_READY',
            message: detail,
            retryable: true,
            preflight: { passed: false, checks: parsedPreflight.checks },
          });
          return;
        }
        if (executed.mock === true) {
          const detail = '当前返回来自模拟 BoardAgent；协议已验证，但不是真机预检证据。';
          const blockedSteps = markStep(runningSteps, 'board-passport', 'blocked', detail);
          await updateSim2RealDeployment(
            id,
            {
              status: 'blocked',
              summary: '模拟 BoardAgent 只能演练协议，不能把部署计划标记为真机就绪。',
              steps: blockedSteps,
            },
            owner,
          ).catch(() => null);
          sendApiError(response, 409, 'SIM2REAL_PREFLIGHT_MOCK_ONLY', detail, {
            retryable: false,
            preflight: { passed: false, mock: true, checks: parsedPreflight.checks },
          });
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
