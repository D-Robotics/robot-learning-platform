import express from 'express';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSim2RealBoardStationRoutes } from './sim2real-board-station-routes.js';

const originalAgentUrl = process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
const originalAgentToken = process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
const originalStudioOrigin = process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
const originalStudioDevice = process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;

describe('board-station real HTTP stream lifecycle', () => {
  let server: Server | undefined;
  let stream: ReadableStream<Uint8Array>;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancel: ReturnType<typeof vi.fn>;
  let upstreamSignal: AbortSignal | undefined;
  const clients: IncomingMessage[] = [];
  const encoder = new TextEncoder();

  beforeEach(() => {
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'http://127.0.0.1:19100';
    process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'fixture-only';
    cancel = vi.fn();
    stream = new ReadableStream({
      start(value) {
        controller = value;
        controller.enqueue(encoder.encode('first-frame\n'));
      },
      cancel,
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      upstreamSignal = options?.signal ?? undefined;
      return new Response(stream);
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (!stream.locked) await stream.cancel().catch(() => undefined);
    if (originalAgentUrl === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    else process.env.RDK_SIM2REAL_BOARD_AGENT_URL = originalAgentUrl;
    if (originalAgentToken === undefined) delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;
    else process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = originalAgentToken;
    if (originalStudioOrigin === undefined) delete process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN;
    else process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = originalStudioOrigin;
    if (originalStudioDevice === undefined) delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
    else process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID = originalStudioDevice;
    vi.restoreAllMocks();
  });

  async function listen(drainRequest = false) {
    let requestCompleted!: (value: { complete: boolean; aborted: boolean }) => void;
    const completed = new Promise<{ complete: boolean; aborted: boolean }>((resolve) => {
      requestCompleted = resolve;
    });
    const app = express();
    app.use((request, _response, next) => {
      request.on('close', () =>
        requestCompleted({ complete: request.complete, aborted: request.aborted }),
      );
      next();
      if (drainRequest) request.resume();
    });
    const router = express.Router();
    registerSim2RealBoardStationRoutes(router, {
      auth: { isMultiUserDeployment: () => false } as never,
      requestOwner: () => 'local-fixture',
      visibleDevices: async () =>
        [
          { id: 'fixture-board', name: 'fixture', status: 'connected', connectionMode: null },
        ] as never,
    });
    app.use(router);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    return { origin: `http://127.0.0.1:${address.port}`, completed };
  }

  async function connect(
    origin: string,
    path: string,
    unfinishedBody = false,
    cookie = 'studio_session=fixture',
  ) {
    const request = httpRequest(`${origin}/api/sim2real/board-station/${path}`, {
      method: 'GET',
      headers: { cookie, ...(unfinishedBody ? { 'content-length': '1' } : {}) },
    });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      request.on('response', resolve);
      request.on('error', reject);
    });
    if (unfinishedBody) request.flushHeaders();
    else request.end();
    const client = await response;
    clients.push(client);
    const first = new Promise<void>((resolve) => client.once('data', () => resolve()));
    let text = '';
    client.on('data', (chunk: Buffer) => (text += chunk.toString()));
    client.on('error', () => undefined);
    await first;
    return { request, client, text: () => text };
  }

  it.each(['camera.mjpeg', 'status/stream'])(
    'keeps %s open when the HTTP request completes normally',
    async (path) => {
      const { origin, completed } = await listen(true);
      const { request, client, text } = await connect(origin, path, true);
      const nextFrame = new Promise<boolean>((resolve) => {
        client.once('close', () => resolve(false));
        client.on('data', () => {
          if (text().includes('second-frame')) resolve(true);
        });
      });
      request.end('x');
      expect(await completed).toEqual({ complete: true, aborted: false });
      controller.enqueue(encoder.encode('second-frame\n'));
      expect(await nextFrame).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
      client.destroy();
    },
  );

  it('cancels the locked upstream and releases its reader on client disconnect', async () => {
    const { origin } = await listen();
    const { client } = await connect(origin, 'camera.mjpeg');
    expect(stream.locked).toBe(true);
    client.destroy();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stream.locked).toBe(false));
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('cancels and releases the producer while the HTTP response is under backpressure', async () => {
    const { origin } = await listen();
    const { client } = await connect(origin, 'camera.mjpeg');
    client.pause();
    controller.enqueue(new Uint8Array(16 * 1024 * 1024));
    await delay(20);
    client.destroy();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stream.locked).toBe(false));
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('ends a completed upstream normally instead of destroying the HTTP response', async () => {
    controller.close();
    const { origin } = await listen();
    const result = await new Promise<{ complete: boolean; text: string }>((resolve) => {
      const request = httpRequest(`${origin}/api/sim2real/board-station/camera.mjpeg`);
      request.on('error', () => resolve({ complete: false, text: '' }));
      request.on('response', (client) => {
        clients.push(client);
        let text = '';
        client.on('data', (chunk: Buffer) => (text += chunk.toString()));
        client.on('end', () => resolve({ complete: client.complete, text }));
        client.on('error', () => resolve({ complete: false, text }));
      });
      request.end();
    });
    expect(result).toEqual({ complete: true, text: 'first-frame\n' });
    expect(stream.locked).toBe(false);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('stops Studio snapshot polling after disconnect and does not overlap a reopened HTTP stream', async () => {
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
    process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
    delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
    const calls = { old: 0, replacement: 0 };
    const signals: AbortSignal[] = [];
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]).toString('base64');
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, options) => {
      const cookie = new Headers(options?.headers).get('cookie');
      if (cookie === 'studio_session=old') {
        calls.old += 1;
        if (options?.signal) signals.push(options.signal);
      } else if (cookie === 'studio_session=replacement') {
        calls.replacement += 1;
      } else {
        throw new Error('unexpected fixture session');
      }
      return new Response(JSON.stringify({ output: jpeg }));
    });
    const { origin } = await listen();
    const old = await connect(origin, 'camera.mjpeg', false, 'studio_session=old');
    expect(calls.old).toBe(1);
    old.client.destroy();
    await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
    const replacement = await connect(origin, 'camera.mjpeg', false, 'studio_session=replacement');
    await vi.waitFor(() => expect(calls.replacement).toBeGreaterThanOrEqual(2));
    expect(calls.old).toBe(1);
    expect(replacement.client.destroyed).toBe(false);
    replacement.client.destroy();
  });
});
