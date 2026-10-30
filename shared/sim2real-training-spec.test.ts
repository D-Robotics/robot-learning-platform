import { describe, expect, it } from 'vitest';

import {
  applyTaskEngineRecommendation,
  normalizeTrainingSpec,
  trainingSpecForProfile,
} from './sim2real.js';

describe('training spec engine routing', () => {
  it.each(['smoke', 'low-vram', 'standard', 'high-vram'])(
    'defaults BC to 100 epochs for %s instead of an RL iteration budget',
    (profile) => {
      const result = normalizeTrainingSpec({ profile, engine: 'offline-bc' });
      expect(result.errors).toEqual([]);
      expect(result.spec).toMatchObject({ engine: 'offline-bc', maxIterations: 100, numEnvs: 1 });
      expect(result.spec?.algorithm).toBeUndefined();
    },
  );
  it.each([1, 100, 10_000])('preserves an explicit legal BC budget of %i', (maxIterations) => {
    const result = normalizeTrainingSpec({ engine: 'offline-bc', maxIterations });
    expect(result.errors).toEqual([]);
    expect(result.spec?.maxIterations).toBe(maxIterations);
  });
  it.each([0, -1, 1.2, 10_001, 100_000, null, true, '100'])(
    'rejects invalid BC epoch budget %s with a useful error',
    (maxIterations) => {
      const result = normalizeTrainingSpec({ engine: 'offline-bc', maxIterations });
      expect(result.spec).toBeUndefined();
      expect(result.errors[0]).toContain('1 到 10000');
    },
  );
  it.each([{ algorithm: 'ppo' }, { algorithm: 'sac' }, { numEnvs: 1 }, { numEnvs: 64 }])(
    'refuses irrelevant RL knobs for BC rather than silently ignoring %j',
    (knob) => {
      const result = normalizeTrainingSpec({ engine: 'offline-bc', ...knob });
      expect(result.spec).toBeUndefined();
      expect(result.errors[0]).toContain('offline-bc');
    },
  );
  it('preserves other engines and their explicit and profile budgets', () => {
    for (const profile of ['smoke', 'low-vram', 'standard', 'high-vram'] as const) {
      expect(normalizeTrainingSpec({ profile, engine: 'starter-ppo' }).spec).toEqual({
        ...trainingSpecForProfile(profile),
        engine: 'starter-ppo',
      });
    }
    expect(
      normalizeTrainingSpec({
        engine: 'starter-ppo',
        maxIterations: 100_000,
        numEnvs: 64,
        algorithm: 'sac',
      }).spec,
    ).toMatchObject({ maxIterations: 100_000, numEnvs: 64, algorithm: 'sac' });
  });
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

    const microduckFootball = normalizeTrainingSpec({
      profile: 'smoke',
      engine: 'microduck-football',
    });
    expect(microduckFootball.errors).toEqual([]);
    expect(microduckFootball.spec?.engine).toBe('microduck-football');

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
      'offline-bc',
      'act',
      'diffusion-policy',
      'smolvla',
      'microduck-football',
      'originman-straight',
      'isaac-lab',
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
    const microduck = applyTaskEngineRecommendation(
      trainingSpecForProfile('smoke'),
      'microduck-rl',
    );
    expect(microduck.engine).toBe('microduck-rl');
    // The Isaac Lab upstream pack carries a real recommendation: a submission
    // that picks it must be routed to a worker that registered the engine
    // (a worker without it fails closed, never falls back).
    const isaac = applyTaskEngineRecommendation(trainingSpecForProfile('smoke'), 'isaac-lab');
    expect(isaac.engine).toBe('isaac-lab');
    const none = applyTaskEngineRecommendation(trainingSpecForProfile('smoke'));
    expect(none.engine).toBeUndefined();
    const junk = applyTaskEngineRecommendation(trainingSpecForProfile('smoke'), 'isaac-sim');
    expect(junk.engine).toBeUndefined();
  });
});
