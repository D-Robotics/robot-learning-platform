/**
 * Standalone Sim2Real web service.
 *
 * This process intentionally owns its own web surface. It is not mounted into
 * the RDK Studio React shell; the shared contract and guarded server adapters
 * are reused so the browser and board hand-off cannot drift apart.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  realpathSync,
  readFileSync,
  mkdirSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
  resolveDataDir,
} from '../../server/sim2real/standalone-adapters.js';
import { createStudioLoginRelayRouter } from '../../server/sim2real/studio-login-relay.js';
import { createRateLimitMiddleware } from '../../server/sim2real/rate-limit.js';
import { createMujocoApiBridge } from '../../server/sim2real/mujoco-bridge.js';
import { createResponseCompressionMiddleware } from '../../server/sim2real/response-compression.js';
import { redactInternalError } from '../../server/sim2real/http-helpers.js';
import { createSim2RealObservability } from '../../server/sim2real/observability.js';
import { createDobsOpsReporter } from '../../server/sim2real/dobs-ops-reporter.js';
import { registerSim2RealPlugin } from '../../server/sim2real/sim2real-events.js';
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
import { createSim2RealEventsSseRouter } from '../../server/routes/sim2real-events-sse.js';
import { createSim2RealAgentRouter } from '../../server/routes/sim2real-agent-routes.js';
import {
  askDsh,
  createDshRuntime,
  DshAgentFailure,
  dshRuntimeEnabled,
  resolveDshPersistenceRoot,
} from '../../server/agent-runtime/dsh-runtime.js';
import {
  createDshAuthChannel,
  createDshCapabilityHandlers,
  currentDshAuthHeaders,
} from '../../server/agent-runtime/dsh-capability-handlers.js';
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
  ssoLoginUrlForDeployment,
  registerAuthModeRoutes,
  studioSsoAuth,
} from './studio-sso-auth.js';
import {
  createStudioDirectRelay,
  renderStudioDirectLoginPage,
  STUDIO_DIRECT_LOGOUT_PATH,
  STUDIO_DIRECT_SESSION_COOKIES,
} from '../../server/sim2real/studio-direct-relay.js';
import {
  USER_CENTER_LOGOUT_PATH,
  userCenterAuthConfigured,
} from '../../server/sim2real/user-center-auth.js';
import {
  isProductionEnv,
  normalizeMicroduckRedirect,
  normalizePublicBasePath,
  parseBooleanFlag,
  parseDirectBoardAgentUrl,
  parseTrustProxyFlag,
  resolveMicroduckStaticRoot,
  resolveSim2RealWebEnv,
} from './runtime-config.js';

export { redactInternalError } from '../../server/sim2real/http-helpers.js';
export { normalizeMicroduckRedirect } from './runtime-config.js';

const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(SERVICE_ROOT, 'public');
/** Keep slow clients from holding a production process indefinitely. */
export const SIM2REAL_HTTP_REQUEST_TIMEOUT_MS = 120_000;
export const SIM2REAL_HTTP_HEADERS_TIMEOUT_MS = 15_000;
export const SIM2REAL_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const SIM2REAL_HTTP_MAX_REQUESTS_PER_SOCKET = 1_000;
const SIM2REAL_DSH_MAX_PROMPT_CHARS = 12_000;
const SIM2REAL_DSH_MAX_MODEL_CHARS = 160;
const SIM2REAL_DSH_MAX_RESPONSE_CHARS = 20_000;
/** Reasoning is a diagnostic trace, so its budget is tighter than the reply's. */
const SIM2REAL_DSH_MAX_REASONING_CHARS = 8_000;
const SIM2REAL_DSH_MAX_TOOL_TRAIL = 30;
const SAFE_DSH_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

const dshSessionTails = new Map<string, Promise<void>>();
type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
type PendingDshApproval = {
  id: string;
  ownerScope: string;
  toolName: string;
  reason: string;
  createdAt: string;
  settle: (outcome: DshApprovalOutcome) => void;
};
const pendingDshApprovals = new Map<string, PendingDshApproval>();
const DSH_APPROVAL_TTL_MS = 120_000;

/** Serialize turns that target one persisted conversation. */
async function withDshSessionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = dshSessionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  dshSessionTails.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (dshSessionTails.get(key) === queued) dshSessionTails.delete(key);
  }
}

function dshOwnerScope(principal: { accountId?: string } | null, multiUser: boolean): string {
  return multiUser
    ? `sso:${String(principal?.accountId ?? '').trim() || 'unknown'}`
    : 'single-user';
}

function scopedDshSessionId(publicSessionId: string, ownerScope: string): string {
  if (ownerScope === 'single-user') return publicSessionId;
  const ownerHash = createHash('sha256').update(ownerScope).digest('hex').slice(0, 16);
  return `sim2real-${ownerHash}-${publicSessionId.replace(/^sim2real-/, '')}`.slice(0, 160);
}

function createDshApproval(
  ownerScope: string,
  request: { toolName: string; reason?: string; signal?: AbortSignal },
): Promise<DshApprovalOutcome> {
  const id = `approval-${randomUUID()}`;
  return new Promise((resolve) => {
    const settle = (outcome: DshApprovalOutcome) => {
      const current = pendingDshApprovals.get(id);
      if (!current) return;
      pendingDshApprovals.delete(id);
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => settle('cancelled');
    const entry: PendingDshApproval = {
      id,
      ownerScope,
      toolName: request.toolName,
      reason: String(request.reason ?? '').slice(0, 500),
      createdAt: new Date().toISOString(),
      settle,
    };
    pendingDshApprovals.set(id, entry);
    const timer = setTimeout(() => settle('cancelled'), DSH_APPROVAL_TTL_MS);
    timer.unref?.();
    request.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function purgeDshApprovals(): void {
  const cutoff = Date.now() - DSH_APPROVAL_TTL_MS;
  for (const [, approval] of pendingDshApprovals) {
    if (Date.parse(approval.createdAt) < cutoff) approval.settle('cancelled');
  }
}

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
 * The model's reasoning/thinking trace, offered to the browser as an optional
 * collapsible. Same control-character scrub as the reply text, with its own
 * (tighter) budget: thinking is a trace, not the deliverable, and a runaway
 * reasoning stream must not dominate the payload.
 */
export function publicDshReasoning(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      : '';
  if (text.length <= SIM2REAL_DSH_MAX_REASONING_CHARS) return text;
  return `${text.slice(0, SIM2REAL_DSH_MAX_REASONING_CHARS - 1)}…`;
}

/**
 * Project the turn's tool calls into a compact trail for the chat UI: one
 * entry per call (tool name + step), with the paired outcome marking
 * success/failure. The runtime already walks the complete event list (stream
 * chunks push tool events out of any fixed tail window); this pass only
 * bounds and sanitizes what crosses the browser boundary. Names and outcomes
 * only — raw `arguments` and result payloads stay server-side (they can carry
 * ids and credentials), which keeps this a diagnostic surface rather than a
 * data exfiltration path.
 */
export function publicDshToolTrail(
  value: unknown,
): Array<{ name: string; step: number; ok: boolean }> {
  if (!Array.isArray(value)) return [];
  const seen: Array<{ name: string; step: number; ok: boolean | null }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const source = item as { name?: unknown; step?: unknown; ok?: unknown };
    if (typeof source.name !== 'string' || !source.name) continue;
    const name = source.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
    const step = Number(source.step);
    if (!name || !Number.isInteger(step)) continue;
    if (typeof source.ok !== 'boolean') continue;
    const entry = seen.find((candidate) => candidate.name === name && candidate.step === step);
    if (entry) entry.ok = source.ok;
    else seen.push({ name, step, ok: source.ok });
  }
  return seen
    .slice(-SIM2REAL_DSH_MAX_TOOL_TRAIL)
    .map((entry) => ({ name: entry.name, step: entry.step, ok: Boolean(entry.ok) }));
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

function publicPath(pathname: string): string {
  const base = normalizePublicBasePath(process.env.RDK_SIM2REAL_PUBLIC_BASE_PATH);
  if (!base || !pathname.startsWith('/') || pathname.startsWith(`${base}/`)) return pathname;
  return `${base}${pathname}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function gpuAgentInstallScript(origin: string, agentUrl: string): string {
  const quotedOrigin = shellSingleQuote(origin);
  const quotedAgentUrl = shellSingleQuote(agentUrl);
  return `#!/bin/sh
set -eu

# RDK Local GPU Agent installer. The agent only listens on 127.0.0.1.
PLATFORM_ORIGIN=${quotedOrigin}
AGENT_URL=${quotedAgentUrl}
AGENT_HOME="\${RDK_GPU_AGENT_HOME:-$HOME/.rdk-lab}"
AGENT_FILE="$AGENT_HOME/local-gpu-agent.mjs"
mkdir -p "$AGENT_HOME"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 22 或更高版本。请先安装 Node.js：https://nodejs.org/" >&2
  exit 2
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "需要 Node.js 22 或更高版本，当前为 $(node --version)。" >&2
  exit 2
fi
if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --location "$AGENT_URL" --output "$AGENT_FILE"
else
  node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw Error('download failed '+r.status);return r.text()}).then(t=>require('fs').writeFileSync(process.argv[2],t))" "$AGENT_URL" "$AGENT_FILE"
fi
chmod 600 "$AGENT_FILE"
if curl --silent --fail --max-time 1 http://127.0.0.1:19190/healthz >/dev/null 2>&1; then
  echo "RDK Local GPU Agent 已经在运行：http://127.0.0.1:19190"
  exit 0
fi
export RDK_GPU_AGENT_ALLOWED_ORIGINS="$PLATFORM_ORIGIN"
export RDK_GPU_AGENT_HOME="$AGENT_HOME"
nohup node "$AGENT_FILE" >"$AGENT_HOME/agent.log" 2>&1 </dev/null &
sleep 1
if curl --silent --fail --max-time 2 http://127.0.0.1:19190/healthz >/dev/null 2>&1; then
  echo "RDK Local GPU Agent 已启动。请回到网页点击“自动发现本机 Agent”。"
  echo "日志：$AGENT_HOME/agent.log"
else
  echo "Agent 启动失败，请查看 $AGENT_HOME/agent.log" >&2
  exit 1
fi
`;
}

/**
 * Return the canonical browser mount prefix.  The reverse proxy may expose
 * this service below any path (not only the historical `/sim2real` prefix),
 * so the SPA receives the value from the server instead of guessing from the
 * current URL. Invalid values fail closed to the root mount.
 */
export function configuredPublicBasePath(): string {
  return normalizePublicBasePath(process.env.RDK_SIM2REAL_PUBLIC_BASE_PATH);
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
  return parseBooleanFlag(process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK);
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
  return resolveMicroduckStaticRoot(process.env.RDK_SIM2REAL_MICRODUCK_ROOT);
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
  if (parseTrustProxyFlag(process.env.EXPRESS_TRUST_PROXY)) app.set('trust proxy', 1);

  // Keep a stable identifier across gateway, API and server logs. This is
  // deliberately generated before auth/CSRF so rejected requests are
  // diagnosable too, without trusting arbitrary headers as identity.
  app.use((request, response, next) => {
    const header = request.headers['x-request-id'];
    const incoming = Array.isArray(header) ? header[0] : header;
    response.setHeader('X-Request-Id', requestCorrelationId(incoming));
    next();
  });

  // Standalone deployments mount the SPA at `/`, but operators frequently
  // reach them through an unstripped `/sim2real/` prefix (bookmark, tunnel,
  // reverse proxy that forgot proxy_pass trailing-slash semantics). The
  // production gateway strips the prefix before forwarding; mirror that
  // contract here by rewriting `/sim2real/...` to `/...` before any route
  // sees it, and canonicalizing the prefix root to `/` so relative asset
  // links resolve against the served document. When a base path is actually
  // configured (RDK_SIM2REAL_PUBLIC_BASE_PATH) the gateway is expected to
  // strip it, so the rewrite is skipped to avoid double-stripping.
  const externalOnlyPrefix = configuredPublicBasePath() === '' ? '/sim2real' : null;
  if (externalOnlyPrefix) {
    app.use((request, response, next) => {
      // request.path stays raw (prefix intact) for log fidelity; only
      // request.url is rewritten, which is what Express routing consumes.
      if (request.path === externalOnlyPrefix) {
        response.redirect(308, '/');
        return;
      }
      if (request.path.startsWith(`${externalOnlyPrefix}/`)) {
        request.url = request.url.slice(externalOnlyPrefix.length);
      }
      next();
    });
  }

  // Keep the same signed-cookie context as the board/device adapters.
  app.use(storageRequestContextMiddleware);
  app.use(studioSecurityHeadersMiddleware);

  // gzip 响应压缩（零依赖，Node zlib）。379KB 的 app.js 在弱网下是首屏
  // 主要瓶颈；API JSON 顺带受益。SSE 与已编码的代理流在中间件内部跳过。
  // 放在安全头之后、观测之前：压缩是传输层关注点，不改变审计语义。
  app.use(createResponseCompressionMiddleware());

  // Install request observability, audit and rate limiting before the JSON
  // parser.  A malformed or oversized body is still a request that must be
  // counted, bounded and (for mutating API calls) auditable; Express otherwise
  // jumps straight to the error handler and silently skips all three layers.
  // Each app instance owns its own registry, which keeps counters isolated
  // between tests and embedded deployments.
  const dobsReporter = createDobsOpsReporter();
  const observability = createSim2RealObservability({
    ...(dobsReporter.enabled
      ? {
          // 5xx 埋点旁路：中间件保持零传输，网络投递归 reporter。
          onServerError: (input) => {
            dobsReporter.reportEvent({
              eventCode: 'http_5xx',
              outcome: 'error',
              safeSummary: `${input.method} ${input.route} ${input.status}`,
              metadata: {
                method: input.method,
                route: input.route,
                status: input.status,
                ...(input.requestId ? { requestId: input.requestId } : {}),
              },
            });
          },
        }
      : {}),
  });
  app.use(observability.requestMiddleware);
  app.use(createSim2RealAuditMiddleware(studioSsoAuth));
  // user-center 模式的登录/回调/注销路由必须先于业务路由挂载（回调写入
  // 的会话 cookie 由同步 resolvePrincipal 消费）。
  registerAuthModeRoutes(app);
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

  // studio-cookie 模式的独立登录页 + 直连登录中继（D-006 的轻量替代路径）：
  // 用户在本平台完成登录，凭据经服务端转发 Studio 直连 API，会话 cookie
  // 原样透传（同域同密钥），凭据不落日志、不落存储。
  if (studioSsoAdapterMode() === 'studio-cookie' && studioSsoAdapterConfigured()) {
    const studioRelay = createStudioDirectRelay({ basePath: configuredPublicBasePath() });
    const loginUrl = '/login';
    app.post(
      '/api/sim2real/auth/studio-direct/login',
      express.urlencoded({ extended: false }),
      (request, response) => {
        void studioRelay.handleForm(request, response);
      },
    );
    app.post(
      '/api/sim2real/auth/studio-direct/login.json',
      express.json({ limit: '4kb' }),
      (request, response) => {
        void studioRelay.handleJson(request, response);
      },
    );
    app.get('/login', (request, response) => {
      const error = String(request.query.error ?? '');
      response
        .type('html')
        .send(
          renderStudioDirectLoginPage(
            ['missing', 'invalid', 'unavailable'].includes(error) ? error : undefined,
            configuredPublicBasePath(),
            String(request.query.loggedOut ?? '') === '1' ? '已退出登录。' : undefined,
          ),
        );
    });
    void loginUrl;
  }

  // 当前会话身份（no-store）：顶栏“更多”菜单用它决定是否展示“账号/退出登录”。
  // 未认证或本地单用户模式返回 authenticated=false，前端保持原样。
  app.get('/api/sim2real/auth/session', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const principal = studioSsoAuth.resolvePrincipal(request);
    const base = configuredPublicBasePath();
    const mode = studioSsoAdapterMode();
    const logoutUrl =
      mode === 'studio-cookie' && studioSsoAdapterConfigured()
        ? `${base}${STUDIO_DIRECT_LOGOUT_PATH}`
        : mode === 'user-center' && userCenterAuthConfigured()
          ? `${base}${USER_CENTER_LOGOUT_PATH}`
          : null;
    response.json({
      ok: true,
      authenticated: Boolean(principal),
      ...(principal?.displayName ? { displayName: principal.displayName } : {}),
      ...(principal && !principal.displayName ? { accountId: principal.accountId } : {}),
      ...(logoutUrl ? { logoutUrl } : {}),
    });
  });

  // auth/session 广告的登出端点：逐一失效登录时透传的会话 cookie，再回到
  // 带提示的登录页。挂载为无条件路由（契约自检不配置认证环境也能看到），
  // 未启用直登面的部署按 404 应答。
  app.get('/api/sim2real/auth/studio-direct/logout', (request, response) => {
    if (!(studioSsoAdapterMode() === 'studio-cookie' && studioSsoAdapterConfigured())) {
      response.status(404).json({ ok: false, error: 'SIM2REAL_STUDIO_DIRECT_LOGOUT_UNAVAILABLE' });
      return;
    }
    for (const cookieName of STUDIO_DIRECT_SESSION_COOKIES) {
      response.clearCookie(cookieName, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
      });
    }
    response.redirect(`${configuredPublicBasePath()}/login?loggedOut=1`);
  });

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
        // Handlers are bound at startup in startSim2RealWebServer; this app
        // factory is also used by tests without a DSH composition, so the
        // catalog reflects whatever handlers the runtime received.
        capabilities:
          (app.locals as { dshCapabilityCatalog?: ReturnType<typeof listDshCapabilityCatalog> })
            .dshCapabilityCatalog ?? listDshCapabilityCatalog(),
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
      parseDirectBoardAgentUrl(process.env.RDK_SIM2REAL_BOARD_AGENT_URL),
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
    if (isProductionEnv() && !audit.healthy) {
      degraded.push('audit-unavailable');
    }
    return {
      ok: true,
      service: 'sim2real-web',
      schemaVersion: SIM2REAL_SCHEMA_VERSION,
      contractId: MICRODUCK_SIM2REAL_CONTRACT.id,
      ssoRequired: isSSORequired(),
      ssoConfigured: isSSOEnabled() || authAdapterConfigured,
      // user-center 模式下发给登录页/登录按钮的平台自有登录入口。挂在反向
      // 代理前缀下时（web-cloud）必须带前缀，否则浏览器会落到站点根 404。
      ssoLoginUrl: (() => {
        const loginPath = ssoLoginUrlForDeployment();
        return loginPath ? publicPath(loginPath) : undefined;
      })(),
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
      dobs: dobsReporter.health(),
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
  app.get('/api/sim2real/dsh/approvals', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const principal = studioSsoAuth.resolvePrincipal(request);
    if (studioSsoAuth.isMultiUserDeployment() && !principal) {
      response.status(401).json({ ok: false, error: 'SIM2REAL_AUTH_REQUIRED' });
      return;
    }
    if (principal && !principalCan(principal, SIM2REAL_PERMISSIONS.agent)) {
      response.status(403).json({ ok: false, error: 'SIM2REAL_PERMISSION_DENIED' });
      return;
    }
    purgeDshApprovals();
    const ownerScope = dshOwnerScope(principal, studioSsoAuth.isMultiUserDeployment());
    response.json({
      ok: true,
      approvals: [...pendingDshApprovals.values()]
        .filter((item) => item.ownerScope === ownerScope)
        .map(({ id, toolName, reason, createdAt }) => ({ id, toolName, reason, createdAt })),
    });
  });

  app.post('/api/sim2real/dsh/approvals/:approvalId', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const principal = studioSsoAuth.resolvePrincipal(request);
    if (studioSsoAuth.isMultiUserDeployment() && !principal) {
      response.status(401).json({ ok: false, error: 'SIM2REAL_AUTH_REQUIRED' });
      return;
    }
    if (principal && !principalCan(principal, SIM2REAL_PERMISSIONS.agent)) {
      response.status(403).json({ ok: false, error: 'SIM2REAL_PERMISSION_DENIED' });
      return;
    }
    const approvalId = String(request.params.approvalId || '').trim();
    const approval = pendingDshApprovals.get(approvalId);
    const ownerScope = dshOwnerScope(principal, studioSsoAuth.isMultiUserDeployment());
    if (!approval || approval.ownerScope !== ownerScope) {
      response.status(404).json({ ok: false, error: 'DSH_APPROVAL_NOT_FOUND' });
      return;
    }
    const decision = String(request.body?.decision || '')
      .trim()
      .toLowerCase();
    const outcome: DshApprovalOutcome =
      decision === 'allowed-once' || decision === 'approve' || decision === 'approved'
        ? 'allowed-once'
        : decision === 'reject' || decision === 'rejected' || decision === 'cancel'
          ? 'rejected'
          : 'unavailable';
    if (outcome === 'unavailable') {
      response.status(400).json({
        ok: false,
        error: 'DSH_APPROVAL_DECISION_INVALID',
        message: 'decision 必须是 approve 或 reject。',
      });
      return;
    }
    approval.settle(outcome);
    response.json({ ok: true, decision: outcome });
  });

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
    const rawSessionId = request.body?.sessionId;
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
    if (
      rawSessionId !== undefined &&
      (!sessionId || sessionId.length > 160 || !/^sim2real-[A-Za-z0-9-]+$/.test(sessionId))
    ) {
      response.status(400).json({
        ok: false,
        error: 'DSH_SESSION_INVALID',
        message: '对话会话标识无效。',
      });
      return;
    }
    const rawTurnId = request.body?.turnId;
    const turnId = typeof rawTurnId === 'string' ? rawTurnId.trim() : '';
    if (
      rawTurnId !== undefined &&
      (!turnId || turnId.length > 120 || !/^[A-Za-z0-9_-]+$/.test(turnId))
    ) {
      response.status(400).json({
        ok: false,
        error: 'DSH_TURN_INVALID',
        message: '对话轮次标识无效。',
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
    const requestAbort = new AbortController();
    const abortRequest = () => requestAbort.abort();
    request.once('aborted', abortRequest);
    try {
      // The browser sees an opaque per-conversation id. In shared deployments
      // the durable DSH id is owner-scoped, so knowing another user's local
      // storage value cannot open that user's transcript or tool context.
      const ownerScope = dshOwnerScope(principal, studioSsoAuth.isMultiUserDeployment());
      const publicSessionId = sessionId || `sim2real-${randomUUID()}`;
      const backendSessionId = scopedDshSessionId(publicSessionId, ownerScope);
      const sessionLockKey = `${ownerScope}:${backendSessionId}`;
      // Forward the caller's session to tool executions for this turn. In
      // single-user mode the loopback routes accept the request directly;
      // in shared deployments the forwarded cookie/authorization keeps RBAC
      // enforced per principal instead of running tools as the server.
      const forwarded: Record<string, string> = {};
      if (request.headers.cookie) forwarded.cookie = String(request.headers.cookie);
      if (request.headers.authorization)
        forwarded.authorization = String(request.headers.authorization);
      if (turnId) forwarded['x-sim2real-turn-id'] = turnId;
      forwarded['x-sim2real-owner-scope'] = ownerScope;
      // Surface the UI's current model/device selection to the model without
      // trusting it: the tools re-validate any id against the workspace.
      const rawContext = request.body?.context;
      const contextId = (value: unknown): string =>
        typeof value === 'string' && value.trim() && value.length <= 128 ? value.trim() : '';
      const contextPart = [
        contextId(rawContext?.modelId) ? `modelId=${contextId(rawContext.modelId)}` : '',
        contextId(rawContext?.deviceId) ? `deviceId=${contextId(rawContext.deviceId)}` : '',
        contextId(rawContext?.computeResourceId)
          ? `computeResourceId=${contextId(rawContext.computeResourceId)}`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      const turnPrompt = contextPart ? `${prompt}\n\n[当前工作区选择] ${contextPart}` : prompt;
      const channel = (app.locals as Record<string, unknown>).dshAuthChannel as
        ReturnType<typeof createDshAuthChannel> | undefined;
      const result = await withDshSessionLock(sessionLockKey, () => {
        const work = () =>
          askDsh(runtime, turnPrompt, {
            ...(model ? { model } : {}),
            sessionId: backendSessionId,
            signal: requestAbort.signal,
          });
        return channel ? channel.withAuth(forwarded, work) : work();
      });
      response.json({
        ok: true,
        sessionId: publicSessionId,
        text: publicDshText(result.text),
        reasoning: publicDshReasoning(result.reasoning),
        toolTrail: publicDshToolTrail(result.toolTrail),
        events: publicDshEventTail(result.events),
        ...(result.usage ? { usage: result.usage } : {}),
      });
    } catch (error) {
      console.error('[sim2real-web] DSH chat failed:', redactInternalError(error));
      // A turn failure with a reviewed code carries its own user-facing
      // message (for example the missing-credential hint). Everything else
      // keeps the generic upstream response so provider internals never cross
      // the browser boundary. This is deliberately not a 503: the runtime is
      // enabled but misconfigured, and silently falling back to the legacy
      // canned-reply planner would hide the real problem.
      if (error instanceof DshAgentFailure) {
        response.status(502).json({
          ok: false,
          error: error.code,
          message: error.message,
          ...(responseRequestId(response) ? { requestId: responseRequestId(response) } : {}),
        });
        return;
      }
      sendPublicUpstreamError(response, 'DSH_CHAT_FAILED', 'dsh');
    } finally {
      request.off('aborted', abortRequest);
    }
  });
  // Studio-cookie deployments also expose a credential relay so the workbench
  // can log in directly (POST /api/sso/login) instead of bouncing users to
  // the Studio main shell. The relay adopts the same site-wide cookie.
  app.use(
    createStudioLoginRelayRouter({
      auth: studioSsoAuth,
      ...(dobsReporter.enabled
        ? {
            // 登录埋点：只带 method/outcome/错误码，凭证字段绝不外传。
            onLoginAttempt: (attempt) => {
              dobsReporter.reportEvent({
                eventCode: 'sso_login_attempt',
                outcome: attempt.outcome,
                ...(attempt.outcome === 'error' ? { severityHint: 'warning' } : {}),
                safeSummary: `login ${attempt.method} ${attempt.outcome}`,
                metadata: {
                  method: attempt.method,
                  ...(attempt.statusCode ? { statusCode: attempt.statusCode } : {}),
                  ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
                },
              });
            },
          }
        : {}),
    }),
  );

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
  app.use(
    createSim2RealRouter(
      { runOnDevice, auth: studioSsoAuth },
      {
        ...(dobsReporter.enabled
          ? {
              onTelemetryIngestFailure: (failure: {
                runId: string;
                source: string;
                message: string;
              }) => {
                dobsReporter.reportEvent({
                  eventCode: 'telemetry_ingest_failed',
                  outcome: 'error',
                  severityHint: 'warning',
                  safeSummary: failure.message,
                  metadata: { source: failure.source },
                  correlation: { runId: failure.runId },
                });
              },
            }
          : {}),
      },
    ),
  );
  // Product Agent surface: the planner/executor owns the conversation task
  // lifecycle and calls the same guarded Sim2Real APIs as the UI. It shares
  // the same auth port so shared deployments keep conversation evidence
  // scoped to the verified account (fail-closed like the business routes).
  app.use(createSim2RealAgentRouter({ auth: studioSsoAuth }));
  app.use(
    createSim2RealRouter(
      { runOnDevice, auth: studioSsoAuth },
      {
        prefix: SIM2REAL_VERSIONED_API_PREFIX,
        ...(dobsReporter.enabled
          ? {
              onTelemetryIngestFailure: (failure) => {
                dobsReporter.reportEvent({
                  eventCode: 'telemetry_ingest_failed',
                  outcome: 'error',
                  severityHint: 'warning',
                  safeSummary: failure.message,
                  metadata: { source: failure.source },
                  correlation: { runId: failure.runId },
                });
              },
            }
          : {}),
      },
    ),
  );

  // Event-driven UI: bridge the store's domain events to browser
  // EventSource streams under both API prefixes. Owner filtering reuses the
  // business auth port, so shared deployments stay tenant-isolated.
  app.use(createSim2RealEventsSseRouter({ auth: studioSsoAuth }));
  app.use(
    createSim2RealEventsSseRouter({ prefix: SIM2REAL_VERSIONED_API_PREFIX, auth: studioSsoAuth }),
  );

  // d-obs 埋点插件：领域事件（run/deployment/model/project 生命周期）→ 低敏
  // ops 事件批量上报。注册在工厂内（与 SSE 插件同一模式，replace-by-id 不
  // 累积），未配置 env 时 reporter 停用、onDomainEvent 直接空转。
  if (dobsReporter.enabled) {
    registerSim2RealPlugin({
      id: 'dobs-ops-reporter',
      events: dobsReporter.domainEventFilter,
      onEvent: (event) => dobsReporter.onDomainEvent(event),
    });
    // 进程级错误埋点：先上报再维持默认崩溃行为（Node 对 uncaught 仍是
    // crash-on-exit；unhandledRejection 默认 warn）。fire-and-forget：flush
    // 有 6s 超时，最坏情况只是这条事件没送达。
    for (const signal of ['uncaughtException', 'unhandledRejection'] as const) {
      process.on(signal, (error: unknown) => {
        dobsReporter.reportEvent({
          eventCode: 'process_unhandled_error',
          outcome: 'error',
          severityHint: 'critical',
          safeSummary: redactInternalError(error),
          metadata: { kind: signal },
        });
        void dobsReporter.flush().catch(() => {});
      });
    }
  }

  // Same-origin bridge for the local MuJoCo Web service. In production nginx
  // owns `/mujoco/` and forwards to 127.0.0.1:18100 itself; in local dev
  // there is no nginx, so this route reproduces that hop for the OriginBot
  // simulator iframe (`/mujoco/api/sessions...` at a 20 Hz control rate).
  // The route is opt-in via RDK_SIM2REAL_MUJOCO_WEB_URL so deployments that
  // keep nginx forwarding (or run without MuJoCo) see no behavior change.
  app.all('/mujoco/api/{*splat}', createMujocoApiBridge());

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

  // The browser cannot start a process on the user's computer. These two
  // endpoints make the one-command Local GPU Agent install flow possible
  // without asking users to clone the platform repository. The downloaded
  // agent is the same audited source used by `npm run dev:gpu-agent`.
  app.get('/agent/local-gpu-agent.mjs', (_request, response) => {
    response
      .setHeader('Cache-Control', 'no-cache')
      .type('application/javascript')
      .sendFile(path.join(SERVICE_ROOT, '..', '..', 'scripts', 'local-gpu-agent.mjs'));
  });
  app.get('/agent/install.sh', (request, response) => {
    const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim();
    const protocol = forwardedProto === 'https' || request.protocol === 'https' ? 'https' : 'http';
    const host = String(request.headers['x-forwarded-host'] ?? request.get('host') ?? '')
      .split(',')[0]
      .trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(host)) {
      response.status(400).type('text/plain').send('invalid host');
      return;
    }
    const origin = `${protocol}://${host}`;
    const agentUrl = `${origin}${publicPath('/agent/local-gpu-agent.mjs')}`;
    response
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Content-Disposition', 'attachment; filename="rdk-gpu-agent-install.sh"')
      .type('text/plain')
      .send(gpuAgentInstallScript(origin, agentUrl));
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
          return;
        }
        // The platform's own control-plane scripts and styles live at the
        // public root. A release that changes app.js must reach every open
        // workbench on its next reload — a production max-age window is exactly
        // how a stale control loop survives an upgrade. Large binary assets in
        // subdirectories keep the production cache window.
        const inPublicRoot = path.dirname(normalizedPath) === PUBLIC_ROOT;
        if (inPublicRoot && /\.(js|css|mjs)$/.test(filePath)) {
          response.setHeader('Cache-Control', 'no-cache');
        }
      },
      maxAge: isProductionEnv() ? '1h' : 0,
    }),
  );
  // Express 5 wildcard syntax keeps the SPA fallback compatible with paths
  // such as `/` and `/sim2real/` without the legacy path-to-regexp pattern.
  // Static-asset extensions must NOT fall back to the HTML entry: when the
  // standalone server is reached through an unstripped proxy prefix
  // (`https://host/sim2real/app.css` with no RDK_SIM2REAL_PUBLIC_BASE_PATH
  // set), serving index.html as `text/html` makes the browser reject the
  // stylesheet/script under nosniff + CSP and the SPA renders unstyled —
  // a broken layout that looks like a whitespace bug. 404 keeps the failure
  // honest and diagnosable instead.
  const STATIC_ASSET_EXTENSIONS = new Set([
    '.css',
    '.js',
    '.mjs',
    '.map',
    '.json',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.webp',
    '.avif',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.wasm',
  ]);
  app.get('/{*splat}', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next();
      return;
    }
    const assetSuffix = path.extname(request.path).toLowerCase();
    if (assetSuffix && STATIC_ASSET_EXTENSIONS.has(assetSuffix)) {
      response
        .status(404)
        .setHeader('Cache-Control', 'no-store')
        .json({
          ok: false,
          error: 'SIM2REAL_STATIC_ASSET_NOT_FOUND',
          message: '静态资源不存在；请从应用入口页访问，或为反向代理配置正确的路径剥离/基路径。',
          requestId: response.getHeader('X-Request-Id'),
        });
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
  // atomic capabilities; they never construct a second agent loop. The
  // capability handlers call this service's own authenticated routes, so
  // RBAC, motion switches and release gates apply to model-initiated actions
  // exactly as they do to the web UI.
  const dshAuthChannel = createDshAuthChannel();
  if (dshRuntimeEnabled()) {
    try {
      const capabilityHandlers = createDshCapabilityHandlers();
      // Sandboxed units (ProtectSystem=strict) keep only the storage directory
      // writable, and DSH lazily creates its session files on the first turn —
      // a cwd default would pass startup composition and fail every real turn.
      // Default into the configured storage root, but fail closed at startup
      // when that root is read-only instead of shipping a runtime that cannot
      // complete a turn.
      const persistenceRoot = resolveDshPersistenceRoot(resolveDataDir);
      mkdirSync(persistenceRoot, { recursive: true, mode: 0o700 });
      accessSync(persistenceRoot, fsConstants.R_OK | fsConstants.W_OK);
      const dsh = await createDshRuntime({
        persistenceRoot,
        capabilityHandlers,
      });
      // Bridge DSH's approval seam to the authenticated web panel. The chat
      // request remains open while a write-capable tool waits; the browser
      // polls the pending approval endpoint and resolves it with one click.
      dsh.on('approval/request', (request) => {
        const ownerScope = currentDshAuthHeaders()['x-sim2real-owner-scope'] || 'single-user';
        return createDshApproval(ownerScope, request);
      });
      app.locals.dshRuntime = dsh;
      app.locals.dshAuthChannel = dshAuthChannel;
      (
        app.locals as { dshCapabilityCatalog?: ReturnType<typeof listDshCapabilityCatalog> }
      ).dshCapabilityCatalog = listDshCapabilityCatalog(capabilityHandlers);
      console.log('[sim2real-web] DSH runtime composed');
    } catch (error) {
      console.error('[sim2real-web] DSH runtime failed:', redactInternalError(error));
      throw error;
    }
  }
  const envConfig = resolveSim2RealWebEnv();
  for (const warning of envConfig.warnings) {
    console.warn('[sim2real-web] config warning:', warning);
  }
  const server = app.listen(envConfig.port, envConfig.host, () => {
    console.log(
      '[sim2real-web] listening on http://' +
        envConfig.host +
        ':' +
        envConfig.port +
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
