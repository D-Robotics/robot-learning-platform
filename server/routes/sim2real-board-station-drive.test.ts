import type { Request, Response, Router } from 'express';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSim2RealBoardStationRoutes } from './sim2real-board-station-routes.js';

const originalAgentUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalAgentToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const originalDriveEnabled = process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;

const device = {
  id: 'x5-real-001',
  name: 'RDK X5 真机',
  status: 'connected',
  kind: 'simulated-x5',
  boardPlatform: 'rdk-x5',
  boardModel: 'D-Robotics RDK X5 V1.0',
  connectionMode: null,
} as never;

type Handler = (request: Request, response: Response, next: (error?: unknown) => void) => void;

function routeHandler(router: Router, method: 'get' | 'post', path: string): Handler {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  const handler = layer?.route?.stack[0]?.handle as Handler | undefined;
  if (!handler) throw new Error(`route missing: ${method} ${path}`);
  return handler;
}

function buildRouter() {
  const router = {} as Router;
  router.stack = [];
  router.get = (path: string, ...handlers: Handler[]) => {
    router.stack.push({ route: { path, methods: { get: true }, stack: handlers.map((h) => ({ handle: h })) } } as never);
    return router;
  };
  router.post = (path: string, ...handlers: Handler[]) => {
    router.stack.push({ route: { path, methods: { post: true }, stack: handlers.map((h) => ({ handle: h })) } } as never);
    return router;
  };
  registerSim2RealBoardStationRoutes(router, {
    auth: { isMultiUserDeployment: () => false } as never,
    requestOwner: () => 'local-dev',
    visibleDevices: async () => [device],
  });
  return router;
}

function call(handler: Handler, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}) {
  return new Promise<{ statusCode: number; body?: unknown; ended: boolean }>((resolve, reject) => {
    const response = {
      statusCode: 200,
      ended: false,
      status(code: number) {
        response.statusCode = code;
        return response;
      },
      setHeader() {},
      writeHead() {},
      write() { return true; },
      end() {
        response.ended = true;
      },
      json(body: unknown) {
        resolve({ statusCode: response.statusCode, body });
        return response;
      },
      on() {},
      destroy() {},
    } as unknown as Response;
    const request = {
      method: init.method ?? 'GET',
      query: init.query ?? {},
      headers: {},
      body: init.body ?? {},
      on() {},
    } as unknown as Request;
    handler(request, response, (error?: unknown) => {
      if (error) reject(error);
      else resolve({ statusCode: response.statusCode, ended: response.ended });
    });
  });
}

beforeEach(() => {
  process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-secret';
  delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
});

afterEach(() => {
  if (originalAgentUrl === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = originalAgentUrl;
  if (originalAgentToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = originalAgentToken;
  if (originalDriveEnabled === undefined) delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
  else process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = originalDriveEnabled;
  vi.restoreAllMocks();
});

/** Mock the agent's answer for the given path. */
function mockAgent(status: number, payload: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('board-station constrained drive proxy', () => {
  it('reports drive state and forwards the honest agent answer', async () => {
    const fetchMock = mockAgent(200, {
      ok: true,
      drive: { enabled: false, active: false, lastStopReason: 'idle' },
      actuatorPolicy: { enabled: false, maxLinear: 0.3 },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'get', '/api/sim2real/board-station/drive'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      platformEnabled: false,
      drive: { enabled: false },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/station/drive',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('refuses motion while the platform switch is off, without calling the agent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/drive'), {
      method: 'POST',
      body: { linear: 0.1, angular: 0, durationSec: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_DRIVE_DISABLED' });
    // The motion command must never reach the agent while the gate is closed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps values and forwards the payload to the agent when both gates are on', async () => {
    process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = '1';
    const fetchMock = mockAgent(200, {
      ok: true,
      drive: { enabled: true, active: true, linear: 0.3, remainingMs: 1500 },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/drive'), {
      method: 'POST',
      body: { linear: 9.0, angular: -5.0, durationSec: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/station/drive',
      expect.objectContaining({ method: 'POST' }),
    );
    const sent = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown[])[1]!.body),
    ) as Record<string, number>;
    // The proxy clamps before the board ever sees the request.
    expect(sent).toEqual({ linear: 0.3, angular: -1.0, durationSec: 2.0 });
  });

  it('rejects non-numeric drive payloads with 400 before the agent is called', async () => {
    process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = '1';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/drive'), {
      method: 'POST',
      body: { linear: 'fast', angular: 0, durationSec: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_DRIVE_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an agent-side refusal (409) through to the browser verbatim', async () => {
    process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = '1';
    mockAgent(409, {
      ok: false,
      error: 'BOARD_AGENT_DRIVE_REFUSED',
      reason: 'drive-disabled',
      drive: { enabled: false, active: false },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/drive'), {
      method: 'POST',
      body: { linear: 0.1, angular: 0, durationSec: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ reason: 'drive-disabled' });
  });

  it('always forwards the emergency stop, even with the drive switch off', async () => {
    const fetchMock = mockAgent(200, {
      ok: true,
      drive: { enabled: false, active: false, lastStopReason: 'operator-emergency-stop' },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/drive/stop'), {
      method: 'POST',
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/station/drive/stop',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports an unreachable agent for stop as retryable 502 (watchdog floor noted)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/drive/stop'), {
      method: 'POST',
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_BOARD_AGENT_UNREACHABLE', retryable: true });
  });
});
