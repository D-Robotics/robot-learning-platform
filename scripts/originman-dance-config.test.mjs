import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOriginmanDanceConfig,
  REWARD_TUNING_LIMITS,
} from '../plugins/rdk-robot-learning-platform/scripts/originman-dance-config.mjs';

const base = {
  schemaVersion: 1,
  title: 'probe',
  bpm: 100,
  sections: [{ type: 'weight-shift', beats: 8, intensity: 0.5 }],
};

test('dance config omits rewardTuning when the learner provides none', () => {
  const resolved = resolveOriginmanDanceConfig({ ...base });
  assert.equal(resolved.rewardTuning, undefined);
});

test('dance config keeps provided reward overrides only', () => {
  const resolved = resolveOriginmanDanceConfig({
    ...base,
    rewardTuning: { squatDepthM: 0.05, tiltPenalty: 4 },
  });
  assert.deepEqual(resolved.rewardTuning, { squatDepthM: 0.05, tiltPenalty: 4 });
});

test('dance config rejects unknown reward keys', () => {
  assert.throws(
    () => resolveOriginmanDanceConfig({ ...base, rewardTuning: { armSwing: 1 } }),
    /unknown field armSwing/,
  );
});

test('dance config rejects out-of-range reward values', () => {
  assert.throws(
    () => resolveOriginmanDanceConfig({ ...base, rewardTuning: { workPenalty: 9.9 } }),
    /rewardTuning.workPenalty/,
  );
});

test('every reward knob is bounded', () => {
  for (const bounds of Object.values(REWARD_TUNING_LIMITS)) {
    assert.ok(bounds.min < bounds.max);
  }
});

test('dance training tool exposes a bounded numEnvs argument', async () => {
  const { DANCE_TRAINING_TOOLS } =
    await import('../plugins/rdk-robot-learning-platform/scripts/dance-training.mjs');
  const tool = DANCE_TRAINING_TOOLS.find((t) => t.name === 'rdk_originman_dance_train');
  const numEnvs = tool.inputSchema.properties.numEnvs;
  assert.equal(numEnvs.type, 'integer');
  assert.equal(numEnvs.minimum, 1);
  assert.equal(numEnvs.maximum, 16);
  assert.equal(numEnvs.default, 8);
  assert.ok(tool.description.includes('numEnvs'));
});
