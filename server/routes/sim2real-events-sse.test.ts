import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSim2RealEventsSseRouter,
  resetSim2RealSseStreamsForTests,
} from './sim2real-events-sse.js';
import { emitSim2RealEvent } from '../sim2real/sim2real-events.js';
import type { Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  resetSim2RealSseStreamsForTests();
});

function readChunkHeaders(raw: string): string {
  const headerEnd = raw.indexOf('\r\n\r\n');
  return headerEnd < 0 ? raw : raw.slice(0, headerEnd);
}
void readChunkHeaders;

/** Collect raw SSE bytes until the predicate sees a complete frame. */
function collectUntil(
  response: http.IncomingMessage,
  predicate: (buffer: string) => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (predicate(buffer)) {
        response.off('data', onData);
        response.destroy();
        resolve(buffer);
      }
    };
    response.on('data', onData);
    response.on('error', () => resolve(buffer));
    setTimeout(() => {
      response.off('data', onData);
      reject(new Error(`SSE collect timeout; got: ${buffer.slice(0, 300)}`));
    }, 4000).unref?.();
  });
}

async function startApp(
  router: express.Router,
): Promise<{ server: http.Server; url: (path: string) => string }> {
  const app = express();
  app.use(router);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    servers.push(s);
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: (path: string) => `http://127.0.0.1:${port}${path}` };
}

describe('sim2real events SSE router', () => {
  it('streams domain events with event type, id and JSON payload', async () => {
    const { url } = await startApp(createSim2RealEventsSseRouter({ prefix: '/api/v1/duck' }));
    const request = http.get(url('/api/v1/duck/events'), {
      headers: { accept: 'text/event-stream' },
    });
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.on('response', resolve);
      request.on('error', reject);
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-cache');

    const emitPromise = (async () => {
      // Wait for the route to register its client before emitting.
      await new Promise((r) => setTimeout(r, 150));
      await emitSim2RealEvent('run.updated', 'run-1', { status: 'running' });
    })();
    const raw = await collectUntil(response, (b) => b.includes('run-1'));
    await emitPromise;

    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(raw).toContain('event: run.updated');
    expect(raw).toMatch(/id: [0-9a-f-]{36}/);
    const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    expect(JSON.parse((dataLine as string).slice(6))).toMatchObject({
      type: 'run.updated',
      entityId: 'run-1',
      data: { status: 'running' },
    });
  });

  it('requires the text/event-stream accept header', async () => {
    const { url } = await startApp(createSim2RealEventsSseRouter());
    const request = http.get(url('/events'), { headers: { accept: 'application/json' } });
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.on('response', resolve);
      request.on('error', reject);
    });
    const body = await new Promise<string>((resolve) => {
      let raw = '';
      response.on('data', (c: Buffer) => (raw += c.toString()));
      response.on('end', () => resolve(raw));
    });
    expect(response.statusCode).toBe(406);
    expect(body).toContain('SIM2REAL_SSE_ACCEPT_REQUIRED');
  });

  it('fails closed for anonymous streams on multi-user deployments', async () => {
    const auth = {
      ...({} as Sim2RealAuthPort),
      isMultiUserDeployment: () => true,
      resolvePrincipal: () => undefined,
      resolveAccessToken: () => undefined,
    };
    const { url } = await startApp(createSim2RealEventsSseRouter({ auth }));
    const request = http.get(url('/events'), { headers: { accept: 'text/event-stream' } });
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.on('response', resolve);
      request.on('error', reject);
    });
    const body = await new Promise<string>((resolve) => {
      let raw = '';
      response.on('data', (c: Buffer) => (raw += c.toString()));
      response.on('end', () => resolve(raw));
    });
    expect(response.statusCode).toBe(401);
    expect(body).toContain('SIM2REAL_AUTH_REQUIRED');
  });

  it('only delivers owner-matching events to authenticated tenants', async () => {
    // Header-driven principal: http.get cannot attach custom request
    // properties the way the Express auth port normally reads them.
    const principalAuth = {
      ...({} as Sim2RealAuthPort),
      isMultiUserDeployment: () => true,
      resolvePrincipal: (request: Request) => {
        const account = String(request.headers['x-test-account'] ?? '');
        return account ? { accountId: account } : undefined;
      },
      resolveAccessToken: () => undefined,
    };
    const app = express();
    app.use(createSim2RealEventsSseRouter({ auth: principalAuth }));
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      servers.push(s);
    });
    const { port } = server.address() as AddressInfo;

    const tenantStream = http.get(`http://127.0.0.1:${port}/events`, {
      headers: { accept: 'text/event-stream', 'x-test-account': 'tenant-a' },
    });
    const tenantResponse = await new Promise<http.IncomingMessage>((resolve, reject) => {
      tenantStream.on('response', resolve);
      tenantStream.on('error', reject);
    });
    expect(tenantResponse.statusCode).toBe(200);
    // Accumulate the stream; the assertion below settles after delivery.
    let buffer = '';
    tenantResponse.on('data', (chunk: Buffer) => (buffer += chunk.toString('utf8')));
    // Give the route a full registration window before emitting: vitest
    // shares one process across this file, so the plugin-bus tail from the
    // previous test can still be draining.
    await new Promise((r) => setTimeout(r, 400));

    // Cross-tenant event must not reach tenant-a's stream.
    await emitSim2RealEvent('run.updated', 'run-secret', { status: 'ok' }, 'tenant-b');
    await emitSim2RealEvent('run.updated', 'run-mine', { status: 'ok' }, 'tenant-a');
    await new Promise((r) => setTimeout(r, 300));

    expect(buffer).toContain('run-mine');
    expect(buffer).not.toContain('run-secret');
    tenantStream.destroy();
  });
});
