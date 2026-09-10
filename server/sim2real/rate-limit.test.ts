import express, { type Express, type Request } from 'express';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_EXEMPT_PATHS,
  RATE_LIMIT_WINDOW_MS,
  createRateLimitMiddleware,
  isRateLimitExemptPath,
  resolveRateLimitKey,
  resolveRateLimitPerMinute,
  type RateLimitMiddleware,
} from './rate-limit.js';

const originalEnv = { ...process.env };
const openServers: Array<ReturnType<Express['listen']>> = [];

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(app: Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

type Fixture = {
  baseUrl: string;
  limiter: RateLimitMiddleware;
  advance: (milliseconds: number) => void;
};

async function startApp(
  options: {
    limitPerMinute?: number;
    maxKeys?: number;
    resolveOwner?: (request: Request) => string | null;
  } = {},
): Promise<Fixture> {
  let currentTime = 1_700_000_000_000;
  const limiter = createRateLimitMiddleware({
    limitPerMinute: options.limitPerMinute ?? 3,
    now: () => currentTime,
    ...(options.maxKeys === undefined ? {} : { maxKeys: options.maxKeys }),
    ...(options.resolveOwner === undefined ? {} : { resolveOwner: options.resolveOwner }),
  });
  const app = express();
  // `trust proxy` mirrors EXPRESS_TRUST_PROXY=1 in production; `request.ip` then
  // reads X-Forwarded-For so distinct callers can be exercised in tests.
  app.set('trust proxy', true);
  app.use(limiter);
  app.get('/api/work', (_request, response) => {
    response.json({ ok: true });
  });
  for (const exemptPath of RATE_LIMIT_EXEMPT_PATHS) {
    app.get(exemptPath, (_request, response) => {
      response.json({ ok: true });
    });
  }
  return {
    baseUrl: await listen(app),
    limiter,
    advance: (milliseconds) => {
      currentTime += milliseconds;
    },
  };
}

describe('rate limit configuration', () => {
  it('defaults to a generous limit and treats 0 as disabled', () => {
    expect(resolveRateLimitPerMinute('')).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
    expect(resolveRateLimitPerMinute(undefined)).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
    expect(DEFAULT_RATE_LIMIT_PER_MINUTE).toBe(1_200);
    expect(resolveRateLimitPerMinute('0')).toBe(0);
    expect(resolveRateLimitPerMinute('300')).toBe(300);
    expect(resolveRateLimitPerMinute(' 240 ')).toBe(240);
    expect(resolveRateLimitPerMinute('abc')).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
    expect(resolveRateLimitPerMinute('-5')).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
    expect(resolveRateLimitPerMinute('999999999999')).toBe(10_000_000);
  });

  it('exempts only the probe and scrape paths', () => {
    for (const path of ['/healthz', '/readyz', '/api/healthz', '/api/readyz', '/metrics']) {
      expect(isRateLimitExemptPath(path)).toBe(true);
    }
    expect(isRateLimitExemptPath('/api/sim2real/overview')).toBe(false);
    expect(isRateLimitExemptPath('/')).toBe(false);
  });
});

describe('rate limit middleware', () => {
  it('allows requests under the limit and reports the remaining budget', async () => {
    const { baseUrl } = await startApp({ limitPerMinute: 3 });
    const first = await fetch(`${baseUrl}/api/work`);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('3');
    expect(first.headers.get('x-ratelimit-remaining')).toBe('2');
    expect(Number(first.headers.get('x-ratelimit-reset'))).toBeGreaterThan(0);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
  });

  it('rejects over-limit requests with 429, Retry-After and the Chinese message', async () => {
    const { baseUrl } = await startApp({ limitPerMinute: 2 });
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);

    const limited = await fetch(`${baseUrl}/api/work`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get('x-ratelimit-limit')).toBe('2');
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(await limited.json()).toEqual({
      ok: false,
      error: 'SIM2REAL_RATE_LIMITED',
      message: '请求过于频繁，已达到本服务的限流阈值，请稍后重试。',
    });
  });

  it('recovers as the bucket refills over the window', async () => {
    const { baseUrl, advance } = await startApp({ limitPerMinute: 2 });
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(429);

    // Half a window refills exactly one token for a 2/minute bucket.
    advance(RATE_LIMIT_WINDOW_MS / 2);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(429);

    // A full window restores the whole budget.
    advance(RATE_LIMIT_WINDOW_MS);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
  });

  it('does not count exempt paths against the caller budget', async () => {
    const { baseUrl, limiter } = await startApp({ limitPerMinute: 2 });
    for (let index = 0; index < 20; index += 1) {
      expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/readyz`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200);
    }
    expect(limiter.size()).toBe(0);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`)).status).toBe(200);
  });

  it('can be disabled with RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE=0', async () => {
    const { baseUrl } = await startApp({ limitPerMinute: 0 });
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${baseUrl}/api/work`);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-ratelimit-limit')).toBeNull();
    }
  });

  it('keeps separate buckets per verified owner, not per shared address', async () => {
    const { baseUrl, limiter } = await startApp({
      limitPerMinute: 2,
      // Stands in for the composition root's verified auth port.
      resolveOwner: (request) => {
        const header = request.headers['x-test-owner'];
        return typeof header === 'string' && header ? `sso:${header}:web` : null;
      },
    });
    const ownerA = { headers: { 'x-test-owner': 'alice' } };
    const ownerB = { headers: { 'x-test-owner': 'bob' } };
    expect((await fetch(`${baseUrl}/api/work`, ownerA)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`, ownerA)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/work`, ownerA)).status).toBe(429);
    expect((await fetch(`${baseUrl}/api/work`, ownerB)).status).toBe(200);
    expect(limiter.size()).toBe(2);
  });

  it('never stores or exposes the raw account id in the key', () => {
    const ownerKey = resolveRateLimitKey({ headers: {}, ip: '10.0.0.9' } as unknown as Request, {
      resolveOwner: () => 'sso:alice:web',
    });
    expect(ownerKey.startsWith('owner:')).toBe(true);
    expect(ownerKey).not.toContain('alice');
    expect(ownerKey).not.toContain('sso:');
    expect(resolveRateLimitKey({ headers: {}, ip: '10.0.0.9' } as unknown as Request)).toBe(
      'ip:10.0.0.9',
    );
  });
});

describe('rate limit memory bounds', () => {
  it('caps tracked keys and sweeps fully refilled buckets', async () => {
    let currentTime = 1_700_000_000_000;
    const limiter = createRateLimitMiddleware({
      limitPerMinute: 100,
      maxKeys: 4,
      now: () => currentTime,
    });
    for (let index = 0; index < 50; index += 1) {
      limiter.decide(`ip:10.0.0.${index}`);
    }
    expect(limiter.size()).toBe(4);

    currentTime += RATE_LIMIT_WINDOW_MS + 1;
    limiter.decide('ip:10.0.0.250');
    expect(limiter.size()).toBe(1);
  });

  it('still enforces the limit for a key that stays inside the cap', () => {
    const limiter = createRateLimitMiddleware({ limitPerMinute: 3, maxKeys: 8 });
    expect(limiter.decide('ip:10.0.0.1').allowed).toBe(true);
    expect(limiter.decide('ip:10.0.0.1').allowed).toBe(true);
    expect(limiter.decide('ip:10.0.0.1').allowed).toBe(true);
    const rejected = limiter.decide('ip:10.0.0.1');
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(limiter.peek('ip:10.0.0.1').allowed).toBe(false);
    expect(limiter.size()).toBe(1);
  });
});
