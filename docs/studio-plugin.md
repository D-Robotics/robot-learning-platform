# 在 RDK Studio 安装学习平台插件

学习平台提供可从目录导入的 **Studio 原生插件连接器**。它把现有 Duck Lab stdio
MCP 注册到 Studio，使用同一套平台 API 和账号权限，不复制训练状态机，也不要求
浏览器承担 GPU 任务中继。

## 已核对的安装机制

Studio 的 `server/plugins/plugin-manifest.ts` 优先识别
`.rdstudio-plugin/plugin.json`，再识别 `.codex-plugin/plugin.json` 和根目录
`plugin.json`。manifest 的 `mcpServers` 指向插件内的 `.mcp.json`。本地插件中心
通过 `POST /api/plugins/import` 复制目录、登记安装记录，MCP resolver 在插件启用后
读取声明。Web Cloud 的用户插件目录安装当前明确拒绝；本文的导入步骤适用于桌面和
本地 Studio。

Studio 还必须在 `loadStudioMcpTools()` 中消费启用的插件配置，使用现有 MCP loader、
默认审批边界和连接关闭机制。旧版宿主仅有目录 scanner/resolver，尚未接入这个运行时
消费入口：目录安装成功与 `tools/list` 成功都不能证明 Agent 能调用插件。下面的
`--studio-root` 门禁会通过真实 loader 调用 Tool，缺少接线时直接失败。

当前 scanner 不将相对 MCP 启动参数改写为插件目录，也不替换 `PLUGIN_ROOT`。
因此仓库中的 `plugins/rdk-robot-learning-platform/` 是模板，**先导出再导入**。
导出配置使用稳定学习平台安装位置的绝对 launcher 路径，launcher 自行设置工作目录；
Studio 复制安装后，即使导出目录被删除，MCP 仍能启动。

## 导出与导入

先在要长期保留的学习平台安装目录运行 `npm ci`，并按 README 启动平台服务。
运行时要求以 `package.json` 的 Node engines 为准；没有开发依赖时先运行
`npm run build`，launcher 可以使用编译后的 MCP 入口。

```bash
node scripts/export-studio-plugin.mjs \
  --output dist/studio-plugin/rdk-robot-learning-platform \
  --platform-url http://127.0.0.1:18102
```

脚本返回 `pluginDirectory`。在 Studio 插件中心选择“从目录导入插件”，填入该目录，
导入后检查插件已启用。插件名为 `rdk-robot-learning-platform`，MCP server 名为
`rdk-learning-platform`，不会占用 Studio 保留的 `rdk` 或 `rdk-docs` 名称。

导出目录已存在时脚本会拒绝覆盖。需要重新配置平台地址或运行时位置时，使用新的输出
目录，再通过 Studio 的覆盖安装操作更新。可选 `--runtime-root` 指定另一个已经安装
依赖的学习平台目录，`--node` 指定现有 Node 可执行文件的绝对路径。

这个包不包含学习平台运行时、依赖、仿真资源或 GPU Worker。安装后需保留所引用的
学习平台目录；不要引用会被归档的临时工作树。平台 URL 只允许 HTTP(S)，禁止在 URL
中携带账号密码、查询参数或片段。

## 平台认证

导出文件不包含账号凭据。Studio 使用的 stdio MCP SDK 可能过滤宿主自定义环境变量，
因此不能假设宿主的会话 Cookie 自动传给插件。需要认证时，在插件包之外创建当前用户
拥有的 JSON 凭据文件，文件权限必须为 `0600`。字段只接受
`RDK_SIM2REAL_MCP_COOKIE`，或同时配置 `RDK_SIM2REAL_MCP_USERNAME` 与
`RDK_SIM2REAL_MCP_PASSWORD`；值由用户自己的登录会话提供。

```bash
node scripts/export-studio-plugin.mjs \
  --output dist/studio-plugin/rdk-robot-learning-platform-auth \
  --platform-url http://127.0.0.1:18102 \
  --credentials-file <私有JSON凭据文件>
```

包内只记录凭据文件路径，文件本身不会被复制。launcher 在实际启动时读取并验证
文件权限，再把认证值交给 Duck Lab MCP；拒绝符号链接、其他用户所有的文件、过大
文件与未知字段。不要把凭据文件、Cookie 或密码放进分发包、共享文档或提交。使用
`rdk_platform_status` 核对实际平台身份。

此凭据绑定一个账号，适用于用户独占的桌面 / 本地 Studio。**云端多用户进程不得
共享这份静态 Cookie 或凭据文件**。通用插件不会自动获得当前 Studio SSO 会话，也
不执行隐式授权；Web Cloud 通用插件加载继续遵守宿主能力门禁。

完成连接后，先精确加载 `rdk-platform-setup`，再调用 `rdk_platform_status`、
`rdk_workspace_overview` 核对账号和服务。导出包带有 10 个带前缀的技能和参考资料。
宿主还需在 Agent 默认技能注册表中发现启用插件；插件中心显示技能并不证明
`load_skill` 可加载它们。旧版桌面客户端需要兼容设置或升级宿主。

Workshop 的真实学习入口是浏览器示教 → 不可变数据快照 → `offline-bc` Worker →
ONNX → 独立闭环评测。通过 `rdk_training_submit` 指定 `demonstrationRunId`、
`engine=offline-bc` 和真实 CPU 执行资源，随后查询实际 Run、数据消费摘要和制品。
训练完成、低验证损失或成功下载 ONNX 均不能替代站立、前进、转向的独立闭环指标。
参考 [示教训练](demonstration-training.md) 和 [Workshop 验收](testing/workshop-2026-10-15.md)。

只有开发板时运行同字节 ONNX 的零致动数值比对。实体站立和行走需要本体、真实关节
映射与 HOME 标定、机械限位及急停验证；模板 profile 保持不可启动。

## 验证范围

```bash
# 导出保护、任意工作目录冷启动、真实 MCP tools/list
node scripts/verify-studio-plugin.mjs

# 实际 import → Studio Agent loader → 私有凭据 → 已认证的平台 Tool 调用
node scripts/verify-studio-plugin.mjs --studio-root <Studio源码目录>
```

原生导入验证使用临时配置和数据目录，不修改 Studio 源码或用户已安装的插件。
它通过真实 `loadStudioMcpTools()` 获取并执行 Tool，调用学习平台的真实项目路由，
验证私有 Cookie 文件经过 stdio SDK 后仍可认证，并且只返回对应账号的项目；同时
验证默认审批边界、连接关闭和关闭通用 MCP 时不暴露插件工具；另外通过真实 MossApp 默认注册表发现 10 个技能，并用 load_skill 加载 setup 与 training-runs，禁用后不再可见。这些认证值属于测试
fixture，不使用用户真实登录凭据。
不提供 `--studio-root` 时，只验证连接器导出与 MCP 冷启动，不声称已验证 Studio 安装。
