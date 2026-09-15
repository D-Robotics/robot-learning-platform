import { describe, expect, it } from 'vitest';
import { artifactIsUsable } from './artifact-domain.js';
import { deploymentCanAdvance, deploymentNextAction } from './deployment-domain.js';
import { deviceIsReady } from './device-domain.js';
import { evaluationIsReleaseReady } from './evaluation-domain.js';

describe('domain contracts', () => {
  it('requires release-grade evaluation evidence', () =>
    expect(
      evaluationIsReleaseReady({ status: 'passed', successRate: 0.7, collisionRate: 0.15 }),
    ).toBe(true));
  it('rejects mutable or malformed artifacts', () =>
    expect(
      artifactIsUsable({ status: 'published', immutable: false, sha256: 'a'.repeat(64) }),
    ).toBe(false));
  it('requires a fresh device heartbeat', () =>
    expect(deviceIsReady({ status: 'online', heartbeatAt: new Date().toISOString() })).toBe(true));
  it('requires approval before deployment can advance', () => {
    expect(deploymentCanAdvance({ status: 'preflight', artifactId: 'a', deviceId: 'd' })).toBe(
      false,
    );
    expect(deploymentNextAction({ status: 'draft' })).toBe('preflight');
  });
});
