#!/usr/bin/env node
/** Add read-only experience composition while preserving the installed upstream MCP. */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  connectMcp,
  prepareExperience,
  readToolResult,
  isDirectInvocation,
} from './experience.mjs';
import { WORKFLOW_TOOLS, inspectWorkflow, prepareTraining } from './workflow-inspection.mjs';
import { EXPERIMENT_TOOLS, experimentContext } from './experiment-context.mjs';

export const EXPERIENCE_TOOLS = [
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

export function experienceProxy(upstream, { env = process.env, contextDirectory } = {}) {
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
          '\n实验接续：提交训练后，用新的明确 contextId 调 rdk_experiment_remember 保存返回的训练Run；提交评测后以同一contextId、训练Run和评测Run补关联。用户说“继续刚才实验”时调用 rdk_experiment_resume；只有明确知道该contextId才恢复，歧义时询问，不选全局最新Run。等待、断线、404或blocked不自动重交训练；新训练使用新contextId。回放入口仍需宿主实际打开与确认播放，不能根据链接生成声称已播放。MP4不调用网页正文抓取；超时不代表401或登录墙。没有播放器观测能力就报告未自动核验，不为视频验证申请新系统权限。OriginMan的evaluate Run不是独立evaluation实体，不套用evaluationId接口。\n准备演示、首次体验或课程时优先调用 rdk_experience_guide 与 rdk_experience_prepare；可按用户目标自由组合步骤。工具准备成功不表示仿真已经运行。仿真、训练、调优、部署的全流程状态用 rdk_workflow_inspect 读取并展示 markdown 表格；未取得证据保持待验证。新提交训练前用 rdk_training_prepare 同时刷新资源健康和任务环境，预检结果不是训练结果；已提交任务只按 Run ID 查询。默认先一次流程检查并展示状态表；有明确阻塞时先解释和恢复，不为了凑齐工具而展开大量无关查询。指定 Run 的结论必须绑定同一 Run 和摘要，不借用全局 golden_path 或其他 Run 的通过状态；用户需要时再展开明细。\n本次原生计算配置：' +
          clientContext().nativeCompute.configuration +
          '。宿主接口缺失时不要要求已经在桌面中的用户重复“去桌面操作”；用指南中的 clientContext 说明实际缺口。',
      };
    }
    if (method === 'tools/list') {
      const result = validateCatalogPage(await upstream.request(method, params, { signal }));
      // Preserve upstream paging; advertise the extension exactly once, on the final page.
      return result.nextCursor === undefined
        ? { ...result, tools: [...result.tools, ...EXPERIENCE_TOOLS] }
        : result;
    }
    if (method === 'tools/call' && EXPERIENCE_TOOLS.some((t) => t.name === params.name)) {
      try {
        let payload;
        if (params.name === 'rdk_experience_guide')
          payload = {
            clientContext: clientContext(),
            guide: readFileSync(
              new URL('../skills/experience-preparation/SKILL.md', import.meta.url),
              'utf8',
            ),
            profile: readProfile(),
          };
        else {
          const call = async (name, args) =>
            readToolResult(
              await upstream.request('tools/call', { name, arguments: args }, { signal }),
            );
          if (EXPERIMENT_TOOLS.some((t) => t.name === params.name)) {
            payload = await experimentContext(
              params.name === 'rdk_experiment_remember' ? 'remember' : 'resume',
              params.arguments,
              call,
              { directory: contextDirectory },
            );
          } else {
            const catalog = await readCatalog(signal);
            const status = await call('rdk_platform_status', {});
            if (params.name === 'rdk_training_prepare')
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
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch (error) {
        const payload = {
          ok: false,
          error: {
            message: error.message,
            platformCode: error.platformCode ?? null,
            httpStatus: error.httpStatus ?? null,
          },
        };
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      }
    }
    return upstream.request(method, params, { signal });
  };
}

export async function main() {
  const upstream = connectMcp();
  const dispatch = experienceProxy(upstream);
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
