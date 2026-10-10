import {
  boardAgentTokenConfigured,
  boardAgentTokenRequired,
  boardAgentUrl,
  safeStudioOrigin,
} from './standalone-adapters.js';

/**
 * Bounded HTTP client for the host-station (上位机) BoardAgent surface.
 * Mirrors the preflight client's rules: same SSRF-safe base URL resolution
 * (loopback-only HTTP, remote must be TLS), same bearer-token handling, and
 * bounded response sizes. The direct BoardAgent path never forwards Studio
 * credentials; the optional Studio bridge path forwards only the caller's
 * already-present browser cookie to Studio's same-origin exec endpoint.
 */

const MAX_STATION_JSON_BYTES = 256 * 1024;
const MAX_STATION_SNAPSHOT_BYTES = 180 * 1024;
// A browser cookie header is forwarded only to the authenticated Studio
// bridge. Keep the input bounded before it reaches fetch/undici so an
// attacker cannot turn a station request into an unbounded header allocation.
const MAX_STUDIO_BRIDGE_COOKIE_CHARS = 16_384;
// An Origin is normally well below 256 characters. 512 leaves room for a
// deployment subdomain while keeping malformed environment values bounded.
const MAX_STUDIO_BRIDGE_ORIGIN_CHARS = 512;
const DEFAULT_STUDIO_BRIDGE_ORIGIN = 'https://rdkstudio.d-robotics.cc';

function safeStudioBridgeCookie(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value;
  // Check controls before trim: String.prototype.trim() would otherwise hide
  // a trailing CR/LF or tab supplied by a request header.
  if (raw.length > MAX_STUDIO_BRIDGE_COOKIE_CHARS || /[\u0000-\u001f\u007f]/.test(raw)) {
    return null;
  }
  const cookie = raw.trim();
  return cookie ? cookie : null;
}

function safeStudioBridgeOrigin(value: unknown): string | null {
  const raw = String(value ?? '');
  // Validate the raw value before URL parsing. WHATWG URL intentionally
  // strips some ASCII controls, which would make a malformed environment
  // value look valid after normalization.
  if (raw.length > MAX_STUDIO_BRIDGE_ORIGIN_CHARS || /[\u0000-\u001f\u007f]/.test(raw)) {
    return null;
  }
  return safeStudioOrigin(raw);
}

function studioBridgeRequestOrigin(): string | null {
  const configured =
    process.env.RDK_SIM2REAL_PUBLIC_ORIGIN ?? process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN;
  // Preserve the historical default when neither public-origin variable is
  // configured (or is deliberately blank), while failing closed on a
  // non-empty malformed value instead of forwarding it as an HTTP header.
  const raw =
    configured === undefined || configured.trim() === ''
      ? DEFAULT_STUDIO_BRIDGE_ORIGIN
      : configured;
  return safeStudioBridgeOrigin(raw);
}

export interface StationAgentFetchOptions {
  method?: 'GET' | 'POST';
  timeoutMs?: number;
  body?: string;
  /** Browser Studio SSO/device cookies forwarded to the shared Studio bridge. */
  cookieHeader?: string;
  /** Device selected by the platform registry for the current request. */
  deviceId?: string;
  /**
   * Loopback-only base URL override for per-connection tunnels (device
   * manager). Anything that is not a bare loopback HTTP origin is ignored so
   * the SSRF boundary cannot move through this option.
   */
  baseUrl?: string;
}

/**
 * Validate an agent base-URL override: bare HTTP origin on loopback only.
 * Returns null for anything else so callers fall back to boardAgentUrl().
 */
function loopbackBaseUrlOverride(value: string | undefined): string | null {
  const candidate = String(value ?? '').trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (parsed.protocol !== 'http:') return null;
    if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return null;
    // A loopback URL is still an internal trust boundary. Reject userinfo so
    // an environment typo cannot smuggle credentials into the agent request;
    // return the canonical origin so callers never inherit a path/query.
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

interface StationAgentJson {
  ok: boolean;
  status: number;
  payload: Record<string, unknown> | null;
}

async function cancelQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* body already closed */
  }
}

/**
 * Consume one JSON object response within the byte budget. Content-length is
 * checked first for an early out; the stream is then read chunk by chunk and
 * cancelled the moment the budget is exceeded, so an oversized or hostile
 * body never fully lands in memory. Non-JSON or non-object bodies yield null
 * (the caller decides whether that is a 502 or a pass-through refusal).
 */
async function boundedJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const normalized = declaredHeader.trim();
    const declaredLength = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_STATION_JSON_BYTES
    ) {
      await cancelQuietly(response);
      return null;
    }
  }
  /*
   * Do not use response.text() here. A null body is an invalid station JSON
   * response, and a custom fetch adapter must not bypass the byte budget with
   * an unbounded text() implementation.
   */
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) return null;
      total += value.byteLength;
      if (total > MAX_STATION_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return null;
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/**
 * One bounded agent round-trip: connect, forward the bearer token, then read
 * the body through the streaming budget above. The abort timer stays armed
 * for the whole exchange, so a stalled body is cut off like a stalled
 * connect. Transport failures (DNS, timeout, redirect, abort) return null.
 */
async function stationAgentJson(
  pathname: string,
  options: StationAgentFetchOptions = {},
): Promise<StationAgentJson | null> {
  const baseUrl = loopbackBaseUrlOverride(options.baseUrl) ?? boardAgentUrl();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(pathname)) return null;
  // A static BoardAgent is a service-to-service boundary.  In production or
  // web-cloud mode an omitted/weak bearer must make the call unavailable
  // rather than silently downgrading to an unauthenticated agent.  The
  // Studio-bridge fallback below remains cookie-authenticated and is allowed
  // when no direct endpoint is ready.
  if (baseUrl && boardAgentTokenRequired(Boolean(baseUrl)) && !boardAgentTokenConfigured()) {
    return null;
  }
  // 15s default for state reads; policy staging moves a whole base64'd ONNX
  // through one request and legitimately needs the higher ceiling.
  const isPolicyUpload = pathname === '/v1/station/policy/upload';
  const timeoutMs = isPolicyUpload
    ? Math.min(Math.max(Number(options.timeoutMs) || 120_000, 500), 180_000)
    : Math.min(Math.max(Number(options.timeoutMs) || 5000, 500), 15_000);
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  const direct = baseUrl
    ? stationAgentDirectUrl(baseUrl, pathname, options, token, timeoutMs)
    : null;
  if (direct) {
    const result = await direct;
    if (result) return result;
  }
  return studioBridgeAgentJson(pathname, options, token, timeoutMs);
}

function stationAgentDirectUrl(
  baseUrl: string,
  pathname: string,
  options: StationAgentFetchOptions,
  token: string,
  timeoutMs: number,
): Promise<StationAgentJson | null> | null {
  if (!baseUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = options.method ?? 'GET';
  return (async () => {
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(options.body ? { body: options.body } : {}),
        signal: controller.signal,
        // NDJSON/MJPEG endpoints are handled by stationAgentFetchStream.
        redirect: 'error',
      });
      return {
        ok: response.ok,
        status: response.status,
        payload: await boundedJsonObject(response),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function studioBridgeConfig(): { origin: string; deviceId: string; agentPort: number } | null {
  const origin = safeStudioBridgeOrigin(process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN);
  const deviceId = String(process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID ?? '').trim();
  const agentPort = Number(process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT ?? 19100);
  if (!origin || (deviceId && !/^[A-Za-z0-9._:-]{1,160}$/.test(deviceId))) {
    return null;
  }
  if (!Number.isSafeInteger(agentPort) || agentPort < 1 || agentPort > 65535) return null;
  return { origin, deviceId, agentPort };
}

// Minimal boards may have Python but no curl. Read the whole bounded response
// before writing stdout so a transport error cannot become a partial frame.
const STUDIO_BRIDGE_PYTHON_REQUEST = `import base64,json,signal,sys,urllib.error,urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  raise ValueError("redirect refused")
try:
 config=json.loads(sys.argv[1])
 signal.alarm(12)
 headers={"Accept":"image/jpeg" if config["snapshot"] else "application/json"}
 if config["token"]: headers["Authorization"]="Bearer "+config["token"]
 data=config["body"].encode("utf-8") if config["body"] is not None else None
 if data is not None: headers["Content-Type"]="application/json"
 request=urllib.request.Request(config["url"],data=data,headers=headers,method=config["method"])
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
 try:
  response=opener.open(request,timeout=12)
 except urllib.error.HTTPError as error:
  if config["snapshot"]: raise
  response=error
 with response:
  length=response.headers.get("Content-Length")
  if length is not None and (int(length)<0 or int(length)>config["maxBytes"]): raise ValueError("response size")
  payload=response.read(config["maxBytes"]+1)
 if not payload or len(payload)>config["maxBytes"]: raise ValueError("response size")
 if config["snapshot"]:
  if len(payload)<4 or payload[:2]!=bytes([255,216]) or payload[-2:]!=bytes([255,217]): raise ValueError("invalid JPEG")
  sys.stdout.buffer.write(base64.b64encode(payload))
 else:
  if not isinstance(json.loads(payload),dict): raise ValueError("invalid JSON")
  sys.stdout.buffer.write(payload)
except Exception:
 sys.stderr.write("board agent request failed\\n")
 sys.exit(1)
finally:
 signal.alarm(0)`;

function studioBridgePythonCommand(
  pathname: string,
  options: StationAgentFetchOptions,
  token: string,
  agentPort: number,
  snapshot = false,
): string {
  const config = JSON.stringify({
    url: `http://127.0.0.1:${agentPort}${pathname}`,
    method: options.method ?? 'GET',
    body: options.body ?? null,
    token,
    snapshot,
    maxBytes: snapshot ? MAX_STATION_SNAPSHOT_BYTES : MAX_STATION_JSON_BYTES,
  });
  return `python3 -c ${shellQuote(STUDIO_BRIDGE_PYTHON_REQUEST)} ${shellQuote(config)}`;
}

function studioBridgeCommand(
  pathname: string,
  options: StationAgentFetchOptions,
  token: string,
  agentPort: number,
): string | null {
  const allowed = new Set([
    '/healthz',
    '/v1/station/status',
    '/v1/station/commands',
    '/v1/station/drive',
    '/v1/station/drive/stop',
    '/v1/station/policy',
    '/v1/station/policy/load',
    '/v1/station/policy/start',
    '/v1/station/policy/reset',
    '/v1/station/policy/stop',
  ]);
  if (!allowed.has(pathname)) return null;
  const method = options.method ?? 'GET';
  const body = options.body ? ` --data ${shellQuote(options.body)}` : '';
  const auth = token ? ` -H ${shellQuote(`Authorization: Bearer ${token}`)}` : '';
  // Do not use curl --fail: a 409 from BoardAgent is a deliberate safety
  // refusal (for example, drive/policy switches are off) and its JSON body
  // must reach the browser intact.
  const curl = `curl --silent --show-error --max-time 12 -X ${shellQuote(method)}${auth} -H ${shellQuote('Accept: application/json')}${body} ${shellQuote(`http://127.0.0.1:${agentPort}${pathname}`)}`;
  const python = studioBridgePythonCommand(pathname, options, token, agentPort);
  return `if command -v curl >/dev/null 2>&1; then ${curl}; else ${python}; fi`;
}

function studioBridgeSnapshotCommand(token: string, agentPort: number): string {
  const auth = token ? ` -H ${shellQuote(`Authorization: Bearer ${token}`)}` : '';
  // Exec is JSON, so carry one bounded JPEG as base64. The bridge stream
  // adapter below turns successive snapshots back into multipart MJPEG.
  const curl = `curl --silent --show-error --max-time 12${auth} ${shellQuote(`http://127.0.0.1:${agentPort}/v1/station/camera.snapshot`)} | base64 | tr -d '\\n'`;
  const python = studioBridgePythonCommand(
    '/v1/station/camera.snapshot',
    {},
    token,
    agentPort,
    true,
  );
  return `if command -v curl >/dev/null 2>&1; then ${curl}; else ${python}; fi`;
}

async function studioBridgeAgentJson(
  pathname: string,
  options: StationAgentFetchOptions,
  token: string,
  timeoutMs: number,
): Promise<StationAgentJson | null> {
  const config = studioBridgeConfig();
  const deviceId = String(options.deviceId || config?.deviceId || '').trim();
  const cookie = safeStudioBridgeCookie(options.cookieHeader);
  const requestOrigin = studioBridgeRequestOrigin();
  if (!config || !deviceId || !cookie || !requestOrigin) return null;
  const command = studioBridgeCommand(pathname, options, token, config.agentPort);
  if (!command) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${config.origin}/api/devices/${encodeURIComponent(deviceId)}/exec`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          cookie,
          origin: requestOrigin,
        },
        body: JSON.stringify({ command }),
        signal: controller.signal,
        redirect: 'error',
      },
    );
    const outer = await boundedJsonObject(response);
    if (!response.ok || !outer) return { ok: false, status: response.status, payload: null };
    const output = typeof outer.output === 'string' ? outer.output.trim() : '';
    if (!output) return { ok: false, status: response.status, payload: null };
    let payload: unknown;
    try {
      payload = JSON.parse(output);
    } catch {
      return { ok: false, status: response.status, payload: null };
    }
    return {
      ok: Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)),
      status: response.status,
      payload:
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function studioBridgeAgentSnapshot(
  options: { cookieHeader?: string; deviceId?: string },
  token: string,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const config = studioBridgeConfig();
  const deviceId = String(options.deviceId || config?.deviceId || '').trim();
  const cookie = safeStudioBridgeCookie(options.cookieHeader);
  const requestOrigin = studioBridgeRequestOrigin();
  if (!config || !deviceId || !cookie || !requestOrigin) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${config.origin}/api/devices/${encodeURIComponent(deviceId)}/exec`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          cookie,
          origin: requestOrigin,
        },
        body: JSON.stringify({ command: studioBridgeSnapshotCommand(token, config.agentPort) }),
        signal: controller.signal,
        redirect: 'error',
      },
    );
    const outer = await boundedJsonObject(response);
    if (!response.ok || !outer || typeof outer.output !== 'string') return null;
    const encoded = outer.output.replace(/\s+/g, '');
    if (
      !encoded ||
      encoded.length > Math.ceil((MAX_STATION_SNAPSHOT_BYTES * 4) / 3) ||
      !/^[A-Za-z0-9+/=]+$/.test(encoded)
    )
      return null;
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_STATION_SNAPSHOT_BYTES) return null;
    // JPEG magic bytes prevent a command error or arbitrary text becoming a
    // browser image. The board agent also marks the frame as real-device.
    if (
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff ||
      bytes[bytes.length - 1] !== 0xd9
    )
      return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a bounded JSON document from the allowlisted agent surface. */
export async function stationAgentFetch(
  pathname: string,
  options: StationAgentFetchOptions = {},
): Promise<Record<string, unknown> | null> {
  const result = await stationAgentJson(pathname, options);
  return result && result.ok ? result.payload : null;
}

/**
 * Fetch a bounded JSON document, passing through a non-2xx JSON body. Used
 * by the drive proxy where an agent refusal (409) is a meaningful answer,
 * not a transport failure. Transport errors and non-JSON bodies still null.
 */
export async function stationAgentFetchWithStatus(
  pathname: string,
  options: StationAgentFetchOptions = {},
): Promise<{ status: number; payload: Record<string, unknown> } | null> {
  const result = await stationAgentJson(pathname, options);
  return result && result.payload ? { status: result.status, payload: result.payload } : null;
}

/**
 * Open a streaming body (NDJSON heartbeat or MJPEG camera) from the agent.
 * The returned ReadableStream must be consumed or cancelled by the caller; it
 * aborts automatically once the proxy tears the connection down.
 */
export async function stationAgentFetchStream(
  pathname: string,
  options: {
    timeoutMs?: number;
    lifetimeMs?: number;
    cookieHeader?: string;
    deviceId?: string;
    /** Loopback tunnel URL for a web-managed per-device connection. */
    baseUrl?: string;
  } = {},
): Promise<ReadableStream<Uint8Array>> {
  // A connected device can have its own SSH loopback tunnel. Prefer that
  // explicitly supplied URL, while retaining the process-wide BoardAgent
  // endpoint for legacy deployments and the Studio bridge fallback.
  const baseUrl = loopbackBaseUrlOverride(options.baseUrl) ?? boardAgentUrl();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(pathname)) {
    throw new Error('invalid station stream path');
  }
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 4000, 500), 10_000);
  const lifetimeMs = Math.min(
    Math.max(Number(options.lifetimeMs) || 15 * 60 * 1000, 1000),
    60 * 60 * 1000,
  );
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  const bridgeCookie = safeStudioBridgeCookie(options.cookieHeader);
  const bridgeConfig = !baseUrl ? studioBridgeConfig() : null;
  const bridgeOrigin = bridgeConfig ? studioBridgeRequestOrigin() : null;
  if (
    !baseUrl &&
    bridgeConfig &&
    bridgeOrigin &&
    bridgeCookie &&
    pathname === '/v1/station/status/stream'
  ) {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const deadline = Date.now() + lifetimeMs;
        try {
          while (!closed && Date.now() < deadline) {
            const payload = await stationAgentFetch('/v1/station/status', {
              timeoutMs,
              cookieHeader: bridgeCookie,
              deviceId: options.deviceId,
            });
            if (!payload) break;
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
            await new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000);
            });
          }
          if (!closed) controller.close();
        } catch (error) {
          if (!closed) controller.error(error);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      cancel() {
        closed = true;
        if (timer) clearTimeout(timer);
      },
    });
    return stream;
  }
  if (
    !baseUrl &&
    bridgeConfig &&
    bridgeOrigin &&
    bridgeCookie &&
    pathname === '/v1/station/camera.mjpeg'
  ) {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const boundary = 'rdk-board-station-frame';
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const deadline = Date.now() + lifetimeMs;
        try {
          while (!closed && Date.now() < deadline) {
            const frame = await studioBridgeAgentSnapshot(
              { ...options, cookieHeader: bridgeCookie },
              token,
              timeoutMs,
            );
            if (!frame) break;
            const header = encoder.encode(
              `--${boundary}\r\ncontent-type: image/jpeg\r\ncontent-length: ${frame.byteLength}\r\n\r\n`,
            );
            controller.enqueue(header);
            controller.enqueue(frame);
            controller.enqueue(encoder.encode('\r\n'));
            await new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 500);
            });
          }
          if (!closed) controller.close();
        } catch (error) {
          if (!closed) controller.error(error);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      cancel() {
        closed = true;
        if (timer) clearTimeout(timer);
      },
    });
    return stream;
  }
  if (!baseUrl) throw new Error('station agent unavailable');
  if (boardAgentTokenRequired(Boolean(baseUrl)) && !boardAgentTokenConfigured()) {
    throw new Error('station agent credentials unavailable');
  }
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), timeoutMs);
  let body: ReadableStream<Uint8Array> | null;
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'GET',
      headers: {
        accept: 'application/x-ndjson, multipart/x-mixed-replace',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok || !response.body) {
      throw new Error(`station stream unavailable (HTTP ${response.status})`);
    }
    body = response.body;
  } finally {
    clearTimeout(connectTimer);
  }
  // Hard lifetime: whatever happens downstream, the upstream stream closes.
  const lifetimeTimer = setTimeout(() => controller.abort(), lifetimeMs);
  const originalCancel = body.cancel.bind(body);
  body.cancel = (reason?: unknown) => {
    clearTimeout(lifetimeTimer);
    controller.abort();
    return originalCancel(reason);
  };
  return body;
}
