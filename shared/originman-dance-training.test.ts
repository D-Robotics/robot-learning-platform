import { describe, expect, it } from 'vitest';
import {
  DANCE_REWARD_LIMITS,
  ORIGINMAN_DANCE_SECTION_TYPES,
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
      numEnvs: 64,
      originmanDance: { ...dance, seed: 7, trainingSteps: 500_000, rewardTuning },
    });
  });

  it('accepts each new action at the API boundary and preserves the eight-section cap', () => {
    const sections = [
      'single-arm-wave',
      'arms-overhead',
      'cross-and-open',
      'side-lean',
      'alternating-knee-lift',
      'side-tap',
    ].map((type) => ({ type, beats: 4, intensity: 0.6 }));
    expect(ORIGINMAN_DANCE_SECTION_TYPES).toHaveLength(10);
    expect(normalizeOriginmanDanceTraining({ ...dance, sections })?.sections).toEqual(sections);
    expect(
      normalizeOriginmanDanceTraining({ ...dance, sections: sections.concat(sections) }),
    ).toBeNull();
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
        numEnvs: 65,
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
