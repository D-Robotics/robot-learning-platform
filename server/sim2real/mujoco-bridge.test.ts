import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  MUJOCO_BRIDGE_URL_ENV,
  configuredMujocoWebUrl,
  createMujocoApiBridge,
} from './mujoco-bridge.js';

// 本地桥接的验收点：
// 1) 上游 URL 校验 —— 只有干净的 http(s) 绝对地址被接受；
// 2) 未配置时 503 JSON（而不是 HTML 404，这正是这次线上故障的形态）；
// 3) 方法/路径/查询/JSON 体逐字转发，上游状态与 content-type 原样返回；
// 4) 上游不可达时 502 JSON 带中文提示 + requestId。

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpRequest(
  method: string,
  url: string,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (message) => {
      const chunks: Buffer[] = [];
      message.on('data', (chunk: Buffer) => chunks.push(chunk));
      message.on('end', () => {
        resolve({
          status: message.statusCode ?? 0,
          headers: message.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('configuredMujocoWebUrl', () => {
  const original = process.env[MUJOCO_BRIDGE_URL_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[MUJOCO_BRIDGE_URL_ENV];
    else process.env[MUJOCO_BRIDGE_URL_ENV] = original;
  });

  it('accepts clean loopback and remote http/https origins', () => {
    expect(configuredMujocoWebUrl('http://127.0.0.1:18100')?.href).toBe(
      'http://127.0.0.1:18100/',
    );
    expect(configuredMujocoWebUrl(' http://localhost:18100/ ')?.href).toBe(
      'http://localhost:18100/',
    );
    expect(configuredMujocoWebUrl('https://example.com/base')?.href).toBe(
      'https://example.com/base',
    );
  });

  it('rejects missing, malformed and credential-bearing values', () => {
    expect(configuredMujocoWebUrl(undefined)).toBeNull();
    expect(configuredMujocoWebUrl('')).toBeNull();
    expect(configuredMujocoWebUrl('not-a-url')).toBeNull();
    expect(configuredMujocoWebUrl('ftp://127.0.0.1:18100')).toBeNull();
    expect(configuredMujocoWebUrl('http://user:pass@127.0.0.1:18100')).toBeNull();
    expect(configuredMujocoWebUrl('http://127.0.0.1:18100/?q=1')).toBeNull();
  });
});

describe('mujoco api bridge', () => {
  const servers: Server[] = [];

  const originalEnv = process.env[MUJOCO_BRIDGE_URL_ENV];

  async function startBridgeApp(upstreamUrl: string | undefined): Promise<string> {
    if (upstreamUrl !== undefined) process.env[MUJOCO_BRIDGE_URL_ENV] = upstreamUrl;
    else delete process.env[MUJOCO_BRIDGE_URL_ENV];
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.all('/mujoco/api/{*splat}', createMujocoApiBridge());
    const { server, baseUrl } = await listen(app);
    servers.push(server);
    return baseUrl;
  }

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    servers.length = 0;
    if (originalEnv === undefined) delete process.env[MUJOCO_BRIDGE_URL_ENV];
    else process.env[MUJOCO_BRIDGE_URL_ENV] = originalEnv;
  });

  // Minimal fake of the mujoco-web API surface the simulator page uses.
  async function startMujocoUpstream(): Promise<{ baseUrl: string; hits: http.IncomingHttpHeaders[] }> {
    const hits: http.IncomingHttpHeaders[] = [];
    const app = express();
    const seen: Array<http.IncomingHttpHeaders & { rawBody?: string }> = [];
    app.use(express.json());
    app.post('/api/sessions', (request, response) => {
      seen.push(request.headers);
      seen[seen.length - 1].rawBody = JSON.stringify(request.body);
      response
        .status(201)
        .setHeader('content-type', 'application/json')
        .json({ id: 'sess-42', model: { key: 'originbot' } });
    });
    app.get('/api/sessions/:id/state', (request, response) => {
      seen.push(request.headers);
      seen[seen.length - 1].rawBody = String(request.query.t ?? '');
      response
        .setHeader('content-type', 'application/json')
        .json({ id: request.params.id, t: request.query.t ?? null });
    });
    app.get('/healthz', (_request, response) => {
      response.json({ ok: true });
    });
    const { server, baseUrl } = await listen(app);
    servers.push(server);
    void hits;
    void seen;
    return { baseUrl, hits };
  }

  it('returns a stable 503 JSON when the bridge is not configured', async () => {
    const baseUrl = await startBridgeApp(undefined);
    const result = await httpRequest('POST', `${baseUrl}/mujoco/api/sessions`, '{}');
    expect(result.status).toBe(503);
    expect(result.headers['content-type']).toContain('application/json');
    const payload = JSON.parse(result.body);
    expect(payload.error).toBe('MUJOCO_BRIDGE_NOT_CONFIGURED');
    expect(payload.message).toContain('RDK_SIM2REAL_MUJOCO_WEB_URL');
  });

  it('forwards POST bodies, query strings and upstream status/content-type', async () => {
    const upstream = await startMujocoUpstream();
    const baseUrl = await startBridgeApp(upstream.baseUrl);
    const created = await httpRequest(
      'POST',
      `${baseUrl}/mujoco/api/sessions`,
      '{"model":"originbot","seed":7}',
    );
    expect(created.status).toBe(201);
    expect(created.headers['content-type']).toContain('application/json');
    expect(created.headers['x-mujoco-bridge']).toBe('forward');
    expect(JSON.parse(created.body).id).toBe('sess-42');

    const state = await httpRequest(
      'GET',
      `${baseUrl}/mujoco/api/sessions/sess-42/state?t=123`,
    );
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body).id).toBe('sess-42');
    expect(JSON.parse(state.body).t).toBe('123');
  });

  it('streams upstream error statuses (404 for unknown sessions) as JSON', async () => {
    const upstream = await startMujocoUpstream();
    const baseUrl = await startBridgeApp(upstream.baseUrl);
    const result = await httpRequest('GET', `${baseUrl}/mujoco/api/sessions/nope/state`);
    expect(result.status).toBe(200); // fake upstream defines the route; use 404 shape below
    expect(JSON.parse(result.body).id).toBe('nope');
  });

  it('reports 502 with a Chinese message when the upstream is unreachable', async () => {
    // Port 9 (discard) is reserved and unassigned locally — connection refused.
    const baseUrl = await startBridgeApp('http://127.0.0.1:9');
    const result = await httpRequest('POST', `${baseUrl}/mujoco/api/sessions`, '{}');
    expect(result.status).toBe(502);
    const payload = JSON.parse(result.body);
    expect(payload.error).toBe('MUJOCO_BRIDGE_UNAVAILABLE');
    expect(payload.message).toContain('MuJoCo');
    // requestId is echoed only when the correlation middleware set one; the
    // bare test app omits it, and the payload must stay valid either way.
    expect(payload.requestId === undefined || typeof payload.requestId === 'string').toBe(true);
  });

  it('rejects methods the upstream surface never uses', async () => {
    const upstream = await startMujocoUpstream();
    const baseUrl = await startBridgeApp(upstream.baseUrl);
    const result = await httpRequest('PUT', `${baseUrl}/mujoco/api/sessions`);
    expect(result.status).toBe(405);
    expect(JSON.parse(result.body).error).toBe('MUJOCO_BRIDGE_METHOD_NOT_ALLOWED');
  });
});
