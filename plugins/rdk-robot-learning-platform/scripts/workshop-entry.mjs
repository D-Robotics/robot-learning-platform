/** One learner entry; workbench buttons own execution, MCP retains full expert tools. */
export const STUDIO_WORKSHOP_NAVIGATION =
  '在 RDK Studio 开始、继续或查看 Workshop 结果时，先调用 studio_open_url，使用 studioNavigation.arguments.url 打开右侧工作台。不再询问是否打开。用户只要链接或明确指定其他打开方式时，按用户要求执行。工具缺失或调用失败时直接给可点击链接。';

const WORKSHOP_PAGE_DELIVERY =
  STUDIO_WORKSHOP_NAVIGATION +
  ' 打开后告诉学员当前页面和一个可以马上做的动作。默认沿用 studentReply 的用语，技术字段在学员追问时再解释。Qoder 默认展示可点击链接，用户要求直接打开时按 qoderNavigation 在内置浏览器依次导航、列出页面并选择完整 URL 匹配的真实 pageId。页面负责预算确认和提交。';
export const WORKSHOP_TOOLS = [
  {
    name: 'rdk_workshop',
    description:
      '用户说“带我开启/开始 OriginMan Workshop”时直接调用本工具 intent=new；打开舞蹈准备页。回执提供当前平台完整页面。“继续”和“看看效果”已知原 Run 时传 runId，已知受扰恢复实验时传 contextId。学员在页面选择算力和预算。本工具不提交训练。' +
      STUDIO_WORKSHOP_NAVIGATION +
      ' Qoder 按回执操作。',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['start', 'new', 'continue', 'results'], default: 'start' },
        course: {
          type: 'string',
          enum: ['dance'],
          description: '新实验使用舞蹈课程。历史实验使用原 Run ID 或 contextId。',
        },
        computeResourceId: { type: 'string', minLength: 1, maxLength: 160 },
        runId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$' },
        contextId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];
const noSubmission = () => ({ training: false, evaluation: false });
const signedIn = (status) =>
  status.session?.authenticated === true && Boolean(status.session.accountId);

export function workshopPageNavigation(url) {
  return {
    studioNavigation: { tool: 'studio_open_url', arguments: { url } },
    qoderNavigation: {
      surface: 'Qoder 内置浏览器',
      steps: [
        { tool: 'navigate_page', arguments: { url } },
        { tool: 'list_pages', arguments: {} },
        {
          tool: 'select_page',
          argumentsFrom: '按完整 URL 匹配刚打开的页面，使用实际 pageId 并传 bringToFront:true。',
        },
      ],
    },
    delivery: WORKSHOP_PAGE_DELIVERY,
  };
}
export function workshopPreview(base, stage = 'preview', resource) {
  const url = new URL(base.replace(/\/+$/, '') + '/workshop.html');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.pathname.endsWith('/workshop.html')
  )
    throw Error('当前平台地址无效，无法生成 Workshop 入口。');
  url.searchParams.set('course', 'dance');
  url.searchParams.set('start', '1');
  if (resource) url.searchParams.set('computeResourceId', resource.id);
  const href = url.href;
  const firstStep =
    '可以先播放「交替摆臂」仿真回放，再选一支预置参考舞蹈或用动作组自由编排。进入跟跳页面后，第一次练习可选 8,192 步快检。';
  const label = 'OriginMan 舞蹈 Workshop';
  return {
    contextId: null,
    stage,
    course: 'dance',
    entryUrl: href,
    links: { workshop: href },
    submission: noSubmission(),
    studentReply: resource
      ? `[打开 ${label}](${href})。本轮选择 ${resource.name || '指定的算力机'}，提交前会核对连接与课程能力。`
      : `[打开 ${label}](${href})。${firstStep}`,
    ...workshopPageNavigation(href),
  };
}

export async function workshopEntry(
  args = {},
  call,
  { remote, readResult, defaultResourceId, authentication, signal } = {},
) {
  if (
    !args ||
    Array.isArray(args) ||
    Object.keys(args).some(
      (k) => !['intent', 'course', 'contextId', 'computeResourceId'].includes(k),
    ) ||
    !['start', 'new', 'continue', 'results'].includes(args.intent ?? 'start') ||
    (args.course !== undefined && !['dance', 'recovery'].includes(args.course)) ||
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
  const intent = args.intent ?? 'start';
  const startsNew = ['start', 'new'].includes(intent) && !args.contextId;
  const course = startsNew ? 'dance' : (args.course ?? 'recovery');
  if (course === 'dance' && !startsNew)
    throw Error('舞蹈训练和结果请使用原 Run 的进度或结果入口。');
  if (course === 'recovery' && !remote) throw Error('当前连接尚不支持实验接续，请更新完整插件。');
  // A fresh preview reads no account data and allocates no experiment. Account and
  // resource checks happen when the learner explicitly starts practice.
  if (
    ['start', 'new'].includes(args.intent ?? 'start') &&
    !args.contextId &&
    !args.computeResourceId &&
    authentication?.audience
  )
    return workshopPreview(authentication.audience);
  // An explicit login may already be pending. Merely opening Workshop never starts one.
  const identity = await authentication?.status();
  if (identity && identity.authenticated !== true) {
    if (!identity.needsLogin)
      throw Error(identity.nextAction ?? '授权服务暂时不可用，稍后重试原请求。');
    const login = identity.verificationUrl;
    const preview = (args.intent ?? 'start') === 'start' && !args.contextId;
    if (preview && !login && !identity.accountSelectionRequired && authentication.audience)
      return workshopPreview(authentication.audience);
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
            ? 'OriginMan Workshop 可以先看仿真回放，再选预置舞蹈或自由编排。准备实操时，说“连接学习平台”。'
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
  if (startsNew && !args.computeResourceId)
    return workshopPreview(base.toString(), 'choose-compute');
  if (course === 'dance') {
    const value = await call('rdk_compute_resources_list', {});
    const resource = value.computeResources?.find((item) => item.id === args.computeResourceId);
    if (!resource) throw Error('当前账号看不到指定算力机，请重新选择。');
    if (resource.mock === true || resource.source === 'local-agent')
      throw Error('舞蹈训练需要平台可访问的真实 Worker，请选择其他算力机。');
    const current = await call('rdk_platform_status', {});
    if (
      !signedIn(current) ||
      current.baseUrl !== status.baseUrl ||
      current.session.accountId !== accountId
    )
      throw Error('账号或平台已变化，请重新选择算力机。');
    return workshopPreview(base.toString(), 'choose-compute', resource);
  }
  const session = args.contextId
    ? (await remote('read', { contextId: args.contextId }, accountId)).session
    : (await remote('list', {}, accountId)).current;
  const stage = session?.stage ?? 'choose';
  const result = stage === 'results' ? await readResult?.(session.contextId) : undefined;
  signal?.throwIfAborted();
  const finalIdentity = await call('rdk_platform_status', {});
  if (
    finalIdentity.baseUrl !== status.baseUrl ||
    finalIdentity.session?.authenticated !== true ||
    finalIdentity.session.accountId !== status.session.accountId
  )
    throw Error('账号或平台已变化，请在当前账号重新接续。');
  const url = session
    ? new URL('./experiment.html', base.toString().replace(/\/?$/, '/'))
    : new URL('./?robot=originman#records', base.toString().replace(/\/?$/, '/'));
  if (session) url.searchParams.set('context', session.contextId);
  const linkLabel = session ? '查看历史实验' : '打开运行记录';
  return {
    ...result,
    contextId: session?.contextId ?? null,
    stage,
    course,
    session,
    links: { ...result?.links, workshop: url.href },
    submission: noSubmission(),
    studentReply: result?.studentReply ?? `[${linkLabel}](${url.href})。`,
    ...workshopPageNavigation(result?.links?.experiment ?? url.href),
  };
}
