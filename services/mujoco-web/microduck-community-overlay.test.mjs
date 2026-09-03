import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const overlaySource = await readFile(new URL('./microduck-community-overlay.js', import.meta.url), 'utf8');

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
  assert.ok(recorder.sampleCount >= 2, `expected at least two samples, got ${recorder.sampleCount}`);
  assert.equal(recorder.lastHeader.contractId, 'microduck-policy-v1');
  assert.equal(recorder.lastHeader.observationSize, 61);
  assert.equal(recorder.lastHeader.actionSize, 14);

  recorder.clear();
  assert.equal(recorder.sampleCount, 0);
  recorder.destroy();
  dom.window.close();
});
