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
    expect(typo.errors[0]).toContain('training.engine must be one of');

    // Every engine the training page offers must survive platform validation:
    // the selector is the public contract, and a 400 on submit would make the
    // option a lie. These are the repo-shipped engines registered per worker
    // via RDK_SIM2REAL_TRAIN_ENGINES_JSON.
    for (const engine of [
      'visual-ppo',
      'dm-control-ppo',
      'mjlab-rsl-rl',
      'act',
      'diffusion-policy',
      'smolvla',
    ]) {
      const submission = normalizeTrainingSpec({ profile: 'smoke', engine });
      expect(submission.errors).toEqual([]);
      expect(submission.spec?.engine).toBe(engine);
    }

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
