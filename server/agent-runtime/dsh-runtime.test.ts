import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';

import { askDsh, createDshRuntime, DshAgentFailure } from './dsh-runtime.js';

/**
 * The runtime is exercised against a real DSH composition with a local
 * SSE-speaking chat-completions stub, because the two failure modes it must
 * cover (credential seam and silent turn errors) only reproduce through the
 * real plugin stack — mocking `Context` would test the mock instead.
 */

const originalEnv = { ...process.env };
const openRuntimes: Context[] = [];
const openGateways: Server[] = [];
const temporaryRoots: string[] = [];

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.RDK_SIM2REAL_DSH_API_KEY;
  delete process.env.RDK_SIM2REAL_DSH_BASE_URL;
  delete process.env.RDK_SIM2REAL_DSH_MODEL;
  delete process.env.RDK_STUDIO_LLM_BASE_URL;
  delete process.env.DEEPSEEK_MODEL;
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  await Promise.all(openRuntimes.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(
    openGateways
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type CapturedRequest = { url: string; authorization: string; body: string };

async function startChatGateway(
  handler: (request: CapturedRequest, response: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk) => {
      body += String(chunk);
    });
    incoming.on('end', () => {
      const captured: CapturedRequest = {
        url: incoming.url ?? '/',
        authorization: String(incoming.headers.authorization ?? ''),
        body,
      };
      requests.push(captured);
      handler(captured, response);
    });
  });
  openGateways.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function sseReply(response: ServerResponse, chunks: string[]): void {
  const asDeltas = chunks.map((content) => ({ content }));
  sseReplyDeltas(response, asDeltas);
}

function sseReplyDeltas(
  response: ServerResponse,
  deltas: { content?: string; reasoning_content?: string }[],
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const delta of deltas) {
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta }],
      })}\n\n`,
    );
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

async function composeRuntime(): Promise<Context> {
  const root = mkdtempSync(path.join(tmpdir(), 'rdk-dsh-runtime-'));
  temporaryRoots.push(root);
  const ctx = await createDshRuntime({ persistenceRoot: root });
  openRuntimes.push(ctx);
  return ctx;
}

describe('DSH runtime chat composition', () => {
  it('bridges the dedicated API key into the provider credential seam and returns the reply', async () => {
    const gateway = await startChatGateway((request, response) => {
      if (!request.url.includes('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      sseReply(response, ['你好！', '我是 RDK 工作台智能体。']);
    });
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const ctx = await composeRuntime();

    const result = await askDsh(ctx, '你好');

    expect(result.text).toBe('你好！我是 RDK 工作台智能体。');
    expect(String(result.sessionId)).toContain('sim2real-');
    expect(gateway.requests.length).toBeGreaterThanOrEqual(1);
    expect(
      gateway.requests.every((item) => item.authorization === 'Bearer dedicated-dsh-key'),
    ).toBe(true);
  }, 60_000);

  it('drops reasoning-block preamble from the reply text of reasoning models', async () => {
    // The managed RDK Studio gateway fronts a reasoning model that streams its
    // thinking through `reasoning_content` deltas before the visible answer.
    const gateway = await startChatGateway((request, response) => {
      if (!request.url.includes('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      sseReplyDeltas(response, [
        { reasoning_content: '用户让我介绍自己，直接回答即可。' },
        { reasoning_content: '组织语言。' },
        { content: '我是' },
        { content: ' RDK 工作台智能体。' },
      ]);
    });
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const ctx = await composeRuntime();

    const result = await askDsh(ctx, '介绍你自己');

    expect(result.text).toBe('我是 RDK 工作台智能体。');
    expect(result.text).not.toContain('直接回答');
  }, 60_000);

  it('binds product capability tools so the model can call them mid-turn', async () => {
    // First LLM round: the model requests a workspace overview tool call.
    // Second round: it answers using the tool result. The gateway stub
    // distinguishes the rounds by inspecting the last message role.
    const gateway = await startChatGateway((request, response) => {
      if (!request.url.includes('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(request.body) as { messages?: Array<{ role?: string }> };
      const lastRole = body.messages?.at(-1)?.role;
      if (lastRole === 'tool') {
        sseReply(response, ['工作区里有 2 个模型和 1 块板卡。']);
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'rdk_workspace_overview', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        response.write('data: [DONE]\n\n');
        response.end();
      }
    });
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const root = mkdtempSync(path.join(tmpdir(), 'rdk-dsh-runtime-'));
    temporaryRoots.push(root);
    const ctx = await createDshRuntime({
      persistenceRoot: root,
      capabilityHandlers: {
        rdk_workspace_overview: async () => ({
          models: [{ id: 'model-a' }, { id: 'model-b' }],
          devices: [{ id: 'device-x5' }],
        }),
      },
    });
    openRuntimes.push(ctx);

    const result = await askDsh(ctx, '看看工作区里有什么');

    expect(result.text).toBe('工作区里有 2 个模型和 1 块板卡。');
    // The dispatched tool call must be visible in the projected event tail.
    const toolCalls = result.events.filter((event) => event.type === 'tool/call');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('fails closed with a credential hint instead of a fake empty reply when no key is configured', async () => {
    // The gateway is wired on purpose: a missing credential must stop the
    // request before any traffic leaves the process.
    const gateway = await startChatGateway((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end();
    });
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    const ctx = await composeRuntime();

    await expect(askDsh(ctx, '你好')).rejects.toBeInstanceOf(DshAgentFailure);
    await expect(askDsh(ctx, '你好')).rejects.toMatchObject({
      code: 'DSH_CREDENTIAL_MISSING',
      message: expect.stringContaining('RDK_SIM2REAL_DSH_API_KEY'),
    });
    expect(gateway.requests).toHaveLength(0);
  }, 60_000);

  it('maps provider failures to a stable DSH turn failure', async () => {
    const gateway = await startChatGateway((_request, response) => {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'provider exploded' } }));
    });
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const ctx = await composeRuntime();

    await expect(askDsh(ctx, '你好')).rejects.toMatchObject({
      code: 'DSH_TURN_FAILED',
      name: 'DshAgentFailure',
    });
  }, 60_000);
});
