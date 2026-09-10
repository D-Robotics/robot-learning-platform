import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import type { Sim2RealAuthPort, Sim2RealPrincipal } from './sim2real-auth.js';

/**
 * Small, dependency-free auth adapter for deployments where an existing SSO
 * gateway terminates OIDC and forwards a signed identity to this service.
 *
 * The gateway must strip these headers from the client request and add them
 * after authentication.  The signature covers the HTTP method, upstream path
 * (including its query string),
 * account id, timestamp, and optional short-lived RoboGo token so a leaked
 * header cannot be moved to a different API operation without detection.
 */
export const TRUSTED_PROXY_HEADERS = Object.freeze({
  account: 'x-rdk-account',
  timestamp: 'x-rdk-auth-timestamp',
  signature: 'x-rdk-auth-signature',
  displayName: 'x-rdk-display-name',
  email: 'x-rdk-email',
  runnerToken: 'x-rdk-robogo-token',
});

const ACCOUNT_PATTERN = /^[^\u0000-\u001f\u007f/]{1,160}$/;
const MAX_TOKEN_LENGTH = 4_096;
const DEFAULT_MAX_AGE_SECONDS = 300;
// Keep replay protection fail-closed under a burst of otherwise valid
// signatures.  The gateway should still rate-limit this endpoint, but the
// adapter must not let an unbounded number of unique mutations grow process
// memory indefinitely during the five-minute replay window.
export const MAX_TRUSTED_PROXY_MUTATIONS = 10_000;

type VerifiedIdentity = {
  principal: Sim2RealPrincipal;
  runnerToken?: string;
};

function header(request: Request, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value.join(',') : String(value ?? '')).trim();
}

function safeHeader(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function requestPath(request: Request): string {
  const pathValue = String(request.path || '').trim();
  const urlValue = String(request.originalUrl || request.url || '').trim();
  // Express' `path` omits the query string while `url` retains it. Prefer the
  // original URL when available; otherwise combine both so adapter tests and
  // lightweight request shims cannot silently ignore a changed pathname.
  const query = urlValue.indexOf('?');
  const value = String(
    request.originalUrl ||
      (pathValue
        ? pathValue.includes('?')
          ? pathValue
          : pathValue + (query >= 0 ? urlValue.slice(query) : '')
        : urlValue || '/'),
  ).trim();
  return value.startsWith('/') && !/[\u0000\r\n]/.test(value) ? value : '/';
}

/** Canonical string that the SSO gateway must sign with HMAC-SHA256. */
export function trustedProxyCanonicalMessage(input: {
  method: string;
  path: string;
  accountId: string;
  timestamp: string;
  runnerToken?: string;
  displayName?: string;
  email?: string;
}): string {
  return [
    String(input.timestamp).trim(),
    String(input.method || 'GET').toUpperCase(),
    String(input.path || '/'),
    String(input.accountId),
    String(input.runnerToken || ''),
    String(input.displayName || ''),
    String(input.email || ''),
  ].join('\n');
}

function decodeSignature(value: string): Buffer | null {
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (!/^[a-zA-Z0-9_-]{40,128}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function configuredSecret(raw?: string): Buffer | null {
  const value = String(raw ?? process.env.RDK_SIM2REAL_TRUSTED_PROXY_SECRET ?? '').trim();
  // A short value is almost certainly a placeholder or an operator mistake.
  if (Buffer.byteLength(value, 'utf8') < 32 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return Buffer.from(value, 'utf8');
}

/** Exposed for readiness pages and deployment checks; never returns the secret. */
export function trustedProxyAuthConfigured(raw?: string): boolean {
  return configuredSecret(raw) !== null;
}

function maxAgeSeconds(raw?: number): number {
  const value = Number(raw ?? process.env.RDK_SIM2REAL_TRUSTED_PROXY_MAX_AGE_SECONDS);
  return Number.isFinite(value) && value >= 30 && value <= 900
    ? Math.floor(value)
    : DEFAULT_MAX_AGE_SECONDS;
}

function verifyRequest(
  request: Request,
  secret: Buffer | null,
  maxAge: number,
  now: () => number,
): VerifiedIdentity | null {
  if (!secret) return null;
  const accountId = safeHeader(header(request, TRUSTED_PROXY_HEADERS.account), 160);
  const timestamp = safeHeader(header(request, TRUSTED_PROXY_HEADERS.timestamp), 32);
  const signature = decodeSignature(header(request, TRUSTED_PROXY_HEADERS.signature));
  const timestampSeconds = Number(timestamp);
  if (
    !ACCOUNT_PATTERN.test(accountId) ||
    !/^\d{1,15}$/.test(timestamp) ||
    !Number.isSafeInteger(timestampSeconds) ||
    !signature ||
    Math.abs(Math.floor(now() / 1000) - timestampSeconds) > maxAge
  ) {
    return null;
  }
  const runnerToken = safeHeader(header(request, TRUSTED_PROXY_HEADERS.runnerToken), MAX_TOKEN_LENGTH);
  const displayName = safeHeader(header(request, TRUSTED_PROXY_HEADERS.displayName), 120);
  const email = safeHeader(header(request, TRUSTED_PROXY_HEADERS.email), 240);
  const message = trustedProxyCanonicalMessage({
    method: request.method,
    path: requestPath(request),
    accountId,
    timestamp,
    runnerToken,
    displayName,
    email,
  });
  const expected = createHmac('sha256', secret).update(message).digest();
  if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) return null;
  return {
    principal: {
      accountId,
      ...(displayName ? { displayName } : {}),
      ...(email ? { email } : {}),
    },
    ...(runnerToken ? { runnerToken } : {}),
  };
}

function isMutatingMethod(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase());
}

/**
 * Replay protection state is process-local by design. This adapter targets a
 * single-node standalone deployment; running multiple instances behind one
 * gateway (cluster workers or horizontally scaled pods) splits the replay
 * window across processes and weakens the guarantee. For a multi-instance
 * deployment, replace this adapter with one backed by shared state (Redis or
 * the gateway's own idempotency layer) before enabling trusted-proxy mode.
 */
export function createTrustedProxyAuth(options: {
  secret?: string;
  maxAgeSeconds?: number;
  now?: () => number;
  /** Disable only for deterministic adapter tests; keep enabled in production. */
  replayProtection?: boolean;
} = {}): Sim2RealAuthPort {
  const secret = configuredSecret(options.secret);
  const maxAge = maxAgeSeconds(options.maxAgeSeconds);
  const now = options.now ?? Date.now;
  const replayProtection = options.replayProtection !== false;
  const requestCache = new WeakMap<object, VerifiedIdentity | null>();
  const seenMutations = new Map<string, number>();
  const verify = (request: Request): VerifiedIdentity | null => {
    if (requestCache.has(request)) return requestCache.get(request) ?? null;
    const verified = verifyRequest(request, secret, maxAge, now);
    if (!verified || !replayProtection || !isMutatingMethod(request.method)) {
      requestCache.set(request, verified);
      return verified;
    }
    const currentSeconds = Math.floor(now() / 1000);
    for (const [key, expiresAt] of seenMutations) {
      if (expiresAt <= currentSeconds) seenMutations.delete(key);
    }
    const signature = header(request, TRUSTED_PROXY_HEADERS.signature);
    const replayKey = `${signature}\n${request.method}\n${requestPath(request)}\n${verified.principal.accountId}`;
    if (seenMutations.has(replayKey)) {
      requestCache.set(request, null);
      return null;
    }
    if (seenMutations.size >= MAX_TRUSTED_PROXY_MUTATIONS) {
      // Evicting a live entry would reopen a replay window. Reject new
      // mutations until old entries expire instead; callers receive the same
      // fail-closed unauthenticated result as any other invalid signature.
      requestCache.set(request, null);
      return null;
    }
    seenMutations.set(replayKey, currentSeconds + maxAge);
    requestCache.set(request, verified);
    return verified;
  };
  return Object.freeze({
    isMultiUserDeployment: () => true,
    resolvePrincipal: (request: Request) => verify(request)?.principal ?? null,
    resolveAccessToken: (request: Request) => verify(request)?.runnerToken ?? null,
  });
}
