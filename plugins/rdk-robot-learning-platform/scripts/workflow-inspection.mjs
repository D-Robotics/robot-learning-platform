/** Compose a lifecycle evidence report; never submits training or a deployment. */
export const WORKFLOW_TOOLS = [
  {
    name: 'rdk_originman_evaluation_read',
    description: '只读指定 OriginMan 评测 Run 的已有扰动恢复结果及来源；不重新计算或保存评测。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', minLength: 1 } },
      required: ['runId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'rdk_training_prepare',
    description:
      '新训练提交前刷新指定资源的健康检查并核对所选机器人任务环境。只准备参数预览，不提交训练，不替换资源；OriginMan 不套用 MicroDuck 配置。',
    inputSchema: {
      type: 'object',
      properties: {
        computeResourceId: { type: 'string' },
        taskId: { type: 'string' },
        productId: { type: 'string', enum: ['microduck', 'originman'] },
      },
      required: ['computeResourceId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'rdk_workflow_inspect',
    description:
      '读取当前同账号、明确实验的流程证据。OriginMan Workshop仅仿真，真机部署标为不属于本课，不计入阻塞或进度；其他产品保留独立部署检查。只读，不自动选择最新Run、不提交任务、不操作设备。',
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        taskId: { type: 'string' },
        runId: { type: 'string' },
        computeResourceId: { type: 'string' },
        evaluationId: { type: 'string' },
        evaluationRunId: { type: 'string' },
        compareWithEvaluationId: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];
export async function readOriginmanEvaluation(input, call) {
  if (
    !input ||
    typeof input.runId !== 'string' ||
    !input.runId.trim() ||
    Object.keys(input).some((k) => k !== 'runId')
  )
    throw new Error('请明确指定评测 Run ID。');
  const readRun = async (runId, artifactRequired = false) => {
    const current = await call('rdk_training_status', { runId });
    if (current?.runId !== runId) throw new Error('平台返回的Run身份不一致。');
    if (
      !current.taskId ||
      current.mock === undefined ||
      current.metrics?.originmanWorkshop === null ||
      (artifactRequired && !current.artifact)
    ) {
      const full = (await call('rdk_lineage_get', { runId }))?.lineage?.run;
      if (full?.id === runId && full.status === current.status && full.modelId === current.modelId)
        return { ...full, runId };
    }
    return current;
  };
  const run = await readRun(input.runId);
  const training = run?.training?.originmanWorkshop;
  const evidence = run?.metrics?.originmanWorkshop;
  if (
    run?.runId !== input.runId ||
    run?.taskId !== 'originman-recovery' ||
    training?.phase !== 'evaluate' ||
    evidence?.phase !== 'evaluate'
  )
    throw new Error('指定 Run 不是可核对的 OriginMan 评测。');
  let sourceVerified = false;
  const sourceRunId = training.sourceRunId;
  if (typeof sourceRunId === 'string' && sourceRunId && sourceRunId !== run.runId) {
    try {
      const parent = await readRun(sourceRunId, true);
      const parentEvidence = parent?.metrics?.originmanWorkshop;
      sourceVerified =
        run.status === 'completed' &&
        run.mock === false &&
        parent?.runId === sourceRunId &&
        parent.status === 'completed' &&
        parent.mock === false &&
        parent.taskId === 'originman-recovery' &&
        typeof run.modelId === 'string' &&
        run.modelId.length > 0 &&
        parent.modelId === run.modelId &&
        parent.training?.originmanWorkshop?.phase === 'train' &&
        parentEvidence?.phase === 'train' &&
        evidence.sourceRunId === sourceRunId &&
        /^[a-f0-9]{64}$/.test(evidence.policySha256 ?? '') &&
        parentEvidence.policySha256 === evidence.policySha256 &&
        parent.artifact?.sha256 === evidence.policySha256;
    } catch {
      // A missing or inaccessible source is not evidence of a matching policy.
    }
  }
  const comparison = evidence.feedbackComparison;
  const suites = Array.isArray(comparison?.suites)
    ? comparison.suites.slice(0, 10).map((s) => ({
        id: s.id,
        caseCount: Array.isArray(s.cases) ? s.cases.length : null,
        originalRecovered: s.originalRecovered ?? null,
        tunedRecovered: s.tunedRecovered ?? null,
        rlRecovered: s.rlRecovered ?? null,
      }))
    : [];
  return {
    runId: run.runId,
    status: run.status,
    mock: run.mock ?? null,
    sourceRunId: training.sourceRunId ?? null,
    sourceVerified,
    policySha256: evidence.policySha256 ?? null,
    hardwareEligible: evidence.hardwareEligible ?? null,
    clearGain: sourceVerified ? (comparison?.clearGain ?? null) : null,
    suites,
    note: sourceVerified
      ? '来源与策略摘要已核对；读取已有记录，未重新计算或保存评测。'
      : '来源或策略摘要尚未核对；读取已有记录，未重新计算或保存评测。',
  };
}
const LABELS = {
  ready: '可继续',
  blocked: '受阻',
  unknown: '待验证',
  needs_input: '待选择',
  completed: '已有完成证据',
  running: '进行中',
  not_applicable: '不属于本课',
};
export async function inspectWorkflow(input, call, toolNames, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('参数必须是对象。');
  for (const [key, value] of Object.entries(input))
    if (
      ![
        'productId',
        'taskId',
        'runId',
        'computeResourceId',
        'evaluationId',
        'evaluationRunId',
        'compareWithEvaluationId',
      ].includes(key) ||
      typeof value !== 'string' ||
      !value.trim()
    )
      throw new Error('仅接受非空的产品、任务、Run、资源或评测 ID。');
  const observations = [];
  async function read(name, args = {}) {
    if (!toolNames.includes(name)) {
      const observation = { tool: name, status: 'unsupported', error: '当前插件未提供此工具。' };
      observations.push(observation);
      return null;
    }
    try {
      const value = await call(name, args);
      observations.push({ tool: name, status: 'returned' });
      return value;
    } catch (error) {
      observations.push({
        tool: name,
        status: 'failed',
        error: error.message,
        platformCode: error.platformCode ?? null,
        httpStatus: error.httpStatus ?? null,
      });
      return null;
    }
  }
  const status = await read('rdk_platform_status');
  const stages = [];
  const add = (id, title, state, reason, action) =>
    stages.push({ id, title, state, reason, nextAction: action });
  if (
    !status ||
    status.ok !== true ||
    status.health?.ready !== true ||
    status.health?.degraded?.some(
      (reason) => !(input.productId === 'originman' && reason === 'microduck-not-mounted'),
    ) ||
    status.canAccessWorkspace === false ||
    (status.session?.authenticated !== true && status.authMode !== 'standalone-anonymous')
  ) {
    add(
      'connect',
      '连接与身份',
      'blocked',
      '当前连接、身份或服务就绪检查未通过。',
      '先恢复当前客户端登录和服务，不切换数据源。',
    );
    return finish();
  }
  add('connect', '连接与身份', 'ready', '当前平台身份与服务就绪检查通过。', '沿当前连接继续。');
  if (input.productId === 'originman') {
    const catalog = await read('rdk_workshop_catalog', { robot: 'originman' });
    const contract = catalog?.manifest?.contract;
    const correct =
      catalog?.robot === 'originman' &&
      catalog.simulationOnly === true &&
      contract?.id === 'custom-policy-originman-recovery-v1' &&
      contract.observationSize === 14 &&
      contract.actionSize === 2;
    add(
      'simulate',
      'OriginMan 仿真',
      correct ? 'ready' : 'blocked',
      correct
        ? '取得 OriginMan 14→2 受扰恢复契约；实际物理回放仍需本次评测。'
        : '未取得匹配的 OriginMan 课程契约，不能借用机器鸭入口。',
      '用 robot=originman 打开工作台，先核对参考站姿与当前账号。',
    );
    const training = input.runId ? await read('rdk_training_status', { runId: input.runId }) : null;
    const evidence = training?.metrics?.originmanWorkshop;
    const validTraining =
      Boolean(input.runId && training) &&
      training?.runId === input.runId &&
      training.status === 'completed' &&
      evidence?.phase === 'train' &&
      evidence.hardwareEligible === false &&
      /^[a-f0-9]{64}$/.test(evidence.policySha256 ?? '');
    add(
      'train',
      'OriginMan 训练',
      !input.runId
        ? 'needs_input'
        : validTraining
          ? 'completed'
          : ['queued', 'running'].includes(training?.status)
            ? 'running'
            : 'blocked',
      validTraining
        ? `本组训练完成 ${evidence.actualTimesteps} 步，已取得策略摘要；完成不等于训练收益。`
        : '需选择本组 OriginMan 训练 Run 并核对其执行证据。',
      '沿原 Run 查询状态和日志；不重新提交来查询进度。',
    );
    const evaluation = input.evaluationRunId
      ? await read('rdk_training_status', { runId: input.evaluationRunId })
      : null;
    const measured = evaluation?.metrics?.originmanWorkshop;
    const validEvaluation =
      validTraining &&
      evaluation?.runId === input.evaluationRunId &&
      evaluation.status === 'completed' &&
      evaluation.modelId === training.modelId &&
      measured?.phase === 'evaluate' &&
      measured.hardwareEligible === false &&
      measured.sourceRunId === input.runId &&
      measured.policySha256 === evidence.policySha256 &&
      measured.cases?.length === 31;
    add(
      'evaluate',
      'OriginMan 对照评测',
      !input.evaluationRunId
        ? 'needs_input'
        : validEvaluation
          ? 'completed'
          : ['queued', 'running'].includes(evaluation?.status)
            ? 'running'
            : 'blocked',
      validEvaluation
        ? `同一父 Run 与策略摘要的课堂对照已完成：基础 ${measured.baselineRecovered}/31，RL ${measured.rlRecovered}/31；${measured.clearGain ? '达到本次课堂收益判据' : '未达明显收益判据'}。`
        : '评测应填写 evaluationRunId；不能套用 MicroDuck 的 evaluationId 或其他组的结果。',
      '保留全部失败和退化；31 条件是公开课堂基准，不是未见测试或真机成功率。',
    );
    add(
      'tune',
      '调优与解释',
      validEvaluation ? 'ready' : 'unknown',
      validEvaluation
        ? '已有本组逐条件对照，可分析差异；不保证换种子或短训练会改善。'
        : '需先取得绑定正确的评测 Run。',
      '先看本次对比与回放并保存记录；学员要求调参时，复制参数新建实验，只改训练步数或训练侧推上限，保留原实验。',
    );
    add(
      'deploy',
      'OriginMan 真机迁移',
      'not_applicable',
      '本课仅仿真；真机迁移不计入课程完成条件。',
      '继续本组仿真结果、回放与保存；硬件工作须由用户独立明确提出。',
    );
    return finish();
  }
  if (input.productId && input.productId !== 'microduck') {
    add(
      'product',
      '机器人流程适配',
      'unknown',
      '当前组合流程尚未声明支持此产品；不会套用机器鸭配置。',
      '使用该产品原子工具，或补充产品适配配置与验收。',
    );
    return finish();
  }
  const overview = await read('rdk_workspace_overview');
  const simulator = overview?.integrations?.simulator;
  add(
    'simulate',
    '仿真',
    simulator?.available === true
      ? 'ready'
      : simulator?.available === false
        ? 'blocked'
        : 'unknown',
    simulator?.available === true
      ? '平台报告参考资源已挂载；画布加载与运动仍需页面证据。'
      : (simulator?.reason ?? '没有取得可验证的仿真资源状态。'),
    '调用场景准备工具取得入口，等待控制器加载稳定后观察运动与停止。',
  );
  const resources = await read('rdk_compute_resources_list');
  const list = resources?.computeResources ?? [];
  const resource = input.computeResourceId
    ? list.find((x) => x.id === input.computeResourceId)
    : null;
  if (!input.computeResourceId)
    add(
      'compute',
      '训练资源',
      'needs_input',
      `当前读取到 ${list.length} 个资源，尚未明确选择。`,
      '指定 computeResourceId，再做实时连接测试与训练预检。',
    );
  else if (!resource)
    add(
      'compute',
      '训练资源',
      'blocked',
      '指定资源未出现在本次返回中，可能不可见或结果被截断。',
      '核对账号、资源 ID 和分页，不自动改选资源。',
    );
  else {
    const checked = Date.parse(resource.lastCheckedAt ?? '');
    const fresh = Number.isFinite(checked) && now - checked >= 0 && now - checked <= 600000;
    const online = resource.status === 'online' && fresh;
    add(
      'compute',
      '训练资源',
      resource.status === 'offline' ? 'blocked' : online ? 'ready' : 'unknown',
      resource.status === 'offline'
        ? '平台最近一次检测报告 Worker 不可达。'
        : online
          ? '最近健康状态在线；仍需任务环境预检。'
          : '健康状态缺失、未知或过期，不能以历史成功或提示文案代替。',
      '通过原资源测试工具重新检测，不重复提交训练来测试连接。',
    );
  }
  let lineage = null;
  if (input.runId)
    lineage = (await read('rdk_lineage_get', { runId: input.runId }))?.lineage ?? null;
  const runStatus = input.runId ? await read('rdk_training_status', { runId: input.runId }) : null;
  const run =
    input.runId && runStatus?.runId === input.runId
      ? { ...lineage?.run, ...runStatus, id: runStatus.runId }
      : lineage?.run;
  if (!input.runId)
    add(
      'train',
      '训练',
      'needs_input',
      '尚未选择要检查的 Run。',
      '先用明确模板预检并提交一次，保存 Run ID 和幂等键。',
    );
  else if (!run || run.id !== input.runId)
    add(
      'train',
      '训练',
      'blocked',
      '指定 Run 的完整来源证据未取得或不匹配。',
      '核对 Run ID、账号与平台接口。',
    );
  else
    add(
      'train',
      '训练',
      run.status === 'completed'
        ? 'completed'
        : ['queued', 'running'].includes(run.status)
          ? 'running'
          : 'blocked',
      run.status === 'completed'
        ? '此 Run 已完成；不代表策略质量或真机任务通过。'
        : (run.summary ?? `Run 状态为 ${run.status}。`),
      run.status === 'completed'
        ? '核对模型、制品摘要、保留状态与独立评测。'
        : '查询原 Run 状态和日志，不重复提交。',
    );
  const preflight = input.computeResourceId
    ? await read('rdk_training_preflight', {
        computeResourceId: input.computeResourceId,
        taskId: input.taskId ?? run?.taskId ?? 'walk',
      })
    : null;
  if (input.computeResourceId)
    add(
      'environment',
      '训练环境',
      preflight?.readyForSmokeTraining === true || preflight?.report?.readyForSmokeTraining === true
        ? 'ready'
        : preflight
          ? 'unknown'
          : 'blocked',
      preflight
        ? '已取得环境回执，实际字段与任务依赖仍按平台结果判断。'
        : '环境预检未取得；缺接口或执行器不可达时不允许宣称训练可用。',
      '修复预检接口及 Worker 环境后复测；不将预检降级为训练通过。',
    );
  let evaluation = null;
  let comparison = null;
  if (input.evaluationId)
    evaluation = await read('rdk_physical_evaluation_status', { evaluationId: input.evaluationId });
  const record = evaluation?.evaluation;
  const expectedSha = run?.artifactRetention?.sha256 ?? run?.artifact?.sha256;
  const sameRun = Boolean(input.runId && record?.runId === input.runId && run?.id === input.runId);
  const digestBound = Boolean(
    /^[a-f0-9]{64}$/.test(expectedSha ?? '') &&
    record?.execution?.policySha256 === expectedSha &&
    record?.taskEvaluation?.dynamicsFacts?.policySha256 === expectedSha,
  );
  const reportValid =
    record?.source === 'runner' &&
    record?.execution?.kind === 'microduck-physics' &&
    record?.taskEvaluation?.harnessQualification?.passed === true &&
    /^[a-f0-9]{64}$/.test(record?.taskEvaluation?.reportSha256 ?? '') &&
    ['nominal', 'hard'].every((name) => {
      const e = record?.taskEvaluation?.trained?.envelopes?.[name];
      return (
        Number.isSafeInteger(e?.episodes) &&
        e.episodes > 0 &&
        Number.isFinite(e.successRate) &&
        e.successRate >= 0 &&
        e.successRate <= 1
      );
    });
  const qualityPassed =
    sameRun &&
    digestBound &&
    reportValid &&
    record?.status === 'passed' &&
    evaluation?.qualityConclusion?.conclusive === true &&
    evaluation?.qualityConclusion?.passed === true &&
    record?.taskEvaluation?.qualityGate?.passed === true;
  let evalState = input.evaluationId ? 'unknown' : 'needs_input';
  let evalReason = input.evaluationId
    ? '已取得回执，但尚未核齐 Run、制品摘要、样本与独立质量证据。'
    : '尚未取得明确绑定的独立评测证据。';
  if (input.evaluationId && !evaluation) {
    evalState = 'blocked';
    evalReason = '评测回执不可读。';
  } else if (record && input.runId && record.runId !== input.runId) {
    evalState = 'blocked';
    evalReason = '这份评测属于其他 Run，不能借用其通过结论。';
  } else if (record && sameRun && expectedSha && record.execution?.policySha256 !== expectedSha) {
    evalState = 'blocked';
    evalReason = '评测绑定的策略摘要与当前制品不同。';
  } else if (record && ['queued', 'running'].includes(record.status)) {
    evalState = 'running';
    evalReason = '原独立评测仍在运行；继续查询，不重复提交。';
  } else if (qualityPassed) {
    evalState = 'completed';
    evalReason = '同一 Run、同一摘要的独立仿真质量门通过；不代表真机部署通过。';
  } else if (
    evaluation?.qualityConclusion?.conclusive === true &&
    evaluation.qualityConclusion.passed === false
  ) {
    evalState = 'blocked';
    evalReason = '独立仿真质量门未通过；保留原策略用于诊断。';
  }
  add(
    'evaluate',
    '独立评测',
    evalState,
    evalReason,
    '指定同一 Run 的 evaluationId，保留原评测与制品证据。',
  );
  if (input.compareWithEvaluationId && sameRun && digestBound)
    comparison = (
      await read('rdk_physical_evaluation_status', {
        evaluationId: input.evaluationId,
        compareWithEvaluationId: input.compareWithEvaluationId,
      })
    )?.comparison;
  const comparable =
    comparison?.comparable === true &&
    comparison.left?.evaluationId === input.evaluationId &&
    comparison.right?.evaluationId === input.compareWithEvaluationId &&
    comparison.left?.runId === input.runId;
  add(
    'tune',
    '调优与比较',
    comparable ? 'ready' : 'unknown',
    comparable
      ? '同条件评测可以比较；差值不代表自动改善或部署授权。'
      : '尚无绑定正确、同条件的两份评测比较。',
    '一次改变少量明确参数，独立评测后再比较；不自动提交多轮训练。',
  );
  add(
    'deploy',
    '受控部署',
    run?.artifact?.deployable === false ? 'blocked' : 'unknown',
    run?.artifact?.deployable === false
      ? '当前 Run 的策略明确为不可部署。'
      : '尚未取得制品、设备绑定和部署门的完整结果。',
    '核对制品摘要、质量与目标设备；部署预检会写入计划，不在本只读检查中执行。',
  );
  return finish();

  function finish() {
    const markdown =
      '| 环节 | 状态 | 依据 | 下一步 |\n|---|---|---|---|\n' +
      stages
        .map(
          (s) => `| ${s.title} | ${LABELS[s.state]} | ${cell(s.reason)} | ${cell(s.nextAction)} |`,
        )
        .join('\n');
    return {
      schemaVersion: 'rdk.workflow-inspection.v1',
      generatedAt: new Date(now).toISOString(),
      scope:
        status?.dataScope ??
        (status?.authMode === 'standalone-anonymous'
          ? 'local-anonymous'
          : 'current-platform-account'),
      selection: input,
      stages,
      observations,
      markdown,
      verdict: stages.some((s) => s.state === 'blocked') ? 'blocked' : 'incomplete',
      execution: {
        trainingSubmitted: false,
        evaluationSubmitted: false,
        deploymentCreated: false,
        deviceActuated: false,
      },
      note: '这是流程证据检查，不是完整任务验收。平台 reported 状态、真实执行和物理成功分别判断。',
    };
  }
}
function cell(value) {
  return String(value)
    .replace(/\|/g, '／')
    .replace(/[\r\n]/g, ' ');
}

export async function prepareTraining(input, call, toolNames, { courseReadiness } = {}) {
  if (
    !input ||
    typeof input.computeResourceId !== 'string' ||
    !input.computeResourceId.trim() ||
    (input.taskId !== undefined && (typeof input.taskId !== 'string' || !input.taskId.trim()))
  )
    throw new Error('请明确指定训练资源和有效任务。');
  if (input.productId !== undefined && !['microduck', 'originman'].includes(input.productId))
    throw new Error('不支持的机器人；不会采用机器鸭训练配置。');
  const originman = input.productId === 'originman';
  if (originman && input.taskId !== undefined && input.taskId !== 'originman-recovery')
    throw new Error('OriginMan 当前只接入 originman-recovery。');
  const resource = await call('rdk_compute_resource_test', {
    computeResourceId: input.computeResourceId,
  });
  if (
    resource.id !== input.computeResourceId ||
    resource.connected !== true ||
    resource.mock === true ||
    resource.browserRelay === true
  )
    return {
      status: 'blocked',
      computeResourceId: input.computeResourceId,
      reason: '指定执行资源未通过真实连接检查，不创建训练记录。',
      trainingSubmitted: false,
      resource,
    };
  if (originman && courseReadiness) {
    const preflight = await courseReadiness({
      computeResourceId: input.computeResourceId,
      device: 'cuda',
    });
    if (preflight.supported !== false) {
      const ready =
        preflight.computeResourceId === input.computeResourceId &&
        preflight.trainingSubmitted === false &&
        preflight.report?.readyForSmokeTraining === true &&
        preflight.report?.schemaVersion === 1 &&
        preflight.report?.trainingPerformed === false &&
        preflight.report?.device === 'cuda' &&
        preflight.report?.engine === 'originman-recovery-reflect' &&
        preflight.report?.taskId === 'originman-recovery';
      return {
        status: ready ? 'prepared' : 'blocked',
        computeResourceId: input.computeResourceId,
        resource,
        preflight,
        trainingSubmitted: false,
        taskEnvironmentVerified: ready,
        reason: ready ? '课程预检通过。' : '课程引擎、依赖或容量未就绪，尚未提交。',
      };
    }
  }
  const preflightTool =
    originman && toolNames?.includes('rdk_originman_training_preflight')
      ? 'rdk_originman_training_preflight'
      : 'rdk_training_preflight';
  if (toolNames && !toolNames.includes(preflightTool))
    return {
      status: 'incomplete',
      computeResourceId: input.computeResourceId,
      resource,
      trainingSubmitted: false,
      taskEnvironmentVerified: false,
      unsupportedTools: ['rdk_training_preflight'],
      reason: '资源已连接，但当前核心未提供任务环境预检；不能据此声称环境已就绪。',
      nextAction:
        '使用当前核心支持的模型校验、明确参数和受控短训练验证实际执行；失败保留原Run，不自动降级CPU或重交。',
    };
  if (!originman && resource.mock !== false)
    return {
      status: 'incomplete',
      computeResourceId: input.computeResourceId,
      resource,
      trainingSubmitted: false,
      taskEnvironmentVerified: false,
      reason: '资源连接正常，但核心没有返回明确的非Mock证据；不能据此声称真实训练已验证。',
    };
  let preflight;
  try {
    preflight = await call(preflightTool, {
      computeResourceId: input.computeResourceId,
      taskId: input.taskId ?? (originman ? 'originman-recovery' : 'walk'),
    });
  } catch (error) {
    if (error.platformCode !== 'SIM2REAL_ENGINE_PREFLIGHT_BUSY') throw error;
    return {
      status: 'waiting',
      platformCode: error.platformCode,
      resource,
      computeResourceId: input.computeResourceId,
      trainingSubmitted: false,
      reason: '课程资源正在执行其他任务，本次尚未提交。',
      nextAction: '等待同一资源空闲后再继续本实验，不换机器或改参数重试。',
    };
  }
  if (
    preflight.computeResourceId !== input.computeResourceId ||
    preflight.report?.readyForSmokeTraining !== true ||
    (originman &&
      (preflight.report?.taskId !== 'originman-recovery' ||
        preflight.report?.engine !== 'originman-recovery-reflect' ||
        preflight.report?.device !== 'cuda'))
  )
    return {
      status: 'blocked',
      reason: '任务环境检查尚未通过。',
      trainingSubmitted: false,
      preflight,
    };
  return {
    status: 'prepared',
    resource,
    taskEnvironmentVerified: true,
    computeResourceId: input.computeResourceId,
    trainingSubmitted: false,
    preflight,
    preview: {
      tool: 'rdk_training_submit',
      arguments: {
        computeResourceId: input.computeResourceId,
        taskId: input.taskId ?? (originman ? 'originman-recovery' : 'walk'),
        backend: 'local',
        engine: originman ? 'originman-recovery' : 'microduck-rl',
        algorithm: originman ? 'sac' : 'ppo',
        ...(originman
          ? {
              numEnvs: 4,
              profile: 'standard',
              maxIterations: 1954,
              originmanWorkshop: { phase: 'train', timesteps: 500000, seed: 7, pushMaxForce: 8.1 },
            }
          : {}),
      },
    },
    note: '这是新提交前的实时准备；参数仍由平台校验。续训还须确认 checkpoint 在所选 Worker 上；保存 Run ID 和幂等键，重试已提交任务时直接查原 Run。',
  };
}
