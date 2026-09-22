/**
 * User Center access-token verification for the `user-center` auth mode
 * (D-006). Ported from RDK Studio's server/sso-jwt-verifier.ts — same
 * IdP, same JWKS contract, our own env names.
 *
 * SECURITY: the User Center IdP has no usable server-side introspection
 * endpoint (it answers 200 for forged tokens too), so the access_token's
 * RS256 signature MUST be verified locally against the cloud JWKS before
 * any user id is trusted. Parse-only acceptance is forbidden on any
 * non-loopback deployment (D-003 of Studio documents the impersonation
 * attack this prevents).
 */
import crypto from 'node:crypto';

type JsonWebKeyLike = {
  kid?: unknown;
  kty?: unknown;
  alg?: unknown;
  use?: unknown;
  n?: unknown;
  e?: unknown;
};
type UserCenterClaims = {
  sub?: unknown;
  user_id?: unknown;
  userId?: unknown;
  username?: unknown;
  name?: unknown;
  preferred_username?: unknown;
  email?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iss?: unknown;
};
type JwksDocument = { keys?: JsonWebKeyLike[] };
export type VerifiedUserCenterJwt = {
  claims: UserCenterClaims;
  protectedHeader: { kid: string; alg: 'RS256' };
};
const DEFAULT_JWKS_URL = 'https://cloud.d-robotics.cc/.well-known/jwks.json';
const DEFAULT_ISSUER = 'user-center';
const CACHE_TTL_MS = 15 * 60_000;
const STALE_CACHE_TTL_MS = 60 * 60_000;
const CLOCK_SKEW_SECONDS = 120;
const FETCH_TIMEOUT_MS = 10_000;
let cache: { fetchedAt: number; keys: JsonWebKeyLike[] } | null = null;
let inFlight: Promise<JsonWebKeyLike[]> | null = null;
let lastWarningAt = 0;

function warnVerificationIssue(reason: string): void {
  const now = Date.now();
  if (now - lastWarningAt < 5 * 60_000) return;
  lastWarningAt = now;
  console.warn(`[sso-jwt] User Center JWKS verification unavailable: ${reason}`);
}

function configuredJwksUrl(): string {
  return (
    String(process.env.RDK_SIM2REAL_UC_JWKS_URL || DEFAULT_JWKS_URL).trim() || DEFAULT_JWKS_URL
  );
}

function configuredIssuer(): string {
  return (
    String(process.env.RDK_SIM2REAL_UC_JWT_ISSUER || DEFAULT_ISSUER).trim() || DEFAULT_ISSUER
  );
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJwt(accessToken: string): {
  header: Record<string, unknown>;
  claims: UserCenterClaims;
  signingInput: Buffer;
  signature: Buffer;
} | null {
  const parts = String(accessToken || '').trim().split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]) as UserCenterClaims | null;
  if (!header || !claims) return null;
  let signature: Buffer;
  try {
    signature = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (signature.length < 32) return null;
  return {
    header,
    claims,
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    signature,
  };
}

let fetchImpl: ((url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>) | null = null;

/** Test seam: inject a fake JWKS transport; pass null to restore global fetch. */
export function setUserCenterJwtFetchForTests(
  impl: ((url: string) => Promise<Response>) | null,
): void {
  fetchImpl = impl;
}

async function fetchJwks(): Promise<JsonWebKeyLike[]> {
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(configuredJwksUrl());
  if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) throw new Error('JWKS response is not JSON');
  const body = (await response.json()) as JwksDocument;
  const keys = Array.isArray(body?.keys) ? body.keys.filter((key) => key && typeof key === 'object') : [];
  if (keys.length === 0) throw new Error('JWKS has no keys');
  return keys;
}

async function getJwks(forceRefresh = false): Promise<JsonWebKeyLike[]> {
  const now = Date.now();
  if (!forceRefresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.keys;
  if (forceRefresh) cache = null;
  if (!inFlight) {
    inFlight = fetchJwks()
      .then((keys) => {
        cache = { fetchedAt: Date.now(), keys };
        return keys;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  try {
    return await inFlight;
  } catch (error) {
    if (cache && now - cache.fetchedAt < STALE_CACHE_TTL_MS) return cache.keys;
    throw error;
  }
}

function claimString(claims: UserCenterClaims, ...names: (keyof UserCenterClaims)[]): string {
  for (const name of names) {
    const value = String(claims[name] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function validNumericDate(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function verifyUserCenterJwt(accessToken: string): Promise<VerifiedUserCenterJwt | null> {
  const parsed = parseJwt(accessToken);
  if (!parsed) return null;
  const alg = String(parsed.header.alg || '').trim();
  const kid = String(parsed.header.kid || '').trim();
  if (alg !== 'RS256' || !kid) return null;
  if (claimString(parsed.claims, 'iss') !== configuredIssuer()) return null;
  const subject = claimString(parsed.claims, 'sub', 'user_id', 'userId');
  if (!subject) return null;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const exp = validNumericDate(parsed.claims.exp);
  const nbf = validNumericDate(parsed.claims.nbf);
  if (exp !== null && exp < nowSeconds - CLOCK_SKEW_SECONDS) return null;
  if (nbf !== null && nbf > nowSeconds + CLOCK_SKEW_SECONDS) return null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let keys: JsonWebKeyLike[];
    try {
      keys = await getJwks(attempt === 1);
    } catch {
      warnVerificationIssue('jwks_fetch_failed');
      return null;
    }
    const jwk = keys.find((key) => String(key.kid || '').trim() === kid);
    if (
      !jwk ||
      String(jwk.kty || '') !== 'RSA' ||
      (jwk.alg && String(jwk.alg) !== 'RS256') ||
      (jwk.use && String(jwk.use) !== 'sig') ||
      !jwk.n ||
      !jwk.e
    ) {
      continue;
    }
    try {
      const publicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
      const valid = crypto.verify('RSA-SHA256', parsed.signingInput, publicKey, parsed.signature);
      if (valid) return { claims: parsed.claims, protectedHeader: { kid, alg: 'RS256' } };
    } catch {
      // A key rotation can retain the same kid; force one refresh before failing closed.
    }
  }
  warnVerificationIssue('signature_invalid_or_key_rotation_pending');
  return null;
}

export function resetUserCenterJwksCacheForTests(): void {
  cache = null;
  inFlight = null;
  lastWarningAt = 0;
}
