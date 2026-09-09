import { boardAgentUrl } from './standalone-adapters.js';

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

export interface StationAgentFetchOptions {
  method?: 'GET' | 'POST';
  timeoutMs?: number;
  body?: string;
  /** Browser Studio SSO/device cookies forwarded to the shared Studio bridge. */
  cookieHeader?: string;
  /** Device selected by the platform registry for the current request. */
  deviceId?: string;
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
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_STATION_JSON_BYTES) {
    await cancelQuietly(response);
    return null;
  }
  // A standard Fetch Response with a null body is an empty response; parse
  // that as invalid JSON rather than calling a text() fallback, which an
  // injected fetch shim could use to hand us an unbounded string.
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_STATION_JSON_BYTES) {
        await reader.cancel();
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
  const baseUrl = boardAgentUrl();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(pathname)) return null;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 5000, 500), 15_000);
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  const direct = baseUrl ? stationAgentDirectUrl(baseUrl, pathname, options, token, timeoutMs) : null;
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
  const origin = String(process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN ?? '').trim().replace(/\/+$/, '');
  const deviceId = String(process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID ?? '').trim();
  const agentPort = Number(process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT ?? 19100);
  if (!/^https?:\/\/[^\s/]+(?::\d+)?$/.test(origin) || (deviceId && !/^[A-Za-z0-9._:-]{1,160}$/.test(deviceId))) {
    return null;
  }
  if (!Number.isSafeInteger(agentPort) || agentPort < 1 || agentPort > 65535) return null;
  return { origin, deviceId, agentPort };
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
  return `curl --silent --show-error --max-time 12 -X ${shellQuote(method)}${auth} -H ${shellQuote('Accept: application/json')}${body} ${shellQuote(`http://127.0.0.1:${agentPort}${pathname}`)}`;
}

function studioBridgeSnapshotCommand(token: string, agentPort: number): string {
  const auth = token ? ` -H ${shellQuote(`Authorization: Bearer ${token}`)}` : '';
  // Exec is JSON, so carry one bounded JPEG as base64. The bridge stream
  // adapter below turns successive snapshots back into multipart MJPEG.
  return `curl --silent --show-error --max-time 12${auth} ${shellQuote(`http://127.0.0.1:${agentPort}/v1/station/camera.snapshot`)} | base64 | tr -d '\\n'`;
}

async function studioBridgeAgentJson(
  pathname: string,
  options: StationAgentFetchOptions,
  token: string,
  timeoutMs: number,
): Promise<StationAgentJson | null> {
  const config = studioBridgeConfig();
  const deviceId = String(options.deviceId || config?.deviceId || '').trim();
  if (!config || !deviceId || !options.cookieHeader) return null;
  const command = studioBridgeCommand(pathname, options, token, config.agentPort);
  if (!command) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.origin}/api/devices/${encodeURIComponent(deviceId)}/exec`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: options.cookieHeader,
        origin: String(
          process.env.RDK_SIM2REAL_PUBLIC_ORIGIN ??
            process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN ??
            'https://rdkstudio.d-robotics.cc',
        ),
      },
      body: JSON.stringify({ command }),
      signal: controller.signal,
      redirect: 'error',
    });
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
      payload: payload && typeof payload === 'object' && !Array.isArray(payload)
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
  if (!config || !deviceId || !options.cookieHeader) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.origin}/api/devices/${encodeURIComponent(deviceId)}/exec`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: options.cookieHeader,
        origin: String(
          process.env.RDK_SIM2REAL_PUBLIC_ORIGIN ??
            process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN ??
            'https://rdkstudio.d-robotics.cc',
        ),
      },
      body: JSON.stringify({ command: studioBridgeSnapshotCommand(token, config.agentPort) }),
      signal: controller.signal,
      redirect: 'error',
    });
    const outer = await boundedJsonObject(response);
    if (!response.ok || !outer || typeof outer.output !== 'string') return null;
    const encoded = outer.output.replace(/\s+/g, '');
    if (!encoded || encoded.length > Math.ceil(MAX_STATION_SNAPSHOT_BYTES * 4 / 3) || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_STATION_SNAPSHOT_BYTES) return null;
    // JPEG magic bytes prevent a command error or arbitrary text becoming a
    // browser image. The board agent also marks the frame as real-device.
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
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
  options: { timeoutMs?: number; lifetimeMs?: number; cookieHeader?: string; deviceId?: string } = {},
): Promise<ReadableStream<Uint8Array>> {
  const baseUrl = boardAgentUrl();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(pathname)) {
    throw new Error('invalid station stream path');
  }
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 4000, 500), 10_000);
  const lifetimeMs = Math.min(Math.max(Number(options.lifetimeMs) || 15 * 60 * 1000, 1000), 60 * 60 * 1000);
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  if (!baseUrl && studioBridgeConfig() && options.cookieHeader && pathname === '/v1/station/status/stream') {
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
              cookieHeader: options.cookieHeader,
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
  if (!baseUrl && studioBridgeConfig() && options.cookieHeader && pathname === '/v1/station/camera.mjpeg') {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const boundary = 'rdk-board-station-frame';
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const deadline = Date.now() + lifetimeMs;
        try {
          while (!closed && Date.now() < deadline) {
            const frame = await studioBridgeAgentSnapshot(options, token, timeoutMs);
            if (!frame) break;
            const header = encoder.encode(`--${boundary}\r\ncontent-type: image/jpeg\r\ncontent-length: ${frame.byteLength}\r\n\r\n`);
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
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), timeoutMs);
  let body: ReadableStream<Uint8Array> | null = null;
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
