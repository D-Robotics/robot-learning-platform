import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DURATION_BUCKETS_SECONDS,
  LOG_FIELD_WHITELIST,
  createSim2RealLogger,
  createSim2RealMetrics,
  createSim2RealObservability,
  normalizeRouteLabel,
  resolveLogLevel,
  sanitizeLogFields,
} from './observability.js';
import { createSim2RealWebApp } from '../../services/sim2real-web/server.js';

const originalEnv = { ...process.env };
const temporaryRoots: string[] = [];
const openServers: Array<ReturnType<Express['listen']>> = [];
let emittedLines: string[] = [];

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
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  emittedLines = [];
});

/** The completion listener runs on the server side of the socket; give it a
 * bounded moment to observe the response before asserting on its effects. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

async function startInstrumentedApp(
  options: { level?: string; maxRouteLabels?: number; extra?: (app: Express) => void } = {},
): Promise<{ baseUrl: string; metrics: ReturnType<typeof createSim2RealMetrics> }> {
  emittedLines = [];
  const observability = createSim2RealObservability({
    level: options.level,
    maxRouteLabels: options.maxRouteLabels,
    sink: (line) => emittedLines.push(line),
  });
  const app = express();
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Request-Id', 'test-request-id');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use(observability.requestMiddleware);
  app.get('/api/runs/:runId', (_request, response) => {
    response.json({ ok: true });
  });
  app.post('/api/echo', (_request, response) => {
    response.json({ ok: true });
  });
  app.get('/api/boom', () => {
    throw new Error('boom');
  });
  app.get('/static-ish', (_request, response) => {
    response.send('ok');
  });
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).json({ ok: false });
  });
  options.extra?.(app);
  return { baseUrl: await listen(app), metrics: observability.metrics };
}

describe('structured logging', () => {
  it('resolves levels strictly and falls back to info', () => {
    expect(resolveLogLevel('debug')).toBe('debug');
    expect(resolveLogLevel(' WARN ')).toBe('warn');
    expect(resolveLogLevel('error')).toBe('error');
    expect(resolveLogLevel('silent')).toBe('silent');
    expect(resolveLogLevel('verbose')).toBe('info');
    expect(resolveLogLevel('')).toBe('info');
    expect(resolveLogLevel(undefined)).toBe('info');
  });

  it('filters below the configured level and treats silent as off', () => {
    const lines: string[] = [];
    const logger = createSim2RealLogger({ level: 'warn', sink: (line) => lines.push(line) });
    logger.log('debug', 'debug-event');
    logger.log('info', 'info-event');
    logger.log('warn', 'warn-event');
    logger.log('error', 'error-event');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(['warn', 'error']);
    expect(lines.every((line) => JSON.parse(line).msg.endsWith('-event'))).toBe(true);

    const silentLines: string[] = [];
    const silent = createSim2RealLogger({
      level: 'silent',
      sink: (line) => silentLines.push(line),
    });
    silent.log('error', 'must-not-appear');
    expect(silentLines).toHaveLength(0);
  });

  it('warns exactly once when the configured level is invalid', () => {
    const warnings: string[] = [];
    const logger = createSim2RealLogger({
      level: 'verbose',
      sink: () => undefined,
      warn: (message) => warnings.push(message),
    });
    expect(logger.level).toBe('info');
    logger.log('info', 'first');
    logger.log('info', 'second');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('RDK_SIM2REAL_LOG_LEVEL');
  });

  it('drops every field outside the whitelist, including credentials and bodies', () => {
    const record = sanitizeLogFields({
      authorization: 'Bearer super-secret',
      cookie: 'rdk_sso_session=super-secret',
      'set-cookie': 'a=b',
      token: 'super-secret',
      secret: 'super-secret',
      password: 'super-secret',
      apiKey: 'super-secret',
      body: { password: 'super-secret' },
      headers: { authorization: 'Bearer super-secret' },
      unexpected: 'nope',
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'http_request',
      method: 'GET',
      path: '/api/runs/42',
      status: 200,
      durationMs: 12.3456,
    });
    expect(Object.keys(record).sort()).toEqual(
      ['durationMs', 'level', 'method', 'msg', 'path', 'status', 'ts'].sort(),
    );
    expect(record.durationMs).toBe(12.35);
    expect(JSON.stringify(record)).not.toContain('super-secret');
  });

  it('strips control characters so a crafted path cannot forge a second record', () => {
    const record = sanitizeLogFields({ path: '/api/x\r\n{"level":"error","msg":"forged"}' });
    expect(record.path).toBe('/api/x{"level":"error","msg":"forged"}');
    expect(String(record.path)).not.toMatch(/[\r\n]/);
  });

  it('never logs request headers or bodies for a real request', async () => {
    const { baseUrl } = await startInstrumentedApp();
    const response = await fetch(`${baseUrl}/api/echo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer super-secret-token',
        cookie: 'rdk_sso_session=super-secret-cookie',
      },
      body: JSON.stringify({ password: 'super-secret-password', token: 'super-secret-token' }),
    });
    expect(response.status).toBe(200);
    await waitFor(() => emittedLines.length > 0);
    expect(emittedLines).toHaveLength(1);
    const record = JSON.parse(emittedLines[0]) as Record<string, unknown>;
    expect(
      Object.keys(record).every((key) => (LOG_FIELD_WHITELIST as readonly string[]).includes(key)),
    ).toBe(true);
    expect(emittedLines[0]).not.toContain('super-secret');
    expect(record).toMatchObject({
      level: 'info',
      msg: 'http_request',
      requestId: 'test-request-id',
      method: 'POST',
      path: '/api/echo',
      route: '/api/echo',
      status: 200,
    });
  });

  it('logs 5xx responses at error level', async () => {
    const { baseUrl } = await startInstrumentedApp();
    const response = await fetch(`${baseUrl}/api/boom`);
    expect(response.status).toBe(500);
    await waitFor(() => emittedLines.length > 0);
    expect(emittedLines).toHaveLength(1);
    expect(JSON.parse(emittedLines[0])).toMatchObject({
      level: 'error',
      status: 500,
      path: '/api/boom',
    });
  });

  it('counts non-API traffic without logging it', async () => {
    const { baseUrl, metrics } = await startInstrumentedApp();
    const response = await fetch(`${baseUrl}/static-ish`);
    expect(response.status).toBe(200);
    await waitFor(() => metrics.requestCount() > 0);
    expect(emittedLines).toHaveLength(0);
    expect(metrics.renderPrometheus()).toContain('route="/static-ish"');
  });
});

describe('route label normalization', () => {
  it('replaces identifier segments and drops query strings', () => {
    expect(
      normalizeRouteLabel('GET', '/api/sim2real/runs/6f1c0a3e-1f0e-4a5b-9c8d-2b3f4a5c6d7e'),
    ).toBe('/api/sim2real/runs/:id');
    expect(normalizeRouteLabel('GET', '/api/v1/duck/runs/12345?verbose=1')).toBe(
      '/api/v1/duck/runs/:id',
    );
    expect(
      normalizeRouteLabel(
        'GET',
        '/api/sim2real/runs/run-2026-09-04T00-00-00-000Z?token=super-secret',
      ),
    ).toBe('/api/sim2real/runs/:id');
    expect(normalizeRouteLabel('GET', '')).toBe('/');
  });

  it('keeps Express patterns and static words intact', () => {
    expect(normalizeRouteLabel('GET', '/api/sim2real/runs/:runId')).toBe(
      '/api/sim2real/runs/:runId',
    );
    expect(normalizeRouteLabel('GET', '/api/sim2real/device-connections')).toBe(
      '/api/sim2real/device-connections',
    );
    expect(normalizeRouteLabel('GET', '/mujoco/microduck-proxy/bundle/duck.wasm')).toBe(
      '/mujoco/microduck-proxy/bundle/duck.wasm',
    );
  });

  it('collapses different ids of one route into a single label', async () => {
    const { baseUrl, metrics } = await startInstrumentedApp();
    await fetch(`${baseUrl}/api/runs/6f1c0a3e-1f0e-4a5b-9c8d-2b3f4a5c6d7e`);
    await fetch(`${baseUrl}/api/runs/12345`);
    await waitFor(() => metrics.requestCount() === 2);
    expect(metrics.requestCount()).toBe(2);
    expect(metrics.routeLabelCount()).toBe(1);
    const output = metrics.renderPrometheus();
    // A matched Express route contributes its own template (`:runId`), which is
    // already bounded; the raw ids must never appear as label values.
    expect(output).toContain(
      'sim2real_http_requests_total{method="GET",route="/api/runs/:runId",status="200"} 2',
    );
    expect(output).not.toContain('6f1c0a3e-1f0e-4a5b-9c8d-2b3f4a5c6d7e');
    expect(output).not.toContain('12345');
  });

  it('caps label cardinality instead of tracking unbounded routes', () => {
    const metrics = createSim2RealMetrics({ maxRouteLabels: 3 });
    for (let index = 0; index < 10; index += 1) {
      metrics.recordRequest({
        method: 'GET',
        route: `/api/thing-${index}/detail`,
        status: 200,
        durationMs: 1,
      });
    }
    expect(metrics.routeLabelCount()).toBeLessThanOrEqual(3);
    const output = metrics.renderPrometheus();
    expect(output).toContain('route="__other__"');
    expect(output).not.toContain('route="/api/thing-9/detail"');
  });
});

describe('prometheus metrics', () => {
  it('increments counters and histogram buckets', () => {
    const metrics = createSim2RealMetrics();
    metrics.recordRequest({ method: 'GET', route: '/api/healthz', status: 200, durationMs: 3 });
    metrics.recordRequest({ method: 'GET', route: '/api/healthz', status: 200, durationMs: 40 });
    metrics.recordRequest({
      method: 'POST',
      route: '/api/sim2real/plans',
      status: 500,
      durationMs: 100,
    });
    expect(metrics.requestCount()).toBe(3);
    const output = metrics.renderPrometheus();
    expect(output).toContain(
      'sim2real_http_requests_total{method="GET",route="/api/healthz",status="200"} 2',
    );
    expect(output).toContain(
      'sim2real_http_requests_total{method="POST",route="/api/sim2real/plans",status="500"} 1',
    );
    expect(output).toContain(
      'sim2real_http_request_duration_seconds_count{method="GET",route="/api/healthz"} 2',
    );
    expect(output).toContain(
      'sim2real_http_request_duration_seconds_bucket{method="GET",route="/api/healthz",le="0.005"} 1',
    );
    expect(output).toContain(
      'sim2real_http_request_duration_seconds_bucket{method="GET",route="/api/healthz",le="0.05"} 2',
    );
    expect(output).toContain(
      'sim2real_http_request_duration_seconds_bucket{method="POST",route="/api/sim2real/plans",le="+Inf"} 1',
    );
  });

  it('renders parseable Prometheus text with HELP and TYPE families', () => {
    const metrics = createSim2RealMetrics();
    metrics.recordRequest({ method: 'GET', route: '/api/x', status: 200, durationMs: 7.5 });
    const output = metrics.renderPrometheus();
    expect(output).toContain('# HELP sim2real_http_requests_total');
    expect(output).toContain('# TYPE sim2real_http_requests_total counter');
    expect(output).toContain('# HELP sim2real_http_request_duration_seconds');
    expect(output).toContain('# TYPE sim2real_http_request_duration_seconds histogram');
    expect(output).toContain('# TYPE sim2real_process_uptime_seconds gauge');
    expect(output).toContain('# TYPE sim2real_memory_rss_bytes gauge');
    expect(output).toMatch(/sim2real_process_uptime_seconds \d+(\.\d+)?/);
    expect(output).toMatch(/sim2real_memory_rss_bytes \d+/);
    expect(DURATION_BUCKETS_SECONDS.length).toBeGreaterThan(5);
    const sampleLine = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d+(\.\d+)?([eE][+-]?\d+)?$/;
    for (const line of output.split('\n').filter(Boolean)) {
      if (line.startsWith('#')) {
        expect(line).toMatch(/^# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* /);
        continue;
      }
      expect(line, line).toMatch(sampleLine);
    }
  });

  it('exposes /metrics from the wired app without leaking request secrets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-observability-'));
    temporaryRoots.push(root);
    process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
    process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
    delete process.env.RDK_SIM2REAL_AUTH_MODE;
    delete process.env.RDK_SIM2REAL_SSO_REQUIRED;
    delete process.env.SSO_REQUIRED;
    delete process.env.RDK_STUDIO_DEPLOYMENT_PROFILE;
    process.env.RDK_SIM2REAL_LOG_LEVEL = 'silent';

    const baseUrl = await listen(createSim2RealWebApp());
    expect((await fetch(`${baseUrl}/api/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/does-not-exist?token=super-secret-token`)).status).toBe(
      404,
    );

    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const body = await response.text();
    expect(body).toContain('# TYPE sim2real_http_requests_total counter');
    expect(body).toContain('# HELP sim2real_http_request_duration_seconds');
    expect(body).toContain('route="/api/healthz"');
    expect(body).toContain('sim2real_process_uptime_seconds');
    expect(body).toContain('sim2real_memory_rss_bytes');
    expect(body).not.toContain('super-secret-token');
    expect(body).not.toContain('token=');
    expect(body).not.toContain(root);
  });
});
