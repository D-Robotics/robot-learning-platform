/** One learner entry; workbench buttons own execution, MCP retains full expert tools. */
import fs from 'node:fs';
import { selectCourseAssets, registerCourseModel } from './course-setup.mjs';
import { prepareTraining } from './workflow-inspection.mjs';
import { requireConnected } from './short-training.mjs';
export const WORKSHOP_TOOLS = [
  {
    name: 'rdk_workshop',
    description:
      '“带我开始 Workshop”“继续”“看看效果”的统一入口。自动使用当前账号已选课程实验，不让学员填写ID；新实验只准备工作台，由页面按钮选择预算后训练及同源评测。本工具不提交训练，不等待外部浏览器连接器。返回链接用Qoder内置浏览器或Studio工作台直接打开，正常只展示studentReply，不再调用旧指南、预算问答或训练工具。高级训练工具仍可自由使用。',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['start', 'new', 'continue', 'results'], default: 'start' },
        computeResourceId: { type: 'string', minLength: 1, maxLength: 160 },
        contextId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];
const noSubmission = () => ({ training: false, evaluation: false });
const signedIn = (status) =>
  status.session?.authenticated === true && Boolean(status.session.accountId);

const qoderNavigation = (url) => ({
  surface: '内置 browser-use MCP，非外部 Chrome Connector',
  steps: [
    { tool: 'navigate_page', arguments: { url } },
    { tool: 'list_pages', arguments: {} },
    {
      tool: 'select_page',
      argumentsFrom:
        '从 list_pages 中按完整 URL 精确匹配取得 pageId，传 {pageId, bringToFront:true}；navigate_page 只返回成功文字，不提供 pageId。',
    },
  ],
});
const previewEntry = (base, stage) => {
  const url = base.replace(/\/+$/, '') + '/workshop.html?start=1';
  return {
    contextId: null,
    stage,
    links: { workshop: url },
    submission: noSubmission(),
    studentReply: `[打开 Workshop](${url})。先看参考，准备好后点「开始实操」。`,
    qoderNavigation: qoderNavigation(url),
    delivery:
      '静默打开 links.workshop 后只展示 studentReply。由用户点击开始实操和选择算力，不主动发起授权。',
  };
};

export async function workshopEntry(
  args = {},
  call,
  {
    remote,
    readModels,
    courseReadiness,
    toolNames = [],
    defaultResourceId,
    authentication,
    signal,
  } = {},
) {
  if (
    !args ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !['intent', 'contextId', 'computeResourceId'].includes(k)) ||
    !['start', 'new', 'continue', 'results'].includes(args.intent ?? 'start') ||
    (args.contextId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(args.contextId))
  )
    throw Error('请使用开始、继续或查看效果。');
  if (args.computeResourceId !== undefined) {
    if (
      typeof args.computeResourceId !== 'string' ||
      !args.computeResourceId.trim() ||
      args.computeResourceId.length > 160 ||
      args.intent !== 'new' ||
      args.contextId !== undefined
    )
      throw Error('请用指定算力机新建实验，原实验继续使用原来的算力机。');
    if (defaultResourceId && args.computeResourceId !== defaultResourceId)
      throw Error('本课堂已固定算力机。如需更换，请联系教师。');
  }
  if (!remote) throw Error('当前连接尚不支持按钮工作台，请更新完整插件。');
  // An explicit login may already be pending. Merely opening Workshop never starts one.
  const identity = await authentication?.status();
  if (identity && identity.authenticated !== true) {
    if (!identity.needsLogin)
      throw Error(identity.nextAction ?? '授权服务暂时不可用，稍后重试原请求。');
    const login = identity.verificationUrl;
    const preview = (args.intent ?? 'start') === 'start' && !args.contextId;
    if (preview && !login && !identity.accountSelectionRequired && authentication.audience)
      return previewEntry(authentication.audience, 'preview');
    return {
      contextId: null,
      stage: preview && !login ? 'preview' : 'authorize',
      links: login ? { login } : {},
      submission: noSubmission(),
      studentReply: identity.accountSelectionRequired
        ? identity.nextAction
        : login
          ? `[确认学习平台授权](${login})。确认后回来继续 Workshop。`
          : preview
            ? 'OriginMan Workshop 会用仿真训练一个受扰恢复策略，再比较恢复次数并看回放。现在可以先问课程或预算。准备实操时，说“连接学习平台”。'
            : '这一步需要学习平台账号。准备好后说“连接学习平台”。',
      delivery: '只展示 studentReply。等待用户明确要求连接或完成已有授权，不自动发起登录。',
    };
  }
  signal?.throwIfAborted();
  const status = await call('rdk_platform_status', {});
  if (!signedIn(status)) throw Error('请先在当前软件登录学习平台，然后继续。');
  if (
    identity &&
    (status.baseUrl !== authentication.audience || status.session.accountId !== identity.accountId)
  )
    throw Error('平台登录身份与授权不一致。请保留原实验，核对当前账号。');
  const base = new URL(status.baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error('平台地址无效。');
  const accountId = status.session.accountId;
  const list = await remote('list', {}, accountId);
  let selectedComputeName;
  let session = list.current;
  if (args.contextId)
    session = (await remote('select', { contextId: args.contextId }, accountId)).session;
  else if (args.intent === 'new' || ((args.intent ?? 'start') === 'start' && !session)) {
    if (!args.computeResourceId) return previewEntry(base.toString(), 'choose-compute');
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../references/originman-manifest.json', import.meta.url), 'utf8'),
    );
    const valid = await call('rdk_model_validate', { manifest });
    if (valid.valid !== true) throw Error('课程模型契约不匹配，请先更新课程材料。');
    const selected = await selectCourseAssets(
      {
        manifest,
        readModels,
        modelId: session?.modelId,
        computeResourceId: args.computeResourceId,
      },
      call,
    );
    const prepared = await prepareTraining(
      {
        productId: 'originman',
        taskId: 'originman-recovery',
        computeResourceId: selected.resource.id,
      },
      call,
      toolNames,
      { courseReadiness },
    );
    requireConnected(prepared);
    const model = selected.model ?? (await registerCourseModel(manifest, call));
    const end = await call('rdk_platform_status', {});
    if (
      end.baseUrl !== status.baseUrl ||
      end.session?.accountId !== status.session.accountId ||
      end.session?.authenticated !== true
    )
      throw Error('账号或平台已变化，停止创建实验。');
    session = (
      await remote(
        'create',
        { modelId: model.id, computeResourceId: selected.resource.id },
        accountId,
      )
    ).session;
    if (args.computeResourceId) selectedComputeName = selected.resource.name;
  }
  const finalIdentity = await call('rdk_platform_status', {});
  if (
    finalIdentity.baseUrl !== status.baseUrl ||
    finalIdentity.session?.authenticated !== true ||
    finalIdentity.session.accountId !== status.session.accountId
  )
    throw Error('账号或平台已变化，请在当前账号重新接续。');
  const root = base.toString().replace(/\/+$/, '');
  const url =
    root + '/workshop.html' + (session ? '?context=' + encodeURIComponent(session.contextId) : '');
  const stage = session?.stage ?? 'choose';
  const [message, linkLabel] = {
    choose: ['选择要继续的实验。', '打开实验列表'],
    ready:
      session?.reference === 'observed' || session?.reference === 'skipped'
        ? ['下一步选训练预算。第一次可以选快速体验。', '选择训练预算']
        : ['可以看一段参考，也可以直接选训练预算。', '打开 Workshop'],
    training: ['这轮训练已提交，可以看实时曲线。', '查看训练进度'],
    'ready-evaluate': session?.autoContinue
      ? ['训练已完成，下一步用同一策略评测。', '查看评测进度']
      : ['训练已完成。打开实验查看如何继续评测。', '打开当前实验'],
    evaluating: ['正在评测这轮训练出的策略。', '查看评测进度'],
    results: ['评测已完成。可看结果、对比历史轮次，或改一项参数再试。', '查看结果与回放'],
    blocked: ['这轮实验已停止，打开页面查看原因。', '查看实验状态'],
    unknown: ['这轮提交状态待核对，打开页面接续原请求。', '恢复当前实验'],
  }[stage] ?? ['查看当前实验的进度与下一步。', '打开当前实验'];
  return {
    contextId: session?.contextId ?? null,
    stage,
    session,
    links: { workshop: url },
    submission: noSubmission(),
    studentReply:
      (selectedComputeName ? '本轮算力机：' + selectedComputeName + '。' : '') +
      message +
      '\n[' +
      linkLabel +
      '](' +
      url +
      ')',
    qoderNavigation: qoderNavigation(url),
    delivery:
      '静默完成导航后只展示studentReply，不添加“我来加载”“我在打开”等过程说明。Qoder依次执行qoderNavigation三个步骤：navigate_page→list_pages→select_page({pageId:真实页面编号,bringToFront:true})，禁止省略pageId或把URL当编号。成功后结束，保持面板展示，不重复截图或询问预算。内置工具不可用时直接给一次链接；不启动外部Browser Connector。其余工具仅在用户明确要求高级操作时使用。',
  };
}
