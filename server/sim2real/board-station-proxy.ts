import { boardAgentUrl } from './standalone-adapters.js';

/**
 * Bounded HTTP client for the host-station (上位机) BoardAgent surface.
 * Mirrors the preflight client's rules: same SSRF-safe base URL resolution
 * (loopback-only HTTP, remote must be TLS), same bearer-token handling, and
 * bounded response sizes. The proxy never forwards Studio credentials.
 */

const MAX_STATION_JSON_BYTES = 256 * 1024;

export interface StationAgentFetchOptions {
  method?: 'GET' | 'POST';
  timeoutMs?: number;
  body?: string;
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
  if (!baseUrl || !/^\/[A-Za-z0-9._/-]+$/.test(pathname)) return null;
  const method = options.method ?? 'GET';
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 5000, 500), 15_000);
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  options: { timeoutMs?: number; lifetimeMs?: number } = {},
): Promise<ReadableStream<Uint8Array>> {
  const baseUrl = boardAgentUrl();
  if (!baseUrl || !/^\/[A-Za-z0-9._/-]+$/.test(pathname)) {
    throw new Error('invalid station stream path');
  }
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 4000, 500), 10_000);
  const lifetimeMs = Math.min(Math.max(Number(options.lifetimeMs) || 15 * 60 * 1000, 1000), 60 * 60 * 1000);
  const token = String(process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN ?? '').trim();
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
