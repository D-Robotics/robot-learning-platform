import type { Request, RequestHandler, Response } from 'express';
import { createHash, createHmac } from 'node:crypto';
import { LOCAL_SIM2REAL_AUTH, type Sim2RealAuthPort } from './sim2real-auth.js';
import { principalCan, SIM2REAL_PERMISSIONS } from './sim2real-rbac.js';

/**
 * Local MuJoCo Web bridge.
 *
 * Both production nginx and local pages route `/mujoco/api/*` through this
 * identity boundary. The verified account is signed for the private Python
 * hop; neither browser-supplied owner headers nor user credentials reach it.
 * Local single-user deployments may keep the legacy unsigned loopback hop
 * while shared deployments require a strong signing secret.
 */

export const MUJOCO_BRIDGE_URL_ENV = 'RDK_SIM2REAL_MUJOCO_WEB_URL';
export const MUJOCO_SIMULATION_SECRET_ENV = 'RDK_SIM2REAL_SIMULATION_SECRET';
const SIMULATION_HEADERS = {
  owner: 'x-rdk-simulation-owner',
  timestamp: 'x-rdk-simulation-timestamp',
  signature: 'x-rdk-simulation-signature',
} as const;

/** Mirrors the nginx `client_max_body_size 2m` on the managed route. */
export const MUJOCO_BRIDGE_MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** MuJoCo answers in bounded JSON and rendered JPEG frames. */
export const MUJOCO_BRIDGE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Only one hop, on loopback, with a bounded body — keep it short. */
export const MUJOCO_BRIDGE_TIMEOUT_MS = 15_000;

const ALLOWED_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Resolve and validate the upstream base URL. Only absolute http(s) origins
 * are accepted; anything else (empty, malformed, other schemes) is `null`
 * and the bridge reports "not configured" instead of guessing a target.
 */
export function configuredMujocoWebUrl(
  raw: unknown = process.env[MUJOCO_BRIDGE_URL_ENV],
): URL | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_ORIGIN_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return parsed;
}

function forwardableMethod(method: string): boolean {
  return ['GET', 'POST', 'DELETE', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function rejectBridgeRequest(
  response: Response,
  status: number,
  error: string,
  message: string,
): void {
  response
    .status(status)
    .setHeader('Cache-Control', 'no-store')
    .json({ ok: false, error, message });
}

function bridgeOwner(request: Request, response: Response, auth: Sim2RealAuthPort): string | null {
  if (!auth.isMultiUserDeployment()) return 'local-single-user';
  const principal = auth.resolvePrincipal(request);
  const owner = String(principal?.accountId ?? '').trim();
  const invalidOwner = Array.from(owner).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || character === '/';
  });
  if (!owner || owner.length > 160 || invalidOwner) {
    rejectBridgeRequest(response, 401, 'SIM2REAL_AUTH_REQUIRED', '请先登录后使用仿真。');
    return null;
  }
  const write = ['POST', 'DELETE'].includes(request.method.toUpperCase());
  const allowed =
    principalCan(principal, SIM2REAL_PERMISSIONS.read) &&
    (!write ||
      principalCan(principal, SIM2REAL_PERMISSIONS.operate) ||
      principalCan(principal, SIM2REAL_PERMISSIONS.edit));
  if (!allowed) {
    rejectBridgeRequest(
      response,
      403,
      'SIM2REAL_PERMISSION_DENIED',
      '当前账号没有执行该仿真操作的权限。',
    );
    return null;
  }
  return owner;
}

function mutationOriginAllowed(request: Request, shared: boolean): boolean {
  if (!['POST', 'DELETE'].includes(request.method.toUpperCase())) return true;
  const fetchSite = String(request.headers['sec-fetch-site'] ?? '')
    .trim()
    .toLowerCase();
  if (fetchSite === 'cross-site') return false;
  const rawOrigin = String(request.headers.origin ?? '').trim();
  if (!rawOrigin) return !shared || fetchSite === 'same-origin';
  try {
    const incoming = new URL(rawOrigin);
    if (!ALLOWED_ORIGIN_PROTOCOLS.has(incoming.protocol) || incoming.origin !== rawOrigin)
      return false;
    // Production sets the external origin, or trusts its loopback reverse
    // proxy so Express resolves the forwarded scheme. Do not accept a set
    // of unrelated "allowed" sites for this same-origin mutation boundary.
    const expected = new URL(
      String(process.env.RDK_SIM2REAL_PUBLIC_ORIGIN || '').trim() ||
        `${request.protocol}://${request.get('host')}`,
    ).origin;
    return incoming.origin === expected;
  } catch {
    return false;
  }
}

function simulationSigningHeaders(
  owner: string,
  target: URL,
  method: string,
  body: string | undefined,
  secret: string,
): Record<string, string> {
  const encodedOwner = Buffer.from(owner, 'utf8').toString('base64url');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash('sha256')
    .update(body === undefined ? Buffer.alloc(0) : Buffer.from(body, 'utf8'))
    .digest('hex');
  const canonical = `v1\n${timestamp}\n${encodedOwner}\n${method}\n${target.pathname}${target.search}\n${bodyHash}`;
  return {
    [SIMULATION_HEADERS.owner]: encodedOwner,
    [SIMULATION_HEADERS.timestamp]: timestamp,
    [SIMULATION_HEADERS.signature]: createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(canonical)
      .digest('hex'),
  };
}

function bridgeDisabled(response: Response): void {
  response.status(503).setHeader('Cache-Control', 'no-store').json({
    ok: false,
    error: 'MUJOCO_BRIDGE_NOT_CONFIGURED',
    message: '本地 MuJoCo 仿真服务未启用：设置 RDK_SIM2REAL_MUJOCO_WEB_URL 后重启服务。',
  });
}

async function bridgeUnavailable(response: Response, requestId: unknown): Promise<void> {
  response
    .status(502)
    .setHeader('Cache-Control', 'no-store')
    .json({
      ok: false,
      error: 'MUJOCO_BRIDGE_UNAVAILABLE',
      message: 'MuJoCo 仿真服务暂时不可达，请确认 18100 端口的 mujoco-web 服务正在运行。',
      ...(typeof requestId === 'string' && requestId ? { requestId } : {}),
    });
}

/**
 * Create the `/mujoco/api` forwarding handler. The handler resolves the
 * upstream per request so operators can start the MuJoCo service after the
 * web process (the common dev order) without a restart.
 */
export function createMujocoApiBridge(options: { auth?: Sim2RealAuthPort } = {}): RequestHandler {
  const auth = options.auth ?? LOCAL_SIM2REAL_AUTH;
  return (request, response, next) => {
    const owner = bridgeOwner(request, response, auth);
    if (owner === null) return;
    if (!mutationOriginAllowed(request, auth.isMultiUserDeployment())) {
      rejectBridgeRequest(
        response,
        403,
        'SIM2REAL_CSRF_BLOCKED',
        '仿真写操作必须来自当前工作台页面。',
      );
      return;
    }
    const secret = String(process.env[MUJOCO_SIMULATION_SECRET_ENV] ?? '');
    const secretConfigured = Buffer.byteLength(secret, 'utf8') >= 32;
    if (!secretConfigured && (auth.isMultiUserDeployment() || secret.length > 0)) {
      rejectBridgeRequest(
        response,
        503,
        'MUJOCO_BRIDGE_AUTH_NOT_CONFIGURED',
        '仿真身份桥接未配置：需要至少 32 字节的 RDK_SIM2REAL_SIMULATION_SECRET。',
      );
      return;
    }
    const origin = configuredMujocoWebUrl();
    if (!origin) {
      bridgeDisabled(response);
      return;
    }
    if (!forwardableMethod(request.method)) {
      response.status(405).setHeader('Allow', 'GET, POST, DELETE, HEAD, OPTIONS').json({
        ok: false,
        error: 'MUJOCO_BRIDGE_METHOD_NOT_ALLOWED',
        message: '该转发路由仅支持 GET/POST/DELETE/HEAD/OPTIONS。',
      });
      return;
    }

    // express.json() has already parsed `/mujoco/api` POST bodies (cmd_vel,
    // step, reset) into an object by the time this runs; re-serialize them
    // for the upstream hop rather than re-reading the stream.
    const method = request.method.toUpperCase();
    const body =
      request.body !== undefined && !['GET', 'HEAD'].includes(method)
        ? JSON.stringify(request.body)
        : undefined;
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > MUJOCO_BRIDGE_MAX_REQUEST_BYTES) {
      rejectBridgeRequest(
        response,
        413,
        'MUJOCO_BRIDGE_REQUEST_TOO_LARGE',
        '仿真请求超过 2 MiB 上限。',
      );
      return;
    }

    const rawSuffix = (request.params as Record<string, string | string[]>).splat ?? '';
    // The route pattern captures everything AFTER `/mujoco/api` (nginx strips
    // `/mujoco/` and forwards `/api/...` to the service), so re-attach the
    // `/api` prefix before the captured suffix.
    const suffix = (Array.isArray(rawSuffix) ? rawSuffix.join('/') : String(rawSuffix)).replace(
      /^\/+/,
      '',
    );
    const target = new URL(`api/${suffix}`, origin);
    const apiRoot = new URL('api/', origin);
    if (target.origin !== apiRoot.origin || !target.pathname.startsWith(apiRoot.pathname)) {
      rejectBridgeRequest(response, 400, 'MUJOCO_BRIDGE_INVALID_PATH', '仿真接口路径无效。');
      return;
    }
    // request.url keeps the original query string (e.g. `?t=123` on frame
    // fetches); carry it over verbatim.
    const queryIndex = request.url.indexOf('?');
    target.search = queryIndex >= 0 ? request.url.slice(queryIndex) : '';

    const requestId = response.getHeader('X-Request-Id');
    void (async () => {
      try {
        const upstream = await fetch(target, {
          method,
          headers: {
            accept: String(request.headers.accept ?? 'application/json'),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(secretConfigured
              ? simulationSigningHeaders(owner, target, method, body, secret)
              : {}),
          },
          body,
          // The upstream is the only permitted authority, exactly like the
          // nginx route; a redirect could move the hop to an unreviewed host.
          redirect: 'error',
          signal: AbortSignal.timeout(MUJOCO_BRIDGE_TIMEOUT_MS),
        });

        response.status(upstream.status);
        const contentType = upstream.headers.get('content-type');
        if (contentType) response.setHeader('content-type', contentType);
        response.setHeader('cache-control', 'no-store');
        response.setHeader('x-mujoco-bridge', 'forward');

        const declared = upstream.headers.get('content-length');
        if (declared !== null) {
          const normalized = declared.trim();
          const declaredLength = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
          if (
            !Number.isSafeInteger(declaredLength) ||
            declaredLength < 0 ||
            declaredLength > MUJOCO_BRIDGE_MAX_RESPONSE_BYTES
          ) {
            await upstream.body?.cancel().catch(() => undefined);
            throw new Error('mujoco_bridge_response_too_large');
          }
        }

        if (!upstream.body || request.method === 'HEAD' || upstream.status === 204) {
          response.end();
          return;
        }

        const reader = upstream.body.getReader();
        request.on('close', () => {
          void reader.cancel().catch(() => undefined);
        });
        let streamed = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            streamed += value.byteLength;
            if (streamed > MUJOCO_BRIDGE_MAX_RESPONSE_BYTES) {
              await reader.cancel().catch(() => undefined);
              response.destroy(new Error('mujoco_bridge_response_too_large'));
              return;
            }
            if (value && !response.write(value)) {
              await new Promise<void>((resolve) => response.once('drain', resolve));
            }
          }
        } catch {
          // Upstream closed mid-stream; the browser sees a truncated body,
          // which the sim page already treats as a retryable loop error.
        } finally {
          response.end();
        }
      } catch (error) {
        console.error('[sim2real-web] MuJoCo bridge failed:', redactBridgeError(error));
        await bridgeUnavailable(response, requestId).catch(() => {
          response.destroy();
        });
      }
    })().catch(next);
  };
}

function redactBridgeError(error: unknown): string {
  const message = String((error as Error)?.message ?? error ?? 'unknown');
  return message.slice(0, 200);
}
