import type { RequestHandler, Response } from 'express';

/**
 * Local MuJoCo Web bridge.
 *
 * In production nginx owns `/mujoco/` and `proxy_pass`es it straight to the
 * standalone MuJoCo service (127.0.0.1:18100), so the SPA's simulator iframe
 * is always same-origin. Local development has no nginx, and the OriginBot
 * simulator page calls `/mujoco/api/*` at 20 Hz; without this bridge every
 * one of those calls lands on the SPA fallback and comes back as an HTML 404
 * that the page can only surface as "Loading…". The bridge reproduces the
 * nginx route inside the dev process: forward method, path, query and JSON
 * body verbatim and stream the upstream response back.
 */

export const MUJOCO_BRIDGE_URL_ENV = 'RDK_SIM2REAL_MUJOCO_WEB_URL';

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
export function configuredMujocoWebUrl(raw: unknown = process.env[MUJOCO_BRIDGE_URL_ENV]): URL | null {
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
export function createMujocoApiBridge(): RequestHandler {
  return (request, response, next) => {
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
    const body =
      request.body !== undefined && Object.keys(request.body).length > 0
        ? JSON.stringify(request.body)
        : undefined;

    const rawSuffix = (request.params as Record<string, string | string[]>).splat ?? '';
    // The route pattern captures everything AFTER `/mujoco/api` (nginx strips
    // `/mujoco/` and forwards `/api/...` to the service), so re-attach the
    // `/api` prefix before the captured suffix.
    const suffix = (Array.isArray(rawSuffix) ? rawSuffix.join('/') : String(rawSuffix)).replace(
      /^\/+/,
      '',
    );
    const target = new URL(`api/${suffix}`, origin);
    // request.url keeps the original query string (e.g. `?t=123` on frame
    // fetches); carry it over verbatim.
    const queryIndex = request.url.indexOf('?');
    target.search = queryIndex >= 0 ? request.url.slice(queryIndex) : '';

    const requestId = response.getHeader('X-Request-Id');
    void (async () => {
      try {
        const upstream = await fetch(target, {
          method: request.method.toUpperCase(),
          headers: {
            accept: String(request.headers.accept ?? 'application/json'),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
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
