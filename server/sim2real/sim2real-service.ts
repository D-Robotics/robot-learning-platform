import fs from 'node:fs';
import path from 'node:path';

import type { Device } from '../../shared/types.js';
import { ALL_RDK_PLATFORMS, type RdkPlatform } from '../../shared/board-types.js';
import type { ModelArtifactDescriptor } from '../../shared/model-artifacts.js';
import {
  SIM2REAL_PRODUCT_PROFILES,
  type Sim2RealCompatibilityView,
  type Sim2RealDeploymentStep,
  type Sim2RealDeviceSummary,
  type Sim2RealModelManifest,
  type Sim2RealLocalWorkerIntegration,
  type Sim2RealRobogoIntegration,
} from '../../shared/sim2real.js';
import {
  collectSandboxBoards,
  createStandaloneRobogoApiClient,
  isBoardAgentConfigured,
  isStandaloneMultiUserMode,
} from './standalone-adapters.js';
import { evaluateModelCompatibility } from './standalone-compatibility.js';
import { sim2RealStorageInfo } from './sim2real-store.js';
import { isRobogoRunnerConfigured, normalizeRunnerUrl } from './robogo-runner.js';
import { isLocalRunnerConfigured } from './local-runner.js';

function publicPath(pathname: string): string {
  const rawBase = String(process.env.RDK_SIM2REAL_PUBLIC_BASE_PATH ?? '').trim();
  const base = rawBase && rawBase !== '/' ? `/${rawBase.replace(/^\/+|\/+$/g, '')}` : '';
  if (!base || !pathname.startsWith('/') || pathname.startsWith(`${base}/`)) return pathname;
  return `${base}${pathname}`;
}

/**
 * Compatibility is evaluated against the compiled policy first.  An ONNX
 * policy is valid for browser/RoboGo simulation but is never silently treated
 * as a board binary.
 */
export function compatibilityForManifest(
  manifest: Sim2RealModelManifest,
  platformId: string,
): Sim2RealCompatibilityView {
  const productProfile = SIM2REAL_PRODUCT_PROFILES[manifest.robot.id];
  if (productProfile && !productProfile.targetPlatforms.includes(platformId)) {
    const result = evaluateModelCompatibility(platformId, {
      name: 'product-target',
      kind: 'compiled',
      format: 'unknown',
    });
    return {
      platformId,
      status: 'incompatible',
      result: {
        ...result,
        status: 'incompatible',
        reasons: [
          `${productProfile.displayName} is registered for ${productProfile.targetPlatforms.join(', ')}; ${platformId} is outside this product target.`,
        ],
      },
      deployable: false,
      reason: `${productProfile.displayName} 当前只登记面向 ${productProfile.targetPlatforms.join('、')} 的板端目标。`,
    };
  }
  const candidates = manifest.artifacts
    .filter((artifact) => artifact.role === 'compiled-policy' || artifact.role === 'policy')
    .map((artifact) => ({
      artifact,
      result: evaluateModelCompatibility(platformId, artifact as ModelArtifactDescriptor),
    }));
  const compiled = candidates.filter((candidate) => candidate.artifact.role === 'compiled-policy');
  const source = candidates.filter((candidate) => candidate.artifact.role === 'policy');
  // A source ONNX artifact is useful for the conversion path, but must not hide
  // an exact compiled target that is incompatible or still missing metadata.
  // Prefer a deployable compiled artifact, then an inspectable compiled result,
  // and only then fall back to source conversion.
  const selected =
    compiled.find((candidate) => candidate.result.status === 'compatible') ??
    compiled.find((candidate) => candidate.result.status === 'needs-validation') ??
    source.find((candidate) => candidate.result.status === 'compatible') ??
    source.find((candidate) => candidate.result.status === 'requires-conversion') ??
    compiled[0] ??
    source[0];
  if (!selected) {
    const result = evaluateModelCompatibility(platformId, {
      name: 'missing-policy',
      kind: 'source',
      format: 'unknown',
    });
    return {
      platformId,
      status: result.status,
      result,
      deployable: false,
      reason: 'No policy artifact is available for this target.',
    };
  }
  const cpuOnnxLocomotion =
    platformId === 'rdk-x5' &&
    selected.artifact.role === 'policy' &&
    selected.artifact.runtime === 'cpu-onnx' &&
    selected.artifact.workload === 'locomotion' &&
    selected.artifact.threads === 1;
  const cpuOnnxMetadataCompatible =
    cpuOnnxLocomotion &&
    (!selected.artifact.targetPlatforms?.length ||
      selected.artifact.targetPlatforms.includes(platformId)) &&
    (!selected.artifact.toolchainTarget ||
      selected.artifact.toolchainTarget.trim() === platformId) &&
    (!selected.artifact.acceleratorArchitecture ||
      selected.artifact.acceleratorArchitecture.trim().toLowerCase() === 'bayes-e');
  // A locomotion ONNX policy is intentionally allowed to run on the X5 CPU
  // when the manifest opts into the one-thread runtime. The generic artifact
  // matrix treats ONNX as requiring BPU conversion, so promote only this
  // explicitly declared safe path to a compatible result.
  const selectedResult = cpuOnnxMetadataCompatible
    ? {
        ...selected.result,
        status: 'compatible' as const,
        reasons: [
          `CPU ONNX locomotion policy ${selected.artifact.name} explicitly declares one-thread execution.`,
        ],
      }
    : selected.result;
  const deployable =
    selectedResult.status === 'compatible' &&
    (selected.artifact.role === 'compiled-policy' || cpuOnnxMetadataCompatible);
  const reason = deployable
    ? cpuOnnxMetadataCompatible
      ? `Locomotion policy ${selected.artifact.name} runs as CPU ONNX with one thread on ${platformId}; BPU remains available for perception.`
      : `Compiled policy ${selected.artifact.name} matches ${platformId}.`
    : selectedResult.status === 'requires-conversion'
      ? `Policy ${selected.artifact.name} must be compiled for ${platformId} before board deployment.`
      : selectedResult.reasons[0] || `Policy is not ready for ${platformId}.`;
  return {
    platformId,
    status: selectedResult.status,
    artifactId: selected.artifact.id,
    result: selectedResult,
    deployable,
    reason,
    ...(selected.artifact.runtime ? { artifactRuntime: selected.artifact.runtime } : {}),
    ...(selected.artifact.workload ? { artifactWorkload: selected.artifact.workload } : {}),
  };
}

export function compatibilityForPlatforms(
  manifest: Sim2RealModelManifest,
  platforms: readonly string[] = ALL_RDK_PLATFORMS,
): Sim2RealCompatibilityView[] {
  const wanted = [...new Set(platforms.map((item) => String(item).trim()).filter(Boolean))];
  return (wanted.length ? wanted : ALL_RDK_PLATFORMS).map((platform) =>
    compatibilityForManifest(manifest, platform),
  );
}

export function deploymentStepsFor(
  compatibility: Sim2RealCompatibilityView,
): Sim2RealDeploymentStep[] {
  const cpuOnnxLocomotion = compatibility.artifactRuntime === 'cpu-onnx';
  return [
    {
      id: 'contract',
      label: 'Verify policy contract',
      status: 'completed',
      detail:
        'Manifest-defined observation/action shape and control loop are recorded for this product.',
    },
    {
      id: 'board-passport',
      label: 'Read board passport',
      status: 'pending',
      detail: 'Read-only SSH probe; no motor or service mutation',
    },
    {
      id: 'artifact',
      label: cpuOnnxLocomotion ? 'Stage CPU ONNX policy' : 'Stage compiled artifact',
      status: compatibility.deployable ? 'pending' : 'blocked',
      detail: compatibility.deployable
        ? cpuOnnxLocomotion
          ? 'Stage the managed ONNX locomotion policy; the board runtime must enforce one CPU thread.'
          : 'The exact board artifact can be staged after approval.'
        : compatibility.reason,
    },
    {
      id: 'checksum',
      label: 'Verify checksum and runtime',
      status: compatibility.deployable ? 'pending' : 'blocked',
      detail: 'The board agent must verify the declared SHA-256 and runtime package.',
    },
    {
      id: 'canary',
      label: 'Run no-motor canary',
      status: compatibility.deployable ? 'pending' : 'blocked',
      detail: 'A canary never enables actuators; live control remains a separate approval.',
    },
    {
      id: 'live',
      label: 'Enable live policy',
      status: 'blocked',
      detail: 'Live actuator control is not enabled by the Studio web page.',
    },
  ];
}

export function publicDeviceSummary(device: Device): Sim2RealDeviceSummary {
  return {
    id: device.id,
    name: String(device.name || `${device.username}@${device.host}`).slice(0, 120),
    status: String(device.status || 'offline').slice(0, 32),
    ...(device.boardPlatform ? { boardPlatform: device.boardPlatform } : { boardPlatform: null }),
    ...(device.boardModel ? { boardModel: device.boardModel } : { boardModel: null }),
    ...(device.connectionMode ? { connectionMode: device.connectionMode } : {}),
    ...(device.sshReachability ? { sshReachability: device.sshReachability } : {}),
  };
}

function countNamedArray(value: unknown, names: readonly string[]): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  for (const name of names) {
    if (Array.isArray(source[name])) return source[name].length;
  }
  for (const nested of Object.values(source)) {
    const count = countNamedArray(nested, names);
    if (count !== undefined) return count;
  }
  return undefined;
}

/** Probe only aggregate RoboGo state; raw payloads and SSH fields never cross this boundary. */
export async function probeRobogoIntegration(
  accountId: string,
  requestToken?: string | null,
  options: { multiUser?: boolean } = {},
): Promise<Sim2RealRobogoIntegration> {
  if (!accountId.trim()) {
    return {
      state: 'login_required',
      clusterQueried: false,
      devMachineQueried: false,
      message: 'Sign in to connect the Studio account to RoboGo.',
    };
  }
  let client: ReturnType<typeof createStandaloneRobogoApiClient>;
  try {
    const token = String(requestToken ?? '').trim();
    // The auth adapter is the source of truth for tenant mode.  Do not infer
    // whether a process-wide token is safe solely from deployment env flags:
    // an extracted service may inject a custom multi-user OIDC adapter while
    // retaining a local-looking deployment profile.
    const multiUser = options.multiUser ?? isStandaloneMultiUserMode();
    // A verified auth adapter may provide a short-lived request token. It is
    // used only for this call and is never persisted or returned to the UI.
    client = createStandaloneRobogoApiClient({
      requestToken: token || undefined,
      // A process-wide token is only permitted for a private local service.
      // Shared/trusted-proxy deployments must forward a verified, short-lived
      // token for the current account on every request.
      allowEnvironmentToken: !multiUser,
    });
  } catch {
    return {
      state: 'unavailable',
      clusterQueried: false,
      devMachineQueried: false,
      message: 'RoboGo is not configured for this Studio deployment.',
    };
  }
  const [cluster, machines] = await Promise.allSettled([
    client.request(accountId, {
      method: 'GET',
      path: '/api/artificerApi/rdk-sandbox/summary',
      timeoutMs: 12_000,
    }),
    client.request(accountId, {
      method: 'GET',
      path: '/api/artificerApi/devMachineApi/instances',
      timeoutMs: 12_000,
    }),
  ]);
  const clusterOk = cluster.status === 'fulfilled';
  const machinesOk = machines.status === 'fulfilled';
  if (!clusterOk && !machinesOk) {
    return {
      state: 'unavailable',
      clusterQueried: true,
      devMachineQueried: true,
      message: 'RoboGo is not reachable with the current Studio session.',
    };
  }
  const boardCount = clusterOk ? collectSandboxBoards(cluster.value).length : undefined;
  const machineCount = machinesOk
    ? countNamedArray(machines.value, ['instances', 'data', 'items', 'records', 'list'])
    : undefined;
  return {
    state: 'ready',
    clusterQueried: clusterOk,
    devMachineQueried: machinesOk,
    ...(boardCount === undefined ? {} : { availableBoardCount: boardCount }),
    ...(machineCount === undefined ? {} : { developmentMachineCount: machineCount }),
    message:
      'RoboGo account resources are visible. Starting compute still requires an explicit user action.',
  };
}

function microduckBrowserSurface(): {
  available: boolean;
  entryUrl: string;
  state: 'mounted' | 'redirect' | 'missing';
  reason: string;
} {
  const root = String(process.env.RDK_SIM2REAL_MICRODUCK_ROOT ?? '').trim();
  if (root && path.isAbsolute(root) && fs.existsSync(path.join(root, 'index.html'))) {
    return {
      available: true,
      entryUrl: publicPath('/mujoco/microduck/'),
      state: 'mounted',
      reason: 'MicroDuck 静态仿真资源已挂载。',
    };
  }
  const rawUrl = String(process.env.RDK_SIM2REAL_MICRODUCK_URL ?? '').trim();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      if (
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash &&
        (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
      ) {
        return {
          available: true,
          entryUrl: parsed.toString(),
          state: 'redirect',
          reason: 'MicroDuck 由独立仿真服务提供。',
        };
      }
    } catch {
      // Fall through to the explicit missing state.
    }
  }
  return {
    available: false,
    entryUrl: publicPath('/mujoco/microduck/'),
    state: 'missing',
    reason: 'MicroDuck 静态资源未挂载；请配置 RDK_SIM2REAL_MICRODUCK_ROOT 或 URL。',
  };
}

export function simulatorIntegration(): {
  browser: {
    available: boolean;
    entryUrl: string;
    state: 'mounted' | 'redirect' | 'missing';
    reason: string;
  };
  boardAgent: { available: boolean; reason: string };
  robogo: { available: boolean; reason: string };
  local: Sim2RealLocalWorkerIntegration;
} {
  const runnerConfigured = isRobogoRunnerConfigured();
  const localRunnerConfigured = isLocalRunnerConfigured();
  const localRunnerMock = process.env.RDK_SIM2REAL_LOCAL_RUNNER_MODE === 'mock';
  const boardAgentConfigured = isBoardAgentConfigured();
  return {
    browser: microduckBrowserSurface(),
    boardAgent: {
      available: boardAgentConfigured,
      reason: boardAgentConfigured
        ? '受控 BoardAgent 已配置；当前仅允许只读板端预检，模拟 agent 不会产生真机就绪证据。'
        : '公开发行版未注入 BoardAgent；板型探测和真机执行保持只读占位。',
    },
    robogo: {
      available: runnerConfigured,
      reason: runnerConfigured
        ? 'A RoboGo runner adapter is configured for this deployment.'
        : 'The RoboGo runner adapter is not configured; the Studio will not start a billable machine automatically.',
    },
    local: {
      available: localRunnerConfigured,
      reachable: false,
      healthy: false,
      configured: localRunnerConfigured,
      reason: localRunnerConfigured
        ? localRunnerMock
          ? '本地 Mock worker 已连接：无 CUDA，仅用于契约与流程演练，不生成可部署模型。'
          : 'A local training runner is configured for this deployment.'
        : 'The local training runner is not configured; configure an internal worker endpoint first.',
      message: localRunnerConfigured
        ? localRunnerMock
          ? '本地 Mock worker 已配置，待健康检查。'
          : '本地训练 worker 已配置，待健康检查。'
        : '本地训练 worker 未配置。',
      ...(localRunnerMock ? { mock: true } : {}),
    },
  };
}

function localWorkerHealthUrl(raw?: string): string | null {
  const value = String(raw ?? process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL ?? '').trim();
  if (!value || !isLocalRunnerConfigured(value)) return null;
  try {
    const parsed = new URL(normalizeRunnerUrl(value, { localHttp: true }));
    const pathname = parsed.pathname.replace(/\/train\/?$/, '').replace(/\/+$/, '');
    parsed.pathname = `${pathname || ''}/healthz`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function boundedCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 1_000_000 ? number : undefined;
}

const MAX_LOCAL_HEALTH_RESPONSE_BYTES = 32 * 1024;

/** Read only the small, aggregate health payload; never buffer an arbitrary worker response. */
async function boundedHealthResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOCAL_HEALTH_RESPONSE_BYTES) {
    throw new Error('local_worker_health_response_too_large');
  }
  // A standard Fetch Response with a null body is an empty response. Do not
  // call an adapter-provided `text()` fallback here: custom fetch shims could
  // otherwise hand us an arbitrarily large string outside the bounded stream
  // reader below.
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_LOCAL_HEALTH_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('local_worker_health_response_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

/**
 * Probe the configured local worker without making its URL or credentials
 * part of the public response. Unconfigured deployments return synchronously
 * useful state; configured-but-down workers fail within a short timeout.
 */
async function probeLocalTrainingWorkerUncached(
  configured: Sim2RealLocalWorkerIntegration = simulatorIntegration().local,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Sim2RealLocalWorkerIntegration> {
  if (!configured.available) {
    return {
      ...configured,
      reachable: false,
      healthy: false,
      message: '本地训练 worker 未配置；不会发起网络探测。',
    };
  }
  const healthUrl = localWorkerHealthUrl();
  if (!healthUrl) {
    return {
      ...configured,
      reachable: false,
      healthy: false,
      message: '本地训练 worker 地址无效；不会发起网络探测。',
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(250, Math.min(2_000, Number(options.timeoutMs) || 1_200));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    let response: Response;
    try {
      response = await fetchImpl(healthUrl, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch {
      return {
        ...configured,
        reachable: false,
        healthy: false,
        responseMs: Math.max(0, Date.now() - startedAt),
        message: '本地训练 worker 当前不可达；请检查服务状态。',
      };
    }
    const responseMs = Math.max(0, Date.now() - startedAt);
    let payload: Record<string, unknown> = {};
    try {
      const raw = await boundedHealthResponseText(response);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      return {
        ...configured,
        reachable: true,
        healthy: false,
        responseMs,
        message: '本地训练 worker 可达但健康响应无效。',
      };
    }
    const healthy = response.ok && payload.ok === true;
    const result: Sim2RealLocalWorkerIntegration = {
      ...configured,
      reachable: true,
      healthy,
      responseMs,
      message: healthy
        ? '本地训练 worker 已通过健康检查。'
        : `本地训练 worker 可达但健康检查未通过（HTTP ${response.status}）。`,
    };
    const maxConcurrentJobs = boundedCount(payload.maxConcurrentJobs);
    const activeJobs = boundedCount(payload.activeJobs);
    const queuedJobs = boundedCount(payload.queuedJobs);
    if (maxConcurrentJobs !== undefined) result.maxConcurrentJobs = maxConcurrentJobs;
    if (activeJobs !== undefined) result.activeJobs = activeJobs;
    if (queuedJobs !== undefined) result.queuedJobs = queuedJobs;
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

const LOCAL_HEALTH_CACHE_TTL_MS = 3_000;
let localHealthCache:
  | { key: string; expiresAt: number; result: Sim2RealLocalWorkerIntegration }
  | undefined;
let localHealthProbeInFlight:
  | { key: string; promise: Promise<Sim2RealLocalWorkerIntegration> }
  | undefined;

/**
 * Coalesce overview requests and briefly cache both healthy and failed probes.
 * A stopped worker should not add a network timeout to every user's refresh;
 * custom fetch implementations remain uncached so tests and diagnostics stay
 * deterministic.
 */
export async function probeLocalTrainingWorker(
  configured: Sim2RealLocalWorkerIntegration = simulatorIntegration().local,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Sim2RealLocalWorkerIntegration> {
  if (options.fetchImpl) return probeLocalTrainingWorkerUncached(configured, options);
  const key = JSON.stringify({
    url: process.env.RDK_SIM2REAL_LOCAL_RUNNER_URL || '',
    available: configured.available,
    mock: configured.mock === true,
  });
  const now = Date.now();
  if (localHealthCache && localHealthCache.key === key && localHealthCache.expiresAt > now) {
    return { ...localHealthCache.result };
  }
  if (localHealthProbeInFlight?.key === key) {
    const result = await localHealthProbeInFlight.promise;
    return { ...result };
  }
  const promise = probeLocalTrainingWorkerUncached(configured, options).then((result) => {
    localHealthCache = {
      key,
      expiresAt: Date.now() + LOCAL_HEALTH_CACHE_TTL_MS,
      result: { ...result },
    };
    return result;
  });
  localHealthProbeInFlight = { key, promise };
  try {
    const result = await promise;
    return { ...result };
  } finally {
    if (localHealthProbeInFlight?.promise === promise) localHealthProbeInFlight = undefined;
  }
}

export function supportedRdkPlatforms(): RdkPlatform[] {
  return [...ALL_RDK_PLATFORMS];
}

export function storageIntegration() {
  return sim2RealStorageInfo();
}
