/** Read-only classroom knowledge. No network, credentials, training or device calls. */
import { readFileSync } from 'node:fs';
import { guidedInput, questionText, INTAKE_SCHEMA } from './guided-input.mjs';
const scenarios = {
  overview: {
    next: '先明确离线教学、真实仿真训练或实体试验，再选择流程。',
    stop: '离线示例不能记成真实任务结果。',
  },
  'new-robot': {
    next: '调用rdk_robot_onboarding_guide，记录逐机身份、标定、模型和源码摘要。',
    stop: '旧机器或旧模型的通过记录不能转移；缺适配器保持未接入。',
  },
  communication: {
    next: '先只读审查协议、已安装SDK、I/O所有者和完整循环时序；记录负状态或0字节证据。',
    stop: '失败不填零，过期回包不接受，不能靠延长超时或无限重试清除故障。',
  },
  temperature: {
    next: '核对机型规范与工程门限，记录开始/趋势/结束温度、供电及承重；先离线准备。',
    stop: '持续升温或温度读数未知时停止后续实体试验，不复制案例阈值或降低保护。',
  },
  training: {
    next: '按当前账号能力和课程配方预检，提交后保存contextId及原Run，同源评测。',
    stop: '断线或失败不换标识重交；completed不等于策略优于基线。',
  },
  evidence: {
    next: '核对设备、模型、源码、配置与原始收据，区分纯推理、影子、静止、抗扰和长期运行。',
    stop: '策略参与目标不等于闭环优势；静止成功不等于抗扰或生产资格。',
  },
};
export function classroomGuide(args = {}) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !['scenario', 'answers', 'detail'].includes(k)) ||
    (args.detail !== undefined && !['summary', 'full'].includes(args.detail)) ||
    (args.scenario !== undefined &&
      (typeof args.scenario !== 'string' || !Object.hasOwn(scenarios, args.scenario)))
  )
    throw Error('课堂指南参数不正确，请选择提供的场景；默认使用简短引导。');
  const scenario = args.scenario ?? 'overview';
  const intake = guidedInput(args.answers);
  const brief =
    scenario === 'new-robot'
      ? '先核对资料来源，再确认这台机器，最后列出待验证项。旧机器的通过记录不能直接沿用。'
      : scenarios[scenario].stop;
  const modeLabel =
    { offline: '离线', 'read-only': '只读检查', physical: '准备实体测试' }[intake.answers.mode] ??
    '待确认';
  const policyLabel =
    { existing: '有文件待核对', 'not-selected': '尚未选择', unknown: '未知' }[
      intake.answers.policyStatus
    ] ?? '待确认';
  const focusLabel =
    { 'review-materials': '核对资料', 'choose-model': '选择模型', 'view-demo': '看课堂演示' }[
      intake.answers.nextFocus
    ] ?? '待确认';
  const label = Array.from(intake.answers.robotLabel ?? '这台机器');
  const displayLabel = label.length > 20 ? label.slice(0, 20).join('') + '…' : label.join('');
  const studentReply = intake.needsInput
    ? `${brief}\n${questionText(intake.nextQuestion)}`
    : `已记录${displayLabel}：${modeLabel}、模型${policyLabel}、下一步${focusLabel}。未知项保留待补，技术摘要由助手核对，你不用手填。当前尚未通过实机验收。`;
  return {
    scope: 'local-classroom-knowledge-only',
    scenario,
    ...scenarios[scenario],
    motionAuthorized: false,
    intake,
    next: intake.needsInput
      ? '只展示studentReply并等待当前问题回答，本轮不再调用其他工具。'
      : '仅展示studentReply并结束本轮；不自动调用其他指南、登记、查询平台或训练。等待用户具体请求。',
    studentReply,
    nextCallArguments: { scenario, answers: intake.answers },
    delivery:
      '逐字展示studentReply，不添加开场白、标题、小结、清单或历史案例；默认120字以内。问题等待回答，填完仅作表单回执。每次只问一题；从用户当前话语和本轮已有信息提取answers，不重复问已知项。不补造答案，不向学员索取SHA、UUID、ABI或密码。事实选项不加推荐、不预选，也不描述为可直接加载。填完准备信息后仅总结并结束本轮，不自动展开验收或训练。',
    ...(args.detail === 'full' || scenario === 'evidence'
      ? {
          sourceLevels: ['官方公开资料', '项目改造', '本样机实测', '仍未确认'],
          currentBoundary:
            '旧策略30秒静止、新候选3秒静止仅历史有限证据；实体抗扰未完成，通信与温升根因未确认。',
        }
      : {}),
    readPolicy: '未要求依据时不读取引用或枚举目录，已返回内容不重复读。',
    platformLoginRequired: false,
    ...(args.detail === 'full'
      ? {
          documents: Object.fromEntries(
            [
              'classroom-guardrails.md',
              'originman-source-levels.md',
              'originman-current-findings.md',
            ].map((name) => [
              name,
              readFileSync(new URL('../references/' + name, import.meta.url), 'utf8'),
            ]),
          ),
        }
      : {}),
    limitation: '指南不是执行许可或收据真实性验证；现场与平台能力仍须当前实际核对。',
  };
}
export const CLASSROOM_TOOLS = [
  {
    name: 'rdk_classroom_guide',
    description:
      '课堂简短分步引导：只问一个待补项并给中文选项，已知答案不重复询问；默认不返回全文，不需平台登录、不发动作。',
    inputSchema: {
      type: 'object',
      properties: {
        scenario: { type: 'string', enum: Object.keys(scenarios) },
        answers: INTAKE_SCHEMA,
        detail: { type: 'string', enum: ['summary', 'full'], default: 'summary' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];
