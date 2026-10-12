import { describe, expect, it } from 'vitest';
import { BUILTIN_MICRODUCK_MODEL, validateSim2RealManifest } from './sim2real.js';

describe('manifest simulator visual assets', () => {
  it('preserves an installed same-origin directory without changing the physical contract', () => {
    const original = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    const input = {
      ...original,
      simulator: { ...original.simulator, visualAssetBase: '/sim2real/visual-models/my-duck/' },
    };
    const result = validateSim2RealManifest(input);
    expect(result.valid).toBe(true);
    expect(result.manifest?.simulator.visualAssetBase).toBe(input.simulator.visualAssetBase);
    expect(result.manifest?.contract).toEqual(
      validateSim2RealManifest(original).manifest?.contract,
    );
    expect(result.manifest?.simulator.policyArtifactId).toBe(original.simulator.policyArtifactId);
  });

  it('keeps existing manifests compatible when no visual directory is configured', () => {
    const result = validateSim2RealManifest(BUILTIN_MICRODUCK_MODEL.manifest);
    expect(result.valid).toBe(true);
    expect(result.manifest?.simulator).not.toHaveProperty('visualAssetBase');
  });

  it.each([
    null,
    42,
    {},
    '',
    ' /models/duck/',
    '/models/duck/ ',
    'https://other.example/duck/',
    '//other.example/duck/',
    'models/duck/',
    '/models/duck',
    '/models//duck/',
    '/models/../duck/',
    '/models/./duck/',
    '/models/duck..old/',
    '/models/duck/?token=secret',
    '/models/duck/#head',
    '/models\\duck/',
    '/models/%2e%2e/duck/',
    '/models/%252e%252e/duck/',
    '/models/%2f/duck/',
    '/models/%5c/duck/',
  ])('rejects an unsafe visual asset directory: %j', (visualAssetBase) => {
    const original = structuredClone(BUILTIN_MICRODUCK_MODEL.manifest);
    const result = validateSim2RealManifest({
      ...original,
      simulator: { ...original.simulator, visualAssetBase },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('simulator.visualAssetBase'))).toBe(true);
  });
});
