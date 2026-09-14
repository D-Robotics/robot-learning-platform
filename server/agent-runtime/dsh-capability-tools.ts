import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';

type Handler = (args: unknown, exec: ToolRunContext) => Promise<unknown>;
export type DshCapabilityHandlers = Partial<Record<string, Handler>>;
export type DshCapabilityDescriptor = {
  id: string;
  description: string;
  readOnly: boolean;
  /** Whether this deployment supplied a real product handler. */
  bound: boolean;
};

const names: Array<[string, string, boolean]> = [
  ['rdk_workspace_overview', '读取当前模型、设备、训练资源和运行状态', true],
  ['rdk_device_discover', '发现可连接的 RDK 设备', true],
  ['rdk_device_connect', '连接指定 RDK 设备并探测 BoardAgent', false],
  ['rdk_board_health', '读取 BoardAgent 健康、磁盘、传感器和遥测状态', true],
  ['rdk_training_submit', '提交受控 GPU 强化学习训练任务', false],
  ['rdk_training_status', '读取训练任务状态和指标', true],
  ['rdk_simulator_open', '打开浏览器参考仿真', true],
  ['rdk_evaluation_summarize', '汇总训练评测证据', true],
  ['rdk_deployment_preflight', '执行只读部署预检', true],
  ['rdk_board_stop', '停止板端策略与驱动', false],
];

/**
 * Return the product capability catalog without exposing executable handlers.
 *
 * DSH can be installed independently from the board/GPU adapters.  Keeping
 * the catalog explicit lets the UI and operators distinguish a capability
 * that is part of the contract from one that is actually wired in this
 * deployment; advertising every schema as callable made an unbound tool look
 * like a production feature.
 */
export function listDshCapabilityCatalog(
  handlers: DshCapabilityHandlers = {},
): DshCapabilityDescriptor[] {
  return names.map(([id, description, readOnly]) => ({
    id,
    description,
    readOnly,
    bound: typeof handlers[id] === 'function',
  }));
}
const output = {
  schema: { type: 'object', additionalProperties: true } as Record<string, unknown>,
  render: (_args: unknown, value: JsonValue) => [
    { type: 'text' as const, text: JSON.stringify(value ?? {}) },
  ],
};
export function installDshCapabilityTools(ctx: Context, handlers: DshCapabilityHandlers = {}) {
  const disposers: Array<() => void> = [];
  // Do not put placeholders into the model-facing tool schema. A model can
  // only make a useful call to a capability with a real product binding;
  // unavailable adapters remain visible through listDshCapabilityCatalog().
  for (const [name, description, readOnly] of names) {
    const handler = handlers[name];
    if (typeof handler !== 'function') continue;
    const definition: ToolDefinition = {
      name,
      description: `${description}。${readOnly ? '只读操作。' : '需要平台安全门控。'}`,
      parameters: { type: 'object', additionalProperties: true },
      output,
      execute: async (args, exec) => {
        return handler(args, exec);
      },
    };
    disposers.push(ctx.tools.register(definition));
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
