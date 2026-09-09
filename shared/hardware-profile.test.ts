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
      provenance: { kind: 'synthetic', mock: true, note: 'contract-only profile; no hardware evidence' },
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
});
