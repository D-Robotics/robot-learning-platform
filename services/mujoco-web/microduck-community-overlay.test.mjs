import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const overlaySource = await readFile(
  new URL('./microduck-community-overlay.js', import.meta.url),
  'utf8',
);

function sessionFixture() {
  return {
    inputNames: ['obs'],
    outputNames: ['actions'],
    run: async () => ({ actions: { data: new Float32Array(14) } }),
  };
}

function policyRuntime(overrides = {}) {
  const sessions = Object.fromEntries(
    ['walk', 'sitstand', 'roll', 'kickL', 'kickR', 'stand'].map((slot) => [slot, sessionFixture()]),
  );
  const official = { ...sessions };
  const current = {
    sessions,
    loco: 'legs',
    mode: 'walk',
    recovery: null,
    customPolicy: null,
    resetSim() {
      this.mode = 'walk';
      this.recovery = null;
    },
    spawnBall() {},
    debugPush() {
      this.recovery = 'recovering';
    },
    async loadCustomPolicy(ref) {
      this.customPolicy = { ref, session: sessionFixture(), slot: 'walk' };
      this.lastLoadedRun = this.customPolicy.session.run;
      this.sessions.walk = this.customPolicy.session;
    },
    clearCustomPolicy() {
      this.customPolicy = null;
      // Deliberately match upstream: kick/stand are the overlay's responsibility.
      for (const slot of ['walk', 'sitstand', 'roll']) this.sessions[slot] = official[slot];
    },
    ...overrides,
  };
  current.controller ||= {
    sources: [
      {
        id: 'keyboard',
        onAction(action) {
          if (action === 'sitToggle') current.mode = 'sitstand';
        },
      },
    ],
  };
  return current;
}

function runResponse(taskId, id = `run-${taskId}`) {
  return {
    ok: true,
    json: async () => ({
      run: {
        id,
        taskId,
        backend: 'local',
        status: 'completed',
        artifact: { format: 'onnx' },
      },
    }),
  };
}

function bridgeFixture(runtime) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>Simulation</body></html>', {
    url: 'https://studio.example.test/mujoco/microduck/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const messages = [];
  const parent = {
    location: { origin: window.location.origin },
    postMessage: (data) => messages.push(data),
  };
  Object.defineProperty(window, 'parent', { value: parent });
  window.matchMedia = () => ({ matches: false });
  if (runtime) window.rl = runtime;
  window.eval(overlaySource);
  return {
    dom,
    window,
    messages,
    send(data, extra = {}) {
      window.dispatchEvent(
        new window.MessageEvent('message', {
          data,
          source: parent,
          origin: window.location.origin,
          ...extra,
        }),
      );
    },
  };
}

test('task bridge waits for runtime, rejects foreign messages and sets up a kick without moving', async (t) => {
  const fixture = bridgeFixture();
  t.after(() => fixture.dom.window.close());
  const calls = [];
  fixture.send({ type: 'rdk-simulator-task', taskId: 'kick' }, { origin: 'https://attacker.test' });
  fixture.send({ type: 'rdk-simulator-task', taskId: 'kick' }, { source: {} });
  fixture.send({ type: 'rdk-simulator-task', taskId: 'kick' });
  assert.equal(
    fixture.messages.some((message) => message.phase === 'ready'),
    false,
  );
  fixture.window.rl = {
    resetSim: () => calls.push('reset'),
    spawnBall: () => calls.push('ball'),
    cmd: new Float32Array([1, 1, 1]),
    velCmd: new Float32Array([1, 1, 1]),
  };
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(calls, ['reset', 'ball']);
  assert.deepEqual(Array.from(fixture.window.rl.velCmd), [0, 0, 0]);
  assert.ok(
    fixture.messages.some(
      (message) =>
        message.type === 'rdk-simulator-task-state' &&
        message.phase === 'ready' &&
        message.taskId === 'kick',
    ),
  );
  fixture.send({ type: 'rdk-simulator-task', taskId: 'kick' });
  assert.deepEqual(
    calls,
    ['reset', 'ball'],
    'same task acknowledgement must not restart its scene',
  );
  fixture.send({ type: 'rdk-simulator-task', taskId: 'balance-stilts' });
  assert.ok(
    fixture.messages.some(
      (message) => message.phase === 'failed' && message.taskId === 'balance-stilts',
    ),
  );
});

test('reading the introduction beyond the startup deadline still becomes ready after the real runtime appears', async (t) => {
  const fixture = bridgeFixture();
  t.after(() => fixture.dom.window.close());
  let now = 0;
  Object.defineProperty(fixture.window.performance, 'now', { value: () => now });
  fixture.window.document.body.textContent = 'WADDLE IN';
  fixture.window.document.body.innerText = 'WADDLE IN';
  fixture.send({ type: 'rdk-simulator-task', taskId: 'walk' });
  now = 60_000;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    fixture.messages.some((message) => message.phase === 'failed'),
    false,
  );
  assert.ok(
    fixture.messages.some(
      (message) => message.phase === 'loading' && /开始仿真/.test(message.message),
    ),
  );
  // Clicking start may still compile WASM before window.rl is exposed.
  fixture.window.document.body.textContent = 'Compiling simulator';
  fixture.window.document.body.innerText = 'Compiling simulator';
  now = 120_000;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    fixture.messages.some((message) => message.phase === 'failed'),
    false,
  );
  fixture.window.rl = policyRuntime();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fixture.window.__microduckSimulator.ready, true);
  assert.ok(
    fixture.messages.some((message) => message.phase === 'ready' && message.taskId === 'walk'),
  );
});

test('the preparation deadline still reports a runtime that never unlocks', async (t) => {
  const fixture = bridgeFixture(policyRuntime({ inputLocked: true }));
  t.after(() => fixture.dom.window.close());
  let now = 0;
  Object.defineProperty(fixture.window.performance, 'now', { value: () => now });
  fixture.send({ type: 'rdk-simulator-task', taskId: 'walk' });
  now = 15_001;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(
    fixture.messages.some((message) => message.phase === 'failed' && /15 秒/.test(message.message)),
  );
  assert.equal(fixture.window.__microduckSimulator.ready, false);
});

test('recovery perturbation is explicit and recordings retain task and complete state', async (t) => {
  const calls = [];
  const fixture = bridgeFixture({
    resetSim() {},
    debugPush: (...args) => calls.push(args),
    buildObs: () => new Float32Array(61),
    lastAction: new Float32Array(14),
    data: { qpos: new Float64Array(28), qvel: new Float64Array(26) },
  });
  t.after(() => fixture.dom.window.close());
  fixture.send({ type: 'rdk-simulator-task', taskId: 'recover' });
  assert.equal(calls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const recoveryButton = fixture.window.document.querySelector('[data-recovery-test]');
  assert.equal(recoveryButton.hidden, false);
  assert.equal(recoveryButton.disabled, false);
  recoveryButton.click();
  assert.equal(calls.length, 1);
  const recorder = fixture.window.__microduckRecorder;
  recorder.start();
  recorder.stop();
  const [header, frame] = recorder.getText().trim().split('\n').map(JSON.parse);
  assert.equal(header.taskId, 'recover');
  assert.equal(header.sceneId, 'microduck-single-duck-v1');
  assert.equal(frame.taskId, 'recover');
  assert.equal(frame.qpos.length, 28);
  assert.equal(frame.qvel.length, 26);
});

test('replay applies validated MuJoCo state, holds physics and restores live stepping', (t) => {
  let forwarded = 0;
  let rendered = 0;
  let stepped = 0;
  const current = {
    resetSim() {},
    model: {},
    data: { qpos: new Float64Array(10), qvel: new Float64Array(9) },
    mujoco: { mj_forward: () => forwarded++, mj_step: () => stepped++ },
    render: () => rendered++,
  };
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  const originalStep = current.mujoco.mj_step;
  const frame = { qpos: [1, 2, 3, 1, 0, 0, 0, 0.1, 0.2, 0.3], qvel: Array(9).fill(0.4) };
  fixture.send({ type: 'rdk-replay-frame', frame, taskId: 'walk', index: 0 });
  assert.deepEqual(Array.from(current.data.qpos), frame.qpos);
  assert.ok(forwarded > 0 && rendered > 0);
  current.data.qpos[0] = 99;
  current.mujoco.mj_step(current.model, current.data);
  assert.equal(current.data.qpos[0], 1);
  assert.equal(stepped, 0);
  current.mujoco.mj_step({}, {});
  assert.equal(stepped, 1, 'another world sharing the WASM module must continue stepping');
  assert.ok(
    fixture.messages.some(
      (message) =>
        message.type === 'rdk-replay-state' && message.applied && message.scope === 'full',
    ),
  );
  fixture.send({ type: 'rdk-replay-stop' });
  assert.equal(current.mujoco.mj_step, originalStep);
  current.mujoco.mj_step();
  assert.equal(stepped, 2);
});

test('replay rejects invalid dimensions, non-finite state and incompatible tasks before mutation', (t) => {
  const current = {
    model: {},
    data: { qpos: new Float64Array(10), qvel: new Float64Array(9) },
    mujoco: { mj_forward() {}, mj_step() {} },
    render() {},
  };
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  for (const frame of [
    { qpos: [1, 2], qvel: Array(9).fill(0) },
    { qpos: Array(10).fill(NaN), qvel: Array(9).fill(0) },
    { qpos: Array(10).fill(0), qvel: Array(9).fill(0) },
  ]) {
    fixture.send({ type: 'rdk-replay-frame', frame, taskId: 'walk' });
  }
  fixture.send({
    type: 'rdk-replay-frame',
    frame: { qpos: Array(10).fill(2), qvel: Array(9).fill(0) },
    taskId: 'football-2v2',
  });
  assert.deepEqual(Array.from(current.data.qpos), Array(10).fill(0));
  assert.equal(
    fixture.messages.filter(
      (message) => message.type === 'rdk-replay-state' && message.applied === false,
    ).length,
    4,
  );
});

test('workbench policy trial loads a verified basic run and stop restores the official policy', async (t) => {
  const loaded = [];
  let cleared = 0;
  const current = policyRuntime();
  const loader = current.loadCustomPolicy;
  const clear = current.clearCustomPolicy;
  current.loadCustomPolicy = async (url) => {
    loaded.push(url);
    await loader.call(current, url);
  };
  current.clearCustomPolicy = () => {
    cleared++;
    clear.call(current);
  };
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  fixture.window.fetch = async () => ({
    ok: true,
    json: async () => ({
      run: {
        id: 'run-walk',
        taskId: 'walk',
        backend: 'local',
        status: 'completed',
        mock: false,
        artifact: { format: 'onnx' },
      },
    }),
  });
  fixture.send({
    type: 'rdk-policy-run',
    runId: 'run-walk',
    apiRoot: '/api/sim2real',
    maxSteps: 600,
    backend: 'wasm',
    trialId: 'trial-walk-1',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(loaded, ['https://studio.example.test/api/sim2real/runs/run-walk/policy.onnx']);
  assert.ok(
    fixture.messages.some(
      (message) =>
        message.phase === 'armed' &&
        message.trialId === 'trial-walk-1' &&
        message.relevantModeCount === 0,
    ),
  );
  assert.equal(
    fixture.messages.some((message) => message.phase === 'running'),
    false,
  );
  await current.sessions.walk.run({ obs: new Float32Array(61) });
  assert.ok(
    fixture.messages.some(
      (message) =>
        message.phase === 'running' &&
        message.relevantModeCount === 1 &&
        message.trialId === 'trial-walk-1',
    ),
  );
  fixture.send({ type: 'rdk-policy-stop' });
  assert.equal(cleared, 1);
  assert.ok(
    fixture.messages.some(
      (message) => message.type === 'rdk-policy-status' && message.phase === 'stopped',
    ),
  );
  fixture.window.fetch = async () => ({
    ok: true,
    json: async () => ({
      run: {
        id: 'run-recurrent',
        taskId: 'balance-stilts',
        backend: 'local',
        status: 'completed',
        artifact: { format: 'onnx' },
      },
    }),
  });
  fixture.send({ type: 'rdk-policy-run', runId: 'run-recurrent', apiRoot: '/api/sim2real' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loaded.length, 1);
  assert.ok(
    fixture.messages.some(
      (message) => message.phase === 'failed' && /单鸭场景/.test(message.message),
    ),
  );
});

test('cancelled delayed policy load is cleared before a replacement trial loads', async (t) => {
  let releaseFirst;
  const firstLoad = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const calls = [];
  let activeUrl = '';
  let cleared = 0;
  const current = policyRuntime();
  const loader = current.loadCustomPolicy;
  const clear = current.clearCustomPolicy;
  current.loadCustomPolicy = async (url) => {
    calls.push(url);
    if (calls.length === 1) await firstLoad;
    activeUrl = url;
    await loader.call(current, url);
  };
  current.clearCustomPolicy = () => {
    activeUrl = '';
    cleared++;
    clear.call(current);
  };
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  fixture.window.fetch = async (url) => ({
    ok: true,
    json: async () => ({
      run: {
        id: String(url).split('/').at(-1),
        taskId: 'walk',
        backend: 'local',
        status: 'completed',
        artifact: { format: 'onnx' },
      },
    }),
  });
  fixture.send({ type: 'rdk-policy-run', runId: 'run-old', apiRoot: '/api/sim2real' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 1);
  fixture.send({ type: 'rdk-policy-stop' });
  fixture.send({ type: 'rdk-policy-run', runId: 'run-new', apiRoot: '/api/sim2real' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    calls.length,
    1,
    'the replacement must await completion and cleanup of the old loader',
  );
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 2);
  assert.equal(cleared, 1);
  assert.match(activeUrl, /\/run-new\/policy\.onnx$/);
  assert.ok(
    fixture.messages.some((message) => message.phase === 'armed' && message.runId === 'run-new'),
  );
  await current.sessions.walk.run({ obs: new Float32Array(61) });
  assert.ok(
    fixture.messages.some((message) => message.phase === 'running' && message.runId === 'run-new'),
  );
  assert.equal(
    fixture.messages.some((message) => message.phase === 'running' && message.runId === 'run-old'),
    false,
  );
});

test('resolved loaders must expose the requested ONNX session before a trial can arm', async (t) => {
  for (const mismatch of [false, true]) {
    const current = policyRuntime({
      async loadCustomPolicy() {
        if (mismatch)
          this.customPolicy = {
            ref: 'https://other.test/unrelated.onnx',
            session: sessionFixture(),
          };
      },
    });
    const fixture = bridgeFixture(current);
    t.after(() => fixture.dom.window.close());
    fixture.window.fetch = async () => runResponse('walk');
    fixture.send({ type: 'rdk-policy-run', runId: 'run-walk', trialId: `failed-${mismatch}` });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      fixture.messages.some((message) => ['armed', 'running'].includes(message.phase)),
      false,
    );
    assert.ok(
      fixture.messages.some(
        (message) =>
          message.phase === 'failed' &&
          /未实际装载/.test(message.message) &&
          message.trialId === `failed-${mismatch}`,
      ),
    );
    assert.equal(fixture.window.__microduckPolicy.current, null);
  }
});

test('task policies execute only in sit, kick and recovery modes and restore all native slots', async (t) => {
  const expected = { sit: ['sitstand'], kick: ['kickL', 'kickR'], recover: ['stand'] };
  for (const [taskId, slots] of Object.entries(expected)) {
    const current = policyRuntime();
    const originals = { ...current.sessions };
    const fixture = bridgeFixture(current);
    t.after(() => fixture.dom.window.close());
    fixture.window.fetch = async () => runResponse(taskId);
    fixture.send({ type: 'rdk-policy-run', runId: `run-${taskId}` });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const loaded = current.customPolicy;
    const originalRun = current.lastLoadedRun;
    assert.ok(loaded, `${taskId} graph should be loaded`);
    for (const slot of slots)
      assert.equal(current.sessions[slot], loaded.session, `${taskId} must bind ${slot}`);
    assert.equal(
      current.sessions.walk,
      originals.walk,
      'unrelated walking remains the reference graph',
    );
    const armed = fixture.messages.find((message) => message.phase === 'armed');
    assert.deepEqual(Array.from(armed.slots), slots);
    assert.equal(armed.relevantModeCount, 0);
    assert.equal(armed.trialId, undefined, 'standalone trials carry no host trial ID');
    if (taskId === 'kick') assert.match(armed.message, /Q \/ E.*踢球/);
    if (taskId === 'recover') assert.match(armed.message, /测试跌倒恢复.*恢复状态/);
    current.mode = 'walk';
    await loaded.session.run({ obs: new Float32Array(61) });
    assert.equal(fixture.window.__microduckPolicy.relevantModeCount, 0);
    if (taskId === 'recover') {
      assert.equal(fixture.window.__microduckSimulator.testRecovery(), true);
    } else current.mode = slots[0];
    await loaded.session.run({ obs: new Float32Array(61) });
    assert.equal(fixture.window.__microduckPolicy.relevantModeCount, 1);
    assert.ok(
      fixture.messages.some(
        (message) => message.phase === 'running' && message.relevantModeCount === 1,
      ),
    );
    fixture.send({ type: 'rdk-policy-stop' });
    assert.equal(current.customPolicy, null);
    for (const [slot, original] of Object.entries(originals))
      assert.equal(current.sessions[slot], original);
    assert.equal(loaded.session.run, originalRun, 'stop must release the inference wrapper');
  }
});

test('upstream watchdog and replacement restore the extra kick and recovery slots', async (t) => {
  for (const taskId of ['kick', 'recover']) {
    const current = policyRuntime();
    const originals = { ...current.sessions };
    const fixture = bridgeFixture(current);
    t.after(() => fixture.dom.window.close());
    fixture.window.fetch = async () => runResponse(taskId);
    fixture.send({ type: 'rdk-policy-run', runId: `run-${taskId}` });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const loaded = current.customPolicy;
    const originalRun = current.lastLoadedRun;
    assert.equal(typeof loaded.session.run, 'function');
    current.clearCustomPolicy(); // Upstream leaves kick/stand bound to the old graph.
    await new Promise((resolve) => setTimeout(resolve, 280));
    for (const [slot, original] of Object.entries(originals))
      assert.equal(current.sessions[slot], original);
    assert.ok(
      fixture.messages.some(
        (message) => message.phase === 'failed' && /撤销或替换/.test(message.message),
      ),
    );
    assert.equal(loaded.session.run, originalRun, 'watchdog must release the inference wrapper');
    fixture.window.fetch = async () => runResponse(taskId);
    fixture.send({ type: 'rdk-policy-run', runId: `run-${taskId}` });
    await new Promise((resolve) => setTimeout(resolve, 30));
    fixture.window.fetch = async () => runResponse('walk');
    fixture.send({ type: 'rdk-policy-run', runId: 'run-walk' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const slot of ['kickL', 'kickR', 'stand'])
      assert.equal(current.sessions[slot], originals[slot]);
    assert.equal(current.sessions.walk, current.customPolicy.session);
    fixture.send({ type: 'rdk-policy-stop' });
  }
});

test('task slots that cannot be bound fail without leaving a custom walker installed', async (t) => {
  const current = policyRuntime();
  Object.defineProperty(current.sessions, 'kickL', {
    value: current.sessions.kickL,
    writable: false,
  });
  const originalWalk = current.sessions.walk;
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  fixture.window.fetch = async () => runResponse('kick');
  fixture.send({ type: 'rdk-policy-run', runId: 'run-kick' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(current.customPolicy, null);
  assert.equal(current.sessions.walk, originalWalk);
  assert.ok(fixture.messages.some((message) => message.phase === 'failed'));
  assert.equal(
    fixture.messages.some((message) => message.phase === 'armed'),
    false,
  );
});

test('non-finite live output ends a task trial and restores its native policies', async (t) => {
  const current = policyRuntime();
  const loader = current.loadCustomPolicy;
  current.loadCustomPolicy = async (ref) => {
    await loader.call(current, ref);
    current.customPolicy.session.run = async () => ({
      actions: { data: new Float32Array(14).fill(NaN) },
    });
  };
  const original = current.sessions.stand;
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  fixture.window.fetch = async () => runResponse('recover');
  fixture.send({ type: 'rdk-policy-run', runId: 'run-recover' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  current.recovery = 'recovering';
  await current.sessions.stand.run({ obs: new Float32Array(61) });
  assert.equal(current.sessions.stand, original);
  assert.equal(current.customPolicy, null);
  assert.equal(fixture.window.__microduckPolicy.relevantModeCount, 0);
  assert.ok(
    fixture.messages.some(
      (message) => message.phase === 'failed' && /无效的 14D/.test(message.message),
    ),
  );
});

test('recorder stops before its 30 MiB JSONL cap, preserving a valid export for the parent', async (t) => {
  const current = policyRuntime({
    buildObs: () => new Float64Array(61).fill(Number.MAX_VALUE),
    lastAction: new Float64Array(14).fill(Number.MAX_VALUE),
    data: {
      qpos: new Float64Array(512).fill(Number.MAX_VALUE),
      qvel: new Float64Array(512).fill(Number.MAX_VALUE),
    },
  });
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  await new Promise((resolve) => setTimeout(resolve, 30));
  let capture;
  const originalInterval = fixture.window.setInterval;
  fixture.window.setInterval = (callback, milliseconds) => {
    if (milliseconds === 20) {
      capture = callback;
      return 123456;
    }
    return originalInterval(callback, milliseconds);
  };
  const recorder = fixture.window.__microduckRecorder;
  assert.equal(recorder.start(), true);
  for (let index = 0; index < 2000 && recorder.recording; index++) capture();
  assert.equal(
    recorder.recording,
    false,
    'the byte cap should stop recording before the frame cap',
  );
  assert.ok(recorder.sampleCount > 1000 && recorder.sampleCount < 2000);
  assert.ok(recorder.byteLength <= 30 * 1024 * 1024);
  assert.ok(recorder.byteLength > 29 * 1024 * 1024);
  const header = JSON.parse(recorder.getText().split('\n', 1)[0]);
  assert.equal(header.sampleCount, recorder.sampleCount);
  assert.match(
    fixture.window.document.querySelector('[data-recorder-status]').textContent,
    /30 MiB/,
  );
});

test('sit preset waits for reset lock; superseded task cannot run its action', async (t) => {
  const actions = [];
  const current = {
    inputLocked: true,
    resetSim() {},
    controller: { sources: [{ id: 'keyboard', onAction: (action) => actions.push(action) }] },
  };
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  fixture.send({ type: 'rdk-simulator-task', taskId: 'sit' });
  assert.deepEqual(actions, []);
  current.inputLocked = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(actions, ['sitToggle']);
  current.inputLocked = true;
  fixture.send({ type: 'rdk-simulator-task', taskId: 'sit' });
  fixture.send({ type: 'rdk-simulator-task', taskId: 'turn' });
  current.inputLocked = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(actions, ['sitToggle']);
  assert.equal(fixture.window.__microduckSimulator.taskId, 'turn');
});

test('inactive view freezes only its physical world and recorder stop returns the captured task', async (t) => {
  let steps = 0;
  let resets = 0;
  const current = {
    resetSim: () => resets++,
    model: {},
    data: { qpos: new Float64Array([0, 0, 0.3, 1, 0, 0, 0]), qvel: new Float64Array(6) },
    mujoco: { mj_step: () => steps++, mj_forward() {} },
    buildObs: () => new Float32Array(61),
    lastAction: new Float32Array(14),
  };
  const fixture = bridgeFixture(current);
  t.after(() => fixture.dom.window.close());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const recorder = fixture.window.__microduckRecorder;
  recorder.start();
  assert.equal(recorder.recording, true);
  const noticeCount = fixture.messages.filter(
    (message) => message.type === 'rdk-microduck-recording-ready',
  ).length;
  const text = recorder.stop({ notify: false });
  assert.equal(recorder.recording, false);
  assert.equal(
    fixture.messages.filter((message) => message.type === 'rdk-microduck-recording-ready').length,
    noticeCount,
    'a parent preserving a recording before navigation must not receive a stale duplicate notice',
  );
  assert.equal(JSON.parse(text.split('\n')[0]).taskId, 'walk');
  const step = current.mujoco.mj_step;
  fixture.send({ type: 'rdk-simulator-active', active: false });
  current.data.qpos[0] = 4;
  current.mujoco.mj_step(current.model, current.data);
  assert.equal(current.data.qpos[0], 0);
  assert.equal(steps, 0);
  assert.equal(recorder.start(), false);
  fixture.send({ type: 'rdk-simulator-task', taskId: 'turn' });
  assert.equal(resets, 0);
  fixture.send({ type: 'rdk-simulator-active', active: true });
  assert.equal(current.mujoco.mj_step, step);
  assert.equal(resets, 1);
  assert.equal(fixture.window.__microduckSimulator.taskId, 'turn');
});

test('control legend uses the simulator Q/E kick contract', () => {
  assert.match(overlaySource, /<kbd>Q · E<\/kbd><span>左 \/ 右踢球<\/span>/);
  assert.doesNotMatch(overlaySource, /<kbd>A \/ Q · E<\/kbd>/);
});

test('browser recorder captures contract observations and actions from window.rl', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><main>MicroDuck simulation</main></body></html>',
    {
      url: 'https://studio.example.test/mujoco/microduck/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  window.URL.createObjectURL = () => 'blob:microduck-test';
  window.URL.revokeObjectURL = () => {};
  const controllerActions = [];
  window.rl = {
    buildObs: () => Float32Array.from({ length: 61 }, (_, index) => index / 100),
    lastAction: Float32Array.from({ length: 14 }, (_, index) => index / 10),
    cmd: Float32Array.from({ length: 13 }, (_, index) => index / 20),
    mode: 'kickL',
    loco: 'legs',
    data: {
      qpos: Float32Array.from({ length: 20 }, (_, index) => index),
      qvel: Float32Array.from({ length: 20 }, (_, index) => index / 2),
    },
    controller: {
      sources: [
        {
          id: 'keyboard',
          onAction: (action) => controllerActions.push(action),
        },
      ],
    },
  };

  window.eval(overlaySource);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const recorder = window.__microduckRecorder;
  assert.ok(recorder, 'recorder API should be exposed for UI and smoke tests');
  assert.equal(recorder.active, false);
  assert.equal(recorder.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 70));
  recorder.stop();

  assert.equal(recorder.active, false);
  assert.ok(
    recorder.sampleCount >= 2,
    `expected at least two samples, got ${recorder.sampleCount}`,
  );
  assert.equal(recorder.lastHeader.contractId, 'microduck-policy-v1');
  assert.equal(recorder.lastHeader.observationSize, 61);
  assert.equal(recorder.lastHeader.actionSize, 14);

  // The upstream keyboard source has no B binding.  The overlay owns B as a
  // desktop convenience and must route it through the controller action bus
  // when the touch button is not mounted.
  window.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyB',
      key: 'b',
    }),
  );
  assert.ok(controllerActions.includes('quack'), 'desktop B should dispatch the quack action');

  const alternateKick = window.document.querySelector('[data-mobile-action="alternate-kick"]');
  assert.ok(alternateKick, 'mobile action panel should expose alternate kick');
  alternateKick.click();
  assert.ok(
    controllerActions.includes('alternateKick'),
    'alternate kick should use the controller fallback',
  );

  recorder.clear();
  assert.equal(recorder.sampleCount, 0);
  recorder.destroy();
  dom.window.close();
});

for (const [entry, apiBase] of [
  ['/mujoco/microduck/', ''],
  ['/robotics-learning/mujoco/microduck/', '/robotics-learning'],
  ['/sim2real/mujoco/microduck/', '/sim2real'],
  ['/mujoco/microduck/?rdkApi=%2Frobotics-learning', '/robotics-learning'],
  [
    '/mujoco/microduck/?rdkApi=https%3A%2F%2Fstudio.example.test%2Frobotics-learning',
    '/robotics-learning',
  ],
  ['/robotics-learning/mujoco/microduck/?rdkApi=https%3A%2F%2Fforeign.test', '/robotics-learning'],
]) {
  test(`policy panel loads a trained run into its mounted API: ${entry}`, async (t) => {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><main>MicroDuck simulation</main></body></html>',
      {
        url: `https://studio.example.test${entry}`,
        runScripts: 'dangerously',
        pretendToBeVisual: true,
      },
    );
    t.after(() => dom.window.close());
    const { window } = dom;
    window.matchMedia = () => ({ matches: false });

    const loaded = [];
    const cleared = [];
    window.rl = policyRuntime({
      buildObs: () => Float32Array.from({ length: 61 }),
      lastAction: Float32Array.from({ length: 14 }),
      loadCustomPolicy: async (ref) => {
        loaded.push(ref);
        window.rl.customPolicy = { ref, session: sessionFixture(), slot: 'walk' };
        window.rl.sessions.walk = window.rl.customPolicy.session;
      },
      clearCustomPolicy: () => {
        cleared.push(true);
        window.rl.customPolicy = null;
      },
    });

    const runs = [
      {
        id: 'run-trained',
        backend: 'local',
        status: 'completed',
        mock: false,
        taskId: 'walk',
        modelId: 'microduck-official',
        artifact: { format: 'onnx', sha256: 'a'.repeat(64) },
        metrics: { iterations: 1500 },
      },
      // Must be filtered out: mock provenance, unfinished, or not a policy.
      {
        id: 'run-mock',
        backend: 'local',
        status: 'completed',
        mock: true,
        artifact: { format: 'onnx' },
      },
      { id: 'run-running', backend: 'local', status: 'running', artifact: { format: 'onnx' } },
      {
        id: 'run-browser',
        backend: 'browser',
        status: 'completed',
        artifact: { format: 'onnx' },
      },
    ];
    const requested = [];
    window.fetch = async (url) => {
      requested.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => (String(url).endsWith('/runs') ? { ok: true, runs } : { run: runs[0] }),
      };
    };

    window.eval(overlaySource);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const api = window.__microduckPolicy;
    assert.ok(api, 'policy API should be exposed for UI and smoke tests');
    await api.refresh();
    assert.equal(requested.length, 1);
    assert.equal(requested[0], `${apiBase}/api/sim2real/runs`);
    assert.deepEqual(
      api.runs.map((run) => run.id),
      ['run-trained'],
      'only completed, real, ONNX-bearing local runs may be offered',
    );

    await api.load('run-trained');
    assert.equal(loaded.length, 1);
    assert.equal(
      loaded[0],
      `https://studio.example.test${apiBase}/api/sim2real/runs/run-trained/policy.onnx`,
      'upstream accepts only absolute http(s) .onnx URLs',
    );
    assert.equal(
      requested[1],
      `https://studio.example.test${apiBase}/api/sim2real/runs/run-trained`,
    );
    assert.equal(api.current, 'run-trained');

    // A policy the simulator rejects must be reported, not swallowed.
    window.rl.loadCustomPolicy = async () => {
      throw new Error('outputs 12 actions (sim drives 14)');
    };
    await api.load('run-trained');
    assert.equal(api.current, null, 'a rejected load must not be remembered as active');
    const status = window.document.querySelector('#rdk-microduck-policy [data-policy-status]');
    assert.match(status.textContent, /outputs 12 actions/);

    api.clear();
    assert.equal(cleared.length, 1);
    api.destroy();
    dom.window.close();
  });
}

test('policy refresh distinguishes malformed responses and authentication errors from an empty list', async (t) => {
  const fixture = bridgeFixture(policyRuntime());
  t.after(() => fixture.dom.window.close());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const api = fixture.window.__microduckPolicy;
  const panel = fixture.window.document.querySelector('#rdk-microduck-policy');
  const status = panel.querySelector('[data-policy-status]');
  for (const payload of [{}, { ok: false, runs: [] }, { ok: true, runs: 'invalid' }]) {
    fixture.window.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
    await api.refresh();
    assert.equal(panel.classList.contains('is-error'), true);
    assert.match(status.textContent, /响应格式错误/);
    assert.deepEqual(Array.from(api.runs), []);
  }
  fixture.window.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, runs: [] }),
  });
  await api.refresh();
  assert.equal(status.textContent, '暂无可用策略');
  assert.equal(panel.classList.contains('is-error'), false);
  fixture.window.fetch = async () => ({ ok: false, status: 401 });
  await api.refresh();
  assert.equal(panel.classList.contains('is-error'), true);
  assert.match(status.textContent, /401/);
  assert.deepEqual(Array.from(api.runs), []);
  assert.doesNotMatch(panel.querySelector('[data-policy-list]').textContent, /还没有带 ONNX/);
});

test('policy panel replaces the boot waiting state when its runtime becomes ready', async (t) => {
  const fixture = bridgeFixture();
  t.after(() => fixture.dom.window.close());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const status = fixture.window.document.querySelector(
    '#rdk-microduck-policy [data-policy-status]',
  );
  assert.equal(status.textContent, '等待仿真引擎');
  fixture.window.rl = policyRuntime({
    buildObs: () => new Float32Array(61),
    lastAction: new Float32Array(14),
  });
  assert.equal(
    fixture.window.__microduckRecorder.start(),
    true,
    'the same runtime supports recording',
  );
  fixture.window.__microduckRecorder.stop();
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.match(status.textContent, /引擎已就绪/);
  delete fixture.window.rl.loadCustomPolicy;
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(
    status.textContent,
    '当前仿真版本未开放策略装载',
    'a running older engine must not claim it is still booting',
  );
});
