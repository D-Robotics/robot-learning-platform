import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  stationAgentFetch,
  stationAgentFetchWithStatus,
} from './board-station-proxy.js';

const originalAgentUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalAgentToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const originalStudioOrigin = process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
const originalStudioDevice = process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;

beforeEach(() => {
  process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-secret';
  process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = '';
  delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
});

afterEach(() => {
  if (originalAgentUrl === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = originalAgentUrl;
  if (originalAgentToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = originalAgentToken;
  if (originalStudioOrigin === undefined) delete process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
  else process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = originalStudioOrigin;
  if (originalStudioDevice === undefined) delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
  else process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID = originalStudioDevice;
  vi.restoreAllMocks();
});

describe('board-station proxy bounded body handling', () => {
  it('rejects an oversized body via the content-length header before reading', async () => {
    const declared = new Response('{}', {
      status: 200,
      headers: { 'content-length': String(300 * 1024) },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(declared);
    await expect(stationAgentFetch('/v1/station/status')).resolves.toBeNull();
    // The oversized body must be cancelled, not drained.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('truncates a chunked body that exceeds the byte budget mid-stream', async () => {
    // No content-length; the stream stays open past the budget on purpose so
    // the assertion can prove the reader CANCELLED it instead of draining it.
    let streamCancelled = false;
    const encoder = new TextEncoder();
    const filler = 'x'.repeat(300 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"ok":true,'));
        controller.enqueue(encoder.encode(`"pad":"${filler}"}`));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    await expect(stationAgentFetch('/v1/station/status')).resolves.toBeNull();
    expect(streamCancelled).toBe(true);
  });

  it('accepts a small JSON object and forwards the bearer token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true,"status":{"cpu":1}}', { status: 200 }));
    await expect(stationAgentFetch('/v1/station/status')).resolves.toEqual({
      ok: true,
      status: { cpu: 1 },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:19100/v1/station/status');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer board-secret');
  });

  it('passes a non-2xx JSON body through stationAgentFetchWithStatus', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":false,"reason":"drive_disabled"}', {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(stationAgentFetchWithStatus('/v1/station/drive', { method: 'POST' })).resolves.toEqual({
      status: 409,
      payload: { ok: false, reason: 'drive_disabled' },
    });
    // The non-2xx answer is a refusal, not an error, for the plain fetch.
    await expect(stationAgentFetch('/v1/station/drive', { method: 'POST' })).resolves.toBeNull();
  });

  it('rejects array and scalar JSON bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    await expect(stationAgentFetch('/v1/station/status')).resolves.toBeNull();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('42', { status: 200 }));
    await expect(stationAgentFetch('/v1/station/status')).resolves.toBeNull();
  });

  it('uses a per-request Studio bridge device id when direct BoardAgent is absent', async () => {
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: JSON.stringify({ ok: true, mock: false }) }), { status: 200 }),
    );
    await expect(
      stationAgentFetch('/healthz', { cookieHeader: 'studio_session=test', deviceId: 'studio-device-2' }),
    ).resolves.toEqual({ ok: true, mock: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:18090/api/devices/studio-device-2/exec');
    expect((init.headers as Record<string, string>).cookie).toBe('studio_session=test');
  });
});
