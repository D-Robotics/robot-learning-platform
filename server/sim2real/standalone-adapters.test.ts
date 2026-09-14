import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildBoardPreflightCommand,
  boardAgentTokenConfigured,
  boardAgentTokenRequired,
  isBoardAgentConfigured,
  createStandaloneRobogoApiClient,
  isForeignOwnedDevice,
  persistDeviceBoardDetection,
  readDevices,
  requestOwnsDevice,
  safeStudioOrigin,
  studioBridgeConfiguration,
  studioSecurityHeadersMiddleware,
  upsertBridgeDevice,
} from './standalone-adapters.js';
import { createSim2RealWebApp } from '../../services/sim2real-web/server.js';

const fakeRequest = {} as never;
const previousApiUrl = process.env.RDK_SIM2REAL_ROBOGO_API_URL;
const previousToken = process.env.RDK_SIM2REAL_ROBOGO_TOKEN;
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousStudioOrigin = process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
const previousStudioDevice = process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
const previousBoardAgentUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const previousBoardAgentToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const previousNodeEnv = process.env.NODE_ENV;
const previousDeployment = process.env.RDK_SIM2REAL_DEPLOYMENT;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  if (previousApiUrl === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_API_URL;
  else process.env.RDK_SIM2REAL_ROBOGO_API_URL = previousApiUrl;
  if (previousToken === undefined) delete process.env.RDK_SIM2REAL_ROBOGO_TOKEN;
  else process.env.RDK_SIM2REAL_ROBOGO_TOKEN = previousToken;
  if (previousStorage === undefined) delete process.env.RDK_SIM2REAL_STORAGE_DIR;
  else process.env.RDK_SIM2REAL_STORAGE_DIR = previousStorage;
  if (previousStudioOrigin === undefined) delete process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
  else process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = previousStudioOrigin;
  if (previousStudioDevice === undefined) delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
  else process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID = previousStudioDevice;
  if (previousBoardAgentUrl === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = previousBoardAgentUrl;
  if (previousBoardAgentToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
  else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = previousBoardAgentToken;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDeployment === undefined) delete process.env.RDK_SIM2REAL_DEPLOYMENT;
  else process.env.RDK_SIM2REAL_DEPLOYMENT = previousDeployment;
});

describe('standalone device ownership boundary', () => {
  it('hides ownerless and unknown-owner records in multi-user mode', () => {
    expect(isForeignOwnedDevice({ id: 'unowned' }, 'sso:alice:web', true)).toBe(true);
    expect(
      isForeignOwnedDevice(
        { id: 'unknown', bridgeOwnerKey: 'legacy:alice' },
        'sso:alice:web',
        true,
      ),
    ).toBe(true);
    expect(
      isForeignOwnedDevice({ id: 'owned', bridgeOwnerKey: 'sso:alice:web' }, 'sso:alice:web', true),
    ).toBe(false);
  });

  it('keeps single-user local inspection compatible', () => {
    expect(isForeignOwnedDevice({ id: 'local' }, null, false)).toBe(false);
    expect(requestOwnsDevice(fakeRequest, { id: 'local' }, null, false)).toBe(true);
  });

  it('requires an exact verified owner key in shared mode', () => {
    const device = { id: 'alice', bridgeOwnerKey: 'sso:alice:web' };
    expect(requestOwnsDevice(fakeRequest, device, 'sso:alice:web', true)).toBe(true);
    expect(requestOwnsDevice(fakeRequest, device, 'sso:bob:web', true)).toBe(false);
    expect(requestOwnsDevice(fakeRequest, device, null, true)).toBe(false);
    expect(
      requestOwnsDevice(
        fakeRequest,
        { id: 'legacy', bridgeOwnerKey: 'legacy:alice' },
        'sso:alice:web',
        true,
      ),
    ).toBe(false);
  });

  it('skips malformed device records without allowing a corrupt registry to break the overview', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-devices-'));
    temporaryRoots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = root;
    await fs.writeFile(
      path.join(root, 'devices.json'),
      JSON.stringify([
        null,
        {
          id: 'valid-device',
          host: '127.0.0.1',
          username: 'root',
          status: 'connected',
          lastCheckedAt: '2026-09-04T00:00:00.000Z',
          bridgeOwnerKey: 'sso:alice:web',
          password: 'must-not-cross-the-adapter-boundary',
          pluginSecret: 'must-not-be-forwarded',
        },
        {
          id: 'bad-status',
          host: '127.0.0.1',
          username: 'root',
          status: 'online',
          lastCheckedAt: '2026-09-04T00:00:00.000Z',
        },
        {
          id: 'bad-control\u0000char',
          host: '127.0.0.1',
          username: 'root',
          status: 'connected',
          lastCheckedAt: '2026-09-04T00:00:00.000Z',
        },
      ]),
      'utf8',
    );

    const devices = await readDevices();
    expect(devices).toEqual([
      expect.objectContaining({ id: 'valid-device', bridgeOwnerKey: 'sso:alice:web' }),
    ]);
    expect(devices[0]).not.toHaveProperty('password');
    expect(devices[0]).not.toHaveProperty('pluginSecret');
  });

  it('keeps same-named bridge devices isolated across owners', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-bridge-owners-'));
    temporaryRoots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = root;

    const first = await upsertBridgeDevice({
      ownerKey: 'sso:alice:web',
      bridgeId: 'bridge-a',
      bridgeDeviceId: 'shared-device-id',
      host: '127.0.0.1',
    });
    const second = await upsertBridgeDevice({
      ownerKey: 'sso:bob:web',
      bridgeId: 'bridge-b',
      bridgeDeviceId: 'shared-device-id',
      host: '127.0.0.2',
    });
    const devices = await readDevices();

    expect(first.id).not.toBe(second.id);
    expect(devices).toHaveLength(2);
    expect(devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, bridgeOwnerKey: 'sso:alice:web' }),
        expect.objectContaining({ id: second.id, bridgeOwnerKey: 'sso:bob:web' }),
      ]),
    );

    // Reconnecting the first tenant updates its own row rather than deleting
    // the second tenant's row with the colliding legacy id.
    const reconnected = await upsertBridgeDevice({
      ownerKey: 'sso:alice:web',
      bridgeId: 'bridge-a',
      bridgeDeviceId: 'shared-device-id',
      host: '127.0.0.3',
    });
    expect(reconnected.id).toBe(first.id);
    expect(await readDevices()).toHaveLength(2);
  });

  it('persists board passport fields only on the selected owner row', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-detect-owners-'));
    temporaryRoots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = root;
    const rows = [
      {
        id: 'same-device-id',
        host: '127.0.0.1',
        username: 'root',
        status: 'connected',
        lastCheckedAt: '2026-09-04T00:00:00.000Z',
        connectionMode: 'bridge',
        bridgeDeviceId: 'board-a',
        bridgeOwnerKey: 'sso:alice:web',
        boardPlatform: 'old-alice',
      },
      {
        id: 'same-device-id',
        host: '127.0.0.2',
        username: 'root',
        status: 'connected',
        lastCheckedAt: '2026-09-04T00:00:00.000Z',
        connectionMode: 'bridge',
        bridgeDeviceId: 'board-b',
        bridgeOwnerKey: 'sso:bob:web',
        boardPlatform: 'old-bob',
      },
    ];
    await fs.writeFile(path.join(root, 'devices.json'), JSON.stringify(rows), 'utf8');

    expect(
      await persistDeviceBoardDetection(
        'same-device-id',
        { boardPlatform: 'rdk-x5', boardModel: 'x5', boardOsVersion: 'linux' },
        { multiUser: true, ownerKey: 'sso:alice:web' },
      ),
    ).toBe(true);
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'devices.json'), 'utf8'));
    expect(persisted).toEqual([
      expect.objectContaining({ boardPlatform: 'rdk-x5', bridgeOwnerKey: 'sso:alice:web' }),
      expect.objectContaining({ boardPlatform: 'old-bob', bridgeOwnerKey: 'sso:bob:web' }),
    ]);
    expect(
      await persistDeviceBoardDetection(
        'same-device-id',
        { boardPlatform: 'should-not-write' },
        { multiUser: true },
      ),
    ).toBe(false);
  });

  it('does not fall back to a global RoboGo token unless private mode opts in', async () => {
    process.env.RDK_SIM2REAL_ROBOGO_API_URL = 'https://robogo.example.test';
    process.env.RDK_SIM2REAL_ROBOGO_TOKEN = 'global-token';
    const requests: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(new Headers(init?.headers).get('authorization') || ''));
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    await expect(
      createStandaloneRobogoApiClient({ fetchImpl }).request('alice', {
        method: 'GET',
        path: '/summary',
      }),
    ).rejects.toThrow('robogo_api_token_not_configured');
    await createStandaloneRobogoApiClient({
      fetchImpl,
      allowEnvironmentToken: true,
    }).request('alice', { method: 'GET', path: '/summary' });
    expect(requests).toEqual(['Bearer global-token']);
  });

  it('bounds RoboGo transport responses and rejects redirects and malformed paths', async () => {
    process.env.RDK_SIM2REAL_ROBOGO_API_URL = 'https://robogo.example.test';
    process.env.RDK_SIM2REAL_ROBOGO_TOKEN = 'a'.repeat(40);
    const inits: RequestInit[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response('{}', {
        status: 200,
        headers: { 'content-length': 'not-a-length' },
      });
    }) as typeof fetch;
    const client = createStandaloneRobogoApiClient({ fetchImpl, allowEnvironmentToken: true });
    await expect(client.request('alice', { method: 'GET', path: '/summary' })).rejects.toThrow(
      'robogo_api_response_too_large',
    );
    expect(inits[0]?.redirect).toBe('error');

    await expect(client.request('alice', { method: 'GET', path: '/../private' })).rejects.toThrow(
      'robogo_api_path_invalid',
    );
    expect(inits).toHaveLength(1);
  });

  it('limits chunked RoboGo responses before JSON parsing', async () => {
    process.env.RDK_SIM2REAL_ROBOGO_API_URL = 'https://robogo.example.test';
    process.env.RDK_SIM2REAL_ROBOGO_TOKEN = 'b'.repeat(40);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_000_001));
        controller.close();
      },
    });
    const client = createStandaloneRobogoApiClient({
      fetchImpl: (async () => new Response(stream, { status: 200 })) as typeof fetch,
      allowEnvironmentToken: true,
    });
    await expect(client.request('alice', { method: 'GET', path: '/summary' })).rejects.toThrow(
      'robogo_api_response_too_large',
    );
  });

  it('allows the visible device registry to provide the Studio bridge id', () => {
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
    delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
    expect(studioBridgeConfiguration()).toEqual({
      origin: 'http://127.0.0.1:18090',
      deviceId: '',
      agentPort: 19100,
    });
  });

  it('never forwards session cookies to a plain-http remote Studio origin', () => {
    expect(safeStudioOrigin('http://studio.example.test')).toBeNull();
    expect(safeStudioOrigin('https://studio.example.test')).toBe('https://studio.example.test');
    expect(safeStudioOrigin('http://127.0.0.1:18090')).toBe('http://127.0.0.1:18090');
    expect(safeStudioOrigin('https://user:pass@studio.example.test')).toBeNull();
    expect(safeStudioOrigin('https://studio.example.test/path')).toBeNull();
  });

  it('fails closed when production points at a BoardAgent without a strong bearer', () => {
    process.env.NODE_ENV = 'production';
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'web-cloud';
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'https://board-agent.example.test';
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
    expect(boardAgentTokenRequired()).toBe(true);
    expect(boardAgentTokenConfigured()).toBe(false);
    expect(isBoardAgentConfigured()).toBe(false);

    process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'board-agent-production-random-secret-0123456789';
    expect(boardAgentTokenConfigured()).toBe(true);
    expect(isBoardAgentConfigured()).toBe(true);
  });
});

describe('board preflight probe contract', () => {
  it('probes BPU toolchain presence without guessing versions', () => {
    const command = buildBoardPreflightCommand();
    expect(command).toContain('bpu_toolchain=%s');
    expect(command).toContain('command -v hbdk-sim');
    // Both runtime spellings count: the probe must not hard-fail a board
    // that ships hbrt-tv instead of hbrtmlin.
    expect(command).toContain('command -v hbrtmlin');
    expect(command).toContain('command -v hbrt-tv');
    expect(command).not.toMatch(/hbdk-sim.*--version/);
  });

  it('stays byte-identical to the reference agent builder in board-agent-x5.py', async () => {
    // The real equivalence check: execute the Python builder and compare
    // its output against the TS allowlist string. Skipped when no python3
    // is available (same SKIP pattern as verify-starter-engine.mjs) so CI
    // nodes without python do not fail spuriously.
    let pythonOutput: string;
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      pythonOutput = (
        await promisify(execFile)(
          'python3',
          [
            '-c',
            [
              'import importlib.util, sys',
              'spec = importlib.util.spec_from_file_location("ba", "services/sim2real-web/board-agent-x5.py")',
              'module = importlib.util.module_from_spec(spec)',
              'sys.modules["ba"] = module',
              'spec.loader.exec_module(module)',
              'print(module.build_preflight_command())',
            ].join('; '),
          ],
          { cwd: process.cwd() },
        )
      ).stdout.trim();
    } catch {
      return; // python3 unavailable: skip the cross-language check
    }
    expect(pythonOutput).toBe(buildBoardPreflightCommand());
  });
});

describe('standalone security headers', () => {
  const managedEnvKeys = [
    'RDK_SIM2REAL_CSP_DISABLE',
    'RDK_SIM2REAL_CSP_EXTRA_FRAME_SRC',
    'RDK_SIM2REAL_CSP_EXTRA_CONNECT_SRC',
    'RDK_SIM2REAL_MICRODUCK_URL',
    'RDK_SIM2REAL_MICRODUCK_ROOT',
    'RDK_SIM2REAL_ENABLE_HSTS',
    'RDK_SIM2REAL_HSTS_INCLUDE_SUBDOMAINS',
    'RDK_SIM2REAL_PUBLIC_BASE_PATH',
    'RDK_SIM2REAL_REQUIRE_MICRODUCK',
    'RDK_SIM2REAL_DEPLOYMENT',
    'RDK_SIM2REAL_AUTH_MODE',
  ];
  const savedEnv = new Map<string, string | undefined>();
  const securityServers: Array<ReturnType<Express['listen']>> = [];

  beforeEach(() => {
    for (const key of managedEnvKeys) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of managedEnvKeys) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    await Promise.all(
      securityServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function listenOn(app: Express): Promise<string> {
    const server = app.listen(0, '127.0.0.1');
    securityServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async function startHeaderApp(options: { trustProxy?: boolean } = {}): Promise<string> {
    const app = express();
    if (options.trustProxy) app.set('trust proxy', 1);
    app.use(studioSecurityHeadersMiddleware);
    app.get('/api/ping', (_request, response) => {
      response.json({ ok: true });
    });
    app.get('/mujoco', (_request, response) => {
      response.json({ ok: true });
    });
    app.get('/mujoco/{*splat}', (_request, response) => {
      response.json({ ok: true });
    });
    return listenOn(app);
  }

  it('sends the strict CSP with the documented baseline on every SPA response', async () => {
    const baseUrl = await startHeaderApp();
    const response = await fetch(`${baseUrl}/api/ping`);
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    // 'unsafe-inline' is intentionally limited to styles: the SPA builds
    // style="…" attributes through innerHTML templates.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("child-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    expect(response.headers.get('permissions-policy')).toContain('microphone=()');
    expect(response.headers.get('permissions-policy')).toContain('geolocation=()');
  });

  it('withholds HSTS from plain HTTP unless the operator opts in', async () => {
    const baseUrl = await startHeaderApp();
    expect(
      (await fetch(`${baseUrl}/api/ping`)).headers.get('strict-transport-security'),
    ).toBeNull();

    process.env.RDK_SIM2REAL_ENABLE_HSTS = '1';
    const forced = await fetch(`${baseUrl}/api/ping`);
    expect(forced.headers.get('strict-transport-security')).toBe('max-age=15552000');

    process.env.RDK_SIM2REAL_HSTS_INCLUDE_SUBDOMAINS = '1';
    const withSubdomains = await fetch(`${baseUrl}/api/ping`);
    expect(withSubdomains.headers.get('strict-transport-security')).toBe(
      'max-age=15552000; includeSubDomains',
    );
  });

  it('sends HSTS when the request arrived over TLS', async () => {
    const behindProxy = await startHeaderApp({ trustProxy: true });
    const forwarded = await fetch(`${behindProxy}/api/ping`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7' },
    });
    expect(forwarded.headers.get('strict-transport-security')).toBe('max-age=15552000');

    // Without `trust proxy`, the raw header is still a TLS hint (a browser
    // ignores HSTS on a plaintext response, so this cannot lock a host).
    const direct = await startHeaderApp();
    const hinted = await fetch(`${direct}/api/ping`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(hinted.headers.get('strict-transport-security')).toBe('max-age=15552000');
  });

  it('honours the CSP escape valve while keeping the other headers', async () => {
    process.env.RDK_SIM2REAL_CSP_DISABLE = '1';
    const baseUrl = await startHeaderApp();
    const response = await fetch(`${baseUrl}/api/ping`);
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('relaxes the CSP for the whole MicroDuck mount namespace only', async () => {
    const baseUrl = await startHeaderApp();
    for (const pathname of [
      '/mujoco',
      '/mujoco/microduck',
      '/mujoco/microduck/',
      '/mujoco/microduck/index.html',
      '/mujoco/microduck-proxy/bundle/duck.wasm',
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`);
      expect(response.headers.get('content-security-policy'), pathname).toBeNull();
      expect(response.headers.get('x-content-type-options'), pathname).toBe('nosniff');
      expect(response.headers.get('x-frame-options'), pathname).toBe('SAMEORIGIN');
    }
    expect(
      (await fetch(`${baseUrl}/api/ping`)).headers.get('content-security-policy'),
    ).not.toBeNull();
  });

  it('appends validated extra CSP origins and rejects wildcards and injections', async () => {
    process.env.RDK_SIM2REAL_CSP_EXTRA_FRAME_SRC =
      'https://sim.example.test, *, http://127.0.0.1:8080, https://bad.example.test;evil, javascript:alert(1)';
    process.env.RDK_SIM2REAL_CSP_EXTRA_CONNECT_SRC =
      'wss://ws.example.test, https://api.example.test/path';
    process.env.RDK_SIM2REAL_MICRODUCK_URL = 'https://microduck.example.test/entry';
    const baseUrl = await startHeaderApp();
    const csp = (await fetch(`${baseUrl}/api/ping`)).headers.get('content-security-policy') ?? '';

    expect(csp).toContain(
      "frame-src 'self' https://microduck.example.test https://sim.example.test http://127.0.0.1:8080",
    );
    expect(csp).toContain("connect-src 'self' wss://ws.example.test");
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('bad.example.test');
    expect(csp).not.toContain('javascript:');
    expect(csp).not.toContain('api.example.test');
    expect(csp).not.toMatch(/[\r\n]/);
  });

  it('ignores an invalid MicroDuck redirect origin in frame-src', async () => {
    process.env.RDK_SIM2REAL_MICRODUCK_URL = 'http://evil.example.test/microduck';
    const baseUrl = await startHeaderApp();
    const csp = (await fetch(`${baseUrl}/api/ping`)).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-src 'self'");
    expect(csp).not.toContain('evil.example.test');
  });

  it('relaxes the CSP on the real app mounts while keeping it on the SPA', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-headers-'));
    temporaryRoots.push(root);
    process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
    process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
    const baseUrl = await listenOn(createSim2RealWebApp());

    const spa = await fetch(`${baseUrl}/index.html`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(spa.headers.get('strict-transport-security')).toBeNull();

    const simulator = await fetch(`${baseUrl}/mujoco/microduck/`);
    expect(simulator.headers.get('content-security-policy')).toBeNull();
    expect(simulator.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('originbot dashboard asset extraction', () => {
  it('serves an external script and stylesheet instead of inline blocks', async () => {
    const publicRoot = path.join(process.cwd(), 'services/sim2real-web/public');
    const html = await fs.readFile(path.join(publicRoot, 'originbot-dashboard.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('src="./originbot-dashboard.js"');
    expect(html).not.toContain('<style>');
    expect(html).toContain('<link rel="stylesheet" href="./originbot-dashboard.css">');
    expect(html).not.toMatch(/\son(click|input|change|submit|load|error)\s*=/i);

    const script = await fs.readFile(path.join(publicRoot, 'originbot-dashboard.js'), 'utf8');
    const css = await fs.readFile(path.join(publicRoot, 'originbot-dashboard.css'), 'utf8');
    expect(script.trim().length).toBeGreaterThan(0);
    // The dashboard prefers the server-provided base-path meta tag, infers
    // its mount from the filename, and retains the legacy standalone fallback.
    expect(script).toContain('meta[name="rdk-sim2real-base-path"]');
    expect(script).toContain("pathName.endsWith('/originbot-dashboard.html')");
    expect(script).toContain("pathName.startsWith('/sim2real/')?'/sim2real':''");
    expect(script).toContain('tick();');
    expect(css.trim().length).toBeGreaterThan(0);
    expect(css).toContain('.grid{display:grid');

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const checked = await promisify(execFile)(
      process.execPath,
      ['--check', path.join(publicRoot, 'originbot-dashboard.js')],
      { cwd: process.cwd() },
    );
    expect(checked.stderr).toBe('');
  });
});
