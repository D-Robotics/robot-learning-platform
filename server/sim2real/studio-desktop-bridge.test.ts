import { describe, expect, it, vi } from 'vitest';
import { StudioDesktopBridge } from './studio-desktop-bridge.js';

const device = {
  id: 'board-1',
  name: 'Saved board',
  host: '192.0.2.5',
  port: 22,
  username: 'robot',
  status: 'connected',
  platform: 'rdk-x5',
  password: 'never-project',
  privateKey: 'never-project',
};
function fixture() {
  const state = { allowed: true, origin: 'http://127.0.0.1:8789' };
  const fetchImpl = vi.fn(async () => Response.json({ ok: true, devices: [device] }));
  const bridge = new StudioDesktopBridge({
    origin: () => state.origin,
    allowed: () => state.allowed,
    fetchImpl,
  });
  return { bridge, state, fetchImpl };
}
describe('desktop Studio device capability', () => {
  it('needs an authenticated host and never probes when no token is available', async () => {
    const { bridge, fetchImpl } = fixture();
    expect((await bridge.catalog()).state).toBe('awaiting-host');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('projects only metadata and permits subsequent UI reads with an in-memory lease', async () => {
    const { bridge, fetchImpl } = fixture();
    const first = await bridge.runWithToken('native-token', () => bridge.catalog());
    expect(first.state).toBe('ready');
    expect(first.devices[0]).toMatchObject({
      status: 'connected',
      source: 'studio-desktop',
      bridgeDeviceId: 'board-1',
      bridgeOwnerKey: 'local:default',
    });
    expect(first.devices[0]?.id).toMatch(/^studio-[a-f0-9]{24}$/);
    expect(JSON.stringify(first)).not.toContain('never-project');
    expect(JSON.stringify(first)).not.toContain('native-token');
    expect((await bridge.catalog()).devices[0]?.id).toBe(first.devices[0]?.id);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { 'x-rdk-desktop-host-token': 'native-token', 'x-rdk-client': 'electron' },
    });
  });
  it.each([
    'https://studio.example.test',
    'http://127.0.0.1:8789/proxy',
    'http://user@127.0.0.1:8789',
    'http://127.0.0.1:8789?x=1',
    'http://127.0.0.1:8789\n',
  ])('rejects unsafe Studio origin %j', async (origin) => {
    const { bridge, state, fetchImpl } = fixture();
    state.origin = origin;
    expect((await bridge.runWithToken('native-token', () => bridge.catalog())).state).toBe(
      'unconfigured',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('disables the desktop lease in shared/authenticated deployments', async () => {
    const { bridge, state, fetchImpl } = fixture();
    await bridge.runWithToken('native-token', () => bridge.catalog());
    state.allowed = false;
    expect((await bridge.catalog()).state).toBe('unconfigured');
    state.allowed = true;
    expect((await bridge.catalog()).state).toBe('awaiting-host');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('a malformed supplied token cannot inherit a cached capability', async () => {
    const { bridge, fetchImpl } = fixture();
    await bridge.runWithToken('native-token', () => bridge.catalog());
    expect((await bridge.runWithToken('bad\r\nvalue', () => bridge.catalog())).state).toBe(
      'awaiting-host',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    [403, 'STUDIO_DESKTOP_AUTH_REQUIRED'],
    [404, 'STUDIO_DESKTOP_UPGRADE_REQUIRED'],
    [503, 'STUDIO_DESKTOP_UNAVAILABLE'],
  ])('reports status %s without pretending an empty ready catalog', async (status, code) => {
    const { bridge, fetchImpl } = fixture();
    await bridge.runWithToken('native-token', () => bridge.catalog());
    fetchImpl.mockImplementation(
      async () => new Response('secret upstream diagnostic', { status: Number(status) }),
    );
    const result = await bridge.catalog();
    expect(result).toEqual({ state: 'unavailable', devices: [], code });
    expect(await bridge.catalog()).toEqual(result);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ok: false, devices: [] },
    { ok: true, devices: [device, device] },
    { ok: true, devices: [{ ...device, port: 0 }] },
    { ok: true, devices: [{ ...device, status: 'healthy' }] },
    { ok: true, devices: [{ ...device, id: '../bad' }] },
  ])('fails closed on malformed host catalog', async (payload) => {
    const { bridge, fetchImpl } = fixture();
    fetchImpl.mockImplementation(async () => Response.json(payload));
    expect((await bridge.runWithToken('native-token', () => bridge.catalog())).state).toBe(
      'unavailable',
    );
    expect((await bridge.catalog()).state).toBe('awaiting-host');
  });
  it('bounds streamed response bytes and does not leak transport errors', async () => {
    const { bridge, fetchImpl } = fixture();
    fetchImpl.mockImplementation(async () => new Response('x'.repeat(1024 * 1024 + 1)));
    expect((await bridge.runWithToken('native-token', () => bridge.catalog())).code).toBe(
      'STUDIO_DESKTOP_UNAVAILABLE',
    );
    fetchImpl.mockImplementation(async () => {
      throw Error('native-token SECRET');
    });
    expect(
      JSON.stringify(await bridge.runWithToken('native-token', () => bridge.catalog())),
    ).not.toMatch(/SECRET|native-token/);
  });
  it('does not bind a result if deployment changes while the host request is pending', async () => {
    const { bridge, state, fetchImpl } = fixture();
    fetchImpl.mockImplementation(async () => {
      state.allowed = false;
      return Response.json({ ok: true, devices: [device] });
    });
    expect((await bridge.runWithToken('native-token', () => bridge.catalog())).state).toBe(
      'unconfigured',
    );
  });
  it('preserves agent refusal status and uses the selected Studio device without shell execution', async () => {
    const { bridge, fetchImpl } = fixture();
    const catalog = await bridge.runWithToken('native-token', () => bridge.catalog());
    fetchImpl.mockImplementation(async (url) =>
      String(url).endsWith('/devices')
        ? Response.json({ ok: true, devices: [device] })
        : Response.json({
            ok: true,
            status: 409,
            body: '{"ok":false,"error":"POLICY_DISABLED"}',
            contentType: 'application/json',
          }),
    );
    const result = await bridge.agent(catalog.devices[0]!.id, '/v1/station/policy/start', {
      method: 'POST',
      body: '{}',
    });
    expect(result).toEqual({
      ok: false,
      status: 409,
      payload: { ok: false, error: 'POLICY_DISABLED' },
    });
    const body = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body));
    expect(body).toMatchObject({
      deviceId: 'board-1',
      method: 'POST',
      path: '/v1/station/policy/start',
    });
    expect(body).not.toHaveProperty('command');
  });
  it.each([
    '/exec',
    '/v1/config',
    'http://evil.test',
    '/v1/station/status?x=1',
    '/v1/devices/../commands',
  ])('does not forward unsupported POST %s', async (pathname) => {
    const { bridge, fetchImpl } = fixture();
    const catalog = await bridge.runWithToken('native-token', () => bridge.catalog());
    fetchImpl.mockClear();
    expect(
      await bridge.agent(catalog.devices[0]!.id, pathname, { method: 'POST', body: '{}' }),
    ).toBeNull();
    expect(fetchImpl.mock.calls.every((row) => String(row[0]).endsWith('/devices'))).toBe(true);
  });
});

it('transmits a real-sized policy JSON, bounds uploads, and validates finite JPEG snapshots', async () => {
  const { bridge, fetchImpl } = fixture();
  const catalog = await bridge.runWithToken('native-token', () => bridge.catalog());
  const id = catalog.devices[0]!.id;
  const onnx = Buffer.alloc(793905, 7).toString('base64');
  const upload = JSON.stringify({ filename: 'policy.onnx', dataBase64: onnx });
  fetchImpl.mockImplementation(async (url) =>
    String(url).endsWith('/devices')
      ? Response.json({ ok: true, devices: [device] })
      : Response.json({
          ok: true,
          status: 200,
          contentType: 'application/json',
          body: '{"ok":true}',
        }),
  );
  expect(
    (await bridge.agent(id, '/v1/station/policy/upload', { method: 'POST', body: upload }))?.ok,
  ).toBe(true);
  expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body)).body).toBe(upload);
  fetchImpl.mockClear();
  expect(
    await bridge.agent(id, '/v1/station/policy/upload', {
      method: 'POST',
      body: 'x'.repeat(2 * 1024 * 1024 + 1),
    }),
  ).toMatchObject({
    ok: false,
    status: 413,
    payload: { error: 'SIM2REAL_STUDIO_UPLOAD_TOO_LARGE', retryable: false },
  });
  expect(fetchImpl.mock.calls.every((row) => String(row[0]).endsWith('/devices'))).toBe(true);
  for (const frame of [
    Buffer.from([255, 216, 7, 255, 217]),
    Buffer.from('not-a-jpeg'),
    Buffer.alloc(180 * 1024 + 1),
  ]) {
    fetchImpl.mockImplementation(async (url) =>
      String(url).endsWith('/devices')
        ? Response.json({ ok: true, devices: [device] })
        : Response.json({
            ok: true,
            status: 200,
            contentType: 'image/jpeg',
            bodyBase64: frame.toString('base64'),
          }),
    );
    const actual = await bridge.snapshot(id);
    if (frame.length === 5) expect(Buffer.from(actual!)).toEqual(frame);
    else expect(actual).toBeNull();
  }
});

it.each([
  [409, 'learning-board-no-session', 'SIM2REAL_STUDIO_SSH_SESSION_NOT_READY', '无需重新填写密码'],
  [413, 'learning-board-too-large', 'SIM2REAL_STUDIO_UPLOAD_TOO_LARGE', '2 MiB'],
  [403, 'learning-desktop-forbidden', 'SIM2REAL_STUDIO_PLUGIN_NOT_CONNECTED', '插件'],
  [404, 'learning-board-device-not-found', 'SIM2REAL_STUDIO_DEVICE_NOT_FOUND', '目标设备'],
  [502, 'learning-board-unavailable', 'SIM2REAL_STUDIO_BOARD_AGENT_UNREACHABLE', '板端'],
  [504, 'learning-board-timeout', 'SIM2REAL_STUDIO_BOARD_AGENT_TIMEOUT', '超时'],
  [409, 'unexpected-secret-token', 'SIM2REAL_STUDIO_DEVICE_BRIDGE_UNAVAILABLE', '重试'],
])(
  'preserves safe actionable host failure %s without upstream diagnostic leakage',
  async (status, hostCode, code, message) => {
    const { bridge, fetchImpl } = fixture();
    const catalog = await bridge.runWithToken('native-token', () => bridge.catalog());
    fetchImpl.mockImplementation(async (url) =>
      String(url).endsWith('/devices')
        ? Response.json({ ok: true, devices: [device] })
        : Response.json(
            { ok: false, error: hostCode, message: 'SECRET http://user:password@private.invalid' },
            { status: Number(status) },
          ),
    );
    const result = await bridge.agent(catalog.devices[0]!.id, '/healthz');
    expect(result).toMatchObject({
      ok: false,
      status: Number(status),
      payload: { ok: false, error: code, retryable: status !== 413 && status !== 404 },
    });
    expect(result?.payload.message).toContain(message);
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|password|private.invalid|unexpected-secret-token|native-token/,
    );
  },
);
it('maps malformed or oversized host errors without leaking or discarding the transport status', async () => {
  const { bridge, fetchImpl } = fixture();
  const catalog = await bridge.runWithToken('native-token', () => bridge.catalog());
  for (const body of ['SECRET not-json', 'SECRET'.repeat(200000)]) {
    fetchImpl.mockImplementation(async (url) =>
      String(url).endsWith('/devices')
        ? Response.json({ ok: true, devices: [device] })
        : new Response(body, { status: 502 }),
    );
    expect(await bridge.agent(catalog.devices[0]!.id, '/healthz')).toMatchObject({
      ok: false,
      status: 502,
      payload: { error: 'SIM2REAL_STUDIO_BOARD_AGENT_UNREACHABLE' },
    });
  }
});

it('an oversized upload cannot bypass a different target or invalid token', async () => {
  const { bridge, fetchImpl } = fixture();
  const catalog = await bridge.runWithToken('native-token', () => bridge.catalog());
  const body = 'x'.repeat(2 * 1024 * 1024 + 1);
  fetchImpl.mockClear();
  expect(
    await bridge.agent('studio-000000000000000000000000', '/v1/station/policy/upload', {
      method: 'POST',
      body,
    }),
  ).toBeNull();
  expect(
    await bridge.agent(catalog.devices[0]!.id, '/v1/station/policy/upload', {
      method: 'POST',
      body,
      agentToken: 'bad\r\nvalue',
    }),
  ).toBeNull();
  expect(fetchImpl.mock.calls.every((row) => String(row[0]).endsWith('/devices'))).toBe(true);
});

it('keeps configured origin distinct from a verified in-memory host lease', async () => {
  const { bridge, fetchImpl, state } = fixture();
  expect(bridge.configured()).toBe(true);
  expect(bridge.hasVerifiedLease()).toBe(false);
  expect((await bridge.catalog()).state).toBe('awaiting-host');
  await bridge.runWithToken('native-token', async () => {
    expect(bridge.hasVerifiedLease()).toBe(false);
    await bridge.catalog();
    expect(bridge.hasVerifiedLease()).toBe(true);
  });
  expect(bridge.hasVerifiedLease()).toBe(true);
  expect(bridge.runWithToken('unverified-token', () => bridge.hasVerifiedLease())).toBe(false);
  expect(bridge.runWithToken('bad\r\ntoken', () => bridge.hasVerifiedLease())).toBe(false);
  fetchImpl.mockImplementation(async () => Response.json({ ok: false }, { status: 403 }));
  await bridge.catalog();
  expect(bridge.hasVerifiedLease()).toBe(false);
  state.origin = 'http://127.0.0.1:9798';
  expect(bridge.hasVerifiedLease()).toBe(false);
});
