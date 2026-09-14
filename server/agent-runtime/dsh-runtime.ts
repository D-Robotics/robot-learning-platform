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

export async function createDshRuntime(options: DshRuntimeOptions): Promise<Context> {
  const ctx = new Context();
  const gatewayBaseUrl = String(
    process.env.RDK_SIM2REAL_DSH_BASE_URL || process.env.RDK_STUDIO_LLM_BASE_URL || '',
  ).trim();
  const deepseekOptions = {
    ...(gatewayBaseUrl ? { baseURL: gatewayBaseUrl } : {}),
    ...(process.env.RDK_SIM2REAL_DSH_API_KEY
      ? { apiKey: process.env.RDK_SIM2REAL_DSH_API_KEY }
      : {}),
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
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
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
    const messages = events
      .filter(
        (event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message',
      )
      .map((event) => event.data.message);
    const text = messages
      .flatMap((message) => {
        if (typeof message === 'string') return [message];
        const content = message?.content;
        if (typeof content === 'string') return [content];
        if (!Array.isArray(content)) return [];
        return content.flatMap((block) => {
          if (typeof block === 'string') return [block];
          if (
            block &&
            typeof block === 'object' &&
            typeof (block as { text?: unknown }).text === 'string'
          )
            return [(block as { text: string }).text];
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
