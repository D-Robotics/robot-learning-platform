import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public/originbot-sim');
const [html, source] = await Promise.all([
  readFile(path.join(directory, 'index.html'), 'utf8'),
  readFile(path.join(directory, 'sim.js'), 'utf8'),
]);
const windows: JSDOM['window'][] = [];
afterEach(() => {
  windows.splice(0).forEach((window) => window.close());
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function drain() {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

async function boot(
  options: { compile?: Promise<any>; infer?: Promise<any>; board?: Promise<any> } = {},
) {
  const window = new JSDOM(html, {
    url: 'http://localhost/originbot-sim/',
    runScripts: 'outside-only',
  }).window;
  windows.push(window);
  window.document.getElementById('depth-view')?.remove();
  const context = new Proxy({}, { get: () => vi.fn() });
  vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return this.id === 'scene' ? (context as any) : null;
  });
  (window as any).createImageBitmap = async () => ({
    width: 900,
    height: 506,
    close: () => undefined,
  });
  const timers: Array<() => void> = [];
  window.setTimeout = ((callback: () => void) => {
    timers.push(callback);
    return timers.length;
  }) as any;
  const statuses: Array<{ phase: string }> = [];
  vi.spyOn(window.parent, 'postMessage').mockImplementation((message: any) => {
    if (message.type === 'rdk-policy-status') statuses.push(message);
  });
  const commands: unknown[] = [];
  const state = {
    id: 'simulation',
    t: 0,
    qpos: [0, 0, 0, 1],
    qvel: [],
    sensors: {},
    cmd_vel: { maxLinear: 0.3, maxAngular: 1 },
  };
  window.fetch = (async (input: string, init: RequestInit = {}) => {
    if (input.endsWith('/policy.onnx'))
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    if (input.endsWith('/board-station/policy-infer'))
      return options.board || { ok: true, json: async () => ({ ok: true, actions: [[0.4, 0.2]] }) };
    if (input.includes('/frame.jpg')) return { ok: true, blob: async () => new Blob() };
    if (input.endsWith('/cmd_vel')) commands.push(JSON.parse(String(init.body)));
    return { ok: true, json: async () => state };
  }) as any;
  const session = {
    inputNames: ['observation'],
    outputNames: ['action'],
    run: vi.fn(async () => options.infer || { action: { data: [0.4, 0.2] } }),
  };
  (window as any).ort = {
    env: { wasm: {} },
    Tensor: class {},
    InferenceSession: { create: vi.fn(async () => options.compile || session) },
  };
  window.eval(source);
  window.document.getElementById('run')?.click(); // Pause the ordinary navigator for cancellation checks.
  await drain();
  const send = (type: string, backend = 'wasm') =>
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type, runId: 'a', apiRoot: '/api/sim2real', backend },
        source: window.parent,
        origin: window.location.origin,
      }),
    );
  const start = async (backend = 'wasm') => {
    send('rdk-policy-run', backend);
    await drain();
    window.document
      .querySelector('script[src*="ort.min.js"]')
      ?.dispatchEvent(new window.Event('load'));
    await drain();
  };
  return { window, start, send, commands, statuses, timers, session };
}

describe('OriginBot policy trial cancellation', () => {
  it('does not revive a stopped trial when ONNX compilation completes later', async () => {
    const compiled = deferred<any>();
    const sim = await boot({ compile: compiled.promise });
    await sim.start();
    expect(sim.statuses.at(-1)?.phase).toBe('loading');
    sim.send('rdk-policy-stop');
    const stopped = sim.statuses.length;
    compiled.resolve(sim.session);
    await drain();
    expect(sim.statuses.slice(stopped)).toEqual([]);
    expect(sim.commands).toEqual([]);
  });

  it.each(['wasm', 'board'])(
    'does not send a late velocity command after stopping pending %s inference',
    async (backend) => {
      const output = deferred<any>();
      const sim = await boot(
        backend === 'wasm' ? { infer: output.promise } : { board: output.promise },
      );
      await sim.start(backend);
      expect(sim.statuses.at(-1)?.phase).toBe('running');
      sim.send('rdk-policy-stop');
      const stopped = sim.statuses.length;
      output.resolve(
        backend === 'wasm'
          ? { action: { data: [0.4, 0.2] } }
          : { ok: true, json: async () => ({ ok: true, actions: [[0.4, 0.2]] }) },
      );
      await drain();
      expect(sim.commands).toEqual([]);
      expect(sim.statuses.slice(stopped)).toEqual([]);
    },
  );

  it('gives the policy exclusive control while compilation is pending', async () => {
    const compiled = deferred<any>();
    const sim = await boot({ compile: compiled.promise });
    sim.window.document.getElementById('run')?.click(); // Ordinary navigation would now be active.
    await sim.start();
    sim.timers.shift()?.(); // Execute the scheduled ordinary navigation tick.
    await drain();
    expect(sim.commands).toEqual([]);
    sim.send('rdk-policy-stop');
    compiled.resolve(sim.session);
    await drain();
  });

  it('does not let a cancelled inference error terminate the replacement trial', async () => {
    const output = deferred<any>();
    const sim = await boot({ infer: output.promise });
    await sim.start();
    sim.send('rdk-policy-stop');
    await sim.start('board');
    expect(sim.commands).toHaveLength(1);
    const replacement = sim.statuses.length;
    output.reject(new Error('old model failed after cancellation'));
    await drain();
    expect(sim.statuses.slice(replacement)).toEqual([]);
    sim.timers.at(-1)?.();
    await drain();
    expect(sim.commands).toHaveLength(2);
  });

  it('does not write a command after the MuJoCo page session was released', async () => {
    const output = deferred<any>();
    const sim = await boot({ infer: output.promise });
    await sim.start();
    sim.window.dispatchEvent(new sim.window.Event('pagehide'));
    const unloading = sim.statuses.length;
    output.resolve({ action: { data: [0.4, 0.2] } });
    await drain();
    expect(sim.commands).toEqual([]);
    expect(sim.statuses.slice(unloading)).toEqual([]);
  });
});
