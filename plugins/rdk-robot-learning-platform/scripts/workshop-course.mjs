import { createHash } from 'node:crypto';
import { DANCE_TRAINING_TOOLS } from './dance-training.mjs';
import {
  DANCE_SECTION_TYPES,
  DANCE_SECTION_LABELS,
  resolveOriginmanDanceConfig,
} from './originman-dance-config.mjs';
import { rewardChangeText } from './dance-coaching.mjs';
import { PluginRequestError } from './plugin-errors.mjs';

export const ORIGINMAN_DANCE_DRAFT_TOOL = {
  name: 'rdk_originman_dance_draft',
  description:
    '学员只想预览舞蹈训练配方或整理编舞草案时使用。算力离线、询问下一步、开始训练或改参时，用rdk_learning_guide。草案支持80–140 BPM、每段4/8/16拍、动作库中的10种动作和0.25–1幅度，默认50万步，8192步用于流程快检。草案只回显配置。',
  inputSchema: {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer', const: 1, default: 1 },
      title: { type: 'string', minLength: 1, maxLength: 80 },
      bpm: { type: 'number', minimum: 80, maximum: 140 },
      sections: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: DANCE_SECTION_TYPES,
            },
            beats: { type: 'integer', enum: [4, 8, 16] },
            intensity: { type: 'number', minimum: 0.25, maximum: 1 },
          },
          required: ['type', 'beats', 'intensity'],
          additionalProperties: false,
        },
      },
      seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
      trainingSteps: { type: 'integer', minimum: 8192, maximum: 2000000, default: 500000 },
    },
    required: ['title', 'bpm', 'sections'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const danceFields = ORIGINMAN_DANCE_DRAFT_TOOL.inputSchema.properties;
const sectionFields = danceFields.sections.items.properties;
const danceSchema = DANCE_TRAINING_TOOLS[0].inputSchema.properties.dance;
const runIdField = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$' };
const knownRobotNames = {
  microduck: 'MicroDuck',
  originbot: 'OriginBot',
  originman: 'OriginMan',
  'rdk-duck': 'RDK Duck',
  custom: '通用 RDK 设备',
};
const trainingModes = ['reinforcement', 'imitation'];
const learningEngines = ['starter-ppo', 'act', 'diffusion-policy'];

function genericTraining(answers, robotId) {
  const mode = answers.task;
  const imitation = mode === 'imitation';
  const label = imitation ? '模仿学习' : '强化学习';
  const recipe = { mode, readiness: 'unverified' };
  const target = robotId ?? (answers.robot ? 'custom' : null);
  if (answers.target === 'hardware')
    return {
      platformView: 'deploy/preflight',
      robotId: target,
      studentReply: '训练和真机部署需要分别核对。先选择设备和已发布的策略文件，进行只读部署预检。',
    };
  if (!target)
    return {
      platformView: 'overview',
      recipe,
      studentReply: `先在工作台选择要做${label}的机器人。确认机型后，可查看适配的任务、训练引擎和算力。`,
    };
  if (target === 'custom' || target === 'rdk-duck' || target === 'originman')
    return {
      platformView: 'train/prepare',
      robotId: target,
      recipe,
      studentReply:
        target === 'originman' && !imitation
          ? 'OriginMan 有舞蹈和受扰恢复两个仿真课程。先选择目标并核对对应策略契约，进入相应课程后再选算力。'
          : `先在${knownRobotNames[target]}的「模型与契约」核对观测、动作和频率，再确认${label}的任务、数据与 Worker 支持。当前适配和资源状态待检查。`,
    };
  if (imitation) {
    const engine = answers.engine ?? 'act';
    if (!['act', 'diffusion-policy'].includes(engine))
      throw Error('模仿学习的此入口支持 ACT 或 Diffusion Policy。请选择与示教数据匹配的引擎。');
    const engineLabel = engine === 'act' ? 'ACT' : 'Diffusion Policy';
    return {
      platformView: 'train/configure',
      robotId: target,
      recipe: {
        ...recipe,
        engine,
        requirements: {
          demonstrations: true,
          minimumEpisodes: 8,
          minimumFramesPerEpisode: 4,
          serverWorker: true,
        },
      },
      studentReply: `${knownRobotNames[target]}模仿学习可用 ${engineLabel} 做向量示教训练。先选择与模型契约和项目一致的原始示教 Run。至少 8 个完整回合，每回合至少 4 帧，包含观测、动作和回合结束标记。数据和服务端 Worker 的可用性待检查。`,
    };
  }
  const engine = target === 'originbot' ? 'starter-ppo' : null;
  return {
    platformView: 'train/configure',
    robotId: target,
    recipe: { ...recipe, ...(engine && { engine, taskId: 'goal-navigation' }) },
    studentReply:
      target === 'originbot'
        ? 'OriginBot 可从目标导航的 Starter PPO 开始。训练用仿真采样，先核对导航策略契约、训练引擎和可用 Worker。'
        : 'MicroDuck 强化学习先选任务和仿真环境。步态入门与真实物理训练所需的引擎和算力不同，请在训练配置中核对可用 Worker。',
  };
}

const learningFields = {
  intent: { type: 'string', enum: ['start', 'new', 'results', 'retry'] },
  task: {
    type: 'string',
    enum: [
      'overview',
      'datasets',
      'simulation',
      'reinforcement',
      'imitation',
      'evaluation',
      'replay',
      'deployment',
      'dance',
      'recovery',
    ],
  },
  robot: { type: 'string', minLength: 1, maxLength: 120 },
  productId: {
    type: 'string',
    enum: Object.keys(knownRobotNames),
    description: '工作台机型 ID。也可用 robot 提供机型名称。',
  },
  engine: { type: 'string', enum: learningEngines },
  runId: runIdField,
  section: { type: 'integer', minimum: 1, maximum: 8 },
  contextId: runIdField,
  modelId: { type: 'string', minLength: 1, maxLength: 160 },
  dance: danceSchema,
  changes: { ...danceSchema, required: [] },
  sectionEdits: {
    type: 'array',
    minItems: 1,
    maxItems: 8,
    items: {
      type: 'object',
      properties: { section: { type: 'integer', minimum: 1, maximum: 8 }, ...sectionFields },
      required: ['section'],
      additionalProperties: false,
    },
  },
  numEnvs: { type: 'integer', minimum: 1, maximum: 64 },
  target: { type: 'string', enum: ['simulation', 'hardware'] },
  movement: sectionFields.type,
  bpm: danceFields.bpm,
  beats: sectionFields.beats,
  intensity: sectionFields.intensity,
  computeResourceId: { type: 'string', minLength: 1, maxLength: 160 },
  trainingSteps: { type: 'integer', minimum: 8192, maximum: 2000000 },
  confirmed: { type: 'boolean' },
};

export const LEARNING_GUIDE_TOOL = {
  name: 'rdk_learning_guide',
  description:
    '看舞蹈结果、问下一轮怎么调或指定第几段时，用 intent:results、原 runId 和可选 section。按逐段评测给出单变量建议，用户要求采用时才预览。机器人学习的默认引导。通用强化学习、模仿学习请传已知机型；明确选择 ACT 或扩散策略时传 engine。重新开始用 intent:new；继续或看看效果用 intent:results，有实验标识传 contextId，有运行标识传 runId，均未知时提供账号内最近记录供选择。舞蹈改参用 intent:retry 和原 runId，changes 只传要改的字段，单段用 sectionEdits（段号从1开始），支持 modelId、numEnvs、computeResourceId。每次只补一个缺项；仅在用户确认当前配方并要求开始时传 confirmed:true。此工具只读。',
  inputSchema: { type: 'object', properties: learningFields, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export function validateLearningGuideArgs(answers = {}) {
  const invalid = (message, nextAction) =>
    new PluginRequestError('INVALID_LEARNING_GUIDE_ARGUMENT', message, {
      httpStatus: 400,
      nextAction,
    });
  if (!answers || typeof answers !== 'object' || Array.isArray(answers))
    throw invalid('请传入对象形式的课程选项。', '使用 rdk_learning_guide 的参数表重新调用。');
  for (const [key, value] of Object.entries(answers)) {
    const rule = Object.hasOwn(learningFields, key) ? learningFields[key] : null;
    const type = rule?.type === 'integer' ? 'number' : rule?.type;
    if (
      !rule ||
      (type === 'array' ? !Array.isArray(value) : typeof value !== type) ||
      (rule.enum && !rule.enum.includes(value)) ||
      (type === 'object' && (!value || Array.isArray(value))) ||
      (type === 'array' && (value.length < 1 || value.length > 8)) ||
      (type === 'number' &&
        (!Number.isFinite(value) ||
          value < rule.minimum ||
          value > rule.maximum ||
          (rule.type === 'integer' && !Number.isSafeInteger(value)))) ||
      (type === 'string' &&
        (!value.trim() ||
          value.length > (rule.maxLength ?? 160) ||
          (rule.pattern && !new RegExp(rule.pattern).test(value))))
    ) {
      const allowed = rule?.enum ?? (key === 'taskId' ? learningFields.task.enum : null);
      const field = key === 'taskId' ? 'task' : key;
      throw invalid(
        key === 'taskId' ? '课程引导使用 task 字段选择目标。' : '选项不符合课程范围：' + key,
        allowed
          ? `请传入 ${field}，可选值：${allowed.join('、')}。`
          : '按 rdk_learning_guide 的参数表检查字段名称、格式和范围。',
      );
    }
  }
  if (!answers.productId) return answers;
  const robotId = answers.robot?.trim().toLowerCase().replace(/\s+/g, '-');
  if (
    robotId &&
    robotId !== answers.productId &&
    answers.robot?.trim() !== knownRobotNames[answers.productId]
  )
    throw invalid(
      'productId 和 robot 指向不同机型。',
      '只传 productId 或使用同一机型的 robot 名称。',
    );
  return { ...answers, robot: answers.productId };
}

export function learningGuide(answers = {}, { operationId, previous } = {}) {
  answers = validateLearningGuideArgs(answers);
  const progress = (stage, studentReply, extra = {}) => ({
    stage,
    studentReply,
    target: answers.target ?? null,
    trainingSubmitted: false,
    motionAuthorized: false,
    ...extra,
  });
  if (answers.sectionEdits && answers.intent !== 'retry')
    throw Error('逐段修改需要指定原舞蹈 Run。');
  if ((answers.task === 'dance' || answers.intent === 'retry') && answers.target === 'hardware')
    return progress(
      'hardware-dance-unavailable',
      '当前舞蹈课程支持仿真。若要检查真机接入，请先打开部署工作台查看板卡和策略契约。',
      {
        platformView: 'deploy',
      },
    );
  if (answers.intent === 'retry') {
    if (!previous?.dance || !previous.computeResourceId || !previous.numEnvs)
      return progress(
        'retry-source',
        '这条 Run 缺少完整的原配置。请在详情页核对编舞和算力，再开始新一轮。',
      );
    const before = danceInput(previous.dance);
    const changes = answers.changes ?? {};
    if (answers.sectionEdits && changes.sections)
      throw Error('请在逐段修改和替换完整舞段之间选一种。');
    const sections = answers.sectionEdits
      ? editDanceSections(before.sections, answers.sectionEdits)
      : changes.sections;
    const after = danceInput({
      ...before,
      ...changes,
      ...(sections && { sections }),
      ...(changes.rewardTuning
        ? { rewardTuning: { ...before.rewardTuning, ...changes.rewardTuning } }
        : {}),
    });
    const computeResourceId = answers.computeResourceId ?? previous.computeResourceId;
    const numEnvs = answers.numEnvs ?? previous.numEnvs;
    const modelId = answers.modelId ?? previous.modelId;
    const changed = Object.keys(after).filter(
      (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
    );
    if (numEnvs !== previous.numEnvs) changed.push('numEnvs');
    if (computeResourceId !== previous.computeResourceId) changed.push('computeResourceId');
    if (modelId !== previous.modelId) changed.push('modelId');
    if (!changed.length)
      return progress('retry-change', '这一轮想改哪一项？例如训练步数、动作幅度或并行环境数。');
    const labels = {
      title: '名称',
      bpm: '节拍',
      sections: '舞段',
      seed: '种子',
      trainingSteps: '训练步数',
      rewardTuning: '奖励配置',
      numEnvs: '并行环境数',
      computeResourceId: '算力机',
      modelId: '模型',
    };
    const from = {
      ...before,
      computeResourceId: previous.computeResourceId,
      numEnvs: previous.numEnvs,
      modelId: previous.modelId,
    };
    const to = { ...after, computeResourceId, numEnvs, modelId };
    const delta = changed.map((key) => ({ label: labels[key], before: from[key], after: to[key] }));
    const unchangedSections = answers.sectionEdits
      ? before.sections.filter(
          (item, index) => JSON.stringify(item) === JSON.stringify(after.sections[index]),
        ).length
      : null;
    const sectionsText = (sections) =>
      sections
        .map(
          ({ type, beats, intensity }) => `${sectionTitles[type]} ${beats} 拍（幅度 ${intensity}）`,
        )
        .join('、');
    const summary = delta
      .map(({ label, before, after }) => {
        if (label === '舞段' && answers.sectionEdits)
          return answers.sectionEdits
            .filter(
              ({ section }) =>
                JSON.stringify(before[section - 1]) !== JSON.stringify(after[section - 1]),
            )
            .map(
              ({ section }) =>
                `第 ${section} 段 ${sectionsText([before[section - 1]])} → ${sectionsText([after[section - 1]])}`,
            )
            .join('、');
        if (label === '舞段') return `舞段由 ${sectionsText(before)} 改为 ${sectionsText(after)}`;
        if (label === '奖励配置')
          return Object.keys(after ?? {})
            .filter((key) => before?.[key] !== after[key])
            .map((key) => rewardChangeText(key, before?.[key], after[key]))
            .join('、');
        if (label === '算力机' || label === '模型')
          return `${label} ${before ?? '未指定'} → ${after}`;
        return `${label} ${before} → ${after}`;
      })
      .join('、');
    if (!answers.confirmed)
      return progress(
        'retry-confirm',
        `本轮调整：${summary}。${unchangedSections === null ? '' : `其余 ${unchangedSections} 段保持原样。`}请核对这项改动。确认开始后会新建一条 Run，保留原 Run 供对照。`,
        {
          changes: delta,
          ...(unchangedSections !== null && { unchangedSections }),
          delivery: '展示 studentReply 中的原值、新值和保留项，然后等用户确认。',
        },
      );
    const contextId =
      'om-' +
      createHash('sha256')
        .update(JSON.stringify([answers.runId, to]))
        .digest('hex')
        .slice(0, 20);
    return progress('ready', `已确认${summary}。下一步检查算力并提交新一轮仿真训练。`, {
      changes: delta,
      nextTool: 'rdk_originman_dance_train',
      nextArguments: {
        contextId,
        computeResourceId,
        numEnvs,
        dance: after,
        previousRunId: answers.runId,
        ...(modelId ? { modelId } : {}),
      },
    });
  }
  if (!answers.task)
    return progress(
      'task',
      '你想从哪一步开始？可以试仿真和录制、训练策略、评测和回放，或做真机部署预检。',
    );
  const robotKey = answers.robot?.trim().toLowerCase().replace(/\s+/g, '-');
  const robotId = Object.hasOwn(knownRobotNames, robotKey) ? robotKey : null;
  if (trainingModes.includes(answers.task)) {
    const { studentReply, ...context } = genericTraining(answers, robotId);
    return progress('platform-training', studentReply, {
      ...context,
      robot: answers.robot ?? null,
    });
  }
  const platformTasks = {
    datasets: [
      'records',
      '在「证据与记录」选择上传数据集，或在数据集详情下载已托管文件。平台文件需要登录后操作。',
    ],
    overview: ['overview', '打开工作台后，可以按机型和任务选择仿真、训练或评测。'],
    simulation: ['simulate', '在仿真工作台选择机器人和场景，可以试玩或录制动作。'],
    evaluation: ['evaluate', '在评测工作台选定策略和评测条件，再查看本轮结果。'],
    replay: ['records', '在记录工作台选择要查看的轨迹或运行。'],
    deployment: [
      'deploy/preflight',
      '先核对指定设备、板端服务与已发布策略的兼容性，再做只读部署预检。真机是否就绪以现场回执为准。',
    ],
  };
  if (Object.hasOwn(platformTasks, answers.task)) {
    const [platformView, reply] = platformTasks[answers.task];
    if (answers.robot && !robotId && !['overview', 'deployment', 'datasets'].includes(answers.task))
      return progress(
        'platform-task',
        '这台机器人需要先核对自定义策略契约和适配器，再继续选择仿真、评测或回放。',
        {
          platformView: 'train/prepare',
          robotId: 'custom',
        },
      );
    return progress('platform-task', reply, {
      platformView,
      robotId: robotId ?? (answers.robot ? 'custom' : null),
      robot: answers.robot ?? null,
    });
  }
  if (answers.task === 'recovery')
    return progress('recovery', '先打开受扰恢复课程，看看参考动作。', {
      nextTool: 'rdk_workshop',
      nextArguments: { intent: answers.intent === 'new' ? 'new' : 'start', course: 'recovery' },
    });
  if (!answers.dance && !answers.movement) {
    const availableActions = DANCE_SECTION_TYPES.map((type) => ({
      type,
      label: sectionTitles[type],
    }));
    return progress(
      'movement',
      `OriginMan 舞蹈支持 ${availableActions.length} 种仿真动作：${availableActions.map(({ label }) => label).join('、')}。可以从左右交替摆臂开始。`,
      { availableActions },
    );
  }
  if (!answers.dance && answers.bpm === undefined)
    return progress('bpm', '这段舞想用多少 BPM？可以先试 100 BPM。');
  if (!answers.dance && answers.beats === undefined)
    return progress('beats', '这段舞要跳 4 拍、8 拍还是 16 拍？');
  if (!answers.dance && answers.intensity === undefined)
    return progress('intensity', '动作幅度想先用小幅（0.25），还是半幅（0.5）？');
  if (!answers.computeResourceId)
    return progress('compute', '接下来你想用哪台支持舞蹈训练的算力机？', {
      nextTool: 'rdk_development_targets',
      nextArguments: { action: 'list-compute', engine: 'originman-dance-ppo' },
      resumeArguments: { ...answers, confirmed: false },
    });
  if (answers.trainingSteps === undefined && answers.dance?.trainingSteps === undefined)
    return progress(
      'budget',
      '你想先用 8192 步检查流程能否跑通，还是用 50 万步训练后再看舞蹈效果？',
    );

  const dance = danceInput({
    schemaVersion: 1,
    ...(answers.dance ?? {
      title: sectionTitles[answers.movement],
      bpm: answers.bpm,
      sections: [{ type: answers.movement, beats: answers.beats, intensity: answers.intensity }],
    }),
    trainingSteps: answers.trainingSteps ?? answers.dance?.trainingSteps,
  });
  const numEnvs = answers.numEnvs ?? 64;
  const recipe = `${dance.title}，${dance.bpm} BPM，${dance.sections.map(({ type, beats, intensity }) => `${sectionTitles[type]} ${beats} 拍（幅度 ${intensity}）`).join('、')}，${dance.trainingSteps.toLocaleString('zh-CN')} 步 PPO，${numEnvs} 个并行环境`;
  if (!answers.confirmed)
    return progress('confirm', `本轮配方是${recipe}。现在开始训练吗？`, { dance });
  return progress('ready', `已确认${recipe}。接下来检查你选的算力并启动本轮仿真训练。`, {
    nextTool: 'rdk_originman_dance_train',
    nextArguments: {
      contextId: operationId,
      computeResourceId: answers.computeResourceId,
      ...(answers.modelId ? { modelId: answers.modelId } : {}),
      numEnvs,
      dance,
    },
    dance,
    computeResourceId: answers.computeResourceId,
  });
}

export const sectionTitles = DANCE_SECTION_LABELS;

function editDanceSections(sections, edits) {
  const updated = sections.slice();
  const seen = new Set();
  for (const edit of edits) {
    const { section, ...fields } = edit ?? {};
    const keys = Object.keys(fields);
    if (
      !Number.isSafeInteger(section) ||
      section < 1 ||
      section > updated.length ||
      seen.has(section) ||
      !keys.length ||
      keys.some((key) => !Object.hasOwn(sectionFields, key))
    )
      throw Error('逐段修改需指定不重复的有效段号，并传要改的动作、拍数或幅度。');
    seen.add(section);
    updated[section - 1] = { ...updated[section - 1], ...fields };
  }
  return updated;
}

function danceInput(value) {
  const { kind, scope, totalBeats, ...input } = resolveOriginmanDanceConfig(value);
  return input;
}

export function originmanDanceDraft(args = {}) {
  const config =
    args && typeof args === 'object' && !Array.isArray(args) && args.schemaVersion === undefined
      ? { ...args, schemaVersion: danceFields.schemaVersion.default }
      : args;
  const draft = resolveOriginmanDanceConfig(config);
  const sections = draft.sections
    .map(({ type, beats, intensity }) => `${sectionTitles[type]} ${beats} 拍（幅度 ${intensity}）`)
    .join('、');
  return {
    scope: 'configuration-only',
    motionAuthorized: false,
    trainingSubmitted: false,
    qualityClaimAllowed: false,
    draft,
    studentReply: `训练配方预览：${draft.title}，${draft.bpm} BPM，${sections}，共 ${draft.totalBeats} 拍。计划采样 ${draft.trainingSteps.toLocaleString('zh-CN')} 步。当前仅预览，尚未提交训练。`,
    nextAction:
      '保留草案作为课程设计输入；只有舞蹈训练Worker、模型合同、同源评测和回放接通并验收后，才可改为真实训练流程。',
  };
}

export const COURSE_BRIEF_TOOL = {
  name: 'rdk_originman_course_brief',
  description:
    '只读本地两句中文简答：解释8192快检与50万正式训练、训练步/迭代单位、流程完成与效果达标/回放待验的区别。学员咨询这些口径时优先调用并原样展示studentReply，不重复读课程或历史资料；不登录、不提交任务。实际实验成绩仍须读原评测。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
export function courseBrief(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
    throw Error('简答无需参数；实际结果请指定原实验读取。');
  return {
    scope: 'local-course-explanation-only',
    motionAuthorized: false,
    studentReply:
      '恢复课8192步用于流程快检、50万步用于效果对比；舞蹈课默认50万步，8192步只作明确要求的链路快检。\nRun完成不等于风格达标；舞蹈轨迹仍是回放待验，真机效果需单独验收。',
    delivery:
      '原样展示studentReply两句，不另加标题、数字倍率、历史成绩或下一步问题，不读取更多资料；用户明确追问依据时才按需读取workshop-training-evidence.md。实际成绩必须读本轮同源评测，不能从预算推出。',
  };
}

/** Local choice only: does not authenticate, submit training or authorize hardware. */
export const TRAINING_CHOICE_TOOL = {
  name: 'rdk_originman_training_choice',
  description:
    '独立预算咨询或高级手动训练的中文引导；默认开始Workshop用rdk_workshop页面按钮，不先调用本问答：未选择时只问8192步快检还是50万步正式效果实验；已明确短训/8192或正式/50万时传对应choice避免重问。不清楚传unknown并暂停，不自动选择或提交，不需登录。',
  inputSchema: {
    type: 'object',
    properties: { choice: { type: 'string', enum: ['quick', 'formal', 'unknown'] } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
export function trainingChoice(args = {}) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => k !== 'choice') ||
    (args.choice !== undefined && !['quick', 'formal', 'unknown'].includes(args.choice))
  )
    throw Error('请选择快检、正式训练或不清楚；不猜测训练预算。');
  const selected = ['quick', 'formal'].includes(args.choice);
  const formal = args.choice === 'formal';
  return {
    scope: 'simulation-only',
    state: selected ? 'selected' : args.choice === 'unknown' ? 'deferred' : 'needs-input',
    needsInput: args.choice === undefined,
    selection: selected ? args.choice : null,
    timesteps: selected ? (formal ? 500000 : 8192) : null,
    trainTool: selected ? (formal ? 'rdk_originman_train' : 'rdk_originman_short_train') : null,
    evaluateTool: selected
      ? formal
        ? 'rdk_originman_evaluate'
        : 'rdk_originman_short_evaluate'
      : null,
    qualityClaimAllowed: false,
    motionAuthorized: false,
    studentReply: selected
      ? formal
        ? '已选50万步正式效果实验。训练后须同条件评测并对比基线，实际达标才报告效果通过；不保证提升。本轮仅仿真。'
        : '已选8192步快检。只验证训练、评测与回放链路；策略可能弱于基线，流程完成不算效果达标。本轮仅仿真。'
      : args.choice === 'unknown'
        ? '先不训练。8192步用于熟悉流程；50万步用于正式效果对比，耗时取决于资源。准备好后回复“快检”或“正式”。'
        : '这次选哪种训练？①8192步快检：验证流程，不要求效果提升；②50万步正式训练：评测是否优于基线，耗时更长；③不清楚，先说明。',
    nextAction: selected
      ? '保留已选预算，按用户授权范围执行；需要新训练时从experience_guide取得新contextId。正式工具显式传timesteps=500000，评测沿用原实验。仅选择不代表已经提交；用户说先不要开始时不得提交。'
      : '只展示studentReply并结束本轮；未选预算或回答不清楚时不调用训练工具、不生成默认预算。',
  };
}

/** Learner-facing scope shared by runtime instructions and the course guide. */
export const ORIGINMAN_COURSE = {
  id: 'originman-workshop',
  title: 'OriginMan 仿真受扰恢复 Workshop',
  scope: 'simulation-only',
  stages: [
    {
      id: 'observe',
      title: '观察参考仿真',
      nextAction: '打开本课程参考仿真，先看站姿和受扰恢复，明确标注参考结果。',
    },
    {
      id: 'train',
      title: '训练本组策略',
      nextAction: '先检查当前账号与明确课程资源，按学员选择的实验预算提交一次。',
    },
    {
      id: 'evaluate',
      title: '同源仿真评测',
      nextAction: '读取本组训练权重，冻结评测条件，对比原PD、调参反馈和本次RL。',
    },
    {
      id: 'replay-export',
      title: '回放与保存',
      nextAction: '打开本次评测回放，提供下载评测记录和离线图文与回放入口。',
    },
    {
      id: 'tune',
      title: '单变量调参',
      optional: true,
      nextAction: '学员要求继续时，保留原实验，复制参数建立新实验，只改训练步数或训练侧推上限。',
    },
  ],
  trainingChoice: {
    tool: TRAINING_CHOICE_TOOL.name,
    default: null,
    options: ['quick', 'formal', 'unknown'],
  },
  shortTraining: {
    purpose: 'workflow-check',
    timesteps: 8192,
    note: '快速熟悉流程，不保证策略提升；50万步是效果实验预算，不能未经请求自动延长。',
  },
  completion:
    '本课完成条件不包含真机部署；确认本组实验来源，解释同条件评测，查看回放并提供保存入口。播放与下载是否完成以宿主实际观察为准。',
  responseRules: [
    '预算用途、计数单位、完成标准等简短咨询优先rdk_originman_course_brief，仅逐字展示studentReply两句；不再读指南和证据全文。明确追问依据才按需展开；不能编造倍率或把历史成绩当本组结果。',
    '没有实际播放时，只能说训练与评测完成、回放待验证，不能说完整Workshop或全流程通过。Qoder提示外部Browser Connector未连接时保留原实验，不重训；学员可点任务右侧产出中的网页查询，打开内置实验页后手动播放。人工点击验收与模型自动播放分别记录，不要求为阅读已有结果重新登录CLI。',

    '舞蹈训练默认50万训练步、64个并行环境；每个环境每轮最多采256步，并行数超过16时缩短每环境采样长度，使每轮总采样量最多为4096步，预算按整轮向上取整。默认并行数下，50万步预算对应123轮、503808步，8192步快检对应2轮。训练步、PPO迭代、梯度更新分别报告，不相互换算冒充。',

    '训练预算必须由学员明确选择。默认Workshop在rdk_workshop页面点预算按钮，不在聊天重复询问。只有高级手动流程才调用rdk_originman_training_choice；已有明确短训、8192、正式或50万时传已知choice，不重复问。未知只说明并暂停，不提交。用户只咨询不开始训练。',
    '分别报告流程执行、仿真效果、实体效果。快检完成只算流程通过；正式训练completed也不算效果通过，须本轮同源评测sourceVerified和clearGain=true，并展示两组实际基线与RL恢复数；未评测待验证、未提升明确未达标、来源不符停止结论。回放只展示其中一个条件，不代替62条件评测。',
    '新平台的experiment_resume返回links.experiment时，优先由宿主打开这个明确实验页查看实时曲线、同源比较与回放；同一账号可跨Studio、Qoder和网页恢复原实验。persistence.sharedAcrossHosts=false时仅为本机引用，不声称跨机器同步。',
    '正式预算用rdk_originman_train显式传timesteps（例如500000），随后rdk_originman_evaluate沿用原训练参数读取既有权重；不要把正式预算传给固定8192短训工具。单变量调参须新contextId，保留原实验。',
    '结果与导出页用course.links.comparison；不要猜#compare。页面打开不保证选中本次Run；先核对训练和评测选择器再播放或点课程内置导出。离线HTML须含真实视频字节，0字节或引用不存在的视频文件不能算保存成功。',
    '结果计数相同不能证明评测条件相同；必须逐条核对条件及两种基线。同一父Run的重复评测不是独立训练样本。',
    'Worker端口是平台侧地址，127.0.0.1不证明GPU与平台同机，也不证明两条在线资源是独立GPU；并发槽不能直接当课堂GPU容量。Worker在线不等于SSH可用。',
    '用户询问本课程能做什么时，介绍本课程步骤和首个动作；插件通用能力使用学习平台能力概览。',
    'OriginMan自定义舞蹈与受扰恢复是两条独立课程链路。用户只要整理舞段时调用rdk_originman_dance_draft；明确要求训练时，按rdk_experience_guide拿到operation.contextId后调用rdk_originman_dance_train，保留学员描述的节奏和动作段。该工具先验证专用78→18模型契约、当前账号资源与Worker已注册originman-dance-ppo，再用同一幂等键提交一次。默认50万训练步、64个并行环境；只有学员明确选择快检时才传8192步。提交后以原Run调用rdk_training_wait至终态，读取本次qualityGate、SHA、舞蹈回放和来源；训练完成不等于风格通过。若资源未证明引擎可用，停止并返回明确原因，不切到恢复任务。舞蹈策略仍仅仿真；模型场景来源、网格摘要、授权、真机关节标定和现场安全验收分别核实，不声称可以部署。',
    '默认只说当前进度、本次结果、下一步；UUID、工具名、manifest和错误码放技术详情，学员不用抄标识。',
    '按每条Run的phase区分训练与评测，Run总数不是训练成功数；只描述已核对且绑定本次实验的状态。',
    '参考结果、历史结果、本组本轮结果必须分开标注；全局golden_path不能作为本课完成比例。',
    '不要把仿真评测称为真机评测，不把仿真成功称为Sim2Real成功，不默认推荐板端部署预检。',
    '账号身份、Worker连通、任务依赖就绪、开发机SSH和宿主原生计算接口分别判断；nativeCompute缺失不等于本地无法训练。',
    '已提交任务的引用保存失败时，禁止重复提交，按回执原Run只读查询；不能将禁止重交解释为禁止查询。没有可核对引用时保留未知状态，交维护者恢复。',
    '需要课程能力介绍时先读本指南，不为泛泛介绍调用部署、运动、全网或官方文档工具；通用平台能力与本课可完成范围分开说明。',
    '默认按钮课程播放明确标注的讲师参考，也可自由探索参考仿真；参考不算本组结果。用户明确要求实时参考时，打开course.links.simulation并实际启动观察，再训练；页面失败先排查，不先训练再补看。讲师参考不算本组结果。referenceVideo仅为原始媒体，不直接导航媒体文件，也不拼接apiPrefix。',
    'OriginMan评测视频与通用遥测样本是两种证据；rdk_runs_replay样本为0不能推出评测视频不存在。引用保存失败先用原训练与评测Run恢复关联，不新提交，核对本次视频回执再提供入口。',
    'Worker连通不等于任务依赖预检通过；没有任务环境证据时只报告连通已验证，不能说训练无阻塞。新实验短训未提升时先报告本轮数据；历史同配方预算对照只作为历史解释，不代替本轮诊断，不承诺50万步必然改善。',
  ],
};

export const ORIGINMAN_COURSE_INSTRUCTIONS =
  '\nOriginMan学员课程口径（优先于平台通用全链路介绍，仅用于本课程）：\n' +
  ORIGINMAN_COURSE.completion +
  '\n' +
  ORIGINMAN_COURSE.stages.map((s) => s.title + (s.optional ? '（可选）' : '')).join(' → ') +
  '。\n' +
  ORIGINMAN_COURSE.shortTraining.note +
  '\n' +
  ORIGINMAN_COURSE.responseRules.join('\n');

export function courseLinks(baseUrl) {
  if (!baseUrl) return {};
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('课程入口需要不含凭据的明确平台地址。');
  const root = base.toString().replace(/\/+$/, '');
  return {
    referenceVideo: root + '/api/sim2real/workshops/originman/reference-video?format=webm',
    simulation: root + '/?robot=originman#simulate',
    comparison: root + '/?robot=originman#evaluate/comparison',
    playbackPage: root + '/?robot=originman#evaluate/comparison',
    preferredPlayback: 'page-player',
    training: root + '/?robot=originman#train/submit',
    note: '回放优先使用playbackPage，在页面内核对并选择本次训练与评测，再展开播放器。不要直接导航媒体URL。referenceVideo为讲师参考，非本组结果；链接存在不证明已打开或播放。',
  };
}

export function courseToolHint(name) {
  if (name === 'rdk_training_submit')
    return 'OriginMan课程优先rdk_originman_train显式选择预算，再rdk_originman_evaluate同源评测；不手拼SAC大小写、环境数、sourceRunId或groupId。\n';
  if (name === 'rdk_artifact_promote')
    return '这是制品发布生命周期晋升，不是保存或下载文件。OriginMan保存评测记录使用links.experiment页面的保存按钮；不要因用户说保存、导出或回放而调用晋升。\n';
  if (name === 'rdk_runs_replay')
    return '查询通用遥测帧。查看原 Run 的已有仿真视频、ONNX 留存或策略下载链接时，优先选择 rdk_training_wait。通用遥测为零时仍可能有仿真视频。\n';
  if (name === 'rdk_training_status')
    return '基础训练状态查询。用户给出原 Run 并要 ONNX 留存、下载链接或仿真回放时，先发现并调用 rdk_training_wait。\n';
  if (name === 'rdk_lineage_get' || name === 'rdk_artifacts_list')
    return '查询血缘或登记记录。按原 Run 查询 ONNX 留存状态及可点击下载链接，应调用 rdk_training_wait。\n';
  if (name === 'rdk_simulator_open')
    return 'OriginMan参考演示与本组回放不同：打开course.links.simulation，在页面内启动并观察基础PD；entryUrl不是已运行证明。不直接导航WebM，参考不需要先训练。\n';
  if (name === 'rdk_golden_path')
    return 'OriginMan仅仿真课程：此全局平台摘要不能作为本课完成比例，不用其他实验或部署状态替代本次结果。\n';
  if (/^rdk_(deployment_|board_|physical_evaluation|replay_video)/.test(name))
    return 'OriginMan本课仅仿真：此通用硬件能力不属于本课下一步，不因本课仿真完成自动调用；仅在用户独立明确要求对应硬件工作时使用。\n';
  return '';
}

/** Separate verifiable execution from the recorded simulation quality criterion. */
export function trainingVerdict({ status, sourceVerified, clearGain, suites = [] }) {
  const comparable =
    suites.length === 2 &&
    suites.every(
      (s) =>
        s.caseCount === 31 &&
        ['originalRecovered', 'tunedRecovered', 'rlRecovered'].every(
          (k) => Number.isInteger(s[k]) && s[k] >= 0 && s[k] <= s.caseCount,
        ),
    );
  const consistentGain =
    comparable &&
    suites.every((s) => s.rlRecovered > s.originalRecovered && s.rlRecovered > s.tunedRecovered);
  return {
    execution:
      status === 'completed'
        ? 'completed'
        : ['failed', 'blocked', 'cancelled', 'canceled'].includes(status)
          ? 'failed'
          : 'pending',
    quality:
      status !== 'completed' || !sourceVerified
        ? 'pending'
        : clearGain === false
          ? 'not-met'
          : clearGain === true && consistentGain
            ? 'met'
            : 'pending',
    hardware: 'unverified',
    criterion: '本轮同源、两组各31条件的记录收益判据；不外推未知条件或真机。',
  };
}
