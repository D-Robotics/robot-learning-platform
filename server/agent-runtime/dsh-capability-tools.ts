import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';

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
  ['rdk_workspace_summary', '读取项目、数据集、运行和部署的工作区摘要', true],
  ['rdk_projects_list', '列出当前账号的机器人学习项目', true],
  ['rdk_project_create', '创建机器人学习项目并绑定模型或数据集', false],
  ['rdk_datasets_list', '列出当前账号的数据集和来源运行', true],
  ['rdk_dataset_register', '登记一个已有轨迹或遥测数据集', false],
  ['rdk_models_list', '列出当前账号登记的模型 manifest', true],
  ['rdk_model_validate', '校验模型 manifest 与目标平台兼容性', true],
  ['rdk_model_register', '登记一个已经校验过的模型 manifest', false],
  ['rdk_runs_list', '按模型、项目或状态列出训练运行', true],
  ['rdk_artifacts_list', '列出模型、检查点、录制和发布制品', true],
  ['rdk_evaluations_list', '列出训练和真机评测记录', true],
  ['rdk_lineage_get', '读取运行、制品、评测或项目的血缘关系', true],
  ['rdk_compute_resources_list', '列出本地、远程和云端训练资源', true],
  ['rdk_compute_resource_test', '测试指定训练资源的健康状态', true],
  ['rdk_device_discover', '发现可连接的 RDK 设备', true],
  ['rdk_device_connect', '连接指定 RDK 设备并探测 BoardAgent', false],
  ['rdk_device_disconnect', '断开指定 RDK 设备的受控连接', false],
  ['rdk_board_health', '读取 BoardAgent 健康、磁盘、传感器和遥测状态', true],
  ['rdk_board_onboarding_preflight', '读取新接入板卡的相机、TROS、遥测和安全预检', true],
  ['rdk_board_station_status', '读取板端状态、传感器和心跳快照', true],
  ['rdk_board_station_command', '执行白名单内的只读板端命令', true],
  ['rdk_board_policy_status', '读取板端策略运行时与延迟证据状态', true],
  ['rdk_board_policy_files', '列出板端已暂存的 ONNX 策略制品', true],
  ['rdk_training_submit', '提交受控 GPU 强化学习训练任务', false],
  ['rdk_training_status', '读取训练任务状态和指标', true],
  ['rdk_runs_replay', '读取运行的遥测回放和聚合评测证据', true],
  ['rdk_telemetry_list', '读取运行的遥测分片和样本数量', true],
  ['rdk_board_sessions', '汇总运行中的板端策略会话和停止原因', true],
  ['rdk_run_logs', '读取本地训练运行的有界日志', true],
  ['rdk_retraining_advice', '根据运行、评测和遥测生成重训建议', true],
  ['rdk_replay_video', '为满足证据条件的真机运行渲染回放视频', false],
  ['rdk_simulator_open', '打开浏览器参考仿真', true],
  ['rdk_evaluation_summarize', '汇总训练评测证据', true],
  ['rdk_feedback_summary', '汇总当前账号对工作台结果的反馈', true],
  ['rdk_artifact_promote', '推进或撤销一个已登记制品的生命周期状态', false],
  ['rdk_deployment_preflight', '执行只读部署预检', true],
  ['rdk_deployment_status', '读取部署计划和当前状态', true],
  ['rdk_deployment_history', '读取部署计划的历史和验证证据', true],
  ['rdk_deployment_version_switch', '为部署计划创建另一个模型版本的只读预检计划', false],
  ['rdk_deployment_cancel', '取消尚未执行板端动作的部署计划', false],
  ['rdk_board_policy_stage', '将真实训练制品暂存到板端策略目录', false],
  ['rdk_board_policy_load', '在板端加载已暂存的 ONNX 策略', false],
  ['rdk_board_policy_start', '在三重安全开关通过后启动板端策略', false],
  ['rdk_board_policy_reset', '在板端策略故障后执行受控复位', false],
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
