import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Device } from '../../shared/types.js';
import type {
  Sim2RealDeploymentMode,
  Sim2RealDeploymentRecord,
  Sim2RealDeploymentStep,
  Sim2RealAvailableContract,
  Sim2RealModelRecord,
  Sim2RealRunArtifactMetadata,
  Sim2RealRunMetrics,
  Sim2RealTaskEvaluationEvidence,
  Sim2RealRunBackend,
  Sim2RealRunRecord,
  Sim2RealRunStatus,
  Sim2RealComputeResource,
  Sim2RealTelemetrySample,
} from '../../shared/sim2real.js';
import {
  MICRODUCK_SIM2REAL_CONTRACT,
  applyTaskEngineRecommendation,
  normalizeTrainingSpec,
  SIM2REAL_PRODUCT_PROFILES,
  SIM2REAL_SCHEMA_VERSION,
  SAFE_ARTIFACT_REF,
  type Sim2RealCheckpointRef,
  type Sim2RealTrainingSpec,
  type Sim2RealRobotId,
  validateSim2RealManifest,
} from '../../shared/sim2real.js';
import {
  redactInternalError,
  sendApiError,
  sendInternalApiError,
  wrapAsync,
} from '../sim2real/http-helpers.js';
import {
  Sim2RealError,
  sim2RealErrorCode,
  type Sim2RealErrorCode,
} from '../sim2real/sim2real-errors.js';
import {
  buildBoardPreflightCommand,
  isForeignOwnedDevice,
  readDevices,
  requestOwnsDevice,
  safeStudioOrigin,
  upsertBridgeDevice,
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
  getSim2RealArtifact,
  getSim2RealEvaluation,
  getSim2RealDeployment,
  getSim2RealModel,
  listSim2RealDeployments,
  listSim2RealModels,
  listSim2RealRuns,
  getSim2RealProject,
  listSim2RealProjects,
  listSim2RealDatasets,
  listSim2RealArtifacts,
  listSim2RealEvaluations,
  listSim2RealComputeResources,
  getSim2RealComputeResourceSecret,
  createSim2RealComputeResource,
  updateSim2RealComputeResource,
  deleteSim2RealComputeResource,
  isSim2RealComputeResourceHealthFresh,
  sim2RealComputeHealthTtlSeconds,
  sim2RealActiveRunLimit,
  updateSim2RealRun,
  claimSim2RealRunRelay,
  storeSim2RealRelayArtifact,
  readSim2RealRelayArtifact,
  updateSim2RealRunForReconcile,
  updateSim2RealDeployment,
  decideSim2RealDeploymentApproval,
  sim2RealStorageInfo,
  sim2RealStorageReadiness,
  appendSim2RealTelemetryWithResult,
  createSim2RealFeedback,
  listSim2RealFeedbackRecords,
  summarizeSim2RealFeedbackRecords,
} from '../sim2real/sim2real-store.js';
import {
  requestLocalTraining,
  requestLocalTrainingStatus,
  fetchLocalRunArtifact,
  fetchLocalRunTelemetry,
  fetchLocalRunLogs,
  localRunnerTokenFormatValid,
  localRunnerTokenRequired,
  localRunnerTokenUsable,
} from '../sim2real/local-runner.js';
import {
  isSim2RealRunnerNotFound,
  isSim2RealRunnerOutcomeUnknown,
  requestRobogoTraining,
  requestRobogoTrainingStatus,
  normalizeRunnerUrl,
  resolvedTaskPack,
} from '../sim2real/robogo-runner.js';
import { LOCAL_SIM2REAL_AUTH, type Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import {
  principalCan,
  SIM2REAL_PERMISSIONS,
  type Sim2RealPermission,
} from '../sim2real/sim2real-rbac.js';
import { validateRunForDeployment } from '../sim2real/release-evidence.js';
import {
  registerSim2RealTelemetryRoutes,
  type Sim2RealTelemetryRouteDeps,
} from './sim2real-telemetry-routes.js';
import { registerSim2RealBoardStationRoutes } from './sim2real-board-station-routes.js';
import { registerSim2RealDeviceConnectionRoutes } from './sim2real-device-connection-routes.js';
import { registerSim2RealWorkspaceRoutes } from './sim2real-workspace-routes.js';
import { registerSim2RealAuditRoutes } from './sim2real-audit-routes.js';
import { deviceConnectionAgentUrl } from '../sim2real/board-tunnel-manager.js';
import {
  FEEDBACK_NOTE_MAX_CHARS,
  FEEDBACK_SURFACES,
  FEEDBACK_VERDICTS,
  normalizeSim2RealFeedback,
  sim2RealWorkspaceNotices,
} from '../sim2real/workspace-feedback.js';

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
    bridgeDeviceId?: string;
    bridgeOwnerKey?: string | null;
  },
) => Promise<{
  device: unknown;
  output: string;
  exitCode?: number;
  mock?: boolean;
  actuatorControl?: boolean;
} | null>;

type OwnedDevice = Device & { bridgeOwnerKey?: string };

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

function queryText(value: unknown, max = 160): string {
  return (Array.isArray(value) ? value[0] : value == null ? '' : String(value))
    .trim()
    .slice(0, max)
    .toLowerCase();
}

const COMPUTE_HEALTH_RESPONSE_MAX_BYTES = 32 * 1024;

/** Keep operator-visible worker fields bounded and free of terminal controls. */
function safeComputeHealthText(value: unknown, max = 160): string {
  if (typeof value !== 'string') return '';
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    output += code >= 0 && code <= 0x1f ? ' ' : code === 0x7f ? ' ' : character;
    if (output.length >= max) break;
  }
  return output.trim().slice(0, max);
}

/**
 * Compute resources are user-owned outbound credentials.  A loopback worker
 * in local development can intentionally run without a token, but production
 * and every non-loopback endpoint must use the same strong bearer policy as
 * the local runner adapter.  Keep syntax validation separate so a short
 * development fixture is still accepted on loopback while control characters
 * can never reach a request header or the JSON ledger.
 */
function computeRunnerTokenError(runnerUrl: string, runnerToken: string): string | null {
  if (!localRunnerTokenFormatValid(runnerToken)) {
    return 'Runner token 不能包含控制字符，且长度不能超过 4096 字节。';
  }
  if (localRunnerTokenRequired(runnerUrl) && !localRunnerTokenUsable(runnerToken)) {
    return '生产或非本机 Runner 必须配置至少 32 字节的随机 bearer token。';
  }
  return null;
}

/**
 * Read a health response without allowing a remote worker to make this web
 * process buffer an unbounded body.  A content-length hint is checked before
 * streaming, then the stream is bounded again for chunked responses.
 */
async function boundedComputeHealthText(response: globalThis.Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared != null) {
    const normalized = declared.trim();
    const length = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(length) || length < 0 || length > COMPUTE_HEALTH_RESPONSE_MAX_BYTES) {
      throw new Error('compute_health_response_too_large');
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > COMPUTE_HEALTH_RESPONSE_MAX_BYTES) {
      throw new Error('compute_health_response_too_large');
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > COMPUTE_HEALTH_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('compute_health_response_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

/**
 * Studio's Local Bridge is a browser-session transport boundary.  Keep the
 * boundary deliberately smaller than the general worker clients: a bridge
 * response is never forwarded verbatim, and a stalled or chunked upstream
 * cannot make this process retain an unbounded body.
 */
export const SIM2REAL_STUDIO_UPSTREAM_TIMEOUT_MS = 15_000;
export const SIM2REAL_STUDIO_UPSTREAM_MAX_RESPONSE_BYTES = 256 * 1024;
const SIM2REAL_STUDIO_PAIRING_MAX_RESPONSE_BYTES = 64 * 1024;
const SIM2REAL_STUDIO_COOKIE_MAX_LENGTH = 8 * 1024;
const SIM2REAL_STUDIO_COMMAND_MAX_LENGTH = 64 * 1024;
const SIM2REAL_STUDIO_BRIDGE_MAX_COUNT = 32;
const SIM2REAL_STUDIO_DEVICE_MAX_COUNT = 128;
const SIM2REAL_STUDIO_TIMEOUT_ENV = 'RDK_SIM2REAL_STUDIO_UPSTREAM_TIMEOUT_MS';
const STUDIO_BRIDGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STUDIO_TEXT_CONTROL = /[\u0000-\u001f\u007f]/;
const STUDIO_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function studioUpstreamTimeoutMs(): number {
  const configured = Number(process.env[SIM2REAL_STUDIO_TIMEOUT_ENV]);
  return Number.isSafeInteger(configured) && configured >= 100 && configured <= 30_000
    ? configured
    : SIM2REAL_STUDIO_UPSTREAM_TIMEOUT_MS;
}

function studioSafeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (
    !text ||
    text.length > maxLength ||
    Buffer.byteLength(text, 'utf8') > maxLength ||
    STUDIO_TEXT_CONTROL.test(text)
  ) {
    return undefined;
  }
  return text;
}

/** Shell scripts may contain line breaks, but never terminal escape/control bytes. */
function studioSafeCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (
    !text ||
    text.length > SIM2REAL_STUDIO_COMMAND_MAX_LENGTH ||
    Buffer.byteLength(text, 'utf8') > SIM2REAL_STUDIO_COMMAND_MAX_LENGTH ||
    STUDIO_CONTROL.test(text)
  ) {
    return undefined;
  }
  return text;
}

function studioSafeId(value: unknown): string | undefined {
  const text = studioSafeText(value, 160);
  return text && STUDIO_BRIDGE_ID.test(text) ? text : undefined;
}

function studioSafePort(value: unknown): number | undefined {
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function studioObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function studioForwardCookie(request: Request): string | undefined {
  const value = request.headers?.cookie;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > SIM2REAL_STUDIO_COOKIE_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

async function readBoundedStudioResponseText(
  response: globalThis.Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const normalized = declared.trim();
    if (!/^\d+$/.test(normalized)) throw new Error('studio_bridge_response_invalid_length');
    const length = Number(normalized);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      throw new Error('studio_bridge_response_too_large');
    }
  }
  // A real Fetch response exposes a readable body for JSON. Treat a null
  // body as a protocol failure instead of calling an adapter-provided
  // unbounded text() fallback.
  if (!response.body) throw new Error('studio_bridge_response_empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('studio_bridge_timeout');
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('studio_bridge_response_too_large');
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

interface StudioBridgeJsonResponse {
  status: number;
  ok: boolean;
  payload: Record<string, unknown>;
}

/**
 * Fetch one fixed Studio endpoint.  The timeout races both fetch and body
 * consumption, while the signal is still passed to fetch so real transports
 * close their socket as soon as the deadline expires.
 */
async function fetchStudioBridgeJson(
  origin: string,
  path: string,
  request: Request,
  options: {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    maxBytes?: number;
  } = {},
): Promise<StudioBridgeJsonResponse | null> {
  const timeoutSignal = AbortSignal.timeout(studioUpstreamTimeoutMs());
  let onAbort: ((event: Event) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('studio_bridge_timeout'));
    if (timeoutSignal.aborted) onAbort(new Event('abort'));
    else timeoutSignal.addEventListener('abort', onAbort, { once: true });
  });
  let upstream: globalThis.Response | undefined;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    const cookie = studioForwardCookie(request);
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (options.body) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    upstream = await Promise.race([
      fetch(`${origin}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: timeoutSignal,
      }),
      timeout,
    ]);
    const raw = await Promise.race([
      readBoundedStudioResponseText(
        upstream,
        options.maxBytes ?? SIM2REAL_STUDIO_UPSTREAM_MAX_RESPONSE_BYTES,
        timeoutSignal,
      ),
      timeout,
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const payload = studioObject(parsed);
    if (!payload) return null;
    return { status: upstream.status, ok: upstream.ok, payload };
  } catch {
    // Do not expose fetch/redirect/proxy text to the browser.  Cancellation is
    // best-effort because a custom test adapter may not implement body.cancel.
    void upstream?.body?.cancel().catch(() => undefined);
    return null;
  } finally {
    if (onAbort) timeoutSignal.removeEventListener('abort', onAbort);
  }
}

function studioBridgeDeviceProjection(
  value: unknown,
  options: { requireHost?: boolean } = {},
): Record<string, unknown> | null {
  const source = studioObject(value);
  if (!source) return null;
  const id = studioSafeId(source.id);
  const bridgeDeviceId = studioSafeId(source.bridgeDeviceId) || id;
  if (!bridgeDeviceId) return null;
  const host = studioSafeText(source.host, 255);
  if (options.requireHost && !host) return null;
  const name = studioSafeText(source.name, 120);
  const label = studioSafeText(source.label, 120);
  const username = studioSafeText(source.username, 160) || studioSafeText(source.sshUser, 160);
  const port = source.port == null ? undefined : studioSafePort(source.port);
  if (source.port != null && port === undefined) return null;
  const rawTransport = source.bridgeTransport ?? source.transport;
  const transport =
    rawTransport === 'ssh' || rawTransport === 'usb-ethernet' || rawTransport === 'serial'
      ? rawTransport
      : undefined;
  const boardPlatform = studioSafeText(source.boardPlatform, 80);
  const boardModel = studioSafeText(source.boardModel, 120);
  return {
    bridgeDeviceId,
    ...(id ? { id } : {}),
    ...(studioSafeId(source.bridgeId) ? { bridgeId: studioSafeId(source.bridgeId) } : {}),
    ...(name ? { name } : {}),
    ...(label ? { label } : {}),
    ...(host ? { host } : {}),
    ...(port === undefined ? {} : { port }),
    ...(username ? { username } : {}),
    ...(transport ? { transport } : {}),
    ...(typeof source.probeOk === 'boolean' ? { probeOk: source.probeOk } : {}),
    ...(boardPlatform ? { boardPlatform } : {}),
    ...(boardModel ? { boardModel } : {}),
  };
}

function projectStudioBridgeStatus(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Array.isArray(payload.bridges)) return null;
  const bridges = payload.bridges.slice(0, SIM2REAL_STUDIO_BRIDGE_MAX_COUNT).flatMap((value) => {
    const source = studioObject(value);
    const bridgeId = studioSafeId(source?.bridgeId);
    if (!source || !bridgeId) return [];
    const devices = Array.isArray(source.devices)
      ? source.devices
          .slice(0, SIM2REAL_STUDIO_DEVICE_MAX_COUNT)
          .map((device) => studioBridgeDeviceProjection(device))
          .filter((device): device is Record<string, unknown> => device !== null)
      : [];
    return [
      {
        bridgeId,
        online: source.online === true,
        devices,
      },
    ];
  });
  return {
    ...(payload.ok === true ? { ok: true } : {}),
    bridges,
  };
}

function projectStudioPairing(payload: Record<string, unknown>): Record<string, unknown> | null {
  const command = studioSafeCommand(payload.command);
  if (!command) return null;
  const oneliner = studioSafeCommand(payload.oneliner);
  const message = studioSafeText(payload.message, 400);
  return {
    ok: true,
    command,
    ...(oneliner ? { oneliner } : {}),
    ...(message ? { message } : {}),
  };
}

function projectStudioConnect(
  payload: Record<string, unknown>,
): { response: Record<string, unknown>; device: Record<string, unknown> } | null {
  const device = studioBridgeDeviceProjection(payload.device, { requireHost: true });
  if (!device) return null;
  const message = studioSafeText(payload.message, 400);
  return {
    device,
    response: {
      ok: true,
      device,
      ...(message ? { message } : {}),
    },
  };
}

function studioBridgeUpstreamError(response: Response): void {
  noStore(response);
  sendApiError(
    response,
    502,
    'SIM2REAL_STUDIO_BRIDGE_UNAVAILABLE',
    'Studio Bridge 暂时不可用，请稍后重试。',
    { retryable: true },
  );
}

function studioBridgeConfigError(response: Response): void {
  noStore(response);
  sendApiError(
    response,
    503,
    'SIM2REAL_STUDIO_BRIDGE_UNAVAILABLE',
    'Studio Bridge 地址未通过安全校验。',
    { retryable: false },
  );
}

function studioPairingRequestBody(value: unknown): Record<string, unknown> | null {
  const source = studioObject(value);
  if (!source) return null;
  const host = studioSafeText(source.host, 255);
  const sshUser = studioSafeText(source.sshUser, 160);
  if (!host || !sshUser) return null;
  const sshPort = source.sshPort == null ? undefined : studioSafePort(source.sshPort);
  if (source.sshPort != null && sshPort === undefined) return null;
  let sshPassword: string | undefined;
  if (source.sshPassword != null) {
    if (
      typeof source.sshPassword !== 'string' ||
      source.sshPassword.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(source.sshPassword)
    ) {
      return null;
    }
    sshPassword = source.sshPassword;
  }
  return {
    host,
    sshUser,
    ...(sshPort === undefined ? {} : { sshPort }),
    ...(sshPassword === undefined ? {} : { sshPassword }),
  };
}

function studioConnectRequestBody(value: unknown): Record<string, unknown> | null {
  const source = studioObject(value);
  if (!source) return null;
  if (source.bridgeId == null) return {};
  const bridgeId = studioSafeId(source.bridgeId);
  return bridgeId ? { bridgeId } : null;
}

interface ComputeHealthPayload {
  cuda?: boolean;
  gpuName?: string;
  vramMb?: number;
  maxConcurrentJobs?: number;
}

/** Accept only the small, explicit health contract used by the worker. */
function parseComputeHealthPayload(text: string): ComputeHealthPayload | null {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  // HTTP 200 alone is not proof that a worker is configured or ready.  The
  // worker's explicit boolean is the source of truth for readiness.
  if (source.ok !== true) return null;
  const boundedInteger = (key: string, min: number, max: number): number | undefined => {
    if (source[key] == null) return undefined;
    const value = Number(source[key]);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
  };
  const maxConcurrentJobs = boundedInteger('maxConcurrentJobs', 1, 32);
  const vramMb = boundedInteger('vramMb', 0, 2_000_000);
  // If a worker sends a field, reject malformed values rather than silently
  // storing a misleading partial health record.
  if (source.maxConcurrentJobs != null && maxConcurrentJobs == null) return null;
  if (source.vramMb != null && vramMb == null) return null;
  const gpuName = safeComputeHealthText(source.gpuName, 160);
  return {
    ...(typeof source.cuda === 'boolean' ? { cuda: source.cuda } : {}),
    ...(gpuName ? { gpuName } : {}),
    ...(vramMb == null ? {} : { vramMb }),
    ...(maxConcurrentJobs == null ? {} : { maxConcurrentJobs }),
  };
}

function computeResourceHealthFailure(
  resource: Pick<Sim2RealComputeResource, 'status' | 'lastCheckedAt'>,
): 'stale' | 'not-ready' | null {
  if (isSim2RealComputeResourceHealthFresh(resource)) return null;
  const checkedAt = resource.lastCheckedAt ? Date.parse(resource.lastCheckedAt) : Number.NaN;
  if (
    resource.lastCheckedAt &&
    Number.isFinite(checkedAt) &&
    Date.now() - checkedAt > sim2RealComputeHealthTtlSeconds() * 1_000
  ) {
    return 'stale';
  }
  return 'not-ready';
}

/**
 * Notices are pure workspace state, not account state: accept an optional
 * owner so logged-out visitors still learn the platform version and any
 * degraded integrations, without gaining any record access.
 */
function requestOwnerOptional(
  request: Request,
  _response: Response,
  auth: Sim2RealAuthPort,
): string | undefined {
  if (!auth.isMultiUserDeployment()) return undefined;
  const id = String(auth.resolvePrincipal(request)?.accountId ?? '').trim();
  return /^[^\u0000-\u001f\u007f]{1,160}$/.test(id) && !id.includes('/') ? id : undefined;
}

function packageJsonCandidates(moduleDirectory: string): string[] {
  return [
    // Standalone dev server: services/sim2real-web/server.ts -> repo root.
    path.resolve(moduleDirectory, '../../package.json'),
    // Compiled dist-server when package metadata is copied beside the output.
    path.resolve(moduleDirectory, '../package.json'),
    // Release layout used by the systemd units: package.json is beside
    // dist-server/, not inside it (see services/sim2real-web/README.md).
    path.resolve(moduleDirectory, '../../../package.json'),
  ];
}

export function workspacePackageVersion(
  moduleDirectory = path.dirname(fileURLToPath(import.meta.url)),
): string {
  for (const file of packageJsonCandidates(moduleDirectory)) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
      if (value.version) return String(value.version);
    } catch {
      // Missing/unreadable candidate is expected for one layout per process.
    }
  }
  return 'unknown';
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
  // An authenticated account is not automatically a reader once an adapter
  // emits explicit role claims.  `principalCan` deliberately treats an empty
  // or unknown claim as deny-all; enforce that policy at the shared owner
  // boundary so every read route (workspace, lineage, audit, telemetry and
  // deployment details) fails closed consistently.  Without this check a
  // malformed role claim could still enumerate its own tenant's records even
  // though all mutations were correctly denied.
  if (!principalCan(principal, SIM2REAL_PERMISSIONS.read)) {
    noStore(response);
    sendApiError(
      response,
      403,
      'SIM2REAL_PERMISSION_DENIED',
      '当前账号没有读取 Sim2Real 工作区的权限。',
      { retryable: false, permission: SIM2REAL_PERMISSIONS.read },
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
  const header = Array.isArray(headerValue)
    ? headerValue.join(',')
    : String(headerValue ?? '').trim();
  const bodyValue = body.idempotencyKey == null ? '' : String(body.idempotencyKey).trim();
  if (header && !SAFE_IDEMPOTENCY_KEY.test(header)) return { error: 'Idempotency-Key 格式无效' };
  if (bodyValue && !SAFE_IDEMPOTENCY_KEY.test(bodyValue))
    return { error: 'idempotencyKey 格式无效' };
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
  projectId?: string;
  experimentId?: string;
  label?: string;
  computeResourceId?: string;
  datasetIds?: string[];
}): string {
  return JSON.stringify({
    modelId: input.modelId,
    backend: input.backend,
    taskId: input.taskId || null,
    training: input.training || null,
    resumeFrom: input.resumeFrom || null,
    projectId: input.projectId || null,
    experimentId: input.experimentId || null,
    label: input.label || null,
    computeResourceId: input.computeResourceId || null,
    datasetIds: input.datasetIds || [],
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
  return value === 'rdk-duck' || value === 'originbot' ? value : 'microduck';
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

function configuredStudioOrigin(): string | null {
  return safeStudioOrigin(
    process.env.RDK_SIM2REAL_STUDIO_ORIGIN ||
      process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN ||
      'https://rdkstudio.d-robotics.cc',
  );
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

/**
 * Keep the workspace landing view cheap: clients that only need a health
 * summary should not download model manifests, telemetry, or runner probes.
 * These projections intentionally contain identifiers and lifecycle state,
 * while the detail endpoints remain the source of truth for full records.
 */
function workspaceLatestRun(run: Sim2RealRunRecord | undefined): Record<string, unknown> | null {
  if (!run) return null;
  return {
    id: run.id,
    modelId: run.modelId,
    ...(run.taskId ? { taskId: run.taskId } : {}),
    backend: run.backend,
    status: run.status,
    summary: run.summary,
    createdAt: run.createdAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  };
}

function workspaceLatestDeployment(
  deployment: Sim2RealDeploymentRecord | undefined,
): Record<string, unknown> | null {
  if (!deployment) return null;
  return {
    id: deployment.id,
    modelId: deployment.modelId,
    deviceId: deployment.deviceId,
    targetPlatform: deployment.targetPlatform,
    mode: deployment.mode,
    status: deployment.status,
    summary: deployment.summary,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
  };
}

function latestByTimestamp<T>(items: readonly T[], timestamp: (item: T) => string): T | undefined {
  return [...items].sort((left, right) => timestamp(right).localeCompare(timestamp(left)))[0];
}

function availableContractsFor(models: readonly Sim2RealModelRecord[]): {
  availableContracts: Sim2RealAvailableContract[];
  contracts: Record<Sim2RealRobotId, Sim2RealAvailableContract[]>;
} {
  const grouped: Record<Sim2RealRobotId, Sim2RealAvailableContract[]> = {
    microduck: [],
    'rdk-duck': [],
    originbot: [],
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
    availableContracts: [...grouped.microduck, ...grouped['rdk-duck'], ...grouped.originbot],
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

/**
 * HTTP mapping for typed sim2real failures. Storage/ledger/telemetry codes
 * are exhaustive here by construction: the STORAGE_HTTP_CODES type requires
 * every code that storageError can receive, so adding one without a row
 * fails the type check instead of silently falling into the 500 bucket like
 * the old message comparison chain did. Runner-level codes
 * (sim2real_robogo_*) are deliberately absent: the run routes catch those
 * before storageError and translate them into run-level states.
 */
const STORAGE_HTTP_CODES = [
  'sim2real_storage_not_configured',
  'sim2real_storage_unavailable',
  'sim2real_storage_writer_conflict',
  'sim2real_storage_quota_exceeded',
  'sim2real_model_version_exists',
  'sim2real_model_quota_exceeded',
  'sim2real_dataset_version_exists',
  'sim2real_dataset_transition_invalid',
  'sim2real_dataset_not_mutable',
  'sim2real_artifact_version_exists',
  'sim2real_artifact_idempotency_conflict',
  'sim2real_artifact_not_mutable',
  'sim2real_artifact_lineage_invalid',
  'sim2real_run_lineage_invalid',
  'sim2real_evaluation_lineage_invalid',
  'sim2real_evaluation_stale',
  'sim2real_evaluation_transition_invalid',
  'sim2real_evaluation_idempotency_conflict',
  'sim2real_run_quota_exceeded',
  'sim2real_deployment_quota_exceeded',
  'sim2real_run_idempotency_required',
  'sim2real_run_idempotency_conflict',
  'sim2real_run_reservation_lost',
  'sim2real_telemetry_idempotency_conflict',
  'sim2real_telemetry_attestation_sequence_required',
  'sim2real_telemetry_timestamp_order',
  'sim2real_telemetry_quota_exceeded',
  'sim2real_active_run_quota_exceeded',
  'sim2real_deployment_idempotency_conflict',
  'sim2real_deployment_transition_invalid',
  'sim2real_runner_token_invalid',
  'sim2real_runner_account_invalid',
  'sim2real_runner_response_too_large',
  'sim2real_runner_idempotency_invalid',
] as const satisfies readonly Sim2RealErrorCode[];

type StorageHttpCode = (typeof STORAGE_HTTP_CODES)[number];

/**
 * Runtime membership set derived from the same list the type comes from, so the
 * lookup below cannot drift from the compile-time exhaustiveness guarantee — and
 * so a code like `toString` can never match through the prototype chain the way
 * a bare `code in STORAGE_ERROR_HTTP` would.
 */
const STORAGE_ERROR_CODE_SET: ReadonlySet<string> = new Set(STORAGE_HTTP_CODES);

const STORAGE_ERROR_HTTP: Readonly<
  Record<
    StorageHttpCode,
    {
      status: number;
      code: string;
      message: string;
      retryable: boolean;
      retryAfterSeconds?: number;
    }
  >
> = {
  sim2real_storage_not_configured: {
    status: 503,
    code: 'SIM2REAL_STORAGE_NOT_CONFIGURED',
    message: '当前 Web Cloud 尚未配置 sim2real 持久化存储；只读仿真入口仍可使用。',
    retryable: false,
  },
  sim2real_storage_unavailable: {
    status: 503,
    code: 'SIM2REAL_STORAGE_UNAVAILABLE',
    message: 'sim2real 台账当前不可读或不可写；为避免覆盖已有数据，服务已停止本次操作。',
    retryable: true,
  },
  sim2real_storage_writer_conflict: {
    // Another process owns the storage directory. Retrying without operator
    // action cannot succeed, so this is explicitly not retryable.
    status: 503,
    code: 'SIM2REAL_STORAGE_WRITER_CONFLICT',
    message:
      '另一个进程正在写这个存储目录；为避免覆盖台账，本服务已拒绝本次写入。请改用独立的 RDK_SIM2REAL_STORAGE_DIR，或确认旧进程已退出后重试。',
    retryable: false,
  },
  sim2real_storage_quota_exceeded: {
    status: 507,
    code: 'SIM2REAL_STORAGE_QUOTA_EXCEEDED',
    message: 'sim2real 台账已达到单实例大小上限，请迁移到对象存储 adapter 后再继续写入。',
    retryable: false,
  },
  sim2real_model_version_exists: {
    status: 409,
    code: 'SIM2REAL_MODEL_EXISTS',
    message: '同一模型版本已登记，请修改 modelId 或 version。',
    retryable: false,
  },
  sim2real_model_quota_exceeded: {
    status: 507,
    code: 'SIM2REAL_LEDGER_QUOTA_EXCEEDED',
    message: 'sim2real 台账记录已达到单实例上限，请迁移到数据库或对象存储 adapter 后再继续。',
    retryable: false,
  },
  sim2real_dataset_version_exists: {
    status: 409,
    code: 'SIM2REAL_DATASET_VERSION_EXISTS',
    message: '同一数据集名称和版本已登记；请创建新的版本号。',
    retryable: false,
  },
  sim2real_dataset_transition_invalid: {
    status: 409,
    code: 'SIM2REAL_DATASET_TRANSITION_INVALID',
    message: '数据集状态转换不合法；已准备或撤销的数据集不能回退覆盖。',
    retryable: false,
  },
  sim2real_dataset_not_mutable: {
    status: 409,
    code: 'SIM2REAL_DATASET_NOT_MUTABLE',
    message: '数据集快照不可原地修改；请登记新的版本。',
    retryable: false,
  },
  sim2real_artifact_version_exists: {
    status: 409,
    code: 'SIM2REAL_ARTIFACT_VERSION_EXISTS',
    message: '同一制品名称和版本已登记且内容不同；发布制品不可覆盖，请使用新版本。',
    retryable: false,
  },
  sim2real_artifact_idempotency_conflict: {
    status: 409,
    code: 'SIM2REAL_ARTIFACT_IDEMPOTENCY_CONFLICT',
    message: '制品 Idempotency-Key 已用于另一份制品请求，请更换 key。',
    retryable: false,
  },
  sim2real_artifact_not_mutable: {
    status: 409,
    code: 'SIM2REAL_ARTIFACT_NOT_MUTABLE',
    message: '已发布制品不可原地修改；如需下线请使用撤销操作。',
    retryable: false,
  },
  sim2real_artifact_lineage_invalid: {
    status: 422,
    code: 'SIM2REAL_ARTIFACT_LINEAGE_INVALID',
    message: '制品血缘引用无效，或引用了不属于当前账号的资源。',
    retryable: false,
  },
  sim2real_run_lineage_invalid: {
    status: 422,
    code: 'SIM2REAL_RUN_LINEAGE_INVALID',
    message: '运行的项目、数据集或制品引用无效，或不属于当前账号。',
    retryable: false,
  },
  sim2real_evaluation_lineage_invalid: {
    status: 422,
    code: 'SIM2REAL_EVALUATION_LINEAGE_INVALID',
    message: '评测血缘引用无效，或引用了不属于当前账号的资源。',
    retryable: false,
  },
  sim2real_evaluation_stale: {
    status: 409,
    code: 'SIM2REAL_EVALUATION_STALE',
    message: '评测所依据的遥测已被更新；请重新运行评测后再提交发布计划。',
    retryable: false,
  },
  sim2real_evaluation_transition_invalid: {
    status: 409,
    code: 'SIM2REAL_EVALUATION_TRANSITION_INVALID',
    message: '评测状态不能回退或覆盖已完成结果。',
    retryable: false,
  },
  sim2real_evaluation_idempotency_conflict: {
    status: 409,
    code: 'SIM2REAL_EVALUATION_IDEMPOTENCY_CONFLICT',
    message: '评测 Idempotency-Key 已用于另一份评测请求，请更换 key。',
    retryable: false,
  },
  sim2real_run_quota_exceeded: {
    status: 507,
    code: 'SIM2REAL_LEDGER_QUOTA_EXCEEDED',
    message: 'sim2real 台账记录已达到单实例上限，请迁移到数据库或对象存储 adapter 后再继续。',
    retryable: false,
  },
  sim2real_deployment_quota_exceeded: {
    status: 507,
    code: 'SIM2REAL_LEDGER_QUOTA_EXCEEDED',
    message: 'sim2real 台账记录已达到单实例上限，请迁移到数据库或对象存储 adapter 后再继续。',
    retryable: false,
  },
  sim2real_run_idempotency_required: {
    status: 409,
    code: 'SIM2REAL_IDEMPOTENCY_CONFLICT',
    message: 'Idempotency-Key 已用于另一份运行请求，请更换 key。',
    retryable: false,
  },
  sim2real_run_idempotency_conflict: {
    status: 409,
    code: 'SIM2REAL_IDEMPOTENCY_CONFLICT',
    message: 'Idempotency-Key 已用于另一份运行请求，请更换 key。',
    retryable: false,
  },
  sim2real_run_reservation_lost: {
    status: 409,
    code: 'SIM2REAL_IDEMPOTENCY_CONFLICT',
    message: 'Idempotency-Key 已用于另一份运行请求，请更换 key。',
    retryable: false,
  },
  sim2real_telemetry_idempotency_conflict: {
    status: 409,
    code: 'SIM2REAL_TELEMETRY_IDEMPOTENCY_CONFLICT',
    message: '遥测 Idempotency-Key 已用于另一份数据，请更换 key。',
    retryable: false,
  },
  sim2real_telemetry_attestation_sequence_required: {
    status: 400,
    code: 'SIM2REAL_TELEMETRY_SEQUENCE_REQUIRED',
    message: '受信 board-agent 遥测必须携带 sequence 序号。',
    retryable: false,
  },
  sim2real_telemetry_timestamp_order: {
    status: 409,
    code: 'SIM2REAL_TELEMETRY_TIMESTAMP_ORDER',
    message:
      '遥测时间戳必须非递减；同一策略会话内请保持时钟单调，新会话需以 session-started 标记开始以重置时间线。',
    retryable: false,
  },
  sim2real_telemetry_quota_exceeded: {
    status: 413,
    code: 'SIM2REAL_TELEMETRY_QUOTA_EXCEEDED',
    message: '该运行或账号的遥测配额已用尽；请分段导出、清理旧数据，或迁移到对象存储 adapter。',
    retryable: false,
  },
  sim2real_active_run_quota_exceeded: {
    status: 429,
    code: 'SIM2REAL_ACTIVE_RUN_QUOTA_EXCEEDED',
    message: '当前账号已有过多排队或运行中的训练任务，请等待任务完成后再提交。',
    retryable: true,
    retryAfterSeconds: 30,
  },
  sim2real_deployment_idempotency_conflict: {
    status: 409,
    code: 'SIM2REAL_DEPLOYMENT_IDEMPOTENCY_CONFLICT',
    message: '部署 Idempotency-Key 已用于另一份计划，请更换 key。',
    retryable: false,
  },
  sim2real_deployment_transition_invalid: {
    status: 409,
    code: 'SIM2REAL_DEPLOYMENT_TRANSITION_INVALID',
    message: '部署状态转换不合法，请刷新当前计划后重试。',
    retryable: false,
  },
  sim2real_runner_token_invalid: {
    status: 401,
    code: 'SIM2REAL_ROBOGO_TOKEN_INVALID',
    message: 'RoboGo 令牌不合规（长度或包含控制字符）。',
    retryable: false,
  },
  sim2real_runner_idempotency_invalid: {
    status: 400,
    code: 'SIM2REAL_IDEMPOTENCY_KEY_INVALID',
    message: 'Idempotency-Key 只能包含可打印 ASCII 字符且不超过 128 位。',
    retryable: false,
  },
  sim2real_runner_account_invalid: {
    status: 401,
    code: 'SIM2REAL_ROBOGO_ACCOUNT_INVALID',
    message: 'RoboGo 账号标识不合规。',
    retryable: false,
  },
  sim2real_runner_response_too_large: {
    status: 502,
    code: 'SIM2REAL_ROBOGO_RESPONSE_TOO_LARGE',
    message: 'RoboGo 响应超出大小边界，已按失败处理。',
    retryable: true,
  },
};

function storageError(request: Request, response: Response, error: unknown, scope: string): void {
  const code = sim2RealErrorCode(error);
  // Runner-level codes (sim2real_robogo_*) are caught upstream and become
  // run-level states; anything left unmapped here falls to the 500 path.
  const mapped =
    code && STORAGE_ERROR_CODE_SET.has(code)
      ? STORAGE_ERROR_HTTP[code as StorageHttpCode]
      : undefined;
  if (mapped) {
    if (mapped.retryAfterSeconds)
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    sendApiError(response, mapped.status, mapped.code, mapped.message, {
      retryable: mapped.retryable,
      ...(mapped.retryAfterSeconds ? { retryAfterSeconds: mapped.retryAfterSeconds } : {}),
    });
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

// ---- POST /runs support ------------------------------------------------
// The create-run handler delegates to three helpers along its natural
// seams: request validation, idempotent resolution, and backend dispatch.
// Each returns a discriminated result so the route body stays a flat
// pipeline instead of a six-level nested block.

interface ParsedRunRequest {
  idempotencyKey?: string;
  modelId: string;
  taskId?: string;
  backend: Sim2RealRunBackend;
  training?: Sim2RealTrainingSpec;
  resumeFrom?: Sim2RealCheckpointRef;
  projectId?: string;
  experimentId?: string;
  label?: string;
  computeResourceId?: string;
  datasetIds?: string[];
}

/** Validate and normalize the POST /runs body; failures are API-shaped. */
function parseRunRequest(
  request: Request,
  body: Record<string, unknown>,
): { parsed?: ParsedRunRequest; apiError?: { status: number; code: string; message: string } } {
  const idempotency = requestIdempotencyKey(request, body);
  if (idempotency.error) {
    return {
      apiError: {
        status: 400,
        code: 'SIM2REAL_INVALID_IDEMPOTENCY_KEY',
        message: idempotency.error,
      },
    };
  }
  const idempotencyKey = idempotency.key;
  const modelId = String(body.modelId ?? '').trim();
  const taskId = String(body.taskId ?? '')
    .trim()
    .toLowerCase();
  const backend = safeBackend(body.backend);
  if (!modelId || !backend) {
    return {
      apiError: {
        status: 400,
        code: 'SIM2REAL_INVALID_RUN',
        message: 'modelId 和 backend(browser、local、robogo 或 contract) 必填',
      },
    };
  }
  if ((backend === 'local' || backend === 'robogo') && !idempotencyKey) {
    return {
      apiError: {
        status: 400,
        code: 'SIM2REAL_IDEMPOTENCY_REQUIRED',
        message: 'local / RoboGo 训练必须提供 Idempotency-Key，避免网络重试重复启动或计费。',
      },
    };
  }
  if (taskId && !/^[a-z][a-z0-9_-]{0,31}$/.test(taskId)) {
    return { apiError: { status: 400, code: 'SIM2REAL_INVALID_TASK', message: 'taskId 格式无效' } };
  }
  const hasTraining = Object.prototype.hasOwnProperty.call(body, 'training');
  let training: Sim2RealTrainingSpec | undefined;
  if (backend === 'robogo' || backend === 'local' || hasTraining) {
    const trainingResult = normalizeTrainingSpec(
      hasTraining ? body.training : { profile: 'smoke' },
    );
    if (trainingResult.errors.length || !trainingResult.spec) {
      return {
        apiError: {
          status: 400,
          code: 'SIM2REAL_INVALID_TRAINING',
          message: trainingResult.errors[0] || '训练参数无效',
        },
      };
    }
    training = trainingResult.spec;
    // Task packs may recommend an engine (physics-dense tasks → MJX). The
    // recommendation only fills in a spec that chose none, so an explicit
    // user/agent submission always wins and the ledger keeps the default
    // when the task has no opinion.
    if (taskId) {
      try {
        const pack = resolvedTaskPack(taskId);
        const recommended =
          pack && typeof pack.recommendedEngine === 'string' ? pack.recommendedEngine : null;
        training = applyTaskEngineRecommendation(training, recommended);
      } catch {
        // resolvedTaskPack already throws through the runner path; keep the
        // recommendation application non-fatal here.
      }
    }
  }
  const resumeResult = normalizeResumeFrom(body.resumeFrom);
  if (resumeResult.error) {
    return {
      apiError: { status: 400, code: 'SIM2REAL_INVALID_RESUME', message: resumeResult.error },
    };
  }
  const projectId = String(body.projectId ?? '').trim();
  const experimentId = String(body.experimentId ?? '').trim();
  const label = String(body.label ?? '').trim();
  const computeResourceId = String(body.computeResourceId ?? '').trim();
  const rawDatasetIds = body.datasetIds;
  let datasetIds: string[] | undefined;
  if (rawDatasetIds !== undefined) {
    if (!Array.isArray(rawDatasetIds) || rawDatasetIds.length > 500) {
      return {
        apiError: {
          status: 400,
          code: 'SIM2REAL_INVALID_DATASET_LINEAGE',
          message: 'datasetIds 必须是最多 500 个字符串的数组。',
        },
      };
    }
    datasetIds = [...new Set(rawDatasetIds.map((id) => String(id).trim()).filter(Boolean))];
    if (datasetIds.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id))) {
      return {
        apiError: {
          status: 400,
          code: 'SIM2REAL_INVALID_DATASET_LINEAGE',
          message: 'datasetIds 包含无效标识。',
        },
      };
    }
  }
  if (projectId && !/^[a-zA-Z0-9_-]{1,120}$/.test(projectId))
    return {
      apiError: { status: 400, code: 'SIM2REAL_INVALID_PROJECT', message: 'projectId 格式无效' },
    };
  if (experimentId && !/^[a-zA-Z0-9._-]{1,120}$/.test(experimentId))
    return {
      apiError: {
        status: 400,
        code: 'SIM2REAL_INVALID_EXPERIMENT',
        message: 'experimentId 格式无效',
      },
    };
  if (label.length > 120)
    return {
      apiError: {
        status: 400,
        code: 'SIM2REAL_INVALID_LABEL',
        message: 'label 长度不能超过 120 个字符',
      },
    };
  if (computeResourceId && !/^[a-f0-9-]{8,100}$/i.test(computeResourceId))
    return {
      apiError: {
        status: 400,
        code: 'SIM2REAL_INVALID_COMPUTE_RESOURCE',
        message: 'computeResourceId 格式无效',
      },
    };
  if (computeResourceId && backend !== 'local')
    return {
      apiError: {
        status: 400,
        code: 'SIM2REAL_COMPUTE_RESOURCE_LOCAL_ONLY',
        message: '自有 GPU 资源目前只支持 local 训练后端。',
      },
    };
  return {
    parsed: {
      idempotencyKey,
      modelId,
      ...(taskId ? { taskId } : {}),
      backend,
      ...(training ? { training } : {}),
      ...(resumeResult.value ? { resumeFrom: resumeResult.value } : {}),
      ...(projectId ? { projectId } : {}),
      ...(experimentId ? { experimentId } : {}),
      ...(label ? { label } : {}),
      ...(computeResourceId ? { computeResourceId } : {}),
      ...(datasetIds ? { datasetIds } : {}),
    },
  };
}

/**
 * Resolve an existing idempotent replay (same key, same fingerprint) before
 * any side effect. A key reused with a different payload is a conflict.
 */
async function findIdempotentRunReplay(
  idempotencyKey: string | undefined,
  requestFingerprint: string,
  owner: string | undefined,
): Promise<Sim2RealRunRecord | 'fingerprint-conflict' | undefined> {
  if (!idempotencyKey) return undefined;
  const existing = await findSim2RealRunByIdempotency(idempotencyKey, owner);
  if (!existing) return undefined;
  if (existing.requestFingerprint && existing.requestFingerprint !== requestFingerprint) {
    return 'fingerprint-conflict';
  }
  return existing.run;
}

interface RunBackendOutcome {
  status: Sim2RealRunStatus;
  summary: string;
  launchUrl?: string;
  externalRunId?: string;
  mock?: boolean;
  checkpoint?: Sim2RealCheckpointRef;
  artifact?: Sim2RealRunArtifactMetadata;
  metrics?: Sim2RealRunMetrics;
  taskEvaluation?: Sim2RealTaskEvaluationEvidence;
  relayAgentUrl?: string;
}

/**
 * Launch one run on its backend. Runner transport failures are translated
 * into run states here (queued when the outcome is unknown so an operator
 * can reconcile, failed otherwise) — they never surface as API errors.
 */
async function dispatchRunBackend(input: {
  request: Request;
  auth: Sim2RealAuthPort;
  owner: string | undefined;
  model: Sim2RealModelRecord;
  parsed: ParsedRunRequest;
}): Promise<RunBackendOutcome> {
  const { request, auth, owner, model, parsed } = input;
  const { backend, taskId, training, resumeFrom, idempotencyKey, computeResourceId } = parsed;
  const browserSupported = model.manifest.simulator.backends.includes('browser');
  const robogoSupported = model.manifest.simulator.backends.includes('robogo');
  const localSupported = model.manifest.simulator.backends.includes('local');
  const integrations = simulatorIntegration();
  // Built-in OriginBot uses the platform's lightweight browser adapter. It is
  // deliberately independent from the optional MicroDuck service so a user
  // can start simulation and training before attaching real hardware.
  const browserIntegration =
    model.manifest.robot.id === 'originbot'
      ? {
          available: true,
          entryUrl: model.manifest.simulator.entryUrl || '/originbot-sim/',
          reason: 'OriginBot 浏览器仿真适配器已内置。',
        }
      : integrations.browser;
  const isBuiltin = model.builtin === true;
  const failedSummary = (kind: 'robogo' | 'local') =>
    kind === 'robogo'
      ? 'RoboGo runner 拒绝或无法启动训练；不会自动重试，避免重复计费。'
      : '本地训练 runner 拒绝或无法启动训练；不会自动重试。';
  const unknownSummary = (kind: 'robogo' | 'local') =>
    kind === 'robogo'
      ? 'RoboGo runner 请求结果未确认；任务保留排队状态以避免重复计费。若 runner 可能已受理，请确认 externalRunId 后使用对账接口。'
      : '本地训练 runner 请求结果未确认；任务保留排队状态以避免重复启动。若 worker 可能已受理，请确认 externalRunId 后使用对账接口。';
  const accountIdFor = () =>
    String(
      auth.resolvePrincipal(request)?.accountId ??
        owner ??
        (!auth.isMultiUserDeployment() ? 'local-dev' : ''),
    ).trim();

  if (backend === 'contract') {
    return {
      status: 'completed',
      summary: '模型契约校验完成；这一步不运行模型，也不接触设备。',
      metrics: {
        contractValid: true,
        observationSize: model.manifest.contract.observationSize,
        actionSize: model.manifest.contract.actionSize,
      },
    };
  }
  if (backend === 'browser' && browserSupported && isBuiltin && browserIntegration.available) {
    return {
      status: 'ready',
      summary: '官方参考策略已准备好在浏览器 MicroDuck 仿真中运行。',
      // Use the integration's public entry so a reverse-proxy prefix such
      // as /sim2real is preserved for API/CLI consumers as well as the SPA.
      launchUrl:
        browserIntegration.entryUrl || model.manifest.simulator.entryUrl || '/mujoco/microduck/',
    };
  }
  if (backend === 'browser' && browserSupported && isBuiltin) {
    return {
      status: 'blocked',
      summary: browserIntegration.reason || '浏览器仿真资源尚未挂载。',
    };
  }
  if (backend === 'browser' && browserSupported) {
    return {
      status: 'blocked',
      summary: '该用户模型已登记，但当前网页仿真仍使用固定官方策略，尚未允许动态替换制品。',
    };
  }
  if (backend === 'robogo' && robogoSupported && integrations.robogo.available) {
    const accountId = accountIdFor();
    if (!accountId) {
      return {
        status: 'queued',
        summary: 'RoboGo runner 已配置，但当前会话没有可用账号；任务只登记，未启动训练。',
      };
    }
    const requestToken = auth.resolveAccessToken(request);
    if (auth.isMultiUserDeployment() && !requestToken) {
      return {
        status: 'blocked',
        summary: '共享部署未收到当前账号的 RoboGo 短期令牌；任务只登记，未向 runner 发送请求。',
      };
    }
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
      return {
        status: launched.status,
        summary:
          launched.message ||
          'RoboGo 训练已' +
            (launched.status === 'completed'
              ? '完成'
              : launched.status === 'running'
                ? '启动'
                : '排队') +
            '；不会在网页层直接驱动电机。',
        ...(launched.externalRunId ? { externalRunId: launched.externalRunId } : {}),
        ...(launched.mock === true ? { mock: true } : {}),
        ...(launched.launchUrl ? { launchUrl: launched.launchUrl } : {}),
        ...(launched.checkpoint ? { checkpoint: launched.checkpoint } : {}),
        ...(launched.artifact ? { artifact: launched.artifact } : {}),
        ...(launched.metrics ? { metrics: launched.metrics } : {}),
        ...(launched.taskEvaluation ? { taskEvaluation: launched.taskEvaluation } : {}),
      };
    } catch (error) {
      // A timeout/connection reset is ambiguous: the runner may have
      // accepted the job even though its response never reached us. Keep
      // only that class of failure queued so an operator can reconcile the
      // external id instead of making a duplicate retry.
      return {
        status: isSim2RealRunnerOutcomeUnknown(error) ? 'queued' : 'failed',
        summary: isSim2RealRunnerOutcomeUnknown(error)
          ? unknownSummary('robogo')
          : failedSummary('robogo'),
      };
    }
  }
  // A user-owned compute resource carries its own worker URL/token and can
  // be used even when the deployment-wide default local runner is absent or
  // deliberately blocked.  The request adapter still re-validates the URL
  // and bearer before any network side effect.
  if (
    backend === 'local' &&
    localSupported &&
    (integrations.local.available || Boolean(computeResourceId))
  ) {
    const accountId = accountIdFor();
    if (!accountId) {
      return {
        status: 'queued',
        summary: '本地训练 runner 已配置，但当前会话没有可用账号；任务只登记，未启动训练。',
      };
    }
    const selectedResource = computeResourceId
      ? await getSim2RealComputeResourceSecret(computeResourceId, owner)
      : null;
    if (computeResourceId && !selectedResource) {
      return { status: 'blocked', summary: '所选 GPU 训练资源不存在，或不属于当前账号。' };
    }
    // A local-agent resource is deliberately browser-relayed. The platform
    // server cannot reach a user's 127.0.0.1, so reserve the run and let the
    // browser submit the normalized payload to the Agent instead.
    if (selectedResource?.resource.source === 'local-agent') {
      return {
        status: 'queued',
        summary: '训练记录已建立，等待用户电脑上的 Local GPU Agent 提交任务。',
        relayAgentUrl: selectedResource.resource.runnerUrl.replace(/\/train\/?$/, ''),
      };
    }
    const resourceHealthFailure = selectedResource
      ? computeResourceHealthFailure(selectedResource.resource)
      : null;
    if (computeResourceId && resourceHealthFailure) {
      return {
        status: 'blocked',
        summary:
          resourceHealthFailure === 'stale'
            ? `所选 GPU 训练资源的健康检查已超过 ${sim2RealComputeHealthTtlSeconds()} 秒；请重新测试连接。`
            : '所选 GPU 训练资源尚未通过最近一次健康检查；请先测试连接并确认在线。',
      };
    }
    const selectedRunner = computeResourceId
      ? {
          // Pass explicit values, including an empty token, so a deleted or
          // redacted resource can never fall back to deployment-wide env vars.
          runnerUrl: selectedResource!.resource.runnerUrl,
          runnerToken: selectedResource!.runnerToken ?? '',
        }
      : {};
    try {
      const launched = await requestLocalTraining({
        accountId,
        manifest: model.manifest,
        training,
        resumeFrom,
        taskId: taskId || undefined,
        idempotencyKey,
        ...selectedRunner,
      });
      return {
        status: launched.status,
        summary:
          launched.message ||
          '本地服务器训练已' +
            (launched.status === 'completed'
              ? '完成'
              : launched.status === 'running'
                ? '启动'
                : '排队') +
            '；训练进程由受控 worker 管理。',
        ...(launched.externalRunId ? { externalRunId: launched.externalRunId } : {}),
        ...(launched.mock === true ? { mock: true } : {}),
        ...(launched.launchUrl ? { launchUrl: launched.launchUrl } : {}),
        ...(launched.checkpoint ? { checkpoint: launched.checkpoint } : {}),
        ...(launched.artifact ? { artifact: launched.artifact } : {}),
        ...(launched.metrics ? { metrics: launched.metrics } : {}),
        ...(launched.taskEvaluation ? { taskEvaluation: launched.taskEvaluation } : {}),
      };
    } catch (error) {
      // Treat only transport/ambiguous responses as outcome-unknown;
      // deterministic configuration or 4xx rejection can be terminal.
      return {
        status: isSim2RealRunnerOutcomeUnknown(error) ? 'queued' : 'failed',
        summary: isSim2RealRunnerOutcomeUnknown(error)
          ? unknownSummary('local')
          : failedSummary('local'),
      };
    }
  }
  return {
    status: 'blocked',
    summary:
      backend === 'robogo'
        ? 'RoboGo runner 尚未配置，任务未启动。'
        : backend === 'local'
          ? '本地训练 runner 尚未配置，任务未启动。'
          : '该模型没有声明 browser 仿真后端。',
  };
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
  /** 'present' only when the fixed probe found hbdk-sim + a runtime tool. */
  bpuToolchain: 'present' | 'missing' | '';
};

function parsePreflightOutput(output: string): {
  checks: PreflightCheck;
  valid: boolean;
  reason: string;
} {
  // `runOnDevice` applies its own stdout limit, but this parser is also called
  // from injected adapters and must remain bounded at its trust boundary.
  const text = String(output ?? '').slice(0, 12_000);
  const begin = text.indexOf(PREFLIGHT_BEGIN);
  const end = text.indexOf(PREFLIGHT_END, begin + PREFLIGHT_BEGIN.length);
  const empty: PreflightCheck = {
    arch: '',
    kernel: '',
    python3: '',
    tros: '',
    diskBytes: null,
    bpuToolchain: '',
  };
  if (begin < 0 || end < 0 || end <= begin) {
    return { checks: empty, valid: false, reason: '板端预检缺少完整的协议标记。' };
  }
  const fields = new Map<string, string>();
  for (const line of text.slice(begin + PREFLIGHT_BEGIN.length, end).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line
      .slice(0, separator)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 64);
    const value = line
      .slice(separator + 1)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 512);
    if (key) fields.set(key, value);
  }
  const bpuField = fields.get('bpu_toolchain') || '';
  const checks: PreflightCheck = {
    arch: fields.get('arch') || '',
    kernel: fields.get('kernel') || '',
    python3: fields.get('python3') || '',
    tros: fields.get('tros') || '',
    diskBytes: (() => {
      const value = Number(fields.get('disk_bytes'));
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    })(),
    bpuToolchain: bpuField === 'present' ? 'present' : bpuField === 'missing' ? 'missing' : '',
  };
  const archOk = /^(?:aarch64|arm64)$/i.test(checks.arch);
  const kernelOk = /^[^\u0000-\u001f\u007f\r\n]{1,160}$/.test(checks.kernel);
  const pythonOk = /^\/[A-Za-z0-9._+@%=-]{1,511}(?:\/[A-Za-z0-9._+@%=-]{1,511})*$/.test(
    checks.python3,
  );
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
  return {
    checks,
    valid: true,
    reason:
      checks.bpuToolchain === 'present'
        ? '板端预检协议和基础环境检查通过；BPU 工具链（hbdk-sim + 运行时工具）已就位。'
        : checks.bpuToolchain === 'missing'
          ? '板端预检协议和基础环境检查通过；未探测到 BPU 工具链，本部署继续按 CPU ONNX 制品下发。'
          : '板端预检协议和基础环境检查通过。',
  };
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
  /**
   * Optional ops-event hook for telemetry ingest failures. Passed through to
   * the telemetry routes so an external reporter can observe storage errors
   * without the route module importing any transport.
   */
  onTelemetryIngestFailure?: Sim2RealTelemetryRouteDeps['onIngestFailure'];
}

function normalizeApiPrefix(value: string | undefined): string {
  const prefix = String(value ?? SIM2REAL_API_PREFIX).trim();
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(prefix)) {
    throw new Error(`Invalid Sim2Real API prefix: ${prefix}`);
  }
  return prefix;
}

type MutationAccess = Sim2RealPermission | 'edit-or-operate' | null;

function requestPathname(request: Request): string {
  const raw = String(request.path || request.originalUrl || request.url || '');
  return raw.split('?', 1)[0].toLowerCase();
}

/**
 * Map mutating HTTP calls to the least privilege they need.  The router is
 * shared by the legacy and versioned prefixes, so this lives at the common
 * boundary instead of relying on every resource module to remember a role
 * check.  Read-only POSTs (validation and the station command allow-list)
 * stay available to viewers; emergency stops remain reachable so a safety
 * action can never be blocked by an expired role claim.
 */
function mutationAccess(request: Request): MutationAccess {
  const method = String(request.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  const pathname = requestPathname(request);
  if (pathname.endsWith('/models/validate') || pathname.endsWith('/board-station/commands')) {
    return SIM2REAL_PERMISSIONS.read;
  }
  if (
    pathname.endsWith('/board-station/drive/stop') ||
    pathname.endsWith('/board-station/policy/stop')
  ) {
    return null;
  }
  // Human approval is a governance action. Operators can prepare and execute
  // a plan, while only owner/admin principals may authorize it in a shared
  // deployment.
  if (/\/deployments\/[^/]+\/approval$/.test(pathname)) {
    return SIM2REAL_PERMISSIONS.approve;
  }
  // Loading/staging changes the selected policy but does not enable motion;
  // either an editor or an operator may perform that preparation step.
  if (/\/board-station\/policy\/(?:load|stage)$/.test(pathname)) {
    return 'edit-or-operate';
  }
  // These paths can reach a board, a runner, or a deployment target.
  if (
    /\/(?:deployments|telemetry|board-station|device-connections|local-bridge)(?:\/|$)/.test(
      pathname,
    )
  ) {
    return SIM2REAL_PERMISSIONS.operate;
  }
  // Training, cancellation, reconciliation and evaluation are operational
  // actions; permit either the editor or operator role to keep the workspace
  // useful while still excluding a read-only viewer.
  if (/\/runs(?:\/|$)/.test(pathname)) return 'edit-or-operate';
  return SIM2REAL_PERMISSIONS.edit;
}

function enforceMutationAccess(
  request: Request,
  response: Response,
  auth: Sim2RealAuthPort,
): boolean {
  if (!auth.isMultiUserDeployment()) return true;
  const access = mutationAccess(request);
  if (access === null) return true;
  const principal = auth.resolvePrincipal(request);
  // Let the resource handler produce the canonical authentication response
  // when there is no principal; this preserves its owner-scope semantics and
  // avoids leaking whether a resource exists.
  if (!principal) return true;
  const allowed =
    access === 'edit-or-operate'
      ? principalCan(principal, SIM2REAL_PERMISSIONS.edit) ||
        principalCan(principal, SIM2REAL_PERMISSIONS.operate)
      : principalCan(principal, access);
  if (allowed) return true;
  noStore(response);
  sendApiError(
    response,
    403,
    'SIM2REAL_PERMISSION_DENIED',
    '当前账号没有执行此操作的权限。请联系项目管理员或切换到具备相应角色的账号。',
    { retryable: false, permission: access },
  );
  return false;
}

/**
 * Auto-attach a completed local run's evaluation telemetry to the replay
 * pipeline. The starter engine already records hard-envelope policy rollouts
 * (telemetry.jsonl) while evaluating; without this the operator had to
 * re-record evidence by hand before the run page could show a replay.
 * Idempotency: the append is keyed by a deterministic idempotency key derived
 * from the run, so a repeated status poll or a reconcile after completion
 * can never duplicate chunks. Any failure is logged and swallowed — the
 * status response must not fail because replay evidence is unavailable.
 */
async function autoAttachEvaluationTelemetry(
  run: Sim2RealRunRecord,
  owner: string | undefined,
  isMultiUser: boolean,
  resolveRunner: (
    computeResourceId: string | undefined,
  ) => Promise<{ runnerUrl: string; runnerToken: string } | null>,
): Promise<void> {
  if (run.backend !== 'local' || !run.externalRunId) return;
  try {
    const workerAccount = owner ?? (isMultiUser ? '' : 'local-dev');
    if (!workerAccount) return;
    const runner = await resolveRunner(run.computeResourceId);
    const telemetry = await fetchLocalRunTelemetry({
      accountId: workerAccount,
      externalRunId: run.externalRunId,
      ...(runner ? { runnerUrl: runner.runnerUrl, runnerToken: runner.runnerToken } : {}),
    });
    if (!telemetry || telemetry.sampleCount === 0) return;
    const CHUNK_SIZE = 5_000;
    for (let offset = 0; offset < telemetry.lines.length; offset += CHUNK_SIZE) {
      const samples = telemetry.lines
        .slice(offset, offset + CHUNK_SIZE)
        .map((line) => JSON.parse(line)) as Sim2RealTelemetrySample[];
      await appendSim2RealTelemetryWithResult(
        {
          runId: run.id,
          modelId: run.modelId,
          source: 'browser',
          ...(run.contractId ? { contractId: run.contractId } : {}),
          samples,
          idempotencyKey:
            offset === 0
              ? `eval-replay-${run.id}`
              : `eval-replay-${run.id}-${Math.floor(offset / CHUNK_SIZE)}`,
        },
        owner,
      );
    }
    console.log(
      `[sim2real] auto-attached ${telemetry.sampleCount} evaluation samples to run ${run.id}`,
    );
  } catch (error) {
    console.warn(
      `[sim2real] evaluation telemetry auto-attach failed for ${run.id}`,
      redactInternalError(error),
    );
  }
}

export function createSim2RealRouter(
  deps: { runOnDevice?: RunOnDevice; auth?: Sim2RealAuthPort } = {},
  options: Sim2RealRouterOptions = {},
): Router {
  const router = Router();

  const prefix = normalizeApiPrefix(options.prefix);
  const api = (suffix: string): string => `${prefix}${suffix}`;

  // Public, immutable seed assets for the first task-pack flywheel.
  router.get(
    api('/task-packs/:taskId/failure-cases'),
    wrapAsync(async (request, response) => {
      noStore(response);
      if (String(request.params.taskId || '') !== 'goal-navigation-clear-arena') {
        response.status(404).json({ ok: false, error: 'TASK_PACK_NOT_FOUND' });
        return;
      }
      try {
        // Resolve the immutable seed next to this module rather than through
        // process.cwd().  A compiled release runs from the repository/release
        // root while this route lives under dist-server/server/routes; the
        // build copies `data/failure-cases` into dist-server so both source
        // tests and dist-only deployments resolve the same reviewed asset.
        const seedFile = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../data/failure-cases/goal-navigation-seed.json',
        );
        const file = await readFile(seedFile, 'utf8');
        response.json({ ok: true, ...JSON.parse(file) });
      } catch {
        response.status(503).json({ ok: false, error: 'TASK_PACK_ASSET_UNAVAILABLE' });
      }
    }),
  );
  const auth = deps.auth ?? LOCAL_SIM2REAL_AUTH;
  const visibleDevicesForAuth = (owner?: string) =>
    visibleDevices(owner, auth.isMultiUserDeployment());

  // Resolve the worker coordinates for a run's compute resource, or null when
  // the run should not reach a worker at all (deleted resource, failing
  // health, or no resource configured). Shared by the artifact staging path
  // and the evaluation-telemetry auto-attach below.
  const resolveRunRunner = async (
    computeResourceId: string | undefined,
    owner: string | undefined,
  ): Promise<{ runnerUrl: string; runnerToken: string } | null> => {
    if (!computeResourceId) return null;
    const selectedResource = await getSim2RealComputeResourceSecret(computeResourceId, owner);
    // A run tied to a deleted resource must never silently download from the
    // deployment-wide worker; doing so could stage a different run's data
    // under the same external id.
    if (!selectedResource) return null;
    if (computeResourceHealthFailure(selectedResource.resource)) return null;
    return {
      runnerUrl: selectedResource.resource.runnerUrl,
      runnerToken: selectedResource.runnerToken ?? '',
    };
  };

  // Auto-attach the engine's own evaluation telemetry when a run first
  // reaches a terminal state through this router's status paths. Idempotent
  // via the store's idempotency key, fail-closed via the fetch's nulls.
  const attachEvalTelemetryForRun = (run: Sim2RealRunRecord, owner: string | undefined) =>
    autoAttachEvaluationTelemetry(run, owner, auth.isMultiUserDeployment(), (computeResourceId) =>
      resolveRunRunner(computeResourceId, owner),
    );

  // One shared guard covers every route registered below, including both the
  // core handlers and the telemetry/device sub-routers.
  router.use((request, response, next) => {
    if (enforceMutationAccess(request, response, auth)) next();
  });

  router.get(
    api('/overview'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const principal = auth.resolvePrincipal(request);
      const selectedProductId = requestedProduct(request.query.productId);
      noStore(response);
      const simulator = simulatorIntegration();
      const [
        models,
        runs,
        deployments,
        devices,
        robogo,
        localWorker,
        computeResources,
        artifacts,
        evaluations,
      ] = await Promise.all([
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
        listSim2RealComputeResources(owner),
        listSim2RealArtifacts(owner),
        listSim2RealEvaluations(owner),
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
        // Promotion-flow surfaces: the first-class registry (artifact
        // lifecycle) and evaluation evidence are what the deploy view's
        // candidate → validated → published chain renders. Capped like the
        // other lists so one account cannot bloat every overview poll.
        artifacts: artifacts.slice(0, 100),
        evaluations: evaluations.slice(0, 100),
        computeResources,
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

  router.get(
    api('/workspace-summary'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const [models, runs, deployments, devices, projects, datasets] = await Promise.all([
        listSim2RealModels(owner),
        listSim2RealRuns(owner),
        listSim2RealDeployments(owner),
        visibleDevicesForAuth(owner),
        listSim2RealProjects(owner),
        listSim2RealDatasets(owner),
      ]);
      const activeRunStatuses: readonly Sim2RealRunStatus[] = ['queued', 'running'];
      const activeDeploymentStatuses: readonly Sim2RealDeploymentRecord['status'][] = [
        'planned',
        'running',
      ];
      const latestRun = latestByTimestamp(runs, (run) => run.createdAt);
      const latestDeployment = latestByTimestamp(deployments, (deployment) => deployment.updatedAt);
      response.json({
        ok: true,
        schemaVersion: SIM2REAL_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        counts: {
          models: models.length,
          projects: projects.length,
          datasets: datasets.length,
          runs: runs.length,
          activeRuns: runs.filter((run) => activeRunStatuses.includes(run.status)).length,
          deployments: deployments.length,
          activeDeployments: deployments.filter((deployment) =>
            activeDeploymentStatuses.includes(deployment.status),
          ).length,
          devices: devices.length,
          connectedDevices: devices.filter((device) => device.status === 'connected').length,
          detectedDevices: devices.filter((device) => Boolean(device.boardPlatform)).length,
        },
        latest: {
          run: workspaceLatestRun(latestRun),
          deployment: workspaceLatestDeployment(latestDeployment),
        },
      });
    }),
  );

  registerSim2RealWorkspaceRoutes(
    router,
    {
      requestOwner: (request, response) => requestOwner(request, response, auth),
      storageError,
    },
    { prefix },
  );

  // ---- granular feedback + workspace notices (Amershi G15 / G18) ----------
  // Feedback is operational telemetry only: it never feeds promotion or
  // release gates, so it needs the read permission only and degrades closed
  // contract values instead of rejecting stale clients.
  router.post(
    api('/feedback'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const noteRaw = String(body.note ?? '');
      if (noteRaw.length > FEEDBACK_NOTE_MAX_CHARS) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_FEEDBACK',
          `反馈备注超过 ${FEEDBACK_NOTE_MAX_CHARS} 字上限。`,
          { retryable: false },
        );
        return;
      }
      const runIdRaw = String(body.runId ?? '');
      if (runIdRaw.length > 120) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_FEEDBACK', 'runId 过长。', {
          retryable: false,
        });
        return;
      }
      const { record, degraded } = normalizeSim2RealFeedback({
        surface: String(body.surface ?? ''),
        verdict: String(body.verdict ?? ''),
        note: noteRaw,
        ...(runIdRaw ? { runId: runIdRaw } : {}),
      });
      try {
        const saved = await createSim2RealFeedback(record, owner);
        response.status(201).json({
          ok: true,
          feedback: saved,
          ...(degraded.surface || degraded.verdict ? { degraded } : {}),
        });
      } catch (error) {
        storageError(request, response, error, 'sim2real-feedback-create');
      }
    }),
  );

  router.get(
    api('/feedback'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      try {
        const feedback = await listSim2RealFeedbackRecords(owner);
        response.json({
          ok: true,
          feedback,
          surfaces: FEEDBACK_SURFACES,
          verdicts: FEEDBACK_VERDICTS,
          noteMaxChars: FEEDBACK_NOTE_MAX_CHARS,
        });
      } catch (error) {
        storageError(request, response, error, 'sim2real-feedback-list');
      }
    }),
  );

  // Reliance summary (Bakusevych #38 / Amershi G17): aggregates only — counts
  // per surface plus accuracy share — so users can see what their feedback
  // added up to. Same owner scoping as the raw list; never a release input.
  router.get(
    api('/feedback/summary'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      try {
        const summary = await summarizeSim2RealFeedbackRecords(owner);
        response.json({ ok: true, summary });
      } catch (error) {
        storageError(request, response, error, 'sim2real-feedback-summary');
      }
    }),
  );

  // Workspace notices are served, never stored: the package version is the
  // release identity and the readiness snapshot is the health identity, so
  // there is no second source of truth that can drift. Anonymous healthz
  // already exists; this route adds the operator-facing packaging.
  router.get(
    api('/notices'),
    wrapAsync(async (request, response) => {
      requestOwnerOptional(request, response, auth);
      noStore(response);
      const storage = await sim2RealStorageReadiness();
      const degraded = storage.writable ? [] : ['storage-not-configured'];
      const version = workspacePackageVersion();
      response.json({
        ok: true,
        notices: sim2RealWorkspaceNotices({
          version,
          degraded,
          degradedMessage: storage.writable
            ? undefined
            : '台账存储不可写，训练与评测记录暂不能保存',
        }),
      });
    }),
  );

  registerSim2RealAuditRoutes(
    router,
    {
      auth,
      requestOwner: (request, response) => requestOwner(request, response, auth),
    },
    { prefix },
  );

  // User-owned local GPU resources. Credentials stay in the server ledger;
  // list responses only expose whether a token is configured.
  router.get(
    api('/compute-resources'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      response.json({ ok: true, computeResources: await listSim2RealComputeResources(owner) });
    }),
  );

  router.post(
    api('/compute-resources'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const name = String(body.name ?? '').trim();
      const runnerUrlRaw = String(body.runnerUrl ?? '').trim();
      const runnerToken = String(body.runnerToken ?? '').trim();
      const source = body.source === 'local-agent' ? 'local-agent' : 'server-runner';
      if (
        !name ||
        name.length > 120 ||
        safeComputeHealthText(name, 120) !== name ||
        !runnerUrlRaw
      ) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_COMPUTE_RESOURCE',
          '名称和 Runner 地址必填。',
          { retryable: false },
        );
        return;
      }
      if (runnerUrlRaw.length > 2048) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_COMPUTE_RESOURCE_URL', 'Runner 地址过长。', {
          retryable: false,
        });
        return;
      }
      let runnerUrl: string;
      try {
        runnerUrl = normalizeRunnerUrl(runnerUrlRaw, { localHttp: true });
        const parsedUrl = new URL(runnerUrl);
        const pathname = parsedUrl.pathname.replace(/\/+$/, '');
        if (source === 'local-agent' && pathname === '/proxy') {
          parsedUrl.pathname = '/proxy/train';
          runnerUrl = parsedUrl.toString();
        } else if (!pathname.endsWith('/train'))
          throw new Error('runner path must end with /train');
        if (
          source === 'local-agent' &&
          !['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname.replace(/^\[|\]$/g, ''))
        ) {
          throw new Error('local-agent must use a loopback URL');
        }
      } catch {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_COMPUTE_RESOURCE_URL',
          'Runner 地址必须是合法的 HTTP(S) /train 地址。',
          { retryable: false },
        );
        return;
      }
      const tokenError = computeRunnerTokenError(runnerUrl, runnerToken);
      if (tokenError) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_COMPUTE_RESOURCE_TOKEN', tokenError, {
          retryable: false,
        });
        return;
      }
      const maxConcurrentJobs = Number(body.maxConcurrentJobs ?? 1);
      if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || maxConcurrentJobs > 32) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_COMPUTE_RESOURCE',
          '并发任务数必须是 1 到 32。',
          { retryable: false },
        );
        return;
      }
      try {
        const resource = await createSim2RealComputeResource(
          {
            name,
            kind: 'local-gpu',
            source,
            runnerUrl,
            ...(source === 'server-runner' && runnerToken ? { runnerToken } : {}),
            status: 'unknown',
            maxConcurrentJobs,
            message: '尚未测试连接。',
          },
          owner,
        );
        response.status(201).json({ ok: true, computeResource: resource });
      } catch (error) {
        storageError(request, response, error, 'sim2real-compute-resource-create');
      }
    }),
  );

  router.patch(
    api('/compute-resources/:id'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const patch: Record<string, unknown> = {};
      if (body.source !== undefined) {
        if (body.source !== 'local-agent' && body.source !== 'server-runner') {
          sendApiError(response, 400, 'SIM2REAL_INVALID_COMPUTE_RESOURCE', '算力资源来源无效。', {
            retryable: false,
          });
          return;
        }
        patch.source = body.source;
      }
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name || name.length > 120 || safeComputeHealthText(name, 120) !== name) {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_COMPUTE_RESOURCE',
            '名称不能为空、不能超过 120 个字符或包含控制字符。',
            { retryable: false },
          );
          return;
        }
        patch.name = name;
      }
      if (body.runnerToken !== undefined) {
        const runnerToken = String(body.runnerToken).trim();
        if (!localRunnerTokenFormatValid(runnerToken)) {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_COMPUTE_RESOURCE_TOKEN',
            'Runner token 不能包含控制字符，且长度不能超过 4096 字节。',
            { retryable: false },
          );
          return;
        }
        patch.runnerToken = runnerToken;
      }
      if (body.runnerUrl !== undefined) {
        const runnerUrlRaw = String(body.runnerUrl).trim();
        if (!runnerUrlRaw || runnerUrlRaw.length > 2048) {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_COMPUTE_RESOURCE_URL',
            'Runner 地址不能为空且不能超过 2048 个字符。',
            { retryable: false },
          );
          return;
        }
        try {
          const normalized = normalizeRunnerUrl(runnerUrlRaw, { localHttp: true });
          const parsedUrl = new URL(normalized);
          const pathname = parsedUrl.pathname.replace(/\/+$/, '');
          if (!pathname.endsWith('/train')) throw new Error('runner path must end with /train');
          patch.runnerUrl = normalized;
        } catch {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_COMPUTE_RESOURCE_URL',
            'Runner 地址无效。',
            { retryable: false },
          );
          return;
        }
      }
      if (body.maxConcurrentJobs !== undefined) {
        const maxConcurrentJobs = Number(body.maxConcurrentJobs);
        if (
          !Number.isInteger(maxConcurrentJobs) ||
          maxConcurrentJobs < 1 ||
          maxConcurrentJobs > 32
        ) {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_COMPUTE_RESOURCE',
            '并发任务数必须是 1 到 32。',
            { retryable: false },
          );
          return;
        }
        patch.maxConcurrentJobs = maxConcurrentJobs;
      }
      if (
        body.status !== undefined &&
        ['online', 'offline', 'unknown'].includes(String(body.status))
      ) {
        patch.status = String(body.status);
      }
      if (body.message !== undefined) patch.message = safeComputeHealthText(body.message, 240);
      if (body.gpuName !== undefined) patch.gpuName = safeComputeHealthText(body.gpuName, 160);
      if (body.cuda === true || body.cuda === false) patch.cuda = body.cuda;
      if (
        body.vramMb !== undefined &&
        Number.isFinite(Number(body.vramMb)) &&
        Number(body.vramMb) >= 0
      ) {
        patch.vramMb = Math.min(Number(body.vramMb), 10_000_000);
      }
      if (body.lastCheckedAt !== undefined)
        patch.lastCheckedAt = String(body.lastCheckedAt).slice(0, 64);

      // Resolve the effective URL/token before writing.  Omitting a token on
      // PATCH preserves the existing secret; explicitly sending an empty
      // token clears it and therefore fails closed for remote/production URLs.
      const existing = await getSim2RealComputeResourceSecret(String(request.params.id), owner);
      if (!existing) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND' });
        return;
      }
      const effectiveUrl = String(patch.runnerUrl ?? existing.resource.runnerUrl);
      const effectiveToken =
        patch.runnerToken !== undefined
          ? String(patch.runnerToken)
          : String(existing.runnerToken ?? '');
      const effectiveSource = String(patch.source ?? existing.resource.source ?? 'server-runner');
      if (effectiveSource === 'local-agent') {
        try {
          const parsed = new URL(effectiveUrl);
          const pathName = parsed.pathname.replace(/\/+$/, '');
          if (
            !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.replace(/^\[|\]$/g, '')) ||
            pathName !== '/proxy/train'
          )
            throw new Error('invalid local agent');
        } catch {
          sendApiError(
            response,
            400,
            'SIM2REAL_INVALID_COMPUTE_RESOURCE_URL',
            '本地 Agent 必须使用 loopback /proxy/train 地址。',
            { retryable: false },
          );
          return;
        }
      }
      const tokenError = computeRunnerTokenError(effectiveUrl, effectiveToken);
      if (tokenError) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_COMPUTE_RESOURCE_TOKEN', tokenError, {
          retryable: false,
        });
        return;
      }
      const resource = await updateSim2RealComputeResource(
        String(request.params.id),
        patch as never,
        owner,
      );
      if (!resource) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND' });
        return;
      }
      response.json({ ok: true, computeResource: resource });
    }),
  );

  router.delete(
    api('/compute-resources/:id'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const deleted = await deleteSim2RealComputeResource(String(request.params.id), owner);
      if (!deleted) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND' });
        return;
      }
      response.json({ ok: true, deleted: true });
    }),
  );

  router.post(
    api('/compute-resources/:id/test'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const secret = await getSim2RealComputeResourceSecret(String(request.params.id), owner);
      if (!secret) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND' });
        return;
      }
      const checkedAt = new Date().toISOString();
      let patch: Record<string, unknown> = {
        status: 'offline',
        message: '尚未完成 Worker 健康检查。',
        lastCheckedAt: checkedAt,
      };
      const runnerUrl = String(secret.resource.runnerUrl);
      const runnerToken = String(secret.runnerToken ?? '').trim();
      if (secret.resource.source === 'local-agent') {
        const updated = await updateSim2RealComputeResource(
          secret.resource.id,
          {
            status: 'unknown',
            message: '本地 Agent 资源由浏览器直连，请在当前网页重新检查。',
            lastCheckedAt: checkedAt,
          },
          owner,
        );
        response.json({ ok: true, computeResource: updated, connected: false, browserRelay: true });
        return;
      }
      const tokenError = computeRunnerTokenError(runnerUrl, runnerToken);
      if (tokenError) {
        // Persist the failed state so the UI cannot mistake a configured but
        // unauthenticated resource for an available GPU.  Crucially, do not
        // make a network request with a missing/weak credential.
        patch = {
          status: 'offline',
          message: tokenError,
          lastCheckedAt: checkedAt,
        };
      } else {
        try {
          const parsed = new URL(normalizeRunnerUrl(runnerUrl, { localHttp: true }));
          const pathName = parsed.pathname.replace(/\/+$/, '');
          if (!pathName.endsWith('/train')) throw new Error('runner path must end with /train');
          parsed.pathname = pathName.slice(0, -'/train'.length) + '/healthz';
          parsed.search = '';
          parsed.hash = '';
          const headers: Record<string, string> = { accept: 'application/json' };
          if (runnerToken) headers.authorization = `Bearer ${runnerToken}`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5_000);
          try {
            const result = await fetch(parsed, {
              headers,
              redirect: 'error',
              signal: controller.signal,
            });
            let bodyText: string;
            let bodyReadable = true;
            try {
              bodyText = await boundedComputeHealthText(result);
            } catch {
              bodyReadable = false;
              bodyText = '';
              patch = {
                status: 'offline',
                message: 'Worker 健康响应过大或无法读取，已拒绝。',
                lastCheckedAt: checkedAt,
              };
            }
            if (bodyReadable) {
              const payload = result.ok ? parseComputeHealthPayload(bodyText) : null;
              const healthy = result.ok && payload !== null;
              patch = {
                status: healthy ? 'online' : 'offline',
                message: healthy
                  ? 'GPU Worker 连接正常。'
                  : result.ok
                    ? 'Worker 返回无效健康响应。'
                    : `Worker 返回 HTTP ${result.status}。`,
                lastCheckedAt: checkedAt,
                ...(payload?.cuda == null ? {} : { cuda: payload.cuda }),
                ...(payload?.gpuName ? { gpuName: payload.gpuName } : {}),
                ...(payload?.vramMb == null ? {} : { vramMb: payload.vramMb }),
                ...(payload?.maxConcurrentJobs == null
                  ? {}
                  : { maxConcurrentJobs: payload.maxConcurrentJobs }),
              };
            }
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          patch = {
            status: 'offline',
            message:
              error instanceof Error && error.name === 'AbortError'
                ? '连接超时：Worker 未在 5 秒内响应。'
                : '连接失败：Worker 不可达或健康响应无效。',
            lastCheckedAt: checkedAt,
          };
        }
      }
      const updated = await updateSim2RealComputeResource(
        secret.resource.id,
        patch as never,
        owner,
      );
      response.json({
        ok: true,
        computeResource: updated,
        connected: updated?.status === 'online',
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
      ...(options.onTelemetryIngestFailure
        ? { onIngestFailure: options.onTelemetryIngestFailure }
        : {}),
    },
    { prefix },
  );

  registerSim2RealBoardStationRoutes(
    router,
    {
      auth,
      requestOwner: (request, response) => requestOwner(request, response, auth),
      visibleDevices: visibleDevicesForAuth,
      resolveDeviceAgentUrl: (deviceId, stationOwner) =>
        deviceConnectionAgentUrl(deviceId, stationOwner),
      getRun: (runId, owner) => getSim2RealRun(runId, owner),
      // Artifact bytes come from the run's own training worker; a run without
      // an external id (remote/cleaned) simply cannot stage, fail-closed.
      fetchRunArtifact: async (run, runOwner) => {
        if (run.backend !== 'local' || !run.externalRunId) return null;
        // The worker gates /runs/:id on the account that submitted the job.
        // Training submission falls back to 'local-dev' in single-user mode,
        // so the artifact fetch must resolve to the same account or the
        // worker will (correctly) refuse the byte read.
        const workerAccount = runOwner ?? (auth.isMultiUserDeployment() ? '' : 'local-dev');
        if (!workerAccount) return null;
        const selectedResource = run.computeResourceId
          ? await getSim2RealComputeResourceSecret(run.computeResourceId, runOwner)
          : null;
        // A run tied to a deleted resource must never silently download from
        // the deployment-wide worker; doing so could stage a different run's
        // artifact under the same external id.
        if (run.computeResourceId && !selectedResource) return null;
        if (run.relayAgentUrl && run.artifact?.sha256) {
          const bytes = await readSim2RealRelayArtifact(run.artifact.sha256);
          return bytes ? { bytes, sha256: run.artifact.sha256 } : null;
        }
        if (
          run.computeResourceId &&
          selectedResource &&
          computeResourceHealthFailure(selectedResource.resource)
        ) {
          return null;
        }
        return fetchLocalRunArtifact({
          accountId: workerAccount,
          externalRunId: run.externalRunId,
          ...(run.computeResourceId
            ? {
                runnerUrl: selectedResource!.resource.runnerUrl,
                runnerToken: selectedResource!.runnerToken ?? '',
              }
            : {}),
        });
      },
    },
    { prefix },
  );

  // Web-managed board connections (Studio 网页版-style device management):
  // SSH coordinates + loopback tunnels + the board-side switch surface.
  registerSim2RealDeviceConnectionRoutes(
    router,
    {
      auth,
      requestOwner: (request, response) => requestOwner(request, response, auth),
    },
    { prefix },
  );

  // Keep the Sim2Real surface independent: the shared Studio Local Bridge
  // protocol is exposed through a Sim2Real-owned API path.
  router.get(
    api('/local-bridge/status'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      void owner;
      const origin = configuredStudioOrigin();
      if (!origin) {
        studioBridgeConfigError(response);
        return;
      }
      const upstream = await fetchStudioBridgeJson(origin, '/api/local-bridge/status', request);
      if (!upstream || !upstream.ok) {
        studioBridgeUpstreamError(response);
        return;
      }
      const projected = projectStudioBridgeStatus(upstream.payload);
      if (!projected) {
        studioBridgeUpstreamError(response);
        return;
      }
      noStore(response);
      response.status(200).json(projected);
    }),
  );
  router.post(
    api('/local-bridge/pairing-code'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      void owner;
      const origin = configuredStudioOrigin();
      if (!origin) {
        studioBridgeConfigError(response);
        return;
      }
      const body = studioPairingRequestBody(request.body);
      if (!body) {
        noStore(response);
        sendApiError(response, 400, 'SIM2REAL_INVALID_BRIDGE_REQUEST', 'Bridge 配对参数无效。', {
          retryable: false,
        });
        return;
      }
      const upstream = await fetchStudioBridgeJson(
        origin,
        '/api/local-bridge/pairing-code',
        request,
        { method: 'POST', body, maxBytes: SIM2REAL_STUDIO_PAIRING_MAX_RESPONSE_BYTES },
      );
      if (!upstream || !upstream.ok) {
        studioBridgeUpstreamError(response);
        return;
      }
      const projected = projectStudioPairing(upstream.payload);
      if (!projected) {
        studioBridgeUpstreamError(response);
        return;
      }
      noStore(response);
      response.status(200).json(projected);
    }),
  );
  router.post(
    api('/local-bridge/devices/:bridgeDeviceId/connect'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const origin = configuredStudioOrigin();
      if (!origin) {
        studioBridgeConfigError(response);
        return;
      }
      const bridgeDeviceId = studioSafeId(request.params?.bridgeDeviceId);
      const body = studioConnectRequestBody(request.body);
      if (!bridgeDeviceId || !body) {
        noStore(response);
        sendApiError(response, 400, 'SIM2REAL_INVALID_BRIDGE_REQUEST', 'Bridge 设备参数无效。', {
          retryable: false,
        });
        return;
      }
      const upstream = await fetchStudioBridgeJson(
        origin,
        `/api/local-bridge/devices/${encodeURIComponent(bridgeDeviceId)}/connect`,
        request,
        { method: 'POST', body },
      );
      if (!upstream || !upstream.ok) {
        studioBridgeUpstreamError(response);
        return;
      }
      const projected = projectStudioConnect(upstream.payload);
      if (!projected) {
        studioBridgeUpstreamError(response);
        return;
      }
      const device = projected.device;
      const bridgeId = studioSafeId(device.bridgeId) || studioSafeId(body.bridgeId);
      if (!bridgeId) {
        studioBridgeUpstreamError(response);
        return;
      }
      try {
        const registered = await upsertBridgeDevice({
          ownerKey: owner ? `sso:${owner}:web` : 'local:default',
          bridgeId,
          bridgeDeviceId,
          name:
            typeof device.name === 'string'
              ? device.name
              : typeof device.label === 'string'
                ? device.label
                : undefined,
          host: String(device.host || '').trim(),
          port: Number(device.port || 22),
          username: typeof device.username === 'string' ? device.username : 'root',
          transport:
            device.transport === 'ssh' ||
            device.transport === 'usb-ethernet' ||
            device.transport === 'serial'
              ? device.transport
              : 'ssh',
          boardPlatform:
            typeof device.boardPlatform === 'string' ? device.boardPlatform : undefined,
          boardModel: typeof device.boardModel === 'string' ? device.boardModel : undefined,
        });
        // `upsertBridgeDevice` preserves legacy registry fields for a stable
        // reconnect. Project the returned record again before it crosses the
        // HTTP boundary so an older row containing credentials can never be
        // reflected into the browser response.
        const publicDevice = studioBridgeDeviceProjection(registered, { requireHost: true });
        if (!publicDevice) {
          studioBridgeUpstreamError(response);
          return;
        }
        projected.response.device = publicDevice;
        noStore(response);
        response.status(200).json(projected.response);
      } catch {
        noStore(response);
        response.status(502).json({
          ok: false,
          error: 'SIM2REAL_DEVICE_REGISTRATION_FAILED',
          code: 'SIM2REAL_DEVICE_REGISTRATION_FAILED',
          message: 'Bridge 已连接，但设备登记失败，请重试。',
          retryable: true,
        });
      }
      return;
    }),
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
        run.externalRunId &&
        !run.relayAgentUrl
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
            const selectedResource = run.computeResourceId
              ? await getSim2RealComputeResourceSecret(run.computeResourceId, owner)
              : null;
            if (run.backend === 'local' && run.computeResourceId && !selectedResource) {
              sendApiError(
                response,
                409,
                'SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND',
                '该运行所选的 GPU 资源已删除或不属于当前账号，拒绝回退到全局 runner。',
                { retryable: false },
              );
              return;
            }
            if (run.backend === 'local' && run.computeResourceId && selectedResource) {
              const healthFailure = computeResourceHealthFailure(selectedResource.resource);
              if (healthFailure === 'stale') {
                sendApiError(
                  response,
                  503,
                  'SIM2REAL_COMPUTE_RESOURCE_HEALTH_STALE',
                  `所选 GPU 资源健康检查已超过 ${sim2RealComputeHealthTtlSeconds()} 秒；状态暂时未知，请先测试连接。`,
                  { retryable: true, retryAfterSeconds: 15 },
                );
                return;
              }
              if (healthFailure === 'not-ready') {
                sendApiError(
                  response,
                  503,
                  'SIM2REAL_COMPUTE_RESOURCE_NOT_READY',
                  '所选 GPU 资源尚未通过健康检查，状态暂时未知，请先测试连接。',
                  { retryable: true, retryAfterSeconds: 15 },
                );
                return;
              }
            }
            const selectedRunner =
              run.backend === 'local' && run.computeResourceId
                ? {
                    runnerUrl: selectedResource!.resource.runnerUrl,
                    runnerToken: selectedResource!.runnerToken ?? '',
                  }
                : {};
            const latest =
              run.backend === 'local'
                ? await requestLocalTrainingStatus({
                    accountId,
                    externalRunId: run.externalRunId,
                    ...selectedRunner,
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
              ...(latest.taskEvaluation ? { taskEvaluation: latest.taskEvaluation } : {}),
              ...(latest.progress ? { progress: latest.progress } : {}),
              ...((latest.status === 'completed' || latest.status === 'failed') && !run.finishedAt
                ? { finishedAt: new Date().toISOString() }
                : {}),
            };
            current = (await updateSim2RealRun(run.id, update, owner)) ?? run;
            // The poll only runs while the ledger copy is queued/running, so a
            // completed status here is always the first observed completion:
            // pull the engine's evaluation telemetry into the replay pipeline
            // so the run page can render it without manual re-recording.
            if (current.status === 'completed') {
              await attachEvalTelemetryForRun(current, owner);
            }
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
                    new Sim2RealError('sim2real_storage_unavailable'),
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
              redactInternalError(error),
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

  router.post(
    api('/runs/:id/relay/claim'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const externalRunId = String(request.body?.externalRunId ?? request.body?.runId ?? '').trim();
      const claimed = await claimSim2RealRunRelay(
        String(request.params.id || ''),
        externalRunId,
        owner,
      );
      if (!claimed) {
        sendApiError(
          response,
          409,
          'SIM2REAL_RELAY_CLAIM_CONFLICT',
          '该浏览器中继运行已被其他页面认领或已结束。',
          { retryable: false },
        );
        return;
      }
      response.json({ ok: true, run: claimed });
    }),
  );

  router.post(
    api('/runs/:id/relay/sync'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const run = await getSim2RealRun(String(request.params.id || ''), owner);
      if (!run || !run.relayAgentUrl) {
        sendApiError(response, 404, 'SIM2REAL_RELAY_RUN_NOT_FOUND', '浏览器中继运行不存在。', {
          retryable: false,
        });
        return;
      }
      const status = String(request.body?.status ?? '').trim();
      if (!['queued', 'running', 'completed', 'failed'].includes(status)) {
        sendApiError(response, 400, 'SIM2REAL_RELAY_STATUS_INVALID', '中继状态无效。', {
          retryable: false,
        });
        return;
      }
      const summary = safeComputeHealthText(
        request.body?.message ?? request.body?.summary ?? '',
        500,
      );
      const patch: Record<string, unknown> = {
        status,
        relayLastSeenAt: new Date().toISOString(),
        ...(summary ? { summary } : {}),
        ...(status === 'completed' || status === 'failed'
          ? { finishedAt: new Date().toISOString() }
          : {}),
      };
      for (const key of [
        'mock',
        'metrics',
        'checkpoint',
        'artifact',
        'taskEvaluation',
        'progress',
      ] as const) {
        const value = request.body?.[key];
        if (value !== undefined && JSON.stringify(value).length <= 100_000) patch[key] = value;
      }
      const updated = await updateSim2RealRun(run.id, patch as never, owner);
      response.json({ ok: true, run: updated });
    }),
  );

  router.post(
    api('/runs/:id/relay/artifact'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      const run = await getSim2RealRun(String(request.params.id || ''), owner);
      const binaryUpload = request.is('application/octet-stream');
      const sha256 = String(
        (binaryUpload ? request.headers['x-artifact-sha256'] : request.body?.sha256) ?? '',
      )
        .trim()
        .toLowerCase();
      const encoded = binaryUpload ? '' : String(request.body?.bytesBase64 ?? '');
      if (
        !run?.relayAgentUrl ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        (!binaryUpload && (!encoded || encoded.length > 70_000_000))
      ) {
        sendApiError(response, 400, 'SIM2REAL_RELAY_ARTIFACT_INVALID', '中继制品数据无效。', {
          retryable: false,
        });
        return;
      }
      let bytes: Buffer;
      if (binaryUpload) {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of request) {
          total += Buffer.byteLength(chunk);
          if (total > 50 * 1024 * 1024) {
            sendApiError(
              response,
              413,
              'SIM2REAL_RELAY_ARTIFACT_TOO_LARGE',
              '中继制品超过 50 MiB 限制。',
              { retryable: false },
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        bytes = Buffer.concat(chunks);
      } else {
        try {
          bytes = Buffer.from(encoded, 'base64');
        } catch {
          sendApiError(response, 400, 'SIM2REAL_RELAY_ARTIFACT_INVALID', '中继制品编码无效。', {
            retryable: false,
          });
          return;
        }
      }
      if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) {
        sendApiError(
          response,
          413,
          'SIM2REAL_RELAY_ARTIFACT_TOO_LARGE',
          '中继制品超过 50 MiB 限制。',
          { retryable: false },
        );
        return;
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== sha256) {
        sendApiError(
          response,
          400,
          'SIM2REAL_RELAY_ARTIFACT_DIGEST_MISMATCH',
          '中继制品校验失败。',
          { retryable: false },
        );
        return;
      }
      await storeSim2RealRelayArtifact(sha256, bytes);
      response.json({ ok: true, sha256, bytes: bytes.length });
    }),
  );

  /**
   * GET /runs/:id/logs?after=N — incremental engine stdout/stderr lines for a
   * local-backend run, proxied from the worker's bounded line ring. This is
   * the operator's live view into training (and the post-mortem when it
   * fails): line numbers are worker-assigned and `after` is the cursor, so a
   * poll returns only the new tail. RoboGo runs have no proxied log channel —
   * the response says so honestly instead of serving an empty success.
   */
  router.get(
    api('/runs/:id/logs'),
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
      if (run.backend !== 'local' || !run.externalRunId) {
        sendApiError(
          response,
          409,
          'SIM2REAL_RUN_LOGS_NOT_AVAILABLE',
          '该运行的引擎日志不可从本平台读取（远端 runner 或 mock 运行没有日志通道）。',
          { retryable: false, details: { runId: run.id, backend: run.backend } },
        );
        return;
      }
      if (run.mock === true) {
        sendApiError(
          response,
          409,
          'SIM2REAL_RUN_LOGS_NOT_AVAILABLE',
          'mock 运行不产生引擎日志。',
          { retryable: false, details: { runId: run.id } },
        );
        return;
      }
      const workerAccount = owner ?? (auth.isMultiUserDeployment() ? '' : 'local-dev');
      if (!workerAccount) {
        sendApiError(response, 401, 'SIM2REAL_AUTH_REQUIRED', '当前会话没有可用账号。', {
          retryable: false,
        });
        return;
      }
      const afterRaw = Number(request.query.after);
      const after = Number.isSafeInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;
      const runner = await resolveRunRunner(run.computeResourceId, owner);
      const logs = await fetchLocalRunLogs({
        accountId: workerAccount,
        externalRunId: run.externalRunId,
        after,
        ...(runner ? { runnerUrl: runner.runnerUrl, runnerToken: runner.runnerToken } : {}),
      });
      if (!logs) {
        sendApiError(
          response,
          503,
          'SIM2REAL_RUN_LOGS_UNAVAILABLE',
          '训练 worker 暂时无法返回日志（可能尚未启动或连接中断）；保留已获取的行。',
          { retryable: true, retryAfterSeconds: 5 },
        );
        return;
      }
      response.json({
        ok: true,
        runId: run.id,
        status: run.status,
        total: logs.total,
        retainedFrom: logs.retainedFrom,
        ...(logs.truncated ? { truncated: true } : {}),
        lines: logs.lines,
      });
    }),
  );

  /**
   * GET /runs/:id/policy.onnx — the completed run's portable policy bytes for
   * the browser-side trial run (same evidence gates as board staging: only a
   * completed, real, non-mock local run with a digest-verified ONNX artifact
   * serves bytes). The browser trial is an operator aid, never release
   * evidence; the digest is still verified so the bytes the operator sees
   * match the ones that would be staged to a board.
   */
  router.get(
    api('/runs/:id/policy.onnx'),
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
      const errors: string[] = [];
      if (run.status !== 'completed') errors.push('运行未完成');
      if (run.mock === true) errors.push('mock 运行没有可试跑的策略');
      if (run.backend !== 'local' && run.backend !== 'robogo') errors.push('非真实训练后端');
      if (run.artifact?.format?.toLowerCase() !== 'onnx') errors.push('运行没有 ONNX 制品');
      if (errors.length) {
        sendApiError(response, 409, 'SIM2REAL_POLICY_TRIAL_NOT_AVAILABLE', errors.join('；'), {
          retryable: false,
          details: { runId: run.id, status: run.status },
        });
        return;
      }
      if (run.backend !== 'local' || !run.externalRunId) {
        sendApiError(
          response,
          409,
          'SIM2REAL_POLICY_TRIAL_NOT_AVAILABLE',
          '该运行的制品字节不可从本平台读取（可能来自远端 runner 或已清理）。',
          { retryable: true },
        );
        return;
      }
      const workerAccount = owner ?? (auth.isMultiUserDeployment() ? '' : 'local-dev');
      if (!workerAccount) {
        sendApiError(response, 401, 'SIM2REAL_AUTH_REQUIRED', '当前会话没有可用账号。', {
          retryable: false,
        });
        return;
      }
      const runner = await resolveRunRunner(run.computeResourceId, owner);
      const artifact = await fetchLocalRunArtifact({
        accountId: workerAccount,
        externalRunId: run.externalRunId,
        ...(runner ? { runnerUrl: runner.runnerUrl, runnerToken: runner.runnerToken } : {}),
      });
      if (!artifact) {
        sendApiError(
          response,
          409,
          'SIM2REAL_POLICY_TRIAL_ARTIFACT_UNAVAILABLE',
          '无法从训练 worker 读取制品字节（任务可能来自远端或制品已清理）。',
          { retryable: true },
        );
        return;
      }
      if (run.artifact?.sha256 && artifact.sha256 !== run.artifact.sha256) {
        sendApiError(
          response,
          409,
          'SIM2REAL_POLICY_TRIAL_ARTIFACT_DIGEST_MISMATCH',
          '制品字节与运行记录的 SHA-256 不一致，拒绝下发。',
          { retryable: false },
        );
        return;
      }
      // The browser simulator's wasm move loader is what consumes these bytes
      // (window.rl.loadCustomPolicy), and upstream only accepts absolute
      // http(s) URLs for a policy, so a deployment that mounts the simulator
      // on its own origin cannot use a same-origin path. The response is a
      // completed run's ONNX actor, already gated on run ownership, status,
      // non-mock provenance and a digest match; it carries no credential and no
      // telemetry. `*` is therefore the deliberate scope: any page that can
      // reach this API can only read bytes the owning account may already read.
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Timing-Allow-Origin', '*');
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', String(artifact.bytes.byteLength));
      response.setHeader('X-Artifact-Sha256', artifact.sha256);
      response.end(artifact.bytes);
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
        const selectedResource = run.computeResourceId
          ? await getSim2RealComputeResourceSecret(run.computeResourceId, owner)
          : null;
        if (run.backend === 'local' && run.computeResourceId && !selectedResource) {
          sendApiError(
            response,
            409,
            'SIM2REAL_COMPUTE_RESOURCE_NOT_FOUND',
            '该运行所选的 GPU 资源已删除或不属于当前账号，拒绝回退到全局 runner。',
            { retryable: false },
          );
          return;
        }
        if (run.backend === 'local' && run.computeResourceId && selectedResource) {
          const healthFailure = computeResourceHealthFailure(selectedResource.resource);
          if (healthFailure === 'stale') {
            sendApiError(
              response,
              503,
              'SIM2REAL_COMPUTE_RESOURCE_HEALTH_STALE',
              `所选 GPU 资源健康检查已超过 ${sim2RealComputeHealthTtlSeconds()} 秒；对账状态暂时未知，请先测试连接。`,
              { retryable: true, retryAfterSeconds: 15 },
            );
            return;
          }
          if (healthFailure === 'not-ready') {
            sendApiError(
              response,
              503,
              'SIM2REAL_COMPUTE_RESOURCE_NOT_READY',
              '所选 GPU 资源尚未通过健康检查，对账状态暂时未知，请先测试连接。',
              { retryable: true, retryAfterSeconds: 15 },
            );
            return;
          }
        }
        const selectedRunner =
          run.backend === 'local' && run.computeResourceId
            ? {
                runnerUrl: selectedResource!.resource.runnerUrl,
                runnerToken: selectedResource!.runnerToken ?? '',
              }
            : {};
        const latest =
          run.backend === 'local'
            ? await requestLocalTrainingStatus({
                accountId,
                externalRunId,
                ...selectedRunner,
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
          ...(latest.taskEvaluation ? { taskEvaluation: latest.taskEvaluation } : {}),
          ...(latest.status === 'completed' || latest.status === 'failed'
            ? { finishedAt: new Date().toISOString() }
            : {}),
        };
        const updated = await updateSim2RealRunForReconcile(run.id, update, owner);
        if (!updated) {
          sendApiError(
            response,
            409,
            'SIM2REAL_RUN_RECONCILE_RACE',
            '运行记录已发生变化，请刷新后重试。',
            {
              retryable: true,
            },
          );
          return;
        }
        // No telemetry auto-attach here: reconcile exists only to recover the
        // external id, and its contract is one runner request per call. The
        // run page's status poll (or the next GET /runs/:id after completion)
        // attaches evaluation evidence instead.
        response.json({ ok: true, reconciled: true, run: updated });
      } catch (error) {
        console.warn(
          `[sim2real] reconcile status lookup failed for ${run.id}`,
          redactInternalError(error),
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
                new Sim2RealError('sim2real_storage_unavailable'),
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
        response.status(201).json({
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

  // Collection reads are intentionally thin wrappers over the account-scoped
  // ledger helpers.  Keeping these alongside the overview endpoint gives API
  // clients a stable way to refresh one resource without downloading the
  // entire workspace snapshot.
  router.get(
    api('/models'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const models = await listSim2RealModels(owner);
      response.json({ ok: true, models: models.map(publicModel) });
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
      const { parsed, apiError } = parseRunRequest(request, body);
      if (apiError || !parsed) {
        sendApiError(response, apiError!.status, apiError!.code, apiError!.message, {
          retryable: false,
        });
        return;
      }
      const {
        idempotencyKey,
        modelId,
        taskId,
        backend,
        training,
        resumeFrom,
        projectId,
        experimentId,
        label,
        computeResourceId,
        datasetIds: requestedDatasetIds,
      } = parsed;
      const model = await getSim2RealModel(modelId, owner);
      if (!model) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_MODEL_NOT_FOUND',
          message: '模型制品不存在，或不属于当前账号。',
        });
        return;
      }
      if (projectId && !(await getSim2RealProject(projectId, owner))) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_PROJECT_NOT_FOUND',
          message: '项目不存在，或不属于当前账号。',
        });
        return;
      }
      // A project supplies its dataset snapshot by default.  An explicit
      // datasetIds array overrides that default, but every id must be visible
      // to the current account and match the model contract when declared.
      const project = projectId ? await getSim2RealProject(projectId, owner) : null;
      const datasetIds = requestedDatasetIds ?? project?.datasetIds ?? [];
      if (datasetIds.length) {
        const datasets = await listSim2RealDatasets(owner);
        const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
        const contractId = model.manifest.contract.id;
        const invalid = datasetIds.find((id) => !byId.has(id));
        if (invalid) {
          sendApiError(
            response,
            422,
            'SIM2REAL_DATASET_LINEAGE_INVALID',
            'datasetIds 包含不存在或不属于当前账号的数据集。',
            { retryable: false },
          );
          return;
        }
        const mismatch = datasetIds.find(
          (id) => byId.get(id)?.contractId && byId.get(id)?.contractId !== contractId,
        );
        if (mismatch) {
          sendApiError(
            response,
            422,
            'SIM2REAL_DATASET_CONTRACT_MISMATCH',
            '数据集契约与训练模型契约不一致。',
            { retryable: false },
          );
          return;
        }
      }
      const requestFingerprint = runRequestFingerprint({
        modelId: model.id,
        backend,
        taskId,
        training,
        resumeFrom,
        projectId,
        experimentId,
        label,
        computeResourceId,
        datasetIds,
      });
      const replay = await findIdempotentRunReplay(idempotencyKey, requestFingerprint, owner);
      if (replay === 'fingerprint-conflict') {
        sendApiError(
          response,
          409,
          'SIM2REAL_IDEMPOTENCY_CONFLICT',
          'Idempotency-Key 已用于另一份运行请求，请更换 key。',
          { retryable: false },
        );
        return;
      }
      if (replay) {
        response.status(200).json({ ok: true, run: replay, idempotentReplay: true });
        return;
      }
      if ((backend === 'local' || backend === 'robogo') && !sim2RealStorageInfo().writable) {
        storageError(
          request,
          response,
          new Sim2RealError('sim2real_storage_not_configured'),
          'sim2real-run-preflight',
        );
        return;
      }
      const now = new Date().toISOString();

      // Reserve before any external side effect.  The reservation is an
      // atomic ledger operation, so concurrent retries carrying the same key
      // cannot both reach RoboGo/local runner and accidentally start two jobs.
      let reservedRun: Sim2RealRunRecord | undefined;
      if (idempotencyKey) {
        try {
          const reservation = await reserveSim2RealRun(
            {
              modelId: model.id,
              ...(projectId ? { projectId } : {}),
              ...(experimentId ? { experimentId } : {}),
              ...(label ? { label } : {}),
              ...(taskId ? { taskId } : {}),
              backend,
              ...(computeResourceId ? { computeResourceId } : {}),
              ...(datasetIds.length ? { datasetIds } : {}),
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

      const outcome = await dispatchRunBackend({ request, auth, owner, model, parsed });
      try {
        const finalRunInput = {
          status: outcome.status,
          summary: outcome.summary,
          ...(outcome.launchUrl ? { launchUrl: outcome.launchUrl } : {}),
          ...(outcome.externalRunId ? { externalRunId: outcome.externalRunId } : {}),
          ...(outcome.mock ? { mock: true } : {}),
          ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
          ...(outcome.artifact ? { artifact: outcome.artifact } : {}),
          ...(outcome.metrics ? { metrics: outcome.metrics } : {}),
          ...(outcome.taskEvaluation ? { taskEvaluation: outcome.taskEvaluation } : {}),
          ...(outcome.relayAgentUrl ? { relayAgentUrl: outcome.relayAgentUrl } : {}),
          ...(outcome.status === 'completed' || outcome.status === 'failed'
            ? { finishedAt: now }
            : {}),
        };
        const run = reservedRun
          ? await updateSim2RealRun(reservedRun.id, finalRunInput, owner)
          : await createSim2RealRun(
              {
                modelId: model.id,
                ...(projectId ? { projectId } : {}),
                ...(experimentId ? { experimentId } : {}),
                ...(label ? { label } : {}),
                ...(taskId ? { taskId } : {}),
                backend,
                ...(computeResourceId ? { computeResourceId } : {}),
                ...(datasetIds.length ? { datasetIds } : {}),
                ...finalRunInput,
                ...(training ? { training } : {}),
                ...(resumeFrom ? { resumeFrom } : {}),
              },
              owner,
              { idempotencyKey, requestFingerprint },
            );
        if (!run) throw new Sim2RealError('sim2real_run_reservation_lost');
        if (idempotencyKey) response.setHeader('Idempotency-Key', idempotencyKey);
        response.status(201).json({ ok: true, run });
      } catch (error) {
        storageError(request, response, error, 'sim2real-run-create');
      }
    }),
  );

  router.get(
    api('/runs'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const models = await listSim2RealModels(owner);
      const allRuns = await listSim2RealRuns(owner);
      const taskId = queryText(request.query.taskId);
      const modelId = queryText(request.query.modelId);
      const projectId = queryText(request.query.projectId);
      const status = queryText(request.query.status);
      const backend = queryText(request.query.backend);
      const search = queryText(request.query.q ?? request.query.search);
      const rawLimit = Number(request.query.limit ?? 200);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(500, Math.trunc(rawLimit)))
        : 200;
      const runs = allRuns
        .filter(
          (run) =>
            (!taskId || run.taskId?.toLowerCase() === taskId) &&
            (!modelId || run.modelId.toLowerCase() === modelId) &&
            (!projectId || run.projectId?.toLowerCase() === projectId) &&
            (!status || run.status.toLowerCase() === status) &&
            (!backend || run.backend.toLowerCase() === backend) &&
            (!search ||
              `${run.id} ${run.label ?? ''} ${run.summary}`.toLowerCase().includes(search)),
        )
        .slice(0, limit);
      response.json({
        ok: true,
        runs: runs.map((run) => publicRun(run, models)),
        total: runs.length,
        available: allRuns.length,
      });
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
      const runId = String(body.runId ?? '').trim();
      const requestedArtifactId = String(body.artifactId ?? '').trim();
      const requestedEvaluationId = String(body.evaluationId ?? '').trim();
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
      if (mode !== 'preflight' && !runId) {
        sendApiError(
          response,
          400,
          'SIM2REAL_RELEASE_RUN_REQUIRED',
          'Canary / Live 部署必须绑定一条已完成且质量门通过的真实训练运行 runId。',
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
      const releaseRun = runId ? await getSim2RealRun(runId, owner) : null;
      // When a run has first-class lineage, pin its latest published artifact
      // and passed evaluation automatically. Legacy runs may still rely on
      // embedded runner metadata, preserving the existing API contract.
      let artifactId = requestedArtifactId || undefined;
      let evaluationId = requestedEvaluationId || undefined;
      if (releaseRun && !artifactId && releaseRun.artifactIds?.length) {
        const artifacts = await listSim2RealArtifacts(owner);
        const candidate = [...artifacts]
          .filter(
            (artifact) =>
              releaseRun.artifactIds?.includes(artifact.id) && artifact.status === 'published',
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        if (candidate) artifactId = candidate.id;
      }
      if (releaseRun && !evaluationId && releaseRun.evaluationId) {
        const evaluation = await getSim2RealEvaluation(releaseRun.evaluationId, owner);
        if (evaluation) evaluationId = evaluation.id;
      }
      if (mode !== 'preflight' && !artifactId) {
        sendApiError(
          response,
          409,
          'SIM2REAL_ARTIFACT_BINDING_REQUIRED',
          'Canary / Live 必须绑定一条已发布的一等制品记录。请先注册并发布制品，再创建部署计划。',
          { retryable: false },
        );
        return;
      }
      if (mode !== 'preflight' && !evaluationId) {
        sendApiError(
          response,
          409,
          'SIM2REAL_EVALUATION_BINDING_REQUIRED',
          'Canary / Live 必须绑定一条通过且已验证的一等评测记录。',
          { retryable: false },
        );
        return;
      }
      let releaseEvaluation: Awaited<ReturnType<typeof getSim2RealEvaluation>> = null;
      if (mode !== 'preflight' && artifactId) {
        const artifact = await getSim2RealArtifact(artifactId, owner);
        if (!artifact || artifact.status !== 'published') {
          sendApiError(
            response,
            409,
            'SIM2REAL_ARTIFACT_NOT_RELEASEABLE',
            'Canary / Live 必须绑定已发布且未撤销的不可变制品。',
            { retryable: false },
          );
          return;
        }
        if (!releaseRun || artifact.modelId !== model.id || artifact.runId !== releaseRun.id) {
          sendApiError(
            response,
            409,
            'SIM2REAL_ARTIFACT_LINEAGE_INVALID',
            '制品与模型或训练运行的血缘不一致。',
            { retryable: false },
          );
          return;
        }
      }
      if (mode !== 'preflight' && evaluationId) {
        const evaluation = await getSim2RealEvaluation(evaluationId, owner);
        releaseEvaluation = evaluation;
        if (
          evaluation?.stale === true ||
          (evaluation?.telemetryRevision &&
            (!releaseRun ||
              releaseRun.telemetryRevision !== evaluation.telemetryRevision ||
              releaseRun.evaluationId !== evaluation.id))
        ) {
          sendApiError(
            response,
            409,
            'SIM2REAL_EVALUATION_STALE',
            '评测所依据的遥测已被更新；请重新运行评测后再提交发布计划。',
            { retryable: false },
          );
          return;
        }
        if (
          !evaluation ||
          evaluation.status !== 'passed' ||
          evaluation.attested !== true ||
          evaluation.report?.replay?.attested !== true ||
          evaluation.modelId !== model.id ||
          !releaseRun ||
          evaluation.runId !== releaseRun.id ||
          (evaluation.artifactId && evaluation.artifactId !== artifactId)
        ) {
          sendApiError(
            response,
            409,
            'SIM2REAL_EVALUATION_LINEAGE_INVALID',
            'Canary / Live 必须绑定同一模型运行的通过评测证据。',
            { retryable: false },
          );
          return;
        }
      }
      // The first-class evaluation report is the canonical release evidence;
      // use it for the gate even when a legacy embedded run summary differs.
      const releaseRunForGate =
        releaseRun && releaseEvaluation?.report
          ? { ...releaseRun, evaluation: releaseEvaluation.report }
          : releaseRun;
      const releaseGate = validateRunForDeployment({
        mode,
        modelId: model.id,
        run: releaseRunForGate,
      });
      if (mode !== 'preflight') {
        releaseGate.checks.artifactBinding = Boolean(artifactId);
        releaseGate.checks.evaluationBinding = Boolean(evaluationId);
        releaseGate.checks.evaluationAttested = releaseEvaluation?.attested === true;
      }
      if (!releaseGate.passed) {
        sendApiError(
          response,
          409,
          'SIM2REAL_RELEASE_EVIDENCE_REJECTED',
          `发布证据门未通过：${releaseGate.errors.join('；')}`,
          { retryable: false, details: { releaseGate } },
        );
        return;
      }
      const status = mode === 'live' ? 'blocked' : compatibility.deployable ? 'planned' : 'blocked';
      const deployment: Omit<Sim2RealDeploymentRecord, 'id' | 'createdAt' | 'updatedAt'> = {
        modelId: model.id,
        ...(releaseRun ? { runId: releaseRun.id } : {}),
        ...(artifactId ? { artifactId } : {}),
        ...(evaluationId ? { evaluationId } : {}),
        deviceId: device.id,
        targetPlatform,
        mode,
        status,
        summary: deploymentSummary(mode, compatibility.deployable),
        compatibility,
        steps: [
          ...(mode === 'preflight'
            ? []
            : [
                {
                  id: 'release-evidence',
                  label: 'Verify training and Task-Pack evidence',
                  status: 'completed' as const,
                  detail: `Run ${releaseRun?.id ?? ''} passed the server-side release gate.`,
                },
              ]),
          ...deploymentStepsFor(compatibility),
        ],
        ...(mode === 'preflight' ? {} : { releaseGate }),
      };
      const requestFingerprint = JSON.stringify({
        modelId: model.id,
        deviceId: device.id,
        mode,
        ...(runId ? { runId } : {}),
        ...(artifactId ? { artifactId } : {}),
        ...(evaluationId ? { evaluationId } : {}),
      });
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
    api('/deployments'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const models = await listSim2RealModels(owner);
      const deployments = await listSim2RealDeployments(owner);
      response.json({
        ok: true,
        deployments: deployments.map((deployment) => publicDeployment(deployment, models)),
      });
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

  router.get(
    api('/deployments/:id/history'),
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
      response.json({
        ok: true,
        deploymentId: deployment.id,
        history: deployment.history ?? [],
        verification: deployment.verification ?? null,
      });
    }),
  );

  /**
   * Record the human approval decision for a canary/live plan. Approval only
   * moves the control-plane record to ready; a board-agent executor remains
   * responsible for the physical rollout.
   */
  router.post(
    api('/deployments/:id/approval'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const rawDecision = String(body.decision ?? '')
        .trim()
        .toLowerCase();
      const decision =
        rawDecision === 'approved' || rawDecision === 'approve'
          ? ('approved' as const)
          : rawDecision === 'rejected' || rawDecision === 'reject'
            ? ('rejected' as const)
            : typeof body.approved === 'boolean'
              ? body.approved
                ? ('approved' as const)
                : ('rejected' as const)
              : null;
      if (!decision) {
        sendApiError(
          response,
          400,
          'SIM2REAL_INVALID_DEPLOYMENT',
          'approval 需要 decision=approved 或 rejected（也兼容 approved 布尔值）。',
          { retryable: false },
        );
        return;
      }
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
      const principal = auth.resolvePrincipal(request);
      try {
        const updated = await decideSim2RealDeploymentApproval(
          id,
          decision,
          owner,
          principal?.accountId ?? owner ?? 'local-operator',
          typeof body.note === 'string' ? body.note : undefined,
        );
        response.json({ ok: true, deployment: updated });
      } catch (error) {
        storageError(request, response, error, 'sim2real-deployment-approval');
      }
    }),
  );

  /** Cancel a plan before any board-agent action. This endpoint never talks to a device. */
  router.post(
    api('/deployments/:id/cancel'),
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
      if (deployment.status === 'cancelled') {
        response.json({ ok: true, deployment, idempotentReplay: true });
        return;
      }
      if (!['planned', 'running', 'blocked', 'ready'].includes(deployment.status)) {
        response.status(409).json({
          ok: false,
          error: 'SIM2REAL_DEPLOYMENT_NOT_CANCELLABLE',
          message: '当前部署状态不可取消。',
        });
        return;
      }
      const updated = await updateSim2RealDeployment(
        id,
        {
          status: 'cancelled',
          summary: '部署计划已取消；未执行模型下发或电机动作。',
        },
        owner,
      );
      response.json({ ok: true, deployment: updated });
    }),
  );

  /** Create a guarded preflight plan that switches to another model version. */
  router.post(
    api('/deployments/:id/version-switch'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response, auth);
      if (owner === null) return;
      noStore(response);
      const source = await getSim2RealDeployment(String(request.params.id || '').trim(), owner);
      if (!source) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_DEPLOYMENT_NOT_FOUND',
          message: '部署计划不存在，或不属于当前账号。',
        });
        return;
      }
      const body =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const targetModelId = String(body.targetModelId ?? body.modelId ?? '').trim();
      if (!targetModelId) {
        response.status(400).json({
          ok: false,
          error: 'SIM2REAL_INVALID_DEPLOYMENT',
          message: 'targetModelId 必填。',
        });
        return;
      }
      if (targetModelId === source.modelId) {
        response.status(409).json({
          ok: false,
          error: 'SIM2REAL_INVALID_DEPLOYMENT',
          message: '目标模型必须是不同版本。',
        });
        return;
      }
      const devices = await visibleDevicesForAuth(owner);
      const device = findVisibleDevice(devices, source.deviceId);
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
          message: '请先完成板卡探测，再切换模型版本。',
        });
        return;
      }
      const model = await getSim2RealModel(targetModelId, owner);
      if (!model) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_MODEL_NOT_FOUND',
          message: '目标模型制品不存在，或不属于当前账号。',
        });
        return;
      }
      const compatibility = compatibilityForManifest(model.manifest, targetPlatform);
      const deployment: Omit<Sim2RealDeploymentRecord, 'id' | 'createdAt' | 'updatedAt'> = {
        modelId: model.id,
        deviceId: source.deviceId,
        targetPlatform,
        mode: 'preflight',
        status: compatibility.deployable ? 'planned' : 'blocked',
        summary: compatibility.deployable
          ? '版本切换计划已创建；需重新执行只读预检后才能进入 canary。'
          : '目标版本不兼容当前板卡；版本切换已阻断。',
        compatibility,
        steps: deploymentStepsFor(compatibility),
        versionSwitchFrom: source.id,
      };
      const idempotency = requestIdempotencyKey(request, body);
      if (idempotency.error) {
        sendApiError(response, 400, 'SIM2REAL_INVALID_DEPLOYMENT', idempotency.error, {
          retryable: false,
        });
        return;
      }
      const created = await createSim2RealDeploymentWithResult(deployment, owner, {
        ...(idempotency.key ? { idempotencyKey: idempotency.key } : {}),
        ...(idempotency.key
          ? { requestFingerprint: JSON.stringify({ source: source.id, targetModelId }) }
          : {}),
      });
      if (idempotency.key) response.setHeader('Idempotency-Key', idempotency.key);
      response.status(created.duplicate ? 200 : 201).json({
        ok: true,
        deployment: created.deployment,
        ...(created.duplicate ? { idempotentReplay: true } : {}),
      });
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
      if (deployment.status === 'cancelled') {
        response.status(409).json({
          ok: false,
          error: 'SIM2REAL_DEPLOYMENT_NOT_CANCELLABLE',
          message: '部署计划已取消，不能执行预检。',
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
            ...(device.connectionMode === 'bridge'
              ? {
                  bridgeDeviceId: device.bridgeDeviceId,
                  bridgeOwnerKey: device.bridgeOwnerKey ?? (owner ? `sso:${owner}:web` : null),
                }
              : {}),
          },
        );
        if (!executed) {
          await updateSim2RealDeployment(
            id,
            {
              status: 'failed',
              summary: '板端只读预检未完成；未执行模型下发或电机动作。',
              verification: { passed: false, checkedAt: new Date().toISOString() },
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
              verification: {
                passed: false,
                checkedAt: new Date().toISOString(),
                checks: parsedPreflight.checks,
              },
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
              verification: {
                passed: false,
                mock: true,
                checkedAt: new Date().toISOString(),
                checks: parsedPreflight.checks,
              },
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
            verification: {
              passed: true,
              checkedAt: new Date().toISOString(),
              checks: parsedPreflight.checks,
            },
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
            verification: { passed: false, checkedAt: new Date().toISOString() },
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
