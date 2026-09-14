import { randomUUID } from 'node:crypto';

export type Sim2RealAgentIntent =
  | 'conversation'
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
  events: Array<{
    at: string;
    type: 'plan' | 'tool_start' | 'tool_result' | 'message';
    text: string;
  }>;
  evidence: Array<{ label: string; value: string; href?: string }>;
  updatedAt: string;
};

/** Extensible skill registry. Product integrations can add skills without
 * changing the planner's dispatch code. */
export type Sim2RealAgentSkill = {
  intent: Sim2RealAgentIntent;
  signals: RegExp[];
  label: string;
  tool: string;
};

export const SIM2REAL_AGENT_SKILLS: Sim2RealAgentSkill[] = [
  {
    intent: 'stop',
    signals: [/(停止|急停|stop|halt)/i],
    label: '停止板端策略与驱动',
    tool: 'board.stop',
  },
  {
    intent: 'full-loop',
    signals: [/(完整|闭环|端云|真机|能力演示|全链路)/i],
    label: '执行端云真机闭环',
    tool: 'workflow.full-loop',
  },
  {
    intent: 'evaluation',
    signals: [/(评测|评估|证据|指标|对比|evaluate|evidence)/i],
    label: '汇总评测证据',
    tool: 'evaluation.summarize',
  },
  {
    intent: 'gpu-train',
    signals: [/(训练|gpu|cuda|冒烟|强化学习)/i],
    label: '提交 GPU 训练',
    tool: 'training.gpu',
  },
  {
    intent: 'deploy-preflight',
    signals: [/(部署|上板|加载模型|预检|preflight)/i],
    label: '执行部署预检',
    tool: 'deployment.preflight',
  },
  {
    intent: 'simulate',
    signals: [/(仿真|模拟器|录制|sim)/i],
    label: '打开仿真器',
    tool: 'simulator.open',
  },
  {
    intent: 'board-check',
    signals: [/(板卡|设备|相机|遥测|状态|健康|x5|rdk)/i],
    label: '检查板端状态',
    tool: 'board.health',
  },
];

export function classifySim2RealAgentIntent(message: string): Sim2RealAgentIntent {
  const text = String(message ?? '')
    .trim()
    .toLowerCase();
  if (
    !text ||
    /^(你好|您好|嗨|hello|hi|在吗|谢谢|感谢|早上好|下午好|晚上好)(啊|呀|呢)?[!！。,.， ]*$/i.test(
      text,
    )
  )
    return 'conversation';
  // Shell commands and credentials are not training intents. Never let a pasted
  // ssh/curl command trigger GPU or board actions by keyword coincidence.
  if (/\b(ssh|scp|curl|wget)\b|preferredauthentications|passwordauthentication/i.test(text))
    return 'conversation';
  const hit = SIM2REAL_AGENT_SKILLS.find((skill) =>
    skill.signals.some((signal) => signal.test(text)),
  );
  return hit?.intent ?? 'conversation';
}

const step = (
  id: string,
  label: string,
  tool: string,
  requiresApproval = false,
): Sim2RealAgentStep => ({
  id,
  label,
  tool,
  status: 'pending',
  ...(requiresApproval ? { requiresApproval: true } : {}),
});

export function createSim2RealAgentPlan(
  message: string,
  context?: Record<string, unknown>,
): Sim2RealAgentPlan {
  const intent = classifySim2RealAgentIntent(message);
  const text = String(message ?? '').toLowerCase();
  // Compose capabilities for natural requests such as “训练后评测并部署”.
  // The executor already understands these tools; the planner only supplies
  // the dependency ordered graph.
  const wantsTrain =
    /(开始|提交|运行|跑一轮|重新|启动).{0,8}(训练|gpu|cuda|冒烟|强化学习)|\b(gpu|cuda)\s*(训练)?/i.test(
      text,
    );
  const wantsEval = /(评测|评估|指标|证据|evaluate|evidence)/i.test(text);
  const wantsDeploy = /(部署|上板|加载模型|预检|preflight)/i.test(text);
  const wantsBoard = /(板卡|设备|相机|遥测|健康|x5|rdk)/i.test(text);
  const wantsSim = /(仿真|模拟器|录制|sim)/i.test(text);
  const modelId = String(context?.modelId ?? '').trim();
  const deviceId = String(context?.deviceId ?? '').trim();
  const computeResourceId = String(context?.computeResourceId ?? '').trim();
  const suffix = [
    modelId ? `模型 ${modelId}` : '',
    deviceId ? `板卡 ${deviceId}` : '',
    computeResourceId ? `指定 GPU 资源 ${computeResourceId}` : '',
  ]
    .filter(Boolean)
    .join('，');
  const common = suffix ? `（${suffix}）` : '';
  const plans: Record<
    Sim2RealAgentIntent,
    Omit<Sim2RealAgentPlan, 'id' | 'createdAt' | 'rationale'>
  > = {
    conversation: {
      intent,
      goal: '回复用户并保持 Agent 待命',
      safety: 'read-only',
      steps: [step('reply', '回复用户消息', 'conversation.reply')],
    },
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
      steps: [
        step('workspace', '读取模型契约', 'workspace.overview'),
        step('train', '提交 GPU smoke 训练', 'training.gpu'),
      ],
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
      steps: [
        step('workspace', '读取模型与设备契约', 'workspace.overview'),
        step('preflight', '执行部署计划和只读 preflight', 'deployment.preflight'),
        step('safety', '确认真机动作仍处于安全门控', 'safety.gate'),
      ],
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
      steps: [
        step('workspace', '读取最近训练运行', 'workspace.overview'),
        step('evaluate', '执行评测并汇总证据', 'evaluation.summarize'),
      ],
    },
    stop: {
      intent,
      goal: '发送停止请求并确认驱动处于安全状态',
      safety: 'guarded',
      steps: [step('stop', '停止板端策略与驱动', 'board.stop')],
    },
  };
  const selected = plans[intent];
  if (
    intent !== 'conversation' &&
    [wantsTrain, wantsEval, wantsDeploy, wantsBoard, wantsSim].filter(Boolean).length > 1
  ) {
    const composed: Sim2RealAgentStep[] = [
      step('workspace', '读取当前工作区与模型契约', 'workspace.overview'),
      ...(wantsSim ? [step('simulate', '打开 MicroDuck 仿真入口', 'simulator.open')] : []),
      ...(wantsTrain ? [step('train', '提交 GPU smoke 训练', 'training.gpu')] : []),
      ...(wantsEval ? [step('evaluate', '执行评测并汇总证据', 'evaluation.summarize')] : []),
      ...(wantsBoard ? [step('board', '读取 X5 BoardAgent 健康状态', 'board.health')] : []),
      ...(wantsDeploy
        ? [step('preflight', '执行部署计划和只读 preflight', 'deployment.preflight')]
        : []),
      step('safety', '确认真机动作仍处于安全门控', 'safety.gate'),
    ];
    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      intent: 'full-loop',
      goal: `按依赖顺序完成：${composed.map((item) => item.label).join(' → ')}`,
      safety: wantsDeploy ? 'guarded' : wantsTrain ? 'compute' : 'read-only',
      steps: composed,
      rationale:
        '通过技能注册表组合用户明确提到的能力，并按工作区、训练、评测、设备、部署依赖排序。',
      ...(modelId ? { modelId } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(computeResourceId ? { computeResourceId } : {}),
    };
  }
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    rationale:
      'Agent 根据任务关键词匹配能力范围，先读取上下文，再按依赖顺序调用受控工具；真机动作始终停在安全门控。',
    ...selected,
    ...(modelId ? { modelId } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(computeResourceId ? { computeResourceId } : {}),
  };
}
