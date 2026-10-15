# RDK Studio 接入与首次检查

先准备本机学习平台 package、符合 `package.json#engines` 的 Node 和依赖。客户端只连接平台，不携带训练算力、设备或账号。已有服务和其他插件配置保持原样。

## 当前原生连接器

在平台仓库根运行：

```bash
npm ci
npm run export:studio-plugin -- --output dist/studio-plugin/rdk-robot-learning-platform
```

输出目录必须不存在。可用 `--platform-url` 指定已运行的服务；地址不得含凭据或查询参数。导出包引用稳定平台安装目录中的绝对 launcher，搬到其他机器后重新导出，不能引用即将删除的临时工作树。

在 Studio 插件中心从目录导入并启用。包内包含 MCP 声明、10 个技能及参考资料。技能名称带 `rdk-platform-` 前缀，例如 `rdk-platform-setup`、`rdk-platform-training-runs`；已有 `rdk-platform-docs` 保持原名。使用精确名称，避免通用 `setup` 命中其他插件。

宿主需要同时完成两处接线：Agent MCP loader 消费启用插件的声明；默认技能注册表发现启用插件的技能目录。目录导入成功、插件中心显示能力或独立 `tools/list` 成功均不能代替这两项。平台仓库的以下门禁通过真实 importer、默认 Agent loader 和认证 Tool 调用验证接入：

```bash
npm run verify:studio-plugin -- --studio-root <Studio源码目录>
```

门禁使用独立临时 profile、ledger 和认证 fixture，不修改用户的插件、凭据或设置。不提供 `--studio-root` 时，只证明连接器导出与 MCP 冷启动。

多用户平台需要认证时，在插件目录之外准备当前用户持有的 `0600` 私有 JSON 文件，并给导出器传 `--credentials-file`。仅接受 `RDK_SIM2REAL_MCP_COOKIE` 或成对的 `RDK_SIM2REAL_MCP_USERNAME`、`RDK_SIM2REAL_MCP_PASSWORD`。包内只记录文件路径，不复制凭据。静态凭据适用于用户独占的桌面或本地 Studio，不能在云端多用户进程共享；云端通用插件仍服从宿主能力门禁。

## 旧桌面客户端

本轮安装的 Studio 1.4.4 不包含上述宿主修复。该版本可以通过设置中的自定义 MCP 和本地技能导入入口兼容接入；需要分别验证真实工具调用和 `load_skill`，不能把新版源码门禁算作旧客户端已升级。保留现有连接器，只合并平台条目，训练与设备动作保留宿主默认审批边界。

只有技能工坊、没有插件中心的旧版本，以其实际管理入口为准。Web Cloud 无法从用户电脑复制本地 stdio 包；需要部署方提供对应服务器资源。

## 首次检查

新建对话后直接说：“精确加载 rdk-platform-setup 学习平台技能；调用 rdk_platform_status 和 rdk_workspace_overview，报告实际平台、账号、ready 与阻断项；然后用 rdk_golden_path 说明下一步。”

只有工具实际返回当前服务结果，才算连接成功。模型网关报错且没有执行工具时，报告模型通道阻断，不能归因为平台业务成功或失败。

再按 [训练与部署契约](workflow-contracts.md) 执行仿真 → 示教 → 真实 BC 训练 → 独立评测 → 板端纯推理。真实数据必须用 `demonstrationRunId` 绑定快照，核对哈希与 worker 消费回执。低训练损失不能证明策略可站立或行走。

只有开发板时止于同字节 ONNX 的零致动计算；本体、关节标定及现场急停未就绪时保持实体动作关闭。连接失败核对当前运行机器、服务和 Node；401 按 [连接契约](connection-contract.md) 处理，不为接入关闭认证或运动门禁。取消 MCP 请求不会自动停止已登记 Run。

## 便携包

Codex 等支持便携 manifest 的宿主使用包内 `.codex-plugin/plugin.json`、`.mcp.json` 和 `scripts/start-mcp.mjs`，按 [连接契约](connection-contract.md) 绑定平台根目录。其他客户端需使用其实际 MCP 与技能导入能力逐项验证，不能把协议通过称作客户端 UI 已验收。
