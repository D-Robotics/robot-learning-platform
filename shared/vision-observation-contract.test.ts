import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MICRODUCK_MODEL,
  MICRODUCK_OBSERVATION_LAYOUT,
  validateSim2RealManifest,
} from './sim2real.js';

/**
 * Vision observation contract.
 *
 * The platform declares observations as a list of slots, and `observationSize`
 * is the policy's flat VECTOR input width. Image slots carry their own shape and
 * are budgeted by it rather than by the 4096-element flat cap, because a single
 * realistic camera frame (3x64x64 = 12288) is already several times that cap.
 * These cases pin both halves of that: images are accepted and normalized with
 * their shape, and the vector sum still has to equal `observationSize` exactly.
 */

/** Builds a manifest with an image-capable contract, defaulting to a valid one. */
function manifestWithImageLayout(
  layout: unknown[],
  observationSize: number,
  overrides: Record<string, unknown> = {},
) {
  const base = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest) as any;
  base.modelId = 'vision-goal-navigation';
  base.robot = { id: 'originbot', variant: 'differential-drive' };
  base.contract = {
    ...base.contract,
    // The OriginBot product profile requires this prefix for manifest-defined
    // contracts, so an accepted case must satisfy it.
    id: 'originbot-policy-vision-v1',
    robotId: 'originbot',
    observationSize,
    observationLayout: layout,
    ...overrides,
  };
  base.simulator = { backends: ['local'], policyArtifactId: 'vision-policy' };
  base.artifacts = [
    {
      id: 'vision-policy',
      name: 'vision-policy.onnx',
      role: 'policy',
      kind: 'source',
      ref: 'artifact://originbot/vision-policy',
      format: 'onnx',
      runtime: 'cpu-onnx',
      workload: 'locomotion',
      threads: 1,
      targetPlatforms: ['rdk-x5'],
    },
  ];
  return base;
}

/** A 3x64x64 frame plus the six vector values a navigation policy still needs. */
const VISION_LAYOUT = [
  { name: 'imu-gravity', size: 6 },
  { name: 'camera', size: 3 * 64 * 64, modality: 'image', channels: 3, height: 64, width: 64 },
];
const VISION_VECTOR_SIZE = 6;

describe('vision observation contract', () => {
  it('keeps the vector-only MicroDuck contract byte-identical', () => {
    // The 61D contract is fixed and must not gain modality fields.
    expect(MICRODUCK_OBSERVATION_LAYOUT.every((item) => !('modality' in item))).toBe(true);
    const result = validateSim2RealManifest(
      structuredClone(BUILTIN_MICRODUCK_MODEL.manifest) as any,
    );
    expect(result.valid).toBe(true);
    expect(result.manifest?.contract.observationLayout).toEqual(
      MICRODUCK_OBSERVATION_LAYOUT.map((item) => ({ ...item })),
    );
  });

  it('accepts an image layout and preserves its shape through normalization', () => {
    const result = validateSim2RealManifest(
      manifestWithImageLayout(VISION_LAYOUT, VISION_VECTOR_SIZE),
    );
    if (!result.valid) console.log(result.errors);
    expect(result.valid).toBe(true);
    expect(result.manifest?.contract.observationLayout).toEqual([
      { name: 'imu-gravity', size: 6 },
      { name: 'camera', size: 12288, modality: 'image', channels: 3, height: 64, width: 64 },
    ]);
  });

  it('accepts a mixed vector+image layout and only sums the vector slots', () => {
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [
          { name: 'imu-gravity', size: 6 },
          { name: 'camera', size: 3 * 4 * 4, modality: 'image', channels: 3, height: 4, width: 4 },
          { name: 'goal', size: 2 },
        ],
        8,
      ),
    );
    if (!result.valid) console.log(result.errors);
    expect(result.valid).toBe(true);
    const layout = result.manifest?.contract.observationLayout ?? [];
    // 6 + 2 vector values; the 48-element frame is budgeted by its shape.
    expect(layout.reduce((sum, item) => sum + item.size, 0)).toBe(56);
    expect(layout.map((item) => item.name)).toEqual(['imu-gravity', 'camera', 'goal']);
  });

  it('accepts a realistic camera frame that exceeds the flat vector budget', () => {
    // This is the case that forced the budget split. The flat per-frame cap is
    // 4096 elements, so a 3x64x64 frame (12288) must NOT be rejected for
    // exceeding it, while the vector half must still fit inside it.
    expect(VISION_LAYOUT[1]!.size).toBeGreaterThan(4096);
    const result = validateSim2RealManifest(
      manifestWithImageLayout(VISION_LAYOUT, VISION_VECTOR_SIZE),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects an image slot whose size disagrees with channels*height*width', () => {
    // 3*8*8 = 192; declaring 191 must fail instead of silently trusting either
    // number, because the flattening is what the runtime actually allocates.
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [{ name: 'camera', size: 191, modality: 'image', channels: 3, height: 8, width: 8 }],
        191,
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/size must equal channels\*height\*width \(192\)/);
  });

  it('rejects an image shape that is incomplete', () => {
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [{ name: 'camera', size: 192, modality: 'image', channels: 3, height: 8 }],
        192,
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/image item shape must be positive integers/);
  });

  it('rejects an unknown modality instead of degrading it to a vector slot', () => {
    // Fail-closed: an unrecognized modality is a declaration bug. Treating it
    // as a vector would surface much later as a shape error inside an engine.
    const result = validateSim2RealManifest(
      manifestWithImageLayout([{ name: 'lidar', size: 64, modality: 'pointcloud' }], 64),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/modality must be "image" when present/);
  });

  it('rejects a shape declared without the image modality', () => {
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [{ name: 'camera', size: 192, channels: 3, height: 8, width: 8 }],
        192,
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/declares an image shape without modality "image"/);
  });

  it('rejects an image shape outside the per-axis bounds', () => {
    // 5 channels exceeds maxObservationImageChannels (4). The vector half stays
    // valid at 6 so the rejection isolates the shape bound.
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [
          { name: 'imu-gravity', size: 6 },
          { name: 'camera', size: 5 * 8 * 8, modality: 'image', channels: 5, height: 8, width: 8 },
        ],
        6,
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/image item shape must be positive integers within/);
  });

  it('still requires the vector slots to sum to observationSize when an image is present', () => {
    // The image does not contribute, so 8 vector values declared against
    // observationSize 6 must still fail.
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [
          { name: 'imu-gravity', size: 6 },
          { name: 'goal', size: 2 },
          { name: 'camera', size: 3 * 4 * 4, modality: 'image', channels: 3, height: 4, width: 4 },
        ],
        6,
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/sizes must add up to contract\.observationSize/);
  });

  it('rejects a vision contract with no vector slot at all', () => {
    // A pure-image contract would need observationSize 0, which the platform
    // rejects, and a visual policy still needs its state vector. Fail loudly
    // rather than accepting a contract whose vector input width cannot exist.
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [{ name: 'camera', size: 3 * 4 * 4, modality: 'image', channels: 3, height: 4, width: 4 }],
        48,
      ),
    );
    expect(result.valid).toBe(false);
  });
});
