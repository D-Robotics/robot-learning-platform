import type { Request, Response, Router } from 'express';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSim2RealBoardStationRoutes } from './sim2real-board-station-routes.js';

const originalAgentUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalAgentToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const originalDriveEnabled = process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
const originalStorageDir = process.env.RDK_SIM2REAL_STORAGE_DIR;
const originalPolicyEnabled = process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;

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
  deps: {
    getRun?: (runId: string, owner?: string) => Promise<unknown>;
    fetchRunArtifact?: (run: unknown, owner?: string) => Promise<{ bytes: Buffer; sha256: string } | null>;
  } = {},
) {
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
  router.put = (path: string, ...handlers: Handler[]) => {
    router.stack.push({ route: { path, methods: { put: true }, stack: handlers.map((h) => ({ handle: h })) } } as never);
    return router;
  };
  registerSim2RealBoardStationRoutes(router, {
    auth: { isMultiUserDeployment: () => false } as never,
    requestOwner: () => 'local-dev',
    visibleDevices: async () => [device],
    ...(deps.getRun ? { getRun: deps.getRun as never } : {}),
    ...(deps.fetchRunArtifact ? { fetchRunArtifact: deps.fetchRunArtifact as never } : {}),
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
  process.env.RDK_SIM2REAL_STORAGE_DIR = tmpdirSync();
  process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-secret';
  delete process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED;
  delete process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;
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
  if (originalPolicyEnabled === undefined) delete process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED;
  else process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = originalPolicyEnabled;
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

describe('board-station policy runtime proxy', () => {
  it('reports the honest policy state (switch off is a readable answer, not an error)', async () => {
    const fetchMock = mockAgent(200, {
      ok: true,
      policy: {
        enabled: false,
        runtimeRunning: false,
        motionAuthorized: false,
        state: null,
        limits: { maxLinear: 0.3 },
      },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'get', '/api/sim2real/board-station/policy'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      platformEnabled: false,
      drivePlatformEnabled: false,
      policy: { enabled: false, runtimeRunning: false },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/station/policy',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('refuses load while the platform policy switch is off, without calling the agent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/load'), {
      method: 'POST',
      body: { path: 'policy.onnx' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_POLICY_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects traversal and absolute paths with 400 before the agent is called', async () => {
    process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    for (const path of ['../etc/passwd', '/abs/path.onnx', 'nested/dir.onnx', 'no-extension', 'a b.onnx']) {
      const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/load'), {
        method: 'POST',
        body: { path },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_POLICY_INVALID_PATH' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only the bare filename and lets the board resolve its pinned dir', async () => {
    process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
    const fetchMock = mockAgent(200, {
      ok: true,
      policy: { state: 'ready', model: { inputDim: 61, outputDim: 14 } },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/load'), {
      method: 'POST',
      body: { path: 'ppo-policy.onnx' },
    });
    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown[])[1]!.body),
    ) as Record<string, string>;
    expect(sent).toEqual({ path: 'ppo-policy.onnx' });
  });

  it('refuses start while the drive switch is off even with policy on', async () => {
    process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/start'), {
      method: 'POST',
      body: { direction: 0.5 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_DRIVE_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps direction and forwards start when all platform gates are on', async () => {
    process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
    process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = '1';
    const fetchMock = mockAgent(200, {
      ok: true,
      policy: { state: 'running', published: 12 },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/start'), {
      method: 'POST',
      body: { direction: 42.0 },
    });
    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown[])[1]!.body),
    ) as Record<string, number>;
    expect(sent).toEqual({ direction: 1 });
  });

  it('forwards an explicit OriginBot goal with the bounded direction', async () => {
    process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
    process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = '1';
    const fetchMock = mockAgent(200, { ok: true, policy: { state: 'running' } });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/start'), {
      method: 'POST',
      body: { direction: 0.25, goalX: 1.2, goalY: -0.4 },
    });
    expect(res.statusCode).toBe(200);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1]!.body));
    expect(sent).toEqual({ direction: 0.25, goalX: 1.2, goalY: -0.4 });
  });

  it('passes an agent-side refusal (409) through to the browser verbatim', async () => {
    process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
    process.env.RDK_SIM2REAL_STATION_DRIVE_ENABLED = '1';
    mockAgent(409, {
      ok: false,
      error: 'BOARD_AGENT_POLICY_REFUSED',
      reason: 'no-model',
      policy: { state: 'idle' },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/start'), {
      method: 'POST',
      body: { direction: 0.1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ reason: 'no-model' });
  });

  it('always forwards the policy stop, even with both switches off', async () => {
    const fetchMock = mockAgent(200, {
      ok: true,
      policy: { state: 'idle', lastOp: { op: 'stop', ok: true } },
    });
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/stop'), {
      method: 'POST',
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19100/v1/station/policy/stop',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports an unreachable agent for stop as retryable 502 (watchdog floor noted)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));
    const router = buildRouter();
    const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/stop'), {
      method: 'POST',
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: 'SIM2REAL_BOARD_AGENT_UNREACHABLE', retryable: true });
  });

  describe('policy staging (training artifact → board policies dir)', () => {
    const artifactBytes = Buffer.from('fake-onnx-bytes-for-staging');
    const artifactSha = 'a'.repeat(64);
    const completedRun = {
      id: 'run-stage-1',
      modelId: 'model-1',
      backend: 'local',
      status: 'completed',
      mock: false,
      externalRunId: 'local-run-1',
      artifact: { artifactId: 'policy', artifactRef: 'artifact://starter/x/policy.onnx', format: 'onnx', sha256: artifactSha },
    };

    it('refuses staging while the platform policy switch is off', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const router = buildRouter({
        getRun: async () => completedRun,
        fetchRunArtifact: async () => ({ bytes: artifactBytes, sha256: artifactSha }),
      });
      const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/stage'), {
        method: 'POST',
        body: { runId: 'run-stage-1' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_POLICY_DISABLED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses without run evidence (mock / incomplete / no digest)', async () => {
      process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
      const router = buildRouter({
        getRun: async () => ({ ...completedRun, mock: true }),
        fetchRunArtifact: async () => null,
      });
      const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/stage'), {
        method: 'POST',
        body: { runId: 'run-stage-1' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_POLICY_RUN_NOT_STAGED' });
    });

    it('refuses when the worker bytes no longer hash to the recorded digest', async () => {
      process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
      const router = buildRouter({
        getRun: async () => completedRun,
        fetchRunArtifact: async () => ({ bytes: artifactBytes, sha256: 'f'.repeat(64) }),
      });
      const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/stage'), {
        method: 'POST',
        body: { runId: 'run-stage-1' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_POLICY_ARTIFACT_DIGEST_MISMATCH' });
    });

    it('uploads verified bytes base64 with the run-bound filename', async () => {
      process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
      const fetchMock = mockAgent(200, {
        ok: true,
        staged: true,
        path: 'run-stage-1.onnx',
        sha256: artifactSha,
        policies: [{ name: 'run-stage-1.onnx', bytes: artifactBytes.length }],
      });
      const router = buildRouter({
        getRun: async () => completedRun,
        fetchRunArtifact: async () => ({ bytes: artifactBytes, sha256: artifactSha }),
      });
      const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/stage'), {
        method: 'POST',
        body: { runId: 'run-stage-1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, staged: true, path: 'run-stage-1.onnx' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:19100/v1/station/policy/upload');
      expect(init.method).toBe('POST');
      const sent = JSON.parse(String(init.body)) as Record<string, string>;
      expect(sent.filename).toBe('run-stage-1.onnx');
      expect(sent.sha256).toBe(artifactSha);
      expect(Buffer.from(sent.bytesBase64, 'base64').toString('utf8')).toBe(
        artifactBytes.toString('utf8'),
      );
      expect(init.headers).toMatchObject({ authorization: 'Bearer board-secret' });
    });

    it('rejects a smuggled traversal filename before the agent is called', async () => {
      process.env.RDK_SIM2REAL_STATION_POLICY_ENABLED = '1';
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const router = buildRouter({
        getRun: async () => completedRun,
        fetchRunArtifact: async () => ({ bytes: artifactBytes, sha256: artifactSha }),
      });
      const res = await call(routeHandler(router, 'post', '/api/sim2real/board-station/policy/stage'), {
        method: 'POST',
        body: { runId: 'run-stage-1', filename: '../escape.onnx' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ error: 'SIM2REAL_STATION_POLICY_INVALID_FILENAME' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('lists staged policies from the agent', async () => {
      const fetchMock = mockAgent(200, {
        ok: true,
        dir: '/root/rdk-board-agent/policies',
        policies: [{ name: 'run-stage-1.onnx', bytes: artifactBytes.length, sha256: artifactSha }],
      });
      const router = buildRouter();
      const res = await call(routeHandler(router, 'get', '/api/sim2real/board-station/policy/files'));
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ ok: true, policies: [{ name: 'run-stage-1.onnx' }] });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:19100/v1/station/policy/files',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });
});
