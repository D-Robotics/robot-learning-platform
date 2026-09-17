import { describe, expect, it } from 'vitest';

import {
  applyTaskEngineRecommendation,
  normalizeTrainingSpec,
  trainingSpecForProfile,
} from './sim2real.js';

describe('training spec engine routing', () => {
  it('accepts the engine allowlist and rejects unknown ids at submission time', () => {
    const mjx = normalizeTrainingSpec({ profile: 'smoke', engine: 'mjx-ppo' });
    expect(mjx.errors).toEqual([]);
    expect(mjx.spec?.engine).toBe('mjx-ppo');

    const starter = normalizeTrainingSpec({ profile: 'smoke', engine: 'starter-ppo' });
    expect(starter.spec?.engine).toBe('starter-ppo');

    // The upstream MicroDuck RL stack (mjlab + MuJoCo Warp + rsl-rl) is a
    // first-class engine id, not a worker-local alias: a submission that asks
    // for it must survive platform validation.
    const microduckRl = normalizeTrainingSpec({ profile: 'smoke', engine: 'microduck-rl' });
    expect(microduckRl.errors).toEqual([]);
    expect(microduckRl.spec?.engine).toBe('microduck-rl');

    const typo = normalizeTrainingSpec({ profile: 'smoke', engine: 'mjx' });
    expect(typo.spec).toBeUndefined();
    expect(typo.errors[0]).toContain(
      'training.engine must be starter-ppo, mjx-ppo or microduck-rl',
    );

    const omitted = normalizeTrainingSpec({ profile: 'smoke' });
    expect(omitted.spec?.engine).toBeUndefined();
  });

  it('keeps an explicit engine choice over any task recommendation', () => {
    const explicit = applyTaskEngineRecommendation(trainingSpecForProfile('smoke'), 'mjx-ppo');
    expect(explicit.engine).toBe('mjx-ppo');

    const userWins = applyTaskEngineRecommendation(
      { ...trainingSpecForProfile('smoke'), engine: 'starter-ppo' },
      'mjx-ppo',
    );
    expect(userWins.engine).toBe('starter-ppo');
  });

  it('injects only the non-default recommendation so single-engine workers stay compatible', () => {
    const kinematic = applyTaskEngineRecommendation(trainingSpecForProfile('smoke'), 'starter-ppo');
    expect(kinematic.engine).toBeUndefined();
    const none = applyTaskEngineRecommendation(trainingSpecForProfile('smoke'));
    expect(none.engine).toBeUndefined();
    const junk = applyTaskEngineRecommendation(trainingSpecForProfile('smoke'), 'isaac-lab');
    expect(junk.engine).toBeUndefined();
  });
});
