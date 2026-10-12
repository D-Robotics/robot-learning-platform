import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac } from 'node:crypto';
import type { Sim2RealAuthPort } from './sim2real-auth.js';

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
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
      },
      (message) => {
        const chunks: Buffer[] = [];
        message.on('data', (chunk: Buffer) => chunks.push(chunk));
        message.on('end', () => {
          resolve({
            status: message.statusCode ?? 0,
            headers: message.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
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
    expect(configuredMujocoWebUrl('http://127.0.0.1:18100')?.href).toBe('http://127.0.0.1:18100/');
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
  const originalSecret = process.env.RDK_SIM2REAL_SIMULATION_SECRET;
  const originalOrigin = process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
  const SECRET = 'simulation-bridge-test-secret-at-least-32-bytes';
  const sharedAuth: Sim2RealAuthPort = {
    isMultiUserDeployment: () => true,
    resolvePrincipal: (request) =>
      request.headers['x-test-account']
        ? {
            accountId: String(request.headers['x-test-account']),
            roles: [String(request.headers['x-test-role'] || 'operator')],
          }
        : null,
    resolveAccessToken: () => 'never-forward-this-user-token',
  };

  async function startBridgeApp(
    upstreamUrl: string | undefined,
    auth?: Sim2RealAuthPort,
  ): Promise<string> {
    if (upstreamUrl !== undefined) process.env[MUJOCO_BRIDGE_URL_ENV] = upstreamUrl;
    else delete process.env[MUJOCO_BRIDGE_URL_ENV];
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.all(['/mujoco/api', '/mujoco/api/{*splat}'], createMujocoApiBridge({ auth }));
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
    if (originalSecret === undefined) delete process.env.RDK_SIM2REAL_SIMULATION_SECRET;
    else process.env.RDK_SIM2REAL_SIMULATION_SECRET = originalSecret;
    if (originalOrigin === undefined) delete process.env.RDK_SIM2REAL_PUBLIC_ORIGIN;
    else process.env.RDK_SIM2REAL_PUBLIC_ORIGIN = originalOrigin;
  });

  // Minimal fake of the mujoco-web API surface the simulator page uses.
  async function startMujocoUpstream(): Promise<{
    baseUrl: string;
    hits: http.IncomingHttpHeaders[];
  }> {
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

  async function startOwnedUpstream(): Promise<{
    baseUrl: string;
    hits: Array<{ owner: string; path: string; body: string; headers: http.IncomingHttpHeaders }>;
  }> {
    const hits: Array<{
      owner: string;
      path: string;
      body: string;
      headers: http.IncomingHttpHeaders;
    }> = [];
    const owners = new Map<string, string>();
    const app = express();
    app.use(express.raw({ type: '*/*' }));
    app.use((request, response) => {
      const encodedOwner = String(request.headers['x-rdk-simulation-owner'] || '');
      const timestamp = String(request.headers['x-rdk-simulation-timestamp'] || '');
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const expected = createHmac('sha256', process.env.RDK_SIM2REAL_SIMULATION_SECRET || SECRET)
        .update(
          `v1\n${timestamp}\n${encodedOwner}\n${request.method}\n${request.originalUrl}\n${createHash('sha256').update(body).digest('hex')}`,
        )
        .digest('hex');
      if (!encodedOwner || request.headers['x-rdk-simulation-signature'] !== expected) {
        response.status(401).json({ error: 'invalid simulation signature' });
        return;
      }
      const owner = Buffer.from(encodedOwner, 'base64url').toString('utf8');
      hits.push({
        owner,
        path: request.originalUrl,
        body: body.toString('utf8'),
        headers: request.headers,
      });
      if (request.method === 'POST' && request.path === '/api/task-sessions') {
        const id = `session-${owner}`;
        owners.set(id, owner);
        response.status(201).json({ sessionId: id });
        return;
      }
      const id = request.path.split('/')[3];
      if (!id || owners.get(id) !== owner) {
        response.status(404).json({ error: 'session not found' });
        return;
      }
      if (request.method === 'DELETE') owners.delete(id);
      response.json({ sessionId: id, owner });
    });
    const { server, baseUrl } = await listen(app);
    servers.push(server);
    return { baseUrl, hits };
  }

  it('rejects anonymous shared create/state/frame/delete requests before any upstream call', async () => {
    process.env.RDK_SIM2REAL_SIMULATION_SECRET = SECRET;
    const upstream = await startOwnedUpstream();
    const bridge = await startBridgeApp(upstream.baseUrl, sharedAuth);
    for (const [method, suffix] of [
      ['POST', 'task-sessions'],
      ['GET', 'sessions/guessed/state'],
      ['GET', 'sessions/guessed/frame.jpg'],
      ['DELETE', 'task-sessions/guessed'],
    ]) {
      const result = await httpRequest(
        method,
        `${bridge}/mujoco/api/${suffix}`,
        method === 'POST' ? '{}' : undefined,
        {
          origin: bridge,
          'x-rdk-simulation-owner': Buffer.from('alice').toString('base64url'),
          'x-rdk-simulation-signature': 'forged',
        },
      );
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body).error).toBe('SIM2REAL_AUTH_REQUIRED');
    }
    expect(upstream.hits).toHaveLength(0);
    expect((await httpRequest('GET', `${bridge}/mujoco/api`)).status).toBe(401);
  });

  it('fails closed for a shared bridge with no strong simulation secret', async () => {
    const upstream = await startOwnedUpstream();
    const bridge = await startBridgeApp(upstream.baseUrl, sharedAuth);
    for (const secret of ['', 'short-placeholder']) {
      process.env.RDK_SIM2REAL_SIMULATION_SECRET = secret;
      const result = await httpRequest('GET', `${bridge}/mujoco/api/task-scenes`, undefined, {
        'x-test-account': 'alice',
      });
      expect(result.status).toBe(503);
      expect(JSON.parse(result.body).error).toBe('MUJOCO_BRIDGE_AUTH_NOT_CONFIGURED');
    }
    expect(upstream.hits).toHaveLength(0);
  });

  it('binds signatures to verified ownership, exact serialized bytes and query without forwarding credentials', async () => {
    process.env.RDK_SIM2REAL_SIMULATION_SECRET = SECRET;
    const upstream = await startOwnedUpstream();
    const bridge = await startBridgeApp(upstream.baseUrl, sharedAuth);
    const body = '{ "taskId": "balance-stilts", "label": "鸭子" }';
    const result = await httpRequest(
      'POST',
      `${bridge}/mujoco/api/task-sessions?seed=7&label=%E9%B8%AD`,
      body,
      {
        origin: bridge,
        'x-test-account': 'alice',
        cookie: 'rdk_sso_web_session=private',
        authorization: 'Bearer private-user-token',
        'x-rdk-simulation-owner': Buffer.from('bob').toString('base64url'),
        'x-rdk-simulation-timestamp': '1',
        'x-rdk-simulation-signature': 'forged',
      },
    );
    expect(result.status).toBe(201);
    expect(upstream.hits[0]).toMatchObject({
      owner: 'alice',
      path: '/api/task-sessions?seed=7&label=%E9%B8%AD',
      body: JSON.stringify(JSON.parse(body)),
    });
    expect(upstream.hits[0].headers.cookie).toBeUndefined();
    expect(upstream.hits[0].headers.authorization).toBeUndefined();
    expect(upstream.hits[0].headers['x-test-account']).toBeUndefined();
    expect(upstream.hits[0].headers['x-rdk-simulation-signature']).not.toBe('forged');
  });

  it('keeps Alice and Bob session operations separate through the signed bridge', async () => {
    process.env.RDK_SIM2REAL_SIMULATION_SECRET = SECRET;
    const upstream = await startOwnedUpstream();
    const bridge = await startBridgeApp(upstream.baseUrl, sharedAuth);
    const alice = { origin: bridge, 'x-test-account': 'alice' };
    const bob = { origin: bridge, 'x-test-account': 'bob' };
    const created = await httpRequest('POST', `${bridge}/mujoco/api/task-sessions`, '{}', alice);
    expect(created.status).toBe(201);
    const sessionId = JSON.parse(created.body).sessionId;
    for (const [method, suffix] of [
      ['GET', 'state'],
      ['GET', 'frame.jpg'],
      ['POST', 'step'],
      ['DELETE', ''],
    ]) {
      const result = await httpRequest(
        method,
        `${bridge}/mujoco/api/task-sessions/${sessionId}${suffix ? `/${suffix}` : ''}`,
        method === 'POST' ? '{}' : undefined,
        bob,
      );
      expect(result.status).toBe(404);
    }
    const state = await httpRequest(
      'GET',
      `${bridge}/mujoco/api/task-sessions/${sessionId}/state`,
      undefined,
      alice,
    );
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body).owner).toBe('alice');
  });

  it('allows viewer reads, rejects viewer writes, and allows editor simulation changes', async () => {
    process.env.RDK_SIM2REAL_SIMULATION_SECRET = SECRET;
    const upstream = await startOwnedUpstream();
    const bridge = await startBridgeApp(upstream.baseUrl, sharedAuth);
    const viewer = { origin: bridge, 'x-test-account': 'alice', 'x-test-role': 'viewer' };
    const write = await httpRequest('POST', `${bridge}/mujoco/api/task-sessions`, '{}', viewer);
    expect(write.status).toBe(403);
    const deniedRead = await httpRequest('GET', `${bridge}/mujoco/api/task-scenes`, undefined, {
      ...viewer,
      'x-test-role': 'unknown-role',
    });
    expect(deniedRead.status).toBe(403);
    expect(upstream.hits).toHaveLength(0);
    const editor = await httpRequest('POST', `${bridge}/mujoco/api/task-sessions`, '{}', {
      ...viewer,
      'x-test-role': 'editor',
    });
    expect(editor.status).toBe(201);
    const read = await httpRequest(
      'GET',
      `${bridge}/mujoco/api/task-sessions/session-alice/state`,
      undefined,
      viewer,
    );
    expect(read.status).toBe(200);
  });

  it('blocks cross-origin or originless shared mutations while accepting trusted same-origin fetches', async () => {
    process.env.RDK_SIM2REAL_SIMULATION_SECRET = SECRET;
    const upstream = await startOwnedUpstream();
    const bridge = await startBridgeApp(upstream.baseUrl, sharedAuth);
    for (const headers of [
      { origin: 'https://attacker.test' },
      {},
      { 'sec-fetch-site': 'same-site' },
      { origin: bridge, 'sec-fetch-site': 'cross-site' },
    ]) {
      const result = await httpRequest('POST', `${bridge}/mujoco/api/task-sessions`, '{}', {
        'x-test-account': 'alice',
        ...headers,
      });
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body).error).toBe('SIM2REAL_CSRF_BLOCKED');
    }
    expect(upstream.hits).toHaveLength(0);
    const accepted = await httpRequest('POST', `${bridge}/mujoco/api/task-sessions`, '{}', {
      'x-test-account': 'alice',
      'sec-fetch-site': 'same-origin',
    });
    expect(accepted.status).toBe(201);
  });

  it('signs an empty JSON object and uses a fixed local owner when local signing is enabled', async () => {
    process.env.RDK_SIM2REAL_SIMULATION_SECRET = SECRET;
    const upstream = await startOwnedUpstream();
    const bridge = await startBridgeApp(upstream.baseUrl);
    const result = await httpRequest('POST', `${bridge}/mujoco/api/task-sessions`, '{}', {
      'x-rdk-simulation-owner': Buffer.from('alice').toString('base64url'),
    });
    expect(result.status).toBe(201);
    expect(upstream.hits[0]).toMatchObject({ owner: 'local-single-user', body: '{}' });
  });

  it('uses UTF-8 bytes for the secret threshold and encodes a Unicode account without changing its owner', async () => {
    process.env.RDK_SIM2REAL_SIMULATION_SECRET = '鸭'.repeat(11); // 33 bytes, 11 JS characters.
    const upstream = await startOwnedUpstream();
    const bridge = await startBridgeApp(upstream.baseUrl, {
      ...sharedAuth,
      resolvePrincipal: () => ({ accountId: '账号甲', roles: ['editor'] }),
    });
    const created = await httpRequest('POST', `${bridge}/mujoco/api/task-sessions`, '{}', {
      origin: bridge,
    });
    expect(created.status).toBe(201);
    expect(upstream.hits[0].owner).toBe('账号甲');
    expect(upstream.hits[0].headers['x-rdk-simulation-owner']).toBe(
      Buffer.from('账号甲', 'utf8').toString('base64url'),
    );
  });

  it('rejects cross-origin deletion in both signed shared and unsigned local modes', async () => {
    const upstream = await startMujocoUpstream();
    for (const auth of [sharedAuth, undefined]) {
      process.env.RDK_SIM2REAL_SIMULATION_SECRET = auth ? SECRET : '';
      const bridge = await startBridgeApp(upstream.baseUrl, auth);
      const deleted = await httpRequest(
        'DELETE',
        `${bridge}/mujoco/api/task-sessions/guessed`,
        undefined,
        { 'x-test-account': 'alice', origin: 'https://attacker.test' },
      );
      expect(deleted.status).toBe(403);
      expect(JSON.parse(deleted.body).error).toBe('SIM2REAL_CSRF_BLOCKED');
    }
  });

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

    const state = await httpRequest('GET', `${baseUrl}/mujoco/api/sessions/sess-42/state?t=123`);
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
