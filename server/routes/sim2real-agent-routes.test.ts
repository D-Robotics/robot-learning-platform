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
});

async function invoke(handler: any, input: any) {
  let settled: any;
  const response: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { settled = { statusCode: this.statusCode, body }; return this; },
  };
  await handler({ body: input.body ?? {}, params: {}, headers: {} }, response, () => undefined);
  return settled;
}
