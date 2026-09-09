import { Router, type Request, type Response } from 'express';
import {
  createSim2RealAgentPlan,
  type Sim2RealAgentPlan,
  type Sim2RealAgentRun,
  type Sim2RealAgentStep,
} from '../sim2real/sim2real-agent.js';

type AgentRequestExecutor = (request: Request, path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
const runs = new Map<string, Sim2RealAgentRun>();

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

async function executeWithRetry(execute: AgentRequestExecutor, request: Request, path: string, init?: RequestInit, attempts = 3) {
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
    const headers = new Headers(init.headers);
    const cookie = request.headers.cookie;
    if (cookie) headers.set('cookie', cookie);
    const authorization = request.headers.authorization;
    if (authorization) headers.set('authorization', authorization);
    headers.set('accept', 'application/json');
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 500) }; }
    return { status: response.status, body };
  };
}

export function createSim2RealAgentRouter(options: { execute?: AgentRequestExecutor } = {}) {
  const router = Router();
  const execute = options.execute ?? localExecutor();
  router.post('/api/sim2real/agent/plan', (request, response) => {
    const message = messageOf(request.body);
    if (!message) { response.status(400).json({ ok: false, error: 'SIM2REAL_AGENT_MESSAGE_REQUIRED', message: '请输入要完成的任务。' }); return; }
    const plan = createSim2RealAgentPlan(message, request.body?.context);
    response.json({ ok: true, plan });
  });
  router.post('/api/sim2real/agent/execute', (request, response) => {
    const plan = request.body?.plan as Sim2RealAgentPlan | undefined;
    if (!plan?.id || !Array.isArray(plan.steps)) { response.status(400).json({ ok: false, error: 'SIM2REAL_AGENT_PLAN_REQUIRED', message: '缺少有效的 Agent 计划。' }); return; }
    if (plan.steps.some((item) => item.requiresApproval && request.body?.approved !== true)) {
      response.status(409).json({ ok: false, error: 'SIM2REAL_AGENT_APPROVAL_REQUIRED', message: '该计划包含需要显式批准的动作。' }); return;
    }
    const run: Sim2RealAgentRun = { ...plan, status: 'queued', events: [], evidence: [], updatedAt: now() };
    runs.set(run.id, run);
    response.status(202).json({ ok: true, run });
    void runAgent(run, request, execute);
  });
  router.get('/api/sim2real/agent/runs/:id', (request, response) => {
    const run = runs.get(String(request.params.id));
    if (!run) { response.status(404).json({ ok: false, error: 'SIM2REAL_AGENT_RUN_NOT_FOUND' }); return; }
    response.json({ ok: true, run });
  });
  return router;
}

async function runAgent(run: Sim2RealAgentRun, request: Request, execute: AgentRequestExecutor): Promise<void> {
  run.status = 'running'; addEvent(run, 'plan', `已接收任务：${run.goal}`);
  let overview: any = null;
  try {
    for (const item of run.steps) {
      updateStep(run, item.id, 'running'); addEvent(run, 'tool_start', `${item.label} · ${item.tool}`);
      if (item.tool === 'workspace.overview') {
        const result = await execute(request, '/api/sim2real/overview'); overview = result.body;
        if (result.status >= 400) throw new Error(overview?.message || '工作区读取失败');
        run.evidence.push({ label: '模型/设备', value: `${overview.models?.length ?? 0} 个模型，${overview.devices?.length ?? 0} 块板卡` });
      } else if (item.tool === 'simulator.open') {
        const configuredEntry = overview?.integrations?.simulator?.browser?.entryUrl || overview?.integrations?.simulator?.entryUrl;
        const entryUrl = String(configuredEntry || (process.env.RDK_SIM2REAL_MICRODUCK_URL ? '/mujoco/microduck-proxy/' : '/mujoco/microduck/'));
        run.evidence.push({ label: '仿真入口', value: entryUrl, href: entryUrl });
      } else if (item.tool === 'training.gpu') {
        const modelId = String(overview?.models?.[0]?.id ?? 'builtin-microduck');
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
        const modelId = String(overview?.models?.[0]?.id ?? 'builtin-microduck');
        const deviceId = String(overview?.devices?.[0]?.id ?? '');
        if (!deviceId) throw new Error('当前没有可用目标板卡');
        const created = await execute(request, '/api/sim2real/deployments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `agent-deploy-${run.id}` }, body: JSON.stringify({ modelId, deviceId, mode: 'preflight' }) });
        if (created.status >= 400) throw new Error(created.body?.message || '部署计划创建失败');
        const deploymentId = created.body?.deployment?.id;
        const result = await execute(request, `/api/sim2real/deployments/${encodeURIComponent(deploymentId)}/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (result.status >= 400) throw new Error(result.body?.message || '只读预检失败');
        run.evidence.push({ label: '真机预检', value: result.body?.preflight?.passed ? '通过（未启用电机）' : '未通过' });
      } else if (item.tool === 'safety.gate') {
        run.evidence.push({ label: '动作安全门', value: 'drive disabled · live policy 未执行' });
      } else if (item.tool === 'board.stop') {
        await execute(request, '/api/sim2real/board-station/policy/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        await execute(request, '/api/sim2real/board-station/drive/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        run.evidence.push({ label: '停止确认', value: '策略与驱动停止请求已发送' });
      }
      updateStep(run, item.id, 'completed', '完成'); addEvent(run, 'tool_result', `${item.label} 完成`);
    }
    run.status = 'completed'; addEvent(run, 'message', '任务完成，证据已写入本次 Agent 运行。');
  } catch (error) {
    const current = run.steps.find((item) => item.status === 'running');
    if (current) updateStep(run, current.id, 'failed', error instanceof Error ? error.message : String(error));
    run.status = 'failed'; addEvent(run, 'message', error instanceof Error ? error.message : String(error));
  }
}
