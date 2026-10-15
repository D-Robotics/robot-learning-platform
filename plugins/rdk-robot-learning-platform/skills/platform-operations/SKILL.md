---
name: platform-operations
description: 对 RDK 学习平台做发布或演示前只读预检、健康与就绪诊断、生产配置检查，以及使用仓库工具执行台账备份、验证和恢复。
---

# 平台预检与运维

交付本次执行的退出码、检查来源和阻断原因。连接约束见 [连接契约](../../references/connection-contract.md)，CLI 入口见 [仓库能力](../../references/cli-capabilities.md)。

先检查 `rdk_platform_status`，再按问题读 `rdk_workspace_overview`、`rdk_compute_resources_list` / `rdk_compute_resource_test`、`rdk_board_health` / `rdk_board_onboarding_preflight` / `rdk_board_station_status` / `rdk_board_policy_status`。只读预检不要求开启运动；关闭开关是安全状态。需要制品上板资格时单独生成部署预检，不能用存活探针代替发布门禁。

在 `$RDK_ROBOT_LEARNING_PLATFORM_ROOT` 运行 `npm run doctor`、`npm run demo:preflight -- --url "$RDK_SIM2REAL_MCP_BASE_URL" --strict`，或 `node scripts/probe-sim2real.mjs --url "$RDK_SIM2REAL_MCP_BASE_URL"`。CLI 不一定复用 MCP 认证，401 需按脚本实际支持配置，不能为跑通而关鉴权。`/healthz` 存活与 `/readyz` 就绪分别判定；degraded / Mock / SKIP 不能记为通过。

备份、恢复、生产部署、服务重启是仓库 CLI 能力，没有专用 MCP 工具。执行前读 `$RDK_ROBOT_LEARNING_PLATFORM_ROOT/docs/production-operations.md` 和脚本实际参数：

- 备份前暂停写者，生成 quiesced 快照并 verify；活跃 writer 默认拒绝。`--allow-live` 只是 best-effort，不能用作发布/评测证据。
- 恢复先验证快照与目标、停止 writer，再执行原子恢复；保留 `*.pre-restore-*`。目标/停机/覆盖必须属于用户请求范围，未授权的恢复不顺带执行。
- 外置 audit 路径在备份与恢复均显式传同一 `--audit-file`；writer lease 是进程状态，不复制回恢复目录。DSH 会话按单独策略备份。
- 生产配置验证基于实际受控 EnvironmentFile 和 unit；凭据外置，不打印。当前 JSON ledger 单写，不能宣称已接入 PostgreSQL 多写生产。

审计、审计健康、领域事件和研究闭环摘要见 [版本化 API 工作流](../../references/api-workflows.md)。空台账、未接设备和未启可选运行时分别报告；用户取消时停止下一步修改，报告已停止服务、快照或已切换目录的真实状态。发布结论只绑定本次输出，不能引用旧记录作为当前验收。
