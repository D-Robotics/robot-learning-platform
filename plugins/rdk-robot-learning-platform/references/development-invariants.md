# 平台开发不变量

所有外部源码入口都位于 `RDK_ROBOT_LEARNING_PLATFORM_ROOT`，不要依赖个人技能或另一项目工作目录。

| 变更 | Owner 与验证 |
| --- | --- |
| 原生工作台 UI | `services/sim2real-web/public/{index.html,app.js,app.css,tokens.css}`；`npm run verify:ui` + 真实浏览器主路径。 |
| HTTP/台账 | `server/routes/sim2real-routes.ts`、`server/sim2real/`；对应 vitest 行为反例 + `verify:api-contract`。 |
| Agent/MCP | `server/agent-runtime/dsh-capability-tools.ts`、`dsh-capability-handlers.ts`、`services/duck-lab-mcp/server.ts`；新增 hint/边界和目录测试，`verify:mcp`。 |
| 引擎/任务 | `engines/<engine>/`、`tasks/`、`adapters/`；对应 `verify:<engine>` 与 task-pack、provenance/lock 门禁。 |
| BoardAgent | `services/sim2real-web/local-board-agent.mjs` 和实际板端 runtime；相应 board-agent/policy/arm/telemetry 测试。 |
| 文档/ADR | `docs/`；导航不存易漂移状态，源码/门禁输出决定事实。 |

UI 棘轮预算只收紧：hex/font-size 字面量、断点、跨层 selector、11 层、z-index 阶梯。新 token 在 `tokens.css` light/dark 双区定义，先 rg 排查历史“已引用但未定义”。IA 改动同提交更新 `ui-ia.spec.mjs`，不靠加例外绕过。

同仓库常有并发修改：保留他人 WIP，同文件交错按必要范围编辑与分块缓存；提交前核对 staged 内容。第二个服务实例独立 storage，浏览器训练旅程每次新账本，不能让演练污染已有台账。

工具扩展五件套：names + handler + 可注入外依赖 + briefing 纪律 + 正例/缺参/上游失败/攻击负例。固定外呼域名/白名单、超时、有界响应，外部 URL 不变任意抓取原语；业务动作仍经平台认证与审批。插件同源工具快照更新后用实际 tools/list 验证一致。

新 adapter/task 用声明式配置，维度、历史顺序、输入命名、奖励符号/改善方向、终止、seed 和质量门对齐。未知 engine/布局/provider 必须响亮失败；执行器未注册不可用替代引擎伪装。ONNX 导出需要 parity，产物摘要、依赖来源和测量阶段保留。

领域事件使用 `registerSim2RealPlugin`（`server/sim2real/sim2real-events.ts`）：id 白名单与配额由核心执行，重复 id 替换，disposer 清理；事件按每个插件串行、失败隔离。event.id 幂等消费，最佳努力内存投递不是持久 outbox；event.owner 是授权隔离边界，public data 不带秘密/请求指纹。

扩展文档真源：`docs/agent-tool-templates.md`、`docs/sim2real-plugins.md`、`docs/task-pack-training.md`、`docs/hardware-adapters.md`、`docs/decisions/README.md`。

## 维护与分发平台插件

只从本平台源码封装能力。复用 `services/duck-lab-mcp/` 的业务适配，不收录个人技能、其他项目运维或另一份台账实现；UI/HTTP/CLI 能力注明实际入口，不虚构未存在的 MCP 工具。

修改 capability/handler/hint 后运行 `npm run update:plugin-catalog`，保持 descriptor 的 schema 与 annotations 同源；修改 `scripts/start-mcp.mjs` 后运行 `npm run update:plugin-entry`。两个 MCP 配置直接执行同源启动代码，避免把未经宿主验证的路径变量替换当成可运行前提。

在受支持 Node 下执行 `npm run verify:mcp`、`npm run build`、`npm run verify:plugin`，验证安装副本、其他工作目录、源码/纯编译模式及配置失败状态。再执行 `npm run package:plugin`，检查 ZIP 完整性和 npm 包的插件资源覆盖；安装时只选 `rdk-robot-learning-platform@rdk-learning-platform`，不把源码目录存在或插件启用当成真实服务/设备验收。

本机仓库与 Node 绑定用 `npm run setup:plugin` 保存到包外，凭据从进程环境继承。发布前保留退出码、工具目录和测试范围，明确没有执行的真实训练、付费资源、设备运动及生产部署；分发前不把这些未测项写成已通过。
