import type { Request, Response, Router } from 'express';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSim2RealBoardStationRoutes } from './sim2real-board-station-routes.js';

const originalAgentUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalAgentToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const originalDriveEnabled = process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
const originalArmEnabled = process.env.RDK_SIM2REAL_STATION_ARM_ENABLED;
const originalStorageDir = process.env.RDK_SIM2REAL_STORAGE_DIR;
const originalStudioExecOrigin = process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
const originalStudioDeviceId = process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
const originalPublicOrigin = process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;

const tmpdirSync = () => mkdtempSync(join(tmpdir(), 'station-switch-test-'));

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

function buildRouter(
  devices: readonly unknown[] = [device],
  options: {
    multiUser?: boolean;
    owner?: string;
    onVisibleDevices?: (owner?: string) => void;
  } = {},
) {
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
    auth: { isMultiUserDeployment: () => options.multiUser === true } as never,
    requestOwner: () => options.owner ?? 'local-dev',
    visibleDevices: async (owner) => {
      options.onVisibleDevices?.(owner);
      return devices;
    },
  });
  return router;
}

function call(
  handler: Handler,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  return new Promise<{
    statusCode: number;
    body?: unknown;
    ended: boolean;
    chunks: Uint8Array[];
    headers: Record<string, string>;
  }>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 200,
      ended: false,
      status(code: number) {
        response.statusCode = code;
        return response;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      writeHead(code: number, values: Record<string, string>) {
        response.statusCode = code;
        Object.assign(headers, values);
      },
      write(chunk: Uint8Array) {
        chunks.push(chunk);
        return true;
      },
      end() {
        response.ended = true;
        resolve({ statusCode: response.statusCode, ended: true, chunks, headers });
      },
      json(body: unknown) {
        resolve({ statusCode: response.statusCode, body, ended: false, chunks, headers });
        return response;
      },
      on() {},
      destroy() {},
    } as unknown as Response;
    const request = {
      method: init.method ?? 'GET',
      query: init.query ?? {},
      headers: init.headers ?? {},
      body: init.body ?? {},
      on() {},
    } as unknown as Request;
    handler(request, response, (error?: unknown) => {
      if (error) reject(error);
      else resolve({ statusCode: response.statusCode, ended: response.ended, chunks, headers });
    });
  });
}

beforeEach(() => {
  process.env.RDK_SIM2REAL_STORAGE_DIR = tmpdirSync();
  process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-secret';
  delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
  delete process.env.RDK_SIM2REAL_STATION_ARM_ENABLED;
});

afterEach(() => {
  if (originalStorageDir === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = originalStorageDir;
  if (originalAgentUrl === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = originalAgentUrl;
  if (originalAgentToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = originalAgentToken;
  if (originalDriveEnabled === undefined) delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
  else process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = originalDriveEnabled;
  if (originalArmEnabled === undefined) delete process.env.RDK_SIM2REAL_STATION_ARM_ENABLED;
  else process.env.RDK_SIM2REAL_STATION_ARM_ENABLED = originalArmEnabled;
  if (originalStudioExecOrigin === undefined) delete process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
  else process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = originalStudioExecOrigin;
  if (originalStudioDeviceId === undefined) delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
  else process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID = originalStudioDeviceId;
  if (originalPublicOrigin === undefined) delete process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
  else process.env.RDK_SIM2REAL_PUBLIC_ORIGIN = originalPublicOrigin;
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

describe('board-station Studio native device identity', () => {
  const studioOrigin = 'http://127.0.0.1:18090';
  const nativeId = '3b0cd56b-84e4-4e84-8c56-e722e41fd3e8';
  const nativeDevice = {
    ...device,
    id: 'platform-s100-alice',
    bridgeDeviceId: 'ssh:rdk@board.example.test:22',
    studioDeviceId: nativeId,
    bridgeOwnerKey: 'owner-alice',
  };
  const readRoutes = [
    ['health', '/healthz'],
    ['status', '/v1/station/status'],
    ['camera.mjpeg', '/v1/station/camera.snapshot'],
  ] as const;

  beforeEach(() => {
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = studioOrigin;
    process.env.RDK_SIM2REAL_PUBLIC_ORIGIN = 'https://studio.example.test';
    // A request's owned registry choice must always win over a legacy default.
    process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID = 'unused-global-device';
  });

  it.each(readRoutes)(
    'executes %s through the selected native UUID, with the caller cookie and no motion',
    async (route, agentPath) => {
      const expectedUrl = `${studioOrigin}/api/devices/${nativeId}/exec`;
      const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
      let snapshots = 0;
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url) !== expectedUrl) {
          return new Response(JSON.stringify({ error: 'DEVICE_NOT_FOUND' }), { status: 404 });
        }
        const command = JSON.parse(String(init?.body)).command as string;
        let output: string;
        if (command.includes('/v1/station/camera.snapshot')) {
          output = snapshots++ === 0 ? jpeg.toString('base64') : '';
        } else if (command.includes('/healthz')) {
          output = JSON.stringify({ ok: true, capabilities: ['host-station'], mock: false });
        } else {
          output = JSON.stringify({ available: true, state: 'connected', mock: false });
        }
        return new Response(JSON.stringify({ output }), { status: 200 });
      });
      const visibleDevices = vi.fn();
      const router = buildRouter([nativeDevice], {
        multiUser: true,
        owner: 'owner-alice',
        onVisibleDevices: visibleDevices,
      });
      const res = await call(routeHandler(router, 'get', `/api/sim2real/board-station/${route}`), {
        query: { deviceId: nativeDevice.id },
        headers: { cookie: 'studio_session=alice-fixture' },
      });
      expect(visibleDevices).toHaveBeenCalledWith('owner-alice');
      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
      for (const [url, init] of fetchMock.mock.calls) {
        expect(url).toBe(expectedUrl);
        expect(init).toMatchObject({
          method: 'POST',
          redirect: 'error',
          headers: {
            cookie: 'studio_session=alice-fixture',
            origin: 'https://studio.example.test',
          },
        });
        const command = JSON.parse(String(init?.body)).command as string;
        expect(command).toContain(`http://127.0.0.1:19100${agentPath}`);
        expect(command).not.toMatch(/--data|station\/(?:drive|policy|arm|commands)/);
      }
      if (route === 'health') {
        expect(res.body).toMatchObject({
          ok: true,
          device: { id: nativeDevice.id },
          cameraSupported: true,
        });
        expect(JSON.stringify(res.body)).not.toContain(nativeId);
        expect(JSON.stringify(res.body)).not.toContain(nativeDevice.bridgeDeviceId);
      } else if (route === 'status') {
        expect(res.body).toMatchObject({ ok: true, status: { available: true, mock: false } });
      } else {
        expect(res.ended).toBe(true);
        expect(res.headers['content-type']).toContain('multipart/x-mixed-replace');
        expect(Buffer.concat(res.chunks).includes(jpeg)).toBe(true);
      }
    },
  );

  it.each(readRoutes)("rejects another owner's device on %s before any exec", async (route) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const visibleDevices = vi.fn();
    // The registry port exposes only Alice's rows after its account filter.
    const router = buildRouter([nativeDevice], {
      multiUser: true,
      owner: 'owner-alice',
      onVisibleDevices: visibleDevices,
    });
    for (const foreignId of [
      'platform-s100-bob',
      'ssh:rdk@other-board.example.test:22',
      'd0c086ff-d911-42c4-80db-aadbe77c5e73',
    ]) {
      const res = await call(routeHandler(router, 'get', `/api/sim2real/board-station/${route}`), {
        query: { deviceId: foreignId },
        headers: { cookie: 'studio_session=alice-fixture' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toMatchObject({ error: 'SIM2REAL_DEVICE_NOT_FOUND' });
    }
    expect(visibleDevices).toHaveBeenCalledWith('owner-alice');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy Bridge ID', { ...device, bridgeDeviceId: 'legacy-bridge-1' }, 'legacy-bridge-1'],
    ['legacy platform ID', device, 'x5-real-001'],
  ])('keeps %s fallback when no native ID is stored', async (_label, row, expectedId) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ output: JSON.stringify({ capabilities: ['host-station'] }) }),
        ),
      );
    const router = buildRouter([row]);
    const res = await call(routeHandler(router, 'get', '/api/sim2real/board-station/health'), {
      headers: { cookie: 'studio_session=legacy-fixture' },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      `${studioOrigin}/api/devices/${expectedId}/exec`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(res.body).toMatchObject({ ok: true, cameraSupported: true });
  });

  it('does not execute a native device without the current caller cookie', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter([nativeDevice]);
    const res = await call(routeHandler(router, 'get', '/api/sim2real/board-station/health'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: false, state: 'offline' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('board-station constrained drive proxy', () => {
  it('defaults to a connected device when an older disconnected row comes first', async () => {
    const stale = { ...device, id: 'x5-stale', status: 'disconnected' };
    const connected = { ...device, id: 's100-live', name: 'RDK S100 实机', status: 'connected' };
    const fetchMock = mockAgent(200, {
      ok: true,
      capabilities: ['host-station'],
      stationCommands: [],
      actuatorControl: false,
      mock: false,
    });
    const router = buildRouter([stale, connected]);
    const res = await call(routeHandler(router, 'get', '/api/sim2real/board-station/health'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      device: { id: 's100-live', name: 'RDK S100 实机' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/healthz',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('does not expose a persisted device as connected without a fresh probe', async () => {
    const router = buildRouter();
    const res = await call(routeHandler(router, 'get', '/api/sim2real/board-station/devices'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      devices: [{ id: 'x5-real-001', status: 'disconnected' }],
    });
  });

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
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1]!.body)) as Record<
      string,
      number
    >;
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

describe('board-station constrained arm proxy', () => {
  it('refuses arm motion while the platform switch is off, without calling the agent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/arm/move'), {
      method: 'POST',
      body: { x: 250, y: 0, z: 80, speedMmPerS: 60 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_ARM_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps arm targets into the workspace box before the board ever sees them', async () => {
    process.env.RDK_SIM2REAL_STATION_ARM_ENABLED = '1';
    const fetchMock = mockAgent(200, { ok: true, arm: { available: true, moving: true } });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/arm/move'), {
      method: 'POST',
      body: { x: 5000, y: -900, z: -20, speedMmPerS: 9999 },
    });
    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1]!.body)) as Record<
      string,
      number
    >;
    expect(sent).toEqual({ x: 450, y: -250, z: 20, speedMmPerS: 120 });
  });

  it('rejects non-numeric arm payloads with 400 before the agent is called', async () => {
    process.env.RDK_SIM2REAL_STATION_ARM_ENABLED = '1';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/arm/move'), {
      method: 'POST',
      body: { x: 'far', y: 0, z: 80 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_ARM_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps gripper values and rejects invalid actions', async () => {
    process.env.RDK_SIM2REAL_STATION_ARM_ENABLED = '1';
    const router = buildRouter();
    const bad = await call(
      routeHandler(router, 'post', '/api/sim2real/board-station/arm/gripper'),
      { method: 'POST', body: { action: 'toggle', value: 8 } },
    );
    expect(bad.statusCode).toBe(400);
    const fetchMock = mockAgent(200, { ok: true, detail: { grasped: true } });
    const res = await call(
      routeHandler(router, 'post', '/api/sim2real/board-station/arm/gripper'),
      { method: 'POST', body: { action: 'close', value: 999 } },
    );
    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1]!.body)) as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({ action: 'close', value: 20 });
  });

  it('always forwards arm stop, even with the switch off', async () => {
    const fetchMock = mockAgent(200, { ok: true, wasMoving: false, homed: true });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/arm/stop'), {
      method: 'POST',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/station/arm/stop',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports arm status with the platform gate state', async () => {
    const fetchMock = mockAgent(200, {
      ok: true,
      arm: { available: true, mock: false, enabled: false },
      capabilities: ['arm-preflight'],
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'get', '/api/sim2real/board-station/arm'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      platformEnabled: false,
      arm: { available: true, mock: false },
      capabilities: ['arm-preflight'],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/station/arm/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
