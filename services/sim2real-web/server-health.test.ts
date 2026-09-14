import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSim2RealWebApp,
  hardenSim2RealHttpServer,
  publicDshEventTail,
  publicDshText,
  SIM2REAL_HTTP_HEADERS_TIMEOUT_MS,
  SIM2REAL_HTTP_KEEP_ALIVE_TIMEOUT_MS,
  SIM2REAL_HTTP_MAX_REQUESTS_PER_SOCKET,
  SIM2REAL_HTTP_REQUEST_TIMEOUT_MS,
} from './server.js';
import { flushSim2RealAudit } from '../../server/sim2real/audit-log.js';

const originalEnv = { ...process.env };
const temporaryRoots: string[] = [];
const openServers: Array<ReturnType<ReturnType<typeof createSim2RealWebApp>['listen']>> = [];
const upstreamServers: http.Server[] = [];

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
    upstreamServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ baseUrl: string; microduckRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-health-'));
  temporaryRoots.push(root);
  const microduckRoot = path.join(root, 'microduck');
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
  delete process.env.RDK_SIM2REAL_AUTH_MODE;
  delete process.env.RDK_SIM2REAL_SSO_REQUIRED;
  delete process.env.SSO_REQUIRED;
  delete process.env.RDK_STUDIO_DEPLOYMENT_PROFILE;
  delete process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
  delete process.env.RDK_SIM2REAL_MICRODUCK_URL;
  delete process.env.RDK_SIM2REAL_DSH_RUNTIME;
  process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
  const app = createSim2RealWebApp();
  const server = app.listen(0, '127.0.0.1');
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, microduckRoot };
}

async function json(url: string): Promise<{ response: Response; payload: any }> {
  const response = await fetch(url);
  return { response, payload: await response.json() };
}

describe('standalone Sim2Real health and optional simulator surface', () => {
  it('sets bounded HTTP timeouts and socket request caps for production starts', () => {
    const server = http.createServer();
    hardenSim2RealHttpServer(server);
    expect(server.requestTimeout).toBe(SIM2REAL_HTTP_REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(SIM2REAL_HTTP_HEADERS_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBe(SIM2REAL_HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.maxRequestsPerSocket).toBe(SIM2REAL_HTTP_MAX_REQUESTS_PER_SOCKET);
  });

  it('reports a usable control plane while an optional MicroDuck release is absent', async () => {
    const { baseUrl } = await fixture();
    const health = await json(`${baseUrl}/healthz`);
    const ready = await json(`${baseUrl}/readyz`);

    expect(health.response.status).toBe(200);
    expect(health.payload).toMatchObject({ ready: true, microduck: { state: 'missing' } });
    expect(health.payload.degraded).toContain('microduck-not-mounted');
    expect(ready.response.status).toBe(200);
  });

  it('serves the versioned Duck API alias from the same business router', async () => {
    const { baseUrl } = await fixture();
    const legacy = await json(`${baseUrl}/api/sim2real/overview`);
    const versioned = await json(`${baseUrl}/api/v1/duck/overview`);

    expect(legacy.response.status).toBe(200);
    expect(versioned.response.status).toBe(200);
    expect(versioned.payload).toMatchObject({
      ok: true,
      schemaVersion: legacy.payload.schemaVersion,
      selectedProductId: legacy.payload.selectedProductId,
    });
    expect(versioned.payload.productProfiles).toEqual(legacy.payload.productProfiles);
  });

  it('publishes capability metadata while validating the optional DSH boundary', async () => {
    const { baseUrl } = await fixture();
    const capabilities = await json(`${baseUrl}/api/sim2real/agent/capabilities`);
    expect(capabilities.response.status).toBe(200);
    expect(capabilities.payload).toMatchObject({
      ok: true,
      runtime: 'legacy',
      capabilities: expect.any(Array),
      dsh: {
        configured: false,
        initialized: false,
        capabilities: expect.any(Array),
      },
    });

    const post = (body: unknown) =>
      fetch(`${baseUrl}/api/sim2real/dsh/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const empty = await post({ message: '   ' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: 'MESSAGE_REQUIRED' });

    const tooLong = await post({ message: 'x'.repeat(12_001) });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ error: 'DSH_MESSAGE_TOO_LONG' });

    const invalidModel = await post({ message: 'hello', model: '../private model' });
    expect(invalidModel.status).toBe(400);
    expect(await invalidModel.json()).toMatchObject({ error: 'DSH_MODEL_INVALID' });

    const disabled = await post({ message: 'hello', model: 'deepseek-chat' });
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: 'DSH_RUNTIME_DISABLED' });
  });

  it('projects DSH events to non-sensitive metadata before returning them', () => {
    expect(
      publicDshEventTail([
        {
          type: 'tool/result',
          timestamp: '2026-09-14T00:00:00.000Z',
          data: { authorization: 'Bearer super-secret-token' },
          arguments: { password: 'do-not-return' },
        },
        { type: 'assistant/message', content: 'private answer' },
        { data: { secret: 'drop this' } },
      ]),
    ).toEqual([
      { type: 'tool/result', at: '2026-09-14T00:00:00.000Z' },
      { type: 'assistant/message' },
    ]);
    const large = publicDshText(`start\u0000${'x'.repeat(25_000)}`);
    expect(large).not.toContain('\u0000');
    expect(large.length).toBe(20_000);
    expect(large.endsWith('…')).toBe(true);
  });

  it('can make the browser release a hard readiness dependency', async () => {
    const { baseUrl } = await fixture();
    process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '1';
    const ready = await json(`${baseUrl}/readyz`);

    expect(ready.response.status).toBe(503);
    expect(ready.payload).toMatchObject({ ready: false, microduckRequired: true });
    expect(ready.payload.degraded).toContain('microduck-not-mounted');
  });

  it('fails readiness closed when the existing JSON ledger is corrupt', async () => {
    const { baseUrl } = await fixture();
    const storageRoot = String(process.env.RDK_SIM2REAL_STORAGE_DIR);
    await fs.mkdir(storageRoot, { recursive: true });
    await fs.writeFile(path.join(storageRoot, 'sim2real.json'), '{"version":1,"runs":[', 'utf8');

    const health = await json(`${baseUrl}/healthz`);
    const ready = await json(`${baseUrl}/readyz`);
    expect(health.response.status).toBe(200);
    expect(health.payload).toMatchObject({ ready: false });
    expect(health.payload.degraded).toContain('storage-not-configured');
    expect(health.payload.storage).toMatchObject({
      writable: false,
      message: expect.stringContaining('台账文件不可读'),
    });
    expect(ready.response.status).toBe(503);
    expect(ready.payload).toMatchObject({ ready: false });
  });

  it('fails readiness closed when production declares an unauthenticated BoardAgent', async () => {
    const { baseUrl } = await fixture();
    process.env.NODE_ENV = 'production';
    process.env.RDK_SIM2REAL_BOARD_AGENT_URL = 'https://board-agent.example.test';
    delete process.env.RDK_SIM2REAL_BOARD_AGENT_TOKEN;

    const health = await json(`${baseUrl}/healthz`);
    const ready = await json(`${baseUrl}/readyz`);

    expect(health.response.status).toBe(200);
    expect(health.payload).toMatchObject({ ready: false });
    expect(health.payload.degraded).toContain('board-agent-auth-required');
    expect(health.payload.boardAgent).toMatchObject({
      directConfigured: true,
      ready: false,
      tokenConfigured: false,
    });
    expect(ready.response.status).toBe(503);
    expect(ready.payload.ready).toBe(false);
  });

  it('fails readiness closed when the production audit sink is unavailable', async () => {
    const { baseUrl } = await fixture();
    process.env.NODE_ENV = 'production';
    process.env.RDK_SIM2REAL_AUDIT_FILE = '/dev/null/rdk-sim2real-audit.ndjson';

    const health = await json(`${baseUrl}/healthz`);
    const ready = await json(`${baseUrl}/readyz`);

    expect(health.response.status).toBe(200);
    expect(health.payload).toMatchObject({ ready: false });
    expect(health.payload.degraded).toContain('audit-unavailable');
    expect(health.payload.audit).toMatchObject({ healthy: false, writable: false });
    expect(ready.response.status).toBe(503);
    expect(ready.payload.ready).toBe(false);
  });

  it('serves a release mounted after process start through the dynamic current symlink', async () => {
    const { baseUrl, microduckRoot } = await fixture();
    await fs.mkdir(microduckRoot, { recursive: true });
    await fs.writeFile(path.join(microduckRoot, 'index.html'), '<!doctype html><p>mounted</p>');
    process.env.RDK_SIM2REAL_MICRODUCK_ROOT = microduckRoot;

    const response = await fetch(`${baseUrl}/mujoco/microduck/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('mounted');
  });

  it('revalidates the HTML entry so versioned assets are picked up immediately', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/index.html`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('<!doctype html>');
  });

  it('serves the public root and OriginBot simulator directory entries', async () => {
    const { baseUrl } = await fixture();
    const [root, simulator] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/originbot-sim/`),
    ]);
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toBe('no-cache');
    expect(await root.text()).toContain('Sim2Real');
    expect(simulator.status).toBe(200);
    expect(simulator.headers.get('cache-control')).toBe('no-cache');
    expect(await simulator.text()).toContain('MuJoCo');
  });

  it('canonicalizes the OriginBot simulator bookmark so relative assets resolve', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/originbot-sim`, { redirect: 'manual' });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/originbot-sim/');
  });

  it('keeps unknown API paths machine-readable and does not masquerade as the SPA', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(response.headers.get('x-request-id')).toMatch(/^[\x21-\x7e]{1,128}$/);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'SIM2REAL_API_NOT_FOUND',
      requestId: response.headers.get('x-request-id'),
    });
  });

  it('observes, rate-limits and audits malformed JSON before the parser short-circuits', async () => {
    process.env.RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE = '1';
    const { baseUrl } = await fixture();
    const auditRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-audit-'));
    temporaryRoots.push(auditRoot);
    process.env.RDK_SIM2REAL_AUDIT_FILE = path.join(auditRoot, 'audit.ndjson');

    const endpoint = `${baseUrl}/api/sim2real/projects`;
    const malformed = '{"password":"parser-secret"';
    const first = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: malformed,
    });
    expect(first.status).toBe(400);
    expect(await first.json()).toMatchObject({ error: 'SIM2REAL_INVALID_JSON' });

    // The malformed request consumed the one-token bucket. A second malformed
    // request is rejected before parsing, proving the limiter protects the
    // parser itself rather than only successful business routes.
    const second = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: malformed,
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: 'SIM2REAL_RATE_LIMITED' });

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(metrics).toMatch(
      /sim2real_http_requests_total\{[^}]*route="\/api\/sim2real\/projects"[^}]*status="400"/,
    );
    expect(metrics).toMatch(
      /sim2real_http_requests_total\{[^}]*route="\/api\/sim2real\/projects"[^}]*status="429"/,
    );

    await flushSim2RealAudit();
    const audit = await fs.readFile(path.join(auditRoot, 'audit.ndjson'), 'utf8');
    expect(audit).toContain('"status":400');
    expect(audit).toContain('"status":429');
    expect(audit).not.toContain('parser-secret');
  });

  it('counts and records oversized JSON bodies before returning 413', async () => {
    const { baseUrl } = await fixture();
    const auditRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-sim2real-audit-'));
    temporaryRoots.push(auditRoot);
    process.env.RDK_SIM2REAL_AUDIT_FILE = path.join(auditRoot, 'audit.ndjson');

    const oversized = JSON.stringify({ payload: 'x'.repeat(2 * 1024 * 1024) });
    const response = await fetch(`${baseUrl}/api/sim2real/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'SIM2REAL_REQUEST_TOO_LARGE' });

    const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(metrics).toMatch(
      /sim2real_http_requests_total\{[^}]*route="\/api\/sim2real\/runs"[^}]*status="413"/,
    );
    await flushSim2RealAudit();
    const audit = await fs.readFile(path.join(auditRoot, 'audit.ndjson'), 'utf8');
    expect(audit).toContain('"status":413');
  });

  it('preserves a bounded gateway request id for API tracing', async () => {
    const { baseUrl } = await fixture();
    const requestId = 'gateway-trace-42';
    const response = await fetch(`${baseUrl}/api/does-not-exist`, {
      headers: { 'X-Request-Id': requestId },
    });
    expect(response.headers.get('x-request-id')).toBe(requestId);
    expect((await response.json()).requestId).toBe(requestId);
  });

  it('shows an actionable fallback page when the optional MicroDuck bundle is absent', async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/mujoco/microduck/`);
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('MicroDuck 仿真资源尚未挂载');
    expect(html).toContain('href="../../#simulate"');
  });

  it('does not reflect MicroDuck upstream details in a proxy error response', async () => {
    const upstream = http.createServer((_request, response) => {
      // Force the fetch promise to reject with an upstream transport error.
      response.destroy();
    });
    upstreamServers.push(upstream);
    await new Promise<void>((resolve, reject) => {
      upstream.once('listening', () => resolve());
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1');
    });
    const address = upstream.address() as AddressInfo;
    const { baseUrl } = await fixture();
    process.env.RDK_SIM2REAL_MICRODUCK_URL = `http://127.0.0.1:${address.port}/entry/secret-token`;

    const response = await fetch(`${baseUrl}/mujoco/microduck-proxy/bundle/app.js`);
    const payload = await response.json();
    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      error: 'MICRODUCK_PROXY_UNAVAILABLE',
      message: 'MicroDuck 上游仿真服务暂时不可达，请稍后重试。',
    });
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  it('rejects MicroDuck upstream redirects instead of proxying a new authority', async () => {
    let redirectedRequest = false;
    const upstream = http.createServer((request, response) => {
      if (request.url === '/entry/redirect') {
        response.writeHead(302, { location: '/entry/secret' });
        response.end();
        return;
      }
      if (request.url === '/entry/secret') redirectedRequest = true;
      response.end('secret');
    });
    upstreamServers.push(upstream);
    await new Promise<void>((resolve, reject) => {
      upstream.once('listening', () => resolve());
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1');
    });
    const address = upstream.address() as AddressInfo;
    const { baseUrl } = await fixture();
    process.env.RDK_SIM2REAL_MICRODUCK_URL = `http://127.0.0.1:${address.port}/entry`;

    const response = await fetch(`${baseUrl}/mujoco/microduck-proxy/redirect`);
    const payload = await response.json();
    expect(response.status).toBe(502);
    expect(payload.error).toBe('MICRODUCK_PROXY_UNAVAILABLE');
    expect(redirectedRequest).toBe(false);
  });

  it('rejects a MicroDuck response that exceeds the proxy byte budget', async () => {
    const upstream = http.createServer((request, response) => {
      if (request.url === '/entry/declared-large') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(64 * 1024 * 1024 + 1),
        });
        response.end();
        return;
      }
      if (request.url === '/entry/malformed-length') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': 'not-a-length',
        });
        response.end('ok');
        return;
      }
      response.end();
    });
    upstreamServers.push(upstream);
    await new Promise<void>((resolve, reject) => {
      upstream.once('listening', () => resolve());
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1');
    });
    const address = upstream.address() as AddressInfo;
    const { baseUrl } = await fixture();
    process.env.RDK_SIM2REAL_MICRODUCK_URL = `http://127.0.0.1:${address.port}/entry`;

    const response = await fetch(`${baseUrl}/mujoco/microduck-proxy/declared-large`);
    const payload = await response.json();
    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      error: 'MICRODUCK_PROXY_UNAVAILABLE',
      message: 'MicroDuck 上游仿真服务暂时不可达，请稍后重试。',
    });

    const malformed = await fetch(`${baseUrl}/mujoco/microduck-proxy/malformed-length`);
    expect(malformed.status).toBe(502);
    expect((await malformed.json()).error).toBe('MICRODUCK_PROXY_UNAVAILABLE');
  });
});
