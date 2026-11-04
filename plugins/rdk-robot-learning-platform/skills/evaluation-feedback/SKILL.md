---
name: evaluation-feedback
description: 汇总和比较 RDK 学习平台的训练与真机评测、遥测来源、质量门、反馈及失败回流，形成可追溯的重训建议。
---

# 评测与反馈闭环

交付评测结果、证据来源和可执行的下一步。读 [训练/评测/部署契约](../../references/workflow-contracts.md)，参数查 [工具目录](../../references/tool-catalog.md)。

针对新用户的学习/Sim2Real/部署调优测试见 [用户工作流](../../references/user-journeys.md)。按明确任务、数据摘要和协议比较 baseline/调优 Run；只改单变量并保留两次配置、seed/split、episodes/envelope。缺证据时说明未完成的阶段，不能用目录加载或模拟样本替代真实学习/板端验证。

- 用 `rdk_runs_list`、`rdk_training_status` 选真实 Run；`rdk_evaluations_list` 读取已有评测。明确用户要求的比较对象，显式传 `runId`，避免默认最新记录。
- `rdk_evaluation_summarize` 触发平台 evaluate 再汇总，虽然目录标注只读，它可能生成/刷新评测台账。只查看既有记录时选 list/replay；不要高频反复触发 evaluate。
- 用 `rdk_runs_replay`、`rdk_telemetry_list`、`rdk_board_sessions` 核对数据来源、实际样本、会话身份、停止原因和新鲜度。将模拟、浏览器、导入和真实板端证据分开；真实来源标记也要与 attestation/契约/制品摘要一起核对。
- 比较运行时固定任务、协议、episode 数、envelope 和测量阶段。成功率点估计不能替代任务质量门的置信界；延迟的 host 与 board 阶段不能互作证据。平台质量门结果及缺项直接报告。
- `rdk_retraining_advice` 提供建议；`rdk_feedback_summary` 是产品准确性反馈汇总，不参与发布闸门。人工反馈提交、遥测上传和图表交互通过实际工作台/API，无对应专用 MCP 写工具。
- 失败回流使用真实轨迹登记为 dataset，绑定 `sourceRunId` 与契约，再规划下一轮训练。报告中保留失败、撤销、stale 和 harness unqualified 记录，不只挑成功指标。

无 Run/无遥测时给诚实空态；缺失统计值不得填 0。用户取消时保留已生成的评测和源数据，不继续自动训练。对无法复核的板端证据，结论限定为软件/仿真验证。

本地 MuJoCo 评测与任务研究入口见 [仓库能力](../../references/cli-capabilities.md)；评测导入/状态更新、遥测上传和产品反馈写入见 [版本化 API 工作流](../../references/api-workflows.md)。深层判据从 `$RDK_ROBOT_LEARNING_PLATFORM_ROOT/shared/artifact-quality-gate.ts`、`docs/lineage.md`、对应 `engines/*` 文档读取。
