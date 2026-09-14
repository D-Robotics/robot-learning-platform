import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Short lived board-agent credentials used by the telemetry ingest boundary.
 *
 * This is deliberately a small JWT-compatible envelope rather than a general
 * purpose session token.  A token is bound to one tenant, run and device and
 * is accepted only for telemetry uploads.  The signing key never crosses the
 * HTTP boundary; board agents receive an already-issued token out of band.
 */
export const SIM2REAL_TELEMETRY_ATTESTATION_AUDIENCE = 'sim2real.telemetry';
export const SIM2REAL_TELEMETRY_ATTESTATION_ALGORITHM = 'HS256';
export const SIM2REAL_TELEMETRY_ATTESTATION_VERSION = 1 as const;
export const SIM2REAL_TELEMETRY_ATTESTATION_SECRET_ENV =
  'RDK_SIM2REAL_TELEMETRY_ATTESTATION_SECRET';

/** Historical aliases are read for rolling deployments; the canonical name
 * above is the one emitted in the production env examples. */
export const SIM2REAL_TELEMETRY_ATTESTATION_SECRET_ALIASES = [
  SIM2REAL_TELEMETRY_ATTESTATION_SECRET_ENV,
  'RDK_SIM2REAL_TELEMETRY_TOKEN_SECRET',
  'RDK_SIM2REAL_TELEMETRY_HMAC_SECRET',
] as const;

const MIN_SECRET_BYTES = 32;
const DEFAULT_TTL_SECONDS = 5 * 60;
const DEFAULT_MAX_FUTURE_SECONDS = 7 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_PAYLOAD_BYTES = 2_048;
// Values copied from an example file (or the usual "change me" defaults) must
// never become a production signing key.  Keep this check deliberately
// conservative: generated keys and test fixtures that merely contain the
// word "test" are still valid when they are long enough.
const WEAK_SECRET_PATTERN =
  /^(?:replace(?:[-_ ]?with)?(?:[-_ ].*)?|change(?:[-_ ]?me)?(?:[-_ ].*)?|changeme(?:[-_ ].*)?|example(?:[-_ ].*)?|placeholder(?:[-_ ].*)?|default(?:[-_ ]?secret)?(?:[-_ ].*)?|dummy(?:[-_ ].*)?|password(?:[-_ ].*)?|your[-_ ]?(?:secret|key)(?:[-_ ].*)?|secret(?:[-_ ].*)?)$/i;
const REPEATED_SECRET_PATTERN = /^(.)\1{31,}$/s;

// Keep these constraints in lockstep with the HTTP telemetry route.  They
// reject delimiters/control characters before a claim can be used in an owner
// lookup or a path parameter.
const OWNER_PATTERN = /^[^\u0000-\u001f\u007f/]{1,160}$/;
const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export interface Sim2RealTelemetryAttestationClaims {
  owner: string;
  runId: string;
  deviceId: string;
  /** Optional chunk sequence binding for one-shot board upload tokens. */
  sequence?: number;
  /** Unix epoch seconds. A token is invalid when `exp <= now`. */
  exp: number;
  /** Issued-at Unix epoch seconds, when present. */
  iat?: number;
  /** Tokens issued by this module carry the telemetry audience. */
  aud?: string;
  /** Envelope version for future key/claim migrations. */
  v?: number;
}

export interface Sim2RealTelemetryAttestationIssueInput {
  owner: string;
  runId: string;
  deviceId: string;
  sequence?: number;
  /** Explicit expiry. If omitted, `expiresInSeconds` or the default TTL is used. */
  exp?: number;
  /** Optional issued-at timestamp; defaults to the current clock. */
  iat?: number;
  /** Convenience TTL used when `exp` is omitted. */
  expiresInSeconds?: number;
}

export interface Sim2RealTelemetryAttestationOptions {
  /** Explicit key, primarily useful for tests and key rotation adapters. */
  secret?: string | Buffer;
  /** Clock returning milliseconds (or epoch seconds for small test clocks). */
  now?: () => number;
  /** Maximum accepted token size. Defaults to 4096 bytes. */
  maxTokenLength?: number;
  /** Maximum expiry distance from now. Defaults to seven days. */
  maxFutureSeconds?: number;
}

export type Sim2RealTelemetryAttestationVerification =
  | { valid: true; claims: Sim2RealTelemetryAttestationClaims }
  | { valid: false; reason: Sim2RealTelemetryAttestationFailure };

export type Sim2RealTelemetryAttestationFailure =
  | 'missing-token'
  | 'malformed-token'
  | 'secret-not-configured'
  | 'invalid-signature'
  | 'invalid-header'
  | 'invalid-claims'
  | 'expired'
  | 'issued-in-the-future'
  | 'too-far-in-the-future';

export interface Sim2RealBearerToken {
  /** Whether an Authorization header was supplied at all. */
  present: boolean;
  /** A syntactically valid Bearer value, when present. */
  token?: string;
  /** Set when a header was supplied but was not a single Bearer token. */
  malformed?: boolean;
}

function epochSeconds(now: number): number {
  const value = Number(now);
  if (!Number.isFinite(value) || value < 0) return 0;
  // Accept both Date.now()-style clocks and epoch-second clocks in adapters.
  return Math.floor(value > 100_000_000_000 ? value / 1_000 : value);
}

function currentEpochSeconds(now?: () => number): number {
  return epochSeconds((now ?? Date.now)());
}

function normalizeSecret(value: string | Buffer | undefined): Buffer | null {
  if (value === undefined) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8').trim() : String(value).trim();
  if (!text || WEAK_SECRET_PATTERN.test(text) || REPEATED_SECRET_PATTERN.test(text)) {
    return null;
  }
  const secret = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(text, 'utf8');
  if (secret.length < MIN_SECRET_BYTES || /[\u0000-\u001f\u007f]/.test(secret.toString('utf8'))) {
    return null;
  }
  return secret;
}

function configuredSecret(raw?: string | Buffer): Buffer | null {
  // An explicit key is authoritative: do not silently fall back to process
  // environment values when a caller supplied a malformed rotation key.
  if (raw !== undefined) return normalizeSecret(raw);
  // During a rolling deployment the canonical variable may be absent or may
  // still contain an old placeholder while one of the historical aliases is
  // valid.  Select the first *valid* candidate instead of swallowing the
  // usable alias merely because an earlier variable is non-empty.
  for (const name of SIM2REAL_TELEMETRY_ATTESTATION_SECRET_ALIASES) {
    const secret = normalizeSecret(process.env[name]);
    if (secret) return secret;
  }
  return null;
}

/** Exposed for readiness/configuration checks without revealing key material. */
export function sim2RealTelemetryAttestationConfigured(secret?: string | Buffer): boolean {
  return configuredSecret(secret) !== null;
}

function base64url(value: Buffer | string): string {
  return (Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'))
    .toString('base64url')
    .replace(/=+$/g, '');
}

function decodeBase64url(value: string, maxBytes: number): Buffer | null {
  if (!value || value.length > maxBytes * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (!decoded.length || decoded.length > maxBytes || base64url(decoded) !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function validText(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value) && value.trim() === value;
}

function normalizeIssueClaims(
  input: Sim2RealTelemetryAttestationIssueInput,
  now: number,
  maxFutureSeconds: number,
): Sim2RealTelemetryAttestationClaims {
  if (!validText(input.owner, OWNER_PATTERN))
    throw new Error('invalid telemetry attestation owner');
  if (!validText(input.runId, RESOURCE_ID_PATTERN))
    throw new Error('invalid telemetry attestation runId');
  if (!validText(input.deviceId, RESOURCE_ID_PATTERN)) {
    throw new Error('invalid telemetry attestation deviceId');
  }
  const sequence = input.sequence === undefined ? undefined : Number(input.sequence);
  if (
    sequence !== undefined &&
    (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 2_000_000_000)
  ) {
    throw new Error('invalid telemetry attestation sequence');
  }
  const iat = input.iat === undefined ? now : Number(input.iat);
  if (!Number.isSafeInteger(iat) || iat < 0 || iat > now + CLOCK_SKEW_SECONDS) {
    throw new Error('invalid telemetry attestation iat');
  }
  const requestedTtl =
    input.expiresInSeconds === undefined ? DEFAULT_TTL_SECONDS : Number(input.expiresInSeconds);
  const exp = input.exp === undefined ? now + requestedTtl : Number(input.exp);
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + maxFutureSeconds || exp < iat) {
    throw new Error('invalid telemetry attestation exp');
  }
  return {
    owner: input.owner,
    runId: input.runId,
    deviceId: input.deviceId,
    ...(sequence === undefined ? {} : { sequence }),
    exp,
    iat,
    aud: SIM2REAL_TELEMETRY_ATTESTATION_AUDIENCE,
    v: SIM2REAL_TELEMETRY_ATTESTATION_VERSION,
  };
}

/**
 * Issue a JWT-compatible HS256 token. The overload accepting a string keeps
 * adapters small (`create...(claims, secret)`), while the options form makes
 * clock injection and key rotation explicit.
 */
export function createSim2RealTelemetryAttestationToken(
  input: Sim2RealTelemetryAttestationIssueInput,
  secretOrOptions?: string | Buffer | Sim2RealTelemetryAttestationOptions,
): string {
  const options: Sim2RealTelemetryAttestationOptions =
    typeof secretOrOptions === 'string' || Buffer.isBuffer(secretOrOptions)
      ? { secret: secretOrOptions }
      : (secretOrOptions ?? {});
  const secret = configuredSecret(options.secret);
  if (!secret) throw new Error('telemetry attestation secret is not configured or is too short');
  const now = currentEpochSeconds(options.now);
  const maxFutureSeconds = Number.isSafeInteger(options.maxFutureSeconds)
    ? Number(options.maxFutureSeconds)
    : DEFAULT_MAX_FUTURE_SECONDS;
  const claims = normalizeIssueClaims(input, now, maxFutureSeconds);
  const header = base64url(
    JSON.stringify({ alg: SIM2REAL_TELEMETRY_ATTESTATION_ALGORITHM, typ: 'JWT' }),
  );
  const payload = base64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64url(signature)}`;
}

/** Alias used by board-agent integrations. */
export const issueSim2RealTelemetryAttestationToken = createSim2RealTelemetryAttestationToken;
export const createTelemetryAttestationToken = createSim2RealTelemetryAttestationToken;
export const issueTelemetryAttestationToken = createSim2RealTelemetryAttestationToken;

function parseClaims(
  payload: Buffer,
  now: number,
  maxFutureSeconds: number,
): Sim2RealTelemetryAttestationVerification {
  if (payload.length > MAX_PAYLOAD_BYTES) return { valid: false, reason: 'invalid-claims' };
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    return { valid: false, reason: 'invalid-claims' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'invalid-claims' };
  }
  const source = value as Record<string, unknown>;
  const { owner, runId, deviceId, sequence, exp, iat, aud, v } = source;
  if (
    !validText(owner, OWNER_PATTERN) ||
    !validText(runId, RESOURCE_ID_PATTERN) ||
    !validText(deviceId, RESOURCE_ID_PATTERN)
  ) {
    return { valid: false, reason: 'invalid-claims' };
  }
  if (!Number.isSafeInteger(exp) || Number(exp) <= 0) {
    return { valid: false, reason: 'invalid-claims' };
  }
  if (
    sequence !== undefined &&
    (!Number.isSafeInteger(sequence) || Number(sequence) < 0 || Number(sequence) > 2_000_000_000)
  ) {
    return { valid: false, reason: 'invalid-claims' };
  }
  if (iat !== undefined && (!Number.isSafeInteger(iat) || Number(iat) < 0)) {
    return { valid: false, reason: 'invalid-claims' };
  }
  // `aud` and `v` were added after the first board-agent rollout.  They are
  // optional on verification for a backwards-compatible key rotation, but if
  // supplied they must identify this exact telemetry envelope.
  if (aud !== undefined && aud !== SIM2REAL_TELEMETRY_ATTESTATION_AUDIENCE) {
    return { valid: false, reason: 'invalid-claims' };
  }
  if (v !== undefined && v !== SIM2REAL_TELEMETRY_ATTESTATION_VERSION) {
    return { valid: false, reason: 'invalid-claims' };
  }
  const expiry = Number(exp);
  if (expiry <= now) return { valid: false, reason: 'expired' };
  if (expiry > now + maxFutureSeconds) return { valid: false, reason: 'too-far-in-the-future' };
  if (iat !== undefined) {
    const issuedAt = Number(iat);
    if (issuedAt > now + CLOCK_SKEW_SECONDS)
      return { valid: false, reason: 'issued-in-the-future' };
    if (expiry < issuedAt) return { valid: false, reason: 'invalid-claims' };
  }
  return {
    valid: true,
    claims: {
      owner,
      runId,
      deviceId,
      ...(sequence === undefined ? {} : { sequence: Number(sequence) }),
      exp: expiry,
      ...(iat === undefined ? {} : { iat: Number(iat) }),
      ...(aud === undefined ? {} : { aud: String(aud) }),
      ...(v === undefined ? {} : { v: Number(v) }),
    },
  };
}

function parseHeader(value: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(value.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const source = parsed as Record<string, unknown>;
    return (
      source.alg === SIM2REAL_TELEMETRY_ATTESTATION_ALGORITHM &&
      (source.typ === undefined || source.typ === 'JWT')
    );
  } catch {
    return false;
  }
}

/** Detailed verifier used by the HTTP route so malformed and expired tokens
 * can be logged/observed without ever returning claim data to a client. */
export function verifySim2RealTelemetryAttestationTokenDetailed(
  token: string,
  options: Sim2RealTelemetryAttestationOptions = {},
): Sim2RealTelemetryAttestationVerification {
  const raw = String(token ?? '');
  const maxTokenLength = Number.isSafeInteger(options.maxTokenLength)
    ? Math.max(256, Math.min(MAX_TOKEN_LENGTH, Number(options.maxTokenLength)))
    : MAX_TOKEN_LENGTH;
  if (!raw || raw.length > maxTokenLength) return { valid: false, reason: 'malformed-token' };
  const secret = configuredSecret(options.secret);
  if (!secret) return { valid: false, reason: 'secret-not-configured' };
  const parts = raw.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    return { valid: false, reason: 'malformed-token' };
  }
  const [first, second, third] = parts;
  const now = currentEpochSeconds(options.now);
  const maxFutureSeconds = Number.isSafeInteger(options.maxFutureSeconds)
    ? Number(options.maxFutureSeconds)
    : DEFAULT_MAX_FUTURE_SECONDS;

  // Standard JWT form: base64url(header).base64url(payload).base64url(sig).
  // Also accept the original compact `v1.payload.signature` envelope used by
  // early board-agent prototypes; both forms verify the exact bytes received.
  const header = decodeBase64url(first, 512);
  const payload = decodeBase64url(second, MAX_PAYLOAD_BYTES);
  let signingInput = `${first}.${second}`;
  if (!header || !parseHeader(header)) {
    if (first !== `v${SIM2REAL_TELEMETRY_ATTESTATION_VERSION}`) {
      return { valid: false, reason: 'invalid-header' };
    }
    signingInput = `${first}.${second}`;
  }
  const signature = decodeSignature(third);
  if (!payload || !signature || signature.length !== 32) {
    return { valid: false, reason: 'malformed-token' };
  }
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
    return { valid: false, reason: 'invalid-signature' };
  }
  return parseClaims(payload, now, maxFutureSeconds);
}

function decodeSignature(value: string): Buffer | null {
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  return decodeBase64url(value, 64);
}

/** Simple null-returning verifier for non-HTTP adapters. */
export function verifySim2RealTelemetryAttestationToken(
  token: string,
  options: Sim2RealTelemetryAttestationOptions = {},
): Sim2RealTelemetryAttestationClaims | null {
  const result = verifySim2RealTelemetryAttestationTokenDetailed(token, options);
  return result.valid ? result.claims : null;
}

export const verifySim2RealTelemetryAttestation = verifySim2RealTelemetryAttestationToken;
export const parseSim2RealTelemetryAttestationToken = verifySim2RealTelemetryAttestationToken;
export const verifyTelemetryAttestationToken = verifySim2RealTelemetryAttestationToken;
export const parseTelemetryAttestationToken = verifySim2RealTelemetryAttestationToken;

/** Parse one Authorization header without accepting comma-separated values. */
export function readSim2RealBearerToken(request: Request): Sim2RealBearerToken {
  const rawHeader = request.headers.authorization;
  if (rawHeader === undefined) return { present: false };
  if (Array.isArray(rawHeader)) {
    if (rawHeader.length !== 1) return { present: true, malformed: true };
    return readBearerValue(rawHeader[0]);
  }
  return readBearerValue(String(rawHeader));
}

function readBearerValue(value: string): Sim2RealBearerToken {
  const raw = value.trim();
  if (!raw) return { present: true, malformed: true };
  const match = /^Bearer[ \t]+([^ \t,]+)$/i.exec(raw);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) return { present: true, malformed: true };
  return { present: true, token: match[1] };
}

export const extractSim2RealBearerToken = readSim2RealBearerToken;
