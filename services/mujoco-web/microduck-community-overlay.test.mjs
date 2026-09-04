import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const overlaySource = await readFile(new URL('./microduck-community-overlay.js', import.meta.url), 'utf8');

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
      sources: [{
        id: 'keyboard',
        onAction: (action) => controllerActions.push(action),
      }],
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

  // The upstream keyboard source has no B binding.  The overlay owns B as a
  // desktop convenience and must route it through the controller action bus
  // when the touch button is not mounted.
  window.dispatchEvent(new window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'KeyB',
    key: 'b',
  }));
  assert.ok(controllerActions.includes('quack'), 'desktop B should dispatch the quack action');

  const alternateKick = window.document.querySelector('[data-mobile-action="alternate-kick"]');
  assert.ok(alternateKick, 'mobile action panel should expose alternate kick');
  alternateKick.click();
  assert.ok(controllerActions.includes('alternateKick'), 'alternate kick should use the controller fallback');

  recorder.clear();
  assert.equal(recorder.sampleCount, 0);
  recorder.destroy();
  dom.window.close();
});
