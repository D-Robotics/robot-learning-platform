import { describe, expect, it } from 'vitest';

import { validateHardwareProfile } from './hardware-profile.js';

const validProfile = {
  schemaVersion: 1,
  id: 'test-drive',
  displayName: 'Test drive',
  board: { platform: 'linux', family: 'test', model: 'test' },
  ros: {
    topics: {
      imu: { name: '/imu', type: 'sensor_msgs/msg/Imu', qos: 'best-effort' },
      cmdVel: { name: '/cmd_vel', type: 'geometry_msgs/msg/Twist', qos: 'reliable' },
    },
  },
  actuator: {
    kind: 'diff-drive',
    commandTopic: '/cmd_vel',
    messageType: 'geometry_msgs/msg/Twist',
    maxLinear: 0.3,
    maxAngular: 1,
    watchdogMs: 500,
  },
  policy: {
    observationAdapterId: 'imu-v1',
    actionAdapterId: 'twist-v1',
    observationSize: 6,
    actionSize: 2,
  },
  capabilities: ['imu', 'twist'],
};

describe('hardware profile contract', () => {
  it('accepts a canonical drive profile', () => {
    expect(validateHardwareProfile(validProfile)).toMatchObject({ valid: true });
  });

  it('rejects a drive profile whose command topic type disagrees', () => {
    const result = validateHardwareProfile({
      ...validProfile,
      ros: {
        topics: {
          ...validProfile.ros.topics,
          cmdVel: { name: '/cmd_vel', type: 'custom_msgs/msg/Velocity' },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('actuator.messageType must match ros.topics.cmdVel.type');
  });

  it('rejects duplicate topic names and unsafe runtime limits', () => {
    const result = validateHardwareProfile({
      ...validProfile,
      ros: {
        topics: {
          imu: { name: '/cmd_vel', type: 'sensor_msgs/msg/Imu' },
          cmdVel: validProfile.ros.topics.cmdVel,
        },
      },
      runtime: { decisionHz: 100 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('ros.topics.cmdVel.name duplicates another topic');
    expect(result.errors).toContain('runtime.decisionHz must be 1..50');
  });

  it('keeps synthetic profile provenance explicit', () => {
    const result = validateHardwareProfile({
      ...validProfile,
      provenance: {
        kind: 'synthetic',
        mock: true,
        note: 'contract-only profile; no hardware evidence',
      },
    });
    expect(result.valid).toBe(true);
    expect(result.profile?.provenance).toMatchObject({ kind: 'synthetic', mock: true });
  });

  it('rejects provenance that claims synthetic data is real', () => {
    const result = validateHardwareProfile({
      ...validProfile,
      provenance: { kind: 'synthetic', mock: false },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('provenance.mock must be true for synthetic profiles');
  });

  // The validator narrows untrusted JSON explicitly instead of walking it as
  // `any`. These cases pin the semantics that makes load-bearing: a numeric
  // *string* is still a string, so it must not slip past an integer check.
  it('rejects numeric strings where an integer is required', () => {
    const result = validateHardwareProfile({
      ...validProfile,
      actuator: { ...validProfile.actuator, watchdogMs: '500' },
      policy: { ...validProfile.policy, observationSize: '6', actionSize: '2' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('actuator.watchdogMs must be 500..2000ms');
    expect(result.errors).toContain('policy.observationSize is invalid');
    expect(result.errors).toContain('policy.actionSize is invalid');
  });

  it('rejects a non-string actuator kind even when its text would match', () => {
    const result = validateHardwareProfile({
      ...validProfile,
      actuator: { ...validProfile.actuator, kind: { toString: () => 'diff-drive' } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('actuator.kind is invalid');
    // A kind we cannot read as a drive must not demand a cmdVel topic either.
    expect(result.errors).not.toContain('ros.topics.cmdVel is required for a drive actuator');
  });

  it('rejects malformed topics, qos values, and provenance kinds', () => {
    const result = validateHardwareProfile({
      ...validProfile,
      ros: {
        topics: {
          imu: 'not-an-object',
          cmdVel: { name: '/cmd_vel', type: 'geometry_msgs/msg/Twist', qos: 'burst' },
        },
      },
      provenance: { kind: 7, mock: true },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('ros.topics.imu must be an object');
    expect(result.errors).toContain('ros.topics.cmdVel.qos is invalid');
    expect(result.errors).toContain('provenance.kind must be real, synthetic, or template');
  });

  it('never throws on primitive, array, or null input', () => {
    for (const input of [null, undefined, 42, 'profile', [], true]) {
      const result = validateHardwareProfile(input);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
