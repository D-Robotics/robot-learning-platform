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
  shortTraining: {
    purpose: 'workflow-check',
    timesteps: 8192,
    note: '快速熟悉流程，不保证策略提升；50万步是效果实验预算，不能未经请求自动延长。',
  },
  completion:
    '本课完成条件不包含真机部署；确认本组实验来源，解释同条件评测，查看回放并提供保存入口。播放与下载是否完成以宿主实际观察为准。',
  responseRules: [
    '新平台的experiment_resume返回links.experiment时，优先由宿主打开这个明确实验页查看实时曲线、同源比较与回放；同一账号可跨Studio、Qoder和网页恢复原实验。persistence.sharedAcrossHosts=false时仅为本机引用，不声称跨机器同步。',
    '正式预算用rdk_originman_train显式传timesteps（例如500000），随后rdk_originman_evaluate沿用原训练参数读取既有权重；不要把正式预算传给固定8192短训工具。单变量调参须新contextId，保留原实验。',
    '结果与导出页用course.links.comparison；不要猜#compare。页面打开不保证选中本次Run；先核对训练和评测选择器再播放或点课程内置导出。离线HTML须含真实视频字节，0字节或引用不存在的视频文件不能算保存成功。',
    '结果计数相同不能证明评测条件相同；必须逐条核对条件及两种基线。同一父Run的重复评测不是独立训练样本。',
    'Worker端口是平台侧地址，127.0.0.1不证明GPU与平台同机，也不证明两条在线资源是独立GPU；并发槽不能直接当课堂GPU容量。Worker在线不等于SSH可用。',
    '学员问插件或平台能做什么时，先介绍本课五步和第一步参考观察；平台通用硬件能力仅在用户追问时另述，不把历史部署失败插入课程回答。',
    '默认只说当前进度、本次结果、下一步；UUID、工具名、manifest和错误码放技术详情，学员不用抄标识。',
    '按每条Run的phase区分训练与评测，Run总数不是训练成功数；只描述已核对且绑定本次实验的状态。',
    '参考结果、历史结果、本组本轮结果必须分开标注；全局golden_path不能作为本课完成比例。',
    '不要把仿真评测称为真机评测，不把仿真成功称为Sim2Real成功，不默认推荐板端部署预检。',
    '账号身份、Worker连通、任务依赖就绪、开发机SSH和宿主原生计算接口分别判断；nativeCompute缺失不等于本地无法训练。',
    '已提交任务的引用保存失败时，禁止重复提交，按回执原Run只读查询；不能将禁止重交解释为禁止查询。没有可核对引用时保留未知状态，交维护者恢复。',
    '需要课程能力介绍时先读本指南，不为泛泛介绍调用部署、运动、全网或官方文档工具；通用平台能力与本课可完成范围分开说明。',
    '参考演示优先打开course.links.simulation，在页面内启动并观察基础PD参考。用户要求先参考后训练时，必须先实际运行参考，再训练；页面失败先排查，不先训练再补看。讲师参考不算本组结果。referenceVideo仅为原始媒体，不直接导航媒体文件，也不拼接apiPrefix。',
    'OriginMan评测视频与通用遥测样本是两种证据；rdk_runs_replay样本为0不能推出评测视频不存在。引用保存失败先用原训练与评测Run恢复关联，不新提交，核对本次视频回执再提供入口。',
    'Worker连通不等于任务依赖预检通过；没有任务环境证据时只报告连通已验证，不能说训练无阻塞。短训未提升只陈述结果与预算，不推断差异主要来自步数，不承诺50万步必然改善。',
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
