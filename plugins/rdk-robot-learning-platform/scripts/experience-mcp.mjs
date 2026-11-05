#!/usr/bin/env node
/** Add read-only experience composition while preserving the installed upstream MCP. */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  connectMcp,
  prepareExperience,
  readToolResult,
  isDirectInvocation,
} from './experience.mjs';
import {
  WORKFLOW_TOOLS,
  inspectWorkflow,
  prepareTraining,
  readOriginmanEvaluation,
} from './workflow-inspection.mjs';
import { AUTH_TOOLS } from './plugin-auth.mjs';
import { SHORT_TRAINING_TOOLS, shortTraining } from './short-training.mjs';
import { EXPERIMENT_TOOLS, experimentContext } from './experiment-context.mjs';
import {
  UI_HTML,
  UI_URI,
  UI_MIME,
  UI_TOOLS,
  uiSupported,
  uiMetadata,
  uiResource,
} from './mcp-app-resource.mjs';
import {
  ORIGINMAN_COURSE,
  ORIGINMAN_COURSE_INSTRUCTIONS,
  courseToolHint,
  courseLinks,
} from './workshop-course.mjs';

import { ROBOT_ONBOARDING_TOOLS, onboardingGuide, assessOnboarding } from './robot-onboarding.mjs';
import { CLASSROOM_TOOLS, classroomGuide } from './classroom-guide.mjs';

// Capture at import time so an old cached process cannot claim newly replaced files.
const loadedSources = Object.fromEntries(
  [
    'mcp-app-resource.mjs',
    'guided-input.mjs',
    'classroom-guide.mjs',
    'robot-onboarding.mjs',
    'experience-mcp.mjs',
    'experience.mjs',
    'workflow-inspection.mjs',
    'experiment-context.mjs',
    'short-training.mjs',
    'plugin-auth.mjs',
    'authenticated-core.mjs',
    'plugin-errors.mjs',
    'course-setup.mjs',
    'submission-journal.mjs',
    'workshop-course.mjs',
  ].map((name) => [
    'scripts/' + name,
    createHash('sha256')
      .update(readFileSync(new URL(name, import.meta.url)))
      .digest('hex'),
  ]),
);
if (UI_HTML)
  loadedSources['ui/experiment.html'] = createHash('sha256').update(UI_HTML).digest('hex');
export function pluginRuntimeIdentity() {
  try {
    const declared = JSON.parse(
      readFileSync(new URL('../provenance.json', import.meta.url), 'utf8'),
    );
    if (
      !/^\d+\.\d+\.\d+$/.test(declared.version ?? '') ||
      Object.entries(loadedSources).some(([name, hash]) => declared.wrapperSources?.[name] !== hash)
    )
      return {
        version: null,
        loadedSourcesMatch: false,
        reason: '当前进程与分发来源记录不一致，需刷新连接。',
      };
    return {
      version: declared.version,
      loadedSourcesMatch: true,
      source: 'local-distribution-provenance',
      note: '仅核对本进程加载的编排模块与本地分发记录；不是服务端版本或签名认证。',
    };
  } catch {
    return {
      version: null,
      loadedSourcesMatch: false,
      reason: '当前入口未提供可核对的便携分发记录。',
    };
  }
}

export const EXPERIENCE_TOOLS = [
  {
    name: 'rdk_plugin_status',
    description: '离线核对当前实际运行插件版本和加载源码是否匹配；无需平台登录，不查询设备。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  ...CLASSROOM_TOOLS,
  ...ROBOT_ONBOARDING_TOOLS,
  ...AUTH_TOOLS,
  ...SHORT_TRAINING_TOOLS,
  {
    name: 'rdk_training_wait',
    description:
      '等待已提交Run至终态或20秒上限；只查询，不提交、不取消。running时可继续对同一Run调用；无需shell sleep或后台进程。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', minLength: 1 },
        pollCursor: {
          type: 'string',
          pattern: '^[a-f0-9-]{36}$',
          description: '只传上一条等待回执的nextPollArguments中的游标，接续同一Run。',
        },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  ...EXPERIMENT_TOOLS,
  ...WORKFLOW_TOOLS,
  {
    name: 'rdk_experience_guide',
    description:
      '介绍机器人学习插件能力、开始或继续OriginMan Workshop前先读取本指南：返回仅仿真课程范围、学员步骤、短训目的与下一步规则，另含宿主计算接口配置状态；不返回凭据，不依赖宿主 load_skill。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'rdk_experience_prepare',
    description:
      '用当前同一账号检查场景、指定策略并准备入口。不会打开页面、驱动设备或提交训练；恢复仅返回指引。默认 OriginMan 受扰恢复，MicroDuck 可通过配置继续选择。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check', 'prepare', 'recover'] },
        profile: { type: 'object' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

export function experienceProxy(
  upstream,
  {
    env = process.env,
    authentication,
    contextDirectory,
    waitBudgetMs = 20000,
    uiHtml = UI_HTML,
  } = {},
) {
  let workflow = null;
  let uiEnabled = false,
    upstreamResources = false;
  let host = {
    family: 'unknown',
    reportedVersion: null,
    source: 'initialize-client-info',
    verified: false,
  };
  const pollCursors = new Map();
  const stoppedResult = () => {
    const value = {
      ok: false,
      stopWorkflow: true,
      retryAllowed: false,
      error: {
        platformCode: 'WORKSHOP_FLOW_STOPPED',
        message: '本次短训流程已受阻或已绑定原Run，不接受换标识、换资源或改用通用提交工具重交。',
        nextAction:
          '保留原Run，只读查看状态和原因。新实验须由用户明确开始新任务；当前任务立即结束。',
      },
    };
    return {
      isError: true,
      structuredContent: value,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    };
  };
  const observe = (value, runId) => {
    if (!workflow) return value;
    const status = value?.status ?? value?.run?.status;
    if (
      ['failed', 'blocked', 'cancelled', 'canceled'].includes(status) &&
      [workflow.runId, workflow.evaluationRunId].includes(runId)
    ) {
      workflow.stopped = true;
      return {
        ...value,
        stopWorkflow: true,
        retryAllowed: false,
        nextAction: '本次运行已失败；停止训练流程，保留原Run和原因，不换机器、参数或实验标识重交。',
      };
    }
    if (runId === workflow.evaluationRunId && status === 'completed') workflow.completed = true;
    return value;
  };
  const reservedNames = new Set(EXPERIENCE_TOOLS.map((tool) => tool.name));
  const validateCatalogPage = (page) => {
    if (
      !Array.isArray(page?.tools) ||
      page.tools.some((tool) => typeof tool?.name !== 'string' || !tool.name.trim()) ||
      (page.nextCursor !== undefined &&
        (typeof page.nextCursor !== 'string' || !page.nextCursor.length))
    )
      throw new Error('Invalid upstream tool catalog or paging cursor.');
    const names = page.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length)
      throw new Error('Duplicate names in upstream tool catalog.');
    if (names.some((name) => reservedNames.has(name)))
      throw new Error('Upstream tool name collides with a reserved experience extension tool.');
    return page;
  };
  const readCatalog = async (signal) => {
    const tools = [];
    const names = new Set();
    const cursors = new Set();
    let params = {};
    for (let pageNumber = 0; pageNumber < 128; pageNumber++) {
      signal?.throwIfAborted();
      const page = validateCatalogPage(await upstream.request('tools/list', params, { signal }));
      signal?.throwIfAborted();
      for (const tool of page.tools) {
        if (names.has(tool.name)) throw new Error('Duplicate names across catalog pages.');
        names.add(tool.name);
        tools.push(tool);
      }
      if (tools.length > 10000) throw new Error('Upstream tool catalog exceeds safety budget.');
      if (page.nextCursor === undefined) return { tools };
      if (cursors.has(page.nextCursor)) throw new Error('Repeated upstream paging cursor.');
      cursors.add(page.nextCursor);
      params = { cursor: page.nextCursor };
    }
    throw new Error('Upstream tool catalog exceeds paging budget.');
  };
  const clientContext = () => {
    const configured = [
      'RDK_LEARNING_STUDIO_HOST_ORIGIN',
      'RDK_LEARNING_STUDIO_HOST_TOKEN',
      'RDK_STUDIO_PLUGIN_REGISTRY',
      'RDK_STUDIO_PLUGIN_ROOT',
      'RDK_STUDIO_SESSION_FILE',
    ].every((name) => typeof env[name] === 'string' && env[name].trim());
    return {
      observedAt: new Date().toISOString(),
      nativeCompute: {
        configuration: configured ? 'present' : 'missing',
        runtimeVerified: false,
        nextAction: configured
          ? '配置存在；仍需通过原生计算状态工具核对宿主、账号和连接，不据配置宣称已接通。'
          : '仅可选受管计算适配器的配置缺失；未测试本地或远程训练运行时，不能推断任何训练路径不可用。回答不得称本地训练断路或只能远程训练；任务资源与任务依赖需各自实测。',
      },
      browserAuthentication:
        '插件认证与网页认证分别验证；网页显示游客时，通过正常登录流程进入同一账号，不复制会话凭据。',
    };
  };
  const readProfile = () =>
    JSON.parse(
      readFileSync(new URL('../references/experience-profile.json', import.meta.url), 'utf8'),
    );
  return async (method, params = {}, signal) => {
    if (method === 'initialize') {
      const reported = String(params.clientInfo?.name ?? '').toLowerCase();
      const version = String(params.clientInfo?.version ?? '');
      host = {
        family:
          ['qoder', 'studio', 'codex', 'vscode', 'claude', 'cursor'].find((name) =>
            reported.includes(name),
          ) ?? 'other',
        reportedVersion: /^\d{1,3}(?:\.\d{1,3}){1,3}(?:[-+][A-Za-z0-9.-]{1,30})?$/.test(version)
          ? version
          : null,
        source: 'initialize-client-info',
        verified: false,
      };
      const result = await upstream.request(method, params, { signal });
      uiEnabled = Boolean(uiHtml) && uiSupported(params);
      upstreamResources = Boolean(result.capabilities?.resources);
      return {
        ...result,
        ...(uiEnabled
          ? {
              capabilities: {
                ...result.capabilities,
                resources: result.capabilities?.resources ?? {},
              },
            }
          : {}),
        instructions:
          (result.instructions ?? '') +
          '\n课堂新学员或新机离线准备：rdk_classroom_guide携带已知answers，只展示studentReply，每次一个中文问题，不重复问已知项。要求依据才detail=full。阶段标准读robot_onboarding_guide，证据读robot_acceptance_assess；needs-input不是通过。离线知识不要求平台登录，不因离线准备启动训练。' +
          '\n认证：先读platform_status。未认证时调用rdk_auth_login取得浏览器登录确认入口；请用户在浏览器登录并确认验证码，然后调用rdk_auth_status完成连接，不索取密码或Cookie。Studio使用宿主绑定的当前身份，未登录时请在Studio账号菜单登录，不扫描其他账号、不静默切换。' +
          '\n交互约定：默认简短中文，按“当前进度→本次结果→下一步”回答。认证、版本、契约和资源校验在后台完成，正常时不逐项播报。只在阶段变化、阻断或需要用户选择时更新；不重复播报running，不展示内部推理。UUID、工具名、摘要和错误码仅在用户查看诊断时展开。正常结果优先给曲线、对比图和回放入口；宿主能打开工作台则在工作台展示，否则给可点击链接。没有实际渲染能力不伪装交互卡片，没有播放器观测不称已播放。' +
          '\n用户说“带我完成OriginMan Workshop”或明确要求短训练、评测和回放，即授权8192步仅仿真流程；仅介绍或咨询不提交。后台先rdk_auth_status核对认证及pluginRuntime，再rdk_experience_guide取得operation.contextId。完整Workshop先打开course.links.simulation，实际启动并观察基础PD参考；参考不计为本组训练结果。然后依次rdk_originman_short_train、rdk_training_wait、rdk_originman_short_evaluate、rdk_training_wait、rdk_experiment_resume及rdk_originman_evaluation_read。只传专用工具要求的标识，模型、manifest和绑定资源由工具校验，不重复调用prepare/catalog或手拼training_submit。不要让用户填写UUID。只有未登录、明确选择歧义或真实阻断才提问。宿主已绑定课程资源时沿用它，不按名称猜其他机器。' +
          '\n等待：沿用同一Run及nextPollArguments，正常等待窗口结束继续读；不启动shell sleep。失败或stopWorkflow=true停止所有自动提交，不换标识、资源或参数重交；仍可只读查询原Run、日志及恢复已有引用。SUBMISSION_REFERENCE_SAVE_FAILED表示任务已经提交，保留回执并恢复，绝不能说尚未提交。' +
          '\n实验接续：通用流程提交后用明确contextId保存训练及同源评测引用；专用短训工具已保存，无需重复。跨聊天或软件继续时使用明确实验标识调用experiment_resume，并重新验证当前平台和账号；不选择全局最新Run，不扫描其他账号。本机引用不等于跨机器同步。404、网络失败和断线不触发重交。新实验使用新contextId，调参须用户明确提出。' +
          '\n结果：只展示本次Run的真实original/tuned/rl对比；执行完成、质量提升和真机资格分别判断，短训不承诺提升。回放优先打开resume.links.experiment；旧平台打开links.workbench并按selection核对本次Run，再在页面播放器播放一次；不要直接导航媒体URL，OriginMan不调用真机rdk_replay_video或evaluationId接口；媒体链接不做正文抓取、HEAD、curl或独立浏览器认证探测。没有观测就报告播放待验证。一般流程用workflow_inspect按需看证据，不默认打印整张技术状态表；新训练前training_prepare刷新资源。默认GPU，CPU须明确选择，不自动降级、不操作真机。\n本次原生计算配置：' +
          clientContext().nativeCompute.configuration +
          '。宿主接口缺失时不要要求已经在桌面中的用户重复“去桌面操作”；用指南中的 clientContext 说明实际缺口。' +
          ORIGINMAN_COURSE_INSTRUCTIONS,
      };
    }
    if (method === 'resources/read' && params.uri === UI_URI) {
      if (!uiEnabled) throw Error('宿主未协商交互视图；请使用实验页链接。');
      return uiResource(uiHtml);
    }
    if (method === 'resources/list' && uiEnabled) {
      const result = upstreamResources
        ? await upstream.request(method, params, { signal })
        : { resources: [] };
      if (!Array.isArray(result.resources) || result.resources.some((r) => r.uri === UI_URI))
        throw Error('上游资源目录与交互视图发生冲突。');
      return result.nextCursor === undefined
        ? {
            ...result,
            resources: [
              ...result.resources,
              {
                uri: UI_URI,
                name: '本次机器人学习实验',
                mimeType: UI_MIME,
                _meta: uiMetadata,
              },
            ],
          }
        : result;
    }
    if (method === 'tools/list') {
      const result = validateCatalogPage(await upstream.request(method, params, { signal }));
      const forUi = (tool) =>
        uiEnabled && tool.annotations?.readOnlyHint !== true
          ? { ...tool, _meta: { ...tool._meta, ui: { ...tool._meta?.ui, visibility: ['model'] } } }
          : tool;
      // Preserve upstream paging; advertise the extension exactly once, on the final page.
      return result.nextCursor === undefined
        ? {
            ...result,
            tools: [
              ...result.tools
                .map((t) =>
                  t.name === 'rdk_replay_video'
                    ? {
                        ...t,
                        description:
                          '仅用于真机遥测视频渲染；OriginMan短训评测的视频已随评测Run生成，不能用本工具。请rdk_experiment_resume优先获取links.experiment；旧平台使用links.workbench并在页面内选择本次Run、打开播放器。\n' +
                          t.description,
                      }
                    : courseToolHint(t.name)
                      ? { ...t, description: courseToolHint(t.name) + (t.description ?? '') }
                      : t,
                )
                .map(forUi),
              ...EXPERIENCE_TOOLS.map((t) =>
                uiEnabled && UI_TOOLS.has(t.name)
                  ? {
                      ...t,
                      _meta: {
                        ...t._meta,
                        ui: {
                          ...t._meta?.ui,
                          resourceUri: UI_URI,
                          visibility:
                            t.annotations?.readOnlyHint === true ? ['model', 'app'] : ['model'],
                        },
                      },
                    }
                  : t,
              ),
            ],
          }
        : { ...result, tools: result.tools.map(forUi) };
    }
    if (method === 'tools/call' && workflow && params.name === 'rdk_replay_video') {
      const value = {
        ok: false,
        stopWorkflow: false,
        error: {
          platformCode: 'ORIGINMAN_REPLAY_ROUTE',
          message: 'OriginMan评测视频不使用真机遥测渲染工具。',
          nextAction:
            '调用rdk_experiment_resume，优先打开links.experiment；旧平台打开links.workbench并按selection选择本次Run、打开播放器。不要新建评测或渲染任务。',
        },
      };
      return {
        isError: true,
        structuredContent: value,
        content: [{ type: 'text', text: JSON.stringify(value) }],
      };
    }
    if (
      method === 'tools/call' &&
      workflow &&
      !workflow.completed &&
      ((['rdk_originman_short_train', 'rdk_originman_train'].includes(params.name) &&
        (workflow.stopped || params.arguments?.contextId !== workflow.contextId)) ||
        (['rdk_originman_short_evaluate', 'rdk_originman_evaluate'].includes(params.name) &&
          workflow.stopped) ||
        params.name === 'rdk_training_submit' ||
        (workflow.stopped && params.name === 'rdk_model_register'))
    )
      return stoppedResult();
    if (method === 'tools/call' && EXPERIENCE_TOOLS.some((t) => t.name === params.name)) {
      try {
        let payload;
        const operationId = 'om-' + randomUUID().replaceAll('-', '').slice(0, 20);
        if (params.name === 'rdk_plugin_status') {
          if (Object.keys(params.arguments ?? {}).length) throw Error('版本检查不需要参数。');
          const runtime = pluginRuntimeIdentity();
          payload = {
            ok: runtime.loadedSourcesMatch,
            platformLoginRequired: false,
            motionAuthorized: false,
            diagnostics: {
              host,
              layers: {
                mcp: 'responding',
                runtime: runtime.loadedSourcesMatch ? 'verified' : 'blocked',
                authentication: 'not-queried',
                platform: 'not-queried',
                resource: 'not-queried',
                experiment: 'not-selected',
              },
              note: '宿主名称与版本由客户端自行报告，不是原生窗口验收；宿主模型未执行工具时本接口无法替它证明就绪。',
            },
            studentReply: runtime.loadedSourcesMatch
              ? `当前实际运行插件 ${runtime.version}，加载源码核对一致。此项未验证平台连接或实机效果。`
              : '当前进程与分发记录未核对通过，请刷新插件连接后再检查；暂不执行训练或实体操作。',
          };
        } else if (params.name === 'rdk_classroom_guide')
          payload = classroomGuide(params.arguments ?? {});
        else if (params.name === 'rdk_robot_onboarding_guide')
          payload = onboardingGuide(params.arguments ?? {});
        else if (params.name === 'rdk_robot_acceptance_assess')
          payload = assessOnboarding(params.arguments);
        else if (AUTH_TOOLS.some((t) => t.name === params.name)) {
          if (!authentication) throw Error('当前入口未启用统一登录，请使用本版完整插件入口。');
          payload = await authentication.call(params.name, params.arguments);
        } else if (params.name === 'rdk_training_wait') {
          const args = params.arguments ?? {};
          if (
            typeof args.runId !== 'string' ||
            !args.runId.trim() ||
            Object.keys(args).some((k) => !['runId', 'pollCursor'].includes(k)) ||
            (args.pollCursor !== undefined && !/^[a-f0-9-]{36}$/.test(args.pollCursor))
          )
            throw new Error('请使用原Run及上一条回执提供的续查参数。');
          if (args.pollCursor && pollCursors.get(args.runId) !== args.pollCursor)
            throw Object.assign(
              new Error(
                '续查游标不属于当前Run或已更新，请使用最新nextPollArguments；重连后可省略游标重新查询同一Run。',
              ),
              { platformCode: 'WAIT_CURSOR_MISMATCH' },
            );
          const deadline = Date.now() + Math.max(1, Math.min(20000, waitBudgetMs));
          do {
            signal?.throwIfAborted();
            payload = readToolResult(
              await upstream.request(
                'tools/call',
                { name: 'rdk_training_status', arguments: { runId: args.runId } },
                { signal },
              ),
            );
            const state = payload?.run?.status ?? payload?.status;
            if (!['queued', 'running', 'pending'].includes(state) || Date.now() >= deadline) break;
            await new Promise((resolve, reject) => {
              const done = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', aborted);
                resolve();
              };
              const aborted = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', aborted);
                reject(signal.reason ?? new Error('Aborted'));
              };
              const timer = setTimeout(done, Math.min(4000, deadline - Date.now()));
              signal?.addEventListener('abort', aborted, { once: true });
            });
          } while (true);
          const state = payload?.run?.status ?? payload?.status;
          if (['queued', 'running'].includes(state)) {
            const cursor = randomUUID();
            pollCursors.set(args.runId, cursor);
            if (pollCursors.size > 32) pollCursors.delete(pollCursors.keys().next().value);
            payload = {
              ...payload,
              waiting: true,
              observedAt: new Date().toISOString(),
              nextPollArguments: { runId: args.runId, pollCursor: cursor },
              nextAction:
                '本次等待窗口正常结束，同一Run仍在运行；下次使用nextPollArguments接续查询，不重新提交或改查其他实验。',
            };
          }
        } else if (params.name === 'rdk_experience_guide')
          payload = {
            clientContext: clientContext(),
            formalTraining: {
              trainTool: 'rdk_originman_train',
              evaluateTool: 'rdk_originman_evaluate',
              note: '仅在用户明确选择预算时使用。默认完整彩排仍为8192步短训；不自动扩训。',
            },
            course: { ...ORIGINMAN_COURSE, links: courseLinks(env.RDK_SIM2REAL_MCP_BASE_URL) },
            learnerInterface: {
              entryPrompt: '带我完成 OriginMan Workshop。',
              locale: 'zh-CN',
              responseOrder: ['当前进度', '本次结果', '下一步'],
              notifyOn: ['stage-change', 'blocked', 'selection-required', 'completed'],
              diagnostics: 'on-demand',
              preferredSurfaces: ['host-workbench', 'browser-link', 'concise-text'],
              inlineAppAvailable: uiEnabled,
              note: uiEnabled
                ? '已协商MCP Apps；是否渲染和播放仍需宿主实际验收。'
                : '当前宿主未协商内联视图；使用平台实验页或简短文字。',
            },
            shortTraining: {
              intent:
                '一句话要求OriginMan短训练、对比效果和回放时使用；无需用户提供UUID或技术参数。',
              course:
                'OriginMan 受扰恢复：完整课程材料由短训工具内部校验，无需手工填写模型或训练参数。',
              manifestSource:
                'bundled-reference-contract; verify against registered model, not retrieved registration',
              courseResourceConfigured: Boolean(env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID),
              operation: (() => {
                const id = operationId;
                return {
                  contextId: id,
                  groupId: id,
                  trainIdempotencyKey: id + '-train',
                  evaluationIdempotencyKey: id + '-eval',
                  note: '本次新训练使用此组标识；重试和评测保留，勿重新生成。',
                };
              })(),
              defaults: {
                backend: 'local',
                taskId: 'originman-recovery',
                profile: 'standard',
                engine: 'originman-recovery-reflect',
                algorithm: 'sac',
                numEnvs: 4,
                maxIterations: 32,
                originmanWorkshop: {
                  phase: 'train',
                  groupId: operationId,
                  timesteps: 8192,
                  seed: 7,
                  pushMaxForce: 8.1,
                },
              },
              steps: [
                '第一步：只传contextId调用rdk_originman_short_train({contextId:operation.contextId})，不要复制manifest.modelId或自行挑资源。此工具执行完整manifest校验、当前账号课程模型/明确资源匹配、健康检查、必填参数装配与单次提交。不要手工重复model_validate或training_submit，不调用experience_prepare/workshop_catalog。',
                '第二步：首次rdk_training_wait({runId:返回的submission.runId})；若仍在运行，下次必须原样使用该回执nextPollArguments接续查询（含pollCursor），直到completed。等待窗口正常结束不是超时错误。失败立即停止，不换contextId、资源或参数重试。',
                '第三步：rdk_originman_short_evaluate({contextId:同一标识})；只允许已完成训练，自动冻结sourceRunId、groupId与参数。用rdk_training_wait及返回的nextPollArguments接续等待同一评测Run至终态。',
                '第四步：rdk_experiment_resume({contextId:同一标识})，核对本次父Run与摘要，展示original/tuned/rl实际对比。优先打开links.experiment；旧平台打开links.workbench并按selection选择本次训练与评测，展开页面播放器播放一次，不直接导航媒体URL；rdk_replay_video只适用于真机遥测，本课程禁止调用。MP4/WebM禁止网页正文抓取、独立HTTP探测或新浏览器登录测试。打开后直接收尾，播放器由宿主实际观察，不循环验证。',
                '只输出简短中文四步进度与真实对比；不主动提出延长训练、换seed或复用contextId调优，不推测效果差的原因。调优必须由用户明确要求并建立新实验。短训不保证提升，未做真机。',
                'stopWorkflow=true停止新的写操作，不拼manifest或换工具重交。若回执明确submitted=true且有原runId，只读查询该Run并展示已有结果；未知提交不猜任务。多个资源仅按名称选择；宿主已配置课程资源时沿用它，不换机。',
              ],
            },
            guide:
              '场景准备：OriginMan一句话短训练必须按shortTraining.steps调用专用编排工具；完整配方已在专用工具内固定，不要手工提交。其他场景按profile与当前工具能力准备。',
            profile: (() => {
              const p = readProfile();
              return p.robot === 'originman' ? { id: p.id, title: p.title, robot: p.robot } : p;
            })(),
          };
        else {
          const call = async (name, args) =>
            readToolResult(
              await upstream.request('tools/call', { name, arguments: args }, { signal }),
            );
          if (SHORT_TRAINING_TOOLS.some((t) => t.name === params.name)) {
            const catalog = await readCatalog(signal);
            payload = await shortTraining(params.name, params.arguments, call, {
              directory: contextDirectory,
              toolNames: catalog.tools.map((t) => t.name),
              submitSchema: catalog.tools.find((t) => t.name === 'rdk_training_submit')
                ?.inputSchema,
              defaultResourceId: env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID,
              courseReadiness:
                upstream.courseReadiness &&
                ((args) => upstream.courseReadiness({ ...args, signal })),
              readModels: upstream.readModels && (() => upstream.readModels({ signal })),
              remote:
                upstream.experimentSession &&
                ((operation, input) => upstream.experimentSession(operation, input, { signal })),
            });
          } else if (EXPERIMENT_TOOLS.some((t) => t.name === params.name)) {
            payload = await experimentContext(
              params.name === 'rdk_experiment_remember' ? 'remember' : 'resume',
              params.arguments,
              call,
              {
                directory: contextDirectory,
                remote:
                  upstream.experimentSession &&
                  ((operation, input) => upstream.experimentSession(operation, input, { signal })),
              },
            );
          } else {
            const catalog = await readCatalog(signal);
            const status = await call('rdk_platform_status', {});
            if (params.name === 'rdk_originman_evaluation_read')
              payload = await readOriginmanEvaluation(params.arguments, call);
            else if (params.name === 'rdk_training_prepare')
              payload = await prepareTraining(
                params.arguments,
                call,
                catalog.tools.map((t) => t.name),
                {
                  courseReadiness:
                    upstream.courseReadiness &&
                    ((args) => upstream.courseReadiness({ ...args, signal })),
                },
              );
            else if (params.name === 'rdk_workflow_inspect')
              payload = await inspectWorkflow(
                params.arguments ?? {},
                call,
                catalog.tools.map((t) => t.name),
              );
            else
              payload = await prepareExperience(params.arguments?.profile ?? readProfile(), call, {
                baseUrl: status.baseUrl,
                tools: catalog.tools.map((t) => t.name),
                action: params.arguments?.action ?? 'check',
              });
          }
        }
        if (['rdk_originman_short_train', 'rdk_originman_train'].includes(params.name)) {
          const runId = payload.submission?.runId ?? payload.experiment?.training?.runId;
          if (runId) {
            workflow = {
              contextId: params.arguments.contextId,
              runId,
              stopped: false,
              completed: false,
            };
            payload = {
              ...payload,
              experiment: {
                ...payload.experiment,
                training: observe(payload.experiment?.training, runId),
              },
            };
          }
        }
        if (['rdk_originman_short_evaluate', 'rdk_originman_evaluate'].includes(params.name)) {
          const runId = payload.submission?.runId ?? payload.experiment?.evaluation?.runId;
          workflow ??= {
            contextId: params.arguments.contextId,
            runId: payload.experiment?.training?.runId,
          };
          if (runId) {
            workflow.evaluationRunId = runId;
            payload = {
              ...payload,
              experiment: {
                ...payload.experiment,
                evaluation: observe(payload.experiment?.evaluation, runId),
              },
            };
          }
        }
        if (params.name === 'rdk_training_wait') payload = observe(payload, params.arguments.runId);
        if (workflow?.stopped)
          payload = {
            ...payload,
            stopWorkflow: true,
            retryAllowed: false,
            nextAction:
              '停止新的提交，保留原Run与原错误；可按原Run只读查询已有状态和结果，不改标识、模型、资源或参数重交。',
          };
        payload = { ...payload, pluginRuntime: pluginRuntimeIdentity() };
        return {
          content: [
            {
              type: 'text',
              text:
                params.name === 'rdk_plugin_status' ||
                (params.name === 'rdk_classroom_guide' && params.arguments?.detail !== 'full')
                  ? payload.studentReply
                  : JSON.stringify(payload),
            },
          ],
          structuredContent: payload,
        };
      } catch (error) {
        const code = error.platformCode ?? error.code ?? '';
        const stop =
          error.stopWorkflow ??
          (SHORT_TRAINING_TOOLS.some((t) => t.name === params.name) &&
            !code.endsWith('_SELECTION_REQUIRED') &&
            code !== 'SIM2REAL_ENGINE_PREFLIGHT_BUSY');
        if (stop && workflow) workflow.stopped = true;
        const payload = {
          ok: false,
          ...(stop ? { stopWorkflow: true, retryAllowed: false } : {}),
          ...(code === 'SUBMISSION_REFERENCE_SAVE_FAILED' &&
          error.details?.submitted === true &&
          error.details?.runId
            ? {
                recovery: {
                  submissionConfirmed: true,
                  readOnly: true,
                  runId: error.details.runId,
                  phase: error.details.phase,
                  nextAction:
                    '任务已提交；按此原Run只读查询，评测完成后读取同源结果，不重新提交。引用恢复失败再交维护者处理。',
                },
              }
            : {}),
          error: {
            message: error.message,
            platformCode: error.platformCode ?? error.code ?? null,
            httpStatus: error.httpStatus ?? null,
            ...(error.needsLogin !== undefined ? { needsLogin: error.needsLogin } : {}),
            ...(error.nextAction ? { nextAction: error.nextAction } : {}),
            ...(error.details ? { details: error.details } : {}),
            ...(error.stopWorkflow !== undefined
              ? { stopWorkflow: error.stopWorkflow, retryAllowed: !error.stopWorkflow }
              : {}),
          },
        };
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }
    }
    const response = await upstream.request(method, params, { signal });
    if (
      method === 'tools/call' &&
      params.name === 'rdk_training_status' &&
      workflow &&
      !response.isError
    ) {
      const value = observe(readToolResult(response), params.arguments.runId);
      if (value.stopWorkflow)
        return {
          ...response,
          structuredContent: value,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        };
    }
    return response;
  };
}

export async function main() {
  const { connectAuthenticatedCore } = await import('./authenticated-core.mjs');
  const upstream = await connectAuthenticatedCore();
  const dispatch = experienceProxy(upstream, { authentication: upstream.authentication });
  const lines = createInterface({ input: process.stdin });
  const active = new Set();
  const controllers = new Map();
  const stop = async () => {
    for (const c of controllers.values()) c.abort();
    lines.close();
    await upstream.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  for await (const line of lines) {
    if (line.length > 1048576) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Request too large.' },
        }) + '\n',
      );
      continue;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON.' },
        }) + '\n',
      );
      continue;
    }
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      typeof request.method !== 'string'
    ) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: { code: -32600, message: 'Invalid request.' },
        }) + '\n',
      );
      continue;
    }
    if (!Object.hasOwn(request, 'id')) {
      if (request.method === 'notifications/cancelled')
        controllers.get(request.params?.requestId)?.abort();
      else upstream.notify(request.method, request.params);
      continue;
    }
    if (controllers.has(request.id)) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32600, message: 'Duplicate request id.' },
        }) + '\n',
      );
      continue;
    }
    const controller = new AbortController();
    controllers.set(request.id, controller);
    const task = dispatch(request.method, request.params, controller.signal)
      .then(
        (result) => ({ jsonrpc: '2.0', id: request.id, result }),
        (error) => ({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: error.message },
        }),
      )
      .then((response) => process.stdout.write(JSON.stringify(response) + '\n'));
    active.add(task);
    task.finally(() => {
      active.delete(task);
      controllers.delete(request.id);
    });
  }
  await Promise.allSettled(active);
  await upstream.close();
}
if (isDirectInvocation(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
