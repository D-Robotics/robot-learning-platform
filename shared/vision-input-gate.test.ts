import { describe, expect, it } from 'vitest';
import { validateVisionObservationAgainstModelInputs } from './artifact-quality-gate.js';
import type { ModelInputSignature } from './artifact-quality-gate.js';
import type { Sim2RealObservationLayoutItem } from './sim2real.js';

/**
 * Vision-input gate.
 *
 * The failure this guards is specific: because an image slot is flattened into
 * `observationSize`, every dimension-only check in the platform still passes for
 * a vision contract even when the exported model has no image input at all.
 * Without this gate that mismatch is only discovered at inference time on the
 * board, after the policy was staged.
 */

const VECTOR_ONLY: Sim2RealObservationLayoutItem[] = [
  { name: 'gyro', size: 3 },
  { name: 'goal', size: 3 },
];

const VISION_LAYOUT: Sim2RealObservationLayoutItem[] = [
  { name: 'gyro', size: 3 },
  { name: 'camera', size: 3 * 64 * 64, modality: 'image', channels: 3, height: 64, width: 64 },
];

const vectorInput: ModelInputSignature = { name: 'obs', shape: ['batch', 6] };
/** NHWC image input with a symbolic batch axis, as a normal ONNX export has. */
const imageInput = (h = 64, w = 64, c = 3): ModelInputSignature => ({
  name: 'image',
  shape: ['batch', h, w, c],
});

describe('vision observation input gate', () => {
  it('exempts a vector-only contract, needing no image input', () => {
    const result = validateVisionObservationAgainstModelInputs({
      layout: VECTOR_ONLY,
      inputs: [vectorInput],
    });
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('exempts a vector-only contract even when the model happens to have an image input', () => {
    // A multi-head export may carry an unused image input; without an image
    // slot in the contract there is nothing to certify.
    const result = validateVisionObservationAgainstModelInputs({
      layout: VECTOR_ONLY,
      inputs: [vectorInput, imageInput()],
    });
    expect(result.passed).toBe(true);
  });

  it('accepts a vision contract whose model exposes a matching NHWC image input', () => {
    const result = validateVisionObservationAgainstModelInputs({
      layout: VISION_LAYOUT,
      inputs: [vectorInput, imageInput()],
    });
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('tolerates a model image larger than the declared slot', () => {
    // The runtime is expected to downscale to the declared shape, so a larger
    // trained input is not a mismatch — a smaller one is.
    const result = validateVisionObservationAgainstModelInputs({
      layout: VISION_LAYOUT,
      inputs: [vectorInput, imageInput(224, 224, 3)],
    });
    expect(result.passed).toBe(true);
  });

  it('fails a vision contract whose model has no image input at all', () => {
    const result = validateVisionObservationAgainstModelInputs({
      layout: VISION_LAYOUT,
      inputs: [vectorInput],
    });
    expect(result.passed).toBe(false);
    expect(result.errors.join('\n')).toMatch(/exposes 0 rank-4 inputs \(expected exactly 1\)/);
  });

  it('fails when the model exposes more than one candidate image input', () => {
    const result = validateVisionObservationAgainstModelInputs({
      layout: VISION_LAYOUT,
      inputs: [vectorInput, imageInput(), { name: 'depth', shape: ['batch', 64, 64, 1] }],
    });
    expect(result.passed).toBe(false);
    expect(result.errors.join('\n')).toMatch(/exposes 2 rank-4 inputs/);
  });

  it('fails on a channel-count mismatch', () => {
    const result = validateVisionObservationAgainstModelInputs({
      layout: VISION_LAYOUT,
      inputs: [vectorInput, imageInput(64, 64, 1)],
    });
    expect(result.passed).toBe(false);
    expect(result.errors.join('\n')).toMatch(
      /has 1 channels but contract image slot "camera" declares 3/,
    );
  });

  it('fails closed on a dynamic channel axis instead of assuming a match', () => {
    const result = validateVisionObservationAgainstModelInputs({
      layout: VISION_LAYOUT,
      inputs: [vectorInput, { name: 'image', shape: ['batch', 64, 64, 'channels'] }],
    });
    expect(result.passed).toBe(false);
    expect(result.errors.join('\n')).toMatch(/channel axis is dynamic/);
  });

  it('fails when the model image is spatially smaller than the declared slot', () => {
    const result = validateVisionObservationAgainstModelInputs({
      layout: VISION_LAYOUT,
      inputs: [vectorInput, imageInput(32, 32, 3)],
    });
    expect(result.passed).toBe(false);
    const errors = result.errors.join('\n');
    expect(errors).toMatch(/height 32 is smaller than the declared image height 64/);
    expect(errors).toMatch(/width 32 is smaller than the declared image width 64/);
  });

  it('refuses to certify a contract with more than one image slot', () => {
    const twoImages: Sim2RealObservationLayoutItem[] = [
      ...VISION_LAYOUT,
      { name: 'wrist', size: 3 * 64 * 64, modality: 'image', channels: 3, height: 64, width: 64 },
    ];
    const result = validateVisionObservationAgainstModelInputs({
      layout: twoImages,
      inputs: [vectorInput, imageInput()],
    });
    expect(result.passed).toBe(false);
    expect(result.errors.join('\n')).toMatch(/only certifies a single image branch/);
  });
});
