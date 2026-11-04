---
name: artifacts-deployments
description: 在 RDK 学习平台追踪与晋级训练制品、生成部署预检计划、检查审批和发布证据、规划版本切换并取消尚未执行的计划。
---

# 制品与受控部署

交付可复核的制品状态和部署计划，而不是仅报告命令成功。先读 [训练/评测/部署契约](../../references/workflow-contracts.md)，参数查 [工具目录](../../references/tool-catalog.md)。

一句话训练到部署的链路及负例见 [用户工作流](../../references/user-journeys.md)。结果必须区分离线训练产物、平台合格 Run、制品发布、预检计划、审批 ready、板端加载与真实执行。CLI 学习结果未绑定合格 Run 时先报告该断点，不用 contract/Mock/手填 completed 补成上线证据。

1. `rdk_artifacts_list`、`rdk_evaluations_list`、`rdk_lineage_get` 核对 Run、manifest、数据与 SHA-256。晋级使用 `rdk_artifact_promote(artifactId, status)`；只支持 `validated` / `published` / `revoked`，撤销记录 `reason`。平台拒绝的证据缺项不能靠直接编辑台账补成通过。
2. `rdk_deployment_preflight` 显式绑定 `modelId`、`deviceId` 及适用的 `runId`、`artifactId`、`evaluationId`，带稳定 `idempotencyKey`。它创建 preflight 台账计划并执行只读板端检查；不会部署字节或运动。记录 `deploymentId`、`passed`、`mock`、`checks`。
3. `rdk_deployment_status`、`rdk_deployment_history` 核对状态、审批和验证证据。Mock 协议演练只能报告演练通过。
4. `rdk_deployment_version_switch(deploymentId,targetModelId)` 创建目标版本的预检计划，返回新 ID；它不立即切换正在运行的策略。`rdk_deployment_cancel` 只取消平台仍允许取消的计划，409 时报告当前状态。

Canary/Live 创建、审批、真实执行与回滚没有专用 MCP 工具。需要这些动作时使用已实现工作台或 [版本化 API 工作流](../../references/api-workflows.md)，先读取目标仓库真实契约，并遵守现有用户授权和平台 owner/admin 审批。审批变为 ready 也不会直接下发模型或开电机；实际动作走受控 BoardAgent。制品登记/单条详情与专用 validate/publish 路由也在该 API 工作流中，不发明额外 `rdk_*` 工具。

制品签发、BPU 编译及 board-onnx 延迟 rehearsal 为仓库 CLI，见 [仓库能力](../../references/cli-capabilities.md)。签名密钥只从环境读取，不把 CLI 的编译完成当成整条发布门通过。

没有制品或目标设备时停在准备阶段；请求超时先查原计划/原制品，保持逻辑操作键。用户取消时停止新动作，保留已发布制品与已执行部署状态；不要暗示取消计划会把运动或发布自动撤销。

质量门拒绝时给出具体 check、对应源实体和修复/复测动作，保留失败版本。调优使用新逻辑键、新 Run/制品，以相同任务、数据、协议和统计口径比较，不覆盖原记录或用单个漂亮指标宣称可上板。
