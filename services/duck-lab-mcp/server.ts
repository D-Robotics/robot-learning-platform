import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

import {
  createDshAuthChannel,
  createDshCapabilityHandlers,
} from '../../server/agent-runtime/dsh-capability-handlers.js';
import type { DshCapabilityHandlers } from '../../server/agent-runtime/dsh-capability-tools.js';
import { listDshCapabilityCatalog } from '../../server/agent-runtime/dsh-capability-tools.js';
import {
  createPlatformFetch,
  describeAuthMode,
  loadPlatformClientConfig,
  type PlatformClientConfig,
  type PlatformFetch,
} from './platform-client.js';
import {
  createJsonRpcDispatcher,
  RpcError,
  serveStdio,
  type JsonRpcMethodContext,
  type JsonRpcMethodHandler,
} from './jsonrpc.js';

export const SERVER_INFO = {
  name: 'duck-lab-mcp',
  title: 'RDK Duck Lab MCP',
  version: '0.1.0',
} as const;

/** Protocol dates this server can speak; a client's version wins when known. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

const PLATFORM_STATUS_TOOL = 'rdk_platform_status';

/**
 * Lifecycle endpoints whose failure mode is "irreversible or state-destroying".
 * Motion tools stay out of this set on purpose: they are gated by
 * readOnlyHint=false and the platform's motion switches, but a move command is
 * not a destructive state transition.
 */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  'rdk_artifact_promote',
  'rdk_deployment_cancel',
  'rdk_device_disconnect',
  'rdk_board_policy_reset',
  'rdk_board_stop',
]);

const INSTRUCTIONS = [
  '这是 RDK 机器人学习平台（Duck Lab）的 MCP 适配层：全部工具经平台版本化 /api/v1/duck API 操作数据、训练、评测、制品、部署与板端运行，幂等、配额、RBAC、审批与运动安全开关均由平台执行，本服务不做任何业务裁决。',
  '约定：1) 工具被拒绝时如实转述平台返回的拒绝原因；机械臂/策略启动类物理动作失败后不要自行重试，先向用户确认。',
  '2) 训练等异步任务提交成功后，用 rdk_training_status / rdk_run_logs / rdk_retraining_advice 轮询，不要为查询进度而重复提交。',
  '3) 写操作可传 idempotencyKey 字符串参数；对同一逻辑操作重试时复用同一值，平台按幂等键去重。',
  '4) rdk_docs_* 返回官方资料，rdk_web_search 返回第三方网络信息；两者冲突时以官方文档为准，引用附来源链接。',
].join('\n');

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
};

/**
 * Per-tool argument hints for the MCP-facing inputSchema. Derived from the
 * capability handlers' own arg readers (requiredArg/argText/argNumber/
 * argStringList and direct `input.<field>` access); `properties` values are
 * JSON Schema type fragments, and every schema keeps
 * `additionalProperties: true` because handlers forward platform-API fields
 * this table does not enumerate. mcp-server.test.ts re-derives this table
 * from the handlers source and fails when they drift apart.
 */
export type ToolParamHint = {
  required: string[];
  properties: Record<string, unknown>;
};

/**
 * Handlers whose args the source-derived extraction cannot see: lineage_get
 * reads exactly one of runId/artifactId/evaluationId/projectId via a selector
 * list. The drift test skips these ids after asserting the override exists.
 */
export const MANUAL_PARAM_HINT_OVERRIDES: Record<string, ToolParamHint> = {
  rdk_lineage_get: {
    required: [],
    properties: {
      runId: { type: 'string' },
      artifactId: { type: 'string' },
      evaluationId: { type: 'string' },
      projectId: { type: 'string' },
    },
  },
};

export const TOOL_PARAM_HINTS: Record<string, ToolParamHint> = {
  rdk_workspace_overview: { required: [], properties: {} },
  rdk_workspace_summary: { required: [], properties: {} },
  rdk_golden_path: {
    required: [],
    properties: {
      projectId: { type: 'string' },
      modelId: { type: 'string' },
      taskId: { type: 'string' },
    },
  },
  rdk_projects_list: { required: [], properties: {} },
  rdk_project_create: {
    required: ['name'],
    properties: {
      name: { type: 'string' },
      modelIds: { type: 'array', items: { type: 'string' } },
      datasetIds: { type: 'array', items: { type: 'string' } },
      slug: { type: 'string' },
      description: { type: 'string' },
    },
  },
  rdk_datasets_list: { required: [], properties: {} },
  rdk_dataset_register: {
    required: ['name'],
    properties: {
      name: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      version: { type: 'string' },
      description: { type: 'string' },
      uri: { type: 'string' },
      format: { type: 'string' },
      contractId: { type: 'string' },
      sourceRunId: { type: 'string' },
      sampleCount: { type: 'number' },
      sizeBytes: { type: 'number' },
    },
  },
  rdk_models_list: { required: [], properties: {} },
  rdk_model_validate: {
    required: [],
    properties: {
      platforms: { type: 'array', items: { type: 'string' } },
      manifest: {},
    },
  },
  rdk_model_register: {
    required: [],
    properties: {
      manifest: {},
    },
  },
  rdk_runs_list: {
    required: [],
    properties: {
      modelId: { type: 'string' },
      projectId: { type: 'string' },
      status: { type: 'string' },
      backend: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  rdk_artifacts_list: {
    required: [],
    properties: {
      type: { type: 'string' },
      modelId: { type: 'string' },
      runId: { type: 'string' },
      projectId: { type: 'string' },
      status: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  rdk_evaluations_list: {
    required: [],
    properties: {
      runId: { type: 'string' },
      artifactId: { type: 'string' },
      status: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  ...MANUAL_PARAM_HINT_OVERRIDES,
  rdk_compute_resources_list: { required: [], properties: {} },
  rdk_compute_resource_test: {
    required: ['computeResourceId'],
    properties: {
      computeResourceId: { type: 'string' },
    },
  },
  rdk_device_discover: { required: [], properties: {} },
  rdk_device_connect: {
    required: [],
    properties: {
      connectionId: { type: 'string' },
    },
  },
  rdk_device_disconnect: {
    required: ['connectionId'],
    properties: {
      connectionId: { type: 'string' },
    },
  },
  rdk_board_health: { required: [], properties: {} },
  rdk_board_onboarding_preflight: { required: [], properties: {} },
  rdk_board_station_status: { required: [], properties: {} },
  rdk_board_station_command: {
    required: ['id'],
    properties: {
      id: { type: 'string' },
    },
  },
  rdk_board_policy_status: { required: [], properties: {} },
  rdk_board_policy_files: { required: [], properties: {} },
  rdk_training_submit: {
    required: [],
    properties: {
      modelId: { type: 'string' },
      backend: { type: 'string' },
      profile: { type: 'string' },
      engine: { type: 'string' },
      algorithm: { type: 'string' },
      numEnvs: { type: 'number' },
      maxIterations: { type: 'number' },
      runName: { type: 'string' },
      taskId: { type: 'string' },
      projectId: { type: 'string' },
      experimentId: { type: 'string' },
      label: { type: 'string' },
      datasetIds: { type: 'array', items: { type: 'string' } },
      computeResourceId: { type: 'string' },
      video: { type: 'boolean' },
    },
  },
  rdk_training_status: {
    required: [],
    properties: {
      runId: { type: 'string' },
    },
  },
  rdk_runs_replay: {
    required: ['runId'],
    properties: {
      runId: { type: 'string' },
    },
  },
  rdk_telemetry_list: {
    required: ['runId'],
    properties: {
      runId: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  rdk_board_sessions: {
    required: ['runId'],
    properties: {
      runId: { type: 'string' },
    },
  },
  rdk_run_logs: {
    required: ['runId'],
    properties: {
      runId: { type: 'string' },
      after: { type: 'number' },
    },
  },
  rdk_retraining_advice: {
    required: ['runId'],
    properties: {
      runId: { type: 'string' },
    },
  },
  rdk_replay_video: {
    required: ['runId'],
    properties: {
      runId: { type: 'string' },
    },
  },
  rdk_simulator_open: { required: [], properties: {} },
  rdk_evaluation_summarize: {
    required: [],
    properties: {
      runId: { type: 'string' },
    },
  },
  rdk_feedback_summary: { required: [], properties: {} },
  rdk_artifact_promote: {
    required: ['artifactId'],
    properties: {
      artifactId: { type: 'string' },
      status: { type: 'string' },
      reason: { type: 'string' },
    },
  },
  rdk_deployment_preflight: {
    required: [],
    properties: {
      modelId: { type: 'string' },
      deviceId: { type: 'string' },
      runId: { type: 'string' },
      artifactId: { type: 'string' },
      evaluationId: { type: 'string' },
    },
  },
  rdk_deployment_status: {
    required: ['deploymentId'],
    properties: {
      deploymentId: { type: 'string' },
    },
  },
  rdk_deployment_history: {
    required: ['deploymentId'],
    properties: {
      deploymentId: { type: 'string' },
    },
  },
  rdk_deployment_version_switch: {
    required: ['deploymentId', 'targetModelId'],
    properties: {
      deploymentId: { type: 'string' },
      targetModelId: { type: 'string' },
    },
  },
  rdk_deployment_cancel: {
    required: ['deploymentId'],
    properties: {
      deploymentId: { type: 'string' },
    },
  },
  rdk_board_policy_stage: {
    required: ['runId'],
    properties: {
      runId: { type: 'string' },
      filename: { type: 'string' },
    },
  },
  rdk_board_policy_load: {
    required: ['path'],
    properties: {
      path: { type: 'string' },
      rehearsalReceipt: {},
    },
  },
  rdk_board_policy_start: {
    required: [],
    properties: {
      direction: { type: 'number' },
      goalX: { type: 'number' },
      goalY: { type: 'number' },
    },
  },
  rdk_board_policy_reset: { required: [], properties: {} },
  rdk_board_arm_status: { required: [], properties: {} },
  rdk_board_arm_move: {
    required: [],
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      z: { type: 'number' },
      speedMmPerS: { type: 'number' },
    },
  },
  rdk_board_arm_gripper: {
    required: [],
    properties: {
      value: { type: 'number' },
      action: {},
    },
  },
  rdk_board_arm_stop: { required: [], properties: {} },
  rdk_board_stop: { required: [], properties: {} },
  rdk_docs_search: {
    required: ['query'],
    properties: {
      query: { type: 'string' },
      manual: { type: 'string' },
    },
  },
  rdk_docs_manuals: { required: [], properties: {} },
  rdk_docs_toc: {
    required: ['manual'],
    properties: {
      manual: { type: 'string' },
      query: { type: 'string' },
    },
  },
  rdk_docs_page: {
    required: ['url'],
    properties: {
      url: { type: 'string' },
    },
  },
  rdk_web_search: {
    required: ['query'],
    properties: {
      query: { type: 'string' },
    },
  },
};

const PLATFORM_STATUS_HINT: ToolParamHint = { required: [], properties: {} };

export function buildInputSchema(hint: ToolParamHint): Record<string, unknown> {
  return {
    type: 'object',
    ...(Object.keys(hint.properties).length ? { properties: hint.properties } : {}),
    ...(hint.required.length ? { required: hint.required } : {}),
    additionalProperties: true,
  };
}

export function buildToolCatalog(
  handlers: DshCapabilityHandlers,
  extra: Array<{ id: string; description: string; readOnly: boolean }> = [],
): McpToolDescriptor[] {
  const catalog = [
    ...listDshCapabilityCatalog(handlers)
      .filter((item) => item.bound)
      .map(({ id, description, readOnly }) => ({ id, description, readOnly })),
    ...extra,
  ];
  return catalog.map(({ id, description, readOnly }) => ({
    name: id,
    description: `${description}。${readOnly ? '只读操作。' : '需要平台安全门控。'}`,
    inputSchema: buildInputSchema(
      (TOOL_PARAM_HINTS[id] as ToolParamHint | undefined) ?? PLATFORM_STATUS_HINT,
    ),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: DESTRUCTIVE_TOOLS.has(id),
    },
  }));
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formatToolError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code && error.name === 'CapabilityError') {
      return `[${code}] ${error.message}`;
    }
    return error.message;
  }
  return String(error);
}

export function createMcpService(
  config: PlatformClientConfig,
  platform: PlatformFetch,
  options: { handlers?: DshCapabilityHandlers } = {},
): { methods: Record<string, JsonRpcMethodHandler>; toolCount: number } {
  const handlers = options.handlers ?? createDshCapabilityHandlers({ fetchImpl: platform.fetch });
  const authChannel = createDshAuthChannel();
  const extraCatalog = [
    {
      id: PLATFORM_STATUS_TOOL,
      description: '读取平台服务健康、就绪与当前会话身份',
      readOnly: true,
    },
  ];
  const tools = buildToolCatalog(handlers, extraCatalog);

  const platformStatusHandler = async (): Promise<Record<string, unknown>> => {
    const [healthResponse, sessionResponse] = await Promise.all([
      platform.requestAppRoute('/healthz'),
      platform.requestAppRoute('/api/sim2real/auth/session'),
    ]);
    const health = await readJsonBody(healthResponse);
    const session = await readJsonBody(sessionResponse);
    return {
      ok: healthResponse.ok && sessionResponse.ok,
      baseUrl: config.baseUrl,
      apiPrefix: config.apiPrefix,
      authMode: describeAuthMode(config),
      health: {
        httpStatus: healthResponse.status,
        ready: health.ready === true,
        degraded: Array.isArray(health.degraded) ? health.degraded : [],
      },
      session: {
        httpStatus: sessionResponse.status,
        authenticated: session.authenticated === true,
        ...(typeof session.displayName === 'string' ? { displayName: session.displayName } : {}),
        ...(typeof session.accountId === 'string' ? { accountId: session.accountId } : {}),
      },
    };
  };

  async function toolsCall(
    params: unknown,
    context: JsonRpcMethodContext,
  ): Promise<Record<string, unknown>> {
    const input =
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    const name = typeof input.name === 'string' ? input.name : '';
    if (!name) throw new RpcError(-32602, 'tools/call 缺少工具名 name。');
    if (!Object.prototype.hasOwnProperty.call(handlers, name) && name !== PLATFORM_STATUS_TOOL) {
      throw new RpcError(-32602, `未知工具：${name}`);
    }

    const rawArgs =
      input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
        ? (input.arguments as Record<string, unknown>)
        : {};
    // Same seam the chat route uses: a stable turn id makes the capability
    // layer derive deterministic idempotency keys, so a client that retries a
    // failed write with the same idempotencyKey hits the ledger's dedupe
    // instead of creating a second run/project. The key travels in a header,
    // so the charset is restricted to token-safe characters.
    const requestedKey = rawArgs.idempotencyKey;
    let turnId: string = randomUUID();
    if (requestedKey !== undefined) {
      if (typeof requestedKey !== 'string' || !requestedKey.trim()) {
        throw new RpcError(-32602, 'idempotencyKey 必须是非空字符串。');
      }
      const candidate = requestedKey.trim().slice(0, 200);
      if (!/^[A-Za-z0-9._:-]+$/.test(candidate)) {
        throw new RpcError(
          -32602,
          'idempotencyKey 只能包含字母、数字和 . _ : - 字符（长度不超过 200）。',
        );
      }
      turnId = candidate;
    }

    const handler =
      name === PLATFORM_STATUS_TOOL
        ? platformStatusHandler
        : (handlers[name] as (args: unknown, exec: ToolRunContext) => Promise<unknown>);

    try {
      const result = (await authChannel.withAuth({ 'x-sim2real-turn-id': turnId }, () =>
        // Capability handlers only consume exec.signal (cancellation from the
        // client's notifications/cancelled); the remaining ToolRunContext
        // members belong to the in-process DSH agent loop.
        Promise.resolve(handler(rawArgs, { signal: context.signal } as ToolRunContext)),
      )) as Record<string, unknown> | unknown;
      const payload = (result ?? {}) as Record<string, unknown>;
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: formatToolError(error) }],
      };
    }
  }

  const methods: Record<string, JsonRpcMethodHandler> = {
    initialize: (params: unknown) => {
      const input =
        params && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      const requested = typeof input.protocolVersion === 'string' ? input.protocolVersion : '';
      return {
        protocolVersion: (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        instructions: INSTRUCTIONS,
      };
    },
    'notifications/initialized': () => ({}),
    'notifications/cancelled': () => ({}),
    ping: () => ({}),
    'tools/list': () => ({ tools }),
    'tools/call': (params: unknown, context: JsonRpcMethodContext) => toolsCall(params, context),
  };

  return { methods, toolCount: tools.length };
}

function isDirectEntryInvocation(): boolean {
  const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(modulePath);
  } catch {
    return argvPath === modulePath;
  }
}

export function main(): void {
  const config = loadPlatformClientConfig();
  const platform = createPlatformFetch(config);
  const service = createMcpService(config, platform);
  serveStdio(createJsonRpcDispatcher(service.methods));
  process.stderr.write(
    `[duck-lab-mcp] platform=${config.baseUrl} api=${config.apiPrefix} auth=${describeAuthMode(config)} tools=${service.toolCount}\n`,
  );
}

if (isDirectEntryInvocation()) {
  main();
}
