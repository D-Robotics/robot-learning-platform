import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const overlaySource = await readFile(
  new URL('./microduck-community-overlay.js', import.meta.url),
  'utf8',
);

test('control legend uses the simulator Q/E kick contract', () => {
  assert.match(overlaySource, /<kbd>Q · E<\/kbd><span>左 \/ 右踢球<\/span>/);
  assert.doesNotMatch(overlaySource, /<kbd>A \/ Q · E<\/kbd>/);
});

test('recorder pairs immutable pre-inference observation with that inference action', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://studio.example.test/mujoco/microduck/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  let finish;
  const session = {
    inputNames: ['observation'],
    outputNames: ['action'],
    run: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const originalRun = session.run;
  const observation = new Float32Array(61);
  observation[0] = 3;
  observation.fill(0.1, 34, 48);
  window.rl = {
    sessions: { walk: session },
    buildObs: () => observation,
    lastAction: new Float32Array(14).fill(0.1),
    data: { time: 1, qpos: [0, 0, 0.118, 1, 0, 0, 0], qvel: [0, 0, 0, 0, 0, 0] },
  };
  try {
    window.eval(overlaySource);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const recorder = window.__microduckRecorder;
    assert.equal(recorder.start(), true);
    assert.equal(recorder.sampleCount, 0, 'Starting or waiting must not fabricate an inference');
    const pending = session.run({ observation: { data: observation } });
    observation[0] = 99;
    finish({ action: { data: new Float32Array(14).fill(0.2) } });
    await pending;
    window.rl.lastAction.fill(0.2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    recorder.stop();
    assert.equal(recorder.sampleCount, 1, 'One completed inference must produce exactly one pair');
    const [header, sample] = recorder.getText().trim().split('\n').map(JSON.parse);
    assert.equal(header.pairing, 'policy-inference-v1');
    assert.equal(sample.done, true, 'Stopping closes the recorded episode');
    assert.equal(sample.observation[0], 3, 'The tensor must be copied before inference awaits');
    assert.ok(Math.abs(sample.observation[34] - 0.1) < 1e-7);
    assert.ok(Math.abs(sample.action[0] - 0.2) < 1e-7);
    assert.equal(session.run, originalRun, 'Stopping restores the exact upstream session method');
    assert.equal(recorder.start(), true);
    const previousRecording = session.run({ observation: { data: observation } });
    const finishPrevious = finish;
    recorder.stop();
    assert.equal(recorder.start(), true);
    const currentRecording = session.run({ observation: { data: observation } });
    const finishCurrent = finish;
    finishPrevious({ action: { data: new Float32Array(14).fill(0.3) } });
    await previousRecording;
    assert.equal(
      recorder.sampleCount,
      0,
      'A stopped recording cannot leak into the next recording',
    );
    finishCurrent({ action: { data: new Float32Array(14).fill(0.4) } });
    await currentRecording;
    recorder.stop();
    assert.equal(recorder.sampleCount, 1);
    const currentSample = JSON.parse(recorder.getText().trim().split('\n')[1]);
    assert.ok(Math.abs(currentSample.action[0] - 0.4) < 1e-7);
    recorder.destroy();
  } finally {
    dom.window.close();
  }
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

  const session = {
    inputNames: ['observation'],
    outputNames: ['action'],
    run: async () => ({ action: { data: window.rl.lastAction } }),
  };
  window.rl.sessions = { walk: session };

  window.eval(overlaySource);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const recorder = window.__microduckRecorder;
  assert.ok(recorder, 'recorder API should be exposed for UI and smoke tests');
  assert.equal(recorder.active, false);
  assert.equal(recorder.start(), true);
  await session.run({ observation: { data: window.rl.buildObs() } });
  await session.run({ observation: { data: window.rl.buildObs() } });
  recorder.stop();

  assert.equal(recorder.active, false);
  assert.ok(
    recorder.sampleCount >= 2,
    `expected at least two samples, got ${recorder.sampleCount}`,
  );
  assert.equal(recorder.lastHeader.contractId, 'microduck-policy-v1');
  assert.equal(recorder.lastHeader.observationSize, 61);
  assert.equal(recorder.lastHeader.actionSize, 14);
  const append = window.document.querySelector('[data-recorder-append]');
  assert.equal(append.disabled, false);
  append.click();
  await session.run({ observation: { data: window.rl.buildObs() } });
  await session.run({ observation: { data: window.rl.buildObs() } });
  recorder.stop();
  const [header, ...samples] = recorder.getText().trim().split('\n').map(JSON.parse);
  assert.equal(header.episodes, 2);
  assert.equal(samples.length, 4);
  assert.deepEqual(
    samples.map((sample) => sample.done === true),
    [false, true, false, true],
  );
  assert.ok(samples[2].time > samples[1].time, 'Appended episode keeps a monotonic replay clock');

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

test('policy panel loads a trained run into window.rl.loadCustomPolicy', async () => {
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

  const loaded = [];
  const cleared = [];
  window.rl = {
    buildObs: () => Float32Array.from({ length: 61 }),
    lastAction: Float32Array.from({ length: 14 }),
    loadCustomPolicy: async (ref) => {
      loaded.push(ref);
    },
    clearCustomPolicy: () => cleared.push(true),
  };

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
      json: async () => ({ runs }),
    };
  };

  window.eval(overlaySource);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const api = window.__microduckPolicy;
  assert.ok(api, 'policy API should be exposed for UI and smoke tests');
  await api.refresh();
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/api\/sim2real\/runs$/);
  assert.deepEqual(
    api.runs.map((run) => run.id),
    ['run-trained'],
    'only completed, real, ONNX-bearing local runs may be offered',
  );

  await api.load('run-trained');
  assert.equal(loaded.length, 1);
  assert.match(
    loaded[0],
    /^https:\/\/studio\.example\.test\/api\/sim2real\/runs\/run-trained\/policy\.onnx$/,
    'upstream accepts only absolute http(s) .onnx URLs',
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
