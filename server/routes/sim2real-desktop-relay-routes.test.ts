import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSim2RealDesktopRelayRoutes } from './sim2real-desktop-relay-routes.js';
import { StudioDesktopRelayBroker } from '../sim2real/studio-desktop-relay.js';
import type { Sim2RealPrincipal } from '../sim2real/sim2real-auth.js';

const device = { id: 'studio-' + 'a'.repeat(24), name: 'Fixture X5', status: 'connected' };
const fixtures: Array<{ server: Server; broker: StudioDesktopRelayBroker }> = [];
afterEach(async () => {
  for (const { server, broker } of fixtures.splice(0)) {
    broker.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture() {
  const broker = new StudioDesktopRelayBroker();
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  const router = express.Router();
  const principal = (request: Request): Sim2RealPrincipal | null => {
    const accountId = request.get('x-test-account');
    return accountId ? { accountId, roles: [request.get('x-test-role') ?? 'operator'] } : null;
  };
  registerSim2RealDesktopRelayRoutes(
    router,
    {
      auth: {
        isMultiUserDeployment: () => true,
        resolvePrincipal: principal,
        resolveAccessToken: () => null,
      },
      requestOwner: (request: Request, _response: Response) => principal(request)?.accountId,
      broker,
    },
    { prefix: '/api/v1/duck' },
  );
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  fixtures.push({ server, broker });
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const call = (path: string, init: RequestInit = {}, account = 'alice', role = 'operator') =>
    fetch(origin + '/api/v1/duck/desktop-relay/sessions' + path, {
      ...init,
      headers: {
        ...(account ? { 'x-test-account': account } : {}),
        'x-test-role': role,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
  const register = async () => {
    const response = await call('', {
      method: 'POST',
      body: JSON.stringify({ devices: [device] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return response.json();
  };
  const capabilities = (account = 'alice', role = 'operator') =>
    fetch(origin + '/api/v1/duck/desktop-relay/capabilities', {
      headers: { ...(account ? { 'x-test-account': account } : {}), 'x-test-role': role },
    });
  return { broker, call, register, capabilities };
}
describe('cloud desktop relay HTTP authority (isolated fixture)', () => {
  it('advertises the transport protocol only to an admitted connector account', async () => {
    const { capabilities, broker } = await fixture();
    expect((await capabilities('')).status).toBe(401);
    expect((await capabilities('alice', 'viewer')).status).toBe(403);
    const response = await capabilities();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, protocolVersion: 1 });
    expect(broker.devices('alice')).toEqual([]);
  });
  it('requires an authenticated operator to enroll a command-capable connector', async () => {
    const { call, broker } = await fixture();
    const init = { method: 'POST', body: JSON.stringify({ devices: [device] }) };
    expect((await call('', init, '')).status).toBe(401);
    expect((await call('', init, 'alice', 'viewer')).status).toBe(403);
    expect((await call('', init, 'alice', 'unknown')).status).toBe(403);
    expect(broker.devices('alice')).toEqual([]);
  });
  it('rejects body-supplied owner and arbitrary connection credentials', async () => {
    const { call, broker } = await fixture();
    expect(
      (
        await call('', {
          method: 'POST',
          body: JSON.stringify({ devices: [device], owner: 'bob' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('', {
          method: 'POST',
          body: JSON.stringify({
            devices: [{ ...device, host: '192.0.2.1', password: 'fixture-not-a-secret' }],
          }),
        })
      ).status,
    ).toBe(400);
    expect(broker.devices('alice')).toEqual([]);
    expect(broker.devices('bob')).toEqual([]);
  });
  it('keeps session tokens scoped to their authenticated owner', async () => {
    const { call, register } = await fixture();
    const lease = await register();
    const headers = { 'x-rdk-desktop-relay-token': lease.sessionToken };
    expect((await call('/' + lease.sessionId + '/commands', { headers }, 'bob')).status).toBe(403);
    expect((await call('/' + lease.sessionId, { method: 'DELETE', headers }, 'bob')).status).toBe(
      403,
    );
    expect((await call('/' + lease.sessionId + '/commands')).status).toBe(403);
    expect((await call('/' + lease.sessionId, { method: 'DELETE', headers })).status).toBe(200);
  });
  it('only delivers commands enqueued by the platform and accepts each matching reply once', async () => {
    const { call, register, broker } = await fixture();
    const lease = await register();
    const headers = { 'x-rdk-desktop-relay-token': lease.sessionToken };
    expect(
      (
        await call('/' + lease.sessionId + '/commands', {
          method: 'POST',
          headers,
          body: JSON.stringify({ method: 'POST', path: '/v1/station/policy/start' }),
        })
      ).status,
    ).toBe(404);
    const pending = broker.request('alice', device.id, { method: 'GET', path: '/healthz' });
    // Cleanup can revoke the request after a failed assertion; observe that
    // rejection immediately without changing the success assertion below.
    void pending.catch(() => {});
    const polled = await call('/' + lease.sessionId + '/commands', { headers });
    expect(polled.status).toBe(200);
    const command = (await polled.json()).command;
    expect(command).toMatchObject({ deviceId: device.id, method: 'GET', path: '/healthz' });
    const reply = {
      ok: true,
      status: 200,
      body: '{"fixture":true}',
      contentType: 'application/json',
    };
    const result = {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: command.requestId, reply }),
    };
    expect((await call('/' + lease.sessionId + '/results', result, 'bob')).status).toBe(403);
    expect((await call('/' + lease.sessionId + '/results', result)).status).toBe(200);
    await expect(pending).resolves.toEqual(reply);
    expect((await call('/' + lease.sessionId + '/results', result)).status).toBeGreaterThanOrEqual(
      400,
    );
  });
  it('withdraws owned metadata when a connector closes', async () => {
    const { call, register, broker } = await fixture();
    const lease = await register();
    expect(broker.devices('alice')).toEqual([device]);
    expect(broker.devices('bob')).toEqual([]);
    await call('/' + lease.sessionId, {
      method: 'DELETE',
      headers: { 'x-rdk-desktop-relay-token': lease.sessionToken },
    });
    expect(broker.devices('alice')).toEqual([]);
  });
});
