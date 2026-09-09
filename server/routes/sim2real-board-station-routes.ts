import { type Request, type Response, type Router } from 'express';

import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import { isBoardAgentConfigured } from '../sim2real/standalone-adapters.js';
import {
  stationAgentFetch,
  stationAgentFetchStream,
  stationAgentFetchWithStatus,
} from '../sim2real/board-station-proxy.js';
import type { StationAgentFetchOptions } from '../sim2real/board-station-proxy.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import type { Device } from '../../shared/types.js';

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
  const { auth, requestOwner, visibleDevices } = deps;
  const multiUser = auth.isMultiUserDeployment();
  const stationOptions = (request: Request, options: StationAgentFetchOptions = {}): StationAgentFetchOptions => ({
    ...options,
    cookieHeader: String(request.headers.cookie ?? ''),
    // resolveStation records the auth-filtered registry choice on the request
    // so the Studio bridge follows the same dynamic device as the API.
    deviceId: String((request as Request & { __stationDeviceId?: string }).__stationDeviceId ?? options.deviceId ?? '').trim() || undefined,
  });
  const visibleDevicesForAuth = (owner?: string) =>
    multiUser ? visibleDevices(owner) : visibleDevices(undefined);

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
    (request as Request & { __stationDeviceId?: string }).__stationDeviceId =
      String(device.bridgeDeviceId ?? device.id).trim();
    return { device, owner };
  };

  /** GET /board-station/health — capability probe for the workbench. */
  router.get(
    api('/board-station/health'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const agent = await stationAgentFetch('/healthz', stationOptions(request, { timeoutMs: 4000 }));
      if (!agent) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端 agent 不可达，请确认 agent 进程已启动（npm run dev:board-agent）。',
          { retryable: true },
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

  /** GET /board-station/status — one status snapshot. */
  router.get(
    api('/board-station/status'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const status = await stationAgentFetch('/v1/station/status', stationOptions(request, { timeoutMs: 5000 }));
      if (!status || typeof status !== 'object') {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端状态不可达，请确认 agent 进程已启动。',
          { retryable: true },
        );
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
      let upstream: ReadableStream<Uint8Array> | null = null;
      try {
        upstream = await stationAgentFetchStream('/v1/station/status/stream', stationOptions(request));
      } catch {
        upstream = null;
      }
      if (!upstream) {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端状态流不可达，请确认 agent 进程已启动。',
          { retryable: true },
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
      let upstream: ReadableStream<Uint8Array> | null = null;
      try {
        upstream = await stationAgentFetchStream('/v1/station/camera.mjpeg', stationOptions(request));
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
      const agent = await stationAgentFetch('/v1/station/commands', stationOptions(request, {
        method: 'POST',
        timeoutMs: Math.min(known.timeoutMs + 4000, 15_000),
        body: JSON.stringify({ id }),
      }));
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
  // RDK_SIM2REAL_STATION_DRIVE_ENABLED=1. Either one alone keeps the
  // platform read-only. The proxy re-validates and clamps every value the
  // browser sends; the agent clamps again on the board.

  const drivePlatformEnabled =
    String(process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED ?? '').trim() === '1';
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
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端驱动状态不可达。',
          { retryable: true },
        );
        return;
      }
      response.json({
        ok: true,
        platformEnabled: drivePlatformEnabled,
        drive: agent.drive ?? null,
        actuatorPolicy: agent.actuatorPolicy ?? null,
      });
    }),
  );

  /** POST /board-station/drive — one clamped, time-boxed motion command. */
  router.post(
    api('/board-station/drive'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      if (!drivePlatformEnabled) {
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
      const agent = await stationAgentFetchWithStatus('/v1/station/drive', stationOptions(request, {
        method: 'POST',
        timeoutMs: 12000,
        body: JSON.stringify(clamped),
      }));
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
      const agent = await stationAgentFetch('/v1/station/drive/stop', stationOptions(request, {
        method: 'POST',
        timeoutMs: 5000,
      }));
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

  const policyPlatformEnabled =
    String(process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED ?? '').trim() === '1';

  /** GET /board-station/policy — honest policy-runtime state. */
  router.get(
    api('/board-station/policy'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      const agent = await stationAgentFetch('/v1/station/policy', stationOptions(request));
      if (!agent || typeof agent !== 'object') {
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端策略运行时状态不可达。',
          { retryable: true },
        );
        return;
      }
      response.json({
        ok: true,
        platformEnabled: policyPlatformEnabled,
        drivePlatformEnabled,
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
      noStore(response);
      if (!policyPlatformEnabled) {
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
      const agent = await stationAgentFetchWithStatus('/v1/station/policy/load', stationOptions(request, {
        method: 'POST',
        timeoutMs: 30_000, // model load + onnxruntime session init on board
        body: JSON.stringify({ path: `/root/rdk-board-agent/policies/${path}` }),
      }));
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

  /** POST /board-station/policy/start — begin policy-driven motion (gated). */
  router.post(
    api('/board-station/policy/start'),
    wrapAsync(async (request, response) => {
      const resolved = await resolveStation(request, response);
      if (!resolved) return;
      noStore(response);
      if (!policyPlatformEnabled) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_DISABLED',
          '平台未开启策略运行时（RDK_SIM2REAL_STATION_POLICY_ENABLED）。',
          { retryable: false },
        );
        return;
      }
      if (!drivePlatformEnabled) {
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
      if ((goalX !== undefined && !Number.isFinite(goalX)) || (goalY !== undefined && !Number.isFinite(goalY))) {
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_POLICY_INVALID_GOAL',
          'goalX / goalY 需为数值。',
          { retryable: false },
        );
        return;
      }
      const agent = await stationAgentFetchWithStatus('/v1/station/policy/start', stationOptions(request, {
        method: 'POST',
        timeoutMs: 15_000,
        body: JSON.stringify({
          direction: Math.min(Math.max(direction, -1), 1),
          ...(goalX === undefined ? {} : { goalX }),
          ...(goalY === undefined ? {} : { goalY }),
        }),
      }));
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
      noStore(response);
      if (!policyPlatformEnabled) {
        sendApiError(
          response,
          409,
          'SIM2REAL_STATION_POLICY_DISABLED',
          '平台未开启策略运行时（RDK_SIM2REAL_STATION_POLICY_ENABLED）。',
          { retryable: false },
        );
        return;
      }
      const agent = await stationAgentFetchWithStatus('/v1/station/policy/reset', stationOptions(request, {
        method: 'POST',
        timeoutMs: 12_000,
      }));
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
      const agent = await stationAgentFetchWithStatus('/v1/station/policy/stop', stationOptions(request, {
        method: 'POST',
        timeoutMs: 12_000,
      }));
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
