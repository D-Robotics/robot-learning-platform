import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

/**
 * In-process application rate limiting for the standalone Sim2Real service.
 *
 * The service has no external dependency (no Redis, no npm package) and no
 * persistent state, so the limiter must be cheap, bounded and honest: it keeps
 * one token bucket per caller, deletes buckets that have fully refilled and
 * never tracks more than a fixed number of keys. That makes it a safety net
 * against a runaway UI poll or a misbehaving script inside one process; a
 * multi-replica deployment still needs an ingress-level limit.
 *
 * Keys never trust a client-controlled header. The composition root injects
 * `resolveOwner`, which reuses the verified auth port; identity values are
 * hashed before they are stored so account ids do not linger in process memory.
 * Everything else falls back to the transport address, which honours the
 * repository's `EXPRESS_TRUST_PROXY` setting through `request.ip`.
 */

export const RATE_LIMIT_PER_MINUTE_ENV = 'RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE';
/** Deliberately generous: normal UI polling must never be interrupted. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 1200;
/** Refill horizon: one full bucket per minute, matching the env var's name. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Probe and scraping endpoints must stay reachable while a caller is limited. */
export const RATE_LIMIT_EXEMPT_PATHS: readonly string[] = Object.freeze([
  '/healthz',
  '/readyz',
  '/api/healthz',
  '/api/readyz',
  '/metrics',
]);

const MAX_CONFIGURED_LIMIT = 10_000_000;
const MAX_OWNER_KEY_LENGTH = 320;
const MAX_ADDRESS_LENGTH = 64;
const DEFAULT_MAX_KEYS = 10_000;

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch milliseconds when the bucket is full again. */
  resetAt: number;
  retryAfterSeconds: number;
};

export type RateLimitKeyOptions = {
  resolveOwner?: (request: Request) => string | null | undefined;
};

export type RateLimitMiddlewareOptions = RateLimitKeyOptions & {
  limitPerMinute?: unknown;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
};

export type RateLimitMiddleware = RequestHandler & {
  /** Consume one token for `key`. */
  decide(key: string): RateLimitDecision;
  /** Inspect the bucket for `key` without consuming a token. */
  peek(key: string): RateLimitDecision;
  /** Number of tracked keys; exposed so memory bounds are testable. */
  size(): number;
};

/**
 * `RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE`: an integer, `0` disables the limiter.
 * Missing or malformed values fall back to the documented default rather than
 * to something stricter, so a typo cannot take the service down.
 */
export function resolveRateLimitPerMinute(
  raw: unknown = process.env[RATE_LIMIT_PER_MINUTE_ENV],
): number {
  const text = String(raw ?? '').trim();
  if (!text || !/^\d+$/.test(text)) return DEFAULT_RATE_LIMIT_PER_MINUTE;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return DEFAULT_RATE_LIMIT_PER_MINUTE;
  return value > MAX_CONFIGURED_LIMIT ? MAX_CONFIGURED_LIMIT : value;
}

export function isRateLimitExemptPath(requestPath: unknown): boolean {
  return RATE_LIMIT_EXEMPT_PATHS.includes(String(requestPath ?? ''));
}

/** Keeps account ids out of the counters while still separating tenants. */
export function hashRateLimitKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function boundAddress(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, MAX_ADDRESS_LENGTH) : 'unknown';
}

/** Transport address only; `request.ip` already respects `trust proxy`. */
export function resolveClientAddress(request: Request): string {
  const address = String(request.ip ?? '').trim();
  if (address) return boundAddress(address);
  const socketAddress = request.socket ? request.socket.remoteAddress : undefined;
  return socketAddress ? boundAddress(String(socketAddress)) : 'unknown';
}

export function resolveRateLimitKey(request: Request, options: RateLimitKeyOptions = {}): string {
  let owner = '';
  try {
    owner = String(options.resolveOwner?.(request) ?? '').trim();
  } catch {
    owner = '';
  }
  if (owner && owner.length <= MAX_OWNER_KEY_LENGTH && !/[\u0000-\u001f\u007f]/.test(owner)) {
    return `owner:${hashRateLimitKey(owner)}`;
  }
  return `ip:${resolveClientAddress(request)}`;
}

type Bucket = {
  /** Tokens available at `updatedAt` (fractional while refilling). */
  tokens: number;
  updatedAt: number;
};

export function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions = {},
): RateLimitMiddleware {
  const limit = resolveRateLimitPerMinute(options.limitPerMinute);
  const windowMs =
    typeof options.windowMs === 'number' &&
    Number.isFinite(options.windowMs) &&
    options.windowMs >= 1_000
      ? Math.floor(options.windowMs)
      : RATE_LIMIT_WINDOW_MS;
  const maxKeys =
    typeof options.maxKeys === 'number' &&
    Number.isSafeInteger(options.maxKeys) &&
    options.maxKeys > 0
      ? options.maxKeys
      : DEFAULT_MAX_KEYS;
  const now = options.now ?? (() => Date.now());
  const refillPerMs = limit > 0 ? limit / windowMs : 0;
  const buckets = new Map<string, Bucket>();
  let lastSweepAt = 0;

  function tokensAt(key: string, currentTime: number): number {
    const bucket = buckets.get(key);
    if (!bucket) return limit;
    return Math.min(limit, bucket.tokens + (currentTime - bucket.updatedAt) * refillPerMs);
  }

  /** A bucket that has fully refilled is indistinguishable from a new one, so
   * deleting it cannot change any decision — it only frees memory. */
  function sweep(currentTime: number): void {
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.updatedAt >= windowMs) buckets.delete(key);
    }
    lastSweepAt = currentTime;
  }

  function evaluate(key: string, consume: boolean): RateLimitDecision {
    const currentTime = now();
    if (limit <= 0) {
      return { allowed: true, limit: 0, remaining: 0, resetAt: currentTime, retryAfterSeconds: 0 };
    }
    if (currentTime - lastSweepAt >= windowMs || buckets.size > maxKeys) sweep(currentTime);
    const tokens = tokensAt(key, currentTime);
    const allowed = tokens >= 1;
    const remainingTokens = allowed ? tokens - 1 : tokens;
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000));
    if (consume) {
      if (buckets.size >= maxKeys && !buckets.has(key)) {
        // Bounded memory. The evicted key simply starts from a full bucket,
        // which is the same fail-open the sweep already performs; a caller that
        // can create more than `maxKeys` identities at once is an ingress
        // problem, not something this in-process net can solve.
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
      buckets.set(key, { tokens: remainingTokens, updatedAt: currentTime });
    }
    return {
      allowed,
      limit,
      remaining: Math.max(0, Math.floor(remainingTokens)),
      resetAt: currentTime + Math.ceil((limit - remainingTokens) / refillPerMs),
      retryAfterSeconds,
    };
  }

  const decide = (key: string): RateLimitDecision => evaluate(key, true);
  const peek = (key: string): RateLimitDecision => evaluate(key, false);

  const middleware = ((request, response, next) => {
    if (limit <= 0 || isRateLimitExemptPath(request.path)) {
      next();
      return;
    }
    const decision = decide(resolveRateLimitKey(request, { resolveOwner: options.resolveOwner }));
    response.setHeader('X-RateLimit-Limit', String(decision.limit));
    response.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    response.setHeader('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
    if (decision.allowed) {
      next();
      return;
    }
    response.setHeader('Retry-After', String(decision.retryAfterSeconds));
    response.setHeader('Cache-Control', 'no-store');
    response.status(429).json({
      ok: false,
      error: 'SIM2REAL_RATE_LIMITED',
      message: '请求过于频繁，已达到本服务的限流阈值，请稍后重试。',
    });
  }) as RateLimitMiddleware;

  middleware.decide = decide;
  middleware.peek = peek;
  middleware.size = () => buckets.size;
  return middleware;
}
