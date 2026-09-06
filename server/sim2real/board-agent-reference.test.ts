import type { Request, Response } from 'express';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runOnDevice } from './standalone-adapters.js';

const originalUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = originalUrl;
  if (originalToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = originalToken;
  vi.restoreAllMocks();
});

const request = {} as Request;
const response = {} as Response;
const preflight = '__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__\narch=aarch64\n__STUDIO_SIM2REAL_PREFLIGHT_END__';

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
      new Response(JSON.stringify({
        device: { id: 'duck-1', kind: 'simulated-x5' },
        output: preflight,
        exitCode: 0,
        mock: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const result = await runOnDevice(request, response, 'duck-1', ['printf preflight'], {
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({ output: preflight, exitCode: 0, mock: true, device: { id: 'duck-1' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:19100/v1/devices/duck-1/commands');
    expect(init.method).toBe('POST');
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
});
