import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MICRODUCK_MODEL,
  MICRODUCK_OBSERVATION_LAYOUT,
  validateSim2RealManifest,
} from './sim2real.js';

/**
 * Vision observation contract.
 *
 * The platform originally declared observations as a flat list of scalar slots
 * whose sizes must sum to the flat `observationSize`. Adding an image branch
 * therefore must not weaken that invariant, because the contract validator, the
 * local worker and the board runtime all assert it independently. These cases
 * pin the mechanism: an image slot reports the *flattened* element count as its
 * `size` and carries its shape alongside, so a vector-only contract keeps its
 * exact previous meaning.
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

const IMAGE_ONLY_LAYOUT = [
  { name: 'camera', size: 3 * 8 * 8, modality: 'image', channels: 3, height: 8, width: 8 },
];

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
    const result = validateSim2RealManifest(manifestWithImageLayout(IMAGE_ONLY_LAYOUT, 192));
    if (!result.valid) console.log(result.errors);
    expect(result.valid).toBe(true);
    expect(result.manifest?.contract.observationLayout).toEqual([
      { name: 'camera', size: 192, modality: 'image', channels: 3, height: 8, width: 8 },
    ]);
  });

  it('accepts a mixed vector+image layout whose flat sizes still sum to observationSize', () => {
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [
          { name: 'imu-gravity', size: 6 },
          { name: 'camera', size: 3 * 4 * 4, modality: 'image', channels: 3, height: 4, width: 4 },
          { name: 'goal', size: 2 },
        ],
        56,
      ),
    );
    if (!result.valid) console.log(result.errors);
    expect(result.valid).toBe(true);
    const layout = result.manifest?.contract.observationLayout ?? [];
    const total = layout.reduce((sum, item) => sum + item.size, 0);
    expect(total).toBe(56);
    expect(layout.map((item) => item.name)).toEqual(['imu-gravity', 'camera', 'goal']);
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

  it('rejects an image bigger than the platform observation budget', () => {
    // Worth stating explicitly because it is easy to assume the per-item budget
    // is the binding limit: it is not. The layout-sum invariant means a single
    // slot can never exceed the flat total, and `maxObservationSize` (4096) is
    // the same number as `maxObservationLayoutItemSize`, so `observationSize`
    // always rejects first. The per-item check stays as defence in depth for a
    // future change that raises the total without revisiting the item budget.
    const result = validateSim2RealManifest(
      manifestWithImageLayout(IMAGE_ONLY_LAYOUT, 5_000, {
        observationLayout: [
          { name: 'camera', size: 5_000, modality: 'image', channels: 4, height: 25, width: 50 },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/contract\.observationSize must be at most 4096/);
  });

  it('rejects an image shape outside the per-axis bounds', () => {
    // 5 channels exceeds maxObservationImageChannels (4). 5*8*8 = 320 keeps the
    // flat total legal, so this isolates the shape bound from the total bound.
    const result = validateSim2RealManifest(
      manifestWithImageLayout(
        [{ name: 'camera', size: 320, modality: 'image', channels: 5, height: 8, width: 8 }],
        320,
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/image item shape must be positive integers within/);
  });

  it('still requires the layout to sum to observationSize when an image is present', () => {
    // 192 declared, 190 summed: the pre-existing invariant must keep holding.
    const result = validateSim2RealManifest(manifestWithImageLayout(IMAGE_ONLY_LAYOUT, 190));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/sizes must add up to contract\.observationSize/);
  });
});
