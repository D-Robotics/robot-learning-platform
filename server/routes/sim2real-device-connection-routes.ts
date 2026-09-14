import { type Request, type Response, type Router } from 'express';

import { sendApiError, wrapAsync } from '../sim2real/http-helpers.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import {
  activeDeviceConnections,
  closeDeviceConnectionTunnel,
  createDeviceConnection,
  deleteDeviceConnection,
  deviceConnectionAgentUrl,
  listDeviceConnections,
  markConnectionCheck,
  openDeviceConnectionTunnel,
} from '../sim2real/board-tunnel-manager.js';
import { stationAgentFetch, stationAgentFetchWithStatus } from '../sim2real/board-station-proxy.js';

/**
 * Web-managed board connections (RDK Studio 网页版-style device management).
 *
 * The browser never talks to the board directly: these routes create SSH
 * coordinates, spawn loopback tunnels owned by this server process, and proxy
 * the board-side switch surface through the same bounded fetch layer as every
 * other station call. Motion switches remain opt-in and double-gated — this
 * surface only flips the two documented flags and restarts the board agent;
 * it can never send a speed command.
 */

export interface Sim2RealDeviceConnectionRouteDeps {
  auth: Sim2RealAuthPort;
  requestOwner: (request: Request, response: Response) => string | undefined | null;
}

export interface Sim2RealDeviceConnectionRouteOptions {
  /** API prefix supplied by the owning Sim2Real router. */
  prefix?: string;
}

const DEFAULT_SIM2REAL_API_PREFIX = '/api/sim2real';

const CONNECTION_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  INVALID_HOST: {
    status: 400,
    code: 'SIM2REAL_INVALID_HOST',
    message: '主机名或 IP 无效（不要带 http:// 前缀）。',
  },
  INVALID_USERNAME: { status: 400, code: 'SIM2REAL_INVALID_USERNAME', message: '用户名无效。' },
  ALREADY_EXISTS: {
    status: 409,
    code: 'SIM2REAL_DEVICE_CONNECTION_EXISTS',
    message: '同主机/端口/用户的连接已存在。',
  },
  QUOTA_EXCEEDED: {
    status: 507,
    code: 'SIM2REAL_DEVICE_CONNECTION_QUOTA',
    message: '连接记录数量达到上限（单账号 50 条，单实例 500 条）。',
  },
  NOT_FOUND: {
    status: 404,
    code: 'SIM2REAL_DEVICE_CONNECTION_NOT_FOUND',
    message: '连接记录不存在。',
  },
  SSH_UNAVAILABLE: {
    status: 503,
    code: 'SIM2REAL_SSH_UNAVAILABLE',
    message: '服务器上找不到 ssh 客户端，无法建立隧道。',
  },
};

function normalizePrefix(value: string | undefined): string {
  const prefix = String(value ?? DEFAULT_SIM2REAL_API_PREFIX).trim();
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(prefix)) {
    throw new Error(`Invalid Sim2Real device-connection API prefix: ${prefix}`);
  }
  return prefix;
}

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
}

function connectionError(response: Response, error: string, fallbackMessage: string): boolean {
  const known = CONNECTION_ERRORS[error];
  if (known) {
    noStore(response);
    sendApiError(response, known.status, known.code, known.message, {
      retryable: known.status >= 500,
    });
    return true;
  }
  // Tunnel open failures return human-readable ssh reasons.
  noStore(response);
  sendApiError(response, 502, 'SIM2REAL_DEVICE_CONNECTION_FAILED', fallbackMessage || error, {
    retryable: true,
  });
  return false;
}

/** Serialize one connection with its live tunnel state. */
function serializeConnection(
  record: ReturnType<typeof listDeviceConnections>[number],
  tunnelUrl: string | null,
) {
  const { localPort, ...rest } = record;
  void localPort;
  return { ...rest, tunnelActive: Boolean(tunnelUrl) };
}

export function registerSim2RealDeviceConnectionRoutes(
  router: Router,
  deps: Sim2RealDeviceConnectionRouteDeps,
  options: Sim2RealDeviceConnectionRouteOptions = {},
): void {
  const prefix = normalizePrefix(options.prefix);
  const api = (suffix: string): string => `${prefix}${suffix}`;
  const { auth, requestOwner } = deps;
  const multiUser = auth.isMultiUserDeployment();
  const activeTunnels = () => new Set(activeDeviceConnections());

  /** GET /device-connections — saved connections + live tunnel flags. */
  router.get(
    api('/device-connections'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      noStore(response);
      const live = activeTunnels();
      const connections = listDeviceConnections(multiUser ? owner : undefined).map((record) =>
        serializeConnection(
          record,
          live.has(record.id)
            ? deviceConnectionAgentUrl(record.id, multiUser ? owner : undefined)
            : null,
        ),
      );
      response.json({
        ok: true,
        connections,
        sshNote:
          '隧道使用服务器本机 ssh 与已有密钥/代理跳转（与 deploy-x5-board-agent.sh 相同），不存储密码。',
      });
    }),
  );

  /** POST /device-connections — save SSH coordinates (no tunnel yet). */
  router.post(
    api('/device-connections'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const created = await createDeviceConnection(
        {
          host: String(body.host ?? ''),
          port: body.port == null ? undefined : Number(body.port),
          username: body.username == null ? undefined : String(body.username),
          label: body.label == null ? undefined : String(body.label),
          agentPort: body.agentPort == null ? undefined : Number(body.agentPort),
          profile: body.profile == null ? undefined : String(body.profile),
          transport: body.transport == null ? undefined : String(body.transport),
        },
        multiUser ? owner : undefined,
      );
      if ('error' in created) {
        connectionError(response, created.error, '创建连接失败。');
        return;
      }
      noStore(response);
      response.status(201).json({ ok: true, connection: serializeConnection(created, null) });
    }),
  );

  /** DELETE /device-connections/:id — remove the record and its tunnel. */
  router.delete(
    api('/device-connections/:connectionId'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      const deleted = await deleteDeviceConnection(
        String(request.params.connectionId || ''),
        multiUser ? owner : undefined,
      );
      if (!deleted) {
        connectionError(response, 'NOT_FOUND', '连接记录不存在。');
        return;
      }
      noStore(response);
      response.json({ ok: true, deleted: true });
    }),
  );

  /** POST /device-connections/:id/connect — open the tunnel and probe. */
  router.post(
    api('/device-connections/:connectionId/connect'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      const id = String(request.params.connectionId || '');
      const result = await openDeviceConnectionTunnel(id, multiUser ? owner : undefined);
      if ('error' in result) {
        if (result.error.startsWith('SSH 连接失败') || result.error.includes('板端 agent')) {
          await markConnectionCheck(id, false, result.error, multiUser ? owner : undefined);
        }
        connectionError(response, result.error, result.error);
        return;
      }
      noStore(response);
      response.json({
        ok: true,
        connection: serializeConnection(
          listDeviceConnections(multiUser ? owner : undefined).find((item) => item.id === id) ?? {
            id,
            label: '',
            host: '',
            port: 22,
            username: '',
            agentPort: 19100,
            localPort: 0,
            createdAt: '',
            lastCheckedAt: null,
            lastCheckOk: true,
            lastCheckMessage: result.probe.message,
          },
          result.url,
        ),
        probe: result.probe,
      });
    }),
  );

  /** POST /device-connections/:id/disconnect — tear the tunnel down. */
  router.post(
    api('/device-connections/:connectionId/disconnect'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      const id = String(request.params.connectionId || '');
      // Keep tunnel teardown owner-scoped just like list/delete/config.  A
      // tunnel id is intentionally opaque, but it is still an API resource
      // identifier; accepting a guessed id here would let one shared-mode
      // account tear down another account's active board connection.
      const visible = listDeviceConnections(multiUser ? owner : undefined);
      if (!visible.some((connection) => connection.id === id)) {
        connectionError(response, 'NOT_FOUND', '连接记录不存在。');
        return;
      }
      await closeDeviceConnectionTunnel(id, multiUser ? owner : undefined);
      noStore(response);
      response.json({ ok: true, disconnected: true });
    }),
  );

  /**
   * GET /device-connections/:id/config — board-side switch states, proxied
   * through the same bounded fetch as every station call (never direct).
   */
  router.get(
    api('/device-connections/:connectionId/config'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      const id = String(request.params.connectionId || '');
      const url = deviceConnectionAgentUrl(id, multiUser ? owner : undefined);
      if (!url) {
        noStore(response);
        sendApiError(
          response,
          409,
          'SIM2REAL_DEVICE_TUNNEL_DOWN',
          '隧道未连接；先连接设备再读取开关。',
          { retryable: false },
        );
        return;
      }
      const config = await stationAgentFetch('/v1/config', { timeoutMs: 5000, baseUrl: url });
      if (!config || config.ok !== true) {
        noStore(response);
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端开关状态不可达（agent 需更新到带 /v1/config 的版本）。',
          { retryable: true },
        );
        return;
      }
      noStore(response);
      response.json({ ok: true, config });
    }),
  );

  /**
   * POST /device-connections/:id/config — flip the two motion switches on the
   * board. Only the two documented flags are accepted; anything else is a 400.
   * The board applies changes by restarting its own agent (refused mid-motion).
   */
  router.post(
    api('/device-connections/:connectionId/config'),
    wrapAsync(async (request, response) => {
      const owner = requestOwner(request, response);
      if (owner === null) return;
      const id = String(request.params.connectionId || '');
      const url = deviceConnectionAgentUrl(id, multiUser ? owner : undefined);
      if (!url) {
        noStore(response);
        sendApiError(
          response,
          409,
          'SIM2REAL_DEVICE_TUNNEL_DOWN',
          '隧道未连接；先连接设备再修改开关。',
          { retryable: false },
        );
        return;
      }
      const body =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};
      const switches =
        body.switches && typeof body.switches === 'object' && !Array.isArray(body.switches)
          ? (body.switches as Record<string, unknown>)
          : null;
      if (!switches) {
        noStore(response);
        sendApiError(response, 400, 'SIM2REAL_STATION_CONFIG_INVALID', '需要 switches 对象。', {
          retryable: false,
        });
        return;
      }
      const ALLOWED = new Set([
        'RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE',
        'RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY',
      ]);
      const unknownKeys = Object.keys(switches).filter((key) => !ALLOWED.has(key));
      if (unknownKeys.length) {
        noStore(response);
        sendApiError(
          response,
          400,
          'SIM2REAL_STATION_CONFIG_INVALID',
          `仅允许修改这两个开关：${[...ALLOWED].join('、')}`,
          { retryable: false, allowed: [...ALLOWED] },
        );
        return;
      }
      const agent = await stationAgentFetchWithStatus('/v1/config', {
        method: 'POST',
        timeoutMs: 20_000,
        baseUrl: url,
        body: JSON.stringify({ switches }),
      });
      if (!agent || !agent.payload) {
        noStore(response);
        sendApiError(
          response,
          502,
          'SIM2REAL_BOARD_AGENT_UNREACHABLE',
          '板端 agent 不可达，开关未修改。',
          { retryable: true },
        );
        return;
      }
      response.status(agent.status).json(agent.payload);
    }),
  );
}
