import { afterEach, expect, it, vi } from 'vitest';
import { studioDeviceSessionId } from './studio-device-session.js';

const device = {
  id: 'platform-board',
  connectionMode: 'bridge' as const,
  bridgeId: 'bridge-one',
  bridgeDeviceId: 'ssh:robot@edge.example:22',
  studioDeviceId: 'other-session-native-id',
  host: 'edge.example',
  port: 22,
  username: 'robot',
};
const cookie = 'rdk_sso_web_session=account; rdk_studio_devices=signed-session';
afterEach(() => vi.restoreAllMocks());

it('uses the verified native registration for this session and the same bridge target', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://studio.example/api/devices');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('cookie')).toBe(cookie);
    return Response.json({
      devices: [{ ...device, id: 'current-session-native-id', status: 'connected' }],
    });
  });
  expect(await studioDeviceSessionId(device, 'https://studio.example', cookie)).toBe(
    'current-session-native-id',
  );
});

it.each([
  { host: 'different.example' },
  { bridgeId: 'different-bridge' },
  { bridgeDeviceId: 'different-device' },
  { status: 'offline' },
  { username: 'another-user' },
  { port: 23 },
])('rejects another board or an unverified record without falling back %j', async (change) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ devices: [{ ...device, status: 'connected', ...change }] }),
  );
  expect(await studioDeviceSessionId(device, 'https://studio.example', cookie)).toBeNull();
});

it('keeps legacy clients and native desktop relay transport unchanged', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  expect(await studioDeviceSessionId(device, null, 'rdk_sso_web_session=account')).toBe(
    device.studioDeviceId,
  );
  expect(
    await studioDeviceSessionId({ ...device, bridgeId: 'studio-desktop-relay' }, null, cookie),
  ).toBe(device.studioDeviceId);
  expect(fetch).not.toHaveBeenCalled();
});

it('refuses ambiguous devices and upstream rejection', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      devices: [
        { ...device, id: 'one', status: 'connected' },
        { ...device, id: 'two', status: 'connected' },
      ],
    }),
  );
  expect(await studioDeviceSessionId(device, 'https://studio.example', cookie)).toBeNull();
  fetch.mockResolvedValue(new Response(null, { status: 403 }));
  expect(await studioDeviceSessionId(device, 'https://studio.example', cookie)).toBeNull();
});
