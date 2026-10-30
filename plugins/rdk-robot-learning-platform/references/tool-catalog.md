# MCP 工具目录（由仓库契约生成）

当前同源目录共 59 个工具；JSON 全量 descriptor（含 schema/annotation）见 [tool-catalog.json](tool-catalog.json)。

生成真源：目标仓库 `server/agent-runtime/dsh-capability-tools.ts`、`dsh-capability-handlers.ts`、`services/duck-lab-mcp/server.ts`。在 `RDK_ROBOT_LEARNING_PLATFORM_ROOT` 执行：

```bash
node --import tsx/esm scripts/update-platform-plugin-catalog.mjs
node --import tsx/esm scripts/update-platform-plugin-catalog.mjs --check
```

安装后以实际 `tools/list` 为准；插件验证对 JSON 快照与实际目录的 schema/annotation 做完整比较。生成不联系平台。

## 输入和标注

`*` 是 MCP schema.required 字段；schema 是类型提示，不替代 handler/API 的业务必填校验。所有工具允许额外字段，但 handler 不保证透传任意字段。

已知 handler 额外条件：`rdk_device_connect` 需要 connectionId；`rdk_board_policy_start` 需要数值 direction；`rdk_board_arm_move` 需要数值 x/y/z（mm）；`rdk_board_arm_gripper` 需要 action=open|close 及正数 value。dataset_register 接受 sha256；policy_load 接受 artifactSha256；station 类工具接受可选 deviceId。

`readOnlyHint` 是产品标注：preflight 可创建台账计划，evaluation_summarize 可刷新评测；不会因此运动。`destructiveHint` 也不等于所有物理动作，非只读动作仍遵守平台门禁和授权。稳定 idempotencyKey 通用参数由 MCP 接受，不能据此保证每个动作去重，详见 [连接契约](connection-contract.md)。

| 工具 | 功能 | readOnlyHint | destructiveHint | schema 参数 |
| --- | --- | --- | --- | --- |
| `rdk_workspace_overview` | 读取当前模型、设备、训练资源和运行状态。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_workspace_summary` | 读取项目、数据集、运行和部署的工作区摘要。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_golden_path` | 读取从任务、数据、训练到 RDK 反馈的唯一主链路进度。只读操作。 | true | false | `projectId: string`, `modelId: string`, `taskId: string`, `idempotencyKey: string` |
| `rdk_projects_list` | 列出当前账号的机器人学习项目。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_project_create` | 创建机器人学习项目并绑定模型或数据集。需要平台安全门控。 | false | false | `name*: string`, `modelIds: array<string>`, `datasetIds: array<string>`, `slug: string`, `description: string`, `idempotencyKey: string` |
| `rdk_datasets_list` | 列出当前账号的数据集和来源运行。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_dataset_register` | 登记一个已有轨迹或遥测数据集。需要平台安全门控。 | false | false | `name*: string`, `tags: array<string>`, `version: string`, `description: string`, `uri: string`, `format: string`, `sha256: string`, `contractId: string`, `sourceRunId: string`, `sampleCount: number`, `sizeBytes: number`, `idempotencyKey: string` |
| `rdk_models_list` | 列出当前账号登记的模型 manifest。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_model_validate` | 校验模型 manifest 与目标平台兼容性。只读操作。 | true | false | `platforms: array<string>`, `manifest: any`, `idempotencyKey: string` |
| `rdk_model_register` | 登记一个已经校验过的模型 manifest。需要平台安全门控。 | false | false | `manifest: any`, `idempotencyKey: string` |
| `rdk_runs_list` | 按模型、项目或状态列出训练运行。只读操作。 | true | false | `modelId: string`, `projectId: string`, `status: string`, `backend: string`, `query: string`, `limit: number`, `idempotencyKey: string` |
| `rdk_artifacts_list` | 列出模型、检查点、录制和发布制品。只读操作。 | true | false | `type: string`, `modelId: string`, `runId: string`, `projectId: string`, `status: string`, `query: string`, `limit: number`, `idempotencyKey: string` |
| `rdk_evaluations_list` | 列出训练和真机评测记录。只读操作。 | true | false | `runId: string`, `artifactId: string`, `status: string`, `limit: number`, `idempotencyKey: string` |
| `rdk_lineage_get` | 读取运行、制品、评测或项目的血缘关系。只读操作。 | true | false | `runId: string`, `artifactId: string`, `evaluationId: string`, `projectId: string`, `idempotencyKey: string` |
| `rdk_compute_resources_list` | 列出本地、远程和云端训练资源。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_compute_resource_test` | 测试指定训练资源的健康状态。只读操作。 | true | false | `computeResourceId*: string`, `idempotencyKey: string` |
| `rdk_device_discover` | 发现可连接的 RDK 设备。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_device_connect` | 连接指定 RDK 设备并探测 BoardAgent。需要平台安全门控。 | false | false | `connectionId*: string`, `idempotencyKey: string` |
| `rdk_device_disconnect` | 断开指定 RDK 设备的受控连接。需要平台安全门控。 | false | true | `connectionId*: string`, `idempotencyKey: string` |
| `rdk_board_health` | 读取 BoardAgent 健康、磁盘、传感器和遥测状态。只读操作。 | true | false | `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_onboarding_preflight` | 读取新接入板卡的相机、TROS、遥测和安全预检。只读操作。 | true | false | `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_station_status` | 读取板端状态、传感器和心跳快照。只读操作。 | true | false | `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_station_command` | 执行白名单内的只读板端命令。只读操作。 | true | false | `id*: string`, `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_policy_status` | 读取板端策略运行时与延迟证据状态。只读操作。 | true | false | `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_policy_files` | 列出板端已暂存的 ONNX 策略制品。只读操作。 | true | false | `deviceId: string`, `idempotencyKey: string` |
| `rdk_training_submit` | 提交受控强化学习或真实轨迹 BC 训练任务。需要平台安全门控。 | false | false | `modelId: string`, `demonstrationRunId: string`, `originmanWorkshop: object`, `backend: string`, `profile: string`, `engine: string`, `algorithm: string`, `numEnvs: number`, `maxIterations: number`, `runName: string`, `taskId: string`, `projectId: string`, `experimentId: string`, `label: string`, `datasetIds: array<string>`, `computeResourceId: string`, `video: boolean`, `idempotencyKey: string` |
| `rdk_training_status` | 读取训练任务状态和指标。只读操作。 | true | false | `runId*: string`, `idempotencyKey: string` |
| `rdk_runs_replay` | 读取运行的遥测回放和聚合评测证据。只读操作。 | true | false | `runId*: string`, `idempotencyKey: string` |
| `rdk_telemetry_list` | 读取运行的遥测分片和样本数量。只读操作。 | true | false | `runId*: string`, `limit: number`, `idempotencyKey: string` |
| `rdk_board_sessions` | 汇总运行中的板端策略会话和停止原因。只读操作。 | true | false | `runId*: string`, `idempotencyKey: string` |
| `rdk_run_logs` | 读取本地训练运行的有界日志。只读操作。 | true | false | `runId*: string`, `after: number`, `idempotencyKey: string` |
| `rdk_retraining_advice` | 根据运行、评测和遥测生成重训建议。只读操作。 | true | false | `runId*: string`, `idempotencyKey: string` |
| `rdk_replay_video` | 为满足证据条件的真机运行渲染回放视频。需要平台安全门控。 | false | false | `runId*: string`, `idempotencyKey: string` |
| `rdk_workshop_catalog` | 读取指定机器人的课程契约和训练模板（不提交训练）。只读操作。 | true | false | `robot*: string`, `idempotencyKey: string` |
| `rdk_simulator_open` | 打开浏览器参考仿真。只读操作。 | true | false | `robot: string`, `runId: string`, `idempotencyKey: string` |
| `rdk_evaluation_summarize` | 汇总训练评测证据。只读操作。 | true | false | `runId: string`, `idempotencyKey: string` |
| `rdk_feedback_summary` | 汇总当前账号对工作台结果的反馈。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_artifact_promote` | 推进或撤销一个已登记制品的生命周期状态。需要平台安全门控。 | false | true | `artifactId*: string`, `status*: string`, `reason: string`, `idempotencyKey: string` |
| `rdk_deployment_preflight` | 执行只读部署预检。只读操作。 | true | false | `modelId: string`, `deviceId: string`, `runId: string`, `artifactId: string`, `evaluationId: string`, `idempotencyKey: string` |
| `rdk_deployment_status` | 读取部署计划和当前状态。只读操作。 | true | false | `deploymentId*: string`, `idempotencyKey: string` |
| `rdk_deployment_history` | 读取部署计划的历史和验证证据。只读操作。 | true | false | `deploymentId*: string`, `idempotencyKey: string` |
| `rdk_deployment_version_switch` | 为部署计划创建另一个模型版本的只读预检计划。需要平台安全门控。 | false | false | `deploymentId*: string`, `targetModelId*: string`, `idempotencyKey: string` |
| `rdk_deployment_cancel` | 取消尚未执行板端动作的部署计划。需要平台安全门控。 | false | true | `deploymentId*: string`, `idempotencyKey: string` |
| `rdk_board_policy_stage` | 将真实训练制品暂存到板端策略目录。需要平台安全门控。 | false | false | `runId*: string`, `filename: string`, `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_policy_load` | 在板端加载已暂存的 ONNX 策略。需要平台安全门控。 | false | false | `path*: string`, `artifactSha256: string`, `rehearsalReceipt: any`, `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_policy_start` | 在三重安全开关通过后启动板端策略。需要平台安全门控。 | false | false | `direction: number`, `goalX: number`, `goalY: number`, `command: object`, `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_policy_command` | 更新经校准关节策略的限时速度命令，过期自动归零。需要平台安全门控。 | false | false | `command*: object`, `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_policy_reset` | 在板端策略故障后执行受控复位。需要平台安全门控。 | false | true | `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_arm_status` | 读取 D6A 机械臂位姿预检与能力状态。只读操作。 | true | false | `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_arm_move` | 在双安全开关与工作空间钳制下移动 D6A 机械臂。需要平台安全门控。 | false | false | `x*: number`, `y*: number`, `z*: number`, `speedMmPerS: number`, `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_arm_gripper` | 在双安全开关与钳制下控制 D6A 夹爪开合。需要平台安全门控。 | false | false | `action*: string`, `value*: number`, `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_arm_stop` | 停止机械臂新命令并尽力回 home（随时可用）。需要平台安全门控。 | false | false | `deviceId: string`, `idempotencyKey: string` |
| `rdk_board_stop` | 停止板端策略与驱动。需要平台安全门控。 | false | true | `deviceId: string`, `idempotencyKey: string` |
| `rdk_docs_search` | 检索 D-Robotics 官方文档与社区（结果按官方/相关/论坛补充排序）。只读操作。 | true | false | `query*: string`, `manual: string`, `idempotencyKey: string` |
| `rdk_docs_manuals` | 列出 D-Robotics 官方手册目录。只读操作。 | true | false | `idempotencyKey: string` |
| `rdk_docs_toc` | 读取指定官方手册的章节目录。只读操作。 | true | false | `manual*: string`, `query: string`, `idempotencyKey: string` |
| `rdk_docs_page` | 读取一篇官方文档或社区帖子的正文（Markdown，仅限官方站点）。只读操作。 | true | false | `url*: string`, `idempotencyKey: string` |
| `rdk_web_search` | 全网搜索公开资料（免费通用检索；结果为第三方信息，非官方结论）。只读操作。 | true | false | `query*: string`, `idempotencyKey: string` |
| `rdk_platform_status` | 读取平台服务健康、就绪与当前会话身份。只读操作。 | true | false | `idempotencyKey: string` |

## 工作流入口

[训练/评测/部署](workflow-contracts.md) · [设备](device-contracts.md) · [API 能力](api-workflows.md) · [CLI/工作台](cli-capabilities.md) · [开发不变量](development-invariants.md)
