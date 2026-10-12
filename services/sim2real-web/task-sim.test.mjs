import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as core from './public/task-sim/task-sim-core.mjs';
import {
  FORMAT,
  fitCameraBounds,
  identity,
  lookAt,
  modelMatrix,
  multiply,
  normalizedAction,
  policyBinding,
  policyStepLimit,
  perspective,
  primitive,
  recordingHeader,
  recordingAppendBudget,
  recordingLineBytes,
  recordingSample,
  replaySnapshot,
  sameOriginPath,
} from './public/task-sim/task-sim-core.mjs';

test('task endpoints cannot receive credentials on another origin', () => {
  assert.equal(
    sameOriginPath('/sim2real/mujoco/', 'http://localhost:18102', '/mujoco'),
    'http://localhost:18102/sim2real/mujoco',
  );
  for (const path of ['https://example.com/mujoco', '//example.com/mujoco', 'javascript:alert(1)'])
    assert.throws(() => sameOriginPath(path, 'http://localhost:18102', '/mujoco'), /同源/);
});

test('bounded actions retain actual task dimensions and all team agents', () => {
  assert.deepEqual(normalizedAction([2, -0.5, -3, 1], { actionDim: 4 }), [1, -0.5, -1, 1]);
  assert.throws(() => normalizedAction(Array(14).fill(0), { actionDim: 4 }), /4 维/);
  assert.throws(() => normalizedAction([0, 0, NaN, 0], { actionDim: 4 }), /有限/);
  assert.throws(() => normalizedAction([[0, 0, 0, 0]], { actionDim: 4, numAgents: 2 }), /2 个/);
  assert.deepEqual(
    normalizedAction(
      [
        [1, 0, 0, 0],
        [0, 0, 0, 1],
      ],
      { actionDim: 4, numAgents: 2 },
    ),
    [
      [1, 0, 0, 0],
      [0, 0, 0, 1],
    ],
  );
});

test('policy trial step limits reject invalid values instead of silently running a different limit', () => {
  assert.equal(policyStepLimit(undefined), 600);
  assert.equal(policyStepLimit(12), 12);
  for (const value of [0, -1, 0.5, Infinity, NaN, '600', 10001])
    assert.throws(() => policyStepLimit(value), /步数/);
});

test('recording budget counts actual UTF-8 bytes and refuses a whole frame before exceeding the cap', () => {
  const header = { type: 'header', taskName: '高跷' },
    frame = { taskId: '高跷', qpos: [1, 2], allAgents: { action: [[1], [2]] } };
  const bytes = recordingLineBytes(header),
    cap = bytes + recordingLineBytes(frame);
  assert.ok(bytes > (JSON.stringify(header) + '\n').length);
  const first = recordingAppendBudget(frame, bytes, cap);
  assert.equal(first.accepted, true);
  assert.equal(first.bytes, cap);
  const second = recordingAppendBudget(frame, first.bytes, cap);
  assert.equal(second.accepted, false);
  assert.equal(second.bytes, first.bytes);
});

test('replay requires the exact task and engine snapshot, never invents a scene from telemetry', () => {
  const replay = {
    taskId: 'balance-stilts',
    qpos: [1, 2],
    qvel: [0],
    integrationState: [1, 2, 0],
    posture: Array(14).fill(0),
  };
  assert.equal(replaySnapshot({ taskId: 'balance-stilts', replay }, 'balance-stilts'), replay);
  assert.throws(() => replaySnapshot({ taskId: 'balance-ball', replay }, 'balance-stilts'), /任务/);
  assert.throws(
    () =>
      replaySnapshot(
        { taskId: 'balance-stilts', replay: { ...replay, taskId: 'balance-ball' } },
        'balance-stilts',
      ),
    /任务/,
  );
  assert.throws(
    () => replaySnapshot({ taskId: 'balance-stilts', qpos: [1, 2] }, 'balance-stilts'),
    /快照/,
  );
  assert.throws(
    () =>
      replaySnapshot(
        { taskId: 'balance-stilts', replay: { qpos: [Infinity], qvel: [0] } },
        'balance-stilts',
      ),
    /快照/,
  );
});

test('recording aligns input observation and action with resulting real engine state', () => {
  const contract = { actionDim: 14, observationDim: 61, controlPeriodSeconds: 0.02 };
  const head = recordingHeader(
    { taskId: 'balance-stilts', name: '高跷平衡', engine: 'microduck-recurrent' },
    contract,
  );
  assert.equal(head.format, FORMAT);
  assert.equal(head.actionSize, 14);
  assert.equal(head.observationSize, 61);
  const before = { taskId: 'balance-stilts', observation: [1], contract },
    after = {
      time: 0.02,
      stepCount: 1,
      observation: [2],
      qpos: [3],
      qvel: [4],
      reward: 0.5,
      metrics: { fallen: false },
      replay: { qpos: [3], qvel: [4] },
    };
  const sample = recordingSample(before, after, [0.2]);
  assert.deepEqual(sample.observation, [1]);
  assert.deepEqual(sample.nextObservation, [2]);
  assert.deepEqual(sample.action, [0.2]);
  assert.equal(sample.t, 0.02);
  assert.equal(sample.replay, after.replay);
});

test('team recording preserves every actual action and exposes agent zero for workbench telemetry', () => {
  const contract = { actionDim: 4, observationDim: 24, numAgents: 2 };
  assert.equal(recordingHeader({ taskId: 'football-2v2' }, contract).recordedAgent, 0);
  const before = { taskId: 'football-2v2', observation: [[1], [2]], contract },
    after = { observation: [[3], [4]], reward: [0.3, 0.4], replay: { action: [[0.1], [0.2]] } };
  const sample = recordingSample(before, after, [[0.1], [0.2]]);
  assert.deepEqual(sample.observation, [1]);
  assert.deepEqual(sample.action, [0.1]);
  assert.deepEqual(sample.allAgents.action, [[0.1], [0.2]]);
  assert.deepEqual(sample.replay.action, [[0.1], [0.2]]);
});

test('ONNX binding carries declared recurrent states and rejects dimensions from other tasks', () => {
  const recurrent = {
    inputNames: ['obs', 'h_in', 'c_in'],
    outputNames: ['actions', 'h_out', 'c_out'],
    inputMetadata: [
      { shape: ['batch', 61] },
      { shape: [1, 'batch', 32] },
      { shape: [1, 'batch', 32] },
    ],
  };
  assert.deepEqual(policyBinding(recurrent, { observationDim: 61 }), {
    inputName: 'obs',
    outputName: 'actions',
    hiddenShapes: { h_in: [1, 1, 32], c_in: [1, 1, 32] },
  });
  assert.throws(() => policyBinding(recurrent, { observationDim: 20 }), /维度/);
  assert.throws(
    () =>
      policyBinding({ ...recurrent, outputNames: ['actions', 'h_out'] }, { observationDim: 61 }),
    /辅助输入/,
  );
  assert.throws(
    () =>
      policyBinding(
        {
          ...recurrent,
          inputNames: ['obs', 'image'],
          inputMetadata: [{ shape: [1, 61] }, { shape: [1, 3, 224, 224] }],
        },
        { observationDim: 61 },
      ),
    /辅助输入/,
  );
  assert.throws(
    () =>
      policyBinding(
        {
          inputNames: ['observation'],
          outputNames: ['action'],
          inputMetadata: { observation: { dimensions: [1, 24] } },
        },
        { observationDim: 24, numAgents: 2 },
      ),
    /维度/,
  );
});

test('MuJoCo row-major rotations and translation become correct WebGL column-major transforms', () => {
  const matrix = modelMatrix({ xpos: [2, 3, 4], xmat: [0, -1, 0, 1, 0, 0, 0, 0, 1] });
  assert.deepEqual(Array.from(matrix).slice(0, 4), [0, 1, 0, 0]);
  assert.deepEqual(Array.from(matrix).slice(12, 15), [2, 3, 4]);
  assert.deepEqual(multiply(matrix, identity()), matrix);
  const view = lookAt([0, -3, 1], [0, 0, 0]);
  assert.ok(Array.from(view).every(Number.isFinite));
});

test('camera fits the real scene bounds tightly with padding in wide and tall canvases', () => {
  const bounds = { low: [-4, -3, 0], high: [4, 3, 0.7], center: [0, 0, 0.35], radius: 5.1 };
  for (const aspect of [0.65, 1, 1.8, 3]) {
    const { target, distance } = fitCameraBounds(bounds, aspect);
    const azimuth = -1.1,
      elevation = 0.48;
    const eye = [
      target[0] + distance * Math.cos(elevation) * Math.cos(azimuth),
      target[1] + distance * Math.cos(elevation) * Math.sin(azimuth),
      target[2] + distance * Math.sin(elevation),
    ];
    const transform = multiply(perspective(aspect), lookAt(eye, target));
    let occupied = 0;
    for (const x of [bounds.low[0], bounds.high[0]])
      for (const y of [bounds.low[1], bounds.high[1]])
        for (const z of [bounds.low[2], bounds.high[2]]) {
          const corner = [x, y, z, 1],
            projected = [0, 1, 2, 3].map((row) =>
              corner.reduce((sum, value, col) => sum + value * transform[col * 4 + row], 0),
            );
          assert.ok(projected[3] > 0);
          const extent = Math.max(
            Math.abs(projected[0] / projected[3]),
            Math.abs(projected[1] / projected[3]),
          );
          assert.ok(extent <= 0.85001, `aspect ${aspect}: bounds must stay inside padded viewport`);
          occupied = Math.max(occupied, extent);
        }
    assert.ok(occupied > 0.8499, `aspect ${aspect}: scene should fill its available viewport`);
  }
});

test('actual primitive sizes survive triangulation with finite unit normals', () => {
  for (const type of ['box', 'plane', 'sphere', 'ellipsoid', 'cylinder', 'capsule']) {
    const mesh = primitive(type, [1, 2, 3]);
    assert.ok(mesh.length > 0 && mesh.length % 18 === 0);
    assert.ok(Array.from(mesh).every(Number.isFinite));
    for (let i = 0; i < mesh.length; i += 6)
      assert.ok(Math.abs(Math.hypot(mesh[i + 3], mesh[i + 4], mesh[i + 5]) - 1) < 1e-6);
    if (type === 'capsule') {
      const zs = [];
      for (let i = 2; i < mesh.length; i += 6) zs.push(mesh[i]);
      assert.equal(Math.max(...zs), 3);
      assert.equal(Math.min(...zs), -3);
    }
  }
  assert.throws(() => primitive('mesh', [1, 1, 1]), /不支持/);
});

test('actual recurrent ONNX export binds real metadata and carries hidden outputs to the next inference', async () => {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const bytes = await readFile(
    new URL('../../engines/microduck-recurrent/evidence/policy-smoke.onnx', import.meta.url),
  );
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  try {
    const binding = policyBinding(session, { observationDim: 61, actionDim: 14, numAgents: 1 });
    assert.deepEqual(binding.hiddenShapes, { h_in: [1, 1, 256], c_in: [1, 1, 256] });
    const feeds = { [binding.inputName]: new ort.Tensor('float32', new Float32Array(61), [1, 61]) };
    for (const [name, shape] of Object.entries(binding.hiddenShapes))
      feeds[name] = new ort.Tensor(
        'float32',
        new Float32Array(shape.reduce((a, b) => a * b, 1)),
        shape,
      );
    const first = await session.run(feeds);
    for (const name of Object.keys(binding.hiddenShapes))
      feeds[name] = first[name.replace('_in', '_out')];
    const second = await session.run(feeds);
    assert.equal(second[binding.outputName].data.length, 14);
    assert.ok(Array.from(second[binding.outputName].data).every(Number.isFinite));
    for (const name of ['h_out', 'c_out'])
      assert.ok(
        Array.from(second[name].data).some((value, index) => value !== first[name].data[index]),
      );
  } finally {
    await session.release();
  }
});

const settleRuntime = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};
async function taskRuntime(runtimeOptions = {}) {
  const html = await readFile(new URL('./public/task-sim/index.html', import.meta.url), 'utf8');
  const source = (
    await readFile(new URL('./public/task-sim/task-sim.js', import.meta.url), 'utf8')
  ).replace(/^import[^\n]*\n/gm, '');
  const dom = new JSDOM(html, {
    url: 'http://localhost:18102/task-sim/?taskId=balance-stilts',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const timers = new Map(),
    messages = [],
    scenes = [];
  let timerId = 0,
    deferredStep = null;
  Object.assign(window, core, { structuredClone });
  if (runtimeOptions.ort) window.ort = runtimeOptions.ort;
  Object.defineProperty(window, 'parent', {
    value: { postMessage: (data) => messages.push(data) },
  });
  window.setTimeout = (fn) => {
    timers.set(++timerId, fn);
    return timerId;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.createRenderer = () => ({ setScene: (scene) => scenes.push(scene), destroy() {} });
  const contract = {
    taskId: 'balance-stilts',
    name: '高跷平衡',
    engine: 'microduck-recurrent',
    actionDim: 14,
    observationDim: 61,
    numAgents: 1,
    controlPeriodSeconds: 0.02,
  };
  let count = 0;
  const state = () => ({
    taskId: 'balance-stilts',
    sessionId: 'task-1',
    time: count * 0.02,
    stepCount: count,
    done: false,
    reward: 1,
    metrics: { fallen: false },
    observation: Array(61).fill(count),
    qpos: [count],
    qvel: [0],
    contract,
    replay: { taskId: 'balance-stilts', qpos: [count], qvel: [0], time: count * 0.02 },
    scene: {
      geoms: [{ type: 'sphere', size: [1, 1, 1], xpos: [count, 0, 0] }],
      bounds: { center: [0, 0, 0], radius: 1 },
    },
  });
  window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    let payload;
    if (path.endsWith('/task-scenes')) {
      if (runtimeOptions.catalogGate) await runtimeOptions.catalogGate;
      payload = { scenes: [contract] };
    } else if (path.endsWith('/policy.onnx'))
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) };
    else if (path.includes('/runs/')) payload = { run: { taskId: 'balance-stilts' } };
    else if (path.endsWith('/step')) {
      count++;
      if (deferredStep) {
        const promise = deferredStep;
        deferredStep = null;
        await promise;
      }
      payload = state();
    } else if (path.endsWith('/replay')) {
      count = JSON.parse(options.body).qpos[0];
      payload = state();
    } else payload = state();
    return { ok: true, json: async () => payload };
  };
  window.eval(source);
  await settleRuntime();
  return {
    dom,
    window,
    messages,
    scenes,
    state,
    deferStep: (promise) => {
      deferredStep = promise;
    },
    message(data) {
      const event = new window.Event('message');
      Object.assign(event, { data, origin: window.location.origin, source: window.parent });
      window.dispatchEvent(event);
    },
    async tick() {
      const timer = timers.entries().next().value;
      if (timer) {
        timers.delete(timer[0]);
        timer[1]();
        await settleRuntime();
      }
    },
    close() {
      window.dispatchEvent(new window.Event('pagehide'));
      dom.window.close();
    },
  };
}

test('hiding a task scene preserves its accepted recorded step while suppressing stale rendering', async () => {
  const h = await taskRuntime();
  try {
    let complete;
    h.deferStep(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    h.window.document.getElementById('record').click();
    await h.tick();
    const previousScenes = h.scenes.length;
    h.message({ type: 'rdk-simulator-active', active: false });
    assert.equal(h.messages.filter((data) => data.type === 'rdk-task-recording-ready').length, 0);
    complete();
    await settleRuntime();
    assert.equal(h.scenes.length, previousScenes);
    const [, sample] = h.window.__rdkTaskRecorder.getText().trim().split('\n').map(JSON.parse);
    assert.equal(sample.replay.qpos[0], 1);
    assert.equal(sample.t, 0.02);
    assert.equal(h.messages.filter((data) => data.type === 'rdk-task-recording-ready').length, 1);
    h.message({ type: 'rdk-simulator-active', active: true });
    await settleRuntime();
    assert.match(h.window.document.getElementById('clock').textContent, /0\.02 s/);
    assert.equal(h.window.document.getElementById('run').textContent, '开始仿真');
  } finally {
    h.close();
  }
});

test('task replay reports loading until its scene is ready', async () => {
  let ready;
  const h = await taskRuntime({
    catalogGate: new Promise((resolve) => {
      ready = resolve;
    }),
  });
  try {
    h.message({
      type: 'rdk-replay-frame',
      taskId: 'balance-stilts',
      index: 4,
      frame: { taskId: 'balance-stilts', replay: h.state().replay },
    });
    await settleRuntime();
    assert.ok(
      h.messages.some(
        (data) => data.type === 'rdk-replay-status' && data.phase === 'loading' && data.index === 4,
      ),
    );
    ready();
    await settleRuntime();
    assert.ok(
      h.messages.some(
        (data) =>
          data.type === 'rdk-simulator-task-state' &&
          data.phase === 'ready' &&
          data.taskId === 'balance-stilts',
      ),
    );
    assert.equal(
      h.messages.filter((data) => data.type === 'rdk-replay-status' && data.phase === 'applied')
        .length,
      0,
    );
  } finally {
    ready();
    h.close();
  }
});

test('task policy statuses retain each operation ID across replacement and delayed model loading', async () => {
  let completeFirst,
    creations = 0,
    releases = 0;
  const session = () => ({
    inputNames: ['obs'],
    outputNames: ['action'],
    inputMetadata: [{ shape: [1, 61] }],
    run: async () => ({ action: { data: new Float32Array(14) } }),
    release: async () => {
      releases++;
    },
  });
  const ort = {
    env: { wasm: {} },
    Tensor: class {
      constructor(_type, data) {
        this.data = data;
      }
    },
    InferenceSession: {
      create: async () => {
        if (++creations === 1)
          await new Promise((resolve) => {
            completeFirst = resolve;
          });
        return session();
      },
    },
  };
  const h = await taskRuntime({ ort });
  try {
    const request = {
      type: 'rdk-policy-run',
      taskId: 'balance-stilts',
      runId: 'test',
      apiRoot: '/api/sim2real',
      maxSteps: 1,
    };
    h.message({ ...request, trialId: 'first' });
    await settleRuntime();
    h.message({ ...request, trialId: 'second' });
    await settleRuntime();
    completeFirst();
    await settleRuntime();
    await h.tick();
    h.message({ ...request, trialId: 'third', taskId: 'balance-ball' });
    await settleRuntime();
    const statuses = h.messages.filter((data) => data.type === 'rdk-policy-status');
    assert.deepEqual(
      statuses.map(({ phase, trialId }) => [phase, trialId]),
      [
        ['loading', 'first'],
        ['stopped', 'first'],
        ['loading', 'second'],
        ['running', 'second'],
        ['finished', 'second'],
        ['failed', 'third'],
      ],
    );
    assert.equal(releases, 2);
  } finally {
    completeFirst?.();
    h.close();
  }
});

test('task replay acknowledges only the actual restored backend state', async () => {
  const h = await taskRuntime();
  try {
    h.message({
      type: 'rdk-replay-frame',
      index: 2,
      taskId: 'balance-stilts',
      frame: { taskId: 'balance-stilts', replay: { ...h.state().replay, qpos: [8], time: 0.16 } },
    });
    await settleRuntime();
    assert.ok(
      h.messages.some(
        (data) =>
          data.type === 'rdk-replay-status' &&
          data.phase === 'applied' &&
          data.taskId === 'balance-stilts' &&
          data.index === 2,
      ),
    );
    assert.match(h.window.document.getElementById('clock').textContent, /0\.16 s/);
    h.message({
      type: 'rdk-replay-frame',
      index: 3,
      taskId: 'balance-stilts',
      frame: { taskId: 'balance-stilts', replay: { ...h.state().replay, taskId: 'balance-ball' } },
    });
    await settleRuntime();
    assert.ok(
      h.messages.some(
        (data) =>
          data.type === 'rdk-replay-status' &&
          data.phase === 'failed' &&
          data.taskId === 'balance-stilts' &&
          data.index === 3,
      ),
    );
    assert.match(h.window.document.getElementById('clock').textContent, /0\.16 s/);
  } finally {
    h.close();
  }
});
