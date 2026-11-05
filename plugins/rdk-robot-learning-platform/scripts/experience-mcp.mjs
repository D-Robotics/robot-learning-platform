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

// Capture at import time so an old cached process cannot claim newly replaced files.
const loadedSources = Object.fromEntries(
  [
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
  ].map((name) => [
    'scripts/' + name,
    createHash('sha256')
      .update(readFileSync(new URL(name, import.meta.url)))
      .digest('hex'),
  ]),
);
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
      '读取可复用的场景准备、恢复与自由探索指南，以及本次宿主计算接口配置状态；不返回凭据，不依赖宿主 load_skill。',
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
  { env = process.env, authentication, contextDirectory, waitBudgetMs = 20000 } = {},
) {
  let workflow = null;
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
          : '当前进程缺少受管计算宿主接口绑定。即使正在桌面 Studio 内，也需核对兼容宿主接口与插件连接配置；重复登录或改用独立 MCP 不会补齐接口。已有远程训练资源仍可单独检查。',
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
      const result = await upstream.request(method, params, { signal });
      return {
        ...result,
        instructions:
          (result.instructions ?? '') +
          '\n认证：先读platform_status。未认证时调用rdk_auth_login取得浏览器登录确认入口；请用户在浏览器登录并确认验证码，然后调用rdk_auth_status完成连接，不索取密码或Cookie。Studio使用宿主绑定的当前身份，未登录时请在Studio账号菜单登录，不扫描其他账号、不静默切换。' +
          '\n交互约定：默认简短中文，按“当前进度→本次结果→下一步”回答。认证、版本、契约和资源校验在后台完成，正常时不逐项播报。只在阶段变化、阻断或需要用户选择时更新；不重复播报running，不展示内部推理。UUID、工具名、摘要和错误码仅在用户查看诊断时展开。正常结果优先给曲线、对比图和回放入口；宿主能打开工作台则在工作台展示，否则给可点击链接。没有实际渲染能力不伪装交互卡片，没有播放器观测不称已播放。' +
          '\n用户说“带我完成OriginMan Workshop”或明确要求短训练、评测和回放，即授权8192步仅仿真流程；仅介绍或咨询不提交。后台先rdk_auth_status核对认证及pluginRuntime，再rdk_experience_guide取得operation.contextId，依次rdk_originman_short_train、rdk_training_wait、rdk_originman_short_evaluate、rdk_training_wait、rdk_experiment_resume及rdk_originman_evaluation_read。只传专用工具要求的标识，模型、manifest和绑定资源由工具校验，不重复调用prepare/catalog或手拼training_submit。不要让用户填写UUID。只有未登录、明确选择歧义或真实阻断才提问。宿主已绑定课程资源时沿用它，不按名称猜其他机器。' +
          '\n等待：沿用同一Run及nextPollArguments，正常等待窗口结束继续读；不启动shell sleep。失败或stopWorkflow=true停止所有自动提交，不换标识、资源或参数重交；仍可只读查询原Run、日志及恢复已有引用。SUBMISSION_REFERENCE_SAVE_FAILED表示任务已经提交，保留回执并恢复，绝不能说尚未提交。' +
          '\n实验接续：通用流程提交后用明确contextId保存训练及同源评测引用；专用短训工具已保存，无需重复。跨聊天或软件继续时使用明确实验标识调用experiment_resume，并重新验证当前平台和账号；不选择全局最新Run，不扫描其他账号。本机引用不等于跨机器同步。404、网络失败和断线不触发重交。新实验使用新contextId，调参须用户明确提出。' +
          '\n结果：只展示本次Run的真实original/tuned/rl对比；执行完成、质量提升和真机资格分别判断，短训不承诺提升。回放用resume的links.video由宿主打开一次，OriginMan不调用真机rdk_replay_video或evaluationId接口；媒体链接不做正文抓取、HEAD、curl或独立浏览器认证探测。没有观测就报告播放待验证。一般流程用workflow_inspect按需看证据，不默认打印整张技术状态表；新训练前training_prepare刷新资源。默认GPU，CPU须明确选择，不自动降级、不操作真机。\n本次原生计算配置：' +
          clientContext().nativeCompute.configuration +
          '。宿主接口缺失时不要要求已经在桌面中的用户重复“去桌面操作”；用指南中的 clientContext 说明实际缺口。',
      };
    }
    if (method === 'tools/list') {
      const result = validateCatalogPage(await upstream.request(method, params, { signal }));
      // Preserve upstream paging; advertise the extension exactly once, on the final page.
      return result.nextCursor === undefined
        ? {
            ...result,
            tools: [
              ...result.tools.map((t) =>
                t.name === 'rdk_replay_video'
                  ? {
                      ...t,
                      description:
                        '仅用于真机遥测视频渲染；OriginMan短训评测的视频已随评测Run生成，不能用本工具。请rdk_experiment_resume获取links.video并由宿主打开。\n' +
                        t.description,
                    }
                  : t,
              ),
              ...EXPERIENCE_TOOLS,
            ],
          }
        : result;
    }
    if (method === 'tools/call' && workflow && params.name === 'rdk_replay_video') {
      const value = {
        ok: false,
        stopWorkflow: false,
        error: {
          platformCode: 'ORIGINMAN_REPLAY_ROUTE',
          message: 'OriginMan评测视频不使用真机遥测渲染工具。',
          nextAction:
            '调用rdk_experiment_resume，使用其links.video由宿主打开。不要新建评测或渲染任务。',
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
      ((params.name === 'rdk_originman_short_train' &&
        (workflow.stopped || params.arguments?.contextId !== workflow.contextId)) ||
        (params.name === 'rdk_originman_short_evaluate' && workflow.stopped) ||
        params.name === 'rdk_training_submit' ||
        (workflow.stopped && params.name === 'rdk_model_register'))
    )
      return stoppedResult();
    if (method === 'tools/call' && EXPERIENCE_TOOLS.some((t) => t.name === params.name)) {
      try {
        let payload;
        const operationId = 'om-' + randomUUID().replaceAll('-', '').slice(0, 20);
        if (AUTH_TOOLS.some((t) => t.name === params.name)) {
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
            learnerInterface: {
              entryPrompt: '带我完成 OriginMan Workshop。',
              locale: 'zh-CN',
              responseOrder: ['当前进度', '本次结果', '下一步'],
              notifyOn: ['stage-change', 'blocked', 'selection-required', 'completed'],
              diagnostics: 'on-demand',
              preferredSurfaces: ['host-workbench', 'browser-link', 'concise-text'],
              inlineAppAvailable: false,
              note: '本版尚未提供MCP Apps资源；可交互工作台是否嵌入由宿主实际能力决定。',
            },
            shortTraining: {
              intent:
                '一句话要求OriginMan短训练、对比效果和回放时使用；无需用户提供UUID或技术参数。',
              course:
                'OriginMan 受扰恢复：完整课程材料由短训工具内部校验，无需手工填写模型或训练参数。',
              manifestSource:
                'bundled-reference-contract; verify against registered model, not retrieved registration',
              courseResourceConfigured: Boolean(env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID),
              resourceSelection: env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID
                ? 'host-bound; do not select a different resource by name'
                : 'explicit-selection-if-ambiguous',
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
                '第四步：rdk_experiment_resume({contextId:同一标识})，核对本次父Run与摘要，展示original/tuned/rl实际对比。用宿主打开其links.video一次；rdk_replay_video只适用于真机遥测，本课程禁止调用。MP4/WebM禁止网页正文抓取、独立HTTP探测或新浏览器登录测试。打开后直接收尾，播放器由宿主实际观察，不循环验证。',
                '只输出简短中文四步进度与真实对比；不主动提出延长训练、换seed或复用contextId调优，不推测效果差的原因。调优必须由用户明确要求并建立新实验。短训不保证提升，未做真机。',
                'stopWorkflow=true停止自动写入并解释阻断；已提交任务可只读查询原Run、日志和恢复引用，禁止重交、拼manifest或改用其他提交工具。多个资源仅按名称选择；宿主已配置课程资源时沿用它，不换机。',
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
              defaultResourceId: env.RDK_WORKSHOP_COMPUTE_RESOURCE_ID,
              readModels: upstream.readModels && (() => upstream.readModels({ signal })),
            });
          } else if (EXPERIMENT_TOOLS.some((t) => t.name === params.name)) {
            payload = await experimentContext(
              params.name === 'rdk_experiment_remember' ? 'remember' : 'resume',
              params.arguments,
              call,
              { directory: contextDirectory },
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
        if (params.name === 'rdk_originman_short_train') {
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
        if (params.name === 'rdk_originman_short_evaluate') {
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
            nextAction: '保留原Run与原错误，立即结束本轮；不改标识、模型、资源或参数重交。',
          };
        payload = { ...payload, pluginRuntime: pluginRuntimeIdentity() };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
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
