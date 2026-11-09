/** Local evidence coverage review only. Never issues motion permits or calls upstream. */
import { readFileSync } from 'node:fs';
import { questionText, guidedInput, INTAKE_SCHEMA } from './guided-input.mjs';
export const STAGES = {
  interface: [
    'officialProtocolReviewed',
    'installedSdkReviewed',
    'readSemanticsKnown',
    'queryRateMeasured',
  ],
  inventory: ['identityConfirmed', 'singleIoOwner', 'powerModeRecorded', 'temperatureReadable'],
  calibration: [
    'jointMapVerified',
    'directionsVerified',
    'offsetsVerified',
    'mechanicalLimitsVerified',
    'imuTransformVerified',
  ],
  parity: ['originalArtifactVerified', 'dimensionsAndUnitsVerified', 'numericToleranceMet'],
  simulation: [
    'taskSuccessCriteriaMet',
    'heldOutScenariosPassed',
    'simToRealPerturbationsEvaluated',
    'actionLimitsRespected',
    'failureRecoveryEvaluated',
    'environmentAndPolicyPinned',
  ],
  shadow: [
    'realSensorsUsed',
    'noActuation',
    'fullCycleTimingMet',
    'staleDataRejected',
    'watchdogAndRecoveryVerified',
  ],
  static: [
    'boundedTrialCompleted',
    'sentTargetsAndReadbackRecorded',
    'operatorConfirmedUnassisted',
    'thermalAndTransportChecksMet',
  ],
  recovery: [
    'matchedBaselineRecorded',
    'matchedPolicyRecorded',
    'perturbationMethodRecorded',
    'operatorConfirmedOutcome',
  ],
  endurance: ['durationTargetMet', 'thermalAndTransportChecksMet', 'operatorConfirmedOutcome'],
};
const bindings = ['robotId', 'adapterSha256', 'calibrationSha256', 'policySha256', 'runtimeSha256'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const labels = {
  robotId: '本机已核实身份',
  adapterSha256: '机型接口/适配器摘要',
  calibrationSha256: '本机标定摘要',
  policySha256: '模型文件摘要',
  runtimeSha256: '运行时代码与配置摘要',
};
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    throw Object.assign(Error('输入格式不正确：请使用指南提供的模板，不添加未声明的字段。'), {
      platformCode: 'ROBOT_ACCEPTANCE_INPUT_INVALID',
      nextAction: '调用rdk_robot_onboarding_guide获取模板；未知项留空，不填写假摘要。',
    });
}
function identityIssues(value) {
  keys(value, bindings, 'identity');
  return bindings.flatMap((key) => {
    const v = value[key];
    const missing =
      v === undefined ||
      v === null ||
      (typeof v === 'string' && (!v.trim() || /^(REPLACE_|UNKNOWN|未核实|未知)/i.test(v)));
    const valid =
      !missing &&
      typeof v === 'string' &&
      (key === 'robotId' ? /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(v) : /^[a-f0-9]{64}$/.test(v));
    return valid
      ? []
      : [
          {
            field: key,
            label: labels[key],
            status: missing ? '待补' : '格式不正确',
            obtainBy:
              key === 'robotId'
                ? '助手根据已保存连接或只读设备信息核实；课堂称呼不能替代设备身份。'
                : '助手从已选择的原文件计算并核对；没有文件就保留未知，不让学员手写摘要。',
          },
        ];
  });
}
function identity(value) {
  const issues = identityIssues(value);
  if (issues.length)
    throw Error(
      '证据身份缺失或无效：' +
        issues.map((i) => i.label).join('、') +
        '。请核对原始证据，不复用其他机器的摘要。',
    );
}
export function onboardingGuide(args = {}) {
  keys(args, ['detail'], 'guide');
  if (args.detail !== undefined && !['summary', 'full'].includes(args.detail))
    throw Error('详情选项应为summary或full。');
  return {
    scope: 'read-only-guidance-and-evidence-coverage',
    motionAuthorized: false,
    stageCriteria: STAGES,
    evidenceFields: ['stage', 'identity', 'observedAt', 'expiresAt', 'receiptSha256', 'facts'],
    instructions:
      args.detail === 'full'
        ? readFileSync(new URL('../references/new-robot-acceptance.md', import.meta.url), 'utf8')
        : '先用rdk_classroom_guide逐项引导输入，已有信息不重复问。身份与文件待补时可以记录准备状态，不能标记通过。所有任务共用simulation迁移门槛，任务模板只定义效果指标；原始收据记录留出条件、仿真扰动和逐项结果。上电前先离线准备，读取时只允许单一I/O持有者，负状态不填零、过期不接受；simulation通过后仍须完成零致动shadow和逐机检查，不能直接视为可运动。',
    readPolicy: '默认不展开参考文档；只有用户追问依据或具体接口争议时使用detail=full。',
    template: JSON.parse(
      readFileSync(
        new URL('../references/robot-acceptance-template.json', import.meta.url),
        'utf8',
      ),
    ),
    nextAction:
      '先核对当前设备身份和实际工具目录；训练后用simulation阶段检查通用迁移证据，再完成零致动shadow与逐机门禁。离线准备完成后才安排上电，未知项保留未知。',
  };
}
export function assessOnboarding(args, now = Date.now()) {
  keys(args, ['record', 'answers'], 'arguments');
  const intake = args.answers === undefined ? null : guidedInput(args.answers);
  const record = args.record;
  keys(record, ['schemaVersion', 'identity', 'evidence', 'unresolvedFaults'], 'record');
  if (record.schemaVersion !== 1)
    throw Error('记录版本缺失或不支持：请使用schemaVersion为1的指南模板。');
  const missingInputs = identityIssues(record.identity ?? {});
  if (
    !Array.isArray(record.evidence) ||
    record.evidence.length > 64 ||
    !Array.isArray(record.unresolvedFaults) ||
    record.unresolvedFaults.length > 32 ||
    record.unresolvedFaults.some((f) => typeof f !== 'string' || !f.trim() || f.length > 500)
  )
    throw Error('证据或未解决故障的列表格式不正确，请保留原始记录并按模板填写。');
  if (missingInputs.length) {
    const nextQuestion = intake
      ? intake.nextQuestion
      : missingInputs.some((i) => i.field === 'robotId')
        ? {
            field: 'robotLabel',
            title: '先告诉我这台机器人怎么称呼，例如“课堂1号”；暂时不知道可以直接说。',
            freeText: true,
          }
        : {
            field: 'policyStatus',
            title: '接下来使用现成模型，还是还没有选择模型？',
            options: [
              { value: 'existing', label: '有现成模型' },
              { value: 'not-selected', label: '还没选择' },
              { value: 'unknown', label: '不清楚' },
            ],
          };
    return {
      ok: true,
      status: 'needs-input',
      schemaVersion: 1,
      needsInput: true,
      missingInputs,
      nextQuestion,
      needsLearnerInput: Boolean(nextQuestion),
      ...(intake ? { answers: intake.answers } : {}),
      studentReply:
        (record.unresolvedFaults.length
          ? '当前有未解决故障，先停止后续实体试验。'
          : '当前仅完成准备建档，尚未通过验收。') +
        '\n待补：' +
        missingInputs.map((i) => i.label).join('、') +
        '。技术摘要由助手核对文件，你不用手填，也不用提供密码。\n' +
        questionText(nextQuestion),
      stages: Object.keys(STAGES).map((stage) => ({
        stage,
        status: 'blocked-missing-identity',
        issues: ['identity-incomplete'],
      })),
      unresolvedFaults: record.unresolvedFaults,
      evidenceCoverageComplete: false,
      motionAuthorized: false,
      hardwareEligible: false,
      receiptsIndependentlyVerified: false,
      nextAction:
        '使用rdk_classroom_guide携带本轮已有answers，每次只引导一个待补问题；已答未知的项保持待补，不反复问或伪造。',
      limitation: '这是准备状态，不是证据已通过；输入不会保存，课堂称呼不替代真实设备身份。',
    };
  }
  const seen = new Set();
  const rows = new Map();
  for (const evidence of record.evidence) {
    keys(
      evidence,
      ['stage', 'identity', 'observedAt', 'expiresAt', 'receiptSha256', 'facts'],
      'evidence',
    );
    if (!Object.hasOwn(STAGES, evidence.stage) || seen.has(evidence.stage))
      throw Error('证据阶段未知或重复，请每个阶段只保留一份明确记录。');
    seen.add(evidence.stage);
    identity(evidence.identity);
    if (
      typeof evidence.receiptSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(evidence.receiptSha256)
    )
      throw Error('证据缺少有效的原始收据摘要，请由助手核对原始文件。');
    const iso = (v) =>
      typeof v === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) &&
      Number.isFinite(Date.parse(v));
    if (
      !iso(evidence.observedAt) ||
      !iso(evidence.expiresAt) ||
      Date.parse(evidence.expiresAt) <= Date.parse(evidence.observedAt)
    )
      throw Error('证据时间缺失或无效，请核对采集时间与有效期，不能延长有效期替代复测。');
    keys(evidence.facts, STAGES[evidence.stage], 'facts');
    if (Object.values(evidence.facts).some((v) => ![true, false, null].includes(v)))
      throw Error('证据事实只能填写true、false或null；未执行填null，不能用文字冒充通过。');
    const issues = [];
    if (bindings.some((k) => evidence.identity[k] !== record.identity[k]))
      issues.push('identity-mismatch');
    if (Date.parse(evidence.observedAt) > now || Date.parse(evidence.expiresAt) <= now)
      issues.push('outside-validity-window');
    for (const fact of STAGES[evidence.stage]) if (evidence.facts[fact] !== true) issues.push(fact);
    rows.set(evidence.stage, issues);
  }
  let prerequisitesMet = true;
  const stages = Object.keys(STAGES).map((stage) => {
    const issues = rows.get(stage);
    const covered = issues !== undefined && issues.length === 0;
    const status = !prerequisitesMet
      ? 'blocked-by-prerequisite'
      : !issues
        ? 'missing'
        : covered
          ? 'documented'
          : 'needs-review';
    prerequisitesMet &&= covered;
    return { stage, status, issues: issues ?? ['no-evidence'] };
  });
  const next = stages.find((s) => s.status !== 'documented');
  return {
    ok: true,
    schemaVersion: 1,
    assessedAt: new Date(now).toISOString(),
    identity: record.identity,
    stages,
    unresolvedFaults: record.unresolvedFaults,
    evidenceCoverageComplete: !next && record.unresolvedFaults.length === 0,
    motionAuthorized: false,
    hardwareEligible: false,
    receiptsIndependentlyVerified: false,
    nextAction: record.unresolvedFaults.length
      ? '保留故障与原始证据，停止实体试验；先诊断，不能靠重试清除故障。'
      : next
        ? `补齐 ${next.stage} 阶段证据；本工具不会发起设备动作。`
        : '记录字段覆盖完整；仍需核验原始收据与平台/板端门禁，不能据此宣称部署合格或RL优于基线。',
    limitation:
      '仅检查调用方提交的字段、绑定、期限与前置阶段；不读取收据文件、不证明事实真实性、不保存记录、不签发运动许可。记录请保存到本项目私有证据目录。',
  };
}
export const ROBOT_ONBOARDING_TOOLS = [
  {
    name: 'rdk_robot_onboarding_guide',
    description: '新机器人接入验收指南和逐机证据模板；只读，不连接设备、不发动作。',
    inputSchema: {
      type: 'object',
      properties: { detail: { type: 'string', enum: ['summary', 'full'], default: 'summary' } },
      additionalProperties: false,
    },
  },
  {
    name: 'rdk_robot_acceptance_assess',
    description:
      '检查逐机证据字段覆盖、绑定与时效；缺信息时用中文列出全部待补项和一个引导问题，保持未通过。不验证收据真实性，不签发运动许可，不保存记录。',
    inputSchema: {
      type: 'object',
      properties: {
        answers: INTAKE_SCHEMA,
        record: {
          type: 'object',
          description: '使用rdk_robot_onboarding_guide返回的schemaVersion=1模板。',
        },
      },
      required: ['record'],
      additionalProperties: false,
    },
  },
].map((t) => ({
  ...t,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));
