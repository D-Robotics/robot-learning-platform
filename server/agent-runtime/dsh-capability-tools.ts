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
  ['rdk_board_arm_status', '读取 D6A 机械臂位姿预检与能力状态', true],
  ['rdk_board_arm_move', '在双安全开关与工作空间钳制下移动 D6A 机械臂', false],
  ['rdk_board_arm_gripper', '在双安全开关与钳制下控制 D6A 夹爪开合', false],
  ['rdk_board_arm_stop', '停止机械臂新命令并尽力回 home（随时可用）', false],
  ['rdk_board_stop', '停止板端策略与驱动', false],
  ['rdk_docs_search', '检索 D-Robotics 官方资料（文档镜像与工程经验帖）', true],
  ['rdk_docs_read', '读取一篇 D-Robotics 官方资料帖子的正文', true],
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

/**
 * System-prompt section that pins how the model answers "你能做什么" questions.
 * Tool schemas alone made the model improvise capability tours that dropped
 * tools and mislabeled which ones sit behind the platform safety gates — the
 * opposite of what a robot-control product must never get wrong. Only bound
 * handlers are advertised, mirroring the model-facing tool schema.
 */
export function capabilityBriefing(handlers: DshCapabilityHandlers = {}): string {
  const catalog = listDshCapabilityCatalog(handlers).filter((item) => item.bound);
  if (catalog.length === 0) return '';
  const gated = catalog.filter((item) => !item.readOnly).map((item) => item.id);
  const readOnlyCount = catalog.length - gated.length;
  const lines = [
    '## RDK 工作台能力口径',
    `- 只介绍本部署已绑定的 ${catalog.length} 个 rdk_* 工具；不得虚构目录之外的工具或能力。`,
    '- 完整工具清单及其只读/门控标注已固定展示在聊天面板的"能力目录"卡片中。用户询问你能做什么时，按工作场景概述主线（数据 → 训练 → 评测 → 部署 → 真机运行），每个场景一两句话即可；不要逐条罗列全部工具，也不必复述目录卡片。',
    `- 其中 ${gated.length} 个工具非只读，实际调用会经过平台安全门控/审批，提及这些能力时必须逐个如实标注：${gated.join('、')}。`,
    `- 其余 ${readOnlyCount} 个均为只读工具，介绍时不得给它们添加"需审批"或"需门控"之类的标注。`,
  ];
  return lines.join('\n');
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
