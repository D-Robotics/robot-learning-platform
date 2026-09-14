import { Router, type Request } from 'express';

import { LOCAL_SIM2REAL_AUTH, type Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import {
  createSim2RealAgentPlan,
  type Sim2RealAgentPlan,
  type Sim2RealAgentRun,
  type Sim2RealAgentStep,
} from '../sim2real/sim2real-agent.js';
import { principalCan, SIM2REAL_PERMISSIONS } from '../sim2real/sim2real-rbac.js';

/**
 * Agent runs are conversation-scoped diagnostics, not ledger records: they
 * vanish on restart and live in a bounded map so a long-lived process cannot
 * grow without limit. Eviction only removes terminal runs; active runs finish
 * within minutes (training polling is capped) and become evictable then.
 */
const MAX_AGENT_RUNS = 200;
/** Keep asynchronous Agent work bounded even when callers never poll/finish. */
export const MAX_ACTIVE_AGENT_RUNS_TOTAL = 200;
export const MAX_ACTIVE_AGENT_RUNS_PER_OWNER = 32;
/** The planner emits at most 6 steps; allow headroom, reject crafted floods. */
const MAX_AGENT_PLAN_STEPS = 12;
/**
 * Only planner-known tools are executable. A client-crafted plan carrying any
 * other tool id is rejected up front instead of executing nothing and then
 * reporting the step as completed.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'workspace.overview',
  'simulator.open',
  'training.gpu',
  'board.health',
  'deployment.preflight',
  'safety.gate',
  'evaluation.summarize',
  'board.stop',
  'conversation.reply',
]);

// Approval is a server-side property of a tool, never a client-controlled
// boolean on an arbitrary plan. These operations create durable evidence or
// contact a runner, so an execute request must carry the explicit approval
// flag even if a crafted plan omits/changes `requiresApproval`.
const APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  'training.gpu',
  'evaluation.summarize',
  'deployment.preflight',
]);

const AGENT_INTENTS: ReadonlySet<string> = new Set([
  'conversation',
  'full-loop',
  'gpu-train',
  'board-check',
  'deploy-preflight',
  'simulate',
  'evaluation',
  'stop',
]);
const AGENT_SAFETY: ReadonlySet<string> = new Set(['read-only', 'compute', 'guarded']);
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type HeaderCarrier = { headers: Record<string, string | undefined> };
type AgentRequestInit = { method?: string; headers?: Record<string, string>; body?: string };

/**
 * The Agent router calls the standalone service through a loopback HTTP hop.
 * Keep that hop bounded even when the downstream route is wedged or returns a
 * response that is much larger than the small envelopes Agent actually reads.
 * The environment override is deliberately narrow: a typo falls back to the
 * safe default instead of disabling the timeout altogether.
 */
export const SIM2REAL_AGENT_EXECUTOR_TIMEOUT_ENV =
  'RDK_SIM2REAL_AGENT_EXECUTOR_TIMEOUT_MS' as const;
export const SIM2REAL_AGENT_EXECUTOR_DEFAULT_TIMEOUT_MS = 15_000;
export const SIM2REAL_AGENT_EXECUTOR_MIN_TIMEOUT_MS = 1_000;
export const SIM2REAL_AGENT_EXECUTOR_MAX_TIMEOUT_MS = 60_000;
export const SIM2REAL_AGENT_RESPONSE_MAX_BYTES = 256 * 1024;
export const SIM2REAL_AGENT_EXECUTOR_TIMEOUT_ERROR = 'sim2real_agent_executor_timeout';
export const SIM2REAL_AGENT_EXECUTOR_UNAVAILABLE_ERROR = 'sim2real_agent_executor_unavailable';
export const SIM2REAL_AGENT_RESPONSE_TOO_LARGE_ERROR = 'sim2real_agent_response_too_large';
export const SIM2REAL_AGENT_RESPONSE_INVALID_ERROR = 'sim2real_agent_response_invalid';

export function resolveSim2RealAgentExecutorTimeout(
  raw: unknown = process.env[SIM2REAL_AGENT_EXECUTOR_TIMEOUT_ENV],
): number {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return SIM2REAL_AGENT_EXECUTOR_DEFAULT_TIMEOUT_MS;
  const value = Number(text);
  return Number.isSafeInteger(value) &&
    value >= SIM2REAL_AGENT_EXECUTOR_MIN_TIMEOUT_MS &&
    value <= SIM2REAL_AGENT_EXECUTOR_MAX_TIMEOUT_MS
    ? value
    : SIM2REAL_AGENT_EXECUTOR_DEFAULT_TIMEOUT_MS;
}

async function cancelAgentResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed by the fetch implementation. The caller
    // still receives the stable boundary error below.
  }
}

/**
 * Loose envelope for the loopback JSON this router reads. Fields are optional
 * and typed to the shape each consumer expects: that documents the contract and
 * catches typos, while the `?? fallback` / `String(...)` at every call site
 * keeps a malformed upstream payload from being trusted verbatim — which is
 * exactly what a bare `any` used to allow.
 */
interface AgentPayload {
  ok?: boolean;
  message?: string;
  error?: string;
  status?: string;
  agent?: { state?: string; [key: string]: unknown };
  run?: { id?: string; status?: string; metrics?: Record<string, unknown>; [key: string]: unknown };
  evaluation?: {
    replay?: Record<string, unknown>;
    warnings?: unknown[];
    [key: string]: unknown;
  };
  deployment?: { id?: string; status?: string; [key: string]: unknown };
  preflight?: {
    mock?: boolean;
    passed?: boolean;
    checks?: Record<string, unknown>;
    [key: string]: unknown;
  };
  models?: { id?: string; [key: string]: unknown }[];
  devices?: { id?: string; [key: string]: unknown }[];
  runs?: { id?: string; status?: string; modelId?: string; [key: string]: unknown }[];
  integrations?: {
    simulator?: {
      entryUrl?: string;
      browser?: { entryUrl?: string; [key: string]: unknown };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

type AgentRequestExecutor = (
  request: HeaderCarrier,
  path: string,
  init?: AgentRequestInit,
) => Promise<{ status: number; body: AgentPayload }>;

const runs = new Map<string, { run: Sim2RealAgentRun; owner?: string }>();

function now() {
  return new Date().toISOString();
}
function messageOf(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const message = (body as AgentPayload).message;
  return typeof message === 'string' ? message.slice(0, 2_000) : '';
}

function safeAgentText(value: unknown, fallback: string, max = 500): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return (text || fallback).slice(0, max);
}

type NormalizedAgentPlan = Sim2RealAgentPlan;

/** Validate the plan envelope and derive all executable step metadata server-side. */
function normalizeAgentPlan(
  value: unknown,
): { plan: NormalizedAgentPlan; approvalRequired: boolean } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '缺少有效的 Agent 计划。' };
  }
  const source = value as Record<string, unknown>;
  const id = String(source.id ?? '').trim();
  if (!SAFE_AGENT_ID.test(id)) return { error: 'Agent 计划 ID 格式无效。' };
  const rawSteps = source.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.length || rawSteps.length > MAX_AGENT_PLAN_STEPS) {
    return { error: `Agent 计划最多 ${MAX_AGENT_PLAN_STEPS} 步且至少包含一步。` };
  }
  const seen = new Set<string>();
  const steps: Sim2RealAgentStep[] = [];
  for (let index = 0; index < rawSteps.length; index += 1) {
    const item = rawSteps[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: '计划包含无效步骤。' };
    }
    const candidate = item as Record<string, unknown>;
    const tool = String(candidate.tool ?? '').trim();
    if (!KNOWN_TOOLS.has(tool)) return { error: '计划包含未知或不受支持的工具步骤。' };
    const stepId = String(candidate.id ?? `step-${index + 1}`).trim();
    if (!SAFE_AGENT_ID.test(stepId) || seen.has(stepId)) {
      return { error: '计划步骤 ID 无效或重复。' };
    }
    seen.add(stepId);
    const requiresApproval = APPROVAL_TOOLS.has(tool);
    steps.push({
      id: stepId,
      label: safeAgentText(candidate.label, tool, 180),
      tool,
      status: 'pending',
      ...(requiresApproval ? { requiresApproval: true } : {}),
    });
  }
  const intent = String(source.intent ?? 'conversation').trim();
  const safety = String(source.safety ?? 'read-only').trim();
  if (!AGENT_INTENTS.has(intent) || !AGENT_SAFETY.has(safety)) {
    return { error: '计划的 intent 或 safety 字段无效。' };
  }
  const optionalId = (key: string): { value?: string; invalid?: boolean } => {
    const candidate = String(source[key] ?? '').trim();
    if (!candidate) return {};
    return SAFE_AGENT_ID.test(candidate) ? { value: candidate } : { invalid: true };
  };
  const modelId = optionalId('modelId');
  const deviceId = optionalId('deviceId');
  const computeResourceId = optionalId('computeResourceId');
  if (modelId.invalid || deviceId.invalid || computeResourceId.invalid) {
    return { error: '计划中的模型、设备或计算资源 ID 格式无效。' };
  }
  const plan: Sim2RealAgentPlan = {
    id,
    intent: intent as Sim2RealAgentPlan['intent'],
    goal: safeAgentText(source.goal, '执行受控 Agent 任务。'),
    safety: safety as Sim2RealAgentPlan['safety'],
    steps,
    rationale: safeAgentText(source.rationale, '按依赖顺序执行受控工具。'),
    ...(modelId.value ? { modelId: modelId.value } : {}),
    ...(deviceId.value ? { deviceId: deviceId.value } : {}),
    ...(computeResourceId.value ? { computeResourceId: computeResourceId.value } : {}),
    createdAt: new Date().toISOString(),
  };
  return { plan, approvalRequired: steps.some((step) => APPROVAL_TOOLS.has(step.tool)) };
}
function updateStep(
  run: Sim2RealAgentRun,
  id: string,
  status: Sim2RealAgentStep['status'],
  detail?: string,
) {
  const safeDetail = detail ? safeAgentText(detail, '执行未完成。', 500) : undefined;
  run.steps = run.steps.map((item) =>
    item.id === id ? { ...item, status, ...(safeDetail ? { detail: safeDetail } : {}) } : item,
  );
  run.updatedAt = now();
}

const MAX_AGENT_EVIDENCE_ITEMS = 64;

function safeAgentHref(value: unknown): string | undefined {
  const text = safeAgentText(value, '', 500);
  if (!text) return undefined;
  return /^(?:#|\/(?!\/)|https:\/\/)/i.test(text) ? text : undefined;
}

/** Add a bounded, terminal-safe evidence record at the conversation boundary. */
function addEvidence(run: Sim2RealAgentRun, label: unknown, value: unknown, href?: unknown): void {
  if (run.evidence.length >= MAX_AGENT_EVIDENCE_ITEMS) return;
  const hrefValue = safeAgentHref(href);
  run.evidence.push({
    label: safeAgentText(label, '证据', 120),
    value: safeAgentText(value, '—', 500),
    ...(hrefValue ? { href: hrefValue } : {}),
  });
}

function addEvent(
  run: Sim2RealAgentRun,
  type: Sim2RealAgentRun['events'][number]['type'],
  text: string,
) {
  run.events.push({ at: now(), type, text: safeAgentText(text, 'Agent 事件', 1_000) });
  run.updatedAt = now();
}

/**
 * Snapshot only the credentials the loopback executor needs instead of
 * retaining the whole Express request (and its socket buffers) for the
 * lifetime of the run record.
 */
function headerCarrier(request: Request): HeaderCarrier {
  return {
    headers: {
      cookie: typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
      authorization:
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
    },
  };
}

/**
 * Owner scope mirrors the rest of the platform: single-user deployments share
 * the registry; shared deployments fail closed without a verified principal,
 * and one account can never read another account's conversation evidence.
 */
function agentOwnerKey(request: Request, auth: Sim2RealAuthPort): string | undefined | null {
  if (!auth.isMultiUserDeployment()) return undefined;
  const id = String(auth.resolvePrincipal(request)?.accountId ?? '').trim();
  if (!id) return null;
  if (!/^[^\u0000-\u001f\u007f/]{1,160}$/.test(id)) return null;
  return id;
}

function pruneRuns(): void {
  if (runs.size <= MAX_AGENT_RUNS) return;
  // Map iteration follows insertion order, so the oldest terminal runs go
  // first; an active run is never evicted mid-flight.
  for (const [id, entry] of runs) {
    if (runs.size <= MAX_AGENT_RUNS) break;
    if (
      entry.run.status === 'completed' ||
      entry.run.status === 'failed' ||
      entry.run.status === 'blocked'
    ) {
      runs.delete(id);
    }
  }
}

function activeAgentRuns(owner: string | undefined): { total: number; owner: number } {
  let total = 0;
  let scoped = 0;
  for (const entry of runs.values()) {
    if (entry.run.status !== 'queued' && entry.run.status !== 'running') continue;
    total += 1;
    if (entry.owner === owner) scoped += 1;
  }
  return { total, owner: scoped };
}

async function executeWithRetry(
  execute: AgentRequestExecutor,
  request: HeaderCarrier,
  path: string,
  init?: AgentRequestInit,
  attempts = 3,
) {
  let last: { status: number; body: AgentPayload } | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await execute(request, path, init);
    if (last.status < 500) return last;
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return last!;
}

/** Read one loopback response without buffering an unbounded body. */
export async function readSim2RealAgentResponseText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > SIM2REAL_AGENT_RESPONSE_MAX_BYTES) {
      await cancelAgentResponse(response);
      throw new Error(SIM2REAL_AGENT_RESPONSE_TOO_LARGE_ERROR);
    }
  }
  // A standard Fetch Response with a null body is an empty response. Keep the
  // text() fallback for lightweight fetch shims, but apply the same byte cap
  // after decoding so a custom adapter cannot bypass the limit.
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > SIM2REAL_AGENT_RESPONSE_MAX_BYTES) {
      throw new Error(SIM2REAL_AGENT_RESPONSE_TOO_LARGE_ERROR);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > SIM2REAL_AGENT_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(SIM2REAL_AGENT_RESPONSE_TOO_LARGE_ERROR);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export type Sim2RealAgentLocalExecutorOptions = {
  fetchImpl?: typeof fetch;
  port?: number;
  /** Test/deployment override; values outside the safe range use the default. */
  timeoutMs?: unknown;
};

function agentExecutorPort(raw: unknown): number {
  const value = Number(raw ?? process.env.RDK_SIM2REAL_PORT ?? 18_102);
  return Number.isInteger(value) && value >= 1_024 && value <= 65_535 ? value : 18_102;
}

function parsedAgentPayload(text: string): AgentPayload {
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never copy an upstream body into the Agent run event. It may contain
    // credentials or a proxy-generated HTML page; callers only need a stable
    // protocol error to decide whether to retry.
    throw new Error(SIM2REAL_AGENT_RESPONSE_INVALID_ERROR);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // A successful HTTP status with an HTML page, scalar, or array is still a
    // protocol failure. Treating it as `{}` used to let orchestration continue
    // with empty model/device lists and potentially select a fallback target.
    throw new Error(SIM2REAL_AGENT_RESPONSE_INVALID_ERROR);
  }
  return parsed as AgentPayload;
}

/**
 * Keep machine-readable hints needed by the orchestration path while dropping
 * free-form upstream error text. A local route may be fronted by a proxy that
 * returns HTML or credentials in `message`; that content must never become a
 * conversation-scoped Agent event.
 */
function scrubAgentErrorPayload(body: AgentPayload): AgentPayload {
  // This is the only non-2xx code the orchestration path interprets. Keep the
  // allow-list exact so an upstream can never smuggle a credential-looking
  // string through an otherwise "code-shaped" error field.
  const mockOnly = body.error === 'SIM2REAL_PREFLIGHT_MOCK_ONLY';
  return {
    ...(mockOnly ? { error: 'SIM2REAL_PREFLIGHT_MOCK_ONLY' } : {}),
    ...(body.preflight?.mock === true ? { preflight: { mock: true } } : {}),
  };
}

/**
 * Build the default in-process Agent executor with a bounded timeout and body.
 * Keeping the fetch implementation injectable makes the boundary directly
 * testable without opening a second HTTP server.
 */
export function createSim2RealAgentLocalExecutor(
  options: Sim2RealAgentLocalExecutorOptions = {},
): AgentRequestExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = resolveSim2RealAgentExecutorTimeout(options.timeoutMs);
  const port = agentExecutorPort(options.port);
  return async (request, path, init = {}) => {
    const headers: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) };
    if (request.headers.cookie) headers.cookie = request.headers.cookie;
    if (request.headers.authorization) headers.authorization = request.headers.authorization;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        redirect: 'error',
        signal,
      });
      const payload = parsedAgentPayload(await readSim2RealAgentResponseText(response));
      return {
        status: response.status,
        body: response.status >= 400 ? scrubAgentErrorPayload(payload) : payload,
      };
    } catch (error) {
      if (error instanceof Error && error.message === SIM2REAL_AGENT_RESPONSE_TOO_LARGE_ERROR) {
        throw error;
      }
      if (error instanceof Error && error.message === SIM2REAL_AGENT_RESPONSE_INVALID_ERROR) {
        throw error;
      }
      if (signal.aborted) throw new Error(SIM2REAL_AGENT_EXECUTOR_TIMEOUT_ERROR);
      // Transport and redirect failures intentionally collapse to one stable
      // message. Never expose a fetch error or upstream response body in the
      // conversation-scoped Agent record.
      throw new Error(SIM2REAL_AGENT_EXECUTOR_UNAVAILABLE_ERROR);
    }
  };
}

function localExecutor(): AgentRequestExecutor {
  return createSim2RealAgentLocalExecutor();
}

export function createSim2RealAgentRouter(
  options: { execute?: AgentRequestExecutor; auth?: Sim2RealAuthPort } = {},
) {
  const router = Router();
  const execute = options.execute ?? localExecutor();
  const auth = options.auth ?? LOCAL_SIM2REAL_AUTH;
  router.post('/api/sim2real/agent/plan', (request, response) => {
    const message = messageOf(request.body);
    if (!message) {
      response.status(400).json({
        ok: false,
        error: 'SIM2REAL_AGENT_MESSAGE_REQUIRED',
        message: '请输入要完成的任务。',
      });
      return;
    }
    const plan = createSim2RealAgentPlan(message, request.body?.context);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, plan });
  });
  router.post('/api/sim2real/agent/execute', (request, response) => {
    const owner = agentOwnerKey(request, auth);
    if (owner === null) {
      response.status(401).json({
        ok: false,
        error: 'SIM2REAL_AUTH_REQUIRED',
        message: '共享部署需要已验证的账号会话。',
      });
      return;
    }
    const principal = auth.resolvePrincipal(request);
    if (auth.isMultiUserDeployment() && !principalCan(principal, SIM2REAL_PERMISSIONS.agent)) {
      response.status(403).json({
        ok: false,
        error: 'SIM2REAL_PERMISSION_DENIED',
        code: 'SIM2REAL_PERMISSION_DENIED',
        message: '当前账号没有执行 Agent 操作的权限。',
        retryable: false,
      });
      return;
    }
    const normalized = normalizeAgentPlan(request.body?.plan);
    if ('error' in normalized) {
      response.status(400).json({
        ok: false,
        error: 'SIM2REAL_AGENT_PLAN_INVALID',
        message: normalized.error,
      });
      return;
    }
    const { plan, approvalRequired } = normalized;
    if (approvalRequired && request.body?.approved !== true) {
      response.status(409).json({
        ok: false,
        error: 'SIM2REAL_AGENT_APPROVAL_REQUIRED',
        message: '该计划包含需要显式批准的动作。',
      });
      return;
    }
    // A plan id is the agent's durable client-side idempotency key. Retries
    // happen frequently when the browser loses the polling connection; never
    // start a second training/deployment side effect for the same plan. Keep
    // the response shape stable and return a generic 404 for a cross-account
    // collision so the id cannot be used as a run-existence oracle.
    const existing = runs.get(plan.id);
    if (existing) {
      if (existing.owner !== owner) {
        response.status(404).json({ ok: false, error: 'SIM2REAL_AGENT_RUN_NOT_FOUND' });
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      response.status(202).json({ ok: true, run: existing.run, duplicate: true });
      return;
    }
    const active = activeAgentRuns(owner);
    if (
      active.total >= MAX_ACTIVE_AGENT_RUNS_TOTAL ||
      active.owner >= MAX_ACTIVE_AGENT_RUNS_PER_OWNER
    ) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Retry-After', '30');
      response.status(429).json({
        ok: false,
        error: 'SIM2REAL_AGENT_ACTIVE_QUOTA',
        code: 'SIM2REAL_AGENT_ACTIVE_QUOTA',
        message: '当前 Agent 已有过多排队或运行中的任务，请等待完成后再试。',
        retryable: true,
        retryAfterSeconds: 30,
      });
      return;
    }
    const run: Sim2RealAgentRun = {
      ...plan,
      status: 'queued',
      events: [],
      evidence: [],
      updatedAt: now(),
    };
    runs.set(run.id, { run, owner });
    pruneRuns();
    response.setHeader('Cache-Control', 'no-store');
    response.status(202).json({ ok: true, run });
    void runAgent(run, headerCarrier(request), execute);
  });
  router.get('/api/sim2real/agent/runs/:id', (request, response) => {
    const owner = agentOwnerKey(request, auth);
    if (owner === null) {
      response.status(401).json({
        ok: false,
        error: 'SIM2REAL_AUTH_REQUIRED',
        message: '共享部署需要已验证的账号会话。',
      });
      return;
    }
    const entry = runs.get(String(request.params.id));
    // Same 404 for "missing" and "not yours": the id must not become an
    // oracle for which conversations exist.
    if (!entry || (owner !== undefined && entry.owner !== owner)) {
      response.status(404).json({ ok: false, error: 'SIM2REAL_AGENT_RUN_NOT_FOUND' });
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, run: entry.run });
  });
  return router;
}

/**
 * Prefer the model the caller pinned in the chat context; fail honestly when
 * it no longer exists instead of silently training a different model.
 */
function resolveAgentModelId(run: Sim2RealAgentRun, overview: AgentPayload): string {
  const pinned = String(run.modelId ?? '').trim();
  if (pinned) {
    const found = (overview?.models ?? []).some((model) => model?.id === pinned);
    if (!found) throw new Error(`所选模型 ${pinned} 不在当前工作区，请重新选择后再执行。`);
    return pinned;
  }
  return String(overview?.models?.[0]?.id ?? 'builtin-microduck');
}

function resolveAgentDeviceId(run: Sim2RealAgentRun, overview: AgentPayload): string {
  const pinned = String(run.deviceId ?? '').trim();
  if (pinned) {
    const found = (overview?.devices ?? []).some((device) => device?.id === pinned);
    if (!found) throw new Error(`所选板卡 ${pinned} 不在当前设备列表，请重新选择后再执行。`);
    return pinned;
  }
  return String(overview?.devices?.[0]?.id ?? '');
}

const AGENT_TRAINING_IN_FLIGHT = new Set(['queued', 'running']);
const AGENT_TRAINING_TERMINAL = new Set(['completed', 'failed', 'blocked']);

function normalizedTrainingStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 32) : '';
}

function trainingRunId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return SAFE_AGENT_ID.test(id) ? id : null;
}

async function runAgent(
  run: Sim2RealAgentRun,
  request: HeaderCarrier,
  execute: AgentRequestExecutor,
): Promise<void> {
  run.status = 'running';
  addEvent(run, 'plan', `已接收任务：${run.goal}`);
  let overview: AgentPayload = {};
  try {
    for (const item of run.steps) {
      updateStep(run, item.id, 'running');
      addEvent(run, 'tool_start', `${item.label} · ${item.tool}`);
      let completionDetail: string | undefined;
      if (item.tool === 'workspace.overview') {
        const result = await execute(request, '/api/sim2real/overview');
        overview = result.body;
        if (result.status >= 400)
          throw new Error(safeAgentText(overview?.message, '工作区读取失败'));
        addEvidence(
          run,
          '模型/设备',
          `${overview.models?.length ?? 0} 个模型，${overview.devices?.length ?? 0} 块板卡`,
        );
      } else if (item.tool === 'simulator.open') {
        const configuredEntry =
          overview?.integrations?.simulator?.browser?.entryUrl ||
          overview?.integrations?.simulator?.entryUrl;
        const entryUrl = String(
          configuredEntry ||
            (process.env.RDK_SIM2REAL_MICRODUCK_URL
              ? '/mujoco/microduck-proxy/'
              : '/mujoco/microduck/'),
        );
        addEvidence(run, '仿真入口', entryUrl, entryUrl);
      } else if (item.tool === 'conversation.reply') {
        addEvidence(
          run,
          'Agent',
          '你好！我可以帮你检查工作区、启动仿真、提交训练，或检查已连接的板端。',
        );
        completionDetail = '已回复';
      } else if (item.tool === 'training.gpu') {
        const modelId = resolveAgentModelId(run, overview);
        const result = await executeWithRetry(execute, request, '/api/sim2real/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `agent-${run.id}` },
          body: JSON.stringify({
            modelId,
            backend: 'local',
            taskId: 'walk',
            training: { profile: 'smoke' },
            ...(run.computeResourceId ? { computeResourceId: run.computeResourceId } : {}),
          }),
        });
        if (result.status >= 400)
          throw new Error(safeAgentText(result.body?.message, 'GPU 训练提交失败'));
        const trainingRun = result.body?.run;
        if (!trainingRun || typeof trainingRun !== 'object' || Array.isArray(trainingRun)) {
          throw new Error('GPU 训练提交未返回有效运行记录');
        }
        const runId = trainingRunId(trainingRun.id);
        if (!runId) throw new Error('GPU 训练提交未返回有效运行 ID');
        let trainingStatus = normalizedTrainingStatus(trainingRun.status);
        if (
          !AGENT_TRAINING_IN_FLIGHT.has(trainingStatus) &&
          !AGENT_TRAINING_TERMINAL.has(trainingStatus)
        ) {
          throw new Error('GPU 训练返回了未知状态');
        }
        if (AGENT_TRAINING_IN_FLIGHT.has(trainingStatus)) {
          for (
            let attempt = 0;
            attempt < 30 && AGENT_TRAINING_IN_FLIGHT.has(trainingStatus);
            attempt += 1
          ) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const statusResult = await execute(
              request,
              `/api/sim2real/runs/${encodeURIComponent(runId)}`,
            );
            if (statusResult.status >= 400)
              throw new Error('GPU 训练状态查询失败，无法确认任务结果');
            const polledRun = statusResult.body?.run;
            if (!polledRun || typeof polledRun !== 'object' || Array.isArray(polledRun)) {
              throw new Error('GPU 训练状态响应无效，无法确认任务结果');
            }
            const nextStatus = normalizedTrainingStatus(polledRun.status);
            if (
              !AGENT_TRAINING_IN_FLIGHT.has(nextStatus) &&
              !AGENT_TRAINING_TERMINAL.has(nextStatus)
            ) {
              throw new Error('GPU 训练状态响应未知，无法确认任务结果');
            }
            trainingStatus = nextStatus;
          }
        }
        addEvidence(run, 'GPU 训练', `${runId} · ${trainingStatus}`, `#records/${runId}`);
        if (trainingStatus === 'failed' || trainingStatus === 'blocked')
          throw new Error(`GPU 训练${trainingStatus === 'failed' ? '失败' : '被阻断'}`);
        if (AGENT_TRAINING_IN_FLIGHT.has(trainingStatus))
          throw new Error('GPU 训练状态轮询超时，结果尚未确认');
      } else if (item.tool === 'board.health') {
        const result = await executeWithRetry(
          execute,
          request,
          '/api/sim2real/board-station/health',
        );
        if (result.status >= 400)
          throw new Error(safeAgentText(result.body?.message, '板端健康检查失败'));
        addEvidence(
          run,
          'X5 BoardAgent',
          result.body?.agent?.state ?? result.body?.status ?? 'connected',
        );
      } else if (item.tool === 'deployment.preflight') {
        const modelId = resolveAgentModelId(run, overview);
        const deviceId = resolveAgentDeviceId(run, overview);
        if (!deviceId) throw new Error('当前没有可用目标板卡');
        const created = await execute(request, '/api/sim2real/deployments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `agent-deploy-${run.id}`,
          },
          body: JSON.stringify({ modelId, deviceId, mode: 'preflight' }),
        });
        if (created.status >= 400)
          throw new Error(safeAgentText(created.body?.message, '部署计划创建失败'));
        const deploymentId = created.body?.deployment?.id;
        if (!deploymentId) throw new Error('部署计划创建未返回 ID');
        const result = await execute(
          request,
          `/api/sim2real/deployments/${encodeURIComponent(deploymentId)}/preflight`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        );
        const mockDrill =
          result.status >= 400 &&
          (result.body?.error === 'SIM2REAL_PREFLIGHT_MOCK_ONLY' ||
            result.body?.preflight?.mock === true);
        if (result.status >= 400 && !mockDrill)
          throw new Error(safeAgentText(result.body?.message, '只读预检失败'));
        const checks = result.body?.preflight?.checks ?? {};
        const checkSummary = Object.entries(checks)
          .filter(([, value]) => value != null)
          .slice(0, 4)
          .map(([key, value]) => `${key}=${String(value).slice(0, 40)}`)
          .join(' · ');
        addEvidence(
          run,
          mockDrill ? '只读预检（演练）' : '真机预检',
          mockDrill
            ? `协议验证通过 · 模拟 BoardAgent，非真机证据${checkSummary ? `（${checkSummary}）` : ''}`
            : result.body?.preflight?.passed
              ? '通过（未启用电机）'
              : '未通过',
          '#deploy',
        );
        addEvidence(
          run,
          '部署计划',
          `${deploymentId} · ${created.body?.deployment?.status ?? 'created'}`,
        );
        if (mockDrill) completionDetail = '协议演练完成 · 证据标记为模拟';
      } else if (item.tool === 'evaluation.summarize') {
        const latest =
          (overview?.runs ?? []).find(
            (candidate) => String(candidate.status ?? '') === 'completed',
          ) ?? (overview?.runs ?? [])[0];
        const runId = String(latest?.id ?? '');
        if (!runId) throw new Error('当前没有可汇总的训练运行');
        const evaluated = await execute(
          request,
          `/api/sim2real/runs/${encodeURIComponent(runId)}/evaluate`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        );
        if (evaluated.status >= 400)
          throw new Error(safeAgentText(evaluated.body?.message, '评测执行失败'));
        const metrics = evaluated.body?.run?.metrics ?? {};
        const replay = evaluated.body?.evaluation?.replay ?? {};
        const percent = (value: unknown) =>
          Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '—';
        addEvidence(
          run,
          '评测运行',
          `${runId} · ${latest?.modelId ?? '未知模型'}`,
          `#records/${runId}`,
        );
        addEvidence(
          run,
          '关键指标',
          `reward ${Number(metrics.reward ?? NaN).toFixed(2)} · 成功率 ${percent(metrics.successRate)} · 跌倒率 ${percent(metrics.fallRate)} · 迭代 ${metrics.iterations ?? '—'}`,
        );
        addEvidence(
          run,
          '遥测证据',
          `${replay.sampleCount ?? 0} 个样本 · ${replay.fallCount ?? 0} 次跌倒 · ${replay.doneCount ?? 0} 次结束`,
        );
        const warnings = evaluated.body?.evaluation?.warnings ?? [];
        if (warnings.length) addEvidence(run, '证据提示', warnings[0]);
      } else if (item.tool === 'safety.gate') {
        addEvidence(run, '动作安全门', 'drive disabled · live policy 未执行');
      } else if (item.tool === 'board.stop') {
        let policyStop: Awaited<ReturnType<AgentRequestExecutor>> | null = null;
        let driveStop: Awaited<ReturnType<AgentRequestExecutor>> | null = null;
        try {
          policyStop = await execute(request, '/api/sim2real/board-station/policy/stop', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
        } catch {
          // Always attempt the independent emergency drive stop below.
        }
        try {
          driveStop = await execute(request, '/api/sim2real/board-station/drive/stop', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
        } catch {
          // The fixed failure below records that the safety state is unknown.
        }
        if (
          !policyStop ||
          !driveStop ||
          policyStop.status < 200 ||
          policyStop.status >= 300 ||
          driveStop.status < 200 ||
          driveStop.status >= 300 ||
          policyStop.body?.ok === false ||
          driveStop.body?.ok === false
        ) {
          throw new Error('停止命令未能同时确认策略与驱动状态');
        }
        addEvidence(run, '停止确认', '策略与驱动停止请求均已确认');
      }
      updateStep(run, item.id, 'completed', completionDetail ?? '完成');
      addEvent(run, 'tool_result', `${item.label} 完成`);
    }
    run.status = 'completed';
    addEvent(run, 'message', '任务完成，证据已写入本次 Agent 运行。');
  } catch (error) {
    const current = run.steps.find((item) => item.status === 'running');
    const detail = safeAgentText(error instanceof Error ? error.message : error, 'Agent 执行失败');
    if (current) updateStep(run, current.id, 'failed', detail);
    run.status = 'failed';
    addEvent(run, 'message', detail);
  } finally {
    // Runs reach terminal status asynchronously, long after their entry was
    // inserted. Sweeping at settle time (not just insert time) is what keeps
    // the map bounded when many runs finish in a burst.
    pruneRuns();
  }
}
