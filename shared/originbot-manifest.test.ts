import { describe, expect, it } from 'vitest';
import { BUILTIN_MICRODUCK_MODEL, validateSim2RealManifest } from './sim2real.js';

describe('OriginBot product contract', () => {
  it('accepts an OriginBot manifest with a differential-drive contract', () => {
    const base = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest) as any;
    base.modelId = 'originbot-goal-navigation'; base.displayName = 'OriginBot 目标点导航';
    base.robot = { id: 'originbot', variant: 'differential-drive' };
    base.contract = { ...base.contract, id: 'originbot-policy-v1', robotId: 'originbot', jointCount: 1, observationSize: 8, actionSize: 2, controlHz: 10, observationLayout: [{ name: 'imu-odom', size: 8 }] };
    base.simulator = { backends: ['local'], policyArtifactId: 'originbot-policy' };
    base.artifacts = [{ id: 'originbot-policy', name: 'originbot-policy.onnx', role: 'policy', kind: 'source', ref: 'artifact://originbot/policy', format: 'onnx', runtime: 'cpu-onnx', workload: 'locomotion', threads: 1, targetPlatforms: ['rdk-x5'] }];
    const result = validateSim2RealManifest(base);
    if (!result.valid) console.log(result.errors); expect(result.valid).toBe(true);
    expect(result.manifest?.robot.id).toBe('originbot');
  });
});
