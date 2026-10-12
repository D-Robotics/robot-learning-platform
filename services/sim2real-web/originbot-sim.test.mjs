import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('./public/originbot-sim/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('./public/originbot-sim/sim.js', import.meta.url), 'utf8');
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function harness(task = 'data-collection') {
  const dom = new JSDOM(html, {
    url: `http://localhost:18102/originbot-sim/?taskId=${task}&mujocoBase=/studio/mujoco`,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.TextEncoder = TextEncoder;
  const timers = new Map(),
    calls = [],
    messages = [];
  let nextTimer = 0,
    pendingState = null,
    pendingCommand = null,
    pendingFrame = null;
  Object.defineProperty(window, 'parent', {
    value: { postMessage: (data) => messages.push(data) },
  });
  const context = new Proxy({}, { get: (target, key) => (key in target ? target[key] : () => {}) });
  window.HTMLCanvasElement.prototype.getContext = () => context;
  window.createImageBitmap = async () => ({ width: 900, height: 506, close() {} });
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  window.setTimeout = (fn) => {
    timers.set(++nextTimer, fn);
    return nextTimer;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const state = {
    id: 'originbot-1',
    time: 0,
    qpos: [0, 0, 0.1, 1, 0, 0, 0, 0, 0],
    qvel: Array(8).fill(0),
    cmd_vel: { linear: 0, angular: 0, maxLinear: 0.3, maxAngular: 1 },
    model: { controlHz: 20, controlPeriod: 0.05 },
    sensors: {
      odom: { x: 0, y: 0, yaw: 0, linearX: 0 },
      imu: { gyroZ: 0 },
      scan: [1, 1],
      depth: { available: true },
    },
  };
  const snapshot = () => {
    state.replay = {
      taskId: 'originbot',
      qpos: [...state.qpos],
      qvel: [...state.qvel],
      time: state.time,
      integrationState: [state.time, ...state.qpos, ...state.qvel],
      action: [0, 0],
      command: Array(13).fill(0),
      stepCount: Math.round(state.time / 0.05),
      reward: 0,
      done: false,
    };
    return structuredClone(state);
  };
  window.fetch = async (url, options = {}) => {
    const path = new URL(url, window.location.origin).pathname,
      body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method || 'GET', body });
    const response = (data) => ({
      ok: true,
      status: 200,
      json: async () => data,
      blob: async () => new window.Blob(['image']),
      headers: new Map([['content-type', 'application/json']]),
    });
    if (path.endsWith('/frame.jpg') && pendingFrame) {
      const deferred = pendingFrame;
      pendingFrame = null;
      await deferred;
    }
    if (path.endsWith('/frame.jpg') || path.endsWith('/depth.jpg')) return response({});
    if (path.endsWith('/policy.onnx'))
      return { ...response({}), arrayBuffer: async () => new ArrayBuffer(1) };
    if (path.includes('/runs/')) return response({ run: { taskId: task } });
    if (path.endsWith('/state') && pendingState) {
      const deferred = pendingState;
      pendingState = null;
      await deferred;
    }
    if (path.endsWith('/cmd_vel')) {
      state.time += 0.05;
      state.qpos[0] += body.linear * 0.05;
      state.sensors.odom.x = state.qpos[0];
      state.cmd_vel = { ...state.cmd_vel, ...body };
      if (pendingCommand) {
        const deferred = pendingCommand;
        pendingCommand = null;
        await deferred;
      }
    }
    if (path.endsWith('/reset')) {
      state.time = 0;
      state.qpos[0] = 0;
      state.sensors.odom.x = 0;
    }
    if (path.endsWith('/replay')) {
      state.qpos = [...body.qpos];
      state.qvel = [...body.qvel];
      state.time = body.time;
      state.sensors.odom.x = body.qpos[0];
    }
    return response(snapshot());
  };
  window.eval(script);
  await settle();
  return {
    dom,
    window,
    calls,
    messages,
    get state() {
      return snapshot();
    },
    message(data, origin = window.location.origin) {
      window.dispatchEvent(
        new window.MessageEvent('message', { data, origin, source: window.parent }),
      );
    },
    async tick() {
      const next = timers.entries().next().value;
      if (next) {
        timers.delete(next[0]);
        next[1]();
        await settle();
      }
    },
    deferState(promise) {
      pendingState = promise;
    },
    deferCommand(promise) {
      pendingCommand = promise;
    },
    deferFrame(promise) {
      pendingFrame = promise;
    },
    close() {
      window.dispatchEvent(new window.Event('pagehide'));
      dom.window.close();
    },
  };
}

test('workbench task switches change OriginBot controller mode; visual preview never autogoals', async () => {
  const h = await harness();
  try {
    assert.equal(h.window.rl.mode, 'data-collection');
    assert.equal(h.window.document.getElementById('manual-controls').hidden, false);
    h.message({ type: 'rdk-simulator-task', taskId: 'goal-navigation' });
    await settle();
    await h.tick();
    assert.equal(h.window.rl.mode, 'goal-navigation');
    assert.equal(h.window.document.getElementById('manual-controls').hidden, true);
    assert.ok(h.calls.some((call) => call.path.endsWith('/cmd_vel') && call.body.linear > 0));
    h.message({ type: 'rdk-simulator-task', taskId: 'visual-twist' });
    await settle();
    const before = h.calls.filter((call) => call.path.endsWith('/cmd_vel')).length;
    await h.tick();
    assert.equal(h.window.rl.mode, 'visual-twist');
    assert.equal(h.calls.filter((call) => call.path.endsWith('/cmd_vel')).length, before);
    assert.match(h.window.document.getElementById('stage-help').textContent, /适配器/);
    h.message({ type: 'rdk-simulator-task', taskId: 'custom' }, 'https://untrusted.example');
    assert.equal(h.window.rl.mode, 'visual-twist');
  } finally {
    h.close();
  }
});

test('manual OriginBot records actual transition, task, full state and replay snapshot', async () => {
  const h = await harness();
  try {
    const input = h.window.document.getElementById('manual-linear');
    input.value = '.2';
    input.dispatchEvent(new h.window.Event('input'));
    h.window.document.getElementById('record').click();
    await h.tick();
    const text = h.window.__rdkOriginbotRecorder.stop({ notify: false });
    const [header, sample] = text.trim().split('\n').map(JSON.parse);
    assert.equal(header.taskId, 'data-collection');
    assert.equal(header.actionSize, 2);
    assert.equal(sample.action[0], 0.2);
    assert.equal(sample.observation[0], 0);
    assert.ok(Math.abs(sample.qpos[0] - 0.01) < 1e-12);
    assert.equal(sample.replay.qpos[0], sample.qpos[0]);
    assert.equal(sample.nextObservation[0], sample.qpos[0]);
    assert.equal(sample.taskId, 'data-collection');
    assert.equal(h.window.__rdkOriginbotRecorder.recording, false);
  } finally {
    h.close();
  }
});

test('OriginBot replay restores the real backend pose and holds it while paused', async () => {
  const h = await harness();
  try {
    const replay = h.state.replay;
    replay.qpos[0] = 2;
    replay.time = 3;
    h.message({
      type: 'rdk-replay-frame',
      taskId: 'data-collection',
      index: 7,
      frame: { taskId: 'data-collection', replay, t: 3, metrics: { goalX: 1, goalY: 1 } },
    });
    await settle();
    assert.ok(h.calls.some((call) => call.path.endsWith('/replay') && call.body.qpos[0] === 2));
    assert.equal(h.window.rl.data.qpos[0], 2);
    assert.ok(
      h.messages.some(
        (data) =>
          data.type === 'rdk-replay-status' &&
          data.phase === 'applied' &&
          data.taskId === 'data-collection' &&
          data.index === 7,
      ),
    );
    const count = h.calls.filter((call) => call.path.endsWith('/cmd_vel')).length;
    await h.tick();
    assert.equal(h.calls.filter((call) => call.path.endsWith('/cmd_vel')).length, count);
    h.message({
      type: 'rdk-replay-frame',
      taskId: 'data-collection',
      index: 8,
      frame: { taskId: 'data-collection', observation: [9, 9] },
    });
    await settle();
    assert.equal(h.window.rl.data.qpos[0], 2);
    assert.match(h.window.document.getElementById('event').textContent, /快照/);
    assert.ok(
      h.messages.some(
        (data) =>
          data.type === 'rdk-replay-status' &&
          data.phase === 'failed' &&
          data.taskId === 'data-collection' &&
          data.index === 8,
      ),
    );
    h.message({
      type: 'rdk-replay-frame',
      taskId: 'goal-navigation',
      index: 9,
      frame: { taskId: 'goal-navigation', replay },
    });
    await settle();
    assert.ok(
      h.messages.some(
        (data) => data.type === 'rdk-replay-status' && data.phase === 'failed' && data.index === 9,
      ),
    );
    let failImage;
    h.deferFrame(
      new Promise((_resolve, reject) => {
        failImage = reject;
      }),
    );
    h.message({
      type: 'rdk-replay-frame',
      taskId: 'data-collection',
      index: 10,
      frame: { taskId: 'data-collection', replay },
    });
    await settle();
    failImage(new Error('frame unavailable'));
    await settle();
    assert.ok(
      h.messages.some(
        (data) => data.type === 'rdk-replay-status' && data.phase === 'failed' && data.index === 10,
      ),
    );
    assert.equal(
      h.messages.filter(
        (data) =>
          data.type === 'rdk-replay-status' && data.phase === 'applied' && data.index === 10,
      ).length,
      0,
    );
  } finally {
    h.close();
  }
});

test('hiding OriginBot preserves its accepted recorded command and publishes the completed snapshot once', async () => {
  const h = await harness();
  try {
    let complete;
    h.deferCommand(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const input = h.window.document.getElementById('manual-linear');
    input.value = '.2';
    input.dispatchEvent(new h.window.Event('input'));
    h.window.document.getElementById('record').click();
    await h.tick();
    h.message({ type: 'rdk-simulator-active', active: false });
    assert.equal(
      h.messages.filter((data) => data.type === 'rdk-originbot-recording-ready').length,
      0,
    );
    complete();
    await settle();
    const [header, sample] = h.window.__rdkOriginbotRecorder
      .getText()
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(header.taskId, 'data-collection');
    assert.equal(sample.action[0], 0.2);
    assert.equal(sample.replay.qpos[0], sample.qpos[0]);
    assert.equal(sample.t, 0.05);
    assert.equal(
      h.messages.filter((data) => data.type === 'rdk-originbot-recording-ready').length,
      1,
    );
  } finally {
    h.close();
  }
});

test('stopping OriginBot policy during final frame loading cannot later report a finished trial', async () => {
  const h = await harness();
  try {
    h.window.ort = {
      env: { wasm: {} },
      Tensor: class {
        constructor(_type, data) {
          this.data = data;
        }
      },
      InferenceSession: {
        create: async () => ({
          inputNames: ['obs'],
          outputNames: ['action'],
          inputMetadata: [{ shape: [1, 8] }],
          run: async () => ({ action: { data: [0, 0] } }),
          release: async () => {},
        }),
      },
    };
    const appendChild = h.window.document.head.appendChild.bind(h.window.document.head);
    h.window.document.head.appendChild = (node) => {
      const result = appendChild(node);
      if (node.tagName === 'SCRIPT') queueMicrotask(() => node.onload());
      return result;
    };
    const frameNow = Date.now() + 1000;
    h.window.Date.now = () => frameNow;
    let complete;
    h.deferFrame(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    h.message({
      type: 'rdk-policy-run',
      taskId: 'data-collection',
      runId: 'test',
      apiRoot: '/api/sim2real',
      maxSteps: 1,
      trialId: 'final-render-trial',
    });
    await settle();
    assert.ok(
      h.messages.some((data) => data.type === 'rdk-policy-status' && data.phase === 'running'),
    );
    assert.equal(
      h.messages.filter((data) => data.type === 'rdk-policy-status' && data.phase === 'finished')
        .length,
      0,
    );
    h.message({ type: 'rdk-policy-stop' });
    complete();
    await settle();
    assert.equal(
      h.messages.filter((data) => data.type === 'rdk-policy-status' && data.phase === 'finished')
        .length,
      0,
    );
    assert.ok(
      h.messages.some((data) => data.type === 'rdk-policy-status' && data.phase === 'stopped'),
    );
    assert.ok(
      h.messages
        .filter((data) => data.type === 'rdk-policy-status')
        .every((data) => data.trialId === 'final-render-trial'),
    );
    h.message({
      type: 'rdk-policy-run',
      taskId: 'data-collection',
      runId: 'test',
      apiRoot: '/api/sim2real',
      maxSteps: 0.5,
      trialId: 'invalid-limit-trial',
    });
    await settle();
    assert.ok(
      h.messages.some(
        (data) =>
          data.type === 'rdk-policy-status' &&
          data.phase === 'failed' &&
          data.trialId === 'invalid-limit-trial' &&
          /步数/.test(data.message),
      ),
    );
  } finally {
    h.close();
  }
});

test('inactive workbench view cancels a pending controller step and stops polling', async () => {
  const h = await harness('goal-navigation');
  try {
    let resolve;
    h.deferState(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const ticking = h.tick();
    await new Promise((done) => setImmediate(done));
    h.message({ type: 'rdk-simulator-active', active: false });
    const count = h.calls.filter((call) => call.path.endsWith('/cmd_vel')).length;
    resolve();
    await ticking;
    assert.equal(h.calls.filter((call) => call.path.endsWith('/cmd_vel')).length, count);
    await h.tick();
    assert.equal(h.calls.filter((call) => call.path.endsWith('/cmd_vel')).length, count);
  } finally {
    h.close();
  }
});
