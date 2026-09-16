import { type Request, type Response, type Router } from 'express';

import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import { isBoardAgentConfigured } from '../sim2real/standalone-adapters.js';
import {
  stationSwitchEnabled,
  setStationSwitch,
  clearStationSwitch,
} from '../sim2real/station-switches.js';
import {
  stationAgentFetch,
  stationAgentFetchStream,
  stationAgentFetchWithStatus,
} from '../sim2real/board-station-proxy.js';
import type { StationAgentFetchOptions } from '../sim2real/board-station-proxy.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import type { Sim2RealRunRecord } from '../../shared/sim2real.js';
import type { Device } from '../../shared/types.js';
import { principalCan, SIM2REAL_PERMISSIONS } from '../sim2real/sim2real-rbac.js';

/**
 * Read-only host-station command whitelist. Kept identical to
 * STATION_COMMANDS in services/sim2real-web/board-station.mjs; the TS side
 * owns the typed contract (allowJs is off) and the agent test asserts the two
 * lists stay in sync.
 */
const STATION_COMMANDS: readonly { id: string; label: string; timeoutMs: number }[] = [
  { id: 'list-tros-nodes', label: 'TROS 节点列表', timeoutMs: 8000 },
  { id: 'list-tros-topics', label: 'TROS 话题列表', timeoutMs: 8000 },
  { id: 'disk-usage', label: '磁盘用量', timeoutMs: 5000 },
  { id: 'service-status', label: '服务状态', timeoutMs: 5000 },
];

type OwnedDevice = Device & { bridgeOwnerKey?: string };
type OwnerResolver = (request: Request, response: Response) => string | undefined | null;

export interface Sim2RealBoardStationRouteDeps {
  auth: Sim2RealAuthPort;
  requestOwner: OwnerResolver;
  visibleDevices: (owner?: string) => Promise<readonly OwnedDevice[]>;
  /** Resolve an active loopback URL for a web-managed device tunnel. */
  resolveDeviceAgentUrl?: (deviceId: string, owner?: string) => string | null;
  /** Owner-scoped run lookup used by policy staging to bind evidence. */
  getRun?: (runId: string, owner?: string) => Promise<Sim2RealRunRecord | null>;
  /**
   * Fetch a completed run's ONNX bytes from its training worker. Returns
   * { bytes, sha256 } on success; null when the artifact is unavailable.
   */
  fetchRunArtifact?: (
    run: Sim2RealRunRecord,
    owner?: string,
  ) => Promise<{ bytes: Buffer; sha256: string } | null>;
}

export interface Sim2RealBoardStationRouteOptions {
  /** API prefix supplied by the owning Sim2Real router. */
  prefix?: string;
}

const DEFAULT_SIM2REAL_API_PREFIX = '/api/sim2real';

function normalizeStationApiPrefix(value: string | undefined): string {
  const prefix = String(value ?? DEFAULT_SIM2REAL_API_PREFIX).trim();
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(prefix)) {
    throw new Error(`Invalid Sim2Real board-station API prefix: ${prefix}`);
  }
  return prefix;
}

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

/**
 * A board station is an optional, operator-attached resource.  Read-only
 * views must be able to render that resource's absence without turning the
 * whole Sim2Real workspace into an error page.  Keep this response distinct
 * from transport failures on mutating routes: `ok` means the platform API
 * answered, while `available=false` means no live BoardAgent was reachable.
 */
function sendStationOffline(
  response: Response,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  noStore(response);
  response.status(200).json({
    ok: true,
    available: false,
    state: 'offline',
    error: 'SIM2REAL_BOARD_AGENT_OFFLINE',
    code: 'SIM2REAL_BOARD_AGENT_OFFLINE',
    message,
    retryable: true,
    ...extra,
  });
}

function offlineAgent(message: string): Record<string, unknown> {
  return {
    available: false,
    state: 'offline',
    reason: message,
    mock: false,
  };
}

function sendStationOfflineStream(response: Response, message: string): void {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-board-station': 'offline',
  });
  response.end(
    `${JSON.stringify({
      available: false,
      state: 'offline',
      reason: 'board-agent-unreachable',
      message,
      timestamp: null,
    })}\n`,
  );
}

/**
 * Forward an agent ReadableStream to the response with a hard lifetime. The
 * proxy holds exactly one upstream connection per downstream client; when
 * either side closes (or the lifetime expires) both are torn down together.
 */
function pipeStationStream(
  request: Request,
  response: Response,
  upstream: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
  lifetimeMs = 15 * 60 * 1000,
): void {
  response.writeHead(200, {
    ...headers,
    'cache-control': 'no-store',
    'x-board-station': 'proxy',
  });
  const lifetime = setTimeout(() => {
    try {
      response.destroy();
    } catch {
      /* downstream already gone */
    }
  }, lifetimeMs);
  const cleanup = () => {
    clearTimeout(lifetime);
    try {
      void upstream.cancel().catch(() => undefined);
    } catch {
      /* upstream already closed */
    }
    try {
      response.destroy();
    } catch {
      /* downstream already closed */
    }
  };
  request.on('close', cleanup);
  response.on('error', cleanup);
  const reader = upstream.getReader();
  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && !response.write(value)) {
          await new Promise<void>((resolve) => response.once('drain', resolve));
        }
      }
    } catch {
      /* upstream closed mid-stream */
    } finally {
      cleanup();
      try {
        response.end();
      } catch {
        /* response already destroyed */
      }
    }
  };
  void pump();
}

/**
 * Board-station (上位机) proxy surface. The workbench browser never talks to
 * the board agent directly: every call goes through this authenticated,
 * allowlisted, ownership-checked proxy. Streaming endpoints (status NDJSON and
 * MJPEG) are forwarded with a bounded lifetime; JSON endpoints are bounded
 * fetches. Motion is the ONE actuator path, and it is double-gated: the
 * platform switch (RDK_SIM2REAL_STATION_DRIVE_ENABLED) AND the board agent
 * switch (RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE) must both be on, every value
 * is re-clamped here and again on the board, each command is time-boxed, and
 * drive/stop (emergency zero) is always forwarded. Everything else stays
 * read-only.
 */
export function registerSim2RealBoardStationRoutes(
  router: Router,
  deps: Sim2RealBoardStationRouteDeps,
  options: Sim2RealBoardStationRouteOptions = {},
): void {
  const prefix = normalizeStationApiPrefix(options.prefix);
  const api = (suffix: string): string => `${prefix}${suffix}`;
  const { auth, requestOwner, visibleDevices, resolveDeviceAgentUrl } = deps;
  const multiUser = auth.isMultiUserDeployment();
  const stationOptions = (
    request: Request,
    options: StationAgentFetchOptions = {},
  ): StationAgentFetchOptions => ({
    ...options,
    cookieHeader: String(request.headers.cookie ?? ''),
    // resolveStation records the auth-filtered registry choice on the request
    // so the Studio bridge follows the same dynamic device as the API.
    deviceId:
      String(
        (request as Request & { __stationDeviceId?: string }).__stationDeviceId ??
          options.deviceId ??
          '',
      ).trim() || undefined,
    baseUrl:
      String(
        (request as Request & { __stationAgentBaseUrl?: string }).__stationAgentBaseUrl ??
          options.baseUrl ??
          '',
      ).trim() || undefined,
  });
  const visibleDevicesForAuth = (owner?: string) =>
    multiUser ? visibleDevices(owner) : visibleDevices(undefined);

  /** Enforce optional verified role claims on actuator/model mutations. */
  const requirePermission = (
    request: Request,
    response: Response,
    permission:
      (typeof SIM2REAL_PERMISSIONS)[keyof typeof SIM2REAL_PERMISSIONS] | 'edit-or-operate',
  ): boolean => {
    if (!multiUser) return true;
    const principal = auth.resolvePrincipal(request);
    const allowed =
      permission === 'edit-or-operate'
        ? Boolean(
            principal &&
            (principalCan(principal, SIM2REAL_PERMISSIONS.edit) ||
              principalCan(principal, SIM2REAL_PERMISSIONS.operate)),
          )
        : Boolean(principal && principalCan(principal, permission));
    if (allowed) return true;
    noStore(response);
    sendApiError(
      response,
      403,
      'SIM2REAL_PERMISSION_DENIED',
      '当前账号没有执行此操作的权限；请联系项目管理员。',
      { retryable: false, permission },
    );
    return false;
  };

  /** Resolve the station target: the configured agent plus a visible device. */
  const resolveStation = async (request: Request, response: Response) => {
    if (!isBoardAgentConfigured()) {
      noStore(response);
      sendApiError(
        response,
        503,
        'SIM2REAL_BOARD_AGENT_NOT_CONFIGURED',
        '未配置板端 agent 或 RDK Studio Local Bridge 设备，无法访问上位机。',
        { retryable: true },
      );
      return null;
    }
    const owner = requestOwner(request, response);
    if (owner === null) return null;
    const deviceId = String(request.query.deviceId ?? '').trim();
    const devices = (await visibleDevicesForAuth(owner)) as readonly OwnedDevice[];
    const device = deviceId ? devices.find((item) => item.id === deviceId) : devices[0];
    if (!device) {
      noStore(response);
      sendApiError(
        response,
        404,
        'SIM2REAL_DEVICE_NOT_FOUND',
        '未找到可用的板卡设备，请先在部署页完成板卡注册与检测。',
        { retryable: false },
      );
      return null;
    }
    // A registry row may carry the Studio bridge's remote identifier when it
    // differs from the platform's device key. Fall back to the legacy key.
    (request as Request & { __stationDeviceId?: string }).__stationDeviceId = String(
      device.bridgeDeviceId ?? device.id,
    ).trim();
    // Device connections own a loopback-only SSH tunnel. Carry its URL on the
    // request so JSON and streaming station calls select the same device;
    // the proxy validates the URL again before making any network request.
    (request as Request & { __stationAgentBaseUrl?: string }).__stationAgentBaseUrl =
      resolveDeviceAgentUrl?.(device.id, multiUser ? (owner ?? undefined) : undefined) ?? undefined;
    return { device, owner };
  };

  /** GET /board-station/health — capability probe for the workbench. */
  router.get(
    api('/board-station/health'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const agent = await stationAgentFetch(
        '/healthz',
        stationOptions(request, { timeoutMs: 4000 }),
      );
      if (!agent) {
        sendStationOffline(
          response,
          '当前没有可达的板端 agent；仿真和训练工作流仍可使用。请接入实体板卡并启动 rdk-board-agent。',
          {
            device: {
              id: resolved.device.id,
              name: resolved.device.name,
              status: resolved.device.status,
              boardPlatform: resolved.device.boardPlatform ?? null,
              boardModel: resolved.device.boardModel ?? null,
            },
            agent: offlineAgent('板端 agent 不可达或尚未启动'),
            cameraSupported: false,
          },
        );
        return;
      }
      const capabilities = Array.isArray((agent as Record<string, unknown>).capabilities)
        ? ((agent as Record<string, unknown>).capabilities as unknown[])
        : [];
      const stationCommands = Array.isArray((agent as Record<string, unknown>).stationCommands)
        ? ((agent as Record<string, unknown>).stationCommands as unknown[])
        : STATION_COMMANDS.map((command) => ({ id: command.id, label: command.label }));
      response.json({
        ok: true,
        device: {
          id: resolved.device.id,
          name: resolved.device.name,
          status: resolved.device.status,
          boardPlatform: resolved.device.boardPlatform ?? null,
          boardModel: resolved.device.boardModel ?? null,
        },
        agent: {
          capabilities,
          stationCommands,
          actuatorControl: (agent as Record<string, unknown>).actuatorControl === true,
          mock: (agent as Record<string, unknown>).mock === true,
        },
        cameraSupported: capabilities.includes('host-station'),
      });
    }),
  );

  /**
   * GET /board-station/onboarding/preflight — one structured, read-only
   * passport for a newly attached OriginBot.  This is intentionally separate
   * from the legacy shell-compatible deployment probe: the UI can render all
   * missing prerequisites (camera, TROS, ROS topics, telemetry, safety
   * switches) without ever receiving an arbitrary command channel.
   */
  router.get(
    api('/board-station/onboarding/preflight'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const passport = await stationAgentFetch(
        '/v1/onboarding/preflight',
        stationOptions(request, { timeoutMs: 6000 }),
      );
      if (!passport || typeof passport !== 'object') {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端 onboarding 预检不可达，请确认 agent 进程已启动。',
          { retryable: true },
        );
        return;
      }
      response.json({ ok: true, deviceId: resolved.device.id, passport });
    }),
  );

  /** GET /board-station/status — one status snapshot. */
  router.get(
    api('/board-station/status'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const status = await stationAgentFetch(
        '/v1/station/status',
        stationOptions(request, { timeoutMs: 5000 }),
      );
      if (!status || typeof status !== 'object') {
        sendStationOffline(response, '实体板卡当前离线，暂时没有可读取的状态或传感器数据。', {
          status: {
            available: false,
            state: 'offline',
            reason: 'board-agent-unreachable',
            timestamp: null,
          },
        });
        return;
      }
      response.json({ ok: true, status });
    }),
  );

  /**
   * GET /board-station/status/stream — forwarded NDJSON heartbeat. The proxy
   * holds ONE upstream connection per downstream client and tears both down
   * together; a bounded lifetime stops orphaned upstream readers.
   */
  router.get(
    api('/board-station/status/stream'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      let upstream: ReadableStream<Uint8Array> | null;
      try {
        upstream = await stationAgentFetchStream(
          '/v1/station/status/stream',
          stationOptions(request),
        );
      } catch {
        upstream = null;
      }
      if (!upstream) {
        sendStationOfflineStream(
          response,
          '实体板卡当前离线，状态流将在板端 agent 恢复后重新连接。',
        );
        return;
      }
      pipeStationStream(request, response, upstream, {
        'content-type': 'application/x-ndjson; charset=utf-8',
      });
    }),
  );

  /**
   * GET /board-station/camera.mjpeg — forwarded MJPEG camera view. A plain
   * <img> tag in the workbench renders this stream directly.
   */
  router.get(
    api('/board-station/camera.mjpeg'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      let upstream: ReadableStream<Uint8Array> | null;
      try {
        upstream = await stationAgentFetchStream(
          '/v1/station/camera.mjpeg',
          stationOptions(request),
        );
      } catch {
        upstream = null;
      }
      if (!upstream) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端相机流不可达，请确认 agent 进程与摄像头已就绪。',
          { retryable: true },
        );
        return;
      }
      pipeStationStream(request, response, upstream, {
        'content-type': 'multipart/x-mixed-replace; boundary=rdk-board-station-frame',
      });
    }),
  );

  /** POST /board-station/commands — allowlisted read-only command dispatch. */
  router.post(
    api('/board-station/commands'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const id = String(body.id ?? '').trim();
      const known = STATION_COMMANDS.find((command) => command.id === id);
      if (!known) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_COMMAND_REJECTED',
          '仅支持白名单内的只读上位机命令：' +
            STATION_COMMANDS.map((command) => command.id).join('、'),
          { retryable: false, commands: STATION_COMMANDS.map((command) => command.id) },
        );
        return;
      }
      const agent = await stationAgentFetch(
        '/v1/station/commands',
        stationOptions(request, {
          method: 'POST',
          timeoutMs: Math.min(known.timeoutMs + 4000, 15_000),
          body: JSON.stringify({ id }),
        }),
      );
      if (!agent || typeof agent !== 'object' || (agent as Record<string, unknown>).ok !== true) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          `命令 ${known.label} 执行失败：板端 agent 不可达或拒绝了该命令。`,
          { retryable: true },
        );
        return;
      }
      response.json(agent);
    }),
  );

  /** GET /board-station/devices — devices usable as the station target. */
  router.get(
    api('/board-station/devices'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      noStore(response);
      const devices = await visibleDevicesForAuth(owner);
      response.json({
        ok: true,
        agentConfigured: isBoardAgentConfigured(),
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          status: device.status,
          boardPlatform: device.boardPlatform ?? null,
          boardModel: device.boardModel ?? null,
          connectionMode: device.connectionMode ?? null,
        })),
      });
    }),
  );

  // ---- constrained drive (motion canary) --------------------------------
  // Motion requires BOTH switches: the board agent's
  // RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1 and the platform's
  // RDK_SIM2REAL_STATION_DRIVE_ENABLED=1 (runtime-overridable through the
  // station-switches surface, env remains the default). Either one alone
  // keeps the platform read-only. The proxy re-validates and clamps every
  // value the browser sends; the agent clamps again on the board.

  const drivePlatformEnabled = () => stationSwitchEnabled('drive');
  const DRIVE_PROXY_MAX_LINEAR = 0.3;
  const DRIVE_PROXY_MAX_ANGULAR = 1.0;
  const DRIVE_PROXY_MAX_WINDOW_SEC = 2.0;

  /** Normalize and clamp one drive request; null when invalid. */
  const clampDriveRequest = (body: Record<string, unknown>) => {
    const linear = Number(body.linear);
    const angular = Number(body.angular);
    const durationSec = Number(body.durationSec);
    if (!Number.isFinite(linear) || !Number.isFinite(angular) || !Number.isFinite(durationSec)) {
      return null;
    }
    return {
      linear: Math.min(Math.max(linear, -DRIVE_PROXY_MAX_LINEAR), DRIVE_PROXY_MAX_LINEAR),
      angular: Math.min(Math.max(angular, -DRIVE_PROXY_MAX_ANGULAR), DRIVE_PROXY_MAX_ANGULAR),
      durationSec: Math.min(Math.max(durationSec, 0.2), DRIVE_PROXY_MAX_WINDOW_SEC),
    };
  };

  /** GET /board-station/drive — current constrained-drive state. */
  router.get(
    api('/board-station/drive'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const agent = await stationAgentFetch('/v1/station/drive', stationOptions(request));
      if (!agent) {
        sendStationOffline(response, '实体板卡当前离线，无法读取驱动状态。', {
          drive: {
            available: false,
            state: 'offline',
            enabled: false,
            active: false,
            lastStopReason: 'board-agent-unreachable',
          },
          platformEnabled: drivePlatformEnabled(),
          actuatorPolicy: null,
        });
        return;
      }
      response.json({
        ok: true,
        platformEnabled: drivePlatformEnabled(),
        drive: agent.drive ?? null,
        actuatorPolicy: agent.actuatorPolicy ?? null,
      });
    }),
  );

  /**
   * GET /board-station/switches — platform-side switch states. Readable even
   * when the board is unreachable so the UI can always render the honest
   * gate state; `source` says whether the value came from a runtime override
   * or the env default.
   */
  router.get(
    api('/board-station/switches'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      noStore(response);
      response.json({
        ok: true,
        drive: stationSwitchEnabled('drive'),
        policy: stationSwitchEnabled('policy'),
      });
    }),
  );

  /**
   * PUT /board-station/switches — toggle the platform-side motion switches.
   * This is ONE half of the double gate: the board agent's own switches stay
   * opt-in through the device-connection config surface. Stopping is never
   * gated, and switching OFF is always allowed (fail-safe direction).
   */
  router.put(
    api('/board-station/switches'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      if (!requirePermission(request, response, SIM2REAL_PERMISSIONS.operate)) return;
      noStore(response);
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const patch: { drive?: boolean; policy?: boolean } = {};
      if (body.drive !== undefined) {
        if (typeof body.drive !== 'boolean') {
          sendApiError(response, 400, 'SIM2REAL_STATION_SWITCH_INVALID', 'drive 需为布尔值。', {
            retryable: false,
          });
          return;
        }
        patch.drive = body.drive;
      }
      if (body.policy !== undefined) {
        if (typeof body.policy !== 'boolean') {
          sendApiError(response, 400, 'SIM2REAL_STATION_SWITCH_INVALID', 'policy 需为布尔值。', {
            retryable: false,
          });
          return;
        }
        patch.policy = body.policy;
      }
      if (patch.drive === undefined && patch.policy === undefined) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_SWITCH_INVALID',
          '需要 drive 或 policy 布尔字段。',
          { retryable: false },
        );
        return;
      }
      // Turning motion ON requires the operator's explicit confirmation flag
      // in the same request, mirroring the drive panel's confirm dialog.
      if ((patch.drive === true || patch.policy === true) && body.confirm !== true) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_SWITCH_CONFIRM_REQUIRED',
          '开启运动开关需要 body.confirm=true（操作者在场、场地清空确认）。',
          { retryable: false },
        );
        return;
      }
      if (patch.drive !== undefined) {
        if (body.reset === true) clearStationSwitch('drive');
        else setStationSwitch('drive', patch.drive);
      }
      if (patch.policy !== undefined) {
        if (body.reset === true) clearStationSwitch('policy');
        else setStationSwitch('policy', patch.policy);
      }
      response.json({
        ok: true,
        drive: stationSwitchEnabled('drive'),
        policy: stationSwitchEnabled('policy'),
      });
    }),
  );

  /** POST /board-station/drive — one clamped, time-boxed motion command. */
  router.post(
    api('/board-station/drive'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      if (!requirePermission(request, response, SIM2REAL_PERMISSIONS.operate)) return;
      noStore(response);
      if (!drivePlatformEnabled()) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_DRIVE_DISABLED',
          '平台未开启受限驱动（RDK_SIM2REAL_STATION_DRIVE_ENABLED），上位机保持只读。',
          { retryable: false },
        );
        return;
      }
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const clamped = clampDriveRequest(body);
      if (!clamped) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_DRIVE_INVALID',
          '驱动参数无效（需要数值型 linear/angular/durationSec）。',
          { retryable: false },
        );
        return;
      }
      const agent = await stationAgentFetchWithStatus(
        '/v1/station/drive',
        stationOptions(request, {
          method: 'POST',
          timeoutMs: 12000,
          body: JSON.stringify(clamped),
        }),
      );
      // An agent refusal (409 drive-disabled / rate-limited / out of range)
      // is a meaningful answer: pass the reason through, not a 502.
      if (!agent) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端 agent 不可达，命令未下发。底盘看门狗保证机器人保持静止。',
          { retryable: true },
        );
        return;
      }
      response.status(agent.status).json(agent.payload);
    }),
  );

  /** POST /board-station/drive/stop — emergency zero-speed, always allowed. */
  router.post(
    api('/board-station/drive/stop'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const agent = await stationAgentFetch(
        '/v1/station/drive/stop',
        stationOptions(request, {
          method: 'POST',
          timeoutMs: 5000,
        }),
      );
      if (!agent || typeof agent !== 'object') {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '急停命令未送达板端。持续按下急停并检查板端 agent；底盘固件看门狗（500ms 无命令自动停车）兜底。',
          { retryable: true },
        );
        return;
      }
      response.json(agent);
    }),
  );

  // ---- policy runtime (trained ONNX → bounded /cmd_vel) --------------------
  // The browser loads a trained policy through this surface and the board
  // runs inference, publishing through the SAME clamped, watchdog-floored
  // channel as the drive canary. Platform-side this adds a THIRD gate
  // (RDK_SIM2REAL_STATION_POLICY_ENABLED) on top of the two drive switches,
  // so policy motion requires all three. `policy/stop` (like drive/stop) is
  // always forwarded regardless of switches.

  const policyPlatformEnabled = () => stationSwitchEnabled('policy');

  /** GET /board-station/policy — honest policy-runtime state. */
  router.get(
    api('/board-station/policy'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const agent = await stationAgentFetch('/v1/station/policy', stationOptions(request));
      if (!agent || typeof agent !== 'object') {
        sendStationOffline(response, '实体板卡当前离线，无法读取策略运行时状态。', {
          platformEnabled: policyPlatformEnabled(),
          drivePlatformEnabled: drivePlatformEnabled(),
          policy: {
            ...offlineAgent('board-agent-unreachable'),
            enabled: false,
            runtimeRunning: false,
            motionAuthorized: false,
          },
        });
        return;
      }
      response.json({
        ok: true,
        platformEnabled: policyPlatformEnabled(),
        drivePlatformEnabled: drivePlatformEnabled(),
        policy: agent.policy ?? null,
      });
    }),
  );

  /** POST /board-station/policy/load — load a policies/ ONNX (gated). */
  router.post(
    api('/board-station/policy/load'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      if (!requirePermission(request, response, 'edit-or-operate')) return;
      noStore(response);
      if (!policyPlatformEnabled()) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_DISABLED',
          '平台未开启策略运行时（RDK_SIM2REAL_STATION_POLICY_ENABLED）。',
          { retryable: false },
        );
        return;
      }
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const path = String(body.path ?? '').trim();
      // Allow only an onnx filename; the board resolves it inside its pinned
      // policies dir. No absolute paths, no traversal, no extensions smuggling.
      if (!/^[\w.-]+\.onnx$/.test(path)) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_POLICY_INVALID_PATH',
          '模型路径无效：仅接受 policies 目录内的 .onnx 文件名。',
          { retryable: false },
        );
        return;
      }
      const agent = await stationAgentFetchWithStatus(
        '/v1/station/policy/load',
        stationOptions(request, {
          method: 'POST',
          timeoutMs: 30_000, // model load + onnxruntime session init on board
          // Send only the bare filename: the board resolves it inside its own
          // pinned policies dir. Keeping the platform ignorant of the on-board
          // directory layout avoids two hardcoded paths that can drift apart
          // (or leak the board's root filesystem layout into the API).
          body: JSON.stringify({ path }),
        }),
      );
      if (!agent) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端 agent 不可达，模型未加载。',
          { retryable: true },
        );
        return;
      }
      response.status(agent.status).json(agent.payload);
    }),
  );

  /** GET /board-station/policy/files — list staged board policies. */
  router.get(
    api('/board-station/policy/files'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const agent = await stationAgentFetchWithStatus(
        '/v1/station/policy/files',
        stationOptions(request, {
          method: 'GET',
          timeoutMs: 5000,
        }),
      );
      if (!agent) {
        sendStationOffline(response, '实体板卡当前离线，暂时无法读取板端策略制品列表。', {
          files: [],
        });
        return;
      }
      response.status(agent.status).json(agent.payload);
    }),
  );

  /**
   * POST /board-station/policy/stage — push a completed run's ONNX artifact
   * to the board agent's pinned policies dir.
   *
   * The full training→board software loop: the platform re-reads the run's
   * bytes from its worker (never trusting a client-supplied path), verifies
   * the SHA-256 recorded at completion, requires the same release evidence
   * as a canary plan, then uploads base64 bytes through the token-gated
   * agent endpoint. Staging never loads the model and never moves a motor —
   * load/start stay separate, switch-gated operator actions.
   */
  router.post(
    api('/board-station/policy/stage'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      if (!requirePermission(request, response, 'edit-or-operate')) return;
      noStore(response);
      if (!policyPlatformEnabled()) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_DISABLED',
          '平台未开启策略运行时（RDK_SIM2REAL_STATION_POLICY_ENABLED），不能下发制品。',
          { retryable: false },
        );
        return;
      }
      if (!deps.getRun || !deps.fetchRunArtifact) {
        sendApiError(
          response,
          501,
          'SIM2REAL_STATION_POLICY_STAGING_UNAVAILABLE',
          '当前服务配置未接入训练制品源，无法下发。',
          { retryable: false },
        );
        return;
      }
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const runId = String(body.runId ?? '').trim();
      if (!runId || !/^[\w.-]{1,120}$/.test(runId)) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_POLICY_INVALID_RUN',
          'runId 无效：需要一条已完成训练运行的 ID。',
          { retryable: false },
        );
        return;
      }
      const run = await deps.getRun(runId, resolved.owner);
      if (!run) {
        response.status(404).json({
          ok: false,
          error: 'SIM2REAL_RUN_NOT_FOUND',
          message: '运行记录不存在，或不属于当前账号。',
        });
        return;
      }
      // Evidence-not-threshold, same as the canary gate: completed, real,
      // non-mock runner, deployable ONNX artifact with a recorded digest.
      const errors: string[] = [];
      if (run.status !== 'completed') errors.push('运行未完成');
      if (run.mock === true) errors.push('mock 运行不能下发制品');
      if (run.backend !== 'local' && run.backend !== 'robogo') errors.push('非真实训练后端');
      if (run.artifact?.format?.toLowerCase() !== 'onnx') errors.push('运行没有 ONNX 制品');
      if (!run.artifact?.sha256) errors.push('制品缺少 SHA-256 摘要');
      if (errors.length) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_RUN_NOT_STAGED',
          `发布证据不足：${errors.join('；')}`,
          {
            retryable: false,
            details: { runId: run.id, status: run.status, mock: run.mock ?? false },
          },
        );
        return;
      }
      const artifact = await deps.fetchRunArtifact(run, resolved.owner);
      if (!artifact) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_ARTIFACT_UNAVAILABLE',
          '无法从训练 worker 读取制品字节（任务可能来自远端或制品已清理）。',
          { retryable: true },
        );
        return;
      }
      if (artifact.sha256 !== run.artifact?.sha256) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_ARTIFACT_DIGEST_MISMATCH',
          '制品字节与运行记录的 SHA-256 不一致，拒绝下发。',
          { retryable: false },
        );
        return;
      }
      const filename = String(body.filename ?? '').trim() || `${run.id}.onnx`;
      if (!/^[\w.-]+\.onnx$/.test(filename) || filename.includes('..')) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_POLICY_INVALID_FILENAME',
          '目标文件名无效：仅接受 .onnx 文件名。',
          { retryable: false },
        );
        return;
      }
      const agent = await stationAgentFetchWithStatus(
        '/v1/station/policy/upload',
        stationOptions(request, {
          method: 'POST',
          // base64 inflates the body by ~4/3 over the 50 MB artifact ceiling.
          timeoutMs: 120_000,
          body: JSON.stringify({
            filename,
            bytesBase64: artifact.bytes.toString('base64'),
            sha256: artifact.sha256,
          }),
        }),
      );
      if (!agent) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端 agent 不可达，制品未下发。',
          { retryable: true },
        );
        return;
      }
      response.status(agent.status).json(agent.payload);
    }),
  );

  /** POST /board-station/policy/start — begin policy-driven motion (gated). */
  router.post(
    api('/board-station/policy/start'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      if (!requirePermission(request, response, SIM2REAL_PERMISSIONS.operate)) return;
      noStore(response);
      if (!policyPlatformEnabled()) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_DISABLED',
          '平台未开启策略运行时（RDK_SIM2REAL_STATION_POLICY_ENABLED）。',
          { retryable: false },
        );
        return;
      }
      if (!drivePlatformEnabled()) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_DRIVE_DISABLED',
          '策略运动同时需要平台侧 RDK_SIM2REAL_STATION_DRIVE_ENABLED=1。',
          { retryable: false },
        );
        return;
      }
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const direction = Number(body.direction);
      if (!Number.isFinite(direction)) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_POLICY_INVALID',
          'direction 需为数值（-1..1）。',
          { retryable: false },
        );
        return;
      }
      const goalX = body.goalX == null || body.goalX === '' ? undefined : Number(body.goalX);
      const goalY = body.goalY == null || body.goalY === '' ? undefined : Number(body.goalY);
      if (
        (goalX !== undefined && !Number.isFinite(goalX)) ||
        (goalY !== undefined && !Number.isFinite(goalY))
      ) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_POLICY_INVALID_GOAL',
          'goalX / goalY 需为数值。',
          { retryable: false },
        );
        return;
      }
      const agent = await stationAgentFetchWithStatus(
        '/v1/station/policy/start',
        stationOptions(request, {
          method: 'POST',
          timeoutMs: 15_000,
          body: JSON.stringify({
            direction: Math.min(Math.max(direction, -1), 1),
            ...(goalX === undefined ? {} : { goalX }),
            ...(goalY === undefined ? {} : { goalY }),
          }),
        }),
      );
      if (!agent) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端 agent 不可达，策略未启动。底盘看门狗保证机器人保持静止。',
          { retryable: true },
        );
        return;
      }
      response.status(agent.status).json(agent.payload);
    }),
  );

  /** POST /board-station/policy/reset — clear a sticky fault (gated). */
  router.post(
    api('/board-station/policy/reset'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      if (!requirePermission(request, response, SIM2REAL_PERMISSIONS.operate)) return;
      noStore(response);
      if (!policyPlatformEnabled()) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_DISABLED',
          '平台未开启策略运行时（RDK_SIM2REAL_STATION_POLICY_ENABLED）。',
          { retryable: false },
        );
        return;
      }
      const agent = await stationAgentFetchWithStatus(
        '/v1/station/policy/reset',
        stationOptions(request, {
          method: 'POST',
          timeoutMs: 12_000,
        }),
      );
      if (!agent) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端 agent 不可达，重置未执行。',
          { retryable: true },
        );
        return;
      }
      response.status(agent.status).json(agent.payload);
    }),
  );

  /** POST /board-station/policy/stop — zero output + halt, always allowed. */
  router.post(
    api('/board-station/policy/stop'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const agent = await stationAgentFetchWithStatus(
        '/v1/station/policy/stop',
        stationOptions(request, {
          method: 'POST',
          timeoutMs: 12_000,
        }),
      );
      if (!agent) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '策略停止命令未送达板端。底盘固件看门狗（500ms 无命令自动停车）兜底。',
          { retryable: true },
        );
        return;
      }
      response.status(agent.status).json(agent.payload);
    }),
  );
}
