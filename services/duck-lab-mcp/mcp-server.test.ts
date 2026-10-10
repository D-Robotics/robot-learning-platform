import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createDshCapabilityHandlers } from '../../server/agent-runtime/dsh-capability-handlers.js';
import { createSim2RealWebApp } from '../sim2real-web/server.js';
import { createJsonRpcDispatcher, RPC_ERROR_CODES, serveStdio } from './jsonrpc.js';
import {
  createPlatformFetch,
  describeAuthMode,
  loadPlatformClientConfig,
  type PlatformClientConfig,
} from './platform-client.js';
import {
  buildToolCatalog,
  createMcpService,
  MANUAL_PARAM_HINT_OVERRIDES,
  SERVER_INFO,
  TOOL_PARAM_HINTS,
} from './server.js';

const originalEnv = { ...process.env };
const temporaryRoots: string[] = [];
const openServers: Array<ReturnType<ReturnType<typeof createSim2RealWebApp>['listen']>> = [];

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
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdk-duck-lab-mcp-'));
  temporaryRoots.push(root);
  process.env.RDK_SIM2REAL_DEPLOYMENT = 'local';
  process.env.RDK_SIM2REAL_STORAGE_DIR = path.join(root, 'ledger');
  process.env.RDK_SIM2REAL_REQUIRE_MICRODUCK = '0';
  delete process.env.RDK_SIM2REAL_MICRODUCK_ROOT;
  delete process.env.RDK_SIM2REAL_MICRODUCK_URL;
  delete process.env.RDK_SIM2REAL_AUTH_MODE;
  const app = createSim2RealWebApp();
  const server = app.listen(0, '127.0.0.1');
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function baseConfig(baseUrl: string): PlatformClientConfig {
  return { baseUrl, apiPrefix: '/api/v1/duck', timeoutMs: 30_000 };
}

type RecordedFetch = {
  urls: string[];
  fetch: typeof fetch;
};

/** Records URLs and answers synthetically — for fake domains. */
function stubFetch(): RecordedFetch {
  const urls: string[] = [];
  const recorded: RecordedFetch = {
    urls,
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  return recorded;
}

/** Records URLs and lets the real request through — for the live fixture. */
function passThroughFetch(): RecordedFetch {
  const urls: string[] = [];
  const recorded: RecordedFetch = {
    urls,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      urls.push(String(input));
      return fetch(input, init);
    }) as typeof fetch,
  };
  return recorded;
}

function makeDispatcher(baseUrl: string, options: { fetch?: typeof fetch } = {}) {
  const config = baseConfig(baseUrl);
  const platform = createPlatformFetch(config, options.fetch ? { fetchImpl: options.fetch } : {});
  const service = createMcpService(config, platform);
  const dispatcher = createJsonRpcDispatcher(service.methods);
  return {
    config,
    service,
    dispatcher,
    call: async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
      const line = await dispatcher.handleLine(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      );
      return line ? (JSON.parse(line) as Record<string, unknown>) : {};
    },
  };
}

describe('duck-lab-mcp JSON-RPC core', () => {
  it('maps malformed lines, unknown methods and notifications per JSON-RPC 2.0', async () => {
    const dispatcher = createJsonRpcDispatcher({ ping: () => ({}) });

    const malformed = JSON.parse((await dispatcher.handleLine('this is not json')) ?? '{}') as {
      error?: { code: number };
    };
    expect(malformed.error?.code).toBe(RPC_ERROR_CODES.PARSE_ERROR);

    const unknown = JSON.parse(
      (await dispatcher.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'nope' }))) ??
        '{}',
    ) as { error?: { code: number; message: string } };
    expect(unknown.error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(unknown.error?.message).toContain('nope');

    expect(
      await dispatcher.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'nope' })),
    ).toBeNull();
    expect(await dispatcher.handleLine('')).toBeNull();

    const pong = JSON.parse(
      (await dispatcher.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }))) ??
        '{}',
    ) as { result?: Record<string, unknown> };
    expect(pong.result).toEqual({});

    const badRequest = JSON.parse(
      (await dispatcher.handleLine(JSON.stringify({ id: 9, method: 'ping' }))) ?? '{}',
    ) as { error?: { code: number } };
    expect(badRequest.error?.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
  });

  it('folds handler failures into JSON-RPC errors while notifications stay silent', async () => {
    const dispatcher = createJsonRpcDispatcher({
      boom: () => {
        throw new Error('exploded');
      },
    });
    const failure = JSON.parse(
      (await dispatcher.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'boom' }))) ??
        '{}',
    ) as { error?: { code: number; message: string } };
    expect(failure.error?.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
    expect(failure.error?.message).toBe('exploded');
    expect(
      await dispatcher.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'boom' })),
    ).toBeNull();
  });

  it('answers id:null requests instead of treating them as notifications', async () => {
    const dispatcher = createJsonRpcDispatcher({ ping: () => ({}) });
    const line = await dispatcher.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }),
    );
    const message = JSON.parse(line ?? '{}') as { id?: unknown; result?: unknown };
    expect(message.id).toBeNull();
    expect(message.result).toEqual({});
  });

  it('processes batch arrays and keeps invalid members as id:null errors', async () => {
    const dispatcher = createJsonRpcDispatcher({ ping: () => ({ pong: true }) });
    const line = await dispatcher.handleLine(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        42,
        { jsonrpc: '2.0', id: 2, method: 'nope' },
      ]),
    );
    const responses = (line ?? '')
      .split('\n')
      .map((entry) => JSON.parse(entry) as { id?: unknown; error?: { code: number } });
    expect(responses.map((entry) => entry.id)).toEqual([1, null, 2]);
    expect(responses[2].error?.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    expect(await dispatcher.handleLine(JSON.stringify([]))).toContain('batch');
  });

  it('never blocks unrelated requests behind a slow call and honors cancellation', async () => {
    let resolveBlocker: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      resolveBlocker = resolve;
    });
    const dispatcher = createJsonRpcDispatcher({
      slow: (_params, context) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('never cancelled')), 5_000);
          context.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('cancelled'));
            },
            { once: true },
          );
          void blocked.then(() => clearTimeout(timer));
        }),
      ping: () => ({}),
    });

    const slowPromise = dispatcher.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 'slow-1', method: 'slow' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pingStartedAt = Date.now();
    const pongLine = await dispatcher.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    );
    expect(Date.now() - pingStartedAt).toBeLessThan(1_000);
    const pong = JSON.parse(pongLine ?? '{}') as { result?: unknown; error?: unknown };
    expect(pong.result).toEqual({});
    expect(pong.error).toBeUndefined();

    await dispatcher.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'slow-1' },
      }),
    );
    const slowResponse = JSON.parse((await slowPromise) ?? '{}') as {
      error?: { message: string };
    };
    expect(slowResponse.error?.message).toBe('cancelled');
    resolveBlocker?.();
  });

  it('keeps responses for in-flight requests when stdin closes mid-call', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(createJsonRpcDispatcher({ ping: () => ({ ok: true }) }), { input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    input.end();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Buffer.concat(chunks).toString('utf8')).toContain('"ok":true');
  });
});

describe('duck-lab-mcp stdio framing', () => {
  function frame(child: { output: PassThrough; input: PassThrough }) {
    const lines: string[] = [];
    let buffer = Buffer.alloc(0);
    child.output.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        lines.push(buffer.subarray(0, newline).toString('utf8'));
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(0x0a);
      }
    });
    return {
      send: (payload: string | Buffer) => child.input.write(payload),
      lines,
      waitLines: async (count: number): Promise<string[]> => {
        for (let attempt = 0; attempt < 100 && lines.length < count; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return lines;
      },
    };
  }

  it('reassembles multi-byte characters split across chunk boundaries', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(
      createJsonRpcDispatcher({
        echo: (params: unknown) => ({ echoed: params }),
      }),
      { input, output },
    );
    const frameHelper = frame({ output, input });
    const payload = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { text: '彩虹塔套环整理' } })}\n`,
      'utf8',
    );
    const splitAt = payload.indexOf(Buffer.from('彩', 'utf8')) + 1;
    frameHelper.send(payload.subarray(0, splitAt));
    await new Promise((resolve) => setTimeout(resolve, 10));
    frameHelper.send(payload.subarray(splitAt));
    const [line] = await frameHelper.waitLines(1);
    const message = JSON.parse(line) as { result?: { echoed?: { text?: string } } };
    expect(message.result?.echoed?.text).toBe('彩虹塔套环整理');
  });

  it('answers one parse error for an oversized line and keeps the stream usable', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    serveStdio(createJsonRpcDispatcher({ ping: () => ({}) }), { input, output });
    const frameHelper = frame({ output, input });
    frameHelper.send(Buffer.concat([Buffer.alloc(1024 * 1024 + 16, 0x61), Buffer.from('\n')]));
    frameHelper.send(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    const lines = await frameHelper.waitLines(2);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ error: { code: RPC_ERROR_CODES.PARSE_ERROR } });
    expect(JSON.parse(lines[1])).toMatchObject({ result: {} });
  });
});

describe('duck-lab-mcp platform client', () => {
  it('rewrites the legacy prefix onto the versioned API and strips the internal turn id', async () => {
    const recorded = stubFetch();
    const platform = createPlatformFetch(baseConfig('http://platform.test'), {
      fetchImpl: recorded.fetch,
    });
    await platform.fetch('/api/sim2real/overview', {
      method: 'GET',
      headers: { 'x-sim2real-turn-id': 'turn-internal' },
      signal: new AbortController().signal,
    });
    await platform.fetch('/api/sim2real/runs/run-1/logs', {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    });
    expect(recorded.urls).toEqual([
      'http://platform.test/api/v1/duck/overview',
      'http://platform.test/api/v1/duck/runs/run-1/logs',
    ]);
  });

  it('projects oversized aggregate bodies so bounded readers survive real ledgers', async () => {
    const runs = Array.from({ length: 46 }, (_, index) => ({
      id: `run-${index}`,
      status: 'completed',
      summary: 'x'.repeat(6000),
    }));
    const big = JSON.stringify({ ok: true, runs, models: [], devices: [] });
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(256 * 1024);
    const fetchImpl = (async () =>
      new Response(big, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const platform = createPlatformFetch(baseConfig('http://platform.test'), { fetchImpl });

    const response = await platform.fetch('/api/sim2real/overview', {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    });
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      projection?: Record<string, unknown>;
      runs: unknown[];
      models: unknown[];
    };
    expect(body.projection).toMatchObject({ truncated: true, arrayCap: 12 });
    expect(body.runs).toHaveLength(12);
    expect(body.runs[0]).toMatchObject({ id: 'run-0' });
  });

  it('re-logins once on 401 and replays the original request with the fresh session', async () => {
    const calls: Array<{ url: string; method?: string; cookie?: string }> = [];
    let businessCalls = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method, cookie: headers.get('cookie') ?? undefined });
      if (url.endsWith('/api/sso/login')) {
        return new Response('{}', {
          status: 200,
          headers: {
            'set-cookie': 'rdk_sso_web_session=v2.fresh; Path=/; HttpOnly',
          },
        });
      }
      businessCalls += 1;
      if (businessCalls === 1) return new Response('{"message":"expired"}', { status: 401 });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    const platform = createPlatformFetch(
      { ...baseConfig('http://platform.test'), username: 'u', password: 'p' },
      { fetchImpl },
    );
    const response = await platform.fetch('/api/sim2real/overview', {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.map((entry) => entry.url)).toEqual([
      'http://platform.test/api/sso/login',
      'http://platform.test/api/v1/duck/overview',
      'http://platform.test/api/sso/login',
      'http://platform.test/api/v1/duck/overview',
    ]);
    expect(calls[3].cookie).toBe('rdk_sso_web_session=v2.fresh');
  });

  it('truncates oversized top-level arrays instead of passing them through', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      id: `run-${index}`,
      blob: 'x'.repeat(4_000),
    }));
    const big = JSON.stringify(entries);
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(240 * 1024);
    const fetchImpl = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    const platform = createPlatformFetch(baseConfig('http://platform.test'), { fetchImpl });
    const response = await platform.fetch('/api/sim2real/runs', {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    });
    const body = (await response.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(12);
  });

  it('fails with an explicit error when a body cannot be projected losslessly', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(300 * 1024) });
    const fetchImpl = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    const platform = createPlatformFetch(baseConfig('http://platform.test'), { fetchImpl });
    await expect(
      platform.fetch('/api/sim2real/overview', {
        method: 'GET',
        headers: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/无法无损投影/);
  });

  it('keeps app-level routes and configured cookies untouched', async () => {
    const recorded = stubFetch();
    const config: PlatformClientConfig = {
      ...baseConfig('http://platform.test'),
      cookie: 'rdk_sso_web_session=v1.abc',
    };
    const platform = createPlatformFetch(config, { fetchImpl: recorded.fetch });
    await platform.requestAppRoute('/healthz');
    expect(recorded.urls).toEqual(['http://platform.test/healthz']);
    expect(describeAuthMode(config)).toBe('static-cookie');
  });
  it('loads configuration from the environment with safe defaults', () => {
    const config = loadPlatformClientConfig({
      RDK_SIM2REAL_MCP_BASE_URL: 'http://192.168.1.10:18102/',
      RDK_SIM2REAL_MCP_TIMEOUT_MS: '5000',
    });
    expect(config.baseUrl).toBe('http://192.168.1.10:18102');
    expect(config.apiPrefix).toBe('/api/v1/duck');
    expect(config.timeoutMs).toBe(5000);
    expect(describeAuthMode(config)).toBe('standalone-anonymous');
    expect(() => loadPlatformClientConfig({ RDK_SIM2REAL_MCP_BASE_URL: 'not a url' })).toThrow(
      /RDK_SIM2REAL_MCP_BASE_URL/,
    );
  });
});

describe('duck-lab-mcp protocol surface', () => {
  it('negotiates the protocol version and advertises the platform instructions', async () => {
    const base = await fixture();
    const { dispatcher } = makeDispatcher(base);
    const request = (params: unknown) =>
      dispatcher.handleLine(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params }),
      );

    const pinned = JSON.parse((await request({ protocolVersion: '2025-03-26' })) ?? '{}') as {
      result?: Record<string, unknown>;
    };
    expect(pinned.result?.protocolVersion).toBe('2025-03-26');
    expect(pinned.result?.serverInfo).toMatchObject({ name: SERVER_INFO.name });
    expect(String(pinned.result?.instructions)).toContain('idempotencyKey');

    const fallback = JSON.parse((await request({ protocolVersion: '1999-01-01' })) ?? '{}') as {
      result?: Record<string, unknown>;
    };
    expect(fallback.result?.protocolVersion).toBe('2025-06-18');
    expect(fallback.result?.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('lists the full capability catalog with honest read-only and destructive hints', async () => {
    const base = await fixture();
    const { call } = makeDispatcher(base);
    const response = (await call('tools/list')) as {
      result?: { tools?: Array<Record<string, unknown>> };
    };
    const tools = response.result?.tools ?? [];
    // The embedded catalog (56 rdk_* tools) plus rdk_platform_status.
    expect(tools).toHaveLength(57);
    const byName = new Map(tools.map((tool) => [tool.name as string, tool]));
    expect(byName.get('rdk_workspace_overview')).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(byName.get('rdk_training_submit')).toMatchObject({
      annotations: { readOnlyHint: false },
    });
    expect(byName.get('rdk_board_stop')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
    });
    expect(byName.get('rdk_board_arm_move')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: false },
    });
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: true });
      expect(typeof tool.description).toBe('string');
    }
  });

  it('serves the catalog from a partial handler map without phantom entries', () => {
    const handlers = createDshCapabilityHandlers({
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    delete handlers.rdk_board_arm_move;
    const tools = buildToolCatalog(handlers, [
      { id: 'rdk_platform_status', description: 'x', readOnly: true },
    ]);
    expect(tools.some((tool) => tool.name === 'rdk_board_arm_move')).toBe(false);
    expect(tools.some((tool) => tool.name === 'rdk_board_stop')).toBe(true);
  });

  it('keeps the param-hint table in lockstep with the capability handlers source', () => {
    const source = readFileSync(
      path.resolve('server/agent-runtime/dsh-capability-handlers.ts'),
      'utf8',
    );
    const marks = [...source.matchAll(/async (rdk_[a-z_]+)\s*\(/g)].map((match) => ({
      id: match[1],
      start: match.index ?? 0,
    }));
    const derived = new Map<string, { required: string[]; properties: Record<string, unknown> }>();
    const typeOf = (helper: string): unknown =>
      helper === 'argNumber'
        ? { type: 'number' }
        : helper === 'argStringList'
          ? { type: 'array', items: { type: 'string' } }
          : helper === 'boolean'
            ? { type: 'boolean' }
            : { type: 'string' };
    for (let index = 0; index < marks.length; index++) {
      const body = source.slice(
        marks[index].start,
        index + 1 < marks.length ? marks[index + 1].start : source.length,
      );
      const helpers = new Map<string, string>();
      for (const match of body.matchAll(
        /(requiredArg|argText|argString|argNumber|argStringList)\(\s*(?:input|args)\s*,\s*['"]([a-zA-Z]+)['"]/g,
      )) {
        const previous = helpers.get(match[2]);
        if (!previous || match[1] === 'requiredArg') helpers.set(match[2], match[1]);
      }
      for (const match of body.matchAll(/typeof (?:input|args)\.([a-zA-Z]+) === 'boolean'/g)) {
        if (!helpers.has(match[1])) helpers.set(match[1], 'boolean');
      }
      for (const match of body.matchAll(/(?:input|args)\.([a-zA-Z]+)(?![a-zA-Z])/g)) {
        if (!helpers.has(match[1])) helpers.set(match[1], 'unknown');
      }
      const required = [...helpers.entries()]
        .filter(([, helper]) => helper === 'requiredArg')
        .map(([key]) => key);
      const properties: Record<string, unknown> = {};
      for (const [key, helper] of helpers) {
        properties[key] = helper === 'unknown' ? {} : typeOf(helper);
      }
      derived.set(marks[index].id, { required, properties });
    }

    for (const [id, hint] of derived) {
      if (id in MANUAL_PARAM_HINT_OVERRIDES) continue;
      expect(TOOL_PARAM_HINTS[id], `${id} 提示与 handlers 源码不一致`).toEqual(hint);
    }
    const handlerIds = new Set([...derived.keys(), ...Object.keys(MANUAL_PARAM_HINT_OVERRIDES)]);
    for (const id of Object.keys(TOOL_PARAM_HINTS)) {
      expect(handlerIds.has(id), `${id} 不在 capability handlers 中`).toBe(true);
    }
    expect(
      Object.keys(MANUAL_PARAM_HINT_OVERRIDES.rdk_lineage_get?.properties ?? {}).sort(),
    ).toEqual(['artifactId', 'evaluationId', 'projectId', 'runId']);
  });

  it('publishes required fields and types on the tool schemas', async () => {
    const base = await fixture();
    const { call } = makeDispatcher(base);
    const response = (await call('tools/list')) as {
      result?: { tools?: Array<Record<string, unknown>> };
    };
    const byName = new Map(
      (response.result?.tools ?? []).map((tool) => [tool.name as string, tool]),
    );
    expect(byName.get('rdk_runs_replay')?.inputSchema).toMatchObject({
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: true,
    });
    expect(byName.get('rdk_training_submit')?.inputSchema).toMatchObject({
      properties: {
        numEnvs: { type: 'number' },
        datasetIds: { type: 'array' },
        video: { type: 'boolean' },
        demonstrationRunId: { type: 'string' },
        syntheticSmoke: { type: 'boolean' },
      },
    });
    expect(byName.get('rdk_platform_status')?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: true,
    });
  });

  it('rejects idempotency keys that cannot travel as header values', async () => {
    const base = await fixture();
    const { call } = makeDispatcher(base);
    const bad = (await call('tools/call', {
      name: 'rdk_training_submit',
      arguments: { backend: 'local', idempotencyKey: 'turn\r\nX-Injected: 1' },
    })) as { error?: { code: number; message: string } };
    expect(bad.error?.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    expect(bad.error?.message).toContain('idempotencyKey');
  });
});

describe('duck-lab-mcp tools over the live platform', () => {
  it('drives workspace reads through the versioned API', async () => {
    const base = await fixture();
    const recorded = passThroughFetch();
    const { call } = makeDispatcher(base, { fetch: recorded.fetch });
    const response = (await call('tools/call', {
      name: 'rdk_workspace_overview',
      arguments: {},
    })) as { result?: { structuredContent?: Record<string, unknown> } };
    const digest = response.result?.structuredContent ?? {};
    expect(Array.isArray(digest.models)).toBe(true);
    expect(digest.models).toHaveLength(2);
    for (const url of recorded.urls) {
      expect(url.startsWith(`${base}/api/v1/duck/`)).toBe(true);
    }
  });

  it('submits training once per idempotency key and surfaces the blocked runner honestly', async () => {
    const base = await fixture();
    const { call } = makeDispatcher(base);
    const submit = {
      name: 'rdk_training_submit',
      arguments: { backend: 'local', idempotencyKey: 'mcp-turn-1' },
    };

    const first = (await call('tools/call', submit)) as {
      result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
    };
    expect(first.result?.isError).toBeFalsy();
    const runId = String(first.result?.structuredContent?.runId ?? '');
    expect(runId).toBeTruthy();
    expect(first.result?.structuredContent).toMatchObject({ backend: 'local', status: 'blocked' });

    const retry = (await call('tools/call', submit)) as {
      result?: { structuredContent?: Record<string, unknown> };
    };
    expect(retry.result?.structuredContent?.runId).toBe(runId);

    const runs = (await call('tools/call', {
      name: 'rdk_runs_list',
      arguments: { limit: 10 },
    })) as { result?: { structuredContent?: Record<string, unknown> } };
    expect(runs.result?.structuredContent?.total).toBe(1);
  });

  it('reports platform rejection and transport failures as isError results', async () => {
    const base = await fixture();
    const { call } = makeDispatcher(base);

    const missingRun = (await call('tools/call', {
      name: 'rdk_training_status',
      arguments: { runId: 'no-such-run' },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(missingRun.result?.isError).toBe(true);
    expect(String(missingRun.result?.content?.[0]?.text ?? '')).toContain(
      'DSH_CAPABILITY_REJECTED',
    );

    const badLineage = (await call('tools/call', {
      name: 'rdk_lineage_get',
      arguments: { runId: 'a', artifactId: 'b' },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(badLineage.result?.isError).toBe(true);
    expect(String(badLineage.result?.content?.[0]?.text ?? '')).toContain('其中一个');

    const unknownTool = await call('tools/call', { name: 'rdk_not_a_tool', arguments: {} });
    expect((unknownTool as { error?: { code: number } }).error?.code).toBe(
      RPC_ERROR_CODES.INVALID_PARAMS,
    );
  });

  it('exposes platform health and session identity through rdk_platform_status', async () => {
    const base = await fixture();
    const { call } = makeDispatcher(base);
    const response = (await call('tools/call', {
      name: 'rdk_platform_status',
      arguments: {},
    })) as { result?: { structuredContent?: Record<string, unknown> } };
    expect(response.result?.structuredContent).toMatchObject({
      ok: true,
      baseUrl: base,
      apiPrefix: '/api/v1/duck',
      authMode: 'standalone-anonymous',
      health: { httpStatus: 200, ready: true },
    });
  });
});

describe('duck-lab-mcp stdio entry', () => {
  it('speaks newline-delimited JSON-RPC over a real child process', async () => {
    const base = await fixture();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', path.resolve('services/duck-lab-mcp/server.ts')],
      {
        cwd: process.cwd(),
        env: { ...process.env, RDK_SIM2REAL_MCP_BASE_URL: base },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));

    let buffer = '';
    const pending = new Map<
      number,
      { resolve: (value: Record<string, unknown>) => void; timer: NodeJS.Timeout }
    >();
    let nextId = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
          if (typeof message.id === 'number' && pending.has(message.id)) {
            const { resolve, timer } = pending.get(message.id)!;
            clearTimeout(timer);
            pending.delete(message.id);
            resolve(message);
          }
        } catch {
          // Non-JSON stdout lines would be a protocol violation.
        }
        newline = buffer.indexOf('\n');
      }
    });

    const rpc = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`stdio 超时等待 ${method}；stderr: ${stderr.join('')}`));
        }, 30_000);
        pending.set(id, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    try {
      const initialized = await rpc('initialize', { protocolVersion: '2025-06-18' });
      expect((initialized.result as Record<string, unknown>).serverInfo).toMatchObject({
        name: 'duck-lab-mcp',
      });

      const summary = await rpc('tools/call', { name: 'rdk_workspace_summary', arguments: {} });
      expect((summary.result as Record<string, unknown>).structuredContent).toMatchObject({
        generatedAt: expect.any(String),
      });
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }, 60_000);
});
