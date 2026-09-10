import { randomUUID } from 'node:crypto';

export type Sim2RealAgentIntent =
  | 'full-loop'
  | 'gpu-train'
  | 'board-check'
  | 'deploy-preflight'
  | 'simulate'
  | 'evaluation'
  | 'stop';

export type Sim2RealAgentStep = {
  id: string;
  label: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'blocked' | 'failed';
  detail?: string;
  requiresApproval?: boolean;
};

export type Sim2RealAgentPlan = {
  id: string;
  intent: Sim2RealAgentIntent;
  goal: string;
  safety: 'read-only' | 'compute' | 'guarded';
  steps: Sim2RealAgentStep[];
  rationale: string;
  /**
   * Caller-pinned targets from the chat context (UI dropdown selections).
   * Without them the executor falls back to the workspace's first model and
   * first device, which can silently train/deploy something the user did not
   * pick.
   */
  modelId?: string;
  deviceId?: string;
  computeResourceId?: string;
  createdAt: string;
};

export type Sim2RealAgentRun = Sim2RealAgentPlan & {
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed';
  events: Array<{ at: string; type: 'plan' | 'tool_start' | 'tool_result' | 'message'; text: string }>;
  evidence: Array<{ label: string; value: string; href?: string }>;
  updatedAt: string;
};

export function classifySim2RealAgentIntent(message: string): Sim2RealAgentIntent {
  const text = String(message ?? '').trim().toLowerCase();
  if (!text) return 'board-check';
  if (/(停止|急停|stop|halt)/i.test(text)) return 'stop';
  if (/(完整|闭环|端云|真机|能力演示|全链路)/i.test(text)) return 'full-loop';
  if (/(评测|评估|证据|指标|成功率|对比|evaluate|evidence)/i.test(text)) return 'evaluation';
  if (/(训练|gpu|cuda|跑一轮|强化学习)/i.test(text)) return 'gpu-train';
  if (/(部署|上板|加载模型|预检|preflight)/i.test(text)) return 'deploy-preflight';
  if (/(仿真|模拟器|录制|sim)/i.test(text)) return 'simulate';
  return 'board-check';
}

const step = (id: string, label: string, tool: string, requiresApproval = false): Sim2RealAgentStep => ({
  id,
  label,
  tool,
  status: 'pending',
  ...(requiresApproval ? { requiresApproval: true } : {}),
});

export function createSim2RealAgentPlan(message: string, context?: Record<string, unknown>): Sim2RealAgentPlan {
  const intent = classifySim2RealAgentIntent(message);
  const modelId = String(context?.modelId ?? '').trim();
  const deviceId = String(context?.deviceId ?? '').trim();
  const computeResourceId = String(context?.computeResourceId ?? '').trim();
  const suffix = [modelId ? `模型 ${modelId}` : '', deviceId ? `板卡 ${deviceId}` : '', computeResourceId ? `指定 GPU 资源 ${computeResourceId}` : ''].filter(Boolean).join('，');
  const common = suffix ? `（${suffix}）` : '';
  const plans: Record<Sim2RealAgentIntent, Omit<Sim2RealAgentPlan, 'id' | 'createdAt' | 'rationale'>> = {
    'full-loop': {
      intent,
      goal: `完成仿真 → GPU 训练 → X5 真机只读预检的演示闭环${common}`,
      safety: 'guarded',
      steps: [
        step('workspace', '读取当前工作区与模型契约', 'workspace.overview'),
        step('simulate', '打开 MicroDuck 仿真入口', 'simulator.open'),
        step('train', '提交一轮 GPU smoke 训练', 'training.gpu'),
        step('board', '检查 X5 BoardAgent、相机与遥测', 'board.health'),
        step('preflight', '创建部署计划并执行只读 preflight', 'deployment.preflight'),
        step('safety', '确认真机动作仍处于安全门控', 'safety.gate'),
      ],
    },
    'gpu-train': {
      intent,
      goal: `提交一轮 GPU smoke 训练${common}`,
      safety: 'compute',
      steps: [step('workspace', '读取模型契约', 'workspace.overview'), step('train', '提交 GPU smoke 训练', 'training.gpu')],
    },
    'board-check': {
      intent,
      goal: '检查板端连接、相机、遥测和上位机状态',
      safety: 'read-only',
      steps: [step('board', '读取 X5 BoardAgent 健康状态', 'board.health')],
    },
    'deploy-preflight': {
      intent,
      goal: `准备模型上板并执行只读预检${common}`,
      safety: 'guarded',
      steps: [step('workspace', '读取模型与设备契约', 'workspace.overview'), step('preflight', '执行部署计划和只读 preflight', 'deployment.preflight'), step('safety', '确认真机动作仍处于安全门控', 'safety.gate')],
    },
    simulate: {
      intent,
      goal: '打开 MicroDuck 浏览器仿真并准备录制',
      safety: 'read-only',
      steps: [step('simulate', '打开 MicroDuck 仿真入口', 'simulator.open')],
    },
    evaluation: {
      intent,
      goal: '汇总最近一次训练的评测证据与关键指标',
      safety: 'read-only',
      steps: [step('workspace', '读取最近训练运行', 'workspace.overview'), step('evaluate', '执行评测并汇总证据', 'evaluation.summarize')],
    },
    stop: {
      intent,
      goal: '发送停止请求并确认驱动处于安全状态',
      safety: 'guarded',
      steps: [step('stop', '停止板端策略与驱动', 'board.stop')],
    },
  };
  const selected = plans[intent];
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    rationale: 'Agent 根据任务关键词匹配能力范围，先读取上下文，再按依赖顺序调用受控工具；真机动作始终停在安全门控。',
    ...selected,
    ...(modelId ? { modelId } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(computeResourceId ? { computeResourceId } : {}),
  };
}
