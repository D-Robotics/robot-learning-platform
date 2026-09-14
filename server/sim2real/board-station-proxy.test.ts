import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  stationAgentFetch,
  stationAgentFetchStream,
  stationAgentFetchWithStatus,
} from './board-station-proxy.js';

const originalAgentUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalAgentToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const originalStudioOrigin = process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
const originalStudioDevice = process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
const originalPublicOrigin = process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
const originalStudioPublicOrigin = process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN;

beforeEach(() => {
  process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-secret';
  process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = '';
  delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
  delete process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
  delete process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN;
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
  if (originalPublicOrigin === undefined) delete process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
  else process.env.RDK_SIM2REAL_PUBLIC_ORIGIN = originalPublicOrigin;
  if (originalStudioPublicOrigin === undefined) delete process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN;
  else process.env.RDK_STUDIO_WEB_PUBLIC_ORIGIN = originalStudioPublicOrigin;
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
    await expect(
      stationAgentFetchWithStatus('/v1/station/drive', { method: 'POST' }),
    ).resolves.toEqual({
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

  it('fails closed on malformed content-length and canonicalizes safe IPv6 loopback URLs', async () => {
    const malformed = new Response('{}', {
      status: 200,
      headers: { 'content-length': 'not-a-number' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(malformed);
    await expect(
      stationAgentFetch('/v1/station/status', { baseUrl: 'http://[::1]:19100/' }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://[::1]:19100/v1/station/status',
      expect.objectContaining({ redirect: 'error' }),
    );

    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    await expect(
      stationAgentFetch('/v1/station/status', { baseUrl: 'http://user:pass@127.0.0.1:19100/' }),
    ).resolves.toBeNull();
    // Invalid userinfo must not trigger another network request (there is no
    // configured fallback endpoint in this half of the assertion).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a per-request Studio bridge device id when direct BoardAgent is absent', async () => {
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: JSON.stringify({ ok: true, mock: false }) }), {
        status: 200,
      }),
    );
    await expect(
      stationAgentFetch('/healthz', {
        cookieHeader: 'studio_session=test',
        deviceId: 'studio-device-2',
      }),
    ).resolves.toEqual({ ok: true, mock: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:18090/api/devices/studio-device-2/exec');
    expect((init.headers as Record<string, string>).cookie).toBe('studio_session=test');
    expect((init.headers as Record<string, string>).origin).toBe('https://rdkstudio.d-robotics.cc');
  });

  it('rejects oversized or control-character cookies before the Studio bridge', async () => {
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const cookieHeader of ['c'.repeat(16_385), 'studio_session=test\nX-Evil: yes']) {
      await expect(
        stationAgentFetch('/healthz', { cookieHeader, deviceId: 'studio-device-2' }),
      ).resolves.toBeNull();
    }
    await expect(
      stationAgentFetchStream('/v1/station/status/stream', {
        cookieHeader: 'studio_session=test\nX-Evil: yes',
        deviceId: 'studio-device-2',
      }),
    ).rejects.toThrow('station agent unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized or control-character bridge origins before fetch', async () => {
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const origin of [
      'https://studio.example.' + 'a'.repeat(600),
      'https://studio.example\t',
    ]) {
      process.env.RDK_SIM2REAL_PUBLIC_ORIGIN = origin;
      await expect(
        stationAgentFetch('/healthz', {
          cookieHeader: 'studio_session=test',
          deviceId: 'studio-device-2',
        }),
      ).resolves.toBeNull();
    }
    for (const execOrigin of ['http://127.0.0.1:18090\t', 'http://127.0.0.1:' + '9'.repeat(600)]) {
      delete process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
      process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = execOrigin;
      await expect(
        stationAgentFetch('/healthz', {
          cookieHeader: 'studio_session=test',
          deviceId: 'studio-device-2',
        }),
      ).resolves.toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.RDK_SIM2REAL_PUBLIC_ORIGIN = 'https://studio.example.test\t';
    await expect(
      stationAgentFetchStream('/v1/station/status/stream', {
        cookieHeader: 'studio_session=test',
        deviceId: 'studio-device-2',
      }),
    ).rejects.toThrow('station agent unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a validated per-device loopback URL for streaming endpoints', async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"ok":true}\n'));
        controller.close();
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(upstream, { status: 200 }));
    const stream = await stationAgentFetchStream('/v1/station/status/stream', {
      baseUrl: 'http://127.0.0.1:19201',
      lifetimeMs: 5_000,
    });
    await stream.cancel();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19201/v1/station/status/stream',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
