import { resolveOriginmanDanceConfig } from './originman-dance-config.mjs';

export const ORIGINMAN_DANCE_DRAFT_TOOL = {
  name: 'rdk_originman_dance_draft',
  description:
    '把学员确认过的简单舞蹈编排整理成有界草案：节奏80–140 BPM，每段4/8/16拍，舞段限交替摆臂、左右换重心、下蹲起身、展开定格，强度0.25–1，训练预算默认50万步（8192步可显式用于链路快检）。此工具只回显配置；学员明确要训练时，另用rdk_originman_dance_train检查当前模型、资源和Worker引擎并提交仿真Run。草案自身不训练、不声称效果，也不授权真机动作。',
  inputSchema: {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
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
              enum: ['alternating-arms', 'weight-shift', 'squat-rise', 'open-pose'],
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
    required: ['schemaVersion', 'title', 'bpm', 'sections'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const danceFields = ORIGINMAN_DANCE_DRAFT_TOOL.inputSchema.properties;
const sectionFields = danceFields.sections.items.properties;
const learningFields = {
  task: { type: 'string', enum: ['dance', 'recovery'] },
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
    '新手开始强化学习的默认入口。携带用户已经明确的选择，每轮返回一个缺项或下一步。task不明先选任务；最终上真机传target=hardware。仅在用户确认本版配方并要求开始时传confirmed=true。只整理计划，不发起登录、训练或设备操作。',
  inputSchema: { type: 'object', properties: learningFields, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export function learningGuide(answers = {}) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers))
    throw Error('请传入学员已确认的选项。');
  for (const [key, value] of Object.entries(answers)) {
    const rule = Object.hasOwn(learningFields, key) ? learningFields[key] : null;
    const type = rule?.type === 'integer' ? 'number' : rule?.type;
    if (
      !rule ||
      typeof value !== type ||
      (rule.enum && !rule.enum.includes(value)) ||
      (type === 'number' &&
        (!Number.isFinite(value) ||
          value < rule.minimum ||
          value > rule.maximum ||
          (rule.type === 'integer' && !Number.isSafeInteger(value)))) ||
      (type === 'string' && (!value.trim() || value.length > (rule.maxLength ?? 160)))
    )
      throw Error('选项不符合课程范围：' + key);
  }
  const progress = (stage, studentReply, extra = {}) => ({
    stage,
    studentReply,
    target: answers.target ?? null,
    trainingSubmitted: false,
    motionAuthorized: false,
    ...extra,
  });
  if (!answers.task) return progress('task', '你想先练 OriginMan 跳舞，还是练被推后重新站稳？');
  if (answers.task === 'recovery')
    return progress('recovery', '先打开受扰恢复课程，看看参考动作。', {
      nextTool: 'rdk_workshop',
    });
  if (!answers.movement) return progress('movement', '第一段舞想做什么？可以从左右交替摆臂开始。');
  if (answers.bpm === undefined) return progress('bpm', '这段舞想用多少 BPM？可以先试 100 BPM。');
  if (answers.beats === undefined) return progress('beats', '这段舞要跳 4 拍、8 拍还是 16 拍？');
  if (answers.intensity === undefined)
    return progress('intensity', '动作幅度想先用小幅（0.25），还是半幅（0.5）？');
  if (!answers.computeResourceId)
    return progress('compute', '接下来你想用哪台支持舞蹈训练的算力机？', {
      nextTool: 'rdk_development_targets',
    });
  if (answers.trainingSteps === undefined)
    return progress('budget', '这轮先做 8192 步流程快检，还是做 50 万步正式效果实验？');

  const titles = {
    'alternating-arms': '左右交替摆臂',
    'weight-shift': '左右换重心',
    'squat-rise': '下蹲起身',
    'open-pose': '展开定格',
  };
  const dance = {
    schemaVersion: 1,
    title: titles[answers.movement],
    bpm: answers.bpm,
    sections: [{ type: answers.movement, beats: answers.beats, intensity: answers.intensity }],
    trainingSteps: answers.trainingSteps,
  };
  resolveOriginmanDanceConfig(dance);
  const recipe = `${dance.title}，${answers.bpm} BPM、${answers.beats} 拍、幅度 ${answers.intensity}、${answers.trainingSteps} 步 PPO`;
  if (!answers.confirmed)
    return progress('confirm', `本轮配方是${recipe}。现在开始训练吗？`, { dance });
  return progress('ready', `已确认${recipe}。接下来检查你选的算力并启动本轮仿真训练。`, {
    nextTool: 'rdk_originman_dance_train',
    dance,
    computeResourceId: answers.computeResourceId,
  });
}

export function originmanDanceDraft(args = {}) {
  const draft = resolveOriginmanDanceConfig(args);
  return {
    scope: 'configuration-only',
    motionAuthorized: false,
    trainingSubmitted: false,
    qualityClaimAllowed: false,
    draft,
    studentReply: `舞蹈草案已整理：${draft.title}，${draft.bpm} BPM、${draft.sections.length} 段、共 ${draft.totalBeats} 拍。它还没有提交训练；如果明确要开始，使用独立的OriginMan舞蹈仿真训练入口。训练质量和真机能力需要分别验证。`,
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

    '舞蹈训练默认50万训练步、8个并行环境；每轮采样为8×256步，预算按整轮取整，50万请求实际可达501760步。8192仅用于明确要求的链路快检（4轮采样）。训练步、PPO迭代、梯度更新分别报告，不相互换算冒充。',

    '训练预算必须由学员明确选择。默认Workshop在rdk_workshop页面点预算按钮，不在聊天重复询问。只有高级手动流程才调用rdk_originman_training_choice；已有明确短训、8192、正式或50万时传已知choice，不重复问。未知只说明并暂停，不提交。用户只咨询不开始训练。',
    '分别报告流程执行、仿真效果、实体效果。快检完成只算流程通过；正式训练completed也不算效果通过，须本轮同源评测sourceVerified和clearGain=true，并展示两组实际基线与RL恢复数；未评测待验证、未提升明确未达标、来源不符停止结论。回放只展示其中一个条件，不代替62条件评测。',
    '新平台的experiment_resume返回links.experiment时，优先由宿主打开这个明确实验页查看实时曲线、同源比较与回放；同一账号可跨Studio、Qoder和网页恢复原实验。persistence.sharedAcrossHosts=false时仅为本机引用，不声称跨机器同步。',
    '正式预算用rdk_originman_train显式传timesteps（例如500000），随后rdk_originman_evaluate沿用原训练参数读取既有权重；不要把正式预算传给固定8192短训工具。单变量调参须新contextId，保留原实验。',
    '结果与导出页用course.links.comparison；不要猜#compare。页面打开不保证选中本次Run；先核对训练和评测选择器再播放或点课程内置导出。离线HTML须含真实视频字节，0字节或引用不存在的视频文件不能算保存成功。',
    '结果计数相同不能证明评测条件相同；必须逐条核对条件及两种基线。同一父Run的重复评测不是独立训练样本。',
    'Worker端口是平台侧地址，127.0.0.1不证明GPU与平台同机，也不证明两条在线资源是独立GPU；并发槽不能直接当课堂GPU容量。Worker在线不等于SSH可用。',
    '学员问插件或平台能做什么时，先介绍本课五步和第一步参考观察；平台通用硬件能力仅在用户追问时另述，不把历史部署失败插入课程回答。',
    'OriginMan自定义舞蹈与受扰恢复是两条独立课程链路。用户只要整理舞段时调用rdk_originman_dance_draft；明确要求训练时，按rdk_experience_guide拿到operation.contextId后调用rdk_originman_dance_train，保留学员描述的节奏和动作段。该工具先验证专用78→18模型契约、当前账号资源与Worker已注册originman-dance-ppo，再用同一幂等键提交一次。默认50万训练步、8个并行环境；只有学员明确选择快检时才传8192步。提交后以原Run调用rdk_training_wait至终态，读取本次qualityGate、SHA、舞蹈回放和来源；训练完成不等于风格通过。若资源未证明引擎可用，停止并返回明确原因，不切到恢复任务。舞蹈策略仍仅仿真；模型场景来源、网格摘要、授权、真机关节标定和现场安全验收分别核实，不声称可以部署。',
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
    return 'OriginMan评测视频不依赖本工具的通用遥测样本；样本为0不能判定视频不存在。请恢复原评测引用并读取workshop视频回执。\n';
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
