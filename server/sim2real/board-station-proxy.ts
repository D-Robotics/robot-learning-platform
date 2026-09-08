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

/** Fetch a bounded JSON document from the allowlisted agent surface. */
export async function stationAgentFetch(
  pathname: string,
  options: StationAgentFetchOptions = {},
): Promise<Record<string, unknown> | null> {
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
    if (!response.ok) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_STATION_JSON_BYTES) return null;
    const payload: unknown = JSON.parse(text);
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
