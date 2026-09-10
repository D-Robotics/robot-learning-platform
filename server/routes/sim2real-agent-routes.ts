import { Router, type Request } from 'express';

import { LOCAL_SIM2REAL_AUTH, type Sim2RealAuthPort } from '../sim2real/sim2real-auth.js';
import {
  createSim2RealAgentPlan,
  type Sim2RealAgentPlan,
  type Sim2RealAgentRun,
  type Sim2RealAgentStep,
} from '../sim2real/sim2real-agent.js';

/**
 * Agent runs are conversation-scoped diagnostics, not ledger records: they
 * vanish on restart and live in a bounded map so a long-lived process cannot
 * grow without limit. Eviction only removes terminal runs; active runs finish
 * within minutes (training polling is capped) and become evictable then.
 */
const MAX_AGENT_RUNS = 200;
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
]);

type HeaderCarrier = { headers: Record<string, string | undefined> };
type AgentRequestInit = { method?: string; headers?: Record<string, string>; body?: string };
type AgentRequestExecutor = (
  request: HeaderCarrier,
  path: string,
  init?: AgentRequestInit,
) => Promise<{ status: number; body: any }>;

const runs = new Map<string, { run: Sim2RealAgentRun; owner?: string }>();

function now() { return new Date().toISOString(); }
function messageOf(body: unknown): string {
  return body && typeof body === 'object' && typeof (body as any).message === 'string' ? String((body as any).message).slice(0, 2_000) : '';
}
function updateStep(run: Sim2RealAgentRun, id: string, status: Sim2RealAgentStep['status'], detail?: string) {
  run.steps = run.steps.map((item) => item.id === id ? { ...item, status, ...(detail ? { detail } : {}) } : item);
  run.updatedAt = now();
}
function addEvent(run: Sim2RealAgentRun, type: Sim2RealAgentRun['events'][number]['type'], text: string) {
  run.events.push({ at: now(), type, text });
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
      authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
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
    if (entry.run.status === 'completed' || entry.run.status === 'failed' || entry.run.status === 'blocked') {
      runs.delete(id);
    }
  }
}

async function executeWithRetry(execute: AgentRequestExecutor, request: HeaderCarrier, path: string, init?: AgentRequestInit, attempts = 3) {
  let last: { status: number; body: any } | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await execute(request, path, init);
    if (last.status < 500) return last;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return last!;
}

function localExecutor(): AgentRequestExecutor {
  return async (request, path, init = {}) => {
    const port = Number(process.env.RDK_SIM2REAL_PORT ?? 18102);
    const headers: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) };
    if (request.headers.cookie) headers.cookie = request.headers.cookie;
    if (request.headers.authorization) headers.authorization = request.headers.authorization;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method, headers, body: init.body });
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 500) }; }
    return { status: response.status, body };
  };
}

export function createSim2RealAgentRouter(options: { execute?: AgentRequestExecutor; auth?: Sim2RealAuthPort } = {}) {
  const router = Router();
  const execute = options.execute ?? localExecutor();
  const auth = options.auth ?? LOCAL_SIM2REAL_AUTH;
  router.post('/api/sim2real/agent/plan', (request, response) => {
    const message = messageOf(request.body);
    if (!message) { response.status(400).json({ ok: false, error: 'SIM2REAL_AGENT_MESSAGE_REQUIRED', message: '请输入要完成的任务。' }); return; }
    const plan = createSim2RealAgentPlan(message, request.body?.context);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, plan });
  });
  router.post('/api/sim2real/agent/execute', (request, response) => {
    const owner = agentOwnerKey(request, auth);
    if (owner === null) {
      response.status(401).json({ ok: false, error: 'SIM2REAL_AUTH_REQUIRED', message: '共享部署需要已验证的账号会话。' });
      return;
    }
    const plan = request.body?.plan as Sim2RealAgentPlan | undefined;
    if (!plan?.id || !Array.isArray(plan.steps) || !plan.steps.length) { response.status(400).json({ ok: false, error: 'SIM2REAL_AGENT_PLAN_REQUIRED', message: '缺少有效的 Agent 计划。' }); return; }
    if (plan.steps.length > MAX_AGENT_PLAN_STEPS) { response.status(400).json({ ok: false, error: 'SIM2REAL_AGENT_PLAN_TOO_LARGE', message: `Agent 计划最多 ${MAX_AGENT_PLAN_STEPS} 步。` }); return; }
    if (plan.steps.some((item) => !item || typeof item !== 'object' || typeof item.tool !== 'string' || !KNOWN_TOOLS.has(item.tool))) {
      response.status(400).json({ ok: false, error: 'SIM2REAL_AGENT_PLAN_INVALID', message: '计划包含未知或不受支持的工具步骤。' });
      return;
    }
    if (plan.steps.some((item) => item.requiresApproval && request.body?.approved !== true)) {
      response.status(409).json({ ok: false, error: 'SIM2REAL_AGENT_APPROVAL_REQUIRED', message: '该计划包含需要显式批准的动作。' }); return;
    }
    const run: Sim2RealAgentRun = { ...plan, status: 'queued', events: [], evidence: [], updatedAt: now() };
    runs.set(run.id, { run, owner });
    pruneRuns();
    response.setHeader('Cache-Control', 'no-store');
    response.status(202).json({ ok: true, run });
    void runAgent(run, headerCarrier(request), execute);
  });
  router.get('/api/sim2real/agent/runs/:id', (request, response) => {
    const owner = agentOwnerKey(request, auth);
    if (owner === null) {
      response.status(401).json({ ok: false, error: 'SIM2REAL_AUTH_REQUIRED', message: '共享部署需要已验证的账号会话。' });
      return;
    }
    const entry = runs.get(String(request.params.id));
    // Same 404 for "missing" and "not yours": the id must not become an
    // oracle for which conversations exist.
    if (!entry || (owner !== undefined && entry.owner !== owner)) { response.status(404).json({ ok: false, error: 'SIM2REAL_AGENT_RUN_NOT_FOUND' }); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, run: entry.run });
  });
  return router;
}

/**
 * Prefer the model the caller pinned in the chat context; fail honestly when
 * it no longer exists instead of silently training a different model.
 */
function resolveAgentModelId(run: Sim2RealAgentRun, overview: any): string {
  const pinned = String(run.modelId ?? '').trim();
  if (pinned) {
    const found = (overview?.models ?? []).some((model: any) => model?.id === pinned);
    if (!found) throw new Error(`所选模型 ${pinned} 不在当前工作区，请重新选择后再执行。`);
    return pinned;
  }
  return String(overview?.models?.[0]?.id ?? 'builtin-microduck');
}

function resolveAgentDeviceId(run: Sim2RealAgentRun, overview: any): string {
  const pinned = String(run.deviceId ?? '').trim();
  if (pinned) {
    const found = (overview?.devices ?? []).some((device: any) => device?.id === pinned);
    if (!found) throw new Error(`所选板卡 ${pinned} 不在当前设备列表，请重新选择后再执行。`);
    return pinned;
  }
  return String(overview?.devices?.[0]?.id ?? '');
}

async function runAgent(run: Sim2RealAgentRun, request: HeaderCarrier, execute: AgentRequestExecutor): Promise<void> {  run.status = 'running'; addEvent(run, 'plan', `已接收任务：${run.goal}`);
  let overview: any = null;
  try {
    for (const item of run.steps) {
      updateStep(run, item.id, 'running'); addEvent(run, 'tool_start', `${item.label} · ${item.tool}`);
      let completionDetail: string | undefined;
      if (item.tool === 'workspace.overview') {
        const result = await execute(request, '/api/sim2real/overview'); overview = result.body;
        if (result.status >= 400) throw new Error(overview?.message || '工作区读取失败');
        run.evidence.push({ label: '模型/设备', value: `${overview.models?.length ?? 0} 个模型，${overview.devices?.length ?? 0} 块板卡` });
      } else if (item.tool === 'simulator.open') {
        const configuredEntry = overview?.integrations?.simulator?.browser?.entryUrl || overview?.integrations?.simulator?.entryUrl;
        const entryUrl = String(configuredEntry || (process.env.RDK_SIM2REAL_MICRODUCK_URL ? '/mujoco/microduck-proxy/' : '/mujoco/microduck/'));
        run.evidence.push({ label: '仿真入口', value: entryUrl, href: entryUrl });
      } else if (item.tool === 'training.gpu') {
        const modelId = resolveAgentModelId(run, overview);
        const result = await executeWithRetry(execute, request, '/api/sim2real/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `agent-${run.id}` }, body: JSON.stringify({ modelId, backend: 'local', taskId: 'walk', training: { profile: 'smoke' }, ...(run.computeResourceId ? { computeResourceId: run.computeResourceId } : {}) }) });
        if (result.status >= 400) throw new Error(result.body?.message || 'GPU 训练提交失败');
        const trainingRun = result.body?.run;
        let trainingStatus = String(trainingRun?.status ?? 'queued');
        if (trainingRun?.id && ['queued', 'running'].includes(trainingStatus)) {
          for (let attempt = 0; attempt < 30 && ['queued', 'running'].includes(trainingStatus); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const statusResult = await execute(request, `/api/sim2real/runs/${encodeURIComponent(trainingRun.id)}`);
            trainingStatus = String(statusResult.body?.run?.status ?? trainingStatus);
          }
        }
        run.evidence.push({ label: 'GPU 训练', value: `${trainingRun?.id ?? '已提交'} · ${trainingStatus}`, href: trainingRun?.id ? `#records/${trainingRun.id}` : undefined });
        if (['failed', 'blocked'].includes(trainingStatus)) throw new Error(`GPU 训练${trainingStatus === 'failed' ? '失败' : '被阻断'}`);
      } else if (item.tool === 'board.health') {
        const result = await executeWithRetry(execute, request, '/api/sim2real/board-station/health');
        if (result.status >= 400) throw new Error(result.body?.message || '板端健康检查失败');
        run.evidence.push({ label: 'X5 BoardAgent', value: result.body?.agent?.state ?? result.body?.status ?? 'connected' });
      } else if (item.tool === 'deployment.preflight') {
        const modelId = resolveAgentModelId(run, overview);
        const deviceId = resolveAgentDeviceId(run, overview);
        if (!deviceId) throw new Error('当前没有可用目标板卡');
        const created = await execute(request, '/api/sim2real/deployments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `agent-deploy-${run.id}` }, body: JSON.stringify({ modelId, deviceId, mode: 'preflight' }) });
        if (created.status >= 400) throw new Error(created.body?.message || '部署计划创建失败');
        const deploymentId = created.body?.deployment?.id;
        if (!deploymentId) throw new Error('部署计划创建未返回 ID');
        const result = await execute(request, `/api/sim2real/deployments/${encodeURIComponent(deploymentId)}/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const mockDrill = result.status >= 400 && (result.body?.error === 'SIM2REAL_PREFLIGHT_MOCK_ONLY' || result.body?.preflight?.mock === true);
        if (result.status >= 400 && !mockDrill) throw new Error(result.body?.message || '只读预检失败');
        const checks = result.body?.preflight?.checks ?? {};
        const checkSummary = Object.entries(checks).filter(([, value]) => value != null).slice(0, 4).map(([key, value]) => `${key}=${String(value).slice(0, 40)}`).join(' · ');
        run.evidence.push({ label: mockDrill ? '只读预检（演练）' : '真机预检', value: mockDrill ? `协议验证通过 · 模拟 BoardAgent，非真机证据${checkSummary ? `（${checkSummary}）` : ''}` : (result.body?.preflight?.passed ? '通过（未启用电机）' : '未通过'), href: `#deploy` });
        run.evidence.push({ label: '部署计划', value: `${deploymentId} · ${created.body?.deployment?.status ?? 'created'}` });
        if (mockDrill) completionDetail = '协议演练完成 · 证据标记为模拟';
      } else if (item.tool === 'evaluation.summarize') {
        const latest = (overview?.runs ?? []).find((candidate: any) => String(candidate.status ?? '') === 'completed') ?? (overview?.runs ?? [])[0];
        const runId = String(latest?.id ?? '');
        if (!runId) throw new Error('当前没有可汇总的训练运行');
        const evaluated = await execute(request, `/api/sim2real/runs/${encodeURIComponent(runId)}/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (evaluated.status >= 400) throw new Error(evaluated.body?.message || '评测执行失败');
        const metrics = evaluated.body?.run?.metrics ?? {};
        const replay = evaluated.body?.evaluation?.replay ?? {};
        const percent = (value: unknown) => Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '—';
        run.evidence.push({ label: '评测运行', value: `${runId} · ${latest?.modelId ?? '未知模型'}`, href: `#records/${runId}` });
        run.evidence.push({ label: '关键指标', value: `reward ${Number(metrics.reward ?? NaN).toFixed(2)} · 成功率 ${percent(metrics.successRate)} · 跌倒率 ${percent(metrics.fallRate)} · 迭代 ${metrics.iterations ?? '—'}` });
        run.evidence.push({ label: '遥测证据', value: `${replay.sampleCount ?? 0} 个样本 · ${replay.fallCount ?? 0} 次跌倒 · ${replay.doneCount ?? 0} 次结束` });
        const warnings = evaluated.body?.evaluation?.warnings ?? [];
        if (warnings.length) run.evidence.push({ label: '证据提示', value: String(warnings[0]).slice(0, 120) });
      } else if (item.tool === 'safety.gate') {
        run.evidence.push({ label: '动作安全门', value: 'drive disabled · live policy 未执行' });
      } else if (item.tool === 'board.stop') {
        await execute(request, '/api/sim2real/board-station/policy/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        await execute(request, '/api/sim2real/board-station/drive/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        run.evidence.push({ label: '停止确认', value: '策略与驱动停止请求已发送' });
      }
      updateStep(run, item.id, 'completed', completionDetail ?? '完成'); addEvent(run, 'tool_result', `${item.label} 完成`);
    }
    run.status = 'completed'; addEvent(run, 'message', '任务完成，证据已写入本次 Agent 运行。');
  } catch (error) {
    const current = run.steps.find((item) => item.status === 'running');
    if (current) updateStep(run, current.id, 'failed', error instanceof Error ? error.message : String(error));
    run.status = 'failed'; addEvent(run, 'message', error instanceof Error ? error.message : String(error));
  } finally {
    // Runs reach terminal status asynchronously, long after their entry was
    // inserted. Sweeping at settle time (not just insert time) is what keeps
    // the map bounded when many runs finish in a burst.
    pruneRuns();
  }
}
