---
name: workspace-data
description: 在 RDK 学习平台管理项目、模型 manifest、数据集版本并追踪数据到 Run、制品、评测和部署的 lineage；用于数据准备、模型接入和来源查询。
---

# 项目、数据和模型

交付可追溯资源及其 ID，或明确缺少的输入。参数见 [工具目录](../../references/tool-catalog.md)，通用连接、幂等和错误约束见 [连接契约](../../references/connection-contract.md)。

1. 用 `rdk_workspace_overview`、`rdk_workspace_summary` 查看当前工作区；用 `rdk_projects_list`、`rdk_datasets_list`、`rdk_models_list` 选择实际 ID。用户指定目标时显式传 ID，避免默认首个模型。
2. 创建项目用 `rdk_project_create`，可绑定 `modelIds` / `datasetIds`。登记已有数据用 `rdk_dataset_register`：它登记元数据，不下载/上传数据内容。保留版本、内容 `sha256`、`contractId`、`sourceRunId`、数量及 URI；来源 Run 必须属于当前账号，契约必须一致。
3. 模型先 `rdk_model_validate`，检查 `valid`、`errors`、`warnings` 和目标平台兼容性；通过后用 `rdk_model_register` 登记同一 manifest。登记不会执行上传的脚本。维度、观测布局、状态输入命名、模型摘要以平台校验为准，不能“修成通过”而改变用户模型语义。
4. `rdk_runs_list`、`rdk_artifacts_list`、`rdk_evaluations_list` 按真实 ID 查询结果；`rdk_lineage_get` 每次选择 `runId` / `artifactId` / `evaluationId` / `projectId` 中一个。末尾用 `rdk_golden_path` 更新下一步建议。

写请求带稳定 `idempotencyKey`，同一逻辑重试复用；超时先查列表和 lineage，确认是否已创建。没有数据时说明可采集/导入的入口，不合成训练数据或来源记录；撤销、缺失和不匹配的来源应保留为失败证据。取消时保留已登记实体，不主动删除。

LeRobot 导入导出、轨迹格式、文件校验及 CLI 训练见 [仓库能力](../../references/cli-capabilities.md)。项目修改/对比、数据集 ready/撤销、模型单条详情等走 [版本化 API 工作流](../../references/api-workflows.md) 中的真实入口；先读取目标仓库契约，不发明专用上传或删除 MCP 工具。
