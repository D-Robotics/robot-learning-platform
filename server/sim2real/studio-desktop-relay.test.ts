import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioDesktopRelayBroker, StudioDesktopRelayError } from './studio-desktop-relay.js';

const id = `studio-${'a'.repeat(24)}`;
const device = { id, name: 'Local X5', status: 'connected' as const };
const jsonReply = {
  ok: true as const,
  status: 200,
  body: '{"ready":true}',
  contentType: 'application/json',
};
let broker: StudioDesktopRelayBroker;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  broker = new StudioDesktopRelayBroker();
});
afterEach(() => {
  broker.closeAll();
  vi.useRealTimers();
});
function session(owner = 'alice', devices: unknown = [device]) {
  return broker.register(owner, devices);
}
async function delivered(owner = 'alice') {
  const s = session(owner);
  const result = broker.request(owner, id, { method: 'GET', path: '/healthz' }).catch((e) => e);
  const command = await broker.poll(owner, s.sessionId, s.sessionToken);
  return { s, result, command: command! };
}

describe('Studio desktop relay ownership and command lifecycle', () => {
  it('rejects every ASCII control in owner identity while retaining Unicode identities', () => {
    for (const code of [...Array(32).keys(), 127]) {
      expect(() => broker.register('alice' + String.fromCharCode(code) + 'test', [device])).toThrow(
        'DESKTOP_RELAY_INVALID_OWNER',
      );
    }
    expect(broker.register('机器人 alice@example.test', [device]).sessionId).toBeTruthy();
  });
  it('holds a request for its authenticated desktop poll and completes exactly once', async () => {
    const { s, command, result } = await delivered();
    expect(command).toMatchObject({
      deviceId: id,
      method: 'GET',
      path: '/healthz',
      deadlineAt: 1_015_000,
    });
    expect(command.requestId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(command)).not.toContain(s.sessionToken);
    broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply);
    expect(await result).toEqual(jsonReply);
    expect(() =>
      broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply),
    ).toThrow(StudioDesktopRelayError);
  });
  it('does not allow a session token or identical device id to cross owners', async () => {
    const a = session('alice');
    const b = session('bob');
    expect(a.sessionToken).not.toBe(b.sessionToken);
    await expect(broker.poll('bob', a.sessionId, a.sessionToken)).rejects.toMatchObject({
      status: 401,
    });
    const result = broker.request('alice', id, { method: 'GET', path: '/healthz' }).catch((e) => e);
    const cmd = (await broker.poll('alice', a.sessionId, a.sessionToken))!;
    expect(() =>
      broker.complete('bob', b.sessionId, b.sessionToken, cmd.requestId, jsonReply),
    ).toThrow(StudioDesktopRelayError);
    expect(() => broker.close('bob', a.sessionId, a.sessionToken)).toThrow(StudioDesktopRelayError);
    broker.complete('alice', a.sessionId, a.sessionToken, cmd.requestId, jsonReply);
    expect(await result).toEqual(jsonReply);
  });
  it('rejects guessed nonces, wrong tokens and unsolicited completion', async () => {
    const s = session();
    await expect(broker.poll('alice', s.sessionId, 'x'.repeat(43))).rejects.toMatchObject({
      status: 401,
    });
    expect(() =>
      broker.complete('alice', s.sessionId, s.sessionToken, 'guessed', jsonReply),
    ).toThrow();
  });
  it('long polls for at most five seconds and rejects simultaneous pending polls', async () => {
    const s = session();
    const first = broker.poll('alice', s.sessionId, s.sessionToken);
    await expect(broker.poll('alice', s.sessionId, s.sessionToken)).rejects.toMatchObject({
      status: 409,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBeNull();
    const next = broker.poll('alice', s.sessionId, s.sessionToken);
    const result = broker
      .request('alice', id, { method: 'GET', path: '/v1/config' })
      .catch((e) => e);
    const cmd = (await next)!;
    broker.complete('alice', s.sessionId, s.sessionToken, cmd.requestId, jsonReply);
    expect(await result).toEqual(jsonReply);
  });
  it('never redelivers a dispatched command on a second poll', async () => {
    const { s, result, command } = await delivered();
    const second = broker.poll('alice', s.sessionId, s.sessionToken);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await second).toBeNull();
    broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply);
    expect(await result).toEqual(jsonReply);
  });
  it('rejects late completion after timeout and clears queued work', async () => {
    const { s, result, command } = await delivered();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ code: 'DESKTOP_RELAY_TIMEOUT', status: 504 });
    expect(() =>
      broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply),
    ).toThrow();
  });
  it('cancels request on abort without making it available to the next poll', async () => {
    const s = session();
    const cancel = new AbortController();
    const result = broker
      .request('alice', id, { method: 'GET', path: '/healthz' }, { signal: cancel.signal })
      .catch((e) => e);
    cancel.abort();
    expect(await result).toMatchObject({ code: 'DESKTOP_RELAY_ABORTED' });
    const poll = broker.poll('alice', s.sessionId, s.sessionToken);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await poll).toBeNull();
  });
  it('aborts a waiting poll and allows a fresh poll', async () => {
    const s = session();
    const cancel = new AbortController();
    const poll = broker.poll('alice', s.sessionId, s.sessionToken, cancel.signal).catch((e) => e);
    cancel.abort();
    expect(await poll).toMatchObject({ code: 'DESKTOP_RELAY_ABORTED' });
    const next = broker.poll('alice', s.sessionId, s.sessionToken);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await next).toBeNull();
  });
  it('revokes in-flight work when session closes', async () => {
    const { s, result, command } = await delivered();
    broker.close('alice', s.sessionId, s.sessionToken);
    expect(await result).toMatchObject({ code: 'DESKTOP_RELAY_SESSION_CLOSED' });
    expect(() =>
      broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply),
    ).toThrow();
    expect(broker.devices('alice')).toEqual([]);
  });
  it('expires disconnected desktops even when cloud keeps reading their catalog', async () => {
    const s = session();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(broker.has('alice', id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(broker.has('alice', id)).toBe(false);
    await expect(broker.poll('alice', s.sessionId, s.sessionToken)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('renews sliding TTL on authenticated polling but never exceeds absolute lifetime', async () => {
    broker.closeAll();
    broker = new StudioDesktopRelayBroker({
      sessionTtlMs: 30,
      maxSessionAgeMs: 80,
      pollTimeoutMs: 5,
    });
    const s = session();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20);
      const poll = broker.poll('alice', s.sessionId, s.sessionToken);
      await vi.advanceTimersByTimeAsync(5);
      expect(await poll).toBeNull();
    }
    await vi.advanceTimersByTimeAsync(5);
    expect(broker.devices('alice')).toEqual([]);
  });
  it('chooses newest active connected session for duplicate device without cross-owner fallback', async () => {
    const old = session();
    await vi.advanceTimersByTimeAsync(1);
    const fresh = session();
    session('bob');
    const result = broker.request('alice', id, { method: 'GET', path: '/healthz' }).catch((e) => e);
    const cmd = (await broker.poll('alice', fresh.sessionId, fresh.sessionToken))!;
    broker.close('alice', fresh.sessionId, fresh.sessionToken);
    expect(await result).toMatchObject({ code: 'DESKTOP_RELAY_SESSION_CLOSED' });
    expect(() =>
      broker.complete('alice', old.sessionId, old.sessionToken, cmd.requestId, jsonReply),
    ).toThrow();
    broker.close('alice', old.sessionId, old.sessionToken);
    expect(broker.has('alice', id)).toBe(false);
    expect(broker.has('bob', id)).toBe(true);
  });
});

describe('relay protocol bounds and private device projection', () => {
  it('rejects secret/host fields, duplicate ids, malformed descriptors and oversized names', () => {
    for (const devices of [
      [{ ...device, host: '127.0.0.1' }],
      [{ ...device, password: 'secret' }],
      [device, device],
      [{ ...device, id: 'http://host' }],
      [{ ...device, name: 'x'.repeat(121) }],
      [{ ...device, status: 'online' }],
      [{ ...device, status: { toString: () => 'connected', secret: 'do-not-retain' } }],
      {},
    ])
      expect(() => session('alice', devices)).toThrow(StudioDesktopRelayError);
  });
  it('does not retain caller object references or expose tokens in device descriptors', () => {
    const input = { ...device };
    const s = session('alice', [input]);
    input.name = 'changed';
    const list = broker.devices('alice');
    list[0].name = 'also changed';
    expect(broker.devices('alice')).toEqual([device]);
    expect(JSON.stringify(broker.devices('alice'))).not.toContain(s.sessionToken);
  });
  it('ignores disconnected replacements and falls back to the remaining connected session', async () => {
    session();
    session('alice', [{ ...device, status: 'disconnected' }]);
    expect(broker.devices('alice')).toEqual([device]);
    expect(broker.has('alice', id)).toBe(true);
  });
  it('enforces owner/global session, device and outstanding request quotas', async () => {
    broker.closeAll();
    broker = new StudioDesktopRelayBroker({
      maxSessionsPerOwner: 1,
      maxSessions: 2,
      maxDevicesPerSession: 1,
      maxPendingPerSession: 1,
      maxPending: 1,
    });
    session();
    expect(() => session()).toThrow();
    session('bob');
    expect(() => session('charlie')).toThrow();
    const pending = broker
      .request('alice', id, { method: 'GET', path: '/healthz' })
      .catch((e) => e);
    await expect(
      broker.request('alice', id, { method: 'GET', path: '/healthz' }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      broker.request('bob', id, { method: 'GET', path: '/healthz' }),
    ).rejects.toMatchObject({ status: 429 });
    broker.closeAll();
    expect(await pending).toBeInstanceOf(StudioDesktopRelayError);
    expect(() =>
      session('alice', [device, { ...device, id: `studio-${'b'.repeat(24)}` }]),
    ).toThrow();
  });
  it('rejects arbitrary paths, methods, host injection, malformed tokens and non-JSON body', async () => {
    session();
    for (const input of [
      { method: 'GET', path: 'http://evil/healthz' },
      { method: 'GET', path: '/healthz?host=evil' },
      { method: 'POST', path: '/exec', body: '{}' },
      { method: 'DELETE', path: '/v1/config' },
      { method: 'GET', path: '/v1/station/policy', body: '{}' },
      { method: 'GET', path: '/healthz', host: 'evil' },
      { method: 'POST', path: '/v1/station/commands', body: 'not json' },
      { method: 'GET', path: '/healthz', agentToken: 'secret\r\n' },
    ])
      await expect(broker.request('alice', id, input as never)).rejects.toBeInstanceOf(
        StudioDesktopRelayError,
      );
  });
  it('accepts the fixed native whitelist including device commands and caps bodies', async () => {
    const s = session();
    for (const [method, path] of [
      ['GET', '/v1/onboarding/preflight'],
      ['POST', '/v1/devices/servo_1/commands'],
      ['POST', '/v1/station/policy-infer'],
      ['POST', '/v1/station/policy/upload'],
    ] as const) {
      const result = broker
        .request('alice', id, { method, path, ...(method === 'POST' ? { body: '{}' } : {}) })
        .catch((e) => e);
      const command = (await broker.poll('alice', s.sessionId, s.sessionToken))!;
      broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply);
      expect(await result).toEqual(jsonReply);
    }
    await expect(
      broker.request('alice', id, {
        method: 'POST',
        path: '/v1/station/commands',
        body: JSON.stringify('x'.repeat(1024 * 1024)),
      }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      broker.request('alice', id, {
        method: 'POST',
        path: '/v1/station/policy/upload',
        body: JSON.stringify('x'.repeat(2 * 1024 * 1024)),
      }),
    ).rejects.toMatchObject({ status: 413 });
  });
  it('checks reply schema/size/base64 before consuming a pending request', async () => {
    const { s, command, result } = await delivered();
    for (const reply of [
      { ...jsonReply, ok: false },
      { ...jsonReply, status: 999 },
      { ...jsonReply, headers: { cookie: 'secret' } },
      { ...jsonReply, body: 'not json' },
      { ...jsonReply, contentType: 'text/html' },
      { ...jsonReply, body: JSON.stringify('x'.repeat(1024 * 1024)) },
      { ok: true, status: 200, contentType: 'image/jpeg', bodyBase64: 'YQ===' },
      {
        ok: true,
        status: 200,
        contentType: 'image/jpeg',
        bodyBase64: Buffer.alloc(180 * 1024 + 1).toString('base64'),
      },
    ])
      expect(() =>
        broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, reply),
      ).toThrow(StudioDesktopRelayError);
    broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply);
    expect(await result).toEqual(jsonReply);
  });
  it('accepts a bounded JPEG only for the snapshot request', async () => {
    const s = session();
    const reply = {
      ok: true as const,
      status: 200,
      contentType: 'image/jpeg' as const,
      bodyBase64: Buffer.from([255, 216, 255, 217]).toString('base64'),
    };
    const result = broker
      .request('alice', id, { method: 'GET', path: '/v1/station/camera.snapshot' })
      .catch((e) => e);
    const cmd = (await broker.poll('alice', s.sessionId, s.sessionToken))!;
    broker.complete('alice', s.sessionId, s.sessionToken, cmd.requestId, reply);
    expect(await result).toEqual(reply);
  });
});

describe('clock and cleanup races', () => {
  it('does not dispatch deadline-expired work when its timer callback has been delayed', async () => {
    broker.closeAll();
    let now = 1000;
    broker = new StudioDesktopRelayBroker({ now: () => now });
    const s = session();
    const result = broker
      .request('alice', id, { method: 'GET', path: '/healthz' }, { timeoutMs: 100 })
      .catch((e) => e);
    now += 101;
    const poll = broker.poll('alice', s.sessionId, s.sessionToken);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await poll).toBeNull();
    expect(await result).toMatchObject({ code: 'DESKTOP_RELAY_TIMEOUT' });
  });
  it('does not renew session TTL when an expiry timer fires before the injected clock', async () => {
    broker.closeAll();
    let now = 1000;
    broker = new StudioDesktopRelayBroker({ now: () => now, sessionTtlMs: 100 });
    session();
    now = 1099;
    await vi.advanceTimersByTimeAsync(100);
    now = 1100;
    expect(broker.has('alice', id)).toBe(false);
  });
  it('revokes an outstanding poll and request on absolute session expiry', async () => {
    broker.closeAll();
    broker = new StudioDesktopRelayBroker({
      sessionTtlMs: 20,
      maxSessionAgeMs: 20,
      pollTimeoutMs: 50,
    });
    const { s, result, command } = await delivered();
    const poll = broker.poll('alice', s.sessionId, s.sessionToken).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ code: 'DESKTOP_RELAY_SESSION_EXPIRED' });
    expect(await poll).toMatchObject({ code: 'DESKTOP_RELAY_SESSION_EXPIRED' });
    expect(() =>
      broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply),
    ).toThrow();
  });
});

describe('read-only relay lease observation', () => {
  it('returns the current deadline without extending an idle session', async () => {
    const s = session();
    expect(broker.lease('alice', s.sessionId, s.sessionToken)).toEqual({ expiresAt: s.expiresAt });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(broker.lease('alice', s.sessionId, s.sessionToken)).toEqual({ expiresAt: s.expiresAt });
    await vi.advanceTimersByTimeAsync(1);
    expect(() => broker.lease('alice', s.sessionId, s.sessionToken)).toThrow(
      StudioDesktopRelayError,
    );
  });
  it('rejects a foreign owner, wrong token and unknown session', () => {
    const s = session();
    for (const [owner, id, token] of [
      ['bob', s.sessionId, s.sessionToken],
      ['alice', s.sessionId, 'x'.repeat(43)],
      ['alice', 'unknown', s.sessionToken],
    ])
      expect(() => broker.lease(owner, id, token)).toThrow(StudioDesktopRelayError);
    expect(broker.lease('alice', s.sessionId, s.sessionToken)).toEqual({ expiresAt: s.expiresAt });
  });
  it('reports actual poll and completion renewal rather than the initial registration expiry', async () => {
    const s = session();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = broker.request('alice', id, { method: 'GET', path: '/healthz' }).catch((e) => e);
    const command = (await broker.poll('alice', s.sessionId, s.sessionToken))!;
    expect(broker.lease('alice', s.sessionId, s.sessionToken)).toEqual({ expiresAt: 1_040_000 });
    await vi.advanceTimersByTimeAsync(2000);
    broker.complete('alice', s.sessionId, s.sessionToken, command.requestId, jsonReply);
    expect(await result).toEqual(jsonReply);
    expect(broker.lease('alice', s.sessionId, s.sessionToken)).toEqual({ expiresAt: 1_042_000 });
  });
  it('never extends the default thirty-minute absolute lifetime', async () => {
    broker.closeAll();
    broker = new StudioDesktopRelayBroker({ sessionTtlMs: 20 * 60_000 });
    const s = session();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const first = broker.poll('alice', s.sessionId, s.sessionToken);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBeNull();
    expect(broker.lease('alice', s.sessionId, s.sessionToken)).toEqual({ expiresAt: 2_800_000 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const second = broker.poll('alice', s.sessionId, s.sessionToken);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await second).toBeNull();
    expect(broker.lease('alice', s.sessionId, s.sessionToken)).toEqual({ expiresAt: 2_800_000 });
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 10_000);
    expect(() => broker.lease('alice', s.sessionId, s.sessionToken)).toThrow(
      StudioDesktopRelayError,
    );
  });
});
