# RDK Robot Learning Platform 插件

这个平台插件封装本仓库 `rdk-robot-learning-platform-public`：项目与数据、浏览器仿真、训练、评测、制品与部署、RDK 设备、平台运维及扩展开发。工作流技能复用 Duck Lab MCP 原子工具；实际工具数量以当前安装版本的工具目录为准。工作台、版本化 HTTP 和仓库 CLI 中没有专用 MCP 工具的能力也有真实操作入口。

平台版本化 API 执行业务校验、认证、幂等、配额、审批和运动门禁。

## RDK Studio

在平台仓库运行 `npm run export:studio-plugin -- --output <新目录>`，生成 Studio 原生接入包。按 [客户端指南](references/client-setup.md) 导入；先验证健康和工作区，再选真实学习流程。导出包绑定本机路径，换机器重新导出。

## 连接

插件的 `.codex-plugin/plugin.json`、`.mcp.json` 定义安装内容和 MCP。加载器为 `scripts/start-mcp.mjs`，依赖目标仓库的 Node 环境和代码：

```bash
export RDK_ROBOT_LEARNING_PLATFORM_ROOT='/absolute/path/to/rdk-robot-learning-platform-public'
export RDK_SIM2REAL_MCP_BASE_URL='http://127.0.0.1:18102'
node scripts/start-mcp.mjs --check
```

命令在插件目录执行。也可以先在目标仓库用符合 `package.json` engines 的 Node 运行 `npm run setup:plugin`，将仓库和 Node 绑定保存到包外 `~/.config/rdk-robot-learning-platform/plugin.json`，随后新聊天可跨目录使用；它只保存 root/node，不保存凭据，不修改全局 Node。root 解析顺序为显式环境变量 → 包/当前目录的仓库祖先 → 本地绑定。

`RDK_ROBOT_LEARNING_PLATFORM_NODE` 可显式选择执行 MCP 的 Node；否则使用绑定的 Node，再回退当前 Node。`RDK_ROBOT_LEARNING_PLATFORM_CONFIG` 可选择其他本地绑定文件。这两个变量属于插件加载器，不是平台 API 配置。`--check` 不启动平台或连接设备。默认 source 模式使用当前仓库 TypeScript 入口；需要已构建版本时设 `RDK_ROBOT_LEARNING_PLATFORM_MCP_MODE=built` 并先构建对应源码。

目标平台已运行时，调用 `rdk_platform_status` 和 `rdk_workspace_overview` 验证服务/账号；首次本地体验在仓库根执行 `npm ci`、`npm run setup`、`npm start`，默认是隔离 Mock 演练。CPU 真训练用 `npm run demo:starter`，真实设备/GPU 由部署方提供。Cookie 或登录中继只放进进程环境，见 [连接契约](references/connection-contract.md)。

## 工作流

| 技能 | 结果 |
| --- | --- |
| [setup](skills/setup/SKILL.md) | 插件、仓库、平台、认证和首次主线检查 |
| [experience-preparation](skills/experience-preparation/SKILL.md) | 场景准备、恢复、训练前检查和全流程证据表 |
| [workspace-data](skills/workspace-data/SKILL.md) | 项目、模型 manifest、数据版本与 lineage |
| [simulation-replay](skills/simulation-replay/SKILL.md) | 仿真、轨迹录制、遥测/会话与回放视频 |
| [training-runs](skills/training-runs/SKILL.md) | 任务/引擎/算力选择、单次提交、Run 与日志 |
| [evaluation-feedback](skills/evaluation-feedback/SKILL.md) | 评测比较、来源、质量门、反馈与失败回流 |
| [artifacts-deployments](skills/artifacts-deployments/SKILL.md) | 制品晋级/签发、预检、审批与受控发布路径 |
| [devices-board](skills/devices-board/SKILL.md) | 设备连接、BoardAgent、策略与 D6A 机械臂 |
| [platform-operations](skills/platform-operations/SKILL.md) | 只读预检、健康、生产配置、备份与恢复 |
| [platform-development](skills/platform-development/SKILL.md) | Agent/MCP、引擎、机型、任务/奖励、事件、UI 扩展 |
| [rdk-platform-docs](skills/rdk-platform-docs/SKILL.md) | 当前平台实现与官方 RDK 知识核对 |

[客户端接入](references/client-setup.md) · [新用户工作流与验收用例](references/user-journeys.md) · [MCP 工具目录](references/tool-catalog.md) · [版本化 API 工作流](references/api-workflows.md) · [CLI/SDK/工作台能力](references/cli-capabilities.md)

可直接说：“连接学习平台并检查主线”、“用我的轨迹训练 ACT”、“比较这两次 Run 为什么不能发布”、“做演示前只读预检”、“打开仿真并录制轨迹”、“检查板端 ONNX 的加载与延迟证据”。

## 验收口径

工具存在、命令启动或 HTTP 200 均不是业务完成。Run 完成、评测合格、制品已发布、部署预检、审批 ready、板端加载、实体运动是不同结果。Mock、synthetic-smoke、dry-run、stale、SKIP 和来源未核对需明确报告。

BC 可通过 `demonstrationRunId` 使用浏览器真实示教快照；核对 `dataUsage`、worker 消费摘要和独立闭环结果。无示教的内置 BC 冒烟以及 ACT/DP 包装仍不能证明消费了用户数据。循环训练虽有 UI 选项，当前 API 提交 allowlist 未包含 microduck-recurrent。SmolVLA 真微调需要部署方 GPU/LeRobot/权重/数据；dry-run 写计划结果但不产模型。纯推理、回放和官方资料查询不隐含真实运动验收。

本插件通过包内技能和参考把入口连起来，不伪造尚未实现的工具。凭据、用户设备坐标、个人路径不内置。真实运动和失败后重试遵守平台既有安全开关、审批和现场授权；取消请求不保证已提交 Run 或实体动作撤销。

## 可配置的场景体验

[场景准备与恢复](skills/experience-preparation/SKILL.md) 可复用到日常演示、首次体验和课程。配置绑定参考策略或指定 Run，不默认提交训练。自检脚本通过原 MCP 查询状态，页面加载、运行和恢复由宿主浏览器实际确认。准备成功不等于仿真已经运动。

可选的 MCP 场景扩展入口为 `scripts/experience-mcp.mjs`，以上游同目录的 `start-mcp.mjs` 保留现有工具、身份与拒绝结果，额外提供场景指南、场景准备、训练前准备和流程检查四个工具。部署前备份当前连接，将该连接的启动入口指向扩展脚本，保留原环境配置；不同时新增第二个数据源。直接返回指南用于兼容宿主技能加载不精确的情况。此入口要求标准上游启动脚本已经可以独立工作；不会为缺少本机接口的宿主补造权限。
