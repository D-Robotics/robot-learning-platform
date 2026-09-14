/**
 * Standalone Sim2Real web service.
 *
 * This process intentionally owns its own web surface. It is not mounted into
 * the RDK Studio React shell; the shared contract and guarded server adapters
 * are reused so the browser and board hand-off cannot drift apart.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import express, { type Express } from 'express';

import { MICRODUCK_SIM2REAL_CONTRACT, SIM2REAL_SCHEMA_VERSION } from '../../shared/sim2real.js';
import {
  createDeviceBoardDetectRouter,
  isSSOEnabled,
  isSSORequired,
  registerSSORoutes,
  restoreSsoSessionsFromDisk,
  runOnDevice,
  isBoardAgentConfigured,
  boardAgentTokenRequired,
  boardAgentTokenConfigured,
  sim2RealCsrfMiddleware,
  ssoAuthMiddleware,
  storageRequestContextMiddleware,
  studioSecurityHeadersMiddleware,
} from '../../server/sim2real/standalone-adapters.js';
import { createStudioLoginRelayRouter } from '../../server/sim2real/studio-login-relay.js';
import { createRateLimitMiddleware } from '../../server/sim2real/rate-limit.js';
import { redactInternalError } from '../../server/sim2real/http-helpers.js';
import { createSim2RealObservability } from '../../server/sim2real/observability.js';
import {
  createSim2RealAuditMiddleware,
  sim2RealAuditHealth,
} from '../../server/sim2real/audit-log.js';
import {
  principalCan,
  SIM2REAL_PERMISSIONS,
  principalRoles,
} from '../../server/sim2real/sim2real-rbac.js';
import {
  createSim2RealRouter,
  SIM2REAL_VERSIONED_API_PREFIX,
} from '../../server/routes/sim2real-routes.js';
import { createSim2RealAgentRouter } from '../../server/routes/sim2real-agent-routes.js';
import {
  createDshRuntime,
  askDsh,
  dshRuntimeEnabled,
} from '../../server/agent-runtime/dsh-runtime.js';
import {
  listCapabilities,
  // DSH's product tools are reported separately from the legacy planner
  // atoms: the latter are route delegates, while the former require an
  // explicitly bound handler in this process.
  registerCapability,
} from '../../server/agent-runtime/plugins/registry.js';
import { listDshCapabilityCatalog } from '../../server/agent-runtime/dsh-capability-tools.js';
import { sim2RealStorageReadiness } from '../../server/sim2real/sim2real-store.js';
import {
  studioSsoAdapterConfigured,
  studioSsoAdapterMode,
  studioSsoAuth,
} from './studio-sso-auth.js';

export { redactInternalError } from '../../server/sim2real/http-helpers.js';

const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(SERVICE_ROOT, 'public');
const DEFAULT_PORT = 18_102;
/** Keep slow clients from holding a production process indefinitely. */
export const SIM2REAL_HTTP_REQUEST_TIMEOUT_MS = 120_000;
export const SIM2REAL_HTTP_HEADERS_TIMEOUT_MS = 15_000;
export const SIM2REAL_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const SIM2REAL_HTTP_MAX_REQUESTS_PER_SOCKET = 1_000;
const SIM2REAL_DSH_MAX_PROMPT_CHARS = 12_000;
const SIM2REAL_DSH_MAX_MODEL_CHARS = 160;
const SIM2REAL_DSH_MAX_RESPONSE_CHARS = 20_000;
const SAFE_DSH_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

/**
 * DSH keeps rich session events internally (tool arguments, provider
 * metadata, and sometimes credentials supplied to a connector). The HTTP
 * contract only needs a diagnostic tail, so project each event to its type and
 * timestamp before it crosses the browser boundary.
 */
export function publicDshEventTail(value: unknown): Array<{ type: string; at?: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(-50).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const type =
      typeof source.type === 'string'
        ? source.type.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80)
        : '';
    if (!type) return [];
    const atValue = source.at ?? source.timestamp ?? source.createdAt ?? source.time;
    let at = '';
    if (typeof atValue === 'number' && Number.isFinite(atValue)) {
      const date = new Date(atValue);
      if (Number.isFinite(date.getTime())) at = date.toISOString();
    } else if (typeof atValue === 'string') {
      at = atValue.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
    }
    return [at ? { type, at } : { type }];
  });
}

export function publicDshText(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      : '';
  if (!text) return 'DSH 已完成本轮，但没有返回文本。';
  if (text.length <= SIM2REAL_DSH_MAX_RESPONSE_CHARS) return text;
  return `${text.slice(0, SIM2REAL_DSH_MAX_RESPONSE_CHARS - 1)}…`;
}
/**
 * A reviewed MicroDuck release is allowed to contain a large WASM binary, but
 * an upstream that streams forever must never turn the web process into an
 * unbounded byte pump.  The limit is deliberately generous for the current
 * release while still giving operators a deterministic failure boundary.
 */
export const SIM2REAL_MICRODUCK_PROXY_MAX_BYTES = 64 * 1024 * 1024;

export function hardenSim2RealHttpServer(server: HttpServer): void {
  server.requestTimeout = SIM2REAL_HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SIM2REAL_HTTP_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SIM2REAL_HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = SIM2REAL_HTTP_MAX_REQUESTS_PER_SOCKET;
}

type MicroduckSurface = {
  state: 'mounted' | 'redirect' | 'missing';
  entryUrl: string;
  message: string;
};

function configuredPort(): number {
  const value = Number(process.env.RDK_SIM2REAL_PORT ?? DEFAULT_PORT);
  return Number.isInteger(value) && value >= 1_024 && value <= 65_535 ? value : DEFAULT_PORT;
}

function configuredHost(): string {
  return String(process.env.RDK_SIM2REAL_BIND_HOST ?? '').trim() || '127.0.0.1';
}

function publicPath(pathname: string): string {
  const rawBase = String(process.env.RDK_SIM2REAL_PUBLIC_BASE_PATH ?? '').trim();
  const base = rawBase && rawBase !== '/' ? `/${rawBase.replace(/^\/+|\/+$/g, '')}` : '';
  if (!base || !pathname.startsWith('/') || pathname.startsWith(`${base}/`)) return pathname;
  return `${base}${pathname}`;
}

/**
 * Return the canonical browser mount prefix.  The reverse proxy may expose
 * this service below any path (not only the historical `/sim2real` prefix),
 * so the SPA receives the value from the server instead of guessing from the
 * current URL. Invalid values fail closed to the root mount.
 */
export function configuredPublicBasePath(): string {
  const raw = String(process.env.RDK_SIM2REAL_PUBLIC_BASE_PATH ?? '').trim();
  if (!raw || raw === '/') return '';
  const normalized = `/${raw.replace(/^\/+|\/+$/g, '')}`;
  return /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized) ? normalized : '';
}

function sendIndexDocument(response: express.Response): void {
  try {
    const html = readFileSync(path.join(PUBLIC_ROOT, 'index.html'), 'utf8').replace(
      '__RDK_SIM2REAL_BASE_PATH__',
      configuredPublicBasePath(),
    );
    response.setHeader('Cache-Control', 'no-cache');
    response.type('html').send(html);
  } catch {
    response.status(503).json({
      ok: false,
      error: 'SIM2REAL_UI_UNAVAILABLE',
      message: '工作台入口暂时不可用。',
    });
  }
}

function configuredMicroduckRequired(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK ?? '')
      .trim()
      .toLowerCase(),
  );
}

export function publicUpstreamErrorMessage(kind: 'microduck' | 'dsh'): string {
  return kind === 'microduck'
    ? 'MicroDuck 上游仿真服务暂时不可达，请稍后重试。'
    : '智能体运行时暂时不可用，请稍后重试。';
}

function responseRequestId(response: express.Response): string | undefined {
  const value = typeof response.getHeader === 'function' ? response.getHeader('X-Request-Id') : '';
  return typeof value === 'string' && value ? value : undefined;
}

function sendPublicUpstreamError(
  response: express.Response,
  code: string,
  kind: 'microduck' | 'dsh',
): void {
  response.status(502).json({
    ok: false,
    error: code,
    message: publicUpstreamErrorMessage(kind),
    ...(responseRequestId(response) ? { requestId: responseRequestId(response) } : {}),
  });
}

/**
 * Read an upstream body through a byte budget.  Fetch's `arrayBuffer()` has no
 * size guard, and a chunked response can omit Content-Length, so check both
 * the declaration and every stream chunk.  A null body is treated as empty;
 * this also keeps injected fetch shims from bypassing the bound with a custom
 * unbounded `arrayBuffer()` implementation.
 */
async function boundedUpstreamBytes(
  response: globalThis.Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const normalized = declaredHeader.trim();
    const declared = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('microduck_proxy_response_too_large');
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('microduck_proxy_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function requestCorrelationId(value: unknown): string {
  const candidate = String(value ?? '').trim();
  // Preserve a gateway-provided correlation id when it is a bounded printable
  // value. Otherwise mint one here so every response can be traced safely.
  return /^[\x21-\x7e]{1,128}$/.test(candidate) ? candidate : randomUUID();
}

function configuredMicroduckRoot(): string | null {
  const raw = String(process.env.RDK_SIM2REAL_MICRODUCK_ROOT ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) return null;
  try {
    return existsSync(path.join(raw, 'index.html')) && statSync(raw).isDirectory() ? raw : null;
  } catch {
    return null;
  }
}

export function normalizeMicroduckRedirect(raw: string | undefined): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  ) {
    return null;
  }
  return parsed.toString();
}

export function microduckSurface(): MicroduckSurface {
  const root = configuredMicroduckRoot();
  if (root) {
    return {
      state: 'mounted',
      entryUrl: publicPath('/mujoco/microduck/'),
      message: 'MicroDuck 静态仿真资源已挂载。',
    };
  }
  const redirect = normalizeMicroduckRedirect(process.env.RDK_SIM2REAL_MICRODUCK_URL);
  if (redirect) {
    return {
      state: 'redirect',
      entryUrl: redirect,
      message: 'MicroDuck 由独立仿真服务提供，入口将安全跳转。',
    };
  }
  return {
    state: 'missing',
    entryUrl: publicPath('/mujoco/microduck/'),
    message: '尚未挂载 MicroDuck 静态资源；当前提供安装指引页。',
  };
}

function microduckUnavailablePage(response: express.Response): void {
  response
    .status(503)
    .setHeader('Cache-Control', 'no-store')
    .sendFile(path.join(PUBLIC_ROOT, 'microduck-unavailable.html'));
}

async function proxyMicroduck(request: express.Request, response: express.Response): Promise<void> {
  const origin = normalizeMicroduckRedirect(process.env.RDK_SIM2REAL_MICRODUCK_URL)?.replace(
    /\/+$/,
    '',
  );
  if (!origin) {
    microduckUnavailablePage(response);
    return;
  }
  const rawSuffix = (request.params as Record<string, string | string[]>).splat ?? '';
  const suffix = (Array.isArray(rawSuffix) ? rawSuffix.join('/') : String(rawSuffix)).replace(
    /^\/+/,
    '',
  );
  const target = `${origin}${suffix ? `/${suffix}` : '/'}`;
  // Rewritable content types (HTML/JS) must be fully buffered to rewrite the
  // upstream absolute /bundle/ paths. Everything else — including the ~10 MB
  // MuJoCo WASM — is streamed straight through so concurrent loads do not
  // multiply memory usage inside this process.
  const isRewritable = (contentType: string): boolean =>
    contentType.includes('text/html') || contentType.includes('javascript');
  // Immutable hashed assets (WASM, JS, fonts) can be cached by the browser
  // for the session so a cold upstream is only paid once per client; HTML
  // entry documents must always revalidate so a new release is picked up.
  const cacheControlFor = (contentType: string): string =>
    contentType.includes('text/html') ? 'no-cache' : 'public, max-age=3600';
  try {
    // The MuJoCo runtime is a ~10 MB WASM asset on a cold HF Space. Keep the
    // bridge timeout long enough for that first load; subsequent browser
    // loads are served from the browser cache via cache-control above.
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(120_000),
      // The configured origin is the only permitted upstream authority. A
      // redirect could otherwise move the proxy to an unreviewed host while
      // the browser still sees a same-origin response.
      redirect: 'error',
    });
    response.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    response.setHeader('content-type', contentType);
    response.setHeader('cache-control', cacheControlFor(contentType));
    const declaredHeader = upstream.headers.get('content-length');
    if (declaredHeader !== null) {
      const normalized = declaredHeader.trim();
      const declaredLength = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > SIM2REAL_MICRODUCK_PROXY_MAX_BYTES
      ) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new Error('microduck_proxy_response_too_large');
      }
    }
    if (!upstream.body || !isRewritable(contentType)) {
      response.setHeader('x-microduck-proxy', 'stream');
      const reader = upstream.body?.getReader();
      if (!reader) {
        response.end(await boundedUpstreamBytes(upstream, SIM2REAL_MICRODUCK_PROXY_MAX_BYTES));
        return;
      }
      request.on('close', () => {
        void reader.cancel().catch(() => undefined);
      });
      response.on('error', () => {
        void reader.cancel().catch(() => undefined);
      });
      try {
        let streamed = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          streamed += value.byteLength;
          if (streamed > SIM2REAL_MICRODUCK_PROXY_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            // Headers may already be visible to the browser. Destroying the
            // response is the only honest way to terminate a chunked body
            // after the byte budget has been crossed.
            response.destroy(new Error('microduck_proxy_response_too_large'));
            return;
          }
          if (value && !response.write(value)) {
            await new Promise<void>((resolve) => response.once('drain', resolve));
          }
        }
      } catch {
        // upstream closed mid-stream
      } finally {
        response.end();
      }
      return;
    }
    const bytes = await boundedUpstreamBytes(upstream, SIM2REAL_MICRODUCK_PROXY_MAX_BYTES);
    if (contentType.includes('text/html')) {
      const html = new TextDecoder()
        .decode(bytes)
        .replaceAll('src="/bundle/', 'src="/mujoco/microduck-proxy/bundle/')
        .replaceAll('href="/bundle/', 'href="/mujoco/microduck-proxy/bundle/');
      response.send(html);
      return;
    }
    // The upstream app keeps its WASM paths absolute (`/bundle/...`). Once
    // mounted below our same-origin prefix those URLs would escape the bridge
    // and hit the host app's HTML fallback, which WebAssembly reports as the
    // familiar "expected magic word" error. Rewrite only JavaScript assets.
    const script = new TextDecoder()
      .decode(bytes)
      .replaceAll('/bundle/', '/mujoco/microduck-proxy/bundle/');
    response.send(script);
  } catch (error) {
    console.error('[sim2real-web] MicroDuck proxy failed:', redactInternalError(error));
    sendPublicUpstreamError(response, 'MICRODUCK_PROXY_UNAVAILABLE', 'microduck');
  }
}

export function createSim2RealWebApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  if (String(process.env.EXPRESS_TRUST_PROXY ?? '').trim() === '1') app.set('trust proxy', 1);

  // Keep a stable identifier across gateway, API and server logs. This is
  // deliberately generated before auth/CSRF so rejected requests are
  // diagnosable too, without trusting arbitrary headers as identity.
  app.use((request, response, next) => {
    const header = request.headers['x-request-id'];
    const incoming = Array.isArray(header) ? header[0] : header;
    response.setHeader('X-Request-Id', requestCorrelationId(incoming));
    next();
  });

  // Keep the same signed-cookie context as the board/device adapters.
  app.use(storageRequestContextMiddleware);
  app.use(studioSecurityHeadersMiddleware);

  // Install request observability, audit and rate limiting before the JSON
  // parser.  A malformed or oversized body is still a request that must be
  // counted, bounded and (for mutating API calls) auditable; Express otherwise
  // jumps straight to the error handler and silently skips all three layers.
  // Each app instance owns its own registry, which keeps counters isolated
  // between tests and embedded deployments.
  const observability = createSim2RealObservability();
  app.use(observability.requestMiddleware);
  app.use(createSim2RealAuditMiddleware(studioSsoAuth));
  app.use(
    createRateLimitMiddleware({
      resolveOwner: (request) => {
        // Reuse the composition root's verified auth port instead of inventing
        // a second identity path. Single-user mode is one principal, so the
        // transport address is the correct bucket there.
        if (!studioSsoAuth.isMultiUserDeployment()) return null;
        const principal = studioSsoAuth.resolvePrincipal(request);
        const accountId = String(principal?.accountId ?? '').trim();
        return accountId ? `sso:${accountId}:web` : null;
      },
    }),
  );
  // Parse only after the protective request layers are attached.  The final
  // error boundary below converts parser failures into stable JSON responses.
  app.use(express.json({ limit: '2mb' }));

  // Stable capability catalog for DSH/plugin clients. This is intentionally
  // public metadata; execution still goes through authenticated domain routes.
  app.get('/api/sim2real/agent/capabilities', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const dsh = Boolean(app.locals.dshRuntime);
    response.json({
      ok: true,
      runtime: dsh ? 'dsh' : dshRuntimeEnabled() ? 'dsh-configured' : 'legacy',
      capabilities: listCapabilities(),
      dsh: {
        configured: dshRuntimeEnabled(),
        initialized: dsh,
        // `bound: false` is intentional in the public reference service: the
        // board/GPU adapters are deployment-owned and are not silently faked.
        capabilities: listDshCapabilityCatalog(),
      },
    });
  });

  // Health is intentionally public so systemd/nginx can probe the service
  // without possessing an account session.
  const healthPayload = async () => {
    const surface = microduckSurface();
    const storage = await sim2RealStorageReadiness();
    const audit = await sim2RealAuditHealth();
    const microduckRequired = configuredMicroduckRequired();
    // Use the actual injected adapter as the source of truth. In particular,
    // trusted-proxy mode can be enabled independently of the legacy deployment
    // profile flags; reporting local-single-user in that case would be unsafe.
    const authRequired = studioSsoAuth.isMultiUserDeployment();
    const authAdapterConfigured = studioSsoAdapterConfigured();
    const directBoardAgentConfigured = Boolean(
      String(process.env.RDK_SIM2REAL_BOARD_AGENT_URL ?? '').trim(),
    );
    const boardAgentReady = isBoardAgentConfigured();
    const degraded: string[] = [];
    if (surface.state === 'missing') degraded.push('microduck-not-mounted');
    if (!storage.writable) degraded.push('storage-not-configured');
    if (authRequired && !authAdapterConfigured) degraded.push('sso-adapter-required');
    if (directBoardAgentConfigured && !boardAgentReady) {
      degraded.push(
        boardAgentTokenRequired(true) && !boardAgentTokenConfigured()
          ? 'board-agent-auth-required'
          : 'board-agent-not-configured',
      );
    }
    // In production the audit trail is part of the release evidence contract:
    // once an append has failed, stop accepting traffic until the operator
    // repairs the audit volume. Local development remains usable while a
    // transient log directory is being created.
    if (process.env.NODE_ENV === 'production' && !audit.healthy) {
      degraded.push('audit-unavailable');
    }
    return {
      ok: true,
      service: 'sim2real-web',
      schemaVersion: SIM2REAL_SCHEMA_VERSION,
      contractId: MICRODUCK_SIM2REAL_CONTRACT.id,
      ssoRequired: isSSORequired(),
      ssoConfigured: isSSOEnabled() || authAdapterConfigured,
      authRequired,
      authMode: authRequired
        ? authAdapterConfigured
          ? studioSsoAdapterMode()
          : 'sso-adapter-required'
        : 'local-single-user',
      microduck: surface,
      microduckRequired,
      storage,
      audit: {
        configured: audit.configured,
        readable: audit.readable,
        writable: audit.writable,
        healthy: audit.healthy,
        eventCount: audit.eventCount ?? null,
        ...(audit.lastErrorAt ? { lastErrorAt: audit.lastErrorAt } : {}),
      },
      boardAgent: {
        configured: directBoardAgentConfigured || boardAgentReady,
        directConfigured: directBoardAgentConfigured,
        ready: boardAgentReady,
        ...(directBoardAgentConfigured && boardAgentTokenRequired(true)
          ? { tokenConfigured: boardAgentTokenConfigured() }
          : {}),
      },
      // Readiness is the traffic gate, so every configured hard dependency
      // must be healthy.  An optional MicroDuck bundle may remain absent, but
      // a declared BoardAgent with bad credentials, a missing SSO adapter, or
      // a production audit outage must never look ready to a load balancer.
      ready:
        !degraded.some((item) => item !== 'microduck-not-mounted' || microduckRequired) &&
        (!authRequired || authAdapterConfigured),
      degraded,
    };
  };
  const health = async (_request: express.Request, response: express.Response): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await healthPayload());
  };
  app.get('/healthz', health);
  app.get('/api/healthz', health);
  app.get('/readyz', async (_request, response) => {
    const payload = await healthPayload();
    response.status(payload.ready ? 200 : 503).json(payload);
  });
  app.get('/api/readyz', async (_request, response) => {
    const payload = await healthPayload();
    response.status(payload.ready ? 200 : 503).json(payload);
  });

  // Prometheus scrape endpoint. It exposes only this process's counters,
  // normalized route labels and gauges — no environment, token or path data —
  // and is exempt from the application rate limit so a scrape never trips it.
  // The body is written with `end` (not `send`) so Express cannot reorder the
  // `version=0.0.4` content-type parameter.
  app.get('/metrics', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    response.end(observability.renderMetrics());
  });

  // Identity is supplied by the injected composition-root adapter. The public
  // default has no session store; a trusted SSO gateway (or a deployment-owned
  // OIDC adapter) must establish the account before shared mode is enabled.
  // The audit middleware was installed before the parser above, so rejected
  // auth/CSRF, rate-limit and parser responses are all retained. It records
  // only method/route/status and a verified principal when one exists;
  // unauthenticated attempts intentionally have no owner.
  registerSSORoutes(app);
  app.use(ssoAuthMiddleware);
  // Mount order matters: the credential relay must sit behind the CSRF
  // boundary so a cross-site page cannot post credentials through this
  // service. Same-origin browser posts carry an allowed Origin and pass.
  app.use(sim2RealCsrfMiddleware);
  // DSH is an authenticated execution surface.  Keep the capability catalog
  // public for discovery, but require a verified principal and the optional
  // `agent` permission before a prompt can create a session or invoke tools.
  app.post('/api/sim2real/dsh/chat', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const principal = studioSsoAuth.resolvePrincipal(request);
    if (studioSsoAuth.isMultiUserDeployment() && !principal) {
      response
        .status(401)
        .json({ ok: false, error: 'SIM2REAL_AUTH_REQUIRED', message: '请先登录后使用智能体。' });
      return;
    }
    if (principal && !principalCan(principal, SIM2REAL_PERMISSIONS.agent)) {
      response.status(403).json({
        ok: false,
        error: 'SIM2REAL_PERMISSION_DENIED',
        message: '当前账号没有智能体执行权限。',
        roles: principalRoles(principal),
      });
      return;
    }
    const rawPrompt = request.body?.message;
    const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    if (!prompt) {
      response.status(400).json({ ok: false, error: 'MESSAGE_REQUIRED', message: '请输入消息。' });
      return;
    }
    if (prompt.length > SIM2REAL_DSH_MAX_PROMPT_CHARS) {
      response.status(400).json({
        ok: false,
        error: 'DSH_MESSAGE_TOO_LONG',
        message: `消息不能超过 ${SIM2REAL_DSH_MAX_PROMPT_CHARS} 个字符。`,
      });
      return;
    }
    const rawModel = request.body?.model;
    const model = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (
      rawModel !== undefined &&
      rawModel !== null &&
      (typeof rawModel !== 'string' ||
        !model ||
        model.length > SIM2REAL_DSH_MAX_MODEL_CHARS ||
        !SAFE_DSH_MODEL.test(model) ||
        model.split('/').some((segment) => segment === '.' || segment === '..' || !segment))
    ) {
      response.status(400).json({
        ok: false,
        error: 'DSH_MODEL_INVALID',
        message: '模型名称格式无效。',
      });
      return;
    }
    const runtime = app.locals.dshRuntime;
    if (!runtime) {
      response.status(503).json({
        ok: false,
        error: 'DSH_RUNTIME_DISABLED',
        message: 'DSH 运行时未启用，请设置 RDK_SIM2REAL_DSH_RUNTIME=1。',
      });
      return;
    }
    try {
      const result = await askDsh(runtime, prompt, { ...(model ? { model } : {}) });
      response.json({
        ok: true,
        sessionId: result.sessionId,
        text: publicDshText(result.text),
        events: publicDshEventTail(result.events),
      });
    } catch (error) {
      console.error('[sim2real-web] DSH chat failed:', redactInternalError(error));
      sendPublicUpstreamError(response, 'DSH_CHAT_FAILED', 'dsh');
    }
  });
  // Studio-cookie deployments also expose a credential relay so the workbench
  // can log in directly (POST /api/sso/login) instead of bouncing users to
  // the Studio main shell. The relay adopts the same site-wide cookie.
  app.use(createStudioLoginRelayRouter({ auth: studioSsoAuth }));

  // Board detection is read-only unless the caller explicitly asks the
  // existing route to persist the detected metadata. The sim2real router
  // itself only creates plans and runs the fixed preflight probe.
  app.use(createDeviceBoardDetectRouter(runOnDevice, { auth: studioSsoAuth }));
  // Studio SSO is injected at the standalone composition root. The Sim2Real
  // business router only sees the auth port, so the product can be extracted
  // into another repository or paired with a native OIDC adapter later.
  // Keep the original `/api/sim2real` paths for existing clients while
  // exposing the stable product API under `/api/v1/duck`. Both routers are
  // created by the same factory and share the same auth/store adapters, so the
  // aliases cannot drift in validation or side effects.
  app.use(createSim2RealRouter({ runOnDevice, auth: studioSsoAuth }));
  // Product Agent surface: the planner/executor owns the conversation task
  // lifecycle and calls the same guarded Sim2Real APIs as the UI. It shares
  // the same auth port so shared deployments keep conversation evidence
  // scoped to the verified account (fail-closed like the business routes).
  app.use(createSim2RealAgentRouter({ auth: studioSsoAuth }));
  app.use(
    createSim2RealRouter(
      { runOnDevice, auth: studioSsoAuth },
      { prefix: SIM2REAL_VERSIONED_API_PREFIX },
    ),
  );

  // Same-origin MicroDuck proxy used by the Agent control bridge. Register it
  // before the legacy `/mujoco/microduck` route because Express wildcard
  // matching treats the latter as a prefix.
  app.get('/mujoco/microduck-proxy/{*splat}', (request, response) => {
    void proxyMicroduck(request, response);
  });

  // MicroDuck is an optional, separately released static surface. Mounting it
  // here is useful for a self-contained deployment; when operators keep the
  // upstream simulator in its own service, a validated redirect is used. A
  // missing release gets an explicit 503 page instead of being mistaken for
  // the Sim2Real SPA (the old fallback made this look like a working simulator).
  // Resolve the release root per request. Operators can atomically switch the
  // reviewed `current` symlink without a race where healthz reports a mounted
  // bundle but the handler still holds the null/old path captured at startup.
  app.use('/mujoco/microduck', (request, response, next) => {
    const root = configuredMicroduckRoot();
    if (!root) {
      next();
      return;
    }
    express.static(root, { index: 'index.html' })(request, response, next);
  });
  app.get(['/mujoco/microduck', '/mujoco/microduck/'], (_request, response) => {
    const surface = microduckSurface();
    if (surface.state === 'redirect') {
      response.redirect(302, surface.entryUrl);
      return;
    }
    if (surface.state === 'mounted') {
      const root = configuredMicroduckRoot();
      if (root) {
        response.sendFile(path.join(root, 'index.html'));
        return;
      }
      microduckUnavailablePage(response);
      return;
    }
    microduckUnavailablePage(response);
  });
  app.get('/mujoco/microduck/{*splat}', (_request, response) => {
    if (microduckSurface().state === 'missing') microduckUnavailablePage(response);
    else response.status(404).json({ ok: false, error: 'MICRODUCK_ASSET_NOT_FOUND' });
  });

  // Keep the API surface machine-readable. Express' default final handler
  // returns an HTML 404 for unknown /api paths, which is especially confusing
  // for SDKs and the SPA when a route is mistyped.
  app.use('/api', (_request, response) => {
    response
      .status(404)
      .setHeader('Cache-Control', 'no-store')
      .json({
        ok: false,
        error: 'SIM2REAL_API_NOT_FOUND',
        message: 'API 路径不存在。',
        requestId: response.getHeader('X-Request-Id'),
      });
  });

  // Keep direct `/index.html` navigations on the same dynamic path as `/` so
  // a bookmarked entry receives the configured mount prefix too.
  app.get('/index.html', (_request, response) => sendIndexDocument(response));

  // The service is commonly mounted below a reverse-proxy prefix such as
  // `/sim2real/`.  Nginx strips that prefix before forwarding, so the browser
  // entry arrives here as `/`; Express' wildcard fallback does not match the
  // bare root in every Express 5/path-to-regexp combination.  Keep the two
  // product entry points explicit so the bookmarked public URLs resolve to a
  // document instead of an HTML 404.
  app.get('/', (_request, response) => sendIndexDocument(response));
  // Relative MuJoCo assets (`./sim.js`, frame paths) require the directory
  // URL. Canonicalize the no-slash bookmark instead of serving HTML that
  // would resolve those assets against `/sim2real/`.
  app.get('/originbot-sim', (request, response, next) => {
    // Express' default non-strict routing treats `/originbot-sim/` as a
    // match for this handler too. Only redirect the bookmark without the
    // slash; otherwise the browser follows an endless self-redirect loop.
    if (request.path !== '/originbot-sim') {
      next();
      return;
    }
    response.redirect(308, publicPath('/originbot-sim/'));
  });
  app.get('/originbot-sim/', (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(path.join(PUBLIC_ROOT, 'originbot-sim', 'index.html'));
  });

  app.use(
    express.static(PUBLIC_ROOT, {
      // Serve the HTML entry through the small dynamic handler below so the
      // configured reverse-proxy prefix is injected into its meta tag.
      index: false,
      // The HTML entry must always revalidate so cache-busted assets
      // (app.js?v=…) are picked up immediately; hashed/versioned assets
      // themselves may cache longer.
      setHeaders: (response, filePath) => {
        // The OriginBot page is deployed below a reverse-proxy prefix and is
        // frequently updated together with its MuJoCo adapter. Do not let a
        // long-lived static asset cache keep an old control loop after a
        // release; the page itself still uses a query version for CDNs that
        // ignore no-cache.
        const normalizedPath = path.normalize(filePath);
        if (
          filePath.endsWith('.html') ||
          normalizedPath.includes(`${path.sep}originbot-sim${path.sep}`)
        ) {
          response.setHeader('Cache-Control', 'no-cache');
        }
      },
      maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    }),
  );
  // Express 5 wildcard syntax keeps the SPA fallback compatible with paths
  // such as `/` and `/sim2real/` without the legacy path-to-regexp pattern.
  app.get('/{*splat}', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next();
      return;
    }
    sendIndexDocument(response);
  });

  app.use(
    (
      error: unknown,
      request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ): void => {
      console.error(
        '[sim2real-web] request failed',
        request.method,
        request.path,
        redactInternalError(error),
      );
      if (response.headersSent) return;
      if ((error as { type?: string })?.type === 'entity.too.large') {
        response.status(413).json({
          ok: false,
          error: 'SIM2REAL_REQUEST_TOO_LARGE',
          message: '请求体过大；请将遥测按更小的 JSON 分片上传。',
          retryable: false,
        });
        return;
      }
      if ((error as { type?: string })?.type === 'entity.parse.failed') {
        response.status(400).json({
          ok: false,
          error: 'SIM2REAL_INVALID_JSON',
          message: '请求体不是合法 JSON。',
          retryable: false,
        });
        return;
      }
      if (
        error instanceof Error &&
        (error.message === 'sim2real_storage_unavailable' ||
          error.message === 'sim2real_storage_not_configured' ||
          error.message === 'sim2real_storage_quota_exceeded')
      ) {
        response.status(error.message === 'sim2real_storage_quota_exceeded' ? 507 : 503).json({
          ok: false,
          error:
            error.message === 'sim2real_storage_quota_exceeded'
              ? 'SIM2REAL_STORAGE_QUOTA_EXCEEDED'
              : 'SIM2REAL_STORAGE_UNAVAILABLE',
          message:
            error.message === 'sim2real_storage_quota_exceeded'
              ? 'sim2real 台账已达到单实例大小上限，请迁移到对象存储 adapter。'
              : 'sim2real 台账暂不可用；请检查共享存储配置。',
          retryable: error.message !== 'sim2real_storage_quota_exceeded',
        });
        return;
      }
      response.status(500).json({
        ok: false,
        error: 'SIM2REAL_WEB_INTERNAL_ERROR',
        message: '独立仿真到真机服务暂时不可用，请稍后重试。',
        requestId: response.getHeader('X-Request-Id'),
      });
    },
  );

  return app;
}

export async function startSim2RealWebServer(): Promise<void> {
  // A standalone process may be restarted independently from Studio. Give a
  // deployment-owned adapter a chance to restore its sessions before accepting
  // requests; the public reference adapter is intentionally a no-op.
  await restoreSsoSessionsFromDisk().catch((error) => {
    console.warn('[sim2real-web] SSO session restore skipped:', redactInternalError(error));
  });

  const app = createSim2RealWebApp();
  // Product atoms are discoverable by DSH without exposing arbitrary routes.
  const atoms: Array<[string, string, boolean]> = [
    ['workspace.overview', '读取模型、设备和训练资源状态', true],
    ['board.health', '读取 BoardAgent 健康与遥测', true],
    ['training.gpu', '提交受控 GPU 训练任务', false],
    ['simulator.open', '打开浏览器参考仿真', true],
    ['evaluation.summarize', '汇总训练评测证据', true],
    ['deployment.preflight', '执行只读部署预检', true],
    ['board.stop', '停止板端策略与驱动', false],
  ];
  for (const [id, description, readOnly] of atoms) {
    try {
      registerCapability({
        id,
        description,
        readOnly: Boolean(readOnly),
        execute: async () => ({ delegated: true, capability: id }),
      });
    } catch {
      /* app reload keeps one registry */
    }
  }
  // DSH is composed once per service process. Product routes may expose only
  // atomic capabilities; they never construct a second agent loop.
  if (dshRuntimeEnabled()) {
    try {
      const dsh = await createDshRuntime({
        persistenceRoot:
          process.env.RDK_SIM2REAL_DSH_HOME || path.join(process.cwd(), '.sim2real-dsh'),
      });
      app.locals.dshRuntime = dsh;
      console.log('[sim2real-web] DSH runtime composed');
    } catch (error) {
      console.error('[sim2real-web] DSH runtime failed:', redactInternalError(error));
      throw error;
    }
  }
  const host = configuredHost();
  const port = configuredPort();
  const server = app.listen(port, host, () => {
    console.log(
      '[sim2real-web] listening on http://' +
        host +
        ':' +
        port +
        ' (contract=' +
        MICRODUCK_SIM2REAL_CONTRACT.id +
        ')',
    );
  });
  hardenSim2RealHttpServer(server);

  let closing = false;
  const close = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log('[sim2real-web] received ' + signal + '; closing');
    void app.locals.dshRuntime?.fiber?.dispose?.();
    const forceExit = setTimeout(() => process.exit(1), 5_000);
    forceExit.unref();
    server.close((error) => {
      clearTimeout(forceExit);
      if (error) {
        console.error('[sim2real-web] close failed:', redactInternalError(error));
        process.exitCode = 1;
      }
      process.exit();
    });
  };
  process.once('SIGTERM', () => close('SIGTERM'));
  process.once('SIGINT', () => close('SIGINT'));
}

function isDirectEntryInvocation(): boolean {
  const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  if (!argvPath) return false;
  // Production starts the service through /opt/rdk-robot-learning-platform/current, which is
  // an atomic symlink to a versioned release. Node may resolve import.meta.url
  // to the release path while process.argv[1] keeps the symlink path; compare
  // canonical paths so the standalone process still starts after a release
  // switch, while imports from tests remain side-effect free.
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return argvPath === modulePath;
  }
}

if (isDirectEntryInvocation()) {
  void startSim2RealWebServer().catch((error) => {
    console.error('[sim2real-web] startup failed:', redactInternalError(error));
    process.exitCode = 1;
  });
}
