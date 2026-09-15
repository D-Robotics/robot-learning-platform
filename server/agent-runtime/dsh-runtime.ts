/**
 * Product-owned DSH runtime entry point. Domain routes must use this host rather
 * than constructing their own planner. The composition is deliberately small:
 * DSH owns sessions/agent loop/tools; product plugins register atomic abilities.
 */
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import * as DeepSeekLlm from '@deepseek-ai/dsh-llm-deepseek';
import SessionStore from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import UserQuestions from '@deepseek-ai/dsh-user-questions';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import * as ToolCallTimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy';
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import { installDshCapabilityTools, type DshCapabilityHandlers } from './dsh-capability-tools.js';

export type DshRuntimeOptions = {
  persistenceRoot: string;
  deepseek?: Record<string, unknown>;
  capabilityHandlers?: DshCapabilityHandlers;
};

/** Accept the same explicit boolean spellings as the standalone service. */
export function dshRuntimeEnabled(value: unknown = process.env.RDK_SIM2REAL_DSH_RUNTIME): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

/**
 * Resolve the DSH session persistence root, defaulting into the product's
 * configured storage directory. Sandboxed units (ProtectSystem=strict) keep
 * only the storage directory writable, and DSH creates its session files
 * lazily on the first turn — a cwd default would pass startup composition and
 * fail every real turn. The default also keeps sessions across release
 * switches; an explicit RDK_SIM2REAL_DSH_HOME always wins.
 */
export function resolveDshPersistenceRoot(
  storageRoot: () => string,
  home = process.env.RDK_SIM2REAL_DSH_HOME,
): string {
  const explicit = String(home ?? '').trim();
  if (explicit) return explicit;
  return path.join(storageRoot(), 'dsh-sessions');
}

export async function createDshRuntime(options: DshRuntimeOptions): Promise<Context> {
  const ctx = new Context();
  const gatewayBaseUrl = String(
    process.env.RDK_SIM2REAL_DSH_BASE_URL || process.env.RDK_STUDIO_LLM_BASE_URL || '',
  ).trim();
  // The DeepSeek adapter has no `apiKey` config field: it resolves its
  // credential lazily from the launching environment (`DEEPSEEK_API_KEY`, or
  // the `apiKeyEnv` reference). Bridge the dedicated variable before the
  // plugins load so it actually reaches the provider, with the same "dedicated
  // setting wins" precedence as the model below.
  const dedicatedApiKey = String(process.env.RDK_SIM2REAL_DSH_API_KEY ?? '').trim();
  if (dedicatedApiKey) process.env.DEEPSEEK_API_KEY = dedicatedApiKey;
  const deepseekOptions = {
    ...(gatewayBaseUrl ? { baseURL: gatewayBaseUrl } : {}),
    ...(options.deepseek ?? {}),
  };
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(TokenMeter);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(SkillRegistry);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(ApprovalService);
    await ctx.plugin(UserQuestions);
    await ctx.plugin(BasicCompactionEngine);
    await ctx.plugin(ToolResultPruner);
    await ctx.plugin(ToolCallTimeoutPolicy);
    await ctx.plugin(JsonlSessionPersistence, {
      root: options.persistenceRoot,
      compression: 'none',
      packChunks: false,
    });
    await ctx.plugin(SessionCheckpointPolicy);
    await ctx.plugin(DeepSeekLlm, deepseekOptions);
    await ctx.plugin(AgentLoop, { agents: [] });
    installDshCapabilityTools(ctx, options.capabilityHandlers);
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose().catch(() => undefined);
    throw error;
  }
}

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * A DSH turn that ended in an error. Carries only a stable code and a
 * user-facing message; provider internals stay in the server-side logs so the
 * HTTP surface never leaks transport details or credentials.
 */
export class DshAgentFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DshAgentFailure';
  }
}

/**
 * Inspect the session's turn summaries and return the terminal error of the
 * last turn, if any. The SDK's `turn/end` events are the authoritative
 * outcome: a turn can fail without producing any assistant message (for
 * example a missing provider credential), which must not be reported as a
 * successful empty reply.
 */
function lastTurnFailure(events: readonly unknown[]): { code: string; message: string } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== 'object') continue;
    const source = event as { type?: unknown; data?: unknown };
    if (source.type !== 'turn/end') continue;
    const data = source.data as
      { reason?: { kind?: unknown; error?: { code?: unknown; message?: unknown } } } | undefined;
    const reason = data?.reason;
    if (!reason || reason.kind !== 'error') return null;
    const error = reason.error ?? {};
    return {
      code: typeof error.code === 'string' ? error.code : '',
      message: typeof error.message === 'string' ? error.message : '',
    };
  }
  return null;
}

function mapTurnFailure(failure: { code: string; message: string }): DshAgentFailure {
  if (failure.code === 'MISSING_CREDENTIAL') {
    return new DshAgentFailure(
      'DSH_CREDENTIAL_MISSING',
      'DSH 已启用但缺少模型凭证：请在服务端配置 RDK_SIM2REAL_DSH_API_KEY 或 DEEPSEEK_API_KEY 后重启。',
    );
  }
  // The DeepSeek adapter reports an OpenAI-compatible gateway's 404 as
  // `HTTP_404` (or a generic UNKNOWN wrapping "404/not found"): the SDK cannot
  // know whether the configured base URL is the official API or a gateway.
  // Point operators at the path-prefix mismatch explicitly instead of a code
  // they cannot act on.
  if (/404|not found/i.test(`${failure.code} ${failure.message}`)) {
    return new DshAgentFailure(
      'DSH_GATEWAY_PATH_NOT_FOUND',
      'DSH 网关返回 404：请检查 RDK_SIM2REAL_DSH_BASE_URL（OpenAI 兼容网关通常需要 /v1 前缀）。',
    );
  }
  return new DshAgentFailure(
    'DSH_TURN_FAILED',
    `DSH 本轮对话失败${failure.code ? `（${failure.code}）` : ''}，请稍后重试。`,
  );
}

export async function askDsh(ctx: Context, prompt: string, options: { model?: string } = {}) {
  const id = SessionId(`sim2real-${randomUUID()}`);
  const handle = await ctx.agents.create({
    sessionId: id,
    agentOptions: {
      provider: 'deepseek-official',
      // Keep the agent model explicit and deployment-owned.  The dedicated
      // setting wins, while DEEPSEEK_MODEL remains a backwards-compatible
      // fallback for existing Studio deployments.
      model:
        options.model ||
        process.env.RDK_SIM2REAL_DSH_MODEL ||
        process.env.DEEPSEEK_MODEL ||
        'deepseek-chat',
    },
  });
  try {
    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: prompt.slice(0, 12000) }],
        source: { kind: 'user' },
      }),
    );
    await handle.agent.whenIdle();
    const events = handle.agent.session.events;
    const failure = lastTurnFailure(events);
    if (failure) throw mapTurnFailure(failure);
    const messages = events
      .filter(
        (event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message',
      )
      .map((event) => event.data.message);
    // Visible answer text only. Reasoning models stream their thinking as
    // separate `type: "reasoning"` blocks on the same message; flattening every
    // block with a `.text` field would prepend that preamble to the user's reply.
    const text = messages
      .flatMap((message) => {
        if (typeof message === 'string') return [message];
        const content = message?.content;
        if (typeof content === 'string') return [content];
        if (!Array.isArray(content)) return [];
        return content.flatMap((block) => {
          if (typeof block === 'string') return [block];
          const candidate = block as { type?: unknown; text?: unknown };
          if (
            typeof candidate.text === 'string' &&
            (!candidate.type || ['text', 'output_text'].includes(String(candidate.type)))
          )
            return [candidate.text];
          return [];
        });
      })
      .join('')
      .trim();
    return {
      sessionId: id,
      text: text || 'DSH 已完成本轮，但没有返回文本。',
      events: events.slice(-50),
    };
  } finally {
    await handle.dispose();
  }
}
