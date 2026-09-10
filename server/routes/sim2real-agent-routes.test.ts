import { describe, expect, it, vi } from 'vitest';
import { createSim2RealAgentRouter } from './sim2real-agent-routes.js';
import { classifySim2RealAgentIntent, createSim2RealAgentPlan } from '../sim2real/sim2real-agent.js';

describe('Sim2Real Agent planner', () => {
  it('turns a natural-language full loop request into guarded tools', () => {
    const plan = createSim2RealAgentPlan('完成仿真、GPU训练、检查X5并做真机预检', { modelId: 'm1', deviceId: 'd1' });
    expect(plan.intent).toBe('full-loop');
    expect(plan.steps.map((item) => item.tool)).toEqual([
      'workspace.overview', 'simulator.open', 'training.gpu', 'board.health', 'deployment.preflight', 'safety.gate',
    ]);
    expect(plan.steps.some((item) => item.tool === 'board.start')).toBe(false);
    expect(plan.safety).toBe('guarded');
  });

  it('classifies stop and simulation commands before generic device checks', () => {
    expect(classifySim2RealAgentIntent('急停')).toBe('stop');
    expect(classifySim2RealAgentIntent('打开仿真器')).toBe('simulate');
    expect(classifySim2RealAgentIntent('看看板卡状态')).toBe('board-check');
  });

  it('routes evaluation-evidence requests to the read-only evaluation intent', () => {
    expect(classifySim2RealAgentIntent('汇总最近一次训练的评测证据')).toBe('evaluation');
    expect(classifySim2RealAgentIntent('跑一轮 GPU 冒烟训练并跟踪结果')).toBe('gpu-train');
    const plan = createSim2RealAgentPlan('汇总最近一次训练的评测证据');
    expect(plan.safety).toBe('read-only');
    expect(plan.steps.map((item) => item.tool)).toEqual(['workspace.overview', 'evaluation.summarize']);
  });
});

describe('Sim2Real Agent route', () => {
  it('creates an async run and records tool evidence through the injected executor', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (_request, path) => {
      calls.push(path);
      if (path.endsWith('/overview')) return { status: 200, body: { models: [{ id: 'm1' }], devices: [{ id: 'd1' }] } };
      if (path.endsWith('/board-station/health')) return { status: 200, body: { agent: { state: 'connected' } } };
      if (path.endsWith('/deployments')) return { status: 201, body: { deployment: { id: 'dep-1' } } };
      if (path.endsWith('/preflight')) return { status: 200, body: { preflight: { passed: true } } };
      if (path.endsWith('/runs')) return { status: 201, body: { run: { id: 'run-1', status: 'completed' } } };
      return { status: 200, body: {} };
    });
    const router = createSim2RealAgentRouter({ execute });
    const planLayer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/plan');
    const executeLayer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/execute');
    expect(planLayer && executeLayer).toBeTruthy();
    const planResponse = await invoke(planLayer!.route.stack[0].handle, { body: { message: '检查板卡' } });
    expect(planResponse.statusCode).toBe(200);
    const plan = planResponse.body.plan;
    expect(plan.steps[0].tool).toBe('board.health');
    const runResponse = await invoke(executeLayer!.route.stack[0].handle, { body: { plan, approved: true } });
    expect(runResponse.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toContain('/api/sim2real/board-station/health');
  });

  it('orchestrates the safe full loop without ever invoking a live actuator tool', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (_request, path) => {
      calls.push(path);
      if (path.endsWith('/overview')) return { status: 200, body: { models: [{ id: 'm1' }], devices: [{ id: 'd1' }] } };
      if (path.endsWith('/board-station/health')) return { status: 200, body: { agent: { state: 'connected' } } };
      if (path.endsWith('/deployments')) return { status: 201, body: { deployment: { id: 'dep-1' } } };
      if (path.endsWith('/preflight')) return { status: 200, body: { preflight: { passed: true } } };
      if (path.endsWith('/runs')) return { status: 201, body: { run: { id: 'run-1', status: 'completed' } } };
      return { status: 200, body: {} };
    });
    const router = createSim2RealAgentRouter({ execute });
    const layer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/execute');
    const plan = createSim2RealAgentPlan('完整端云真机闭环');
    const response = await invoke(layer!.route.stack[0].handle, { body: { plan, approved: true } });
    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(expect.arrayContaining(['/api/sim2real/overview', '/api/sim2real/runs', '/api/sim2real/board-station/health', '/api/sim2real/deployments', '/api/sim2real/deployments/dep-1/preflight']));
    expect(calls.some((path) => path.includes('/policy/start') || path.includes('/drive'))).toBe(false);
  });

  it('summarizes evaluation evidence for the latest completed run', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (_request, path) => {
      calls.push(path);
      if (path.endsWith('/overview')) return { status: 200, body: { models: [{ id: 'm1' }], devices: [{ id: 'd1' }], runs: [{ id: 'run-9', status: 'completed', modelId: 'm1' }] } };
      if (path.endsWith('/evaluate')) return { status: 200, body: { run: { metrics: { reward: 38.76, successRate: 0, fallRate: 1, iterations: 5 } }, evaluation: { replay: { sampleCount: 0, fallCount: 0, doneCount: 0 }, warnings: ['no telemetry samples were available'] } } };
      return { status: 200, body: {} };
    });
    const router = createSim2RealAgentRouter({ execute });
    const layer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/execute');
    const plan = createSim2RealAgentPlan('汇总最近一次训练的评测证据');
    const response = await invoke(layer!.route.stack[0].handle, { body: { plan, approved: true } });
    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toContain('/api/sim2real/runs/run-9/evaluate');
  });

  it('rejects crafted plans carrying unknown tool ids instead of faking completion', async () => {
    const execute = vi.fn(async () => ({ status: 200, body: {} }));
    const router = createSim2RealAgentRouter({ execute });
    const layer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/execute');
    const plan = createSim2RealAgentPlan('打开仿真器');
    const hostile = { ...plan, steps: [{ ...plan.steps[0], tool: 'board.policy-start' }] };
    const response = await invoke(layer!.route.stack[0].handle, { body: { plan: hostile, approved: true } });
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toBe('SIM2REAL_AGENT_PLAN_INVALID');
    expect(execute).not.toHaveBeenCalled();
  });

  it('trains the model the caller pinned instead of silently picking models[0]', async () => {
    const submittedModels: string[] = [];
    const execute = vi.fn(async (_request, path, init) => {
      if (path.endsWith('/overview')) return { status: 200, body: { models: [{ id: 'builtin-first' }, { id: 'chosen-model' }], devices: [{ id: 'd1' }] } };
      if (path === '/api/sim2real/runs' && init?.method === 'POST') {
        submittedModels.push(JSON.parse(init.body).modelId);
        return { status: 201, body: { run: { id: 'run-1', status: 'completed' } } };
      }
      return { status: 200, body: {} };
    });
    const router = createSim2RealAgentRouter({ execute });
    const layer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/execute');
    // The pinned model is NOT the first one in the overview; the executor
    // must use it rather than training builtin-first.
    const plan = createSim2RealAgentPlan('跑一轮训练', { modelId: 'chosen-model' });
    expect(plan.modelId).toBe('chosen-model');
    const response = await invoke(layer!.route.stack[0].handle, { body: { plan, approved: true } });
    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submittedModels).toEqual(['chosen-model']);
  });

  it('fails honestly when the pinned model no longer exists in the workspace', async () => {
    const submittedModels: string[] = [];
    const execute = vi.fn(async (_request, path, init) => {
      if (path.endsWith('/overview')) return { status: 200, body: { models: [{ id: 'builtin-first' }], devices: [{ id: 'd1' }] } };
      if (path === '/api/sim2real/runs' && init?.method === 'POST') {
        submittedModels.push(JSON.parse(init.body).modelId);
        return { status: 201, body: { run: { id: 'run-1', status: 'completed' } } };
      }
      return { status: 200, body: {} };
    });
    const router = createSim2RealAgentRouter({ execute });
    const layer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/execute');
    const runLayer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/runs/:id');
    const plan = createSim2RealAgentPlan('跑一轮训练', { modelId: 'deleted-model' });
    const response = await invoke(layer!.route.stack[0].handle, { body: { plan, approved: true } });
    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No training submission ever happened for a vanished model.
    expect(submittedModels).toEqual([]);
    const polled = await invoke(runLayer!.route.stack[0].handle, { params: { id: response.body.run.id } });
    expect(polled.body.run.status).toBe('failed');
    expect(polled.body.run.steps.find((item: any) => item.tool === 'training.gpu').detail).toContain('deleted-model');
  });

  it('keeps shared-deployment runs private between accounts', async () => {
    const execute = vi.fn(async (_request, path) => {
      if (path.endsWith('/overview')) return { status: 200, body: { models: [], devices: [] } };
      return { status: 200, body: {} };
    });
    const auth = {
      isMultiUserDeployment: () => true,
      resolvePrincipal: (request: any) => (request.headers?.['x-test-account'] ? { accountId: request.headers['x-test-account'] } : null),
      resolveAccessToken: () => null,
    };
    const router = createSim2RealAgentRouter({ execute, auth });
    const executeLayer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/execute');
    const runLayer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/runs/:id');

    // Anonymous callers are refused outright (fail closed).
    const anonymous = await invoke(executeLayer!.route.stack[0].handle, { body: { plan: createSim2RealAgentPlan('看看板卡状态'), approved: true }, headers: {} });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body.error).toBe('SIM2REAL_AUTH_REQUIRED');

    const owner = await invoke(executeLayer!.route.stack[0].handle, {
      body: { plan: createSim2RealAgentPlan('看看板卡状态'), approved: true },
      headers: { 'x-test-account': 'account-a' },
    });
    expect(owner.statusCode).toBe(202);
    const runId = owner.body.run.id;

    // The creating account can poll its run; a different account gets the
    // same 404 as a missing id so run ids cannot leak conversation existence.
    const same = await invoke(runLayer!.route.stack[0].handle, { params: { id: runId }, headers: { 'x-test-account': 'account-a' } });
    expect(same.statusCode).toBe(200);
    expect(same.body.run.id).toBe(runId);
    const other = await invoke(runLayer!.route.stack[0].handle, { params: { id: runId }, headers: { 'x-test-account': 'account-b' } });
    expect(other.statusCode).toBe(404);
    expect(other.body.error).toBe('SIM2REAL_AGENT_RUN_NOT_FOUND');
    const missing = await invoke(runLayer!.route.stack[0].handle, { params: { id: 'nope' }, headers: { 'x-test-account': 'account-b' } });
    expect(missing.statusCode).toBe(404);
  });

  it('evicts only terminal runs once the registry exceeds its cap', async () => {
    const execute = vi.fn(async (_request, path) => {
      if (path.endsWith('/overview')) return { status: 200, body: { models: [{ id: 'm1' }], devices: [{ id: 'd1' }] } };
      return { status: 200, body: {} };
    });
    const router = createSim2RealAgentRouter({ execute });
    const executeLayer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/execute');
    const runLayer = router.stack.find((entry) => entry.route?.path === '/api/sim2real/agent/runs/:id');

    // Fill the registry with terminal board-check runs, then verify runs past
    // the cap are evicted while the newest run survives.
    const ids: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      const response = await invoke(executeLayer!.route.stack[0].handle, { body: { plan: createSim2RealAgentPlan('看看板卡状态'), approved: true } });
      ids.push(response.body.run.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    let surviving = 0;
    for (const id of ids) {
      const result = await invoke(runLayer!.route.stack[0].handle, { params: { id } });
      if (result.statusCode === 200) surviving += 1;
    }
    expect(surviving).toBeGreaterThan(0);
    expect(surviving).toBeLessThan(ids.length);
    const newest = await invoke(runLayer!.route.stack[0].handle, { params: { id: ids[ids.length - 1] } });
    expect(newest.statusCode).toBe(200);
  });
});

async function invoke(handler: any, input: any) {
  let settled: any;
  const response: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; },
    json(body: any) { settled = { statusCode: this.statusCode, body }; return this; },
  };
  await handler(
    { body: input.body ?? {}, params: input.params ?? {}, headers: input.headers ?? {} },
    response,
    () => undefined,
  );
  return settled;
}
