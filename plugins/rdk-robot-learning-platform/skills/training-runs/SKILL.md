---
name: training-runs
description: 在 RDK 学习平台选择任务、训练引擎与执行资源，提交训练并跟踪 Run、日志和重训建议；也支持仓库已有的模仿学习和强化学习 CLI。
---

# 训练与 Run

交付单次可追踪的训练请求和 Run 状态，完成时绑定真实产物。读 [训练/评测/部署契约](../../references/workflow-contracts.md)；参数查 [工具目录](../../references/tool-catalog.md)。

用户说“用我的轨迹训练并部署”时按 [用户工作流](../../references/user-journeys.md) 先核对真实数据与训练路径。登记 dataset/传入 datasetIds 只保留来源关联，不保证当前执行器读过这些字节；ACT/BC/DP 的 synthetic-smoke 不能替代用户数据。远程 Agent 没有输入文件时先准备明确的上传/挂载，不凭路径字符串猜数据已到 worker。

1. 确认用户任务、模型、数据、预算和目标设备。用 `rdk_models_list`、`rdk_datasets_list`、`rdk_golden_path` 找可用资源。
2. `rdk_compute_resources_list` 后对选中的 `computeResourceId` 调 `rdk_compute_resource_test`。训练后端和引擎是两项；支持范围取当前资源、worker 配置及任务包，不把已存在的 Python 训练器当作已注册到所有 worker。
3. `rdk_training_submit` 显式传实际 `modelId`、`taskId`、`projectId`、`datasetIds`、`computeResourceId`（适用时）、`backend`、`engine`、`profile` 及预算。默认 backend 是 local、profile 是 smoke；用户要求真训练时先确认 worker 不是 Mock。未知 backend 和本工具不支持的轨迹路径/续训/嵌套 training 字段会在任何请求前拒绝；不改成另一路径重试。读取返回的 `resolvedTraining` 与 `defaultsApplied`，说明所选模型与预算，避免缺参默认首模型被误认成用户选择。用稳定 `idempotencyKey`，提交一次保存返回 `runId`。
4. 用 `rdk_training_status(runId)` 查状态、`rdk_run_logs(runId, after)` 增量读日志。等待间隔随耗时调整，不为查进度再次 submit。结束后查 `rdk_artifacts_list`、`rdk_lineage_get`；再用 `rdk_retraining_advice` 辅助诊断。

训练运行完成不等于质量门通过或可上板。平台、worker 或引擎拒绝时报告原因和残留 Run；不换成 Mock 伪装成功。改变任务/参数才创建新的逻辑操作键。没有资源、模型或可用数据时先完成准备，不擅自启动计费资源。

提交响应中的 `dataUsage.consumptionVerified=false` 表示它没有证明用户数据被消费；`syntheticData.confirmed=null` 表示尚无来源证据，`builtinSmokePath` 只提示当前仓库内置包装的风险，不推断自定义 worker 的实际输入。`status=blocked|failed` 与 `summary`/`note` 原因优先于“请求已登记”，不要把登记成功说成训练已启动。

训练提交只接受 schema 声明的平铺字段及 `idempotencyKey`。额外的 `learningRate`、`seed` 等未公开参数会明确拒绝，不能报告调优生效；字符串/布尔/数值类型必须匹配，例如 `numEnvs` 使用 JSON 数字，不能传 `"16"`。显式无效模型/profile 不会回退默认任务。更细超参用当前引擎 CLI 的真实参数，在同数据、seed、split 和协议下对比；查看留出结果用于调参后，该留出集属于开发评估，最终质量需新独立数据。

仓库 CLI 完成真训练后，报告输入摘要、输出模型/ONNX/验证结果及它们与平台实体的实际关联。离线产物不会自动生成符合发布证据的 completed non-Mock local Run；缺少这条证据时明确停在离线学习结果阶段，不能登记 contract 演练或手改状态冒充可发布 Run。

MCP 无训练取消/续训专用工具。用户取消时停止继续提交和轮询；通过真实工作台/API 查询已提交任务能否取消，不把 MCP `notifications/cancelled` 当成 Run 已停止。续训和更细的 CLI 超参先读实际引擎接口。执行资源 CRUD、运行关联/中继等没有专用 MCP 工具的操作走 [版本化 API 工作流](../../references/api-workflows.md)。

引擎、任务包、自定义奖励、GPU 接入、LeRobot、足球和循环策略的可用仓库入口见 [仓库能力](../../references/cli-capabilities.md)。凭据与执行器路径从部署环境读取，不进入请求 manifest 或共享产物。

真实浏览器示教 BC：提交时指定 `engine=offline-bc`、`demonstrationRunId` 和真实 local worker。平台冻结 observation/action 字节与摘要，校验同账号、同模型和维度；完成后核对数据消费回执与 ONNX。录制必须配对同一次推理前输入和输出，避免当前动作泄漏到 last_action 槽。闭环评测需新 reset，覆盖站立、前进、转向及 zero/参考对照；拒载或跌倒保留失败，不绕过验证器。
