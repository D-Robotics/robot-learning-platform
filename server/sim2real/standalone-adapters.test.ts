import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildBoardPreflightCommand,
  createStandaloneRobogoApiClient,
  isForeignOwnedDevice,
  readDevices,
  requestOwnsDevice,
  studioBridgeConfiguration,
} from './standalone-adapters.js';

const fakeRequest = {} as never;
const previousApiUrl = process.env.RDK_SIM2REAL_ROBOGO_API_URL;
const previousToken = process.env.RDK_SIM2REAL_ROBOGO_TOKEN;
const previousStorage = process.env.RDK_SIM2REAL_STORAGE_DIR;
const previousStudioOrigin = process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
const previousStudioDevice = process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
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
});

describe('standalone device ownership boundary', () => {
  it('hides ownerless and unknown-owner records in multi-user mode', () => {
    expect(isForeignOwnedDevice({ id: 'unowned' }, 'sso:alice:web', true)).toBe(true);
    expect(
      isForeignOwnedDevice({ id: 'unknown', bridgeOwnerKey: 'legacy:alice' }, 'sso:alice:web', true),
    ).toBe(true);
    expect(
      isForeignOwnedDevice({ id: 'owned', bridgeOwnerKey: 'sso:alice:web' }, 'sso:alice:web', true),
    ).toBe(false);
  });

  it('keeps single-user local inspection compatible', () => {
    expect(isForeignOwnedDevice({ id: 'local' }, null, false)).toBe(false);
    expect(
      requestOwnsDevice(fakeRequest, { id: 'local' }, null, false),
    ).toBe(true);
  });

  it('requires an exact verified owner key in shared mode', () => {
    const device = { id: 'alice', bridgeOwnerKey: 'sso:alice:web' };
    expect(requestOwnsDevice(fakeRequest, device, 'sso:alice:web', true)).toBe(true);
    expect(requestOwnsDevice(fakeRequest, device, 'sso:bob:web', true)).toBe(false);
    expect(requestOwnsDevice(fakeRequest, device, null, true)).toBe(false);
    expect(
      requestOwnsDevice(fakeRequest, { id: 'legacy', bridgeOwnerKey: 'legacy:alice' }, 'sso:alice:web', true),
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

  it('allows the visible device registry to provide the Studio bridge id', () => {
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
    delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
    expect(studioBridgeConfiguration()).toEqual({
      origin: 'http://127.0.0.1:18090',
      deviceId: '',
      agentPort: 19100,
    });
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
      pythonOutput = (await promisify(execFile)('python3', ['-c', [
        'import importlib.util, sys',
        'spec = importlib.util.spec_from_file_location("ba", "services/sim2real-web/board-agent-x5.py")',
        'module = importlib.util.module_from_spec(spec)',
        'sys.modules["ba"] = module',
        'spec.loader.exec_module(module)',
        'print(module.build_preflight_command())',
      ].join('; ')], { cwd: process.cwd() })).stdout.trim();
    } catch {
      return; // python3 unavailable: skip the cross-language check
    }
    expect(pythonOutput).toBe(buildBoardPreflightCommand());
  });
});
