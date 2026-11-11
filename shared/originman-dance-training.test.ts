import { describe, expect, it } from 'vitest';
import {
  DANCE_REWARD_LIMITS,
  normalizeOriginmanDanceTraining,
} from './originman-dance-training.js';
import { normalizeTrainingSpec } from './sim2real.js';

const dance = {
  schemaVersion: 1,
  title: 'Dance fixture',
  bpm: 100,
  sections: [{ type: 'alternating-arms', beats: 8, intensity: 0.4 }],
};

describe('OriginMan dance platform contract', () => {
  it('preserves all bounded reward values and normalizes omitted budget and seed', () => {
    const rewardTuning = Object.fromEntries(
      Object.entries(DANCE_REWARD_LIMITS).map(([key, [min, max]]) => [key, (min + max) / 2]),
    );
    const normalized = normalizeTrainingSpec({
      engine: 'originman-dance-ppo',
      algorithm: 'ppo',
      originmanDance: { ...dance, rewardTuning },
    });
    expect(normalized.errors).toEqual([]);
    expect(normalized.spec).toMatchObject({
      numEnvs: 8,
      originmanDance: { ...dance, seed: 7, trainingSteps: 500_000, rewardTuning },
    });
  });

  it('rejects incorrect engines, excessive parallelism and arbitrary reward keys', () => {
    expect(
      normalizeTrainingSpec({ engine: 'starter-ppo', algorithm: 'ppo', originmanDance: dance })
        .spec,
    ).toBeUndefined();
    expect(
      normalizeTrainingSpec({
        engine: 'originman-dance-ppo',
        algorithm: 'ppo',
        originmanDance: dance,
        numEnvs: 17,
      }).spec,
    ).toBeUndefined();
    expect(
      normalizeOriginmanDanceTraining({ ...dance, rewardTuning: { qualityThreshold: 0 } }),
    ).toBeNull();
    expect(
      normalizeOriginmanDanceTraining({ ...dance, rewardTuning: { squatWeight: 100 } }),
    ).toBeNull();
  });
});
