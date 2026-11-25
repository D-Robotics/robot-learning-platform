import { describe, expect, it } from 'vitest';
import { normalizeTrainingSpec } from './sim2real.js';
import { composeOriginmanReference } from '../services/sim2real-web/public/originman-reference-compose.mjs';
import {
  ORIGINMAN_REFERENCE_ENGINE,
  originmanReferenceCalibration,
  originmanReferenceExample,
  validateOriginmanReferenceTrajectory,
} from './originman-reference-training.js';

describe('OriginMan trajectory following', () => {
  it('keeps source motion intact and revalidates blended, slowed trajectories', () => {
    const original = originmanReferenceExample();
    const { robot, trajectory } = originmanReferenceCalibration;
    const clips = [{ label: 'A', value: original }];
    expect(composeOriginmanReference(clips, 1, robot.jointOrder, trajectory)).toBe(original);
    const joined = composeOriginmanReference(
      [...clips, { label: 'B', value: original }],
      0.5,
      robot.jointOrder,
      trajectory,
    );
    expect(joined.fps).toBe(50);
    expect(joined.joint_pos).toHaveLength((200 + 19 + 200 - 1) * 2 + 1);
    expect(joined.joint_pos[0]).toEqual(original.joint_pos[0].map((q) => q || 0));
    expect(joined.joint_pos.at(-1)).toEqual(original.joint_pos.at(-1));
    expect(joined.joint_vel[1][12]).toBeCloseTo(
      (joined.joint_pos[2][12] - joined.joint_pos[0][12]) * 25,
      7,
    );
    expect(validateOriginmanReferenceTrajectory(joined)).toEqual(joined);
    expect(() =>
      composeOriginmanReference(
        [{ label: 'A', value: { ...original, fps: 25 } }],
        0.5,
        robot.jointOrder,
        trajectory,
      ),
    ).toThrow(/采样频率/);
    const long = {
      ...original,
      joint_pos: Array.from({ length: 6100 }, (_, frame) => original.joint_pos[frame % 200]),
      joint_vel: Array.from({ length: 6100 }, (_, frame) => original.joint_vel[frame % 200]),
    };
    expect(() =>
      composeOriginmanReference(
        [{ label: '长参考', value: long }],
        0.5,
        robot.jointOrder,
        trajectory,
      ),
    ).toThrow(/240 秒/);
  });

  it('normalizes NPZ speed rounding and keeps sub-second clips composable', () => {
    const { robot, trajectory } = originmanReferenceCalibration;
    const value = originmanReferenceExample();
    value.joint_vel[0][12] = Math.fround(6.000003);
    const npz = { label: '动作.npz', value, float32: true };
    const normalized = composeOriginmanReference([npz], 1, robot.jointOrder, trajectory);
    expect(normalized.joint_vel[0][12]).toBe(6);
    expect(normalized.joint_pos).toEqual(value.joint_pos);
    expect(validateOriginmanReferenceTrajectory(normalized)).toEqual(normalized);
    expect(() =>
      composeOriginmanReference([{ ...npz, float32: false }], 1, robot.jointOrder, trajectory),
    ).toThrow(/速度/);
    value.joint_vel[0][12] = 6.001;
    expect(() => composeOriginmanReference([npz], 1, robot.jointOrder, trajectory)).toThrow(/速度/);

    const short = {
      label: '短动作',
      value: {
        ...value,
        joint_pos: value.joint_pos.slice(5, 35),
        joint_vel: value.joint_vel.slice(5, 35),
      },
    };
    expect(validateOriginmanReferenceTrajectory(short.value, 'motion-block')).toEqual(short.value);
    expect(() => validateOriginmanReferenceTrajectory(short.value)).toThrow(/50–12,000/);
    expect(() => composeOriginmanReference([short], 1, robot.jointOrder, trajectory)).toThrow(
      /至少需要 1 秒/,
    );
    const joined = composeOriginmanReference([short, short], 1, robot.jointOrder, trajectory);
    expect(validateOriginmanReferenceTrajectory(joined).joint_pos).toHaveLength(79);
  });

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
