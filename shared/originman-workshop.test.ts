import { describe, expect, it } from 'vitest';
import { normalizeTrainingSpec, validateSim2RealManifest } from './sim2real.js';
import {
  normalizeOriginmanWorkshopResult,
  matchesOriginmanWorkshopContract,
  ORIGINMAN_WORKSHOP_MANIFEST,
} from './originman-workshop.js';

const config = { phase: 'train', timesteps: 500000, seed: 7, pushMaxForce: 8.1 };
const training = {
  profile: 'standard',
  engine: 'originman-recovery',
  algorithm: 'sac',
  numEnvs: 4,
  originmanWorkshop: config,
};

describe('OriginMan Workshop contract', () => {
  it('uses a separate valid 14→2 contract and preserves classroom settings', () => {
    expect(validateSim2RealManifest(ORIGINMAN_WORKSHOP_MANIFEST).errors).toEqual([]);
    expect(matchesOriginmanWorkshopContract(ORIGINMAN_WORKSHOP_MANIFEST.contract)).toBe(true);
    expect(
      matchesOriginmanWorkshopContract({
        ...ORIGINMAN_WORKSHOP_MANIFEST.contract,
        controlHz: 100,
        physicsTimestepSeconds: 0.0005,
      }),
    ).toBe(false);
    expect(normalizeTrainingSpec(training).spec?.originmanWorkshop).toEqual({
      ...config,
      device: 'cuda',
    });
  });
  it('preserves an explicit CPU selection', () => {
    expect(
      normalizeTrainingSpec({ ...training, originmanWorkshop: { ...config, device: 'cpu' } }).spec
        ?.originmanWorkshop?.device,
    ).toBe('cpu');
  });
  it.each([
    { device: 'auto' },
    { device: 'mps' },
    { timesteps: 4095 },
    { timesteps: Infinity },
    { seed: '7' },
    { pushMaxForce: 6.3 },
    { sourceExternalRunId: 'other-account-worker-job' },
    { sourceRunId: 'unexpected-parent' },
    { scene: '/arbitrary/model.xml' },
    { phase: 'evaluate' },
  ])('rejects unsupported configuration or source injection: %j', (change) => {
    expect(
      normalizeTrainingSpec({ ...training, originmanWorkshop: { ...config, ...change } }).spec,
    ).toBeUndefined();
  });
  it('rejects the workshop options on the old engine or with a different algorithm', () => {
    expect(
      normalizeTrainingSpec({ ...training, engine: 'originman-straight' }).spec,
    ).toBeUndefined();
    expect(normalizeTrainingSpec({ ...training, algorithm: 'ppo' }).spec).toBeUndefined();
  });
  it('retains actual GPU evidence and rejects a CPU parameter device claimed as CUDA', () => {
    const result = {
      schemaVersion: 1,
      hardwareEligible: false,
      phase: 'train',
      policySha256: 'a'.repeat(64),
      seed: 7,
      requestedTimesteps: 12032,
      actualTimesteps: 12032,
      pushMaxForce: 8.1,
      gradientUpdates: 1792,
      trainingDevice: {
        requestedDevice: 'cuda',
        resolvedDevice: 'cuda',
        parameterDevices: ['cuda:0'],
        torchVersion: '2.9.1+cu128',
        cudaRuntime: '12.8',
        gpuName: 'GPU',
        physicsBackend: 'cpu-mujoco',
      },
    };
    expect(normalizeOriginmanWorkshopResult(result)?.trainingDevice?.parameterDevices).toEqual([
      'cuda:0',
    ]);
    expect(
      normalizeOriginmanWorkshopResult({
        ...result,
        trainingDevice: { ...result.trainingDevice, parameterDevices: ['cpu'] },
      }),
    ).toBeUndefined();
  });
  it('rejects a worker learning claim inconsistent with all 31 paired outcomes', () => {
    const result = {
      schemaVersion: 1,
      hardwareEligible: false,
      phase: 'evaluate',
      sourceRunId: 'source-run',
      policySha256: 'a'.repeat(64),
      seed: 7,
      requestedTimesteps: 500000,
      actualTimesteps: 500224,
      pushMaxForce: 8.1,
      baselineRecovered: 1,
      rlRecovered: 31,
      normalStanding: true,
      clearGain: true,
      cases: Array.from({ length: 31 }, (_, i) => ({
        index: i,
        force:
          i === 30
            ? 0
            : [-7.9, -7.55, -7.3, -7.05, -6.8, 6.8, 7.05, 7.3, 7.55, 7.9][Math.floor(i / 3)],
        start: i === 30 ? 2.75 : [1.55, 2.75, 3.95][i % 3],
        baseline: i === 30,
        initial: i === 30,
        rl: true,
        frozen: i === 30,
        fallen: false,
      })),
      selectedCase: 0,
      traces: ['reference', 'imu-feedback', 'untrained', 'rl'].map((controller) => ({
        controller,
        frames: [[0.04, 0, 0, 0]],
      })),
    };
    expect(normalizeOriginmanWorkshopResult(result)?.clearGain).toBe(true);
    expect(normalizeOriginmanWorkshopResult({ ...result, baselineRecovered: 0 })).toBeUndefined();
    expect(normalizeOriginmanWorkshopResult({ ...result, clearGain: false })).toBeUndefined();
    expect(normalizeOriginmanWorkshopResult({ ...result, hardwareEligible: true })).toBeUndefined();
    expect(
      normalizeOriginmanWorkshopResult({ ...result, traces: [...result.traces, result.traces[0]] }),
    ).toBeUndefined();
  });
});
