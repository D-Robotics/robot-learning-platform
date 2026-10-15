---
name: platform-development
description: 扩展 RDK 学习平台的 Agent/MCP 工具、训练引擎、机器人适配器、任务奖励、领域事件和原生 JS 工作台，并运行对应仓库门禁。
---

# 扩展平台

交付属于该平台的可审查实现和相关验证证据。读 [开发不变量](../../references/development-invariants.md)；脚手架、引擎和事件入口见 [仓库能力](../../references/cli-capabilities.md)。

在 `RDK_ROBOT_LEARNING_PLATFORM_ROOT` 先读 `AGENTS.md`、当前 `git status`、相邻实现和对应 ADR。用户结果、失败/空/取消行为先明确；不清理或混入其他会话 WIP。源码、测试和门禁决定当前事实。

- 新 Agent 工具同步 names、handler、可注入外部依赖、briefing 纪律和正例/缺参/失败/攻击负例；MCP `TOOL_PARAM_HINTS`、目录与测试同步，导出的插件目录同步更新。版本化 API 承担业务裁决，不在插件复制台账状态机。
- 新引擎必须明确真实训练命令、输入/输出协议、来源和依赖锁、质量门/ONNX 等价证明，未知引擎响亮失败。同一任务契约不能因换引擎静默变观测槽位或奖励含义。
- 机型/任务优先 adapter + task-pack 声明，不在 UI 硬编码；创建 adapter 前查看 `npm run create:adapter -- --help`。新增观测或状态图按真实 runtime 能力验收，不对未实现的循环状态上板给成功承诺。
- 事件扩展用 `registerSim2RealPlugin`、以 `event.id` 幂等消费，失败隔离；当前总线单进程最佳努力，外部可靠投递需另实现 adapter。事件信封可带 owner；公共 `data` 不带 owner/幂等键/请求指纹，跨用户投影必须按 owner 隔离，不外传凭据或完整遥测样本。
- UI 仍是原生 JS；颜色/字号/断点来自 `tokens.css`，IA 改动同提交更新断言。改前/后运行 `npm run verify:ui`，真实浏览器走主路径；不放宽棘轮预算。

按 owner 先跑最窄门禁，bug 修复先构造修复前失败的反例。发布级变更运行需要的完整门禁；报告已跑、未跑、SKIP 和风险。不以命令启动过证明完成，不替用户扩大到外部发布。

本技能用于平台源码能力，不管理无关个人技能库、其他项目运维或 Codex 全局配置。
