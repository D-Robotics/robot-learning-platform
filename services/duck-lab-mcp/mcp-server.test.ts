import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createDshCapabilityHandlers } from '../../server/agent-runtime/dsh-capability-handlers.js';
import {
  appendSim2RealTelemetry,
  createSim2RealRun,
} from '../../server/sim2real/sim2real-store.js';
import { BUILTIN_MICRODUCK_MODEL } from '../../shared/sim2real.js';
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
    // The embedded catalog (58 rdk_* tools) plus rdk_platform_status.
    expect(tools).toHaveLength(59);
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
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: tool.name !== 'rdk_training_submit',
      });
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
      helper === 'argNumber' || helper === 'requiredNumberArg'
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
        /(requiredArg|requiredNumberArg|argText|argString|argNumber|argStringList)\(\s*(?:input|args)\s*,\s*['"]([a-zA-Z][a-zA-Z0-9]*)['"]/g,
      )) {
        const previous = helpers.get(match[2]);
        if (!previous || ['requiredArg', 'requiredNumberArg'].includes(match[1]))
          helpers.set(match[2], match[1]);
      }
      for (const match of body.matchAll(
        /typeof (?:input|args)\.([a-zA-Z][a-zA-Z0-9]*) === 'boolean'/g,
      )) {
        if (!helpers.has(match[1])) helpers.set(match[1], 'boolean');
      }
      for (const match of body.matchAll(/(?:input|args)\.([a-zA-Z][a-zA-Z0-9]*)(?![a-zA-Z0-9])/g)) {
        if (!helpers.has(match[1])) helpers.set(match[1], 'unknown');
      }
      const required = [...helpers.entries()]
        .filter(([, helper]) => ['requiredArg', 'requiredNumberArg'].includes(helper))
        .map(([key]) => key);
      const properties: Record<string, unknown> = {};
      for (const [key, helper] of helpers) {
        properties[key] = helper === 'unknown' ? {} : typeOf(helper);
      }
      // Station target selection is performed by the shared stationPath helper.
      if (body.includes('stationPath(')) properties.deviceId = { type: 'string' };
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
        demonstrationRunId: { type: 'string' },
        video: { type: 'boolean' },
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

describe('duck-lab-mcp user input semantics', () => {
  function trainingProbe(runOverrides: Record<string, unknown> = {}) {
    const requests: Array<{
      url: string;
      method: string;
      body: Record<string, unknown> | null;
    }> = [];
    const probeFetch = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      requests.push({ url: String(url), method: init?.method ?? 'GET', body });
      const payload = String(url).endsWith('/overview')
        ? { models: [{ id: 'fixture-first-model' }], devices: [] }
        : {
            run: {
              id: 'fixture-run',
              status: 'queued',
              modelId: body?.modelId,
              backend: body?.backend,
              mock: false,
              training: {
                numEnvs: 4,
                maxIterations: 6,
                video: false,
                ...(body?.training as object),
              },
              ...runOverrides,
            },
          };
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { ...makeDispatcher('http://platform.test', { fetch: probeFetch }), requests };
  }

  it('rejects an invalid backend before creating a different local job', async () => {
    const { call, requests } = trainingProbe();
    const response = (await call('tools/call', {
      name: 'rdk_training_submit',
      arguments: { backend: 'locla' },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('backend');
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['trajectoryPath', 'user-trajectory.jsonl'],
    ['trajectoryFile', 'user-trajectory.jsonl'],
    ['datasetPath', 'user-dataset'],
    ['datasetUri', 'file:///user-dataset'],
    ['dataPath', 'user-data.jsonl'],
    ['resumeFrom', { checkpointId: 'checkpoint', artifactRef: 'artifact://fixture/checkpoint' }],
    ['checkpointId', 'checkpoint'],
    ['training', { profile: 'standard' }],
  ])('rejects unsupported training input %s without silently dropping it', async (field, value) => {
    const { call, requests } = trainingProbe();
    const response = (await call('tools/call', {
      name: 'rdk_training_submit',
      arguments: { [field as string]: value },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain(String(field));
    expect(requests).toHaveLength(0);
  });

  it('preserves compatibility defaults while making the chosen configuration explicit', async () => {
    const { call, requests } = trainingProbe();
    const response = (await call('tools/call', {
      name: 'rdk_training_submit',
      arguments: {},
    })) as { result?: { structuredContent?: Record<string, unknown> } };
    const result = response.result?.structuredContent;
    expect(result?.resolvedTraining).toMatchObject({
      modelId: 'fixture-first-model',
      backend: 'local',
      profile: 'smoke',
      engine: null,
      numEnvs: 4,
      maxIterations: 6,
    });
    expect(result?.defaultsApplied).toEqual(['modelId', 'backend', 'profile']);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['learningRate', 0.0001],
    ['seed', 42],
    ['customTuning', { epochs: 100 }],
  ])(
    'rejects undeclared training parameter %s instead of reporting false tuning success',
    async (field, value) => {
      const { call, requests } = trainingProbe();
      const response = (await call('tools/call', {
        name: 'rdk_training_submit',
        arguments: { [field as string]: value },
      })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(response.result?.isError).toBe(true);
      expect(response.result?.content?.[0]?.text).toContain(String(field));
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    ['modelId', 123],
    ['profile', 123],
    ['modelId', ' '],
    ['profile', null],
    ['numEnvs', '16'],
    ['maxIterations', 'bad-number'],
    ['video', 'false'],
  ])(
    'rejects invalid training argument type/value %s without a fallback task',
    async (field, value) => {
      const { call, requests } = trainingProbe();
      const response = (await call('tools/call', {
        name: 'rdk_training_submit',
        arguments: { [field as string]: value },
      })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(response.result?.isError).toBe(true);
      expect(response.result?.content?.[0]?.text).toContain(String(field));
      expect(requests).toHaveLength(0);
    },
  );

  it.each(['user-dataset', [42], ['']])(
    'rejects malformed dataset IDs instead of silently training without their lineage',
    async (datasetIds) => {
      const { call, requests } = trainingProbe();
      const response = (await call('tools/call', {
        name: 'rdk_training_submit',
        arguments: { datasetIds },
      })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(response.result?.isError).toBe(true);
      expect(response.result?.content?.[0]?.text).toContain('datasetIds');
      expect(requests).toHaveLength(0);
    },
  );

  it('does not claim registered dataset IDs were consumed by a real imitation trainer', async () => {
    const { call } = trainingProbe();
    const response = (await call('tools/call', {
      name: 'rdk_training_submit',
      arguments: {
        modelId: 'user-model',
        backend: 'local',
        profile: 'standard',
        engine: 'act',
        datasetIds: ['user-dataset'],
      },
    })) as { result?: { structuredContent?: Record<string, unknown> } };
    expect(response.result?.structuredContent?.dataUsage).toMatchObject({
      datasetIds: ['user-dataset'],
      consumptionVerified: false,
    });
    expect(response.result?.structuredContent?.syntheticData).toMatchObject({
      confirmed: null,
      builtinSmokePath: true,
    });
    expect(response.result?.structuredContent?.defaultsApplied).toEqual([]);
  });

  it('forwards a managed demonstration source without claiming queued data was consumed', async () => {
    const snapshot = {
      sourceRunId: 'recorded-run',
      telemetryRevision: 'c'.repeat(64),
      source: 'import',
      rows: 140,
      sha256: 'a'.repeat(64),
    };
    const { call, requests } = trainingProbe({ trainingData: snapshot });
    const response = (await call('tools/call', {
      name: 'rdk_training_submit',
      arguments: {
        modelId: 'user-model',
        engine: 'offline-bc',
        demonstrationRunId: 'recorded-run',
        maxIterations: 100,
      },
    })) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    expect(response.result?.isError).not.toBe(true);
    expect(requests.find((entry) => entry.method === 'POST')?.body).toMatchObject({
      demonstrationRunId: 'recorded-run',
      training: { engine: 'offline-bc', maxIterations: 100 },
    });
    expect(response.result?.structuredContent?.dataUsage).toMatchObject({
      trainingData: snapshot,
      consumptionVerified: false,
    });
    expect(response.result?.structuredContent?.syntheticData).toMatchObject({
      builtinSmokePath: false,
      confirmed: null,
    });
  });

  it.each([
    ['completed', 'a', true],
    ['completed', 'b', false],
    ['running', 'a', false],
  ])(
    'requires completion and a matching consumed data digest (%s/%s)',
    async (status, digest, verified) => {
      const snapshot = {
        sourceRunId: 'recorded-run',
        telemetryRevision: 'c'.repeat(64),
        source: 'import',
        rows: 140,
        sha256: 'a'.repeat(64),
      };
      const { call } = trainingProbe({
        status,
        trainingData: snapshot,
        metrics: { syntheticData: false, trainingDataSha256: digest.repeat(64) },
      });
      const response = (await call('tools/call', {
        name: 'rdk_training_submit',
        arguments: { engine: 'offline-bc', demonstrationRunId: 'recorded-run' },
      })) as { result?: { structuredContent?: Record<string, unknown> } };
      expect(response.result?.structuredContent?.dataUsage).toMatchObject({
        consumptionVerified: verified,
      });
    },
  );

  it('advertises required fields, device selection, digests and stable operation keys', () => {
    const catalog = buildToolCatalog(createDshCapabilityHandlers());
    const tools = new Map(catalog.map((tool) => [tool.name, tool]));
    for (const [name, required] of [
      ['rdk_training_status', ['runId']],
      ['rdk_device_connect', ['connectionId']],
      ['rdk_board_policy_command', ['command']],
      ['rdk_board_arm_move', ['x', 'y', 'z']],
      ['rdk_board_arm_gripper', ['action', 'value']],
      ['rdk_artifact_promote', ['artifactId', 'status']],
    ] as const) {
      expect(tools.get(name)?.inputSchema.required, name).toEqual([...required]);
    }
    expect(tools.get('rdk_dataset_register')?.inputSchema.properties).toMatchObject({
      sha256: { type: 'string' },
    });
    expect(tools.get('rdk_board_policy_load')?.inputSchema.properties).toMatchObject({
      artifactSha256: { type: 'string' },
      deviceId: { type: 'string' },
    });
    expect(tools.get('rdk_board_station_status')?.inputSchema.properties).toMatchObject({
      deviceId: { type: 'string' },
    });
    expect(tools.get('rdk_board_policy_start')?.inputSchema.anyOf).toEqual([
      { required: ['direction'] },
      { required: ['command'] },
    ]);
    expect(tools.get('rdk_board_policy_command')?.inputSchema.properties).toMatchObject({
      command: {
        type: 'object',
        required: ['vx', 'vy', 'wz'],
        additionalProperties: false,
        properties: { ttlMs: { type: 'integer', minimum: 1, maximum: 2000 } },
      },
    });
    expect(tools.get('rdk_training_submit')?.inputSchema.properties).toMatchObject({
      idempotencyKey: { type: 'string', maxLength: 200 },
      backend: { enum: ['local', 'robogo', 'browser', 'contract'] },
      datasetIds: { description: expect.stringContaining('不上传轨迹') },
    });
    expect(tools.get('rdk_training_submit')?.inputSchema.additionalProperties).toBe(false);
    expect(tools.get('rdk_board_arm_gripper')?.inputSchema.properties).toMatchObject({
      action: { enum: ['close', 'open'] },
      value: { description: expect.stringContaining('mm') },
    });
    expect(tools.get('rdk_board_arm_move')?.inputSchema.properties).toMatchObject({
      x: { description: expect.stringContaining('mm') },
      speedMmPerS: { description: expect.stringContaining('mm/s') },
    });
  });

  it('rejects overlong operation keys instead of truncating two different requests to one key', async () => {
    const { call, requests } = trainingProbe();
    const response = (await call('tools/call', {
      name: 'rdk_training_submit',
      arguments: { idempotencyKey: `${'same-prefix-'.repeat(20)}distinct-suffix` },
    })) as { error?: { code: number; message: string } };
    expect(response.error?.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    expect(response.error?.message).toContain('200');
    expect(requests).toHaveLength(0);
  });
});

describe('duck-lab-mcp tools over the live platform', () => {
  it('reads exact telemetry summaries without buffering large sample vectors into MCP', async () => {
    const base = await fixture();
    const contract = BUILTIN_MICRODUCK_MODEL.manifest.contract;
    const run = await createSim2RealRun({
      modelId: BUILTIN_MICRODUCK_MODEL.id,
      contractId: contract.id,
      backend: 'browser',
      status: 'ready',
      summary: 'recording',
    });
    const samples = Array.from({ length: 300 }, (_, i) => ({
      t: i / 50,
      observation: Array(contract.observationSize).fill(0.1234567890123456),
      action: Array(contract.actionSize).fill(0.2345678901234567),
    }));
    await appendSim2RealTelemetry({
      runId: run.id,
      modelId: run.modelId,
      contractId: contract.id,
      source: 'browser',
      sequence: 7,
      samples,
    });
    const endpoint = `${base}/api/v1/duck/runs/${run.id}/telemetry`;
    const raw = await (await fetch(endpoint)).text();
    expect(Buffer.byteLength(raw)).toBeGreaterThan(256 * 1024);
    expect(JSON.parse(raw).telemetry[0].samples).toHaveLength(300);
    const summary = await (await fetch(endpoint + '?includeSamples=false')).json();
    expect(summary.telemetry[0]).toMatchObject({ sampleCount: 300, sequence: 7 });
    expect(summary.telemetry[0]).not.toHaveProperty('samples');
    const recorded = passThroughFetch();
    const { call } = makeDispatcher(base, { fetch: recorded.fetch });
    const response = (await call('tools/call', {
      name: 'rdk_telemetry_list',
      arguments: { runId: run.id },
    })) as {
      result?: {
        isError?: boolean;
        structuredContent?: { telemetry: Array<Record<string, unknown>> };
      };
    };
    expect(response.result?.isError).toBeFalsy();
    expect(response.result?.structuredContent?.telemetry).toEqual([
      expect.objectContaining({ sampleCount: 300, sequence: 7 }),
    ]);
    expect(recorded.urls.some((url) => url.includes('includeSamples=false'))).toBe(true);
    const replay = (await call('tools/call', {
      name: 'rdk_runs_replay',
      arguments: { runId: run.id },
    })) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    expect(replay.result?.isError).toBeFalsy();
    expect(replay.result?.structuredContent).toMatchObject({
      frameCount: 300,
      returnedFrameCount: 12,
    });
    expect(replay.result?.structuredContent?.projection).toMatchObject({ truncated: true });
    expect((await fetch(endpoint + '?includeSamples=maybe')).status).toBe(400);
  });
  it('preserves full 200-character logical keys through the platform 128-character header limit', async () => {
    const base = await fixture();
    const { call } = makeDispatcher(base);
    const firstKey = `${'same-prefix-'.repeat(16)}${'x'.repeat(7)}1`;
    const secondKey = `${'same-prefix-'.repeat(16)}${'x'.repeat(7)}2`;
    expect(firstKey.length).toBe(200);
    const submit = (idempotencyKey: string) =>
      call('tools/call', {
        name: 'rdk_training_submit',
        arguments: { backend: 'local', idempotencyKey },
      });
    const first = (await submit(firstKey)) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    expect(first.result?.isError).toBeFalsy();
    const runId = first.result?.structuredContent?.runId;
    expect(runId).toBeTruthy();
    const retry = (await submit(firstKey)) as {
      result?: { structuredContent?: Record<string, unknown> };
    };
    expect(retry.result?.structuredContent?.runId).toBe(runId);
    const different = (await submit(secondKey)) as {
      result?: { structuredContent?: Record<string, unknown> };
    };
    expect(different.result?.structuredContent?.runId).toBeTruthy();
    expect(different.result?.structuredContent?.runId).not.toBe(runId);
    const runs = (await call('tools/call', {
      name: 'rdk_runs_list',
      arguments: { limit: 10 },
    })) as { result?: { structuredContent?: Record<string, unknown> } };
    expect(runs.result?.structuredContent?.total).toBe(2);
  });

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
    expect(String(first.result?.structuredContent?.note)).toContain('被阻断');
    expect(first.result?.structuredContent?.resolvedTraining).toMatchObject({ backend: 'local' });

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
