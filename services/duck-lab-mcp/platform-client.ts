import type { LoopbackFetch } from '../../server/agent-runtime/dsh-capability-handlers.js';

/**
 * HTTP adapter between the MCP tool layer and a running Sim2Real platform.
 *
 * The design documents pin the contract for external adapters
 * (docs/design/sim2real-platform.md, docs/api/README.md): call the versioned
 * `/api/v1/duck` API, never duplicate validation/idempotency/quota logic, and
 * keep the platform as the single source of truth. This module therefore only
 * translates paths, attaches credentials and bounds transport time — every
 * business rule stays behind the platform's own routes.
 */

export type PlatformClientConfig = {
  baseUrl: string;
  apiPrefix: string;
  cookie?: string;
  username?: string;
  password?: string;
  timeoutMs: number;
};

const DEFAULT_BASE_URL = 'http://127.0.0.1:18102';
const DEFAULT_API_PREFIX = '/api/v1/duck';
const DEFAULT_TIMEOUT_MS = 120_000;
const LEGACY_PREFIX = '/api/sim2real';

/**
 * The capability executor reads responses through the embedded agent's
 * bounded reader (256 KiB). Populated ledgers legitimately exceed that with
 * raw aggregate routes (46 runs ≈ 224 KiB on a long-lived instance), so the
 * adapter projects oversized bodies: arrays nested in an object are truncated
 * to the most recent entries and the projection is flagged in the body. The
 * ledger stays untouched; exact lists remain available through the `*_list`
 * query tools. This is the "MCP 只做适配和证据投影" boundary from
 * docs/design/sim2real-platform.md — business truth never lives here.
 *
 * Responses that cannot be projected losslessly in shape — a top-level array,
 * or an object still over budget with every nested array capped — fail with
 * an explicit error instead of passing an oversized body downstream, where
 * the bounded reader would reject it with a message that hides the cause.
 */
const WIRE_BODY_BUDGET_BYTES = 240 * 1024;
const HARD_READ_LIMIT_BYTES = 8 * 1024 * 1024;
const PROJECTION_ARRAY_CAP = 12;

async function readBodyBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isSafeInteger(declared) && declared > HARD_READ_LIMIT_BYTES) {
    throw new Error(`平台响应超过 ${HARD_READ_LIMIT_BYTES} 字节硬上限，拒绝缓冲。`);
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > HARD_READ_LIMIT_BYTES) {
      await reader.cancel();
      throw new Error(`平台响应超过 ${HARD_READ_LIMIT_BYTES} 字节硬上限，拒绝缓冲。`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function projectOversizedBody(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= WIRE_BODY_BUDGET_BYTES) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const originalBytes = Buffer.byteLength(text, 'utf8');
  const overBudget = (body: string): boolean =>
    Buffer.byteLength(body, 'utf8') > WIRE_BODY_BUDGET_BYTES;
  const refuse = (): never => {
    throw new Error(
      `平台响应 ${originalBytes} 字节，超过投影预算 ${WIRE_BODY_BUDGET_BYTES} 字节且无法无损投影；请改用对应的 *_list 查询工具获取精确列表。`,
    );
  };
  if (!parsed || typeof parsed !== 'object') refuse();
  if (Array.isArray(parsed)) {
    let arrayCap = PROJECTION_ARRAY_CAP;
    let body = JSON.stringify(parsed.slice(0, arrayCap));
    while (overBudget(body) && arrayCap > 1) {
      arrayCap = Math.floor(arrayCap / 2);
      body = JSON.stringify(parsed.slice(0, arrayCap));
    }
    if (overBudget(body)) refuse();
    return body;
  }
  const build = (arrayCap: number): string => {
    const projected: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    for (const [key, value] of Object.entries(projected)) {
      if (Array.isArray(value) && value.length > arrayCap)
        projected[key] = value.slice(0, arrayCap);
    }
    projected.projection = { truncated: true, arrayCap, originalBytes };
    return JSON.stringify(projected);
  };
  let arrayCap = PROJECTION_ARRAY_CAP;
  let body = build(arrayCap);
  while (overBudget(body) && arrayCap > 1) {
    arrayCap = Math.floor(arrayCap / 2);
    body = build(arrayCap);
  }
  if (overBudget(body)) refuse();
  return body;
}

function rebuildBodyResponse(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function loadPlatformClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlatformClientConfig {
  const rawBaseUrl = readString(env, 'RDK_SIM2REAL_MCP_BASE_URL') ?? DEFAULT_BASE_URL;
  let baseUrl: string;
  try {
    baseUrl = new URL(rawBaseUrl).toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`RDK_SIM2REAL_MCP_BASE_URL 不是合法 URL：${rawBaseUrl}`);
  }

  const rawPrefix = readString(env, 'RDK_SIM2REAL_MCP_API_PREFIX') ?? DEFAULT_API_PREFIX;
  const apiPrefix = rawPrefix.startsWith('/')
    ? rawPrefix.replace(/\/+$/, '')
    : `/${rawPrefix.replace(/\/+$/, '')}`;

  const rawTimeout = Number(env.RDK_SIM2REAL_MCP_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout >= 1_000
      ? Math.trunc(rawTimeout)
      : DEFAULT_TIMEOUT_MS;

  return {
    baseUrl,
    apiPrefix,
    cookie: readString(env, 'RDK_SIM2REAL_MCP_COOKIE'),
    username: readString(env, 'RDK_SIM2REAL_MCP_USERNAME'),
    password: readString(env, 'RDK_SIM2REAL_MCP_PASSWORD'),
    timeoutMs,
  };
}

export function describeAuthMode(config: PlatformClientConfig): string {
  if (config.cookie) return 'static-cookie';
  if (config.username && config.password) return 'credential-login';
  return 'standalone-anonymous';
}

export type PlatformFetch = {
  /** Business-routes fetch; rewrites the legacy prefix onto the versioned API. */
  fetch: LoopbackFetch;
  /** App-level fetch (healthz, auth/session, sso endpoints) without rewrite. */
  requestAppRoute: (path: string, init?: { method?: string; json?: unknown }) => Promise<Response>;
};

/**
 * Build the outbound transport. Credentials are attached per request; a
 * configured username/password pair lazily exchanges against
 * POST /api/sso/login for a session cookie, with a single re-login retry when
 * the platform answers 401 (studio sessions expire server-side).
 */
export function createPlatformFetch(
  config: PlatformClientConfig,
  options: { fetchImpl?: typeof fetch } = {},
): PlatformFetch {
  const doFetch = options.fetchImpl ?? fetch;
  let sessionCookie: string | null = config.cookie ?? null;
  let loginPromise: Promise<void> | null = null;

  function extractCookie(lines: string[]): string {
    const pairs = lines
      .map((line) => line.split(';')[0]?.trim() ?? '')
      .filter((pair) => pair && /=/.test(pair));
    if (!pairs.length) throw new Error('登录成功但平台未返回会话 Cookie，无法建立 MCP 会话。');
    return pairs.join('; ');
  }

  async function login(): Promise<void> {
    const response = await doFetch(`${config.baseUrl}/api/sso/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        method: 'account',
        userName: config.username,
        password: config.password,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `平台登录失败（HTTP ${response.status}）：请核对 RDK_SIM2REAL_MCP_USERNAME / RDK_SIM2REAL_MCP_PASSWORD。`,
      );
    }
    const setCookie =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    sessionCookie = extractCookie(setCookie);
  }

  function ensureSession(): Promise<void> {
    if (sessionCookie || !config.username || !config.password) return Promise.resolve();
    loginPromise ??= login().catch((error) => {
      loginPromise = null;
      throw error;
    });
    return loginPromise;
  }

  function outboundHeaders(
    init: { headers?: Record<string, string> },
    extra?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    // Internal seam only: the capability layer derives idempotency keys from
    // the turn id before the request leaves this process.
    delete headers['x-sim2real-turn-id'];
    if (extra) Object.assign(headers, extra);
    if (sessionCookie) headers.cookie = sessionCookie;
    return headers;
  }

  async function send(
    url: string,
    method: string,
    body: string | undefined,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    return doFetch(url, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    });
  }

  async function requestWithRewrite(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
  ): Promise<Response> {
    await ensureSession();
    const rewritten = path.startsWith(`${LEGACY_PREFIX}/`)
      ? `${config.apiPrefix}${path.slice(LEGACY_PREFIX.length)}`
      : path;
    const response = await send(
      `${config.baseUrl}${rewritten}`,
      init.method,
      init.body,
      outboundHeaders(init),
      init.signal,
    );
    if (response.status === 401 && !config.cookie && config.username && config.password) {
      sessionCookie = null;
      // loginPromise still holds the resolved first login; drop it so
      // ensureSession actually exchanges fresh credentials before the replay.
      loginPromise = null;
      await ensureSession();
      return send(
        `${config.baseUrl}${rewritten}`,
        init.method,
        init.body,
        outboundHeaders(init),
        init.signal,
      );
    }
    return rebuildBodyResponse(response, projectOversizedBody(await readBodyBounded(response)));
  }

  const fetchViaVersionedApi: LoopbackFetch = (path, init) => requestWithRewrite(path, init);

  async function requestAppRoute(
    path: string,
    init: { method?: string; json?: unknown } = {},
  ): Promise<Response> {
    await ensureSession();
    const method = init.method ?? 'GET';
    const body = init.json === undefined ? undefined : JSON.stringify(init.json);
    const headers = outboundHeaders(
      { headers: body === undefined ? {} : { 'content-type': 'application/json' } },
      { accept: 'application/json' },
    );
    return send(
      `${config.baseUrl}${path}`,
      method,
      body,
      headers,
      AbortSignal.timeout(config.timeoutMs),
    );
  }

  return { fetch: fetchViaVersionedApi, requestAppRoute };
}
