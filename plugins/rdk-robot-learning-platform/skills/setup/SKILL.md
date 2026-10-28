---
name: setup
description: 连接和诊断 RDK Robot Learning Platform 的 Codex 插件与 Duck Lab MCP；用于安装、启动、认证、检查平台就绪和首次体验。
---

# 连接学习平台

交付可验证的平台连接：仓库与依赖可用、MCP 工具可发现、目标服务及账号状态明确。先读包内 [连接契约](../../references/connection-contract.md)。需要完整参数时查 [工具目录](../../references/tool-catalog.md)。

RDK Studio / WorkBuddy 的配置导出和接入步骤先读 [客户端接入](../../references/client-setup.md)，实际主路径与逐项验收见 [用户工作流](../../references/user-journeys.md)。先完成这个客户端的实际导入与业务探针，不把 Codex 上的目录可见性或配置文件已生成当作另一个客户端已用通。MCP 执行主机必须能读取目标仓库和受支持 Node；另一台电脑不会自动拥有本机绑定。客户端是否自动读取 skills 也要单独检查，只有 MCP 的客户端依赖 server instructions 和工具 schema。

- 本地仓库使用 `RDK_ROBOT_LEARNING_PLATFORM_ROOT`，目标服务使用 `RDK_SIM2REAL_MCP_BASE_URL`。或先在目标仓库用受支持 Node 运行 `npm run setup:plugin`，将 root/Node 绑定保存到包外本地配置，之后新聊天可跨目录使用。插件加载器是包内 `scripts/start-mcp.mjs`；`--check` 只检查仓库/依赖，不启动平台。
- 连接已有服务时调用 `rdk_platform_status`，检查 `ok`、`health.ready`、`health.degraded` 和 `session`；再调用 `rdk_workspace_overview`。工具出现不等于平台就绪，HTTP 200 不等于真实硬件可用。
- 首次本地体验在仓库根执行 `npm ci`、`npm run setup`、`npm start`。这是隔离 Mock 演练；CPU 真训练入口为 `npm run demo:starter`。新开第二个服务实例必须指定独立 `RDK_SIM2REAL_STORAGE_DIR`，浏览器 sweep 每次重建账本。
- 首次业务流程调用 `rdk_golden_path`，按它的 `nextAction` 与 `refs` 继续；不根据某个 Run 自行猜整条主线完成情况。

鉴权失败按部署方式配置 Cookie 或登录中继环境变量，不把账号密码放进工具参数、共享文档或日志。连接失败返回具体检查结果和待修复项；没有运行记录是空工作区，不是连接故障。用户取消后停止新建服务/任务，保留已经创建的进程与 Run 的实际状态并报告。

遇到 `fetch failed` 或连接拒绝时说明“MCP 已加载，但目标平台尚未连通”，先核对脱敏地址/挂载前缀、目标服务是否运行、health/readiness，再给启动或连接修复动作。`--check` 不会启动平台；不要反复列工具或提交训练来测试连通。浏览器登录态不会自动传给 stdio 子进程。

现场安装和部署参考 `$RDK_ROBOT_LEARNING_PLATFORM_ROOT/docs/first-run.md`、`docs/duck-lab-mcp.md`；其他 CLI 入口见 [仓库能力](../../references/cli-capabilities.md)。

需要准备演示、首次仿真体验或恢复场景时，使用 [场景准备与恢复](../experience-preparation/SKILL.md)，可按配置组合步骤，保留自由探索。
