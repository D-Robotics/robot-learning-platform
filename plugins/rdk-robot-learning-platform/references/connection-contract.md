# 连接与调用契约

此插件只封装 `rdk-robot-learning-platform-public`。MCP 执行器复用仓库 `services/duck-lab-mcp/server.ts`，通过平台版本化 `/api/v1/duck/*` 路由执行，平台是业务真源。插件不带独立台账、训练器、设备驱动或秘密。

## 环境与加载

| 变量 | 用途 |
| --- | --- |
| `RDK_ROBOT_LEARNING_PLATFORM_ROOT` | 目标仓库绝对路径；未设置时从包/cwd 仓库祖先识别，再使用本地绑定。 |
| `RDK_ROBOT_LEARNING_PLATFORM_NODE` | 加载器使用的受支持 Node 可执行文件；优先于本地绑定的 Node，再回退当前 Node。 |
| `RDK_ROBOT_LEARNING_PLATFORM_CONFIG` | 加载器本地绑定文件，默认 `~/.config/rdk-robot-learning-platform/plugin.json`；不是平台 API 配置。 |
| `RDK_ROBOT_LEARNING_PLATFORM_MCP_MODE` | `source`（默认）或 `built`。source 需要仓库 Node 依赖；built 使用构建产物，需先构建匹配当前源码。 |
| `RDK_SIM2REAL_MCP_BASE_URL` | 目标平台完整地址，可带网关挂载前缀；本地默认 `http://127.0.0.1:18102`。 |
| `RDK_SIM2REAL_MCP_API_PREFIX` | 默认 `/api/v1/duck`，通常不修改。 |
| `RDK_SIM2REAL_MCP_COOKIE` | 多用户平台已有会话 Cookie。 |
| `RDK_SIM2REAL_MCP_USERNAME` / `RDK_SIM2REAL_MCP_PASSWORD` | 支持登录中继的部署使用，首次调用换取会话；401 自动重登一次。 |
| `RDK_SIM2REAL_MCP_TIMEOUT_MS` | HTTP 超时，仓库默认 120000。 |

凭据仅从 MCP 启动进程环境读取；不用 `.mcp.json` 示例、仓库文档或工具参数保存明文。不用全机扫描猜用户仓库。Node 版本取目标 `package.json` 的 engines 与 lockfile，依赖用 `npm ci`。默认系统 Node 不满足 engines 时无需改全局 Node：在仓库用受支持 Node 运行 `npm run setup:plugin`，保存包外 root/node 绑定，再在新聊天调用插件。绑定不包含凭据；ROOT/NODE 环境变量仍可显式覆盖。包内/cwd 的明确仓库优先于本地绑定。

包内 `node scripts/start-mcp.mjs --check` 只核对入口和依赖。开始 stdio 服务用 `node scripts/start-mcp.mjs`；平台 Web 服务单独启动。stdio stdout 仅协议，日志走 stderr。连接诊断 `rdk_platform_status` 检查健康与当前会话；`health.ready` 的来源是健康响应，不替代生产 `/readyz` 流量探针。

RDK Studio / WorkBuddy 的导入配置与业务动作分别验收。配置存在、initialize/tools/list 通过只说明 stdio 可用，不说明平台服务在运行，也不说明客户端自动加载本包 skills。跨主机使用时在实际执行 MCP 的主机准备仓库、Node、配置与凭据。具体输入/预期与验收层级见 [用户工作流](user-journeys.md)。

## 业务、安全和重试

- 工具实际参数以运行时 `tools/list` 为准，包内 [工具目录](tool-catalog.md) 是同源快照。`additionalProperties: true` 不表示任意参数会被 handler 透传；未知字段可能被忽略。命中部署工具不代表设备在当前环境已连接。
- API 执行 owner 隔离、幂等、配额、RBAC、审批与运动门禁。被拒绝时原样解释稳定错误码和原因，不通过私有回调、SSH 或改台账绕过。
- `readOnlyHint` 是仓库能力标注，不是 HTTP GET 或无台账变化的保证。`rdk_deployment_preflight` 建立 preflight 计划；`rdk_evaluation_summarize` 经 evaluate 刷新证据。两者不执行电机动作。
- 非只读操作仅在用户任务授权范围内调用。平台/Codex 客户端要求审批时尊重现有流程；技能不新增全局“所有操作都需再次确认”的规则。
- 写入逻辑操作用稳定 `idempotencyKey`：非空、ASCII 字母数字及 `. _ : -`，长度不超过 200。同请求不明结果重试复用；变更语义使用新键。MCP 将其映射为稳定 turn ID，handlers 在创建项目、登记数据/模型、提交训练、制品晋级、创建预检/版本计划等路由派生幂等键；不能据此承诺每一个设备动作都去重。
- 平台 HTTP 幂等头有更短的长度边界；MCP 保留已支持的短派生键，较长逻辑键按完整内容哈希为有界头，不截断尾部或同 turn 的操作序号。用户仍复用原始逻辑键，不需要手动生成 HTTP 头。
- 超时后先查询原实体。物理移动、夹爪、策略启动等不明/失败结果不自动重试；按服务 instructions 先取得用户再次确认。急停失败仍应如实报告设备安全状态未知。
- `isError:true` 是失败；`mock:true`、`SKIP`、`projection.truncated`、无样本、缺指标均须反映在结论。被截断时按 ID/筛选分段读取，不能对不完整目录做全量统计。
- MCP `notifications/cancelled` 终止 in-flight 请求信号，不能撤销已成功提交的 Run 或运动。取消任务用平台实际支持的操作；没有操作时明确剩余任务状态。
- 传输错误只有 `fetch failed` 时，补充用户可执行的诊断：当前 MCP 已加载但平台请求未连通；检查脱敏目标、挂载前缀、服务存活/就绪和实际认证方式。不要泄漏凭据，不通过重复写入探测连接，不以关闭认证解决 401。

## 仓库契约入口

所有下面的路径均相对于 `RDK_ROBOT_LEARNING_PLATFORM_ROOT`：`docs/duck-lab-mcp.md`、`docs/api/README.md`、`docs/api/openapi.yaml`、`services/duck-lab-mcp/platform-client.ts`、`server/agent-runtime/dsh-capability-handlers.ts`。包内引用均在插件边界内；安装后无需读取个人技能目录。
