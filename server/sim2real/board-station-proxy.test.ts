import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const originalStudioAgentPort = process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT;

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
  if (originalStudioAgentPort === undefined) delete process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT;
  else process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT = originalStudioAgentPort;
  vi.restoreAllMocks();
});

describe('Studio bridge without curl uses bounded Python stdlib requests', () => {
  let commandPath: string;
  let agent: ReturnType<typeof createServer>;
  let requestHandler: (request: IncomingMessage, response: ServerResponse) => void;
  let executions: { code: number | null; stdout: string; stderr: string; command: string }[];
  const bridgeOptions = { cookieHeader: 'studio_session=fixture', deviceId: 'native-device-1' };
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

  beforeEach(async () => {
    commandPath = mkdtempSync(join(tmpdir(), 'station-python-fallback-'));
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim();
    symlinkSync(python, join(commandPath, 'python3'));
    // PATH has Python only: curl, base64 and tr genuinely cannot be found.
    executions = [];
    requestHandler = (_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, mock: false, transport: 'python' }));
    };
    agent = createServer((request, response) => requestHandler(request, response));
    await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
    const address = agent.address();
    if (!address || typeof address === 'string') throw new Error('missing agent fixture port');
    process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT = String(address.port);
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const command = JSON.parse(String(init?.body)).command as string;
      const result = await new Promise<(typeof executions)[number]>((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', command], {
          env: {
            PATH: commandPath,
            // A configured proxy must never receive the loopback request/token.
            http_proxy: 'http://127.0.0.1:1',
            HTTP_PROXY: 'http://127.0.0.1:1',
            https_proxy: 'http://127.0.0.1:1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr, command }));
      });
      executions.push(result);
      return new Response(JSON.stringify({ output: result.stdout }), {
        status: result.code === 0 ? 200 : 500,
      });
    });
  });

  afterEach(async () => {
    agent.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      agent.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(commandPath, { recursive: true, force: true });
  });

  it('reads real health JSON with the bearer token even when environment proxies are set', async () => {
    let authorization: string | undefined;
    requestHandler = (request, response) => {
      expect(request.url).toBe('/healthz');
      expect(request.method).toBe('GET');
      authorization = request.headers.authorization;
      response.end(JSON.stringify({ ok: true, mock: false }));
    };
    await expect(stationAgentFetch('/healthz', bridgeOptions)).resolves.toEqual({
      ok: true,
      mock: false,
    });
    expect(authorization).toBe('Bearer board-secret');
    expect(executions[0]).toMatchObject({ code: 0, stderr: '' });
  });

  it('sends POST JSON without interpreting quotes, shell substitutions or token text', async () => {
    const marker = join(commandPath, 'shell-injected');
    const text = `quote' " $() $(touch ${marker}) ;`;
    process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = text;
    const body = JSON.stringify({ command: 'sys-info', fixture: text });
    let received = '';
    requestHandler = (request, response) => {
      expect(request.url).toBe('/v1/station/commands');
      expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe(`Bearer ${text}`);
      expect(request.headers['content-type']).toBe('application/json');
      request.setEncoding('utf8').on('data', (chunk: string) => (received += chunk));
      request.on('end', () => response.end(JSON.stringify({ ok: true })));
    };
    await expect(
      stationAgentFetch('/v1/station/commands', { ...bridgeOptions, method: 'POST', body }),
    ).resolves.toEqual({ ok: true });
    expect(received).toBe(body);
    expect(existsSync(marker)).toBe(false);
    expect(executions[0]).toMatchObject({ code: 0, stderr: '' });
  });

  it('preserves a 409 JSON safety refusal instead of treating HTTPError as transport failure', async () => {
    requestHandler = (_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'drive_disabled' }));
    };
    await expect(
      stationAgentFetchWithStatus('/v1/station/drive', { ...bridgeOptions, method: 'POST' }),
    ).resolves.toEqual({ status: 200, payload: { ok: false, error: 'drive_disabled' } });
    expect(executions[0]).toMatchObject({ code: 0, stderr: '' });
  });

  it('carries one bounded JPEG as canonical base64 into the MJPEG stream', async () => {
    requestHandler = (request, response) => {
      expect(request.url).toBe('/v1/station/camera.snapshot');
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      response.end(jpeg);
    };
    const stream = await stationAgentFetchStream('/v1/station/camera.mjpeg', bridgeOptions);
    const reader = stream.getReader();
    try {
      const header = await reader.read();
      const frame = await reader.read();
      expect(Buffer.from(header.value ?? []).toString()).toContain('content-type: image/jpeg');
      expect(Buffer.from(frame.value ?? [])).toEqual(jpeg);
      expect(executions[0]).toMatchObject({ code: 0, stdout: jpeg.toString('base64'), stderr: '' });
    } finally {
      await reader.cancel();
    }
  });

  it('fails nonzero without output when the loopback agent is absent', async () => {
    await new Promise<void>((resolve) => agent.close(() => resolve()));
    await expect(stationAgentFetch('/healthz', bridgeOptions)).resolves.toBeNull();
    expect(executions[0].code).not.toBe(0);
    expect(executions[0].stdout).toBe('');
    expect(executions[0].stderr).not.toContain('board-secret');
    // Keep the fixture server reusable for the common cleanup.
    const port = Number(process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT);
    await new Promise<void>((resolve) => agent.listen(port, '127.0.0.1', resolve));
  });

  it('rejects oversized JSON before emitting any partial output', async () => {
    requestHandler = (_request, response) => {
      response.end(JSON.stringify({ pad: 'x'.repeat(256 * 1024) }));
    };
    await expect(stationAgentFetch('/healthz', bridgeOptions)).resolves.toBeNull();
    expect(executions[0].code).not.toBe(0);
    expect(executions[0].stdout).toBe('');
  });

  it('bounds a chunked JSON response even without a content-length header', async () => {
    requestHandler = (_request, response) => {
      response.write('{"pad":"');
      response.write('x'.repeat(256 * 1024));
      response.end('"}');
    };
    await expect(stationAgentFetch('/healthz', bridgeOptions)).resolves.toBeNull();
    expect(executions[0].code).not.toBe(0);
    expect(executions[0].stdout).toBe('');
  });

  it.each(['oversized JPEG', 'invalid JPEG', 'HTTP camera error'])(
    'rejects %s nonzero and emits no fake first frame',
    async (kind) => {
      requestHandler = (_request, response) => {
        response.statusCode = kind === 'HTTP camera error' ? 503 : 200;
        response.end(
          kind === 'oversized JPEG'
            ? Buffer.concat([jpeg.subarray(0, 2), Buffer.alloc(180 * 1024), jpeg.subarray(-2)])
            : 'camera unavailable',
        );
      };
      const stream = await stationAgentFetchStream('/v1/station/camera.mjpeg', bridgeOptions);
      const reader = stream.getReader();
      try {
        expect(await reader.read()).toEqual({ done: true, value: undefined });
        expect(executions[0].code).not.toBe(0);
        expect(executions[0].stdout).toBe('');
      } finally {
        await reader.cancel();
      }
    },
  );

  it('refuses redirects instead of forwarding the token outside the fixed loopback URL', async () => {
    let redirectedRequests = 0;
    requestHandler = (request, response) => {
      if (request.url === '/unexpected') redirectedRequests += 1;
      response.writeHead(302, {
        location: `http://127.0.0.1:${process.env.RDK_SIM2REAL_STUDIO_AGENT_PORT}/unexpected`,
      });
      response.end('{}');
    };
    await expect(stationAgentFetch('/healthz', bridgeOptions)).resolves.toBeNull();
    expect(redirectedRequests).toBe(0);
    expect(executions[0].code).not.toBe(0);
    expect(executions[0].stdout).toBe('');
  });

  it('continues using curl when it exists instead of invoking the Python fallback', async () => {
    writeFileSync(
      join(commandPath, 'curl'),
      '#!/bin/sh\nprintf \'%s\' \'{"ok":true,"transport":"curl"}\'\n',
      { mode: 0o700 },
    );
    await expect(stationAgentFetch('/healthz', bridgeOptions)).resolves.toEqual({
      ok: true,
      transport: 'curl',
    });
    expect(executions[0]).toMatchObject({ code: 0, stderr: '' });
  });

  it('does not retry a failing installed curl through a different transport', async () => {
    writeFileSync(join(commandPath, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o700 });
    let requests = 0;
    requestHandler = (_request, response) => {
      requests += 1;
      response.end('{"ok":true}');
    };
    await expect(stationAgentFetch('/healthz', bridgeOptions)).resolves.toBeNull();
    expect(executions[0]).toMatchObject({ code: 7, stdout: '' });
    expect(requests).toBe(0);
  });

  it('does not add an unallowlisted actuator endpoint to the bridge fallback', async () => {
    await expect(
      stationAgentFetch('/v1/station/arm/move', {
        ...bridgeOptions,
        method: 'POST',
        body: JSON.stringify({ x: 200, y: 0, z: 80 }),
      }),
    ).resolves.toBeNull();
    expect(executions).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
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
