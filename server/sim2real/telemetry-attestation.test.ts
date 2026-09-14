import { createHmac } from 'node:crypto';

import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  createSim2RealTelemetryAttestationToken,
  readSim2RealBearerToken,
  sim2RealTelemetryAttestationConfigured,
  verifySim2RealTelemetryAttestationToken,
  verifySim2RealTelemetryAttestationTokenDetailed,
} from './telemetry-attestation.js';

const NOW = 1_760_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1_000);
const SECRET = 'telemetry-attestation-test-secret-0123456789';

function requestWithAuthorization(authorization?: string): Request {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as Request;
}

describe('sim2real telemetry attestation', () => {
  it('issues and verifies a short-lived owner/run/device bound JWT', () => {
    const token = createSim2RealTelemetryAttestationToken(
      { owner: 'alice', runId: 'run-1', deviceId: 'board-1', expiresInSeconds: 120 },
      { secret: SECRET, now: () => NOW },
    );
    const result = verifySim2RealTelemetryAttestationTokenDetailed(token, {
      secret: SECRET,
      now: () => NOW + 60_000,
    });
    expect(result).toMatchObject({
      valid: true,
      claims: {
        owner: 'alice',
        runId: 'run-1',
        deviceId: 'board-1',
        exp: NOW_SECONDS + 120,
      },
    });
    expect(
      verifySim2RealTelemetryAttestationToken(token, { secret: SECRET, now: () => NOW }),
    ).toMatchObject({ owner: 'alice', runId: 'run-1', deviceId: 'board-1' });
  });

  it('rejects expiry, tampering, wrong audience and short keys', () => {
    const token = createSim2RealTelemetryAttestationToken(
      { owner: 'alice', runId: 'run-1', deviceId: 'board-1', expiresInSeconds: 30 },
      { secret: SECRET, now: () => NOW },
    );
    expect(
      verifySim2RealTelemetryAttestationTokenDetailed(token, {
        secret: SECRET,
        now: () => NOW + 31_000,
      }),
    ).toMatchObject({ valid: false, reason: 'expired' });

    const tokenParts = token.split('.');
    const tamperedSignature = `${tokenParts[2][0] === 'a' ? 'b' : 'a'}${tokenParts[2].slice(1)}`;
    const tampered = `${tokenParts[0]}.${tokenParts[1]}.${tamperedSignature}`;
    expect(
      verifySim2RealTelemetryAttestationTokenDetailed(tampered, { secret: SECRET, now: () => NOW }),
    ).toMatchObject({ valid: false, reason: 'invalid-signature' });
    expect(
      verifySim2RealTelemetryAttestationTokenDetailed(token, { secret: 'short', now: () => NOW }),
    ).toMatchObject({ valid: false, reason: 'secret-not-configured' });
  });

  it('rejects copied placeholder or repeated production keys', () => {
    expect(sim2RealTelemetryAttestationConfigured('replace-with-at-least-32-random-bytes')).toBe(
      false,
    );
    expect(sim2RealTelemetryAttestationConfigured('change-me-change-me-change-me-change-me')).toBe(
      false,
    );
    expect(sim2RealTelemetryAttestationConfigured('a'.repeat(32))).toBe(false);
    expect(sim2RealTelemetryAttestationConfigured(SECRET)).toBe(true);
  });

  it('accepts the compact v1 envelope and a hex HMAC signature for rotation', () => {
    const payload = Buffer.from(
      JSON.stringify({
        owner: 'alice',
        runId: 'run-1',
        deviceId: 'board-1',
        exp: NOW_SECONDS + 60,
      }),
      'utf8',
    ).toString('base64url');
    const signingInput = `v1.${payload}`;
    const signature = createHmac('sha256', SECRET).update(signingInput).digest('hex');
    const result = verifySim2RealTelemetryAttestationTokenDetailed(`${signingInput}.${signature}`, {
      secret: SECRET,
      now: () => NOW,
    });
    expect(result).toMatchObject({ valid: true, claims: { owner: 'alice', runId: 'run-1' } });
  });

  it('distinguishes an absent Authorization header from a malformed one', () => {
    expect(readSim2RealBearerToken(requestWithAuthorization())).toEqual({ present: false });
    expect(readSim2RealBearerToken(requestWithAuthorization('Bearer token'))).toEqual({
      present: true,
      token: 'token',
    });
    expect(readSim2RealBearerToken(requestWithAuthorization('Basic token'))).toMatchObject({
      present: true,
      malformed: true,
    });
    expect(
      readSim2RealBearerToken(requestWithAuthorization('Bearer one, Bearer two')),
    ).toMatchObject({ present: true, malformed: true });
  });
});
