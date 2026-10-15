import assert from 'node:assert/strict';
import test from 'node:test';
import { resetSimulatorEpisode, summarizePolicyEpisode } from './browser-bc-acceptance.mjs';

test('episode preparation waits for reset animation to release commands', async () => {
  const previous = globalThis.window;
  const rl = {
    data: { time: 10 },
    inputLocked: false,
    respawnActive: false,
    clearCustomPolicy() {},
    resetSim() {
      this.data.time = 0;
      this.inputLocked = this.respawnActive = true;
      setTimeout(() => {
        this.inputLocked = this.respawnActive = false;
      }, 35);
    },
  };
  globalThis.window = { rl };
  try {
    const result = await resetSimulatorEpisode();
    assert.deepEqual(result, { resetTimeBefore: 10, resetTimeAfter: 0, inputReleased: true });
    assert.equal(rl.inputLocked || rl.respawnActive, false);
  } finally {
    globalThis.window = previous;
  }
});

function standingSamples() {
  return Array.from({ length: 151 }, (_, index) => ({
    elapsed: index * 0.02,
    time: index * 0.02,
    qpos: [0, 0, 0.118, 1, 0, 0, 0],
    qvel: [0, 0, 0, 0, 0, 0],
    observation: [0, 0, 0, 0, 0, -1, ...Array(55).fill(0)],
    action: Array(14).fill(0),
    recovery: null,
    controllerMatches: true,
  }));
}

test('a fallback to reference cannot pass the trained-policy episode', () => {
  const samples = standingSamples();
  assert.equal(summarizePolicyEpisode(samples, [0, 0, 0]).passed, true);
  samples[80].controllerMatches = false;
  const result = summarizePolicyEpisode(samples, [0, 0, 0]);
  assert.equal(result.passed, false);
  assert.equal(result.controllerRetained, false);
});

test('an automatic reset does not hide an earlier fall', () => {
  const samples = standingSamples();
  samples[80].qpos[2] = 0.03;
  samples[81].time = 0;
  const result = summarizePolicyEpisode(samples, [0, 0, 0]);
  assert.equal(result.passed, false);
  assert.equal(result.fell, true);
  assert.equal(result.automaticReset, true);
});

test('standing still cannot satisfy the requested forward command', () => {
  const samples = standingSamples();
  for (const sample of samples) sample.observation[48] = 0.2;
  const result = summarizePolicyEpisode(samples, [0.2, 0, 0]);
  assert.equal(result.passed, false);
  assert.ok(Math.abs(result.linearVelocityRmseMps - 0.2) < 1e-8);
  assert.equal(result.commandMaxError, 0);
});

test('an input-locked episode cannot satisfy a nonzero requested command', () => {
  const samples = standingSamples();
  for (const sample of samples) sample.qvel[0] = 0.2;
  const result = summarizePolicyEpisode(samples, [0.2, 0, 0]);
  assert.equal(result.linearVelocityRmseMps, 0);
  assert.equal(result.commandMaxError, 0.2);
  assert.equal(result.passed, false);
});

test('a frozen or non-finite simulation cannot be counted as measured quality', () => {
  const samples = standingSamples();
  for (const sample of samples) sample.time = 0;
  assert.equal(summarizePolicyEpisode(samples, [0, 0, 0]).passed, false);
  samples[50].qvel[0] = NaN;
  assert.equal(summarizePolicyEpisode(samples, [0, 0, 0]).finite, false);
});
