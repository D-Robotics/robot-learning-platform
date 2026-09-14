import type { Request, Response } from 'express';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runOnDevice } from './standalone-adapters.js';

const originalUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const originalStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const originalStudioOrigin = process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  if (originalUrl === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = originalUrl;
  if (originalToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = originalToken;
  if (originalStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = originalStorage;
  if (originalStudioOrigin === undefined) delete process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
  else process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = originalStudioOrigin;
  vi.restoreAllMocks();
});

const request = {} as Request;
const response = {} as Response;
const preflight =
  '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__\narch=aarch64\n__STUDIO_SIM2REAL_PREFLIGHT_END__';

describe('standalone BoardAgent HTTP reference client', () => {
  it('fails closed when no agent URL or an insecure remote URL is configured', async () => {
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    expect(await runOnDevice(request, response, 'duck-1', ['probe'])).toBeNull();

    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://board-agent.internal:19100';
    expect(await runOnDevice(request, response, 'duck-1', ['probe'])).toBeNull();
  });

  it('sends a structured read-only command to the loopback agent', async () => {
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
    process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'local-secret';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          device: {
            id: 'duck-1',
            kind: 'simulated-x5',
            boardPlatform: 'rdk-x5',
            password: 'must-not-cross-adapter',
            pluginSecret: 'must-not-cross-adapter',
          },
          output: preflight,
          exitCode: 0,
          mock: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await runOnDevice(request, response, 'duck-1', ['printf preflight'], {
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      output: preflight,
      exitCode: 0,
      mock: true,
      device: { id: 'duck-1', kind: 'simulated-x5', boardPlatform: 'rdk-x5' },
    });
    expect(result?.device).not.toHaveProperty('password');
    expect(result?.device).not.toHaveProperty('pluginSecret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:19100/v1/devices/duck-1/commands');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer local-secret');
    expect(JSON.parse(String(init.body))).toEqual({ commands: ['printf preflight'] });
  });

  it('rejects oversized or malformed agent responses', async () => {
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://localhost:19100';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: '', device: {} }), { status: 200 }),
    );
    expect(await runOnDevice(request, response, 'duck-1', ['probe'])).toBeNull();
  });

  it('rejects malformed declared lengths and follows no upstream redirect', async () => {
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'https://agent.example.test';
    const calls: RequestInit[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      calls.push(init ?? {});
      return new Response('{}', {
        status: 200,
        headers: { 'content-length': 'not-a-length' },
      });
    });
    expect(await runOnDevice(request, response, 'duck-1', ['probe'])).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0]?.redirect).toBe('error');

    fetchMock.mockImplementationOnce(async (_input, init) => {
      calls.push(init ?? {});
      return new Response('', {
        status: 302,
        headers: { location: 'https://evil.example' },
      });
    });
    expect(await runOnDevice(request, response, 'duck-1', ['probe'])).toBeNull();
    expect(calls[1]?.redirect).toBe('error');
  });

  it('bounds a chunked agent response with no content-length header', async () => {
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));
    expect(await runOnDevice(request, response, 'duck-1', ['probe'])).toBeNull();
  });

  it('fails closed before transport for malformed command envelopes', async () => {
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await runOnDevice(request, response, 'duck-1', ['probe\u0000'])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps bridge execution bound to the owner-authorized registry row', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-board-agent-owners-'));
    temporaryRoots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = root;
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'https://studio.example.test';
    await fs.writeFile(
      path.join(root, 'devices.json'),
      JSON.stringify([
        {
          id: 'same-device-id',
          host: '127.0.0.2',
          username: 'root',
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
          connectionMode: 'bridge',
          bridgeDeviceId: 'bob-device',
          bridgeOwnerKey: 'sso:bob:web',
        },
        {
          id: 'same-device-id',
          host: '127.0.0.3',
          username: 'root',
          status: 'connected',
          lastCheckedAt: new Date().toISOString(),
          connectionMode: 'bridge',
          bridgeDeviceId: 'alice-device',
          bridgeOwnerKey: 'sso:alice:web',
        },
      ]),
      'utf8',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: preflight, device: { id: 'same-device-id' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const authorizedRequest = { headers: { cookie: 'studio_session=alice' } } as Request;

    const result = await runOnDevice(authorizedRequest, response, 'same-device-id', ['probe'], {
      bridgeDeviceId: 'alice-device',
      bridgeOwnerKey: 'sso:alice:web',
    });
    expect(result).toMatchObject({ output: preflight });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://studio.example.test/api/devices/alice-device/exec',
    );

    fetchMock.mockClear();
    expect(
      await runOnDevice(authorizedRequest, response, 'same-device-id', ['probe'], {
        bridgeDeviceId: 'bob-device',
        bridgeOwnerKey: 'sso:alice:web',
      }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
