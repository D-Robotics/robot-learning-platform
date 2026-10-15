# 没有专用 MCP 工具的版本化 API 工作流

以下是已有平台能力的入口导航，不增加新的 `rdk_*` 工具。调用前从 `RDK_ROBOT_LEARNING_PLATFORM_ROOT/docs/api/openapi.yaml`、对应 `server/routes/` 和测试读取当前 request schema、响应、权限、配额及状态机；本文不复制业务裁决。所有相对端点以 `/api/v1/duck` 为前缀，目标 base 为 `RDK_SIM2REAL_MCP_BASE_URL`。

优先使用工作台实际控件或已有认证上下文的 HTTP 客户端。认证取实际部署 Cookie/短期 token/可信上下文，不猜 Authorization 支持，不把凭据放 URL 或输出。MCP 进程的认证不是任意 shell 工具自动拥有的会话。必要输入/权限缺失时只完成准备与可读检查，不关闭鉴权。

写路由遵守契约的 `Idempotency-Key`：同一逻辑操作不明结果重试复用；没有幂等保证的动作先查询状态。400/401/403/409/422/429 分别按服务返回解释，保留已创建实体，不强行覆盖/自动重试物理动作。请求取消不撤销已写记录。

## 数据、项目和模型

| 目标 | 当前入口（前缀 `/api/v1/duck`） | 结果与限制 |
| --- | --- | --- |
| 项目详情/修改 | `GET/PATCH /projects/{id}` | 修改本账号项目及合法关联，保留 lineage。 |
| 项目 Run 对比 | `GET /projects/{id}/runs/compare` | 从参数契约选真实 Run 和指标，跨协议不混比。 |
| 模型详情 | `GET /models/{modelId}` | 元数据/契约，不执行模型脚本。 |
| 单数据集详情 | `GET /datasets/{id}` | 读取不可变快照元数据。 |
| dataset ready/撤销 | `PATCH /datasets/{id}`、`POST /datasets/{id}/revoke` | 按 registered/ready/revoked 状态机；撤销保留来源，不删除内容证据。 |
| 任务失败案例 | `GET /task-packs/{taskId}/failure-cases` | 读取现有任务失败归档，保留失败原因。 |

原始 JSONL/LeRobot 内容准备和哈希通过 [CLI](cli-capabilities.md)；平台登记对象引用与版本。不存在专用 dataset upload MCP 工具。

## 资源与运行

| 目标 | 当前入口 | 结果与限制 |
| --- | --- | --- |
| 执行资源登记/改/删 | `POST /compute-resources`、`PATCH/DELETE /compute-resources/{id}` | 使用当前 runner URL/安全字段，不泄漏私钥；测试由 MCP resource_test 或 POST test。 |
| 检查点续训 | `POST /runs` 的 `resumeFrom` | 按当前 RunRequest 使用真实 checkpointId/artifactRef/可选 iteration，并核对后端与执行器确实支持；稳定 key 创建新的续训 Run。MCP training_submit handler 当前未转发 resumeFrom，不能仅加额外参数伪装续训。 |
| 运行详情/下载策略 | `GET /runs/{runId}`、`GET /runs/{runId}/policy.onnx` | 真实策略字节/摘要，失败和 Mock 不假装有文件。 |
| 关联外部已存在 Run | `POST /runs/{runId}/reconcile` | 契约要求已确认 externalRunId 与 confirm，不重新发起训练。 |
| 受控 worker relay | `POST /runs/{runId}/relay/claim`、`POST /runs/{runId}/relay/sync`、`POST /runs/{runId}/relay/artifact` | 读取实际租约/能力/认证协议；上传结果必须绑定原 Run，不能伪造 completed。 |
| 运行关联分析 | `GET /runs-correlation` | 读取已有指标，明确样本与统计适用范围。 |

普通训练提交与 status/log/replay 使用本插件现有 MCP。训练取消/暂停/续训不能凭本文发明路由，先查实际工作台与当前契约。

## 评测、遥测与反馈

| 目标 | 当前入口 | 结果与限制 |
| --- | --- | --- |
| Run 遥测写入 | `POST /runs/{runId}/telemetry` | 按真实 chunk/sequence/source/契约和 attestation 校验；每片稳定 key，保留来源。 |
| 遥测按 Run 读取 | `GET /runs/{runId}/telemetry` 或 `rdk_telemetry_list` | owner 隔离、有界检索，不视被截断结果为全量。全局 `/telemetry` 是 POST 写入口，不提供 GET 列表。 |
| 导入评测证据 | `POST /evaluations` | 基于真实 report/Run/artifact，稳定 key，metadata 声明不替代质量门证据。 |
| 单条评测/追加结果 | `GET/PATCH /evaluations/{id}` | 只合法状态转换与真实证据追加，stale/invalid 不改成无依据 passed。 |
| 产品反馈 | `POST /feedback`、`GET /feedback/summary` | 用户准确性反馈，未授权不代用户投票；不参与制品闸门。 |
| 运营通知 | `GET /notices` | 展示真实公告，不发明服务状态。 |

若导入文件为空/无效/来源不明，说明现状并保留原文件；取消时停止后续上传，查询已经接受的分片。

## 制品与发布

| 目标 | 当前入口 | 结果与限制 |
| --- | --- | --- |
| 制品登记 | `POST /artifacts` | 不可变版本、摘要、Run/data/contract lineage，稳定 key。 |
| 单制品详情/晋级 | `GET/PATCH /artifacts/{id}` | 状态机与证据由平台裁决，通常可直接用 MCP artifact_promote。 |
| 显式验证/发布/撤销 | `POST /artifacts/{id}/validate`、`POST /artifacts/{id}/publish`、`POST /artifacts/{id}/revoke` | validated → published，撤销保留审计。 |
| Canary/Live 计划 | `POST /deployments` | mode、Run、制品、评测、设备证据与稳定 key；不直接运动。 |
| 人工审批 | `POST /deployments/{deploymentId}/approval` | owner/admin 决定；pending → ready 是治理，不是执行成功。 |

实际执行、时间盒、现场确认及回滚由现有受控 BoardAgent adapter 完成；没有适配器就报告待部署，不能用 SSH 直接起策略替代门禁。预检/状态/历史/版本计划/取消已有 MCP 原语。

## 设备、桥接、仿真混合与运动配置

| 目标 | 当前入口 | 结果与限制 |
| --- | --- | --- |
| 保存/删除设备连接 | `POST /device-connections`、`DELETE /device-connections/{connectionId}` | 只登记 SSH 坐标，不存密码；删除会拆隧道。 |
| 板端配置 | `GET/POST /device-connections/{connectionId}/config` | 只允许文档中的 drive/policy 开关；写入会重启 agent，运动窗口中拒绝。 |
| 平台运动开关 | `GET/PUT /board-station/switches` | 开启需真实操作者确认和 confirm=true；安全关闭恒可用，不为完成其他请求自行开启。 |
| Local Bridge 状态/配对/连接 | `GET /local-bridge/status`、`POST /local-bridge/pairing-code`、`POST /local-bridge/devices/{bridgeDeviceId}/connect` | 短期受控配对身份，不绕 SSH/平台安全边界。 |
| 相机/遥测流/设备 | `GET /board-station/camera.mjpeg`、`GET /board-station/status/stream`、`GET /board-station/devices` | 真相机不可用时保留失败，流取消及时释放连接。 |
| 批量纯推理 | `POST /board-station/policy-infer` | 1–64 observations，仅加载模型推理，不运动；有限值/维度/输出由 runtime fail-closed。 |
| 受限底盘运动 | `GET/POST /board-station/drive`、`POST /board-station/drive/stop` | 当前契约的安全钳制、双开关、时间盒、现场授权；非 stop 物理失败不自动重试。 |

policy/arm 现有 MCP 能力优先用对应工具。未经用户要求不把只读推理演练升级成运动，也不把截图/零向量纯推理称作实体运动闭环。

## 审计和可观测

`GET /audit`、`GET /audit/health`、`GET /research-loop/summary`、`GET /events`、`GET /events/stream` 是版本化平台入口。读取时保持 owner 过滤及内容边界，事件流没有新变更时不合成消息；端口 alive 不能代替 audit/storage ready。

## SDK 适用范围

仓库 Python SDK 的目前接口和认证限制见 [CLI/SDK](cli-capabilities.md)。它不是所有 API 的完整专用包装，通用 request 也未开放自定义 Idempotency-Key/Cookie；需要受控写入时用真正支持这些头的客户端或当前 MCP。本文导航保持业务真源在平台，外部 Agent 只准备请求和解释返回。
