import { Router, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSim2RealBoardStationRoutes } from './sim2real-board-station-routes.js';

const envKeys = [
  'RDK_SIM2REAL_BOARD_AGENT_URL',
  'RDK_SIM2REAL_BOARD_AGENT_TOKEN',
  'RDK_SIM2REAL_STUDIO_EXEC_ORIGIN',
  'RDK_SIM2REAL_STATION_DRIVE_ENABLED',
  'RDK_SIM2REAL_STATION_POLICY_ENABLED',
] as const;
const originalEnvironment = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const device = {
  id: 'duck-group-a',
  name: 'Group A duck',
  status: 'connected',
  bridgeDeviceId: 'studio-duck-a',
} as never;
const passport = {
  ok: true,
  kind: 'joint-onboarding-preflight',
  schemaVersion: 1,
  mock: false,
  ready: false,
  status: 'attention',
  blockingChecks: ['telemetry'],
  nextActions: ['check the source timestamp'],
  observedAt: '2026-10-13T00:00:00Z',
  checks: {
    identity: {
      ok: true,
      profileSha256: 'a'.repeat(64),
      provenance: { kind: 'template', mock: true },
    },
    ros: {
      ok: true,
      expected: {
        jointStates: {
          name: '/joint_states',
          type: 'sensor_msgs/msg/JointState',
          required: true,
          present: true,
        },
      },
    },
    telemetry: {
      ok: false,
      fresh: false,
      issues: ['jointStates sample expired'],
      sourceTime: { jointStates: { sampleTs: 1, sampleMonotonicNs: '1000000000' } },
    },
    joints: {
      ok: true,
      expectedNames: ['joint-1'],
      rows: [
        { name: 'joint-1', homeRad: 0, positionRad: 0.1, velocityRadSec: 0, errorFromHomeRad: 0.1 },
      ],
    },
    contract: { observationSize: 61, actionSize: 14, commandVectorSize: 13 },
    safety: { physicalCalibrationVerified: false, stopBehavior: 'hold-last-bounded-target' },
  },
  motion: { started: false, note: 'onboarding preflight is read-only' },
};

function buildRouter(
  options: { prefix?: string; denied?: boolean; devices?: readonly unknown[] } = {},
) {
  const router = Router();
  const visibleDevices = vi.fn(async () => (options.devices ?? [device]) as never);
  const requestOwner = vi.fn((_request: Request, response: Response) => {
    if (options.denied) {
      response.status(403).json({ ok: false, error: 'SIM2REAL_PERMISSION_DENIED' });
      return null;
    }
    return 'account-a';
  });
  registerSim2RealBoardStationRoutes(
    router,
    {
      auth: {
        isMultiUserDeployment: () => true,
        resolvePrincipal: () => ({ accountId: 'account-a', roles: ['viewer'] }),
      } as never,
      requestOwner,
      visibleDevices,
    },
    { prefix: options.prefix },
  );
  return { router, visibleDevices, requestOwner };
}

function invoke(router: Router, prefix = '/api/sim2real', deviceId?: string) {
  const route = router.stack.find(
    (layer) => layer.route?.path === `${prefix}/board-station/onboarding/preflight`,
  );
  const handler = route?.route?.stack[0]?.handle;
  if (!handler) throw new Error('preflight route missing');
  return new Promise<{ status: number; body: unknown; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const headers: Record<string, unknown> = {};
      const response = {
        statusCode: 200,
        status(value: number) {
          response.statusCode = value;
          return response;
        },
        setHeader(key: string, value: unknown) {
          headers[key] = value;
        },
        json(body: unknown) {
          resolve({ status: response.statusCode, body, headers });
          return response;
        },
      } as unknown as Response;
      handler(
        { method: 'GET', query: deviceId ? { deviceId } : {}, headers: {} } as Request,
        response,
        reject,
      );
    },
  );
}

beforeEach(() => {
  process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'test-board-token';
  delete process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
  delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
  delete process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe('profile-aware board onboarding preflight proxy', () => {
  it.each(['/api/sim2real', '/api/v1/duck'])(
    'preserves the joint passport on %s with motion switches off',
    async (prefix) => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new globalThis.Response(JSON.stringify(passport), { status: 200 }));
      const { router, visibleDevices } = buildRouter({ prefix });
      const result = await invoke(router, prefix, 'duck-group-a');
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, deviceId: 'duck-group-a', passport });
      expect(result.headers['Cache-Control']).toBe('no-store');
      expect(visibleDevices).toHaveBeenCalledWith('account-a');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:19100/v1/onboarding/preflight',
        expect.objectContaining({ method: 'GET' }),
      );
      const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(request.body).toBeUndefined();
    },
  );

  it('keeps the legacy wheel passport and its ready flag unchanged', async () => {
    const wheel = {
      ...passport,
      kind: 'originbot-onboarding-preflight',
      ready: true,
      blockingChecks: [],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new globalThis.Response(JSON.stringify(wheel), { status: 200 }),
    );
    const { router } = buildRouter();
    expect((await invoke(router)).body).toEqual({
      ok: true,
      deviceId: 'duck-group-a',
      passport: wheel,
    });
  });

  it('never reaches a board when owner/read authorization rejects the request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected fetch'));
    const { router, visibleDevices } = buildRouter({ denied: true });
    expect((await invoke(router)).status).toBe(403);
    expect(visibleDevices).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an explicit device outside the visible owner registry', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected fetch'));
    const { router } = buildRouter();
    const result = await invoke(router, '/api/sim2real', 'another-group-duck');
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: 'SIM2REAL_DEVICE_NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([null, [], 'unavailable'])(
    'rejects a non-object agent answer without inventing readiness',
    async (payload) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new globalThis.Response(JSON.stringify(payload), { status: 200 }),
      );
      const { router } = buildRouter();
      const result = await invoke(router);
      expect(result.status).toBe(502);
      expect(result.body).toMatchObject({ error: 'SIM2REAL_BOARD_AGENT_UNREACHABLE' });
    },
  );

  it('reports an offline board as a retryable proxy error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const { router } = buildRouter();
    const result = await invoke(router);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: 'SIM2REAL_BOARD_AGENT_UNREACHABLE',
      retryable: true,
    });
  });
});
