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
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
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
import {
  capabilityBriefing,
  installDshCapabilityTools,
  type DshCapabilityHandlers,
} from './dsh-capability-tools.js';

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
    });
    await ctx.plugin(SessionCheckpointPolicy);
    // 0.1.5 的 AgentLoop 在构造时向 projection registry 注册 turn 边界投影，
    // 该 registry 不再由 SessionStore 隐式提供，必须显式加载。
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(DeepSeekLlm, deepseekOptions);
    await ctx.plugin(AgentLoop, { agents: [] });
    installDshCapabilityTools(ctx, options.capabilityHandlers);
    // Tool schemas make the tools callable but say nothing about how to PRESENT
    // the capability set; the briefing section closes that gap. Reply-formatting
    // conventions ride along so chat rendering stays predictable even in bare
    // demo runs without bound product handlers.
    const briefing = capabilityBriefing(options.capabilityHandlers);
    const replyFormatting = [
      '## 回复排版约定',
      '- 聊天面板只渲染 Markdown 子集:##/### 小标题、- 或 1. 列表、**加粗**、`行内代码`。',
      '- **加粗**只用于完整术语或关键结论,禁止对单个汉字或半句话加粗。',
      '- 多步骤说明用列表逐条罗列;命令、路径、id、参数名一律放 `行内代码`。',
    ].join('\n');
    ctx.systemPrompt.section({
      name: 'rdk:capability-briefing',
      order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: briefing ? `${briefing}\n\n${replyFormatting}` : replyFormatting,
    });
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

const DEFAULT_DSH_TURN_TIMEOUT_MS = 110_000;

function dshTurnTimeoutMs(): number {
  const configured = Number(process.env.RDK_SIM2REAL_DSH_TURN_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_DSH_TURN_TIMEOUT_MS;
  // Keep the agent timeout below the HTTP request timeout so the browser gets
  // a stable JSON error instead of a socket reset when a provider/tool stalls.
  return Math.min(Math.max(Math.floor(configured), 1_000), 119_000);
}

async function waitForDshTurn(agent: { whenIdle: () => Promise<unknown> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DshAgentFailure(
                'DSH_TURN_TIMEOUT',
                'DSH 本轮对话等待超时，模型或工具可能仍在处理；请稍后查看运行记录或重试。',
              ),
            ),
          dshTurnTimeoutMs(),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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

/**
 * Drop the English preamble a bilingual model prepends before its real answer
 * (e.g. "I'll read the workspace overview for you." before the Chinese reply).
 * In tool-using turns the model emits one such sentence per step, so the rule
 * strips the ENTIRE leading run of pure-ASCII lines, not just the first line.
 * Boundaries that stop the strip: the first line containing CJK or other
 * non-ASCII text, a Markdown heading/table/fence (structure signals the real
 * answer), or an over-long English line (an English body's first sentence).
 * A line count cap keeps an all-English answer's body intact when its opening
 * happens to be several short sentences: past the cap we assume the English
 * IS the content and return the original text.
 */
export function stripEnglishPreamble(text: string): string {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  const limit = Math.min(lines.length, 6);
  let index = 0;
  let stripChars = 0;
  while (index < limit) {
    const line = lines[index];
    if (!line.trim()) {
      // Blank line inside the preamble: still ASCII-only so far; keep scanning
      // but remember how much would be stripped.
      stripChars += line.length + 1;
      index += 1;
      continue;
    }
    if (!/^[\x20-\x7e]*$/.test(line)) break; // non-ASCII: the real answer starts here
    if (line.length > 240) break; // too long to be a throwaway preamble line
    if (/^(#{1,6}\s|[-*]\s|\||```|>\s|\d+\.\s)/.test(line)) break; // structural Markdown
    stripChars += line.length + 1;
    index += 1;
  }
  if (index >= lines.length) return source; // the whole message was English prose
  // The cap fired while every scanned line still looked like preamble: an
  // all-English message whose opening happens to be several short sentences.
  // Treat the English as the content instead of stripping into the body.
  if (index >= limit && limit < lines.length) return source;
  const rest = source.slice(stripChars).replace(/^(?:\r?\n)+/, '');
  return rest.trim() ? rest : source;
}

/**
 * Drop a reasoning model's think block that leaked into the visible content.
 * OpenAI-compatible gateways do not agree on where thinking belongs: some keep
 * `reasoning_content` separate, others inline it into `content` delimited by a
 * literal `</think>` marker (the opening tag may be swallowed). Everything up
 * to and including the LAST close marker is preamble; what follows is the
 * user's answer. Text without the marker is returned untouched.
 */
export function stripThinkBlock(text: string): string {
  const source = String(text ?? '');
  const marker = '</think>';
  const index = source.lastIndexOf(marker);
  if (index === -1) return source;
  const rest = source.slice(index + marker.length);
  return rest.trim() ? rest : source;
}

/**
 * The runtime joins per-step assistant text with `join('')`, so a multi-step
 * turn can land its English narrations inline on ONE line ahead of the real
 * answer ("I'll read the overview.Workspace read.## 工作区总览…"). Line-based
 * stripping cannot see that. This pass strips a leading ASCII run within the
 * first line, ending at the first CJK character, structural Markdown, or a
 * sentence-past-the-cap boundary (three sentences is narration; five is
 * content). Only the first line is touched, and only up to 400 characters in.
 */
export function stripInlineEnglishPreamble(text: string): string {
  const source = String(text ?? '');
  const firstBreak = source.search(/\r?\n/);
  const firstLine = firstBreak === -1 ? source : source.slice(0, firstBreak);
  if (firstLine.length > 400) return source;
  // Find the first character that is not printable ASCII: CJK starts there.
  let boundary = -1;
  for (let index = 0; index < firstLine.length; index += 1) {
    const code = firstLine.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      boundary = index;
      break;
    }
  }
  if (boundary === -1) return source; // the line is pure ASCII: line pass owns it
  const inline = firstLine.slice(0, boundary);
  const sentenceEnds = (inline.match(/[.!?:](?:\s|$)/g) || []).length;
  if (!inline.trim()) return source;
  if (sentenceEnds > 4) return source; // too much English inline: treat as content
  // Narrations can be glued directly onto the answer's Markdown marker
  // ("...overview.## 工作区总览"): walk the boundary back over immediately
  // preceding heading/hash characters so the marker survives the strip.
  while (boundary > 0 && firstLine.charCodeAt(boundary - 1) === 0x23) boundary -= 1;
  const remainder = firstLine.slice(boundary);
  const rebuilt = `${remainder}${firstBreak === -1 ? '' : source.slice(firstBreak)}`;
  return rebuilt.trim() ? rebuilt : source;
}

/**
 * Collect the model's reasoning/thinking blocks into one string. Reasoning
 * models stream their thinking as separate `type: "reasoning"` blocks on the
 * same message; the visible answer stays in `type: "text"` blocks. Keeping the
 * two apart lets the UI offer the thinking as an optional trace instead of
 * either prepending it to the reply or discarding it.
 */
function reasoningTextOf(events: readonly unknown[]): string {
  return events
    .filter(
      (item): item is SessionEvent<'assistant/message'> =>
        Boolean(item) &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'assistant/message',
    )
    .flatMap((event) => {
      const message = event.data.message;
      if (typeof message === 'string') return [];
      const content = message?.content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((block) => {
        if (typeof block === 'string') return [];
        const candidate = block as { type?: unknown; text?: unknown };
        return candidate.type === 'reasoning' && typeof candidate.text === 'string'
          ? [candidate.text]
          : [];
      });
    })
    .join('')
    .trim();
}

/**
 * Project the tool calls of a turn into name + step + outcome entries. This
 * walks the FULL event list — the response's 50-event diagnostic tail is
 * routinely flooded by `assistant/chunk` stream events, which would slice the
 * `tool/call` records out of a tool-using turn and hide exactly the calls the
 * chat UI wants to show. Arguments and result payloads stay here.
 */
export function toolTrailOf(
  events: readonly unknown[],
): Array<{ name: string; step: number; ok: boolean }> {
  const trail: Array<{ name: string; step: number; ok: boolean | null }> = [];
  const byCallId = new Map<string, { name: string; step: number; ok: boolean | null }>();
  for (const item of events) {
    if (!item || typeof item !== 'object') continue;
    const source = item as {
      type?: unknown;
      data?: {
        name?: unknown;
        step?: unknown;
        callId?: unknown;
        message?: { toolCallId?: unknown } | string;
        error?: unknown;
      };
    };
    if (source.type === 'tool/call') {
      const name = typeof source.data?.name === 'string' ? source.data.name.slice(0, 80) : '';
      const step = Number(source.data?.step);
      if (!name || !Number.isInteger(step)) continue;
      const entry = { name, step, ok: null };
      trail.push(entry);
      if (typeof source.data?.callId === 'string' && source.data.callId)
        byCallId.set(source.data.callId, entry);
      continue;
    }
    if (source.type === 'tool/result') {
      const message = source.data?.message;
      const callId =
        typeof message === 'object' && message !== null
          ? typeof message.toolCallId === 'string'
            ? message.toolCallId
            : ''
          : '';
      const failed = Boolean(source.data?.error);
      const entry = (callId && byCallId.get(callId)) || pendingEntryOf(trail);
      if (entry) entry.ok = !failed;
    }
  }
  return trail
    .filter((entry): entry is { name: string; step: number; ok: boolean } => entry.ok !== null)
    .map((entry) => ({ name: entry.name, step: entry.step, ok: Boolean(entry.ok) }));
}

function pendingEntryOf(
  trail: Array<{ name: string; step: number; ok: boolean | null }>,
): { name: string; step: number; ok: boolean | null } | undefined {
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    if (trail[index].ok === null) return trail[index];
  }
  return undefined;
}

function tokenUsageOf(events: readonly unknown[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let seen = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const source = event as { type?: unknown; data?: unknown };
    if (source.type !== 'assistant/message' || !source.data || typeof source.data !== 'object')
      continue;
    const usage = (source.data as { usage?: unknown }).usage;
    if (!usage || typeof usage !== 'object') continue;
    const input = Number((usage as { inputTokens?: unknown }).inputTokens);
    const output = Number((usage as { outputTokens?: unknown }).outputTokens);
    if (!Number.isFinite(input) && !Number.isFinite(output)) continue;
    if (Number.isFinite(input)) inputTokens += Math.max(0, Math.floor(input));
    if (Number.isFinite(output)) outputTokens += Math.max(0, Math.floor(output));
    seen = true;
  }
  return seen ? { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : undefined;
}

export async function askDsh(
  ctx: Context,
  prompt: string,
  options: { model?: string; sessionId?: string; signal?: AbortSignal } = {},
) {
  const id = SessionId(options.sessionId || `sim2real-${randomUUID()}`);
  const agentOptions = {
    provider: 'deepseek-official',
    // Keep the agent model explicit and deployment-owned.  The dedicated
    // setting wins, while DEEPSEEK_MODEL remains a backwards-compatible
    // fallback for existing Studio deployments.
    model:
      options.model ||
      process.env.RDK_SIM2REAL_DSH_MODEL ||
      process.env.DEEPSEEK_MODEL ||
      'deepseek-chat',
  };
  // A follow-up must resume the persisted session. Calling create() with an
  // id that already has durable history races the registry's live-session
  // ownership check and surfaces an opaque UNKNOWN/id-collision failure after
  // the first successful turn. A browser can still hold a session id after a
  // release, storage restore, or manual cleanup removed its server-side
  // transcript, though. In that case the session is recoverable: start a new
  // session under the same opaque id so the next turn works without requiring
  // users to clear local storage or create a new conversation manually.
  let handle;
  if (options.sessionId) {
    try {
      handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (!/session .*not found/i.test(message)) throw error;
      handle = await ctx.agents.create({ sessionId: id, agentOptions });
    }
  } else {
    handle = await ctx.agents.create({ sessionId: id, agentOptions });
  }
  const cancelOnAbort = () => handle.agent.cancel({ kind: 'parent' });
  try {
    if (options.signal?.aborted) {
      cancelOnAbort();
      throw new DshAgentFailure('DSH_TURN_ABORTED', 'DSH 本轮对话已取消。');
    }
    options.signal?.addEventListener('abort', cancelOnAbort, { once: true });
    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: prompt.slice(0, 12000) }],
        source: { kind: 'user' },
      }),
    );
    await waitForDshTurn(handle.agent);
    const events = handle.agent.session.snapshotEvents();
    const failure = lastTurnFailure(events);
    if (failure) throw mapTurnFailure(failure);
    // Resumed sessions contain the complete durable conversation. Project only
    // the current turn back to the browser; returning the full history here
    // makes every follow-up repeat all previous assistant text in one reply.
    let latestTurnStart = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/start') {
        latestTurnStart = index;
        break;
      }
    }
    const turnEvents = latestTurnStart >= 0 ? events.slice(latestTurnStart) : events;
    const messages = turnEvents
      .filter(
        (item): item is SessionEvent<'assistant/message'> =>
          Boolean(item) &&
          typeof item === 'object' &&
          (item as { type?: unknown }).type === 'assistant/message',
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
    // The chat UI renders this as "本轮约 N tokens", so the meter must cover
    // only the projected turn: the session-wide event list would also sum every
    // earlier turn's messages and the label would grow with each follow-up.
    const usage = tokenUsageOf(turnEvents);
    return {
      sessionId: id,
      text:
        stripThinkBlock(stripInlineEnglishPreamble(stripEnglishPreamble(text))) ||
        'DSH 已完成本轮，但没有返回文本。',
      reasoning: reasoningTextOf(turnEvents),
      // Walk the complete event list, not the tail below: streaming chunks
      // push tool events out of any fixed window.
      toolTrail: toolTrailOf(turnEvents),
      events: turnEvents.slice(-50),
      ...(usage ? { usage } : {}),
    };
  } finally {
    options.signal?.removeEventListener('abort', cancelOnAbort);
    await handle.dispose();
  }
}
