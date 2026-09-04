import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { Device } from '../../shared/types.js';

const MAX_ROBOGO_API_RESPONSE_BYTES = 1_000_000;

/** Minimal host adapters used by the public standalone distribution.
 *
 * The product core only talks to these ports. Deployments can replace this
 * module with an SSO, board-agent, object-store, or device-registry adapter
 * without changing the workflow routes.
 */
export function resolveDataDir(): string {
  return String(process.env.RDK_SIM2REAL_STORAGE_DIR || path.join(process.cwd(), '.data'));
}

export function isWebCloudDeployment(): boolean {
  return (
    String(process.env.RDK_SIM2REAL_DEPLOYMENT || '').trim() === 'web-cloud' ||
    String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE || '').trim() === 'web-cloud'
  );
}

export const storageRequestContextMiddleware: RequestHandler = (_request, _response, next) => next();

export const studioSecurityHeadersMiddleware: RequestHandler = (_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
};

export function isSSOEnabled(): boolean {
  return (
    String(process.env.RDK_SIM2REAL_SSO_ENABLED || process.env.SSO_ENABLED || '').trim() === '1' ||
    String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE || '').trim() === 'web-cloud' ||
    String(process.env.RDK_SIM2REAL_AUTH_MODE || '').trim().toLowerCase() === 'trusted-proxy'
  );
}

export function isSSORequired(): boolean {
  return (
    String(process.env.RDK_SIM2REAL_SSO_REQUIRED || process.env.SSO_REQUIRED || '').trim() === '1' ||
    String(process.env.RDK_STUDIO_DEPLOYMENT_PROFILE || '').trim() === 'web-cloud' ||
    String(process.env.RDK_SIM2REAL_AUTH_MODE || '').trim().toLowerCase() === 'trusted-proxy'
  );
}

/**
 * The public adapter has no identity provider of its own.  If an operator
 * opts into SSO/web-cloud mode without replacing this adapter, fail closed
 * instead of silently treating every caller as one anonymous owner.
 */
export function isStandaloneMultiUserMode(): boolean {
  return isWebCloudDeployment() || isSSORequired() || isSSOEnabled();
}

export function registerSSORoutes(_app: unknown): void {
  // The standalone sample intentionally has no identity provider dependency.
}

export async function restoreSsoSessionsFromDisk(): Promise<void> {
  // Identity/session persistence belongs to the deployment adapter.
}

export const ssoAuthMiddleware: RequestHandler = (_request, _response, next) => next();

/**
 * Lightweight CSRF boundary for cookie-based SSO deployments.  API clients
 * such as a board agent normally omit Origin and continue to work; browsers
 * sending a cross-site request are rejected.  A production OIDC adapter may
 * replace this with a synchronizer token, but should keep the same fail-closed
 * behaviour for unknown origins.
 */
export const sim2RealCsrfMiddleware: RequestHandler = (request, response, next) => {
  if (
    !isStandaloneMultiUserMode() ||
    !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase()) ||
    !request.path.startsWith('/api/')
  ) {
    next();
    return;
  }
  const fetchSite = String(request.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (fetchSite === 'cross-site') {
    response.status(403).json({
      ok: false,
      error: 'SIM2REAL_CSRF_BLOCKED',
      message: '跨站请求被拒绝，请从已登录的 Sim2Real 页面重试。',
    });
    return;
  }
  const origin = String(request.headers.origin ?? '').trim();
  if (origin) {
    const configured = String(
      process.env.RDK_SIM2REAL_ALLOWED_ORIGINS ??
        process.env.RDK_SIM2REAL_PUBLIC_ORIGIN ??
        'https://rdkstudio.d-robotics.cc',
    )
      .split(',')
      .map((item) => item.trim().replace(/\/$/, ''))
      .filter(Boolean);
    if (origin === 'null' || !configured.includes(origin.replace(/\/$/, ''))) {
      response.status(403).json({
        ok: false,
        error: 'SIM2REAL_CSRF_BLOCKED',
        message: '请求来源未被允许。',
      });
      return;
    }
  }
  response.setHeader('Vary', 'Origin, Sec-Fetch-Site');
  next();
};

export const standaloneAuth = {
  // Never infer an identity from a client-controlled header. A production
  // deployment must inject a verified OIDC/SSO adapter at this boundary.
  isMultiUserDeployment: isStandaloneMultiUserMode,
  resolvePrincipal: (_request: Request) => null,
  resolveAccessToken: (_request: Request) => null,
};

function normalizedDevice(value: unknown): (Device & { bridgeOwnerKey?: string }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  // Device records are read from a shared JSON file that may also be written
  // by another product (or by an older Studio version). Never spread that
  // object into the adapter result: legacy records can contain credentials or
  // arbitrary plugin fields which must not cross this boundary. Keep only the
  // fields understood by the Sim2Real device contract and bound every string
  // before a future BoardAgent receives it.
  const optionalText = (key: string, maxLength: number): string | undefined => {
    const raw = source[key];
    if (typeof raw !== 'string') return undefined;
    const text = raw.trim();
    if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
    return text;
  };
  const optionalPort = (key: string): number | undefined => {
    const raw = source[key];
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 && raw <= 65_535
      ? raw
      : undefined;
  };
  const id = typeof source.id === 'string' ? source.id.trim() : '';
  const host = typeof source.host === 'string' ? source.host.trim() : '';
  const username = typeof source.username === 'string' ? source.username.trim() : '';
  const status = source.status === 'connected' || source.status === 'disconnected'
    ? source.status
    : null;
  const lastCheckedAt =
    typeof source.lastCheckedAt === 'string' ? source.lastCheckedAt.trim() : '';
  if (
    !id ||
    id.length > 160 ||
    !host ||
    host.length > 255 ||
    !username ||
    username.length > 160 ||
    !status ||
    !lastCheckedAt ||
    /[\u0000-\u001f\u007f]/.test(id + host + username + lastCheckedAt)
  ) {
    return null;
  }
  const normalized: Device & { bridgeOwnerKey?: string } = {
    id,
    host,
    username,
    status,
    lastCheckedAt,
  };
  const name = optionalText('name', 120);
  if (name) normalized.name = name;
  const port = optionalPort('port');
  if (port !== undefined) normalized.port = port;
  const manualDisconnectedAt = optionalText('manualDisconnectedAt', 80);
  if (manualDisconnectedAt) normalized.manualDisconnectedAt = manualDisconnectedAt;
  const boardPlatform = optionalText('boardPlatform', 80);
  if (boardPlatform) normalized.boardPlatform = boardPlatform;
  const boardModel = optionalText('boardModel', 120);
  if (boardModel) normalized.boardModel = boardModel;
  const boardOsVersion = optionalText('boardOsVersion', 120);
  if (boardOsVersion) normalized.boardOsVersion = boardOsVersion;
  const boardDetectedAt = optionalText('boardDetectedAt', 80);
  if (boardDetectedAt) normalized.boardDetectedAt = boardDetectedAt;
  const boardFamilyDetectedBy = optionalText('boardFamilyDetectedBy', 32);
  if (
    boardFamilyDetectedBy === 'uname' ||
    boardFamilyDetectedBy === 'os-release' ||
    boardFamilyDetectedBy === 'device-tree' ||
    boardFamilyDetectedBy === 'tegra-release' ||
    boardFamilyDetectedBy === 'cpuinfo' ||
    boardFamilyDetectedBy === 'timeout'
  ) {
    normalized.boardFamilyDetectedBy = boardFamilyDetectedBy;
  }
  const researchSeeds = Array.isArray(source.researchSeeds)
    ? source.researchSeeds
        .slice(0, 8)
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item && item.length <= 300 && !/[\u0000-\u001f\u007f]/.test(item))
    : [];
  if (researchSeeds.length) normalized.researchSeeds = researchSeeds;
  const lanSshHost = optionalText('lanSshHost', 255);
  if (lanSshHost) normalized.lanSshHost = lanSshHost;
  const lanSshPort = optionalPort('lanSshPort');
  if (lanSshPort !== undefined) normalized.lanSshPort = lanSshPort;
  const frpRemotePort = optionalPort('frpRemotePort');
  if (frpRemotePort !== undefined) normalized.frpRemotePort = frpRemotePort;
  const sshReachability = optionalText('sshReachability', 16);
  if (sshReachability === 'direct' || sshReachability === 'tunnel') {
    normalized.sshReachability = sshReachability;
  }
  const connectionMode = optionalText('connectionMode', 16);
  if (connectionMode === 'direct' || connectionMode === 'bridge') {
    normalized.connectionMode = connectionMode;
  }
  const bridgeId = optionalText('bridgeId', 160);
  if (bridgeId) normalized.bridgeId = bridgeId;
  const bridgeDeviceId = optionalText('bridgeDeviceId', 160);
  if (bridgeDeviceId) normalized.bridgeDeviceId = bridgeDeviceId;
  const bridgeTransport = optionalText('bridgeTransport', 24);
  if (bridgeTransport === 'ssh' || bridgeTransport === 'usb-ethernet' || bridgeTransport === 'serial') {
    normalized.bridgeTransport = bridgeTransport;
  }
  const bridgeOwnerKey = optionalText('bridgeOwnerKey', 200);
  if (bridgeOwnerKey) normalized.bridgeOwnerKey = bridgeOwnerKey;
  return normalized;
}

export async function readDevices(): Promise<Device[]> {
  try {
    const raw = await fs.readFile(path.join(resolveDataDir(), 'devices.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A corrupt record must not make the whole overview fail. Keep a bounded
    // registry in memory; the device manager remains the owner of persistence.
    return parsed.slice(0, 500).map(normalizedDevice).filter((device): device is Device => device !== null);
  } catch {
    return [];
  }
}

export function isForeignOwnedDevice(
  device: Device & { bridgeOwnerKey?: string },
  ownerKey: string | null | undefined,
  multiUser = false,
): boolean {
  const deviceOwner = String(device.bridgeOwnerKey ?? '').trim();
  // In a shared deployment an ownerless or malformed record is not public;
  // hiding it is safer than allowing one tenant to claim it. Single-user
  // development keeps the convenient legacy behaviour and can inspect all
  // locally discovered devices.
  if (!multiUser) return false;
  if (!deviceOwner || !ownerKey) return true;
  return deviceOwner !== ownerKey;
}

export function requestOwnsDevice(
  request: Request,
  device: Device & { bridgeOwnerKey?: string },
  expectedOwnerKey?: string | null,
  multiUser = false,
): boolean {
  const owner = String(device.bridgeOwnerKey ?? '').trim();
  // A standalone service is intentionally private to its operator. It may
  // inspect the local device registry even when records carry an owner key
  // copied from Studio; there is no cross-tenant boundary to enforce here.
  if (!multiUser) return true;
  // The route has already resolved the verified principal and passes the
  // derived owner key. Never trust a client header here; a missing key remains
  // fail-closed in shared mode, while an injected SSO adapter can operate its
  // own devices. Unknown owner-key formats are deliberately not special-cased.
  void request;
  return Boolean(owner && expectedOwnerKey && owner === expectedOwnerKey);
}

export const runOnDevice = async (
  _request: Request,
  _response: Response,
  _id: string,
  _commands: string[],
): Promise<{ device: unknown; output: string } | null> => null;

/** Read-only placeholder route. A deployment may mount a BoardAgentPort here. */
export function createDeviceBoardDetectRouter(_runner: typeof runOnDevice): Router {
  const router = Router();
  router.post('/api/devices/:id/board/detect', (_request, response) => {
    response.status(503).json({
      ok: false,
      error: 'SIM2REAL_BOARD_AGENT_UNAVAILABLE',
      message: '公开示例未连接真实板端 agent；请在部署环境注入 BoardAgentPort。',
    });
  });
  return router;
}

export function createStandaloneRobogoApiClient(
  options: {
    requestToken?: string;
    fetchImpl?: typeof fetch;
    /** Global env token is only safe for a private single-user deployment. */
    allowEnvironmentToken?: boolean;
  } = {},
) {
  const baseUrl = String(process.env.RDK_SIM2REAL_ROBOGO_API_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('robogo_api_not_configured');
  return {
    async request(accountId: string, input: { method: string; path: string; timeoutMs?: number }) {
      const token = String(
        options.requestToken ||
          (options.allowEnvironmentToken ? process.env.RDK_SIM2REAL_ROBOGO_TOKEN : '') ||
          '',
      ).trim();
      if (!token || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
        throw new Error('robogo_api_token_not_configured');
      }
      if (!accountId || accountId.length > 160 || /[\u0000-\u001f\u007f/]/.test(accountId)) {
        throw new Error('robogo_api_account_invalid');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 12_000);
      try {
        const response = await (options.fetchImpl || fetch)(`${baseUrl}${input.path}`, {
          method: input.method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'x-sim2real-account': accountId,
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`robogo_http_${response.status}`);
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_ROBOGO_API_RESPONSE_BYTES) {
          throw new Error('robogo_api_response_too_large');
        }
        if (!response.body) {
          const raw = await response.text();
          if (Buffer.byteLength(raw, 'utf8') > MAX_ROBOGO_API_RESPONSE_BYTES) {
            throw new Error('robogo_api_response_too_large');
          }
          return raw ? (JSON.parse(raw) as unknown) : null;
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > MAX_ROBOGO_API_RESPONSE_BYTES) {
              await reader.cancel();
              throw new Error('robogo_api_response_too_large');
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }
        const raw = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
        return raw ? (JSON.parse(raw) as unknown) : null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function collectSandboxBoards(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const source = value as Record<string, unknown>;
  for (const key of ['boards', 'devices', 'instances', 'data', 'items', 'records', 'list']) {
    if (Array.isArray(source[key])) return source[key] as unknown[];
  }
  return [];
}
