import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';

import {
  askDsh,
  createDshRuntime,
  DshAgentFailure,
  resolveDshPersistenceRoot,
  stripEnglishPreamble,
  stripInlineEnglishPreamble,
  stripThinkBlock,
} from './dsh-runtime.js';

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

function composeRuntimeWith(
  handlers: Parameters<typeof createDshRuntime>[0]['capabilityHandlers'],
) {
  return async (): Promise<Context> => {
    const root = mkdtempSync(path.join(tmpdir(), 'rdk-dsh-runtime-'));
    temporaryRoots.push(root);
    const ctx = await createDshRuntime({ persistenceRoot: root, capabilityHandlers: handlers });
    openRuntimes.push(ctx);
    return ctx;
  };
}

describe('DSH think-block leak stripping', () => {
  it('drops everything up to the last close marker when thinking leaks into content', () => {
    // Gateways that inline reasoning usually keep only the closing tag.
    expect(stripThinkBlock('Let me draft this.</think>我能帮你走完完整闭环。')).toBe(
      '我能帮你走完完整闭环。',
    );
    // Paired markers are covered by the same last-marker rule.
    expect(stripThinkBlock('<think>按场景概述即可。</think>正式回答。')).toBe('正式回答。');
    expect(stripThinkBlock('<think>草稿。</think>铺垫<think>终稿。</think>答案。')).toBe('答案。');
    // Plain replies and a dangling open marker must stay untouched.
    expect(stripThinkBlock('普通回答。')).toBe('普通回答。');
    expect(stripThinkBlock('<think>截断的思考')).toBe('<think>截断的思考');
    // A marker with nothing after it is not worth stripping.
    expect(stripThinkBlock('思考完毕。</think>')).toBe('思考完毕。</think>');
  });
});

describe('DSH runtime capability briefing section', () => {
  it('pins the briefing to the bound handler set so capability tours stay complete and honest', async () => {
    const compose = composeRuntimeWith({
      rdk_workspace_overview: async () => ({ ok: true }),
      rdk_board_policy_start: async () => ({ ok: true }),
    });
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const ctx = await compose();

    const assembly = await ctx.systemPrompt.assemble();
    const section = assembly.sections.find((item) => item.name === 'rdk:capability-briefing');

    expect(section?.text).toContain('已绑定的 2 个');
    expect(section?.text).toMatch(/如实标注：rdk_board_policy_start。/);
    expect(section?.text).toContain('其余 1 个均为只读');
    expect(section?.text).toContain('能力目录');
  }, 60_000);

  it('keeps reply-formatting conventions but drops the catalog when no product handler is bound', async () => {
    const ctx = await composeRuntime();

    const assembly = await ctx.systemPrompt.assemble();
    const section = assembly.sections.find((item) => item.name === 'rdk:capability-briefing');

    expect(section).toBeTruthy();
    expect(section?.text).toContain('回复排版约定');
    expect(section?.text).not.toContain('RDK 工作台能力口径');
  }, 60_000);
});

describe('DSH runtime token metering', () => {
  it('meters each turn by itself instead of accumulating the session history', async () => {
    // Usage arrives on the trailing usage-only stream chunk, mirroring the
    // OpenAI-compatible gateways this deployment fronts.
    const gateway = await startChatGateway((request, response) => {
      if (!request.url.includes('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: '收到。' } }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 7 },
        })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const ctx = await composeRuntime();

    const first = await askDsh(ctx, '你好');
    expect(first.usage).toMatchObject({ inputTokens: 100, outputTokens: 7, totalTokens: 107 });

    const followup = await askDsh(ctx, '请再确认一次', { sessionId: first.sessionId });
    // Before the per-turn meter this follow-up reported 200/14: the session-wide
    // event list double-counted every earlier turn under a "本轮" label.
    expect(followup.usage).toMatchObject({ inputTokens: 100, outputTokens: 7, totalTokens: 107 });
  }, 60_000);
});

describe('DSH persistence root resolution', () => {
  it('defaults into the configured storage root so sandboxed units stay writable', () => {
    // ProtectSystem=strict deployments whitelist only RDK_SIM2REAL_STORAGE_DIR;
    // a cwd default would be read-only and fail the first turn.
    expect(resolveDshPersistenceRoot(() => '/opt/data')).toBe('/opt/data/dsh-sessions');
  });

  it('lets an explicit RDK_SIM2REAL_DSH_HOME win over the storage default', () => {
    expect(resolveDshPersistenceRoot(() => '/opt/data', '/var/lib/dsh')).toBe('/var/lib/dsh');
    expect(resolveDshPersistenceRoot(() => '/opt/data', '  ')).toBe('/opt/data/dsh-sessions');
  });
});

describe('DSH reply preamble stripping', () => {
  it('drops a pure-ASCII English first line when a following body exists', () => {
    expect(
      stripEnglishPreamble("I'll read the workspace overview for you.\n\n## 模型\n- 内置模型 2 个"),
    ).toBe('## 模型\n- 内置模型 2 个');
  });

  it('strips the whole per-step English preface of a tool-using turn', () => {
    expect(
      stripEnglishPreamble(
        "I'll start by reading the workspace overview.\nNow let me summarize the evaluation.\n已完成两次只读读取。\n\n## 结果",
      ),
    ).toBe('已完成两次只读读取。\n\n## 结果');
  });

  it('keeps a single-line answer, a Chinese first line, and a long English body', () => {
    // All-English answers survive: their first line is their body.
    expect(stripEnglishPreamble('Training completed in 90 seconds.')).toBe(
      'Training completed in 90 seconds.',
    );
    // A Chinese first line is never touched.
    expect(stripEnglishPreamble('已完成。\n后续步骤如下')).toBe('已完成。\n后续步骤如下');
    // An over-long first line is treated as content, not preamble.
    const longLine = `x`.repeat(300);
    expect(stripEnglishPreamble(`${longLine}\nbody`)).toBe(`${longLine}\nbody`);
  });

  it('stops stripping at structural Markdown and caps the preface length', () => {
    // A Markdown heading ends the preface even when it is pure ASCII: the real
    // answer is starting.
    expect(stripEnglishPreamble('Let me summarize.\n## Summary\n- item')).toBe(
      '## Summary\n- item',
    );
    // An all-English message whose first six lines are short sentences is kept
    // verbatim: past the cap, the English is the content.
    const englishProse = Array.from({ length: 8 }, (_, i) => `Line number ${i} here.`).join('\n');
    expect(stripEnglishPreamble(englishProse)).toBe(englishProse);
  });

  it('strips inline per-step narrations that share the first line with the answer', () => {
    // askDsh joins per-step text with '', so step narrations land inline ahead
    // of the CJK answer on the SAME line. The narration and its glued
    // Markdown marker go; the answer text survives.
    expect(
      stripInlineEnglishPreamble(
        "I'll read the overview.Workspace read.## 工作区总览\n\n**模型**：7 个",
      ),
    ).toBe('工作区总览\n\n**模型**：7 个');
    // Chinese-first lines and pure-ASCII lines are untouched.
    expect(stripInlineEnglishPreamble('已完成。\n后续')).toBe('已完成。\n后续');
    expect(stripInlineEnglishPreamble('All English line.')).toBe('All English line.');
    // Five or more inline sentences read as content, not narration.
    const dense =
      'One sentence. Two sentence. Three sentence. Four sentence. Five sentence.然后是中文。';
    expect(stripInlineEnglishPreamble(dense)).toBe(dense);
  });
});

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
    const followup = await askDsh(ctx, '请再确认一次', { sessionId: result.sessionId });
    expect(followup.sessionId).toBe(result.sessionId);
    expect(followup.text).toBe('你好！我是 RDK 工作台智能体。');
  }, 60_000);

  it('recovers when the browser keeps a session id whose server transcript is gone', async () => {
    const gateway = await startChatGateway((request, response) => {
      if (!request.url.includes('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      sseReply(response, ['会话已恢复。']);
    });
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const ctx = await composeRuntime();

    const result = await askDsh(ctx, '继续', { sessionId: 'sim2real-stale-browser-session' });

    expect(result.sessionId).toBe('sim2real-stale-browser-session');
    expect(result.text).toBe('会话已恢复。');
    expect(gateway.requests).toHaveLength(1);
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
    // The thinking is offered separately instead of being discarded, so the
    // chat UI can render an optional trace without polluting the reply.
    expect(result.reasoning).toContain('用户让我介绍自己');
    expect(result.reasoning).toContain('组织语言');
  }, 60_000);

  it('strips a think block that the gateway inlined into the visible content', async () => {
    // Some OpenAI-compatible gateways stream reasoning as content delimited by
    // a literal `</think>` instead of a separate reasoning field.
    const gateway = await startChatGateway((request, response) => {
      if (!request.url.includes('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      sseReply(response, [
        '<think>按场景概述即可，不逐条罗列。</think>',
        '我是 RDK 工作台智能体。',
      ]);
    });
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const ctx = await composeRuntime();

    const result = await askDsh(ctx, '你能做啥');

    expect(result.text).toBe('我是 RDK 工作台智能体。');
    expect(result.text).not.toContain('<think>');
    expect(result.text).not.toContain('按场景概述');
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
    // And in the dedicated trail: streaming chunks push tool events out of the
    // fixed event tail, so the trail is computed from the full event list.
    expect(result.toolTrail).toEqual([{ name: 'rdk_workspace_overview', step: 1, ok: true }]);
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

  it('maps upstream 404s to a base-URL path hint instead of opaque UNKNOWN', async () => {
    // An OpenAI-compatible gateway serves chat completions under /v1; a
    // missing prefix surfaces as 404 on the DeepSeek adapter's request.
    const gateway = await startChatGateway((request, response) => {
      if (!request.url.startsWith('/v1/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: '404 page not found' } }));
        return;
      }
      sseReply(response, ['OK']);
    });
    // Deliberately point at the gateway root so the adapter's request misses
    // the /v1 prefix, exactly like the production misconfiguration did.
    process.env.RDK_SIM2REAL_DSH_BASE_URL = gateway.baseUrl;
    process.env.RDK_SIM2REAL_DSH_API_KEY = 'dedicated-dsh-key';
    const ctx = await composeRuntime();

    await expect(askDsh(ctx, '你好')).rejects.toMatchObject({
      code: 'DSH_GATEWAY_PATH_NOT_FOUND',
      message: expect.stringContaining('/v1'),
    });
  }, 60_000);
});
