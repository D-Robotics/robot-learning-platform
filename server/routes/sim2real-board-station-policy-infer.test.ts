import type { Request, Response, Router } from 'express';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSim2RealBoardStationRoutes } from './sim2real-board-station-routes.js';

const originalAgentUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalAgentToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const originalStorageDir = process.env.RDK_SIM2REAL_STORAGE_DIR;

const tmpdirSync = () => mkdtempSync(join(tmpdir(), 'station-policy-infer-test-'));

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
    router.stack.push({
      route: { path, methods: { get: true }, stack: handlers.map((h) => ({ handle: h })) },
    } as never);
    return router;
  };
  router.post = (path: string, ...handlers: Handler[]) => {
    router.stack.push({
      route: { path, methods: { post: true }, stack: handlers.map((h) => ({ handle: h })) },
    } as never);
    return router;
  };
  router.put = (path: string, ...handlers: Handler[]) => {
    router.stack.push({
      route: { path, methods: { put: true }, stack: handlers.map((h) => ({ handle: h })) },
    } as never);
    return router;
  };
  registerSim2RealBoardStationRoutes(router, {
    auth: { isMultiUserDeployment: () => false } as never,
    requestOwner: () => 'local-dev',
    visibleDevices: async () => [device],
  });
  return router;
}

function call(
  handler: Handler,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
) {
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
      write() {
        return true;
      },
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
  process.env.RDK_SIM2REAL_STORAGE_DIR = tmpdirSync();
  process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-secret';
});

afterEach(() => {
  if (originalStorageDir === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = originalStorageDir;
  if (originalAgentUrl === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = originalAgentUrl;
  if (originalAgentToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = originalAgentToken;
  vi.restoreAllMocks();
});

function mockAgent(status: number, payload: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('board-station batch policy inference proxy (hybrid mode)', () => {
  it('rejects a non-2d observations body without calling the agent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    const res = await call(
      routeHandler(router, 'post', '/api/sim2real/board-station/policy-infer'),
      {
        method: 'POST',
        body: { observations: [0.1, 0.2, 0.3] },
      },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_POLICY_INFER_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects batches beyond 64 rows without calling the agent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    const rows = Array.from({ length: 65 }, () => new Array(61).fill(0));
    const res = await call(
      routeHandler(router, 'post', '/api/sim2real/board-station/policy-infer'),
      {
        method: 'POST',
        body: { observations: rows },
      },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_POLICY_INFER_INVALID', max: 64 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the nine-duck batch to the agent and returns the actions verbatim', async () => {
    const actions = Array.from({ length: 9 }, (_, i) => new Array(14).fill(i * 0.01));
    const fetchMock = mockAgent(200, {
      ok: true,
      actions,
      count: 9,
      path: 'per-sample',
      mock: true,
    });
    const router = buildRouter();
    const rows = Array.from({ length: 9 }, () => new Array(61).fill(0.5));
    const res = await call(
      routeHandler(router, 'post', '/api/sim2real/board-station/policy-infer'),
      {
        method: 'POST',
        body: { observations: rows },
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, count: 9, path: 'per-sample' });
    expect((res.body as { actions: number[][] }).actions).toHaveLength(9);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/station/policy-infer',
      expect.objectContaining({ method: 'POST' }),
    );
    const forwarded = JSON.parse(
      String(
        (fetchMock.mock.calls[0] as unknown[])[1] !== undefined
          ? (fetchMock.mock.calls[0] as [string, { body: string }])[1].body
          : '{}',
      ),
    ) as { observations: number[][] };
    expect(forwarded.observations).toHaveLength(9);
    expect(forwarded.observations[0]).toHaveLength(61);
  });

  it('maps an unreachable agent to 502 SIM2REAL_BOARD_AGENT_UNREACHABLE', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const router = buildRouter();
    const res = await call(
      routeHandler(router, 'post', '/api/sim2real/board-station/policy-infer'),
      {
        method: 'POST',
        body: { observations: [new Array(61).fill(0)] },
      },
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_BOARD_AGENT_UNREACHABLE', retryable: true });
  });

  it('propagates the agent-side fail-closed rejection status and payload', async () => {
    mockAgent(409, { ok: false, error: 'model-not-ready', state: 'idle' });
    const router = buildRouter();
    const res = await call(
      routeHandler(router, 'post', '/api/sim2real/board-station/policy-infer'),
      {
        method: 'POST',
        body: { observations: [new Array(61).fill(0)] },
      },
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'model-not-ready' });
  });
});
