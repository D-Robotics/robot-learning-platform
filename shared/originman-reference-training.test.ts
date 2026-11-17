import { describe, expect, it } from 'vitest';
import { normalizeTrainingSpec } from './sim2real.js';
import {
  ORIGINMAN_REFERENCE_ENGINE,
  originmanReferenceCalibration,
  originmanReferenceExample,
  validateOriginmanReferenceTrajectory,
} from './originman-reference-training.js';

describe('OriginMan trajectory following', () => {
  it('keeps relative positions, joint order and physical servo order distinct', () => {
    const example = originmanReferenceExample();
    expect(validateOriginmanReferenceTrajectory(example)).toEqual(example);
    expect(example.joint_pos[0].every((offset) => offset === 0)).toBe(true);
    expect(example.joint_names).toHaveLength(20);
    expect(originmanReferenceCalibration.robot.servoOrder).toHaveLength(18);
    expect(originmanReferenceCalibration.robot.servoOrder[0]).toBe('l_ank_roll');
    expect(originmanReferenceCalibration.pwmScale.evidence).toContain('unmeasured');
  });

  it('refuses mismatched frequency, actuator order, motion discontinuities and head commands', () => {
    const example = originmanReferenceExample();
    expect(() => validateOriginmanReferenceTrajectory({ ...example, fps: 25 })).toThrow(/50 Hz/);
    expect(() =>
      validateOriginmanReferenceTrajectory({
        ...example,
        joint_names: [...example.joint_names].reverse(),
      }),
    ).toThrow(/关节/);
    example.joint_pos[25][0] = 0.01;
    expect(() => validateOriginmanReferenceTrajectory(example)).toThrow(/头部/);
    example.joint_pos[25][0] = 0;
    example.joint_pos[25][15] = 1.0;
    expect(() => validateOriginmanReferenceTrajectory(example)).toThrow(/上一帧/);
  });

  it('requires the independent PPO engine and a rollout-aligned budget', () => {
    const originmanReference = {
      trajectory: originmanReferenceExample(),
      trainingSteps: 8192,
      seed: 7,
    };
    const request = {
      profile: 'smoke',
      algorithm: 'ppo',
      numEnvs: 8,
      video: true,
      engine: ORIGINMAN_REFERENCE_ENGINE,
      originmanReference,
    };
    expect(normalizeTrainingSpec(request).spec?.originmanReference).toEqual(originmanReference);
    expect(
      normalizeTrainingSpec({ ...request, engine: 'originman-dance-ppo' }).spec,
    ).toBeUndefined();
    expect(normalizeTrainingSpec({ ...request, video: false }).spec).toBeUndefined();
    expect(
      normalizeTrainingSpec({
        ...request,
        originmanReference: { ...originmanReference, trainingSteps: 8193 },
      }).spec,
    ).toBeUndefined();
  });
});
