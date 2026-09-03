import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { Device } from '../../shared/types.js';

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
  return String(process.env.RDK_SIM2REAL_DEPLOYMENT || '').trim() === 'web-cloud';
}

export const storageRequestContextMiddleware: RequestHandler = (_request, _response, next) => next();

export const studioSecurityHeadersMiddleware: RequestHandler = (_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
};

export function isSSOEnabled(): boolean {
  return String(process.env.RDK_SIM2REAL_SSO_ENABLED || '').trim() === '1';
}

export function isSSORequired(): boolean {
  return String(process.env.RDK_SIM2REAL_SSO_REQUIRED || '').trim() === '1';
}

export function registerSSORoutes(_app: unknown): void {
  // The standalone sample intentionally has no identity provider dependency.
}

export async function restoreSsoSessionsFromDisk(): Promise<void> {
  // Identity/session persistence belongs to the deployment adapter.
}

export const ssoAuthMiddleware: RequestHandler = (_request, _response, next) => next();

export const standaloneAuth = {
  // Never infer an identity from a client-controlled header. A production
  // deployment must inject a verified OIDC/SSO adapter at this boundary.
  isMultiUserDeployment: () => false,
  resolvePrincipal: (_request: Request) => null,
  resolveAccessToken: (_request: Request) => null,
};

export async function readDevices(): Promise<Device[]> {
  try {
    const raw = await fs.readFile(path.join(resolveDataDir(), 'devices.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Device[]) : [];
  } catch {
    return [];
  }
}

export function isForeignOwnedDevice(
  device: Device & { bridgeOwnerKey?: string },
  ownerKey: string | null | undefined,
): boolean {
  return Boolean(device.bridgeOwnerKey?.startsWith('sso:') && device.bridgeOwnerKey !== ownerKey);
}

export function requestOwnsDevice(
  request: Request,
  device: Device & { bridgeOwnerKey?: string },
): boolean {
  const owner = device.bridgeOwnerKey;
  if (!owner || !owner.startsWith('sso:')) return true;
  // No identity adapter is installed in the public sample, so owned devices
  // are fail-closed until a real SSO adapter is supplied by the deployment.
  return false;
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

export function createStandaloneRobogoApiClient(options: { requestToken?: string; fetchImpl?: typeof fetch } = {}) {
  const baseUrl = String(process.env.RDK_SIM2REAL_ROBOGO_API_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(baseUrl)) throw new Error('robogo_api_not_configured');
  return {
    async request(accountId: string, input: { method: string; path: string; timeoutMs?: number }) {
      const token = String(options.requestToken || process.env.RDK_SIM2REAL_ROBOGO_TOKEN || '').trim();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 12_000);
      try {
        const response = await (options.fetchImpl || fetch)(`${baseUrl}${input.path}`, {
          method: input.method,
          headers: {
            accept: 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'x-sim2real-account': accountId,
          },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`robogo_http_${response.status}`);
        return (await response.json()) as unknown;
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
