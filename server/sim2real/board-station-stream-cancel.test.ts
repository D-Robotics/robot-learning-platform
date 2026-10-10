import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stationAgentFetchStream } from './board-station-proxy.js';

const envKeys = [
  'RDK_SIM2REAL_BOARD_AGENT_URL',
  'RDK_SIM2REAL_BOARD_AGENT_TOKEN',
  'RDK_SIM2REAL_STUDIO_EXEC_ORIGIN',
  'RDK_SIM2REAL_STUDIO_DEVICE_ID',
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const routes = ['/v1/station/camera.mjpeg', '/v1/station/status/stream'] as const;
const options = { deviceId: 'fixture-device', cookieHeader: 'studio_session=fixture' };
const output = (path: string) =>
  path.includes('camera')
    ? Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]).toString('base64')
    : JSON.stringify({ available: true, mock: true });

beforeEach(() => {
  delete process.env.RDK_SIM2REAL_BOARD_AGENT_URL;
  process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN = 'fixture-token';
  process.env.RDK_SIM2REAL_STUDIO_EXEC_ORIGIN = 'http://127.0.0.1:18090';
  delete process.env.RDK_SIM2REAL_STUDIO_DEVICE_ID;
});

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Studio bridge stream producer cancellation', () => {
  it.each(routes)(
    'settles the actual %s producer while its poll delay is pending',
    async (path) => {
      const NativeStream = globalThis.ReadableStream;
      let producerFinished = false;
      // Observe the real async producer promise passed to the Web Streams API.
      vi.stubGlobal(
        'ReadableStream',
        new Proxy(NativeStream, {
          construct(target, args) {
            const source = args[0] as UnderlyingDefaultSource<Uint8Array> | undefined;
            if (source?.start?.constructor.name !== 'AsyncFunction') {
              return Reflect.construct(target, args);
            }
            return Reflect.construct(target, [
              {
                ...source,
                start(controller: ReadableStreamDefaultController<Uint8Array>) {
                  return Promise.resolve(source.start?.(controller)).finally(() => {
                    producerFinished = true;
                  });
                },
              },
              args[1],
            ]);
          },
        }),
      );
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => new Response(JSON.stringify({ output: output(path) })));
      const stream = await stationAgentFetchStream(path, options);
      const reader = stream.getReader();
      try {
        expect((await reader.read()).done).toBe(false);
        expect(producerFinished).toBe(false);
        await reader.cancel();
        await vi.waitFor(() => expect(producerFinished).toBe(true));
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  );

  it.each(routes)(
    'aborts an in-flight %s request before a replacement stream begins',
    async (path) => {
      let oldSignal: AbortSignal | undefined;
      let finishOld!: () => void;
      let started!: () => void;
      const pending = new Promise<void>((resolve) => (started = resolve));
      let oldActive = false;
      let overlaps = 0;
      let calls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        calls += 1;
        if (calls > 1) {
          if (oldActive) overlaps += 1;
          return Promise.resolve(new Response(JSON.stringify({ output: output(path) })));
        }
        oldActive = true;
        oldSignal = init?.signal ?? undefined;
        started();
        return new Promise<Response>((resolve, reject) => {
          finishOld = () => {
            oldActive = false;
            resolve(new Response(JSON.stringify({ output: output(path) })));
          };
          oldSignal?.addEventListener(
            'abort',
            () => {
              oldActive = false;
              reject(new DOMException('cancelled', 'AbortError'));
            },
            { once: true },
          );
        });
      });
      const old = await stationAgentFetchStream(path, options);
      const oldReader = old.getReader();
      let replacementReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        await pending;
        await oldReader.cancel();
        expect(oldSignal?.aborted).toBe(true);
        const replacement = await stationAgentFetchStream(path, options);
        replacementReader = replacement.getReader();
        expect((await replacementReader.read()).done).toBe(false);
        expect(overlaps).toBe(0);
      } finally {
        finishOld();
        await oldReader.cancel().catch(() => undefined);
        oldReader.releaseLock();
        if (replacementReader) {
          await replacementReader.cancel();
          replacementReader.releaseLock();
        }
      }
    },
  );
});
