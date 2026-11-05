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
        contextId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];
export async function workshopEntry(
  args = {},
  call,
  { remote, readModels, courseReadiness, toolNames = [], defaultResourceId } = {},
) {
  if (
    !args ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !['intent', 'contextId'].includes(k)) ||
    !['start', 'new', 'continue', 'results'].includes(args.intent ?? 'start') ||
    (args.contextId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(args.contextId))
  )
    throw Error('请使用开始、继续或查看效果。');
  if (!remote) throw Error('当前连接尚不支持按钮工作台，请更新完整插件。');
  const status = await call('rdk_platform_status', {});
  if (status.session?.authenticated !== true || !status.session.accountId)
    throw Error('请先在当前软件登录学习平台，然后继续。');
  const base = new URL(status.baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error('平台地址无效。');
  const list = await remote('list', {});
  let session = list.current;
  if (args.contextId) session = (await remote('select', { contextId: args.contextId })).session;
  else if (
    (args.intent ?? 'start') === 'new' ||
    ((args.intent ?? 'start') === 'start' &&
      (!session || ['results', 'blocked'].includes(session.stage)))
  ) {
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../references/originman-manifest.json', import.meta.url), 'utf8'),
    );
    const valid = await call('rdk_model_validate', { manifest });
    if (valid.valid !== true) throw Error('课程模型契约不匹配，请先更新课程材料。');
    const selected = await selectCourseAssets(
      { manifest, readModels, computeResourceId: defaultResourceId },
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
      await remote('create', { modelId: model.id, computeResourceId: selected.resource.id })
    ).session;
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
  return {
    contextId: session?.contextId ?? null,
    stage: session?.stage ?? 'choose',
    session,
    links: { workshop: url },
    submission: { training: false, evaluation: false },
    studentReply:
      session?.stage === 'ready'
        ? 'Workshop 已准备好。先看参考，再点一次预算按钮，后续训练与评测会自动接续。\n[打开 Workshop](' +
          url +
          ')'
        : session
          ? '已接上当前实验，直接查看进度、对比与回放。\n[继续实验](' + url + ')'
          : '请选择要继续的实验。\n[打开实验列表](' + url + ')',
    delivery:
      '只展示studentReply并打开links.workshop。Qoder使用browser-use内置navigate_page，不使用外部Browser Connector；必要时点任务产出→网页查阅打开面板。不要再问UUID、重读指南或由模型提交训练；页面按钮已提供预算、参考、自动评测、暂停、历史与自定义参数。只有用户明确要求高级操作时使用其余原子工具。',
  };
}
