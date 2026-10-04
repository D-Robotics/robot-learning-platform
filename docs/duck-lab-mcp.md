# duck-lab-mcp — 平台能力对外 MCP 适配层

`services/duck-lab-mcp/` 是一个零新增依赖的 stdio MCP（Model Context Protocol）
服务，让 Claude Code、Qoder 等外部 agent 客户端直接驱动本平台的仿真、训练、
评测、制品、部署与板端运行能力。

## 定位与边界

设计文档对这个组件有既定约束，实现严格遵守：

- `docs/design/sim2real-platform.md`：经 `duck-lab-mcp` 调用版本化 Sim2Real
  API；**API 是业务真源，MCP 只做适配和证据投影**。
- `docs/api/README.md`：外部适配器必须调用版本化 `/api/v1/duck/*` API，不得
  复制 manifest 校验、幂等、配额或部署门禁逻辑。

因此本服务不做任何业务裁决：

- 工具目录与语义 1:1 镜像内嵌 DSH Agent（`server/agent-runtime/dsh-capability-tools.ts`），
  执行器直接复用 `createDshCapabilityHandlers`，仅把回环 fetch 换成指向任意
  平台实例的外部 HTTP 适配（legacy 前缀自动改写为 `/api/v1/duck`）。
- 幂等、配额、RBAC、审批、运动安全开关全部由平台路由执行；MCP 层被拒绝时
  原样转述平台返回的拒绝原因。
- `rdk_docs_*` / `rdk_web_search` 与内嵌 Agent 同源（`rdk-docs-mcp` 库 +
  免费检索通道），D-008 纪律一致：检索失败必须如实告知"官方资料未核对"。

## 启动与配置

```bash
npm run dev:mcp        # stdio 模式，连接默认平台 http://127.0.0.1:18102
```

MCP 客户端自行 spawn 本服务，进程环境即配置：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `RDK_SIM2REAL_MCP_BASE_URL` | `http://127.0.0.1:18102` | 平台实例地址（standalone 或网关入口） |
| `RDK_SIM2REAL_MCP_API_PREFIX` | `/api/v1/duck` | 业务路由前缀，一般不需改动 |
| `RDK_SIM2REAL_MCP_COOKIE` | — | 静态会话 Cookie（多用户部署推荐） |
| `RDK_SIM2REAL_MCP_USERNAME` / `RDK_SIM2REAL_MCP_PASSWORD` | — | 账号密码；首次调用经 `POST /api/sso/login` 换取会话，401 时自动重登一次 |
| `RDK_SIM2REAL_MCP_TIMEOUT_MS` | `120000` | 单次 HTTP 请求超时 |

认证按部署形态选择（见 `docs/api/README.md` 的认证边界）：

- **standalone 单用户**：不配置任何凭据即可（`standalone-anonymous`）。
- **多用户（studio-cookie / user-center）**：优先静态 Cookie；或配置账号密码
  走登录中继。凭据只从环境变量读取，不写入日志、不出现在协议通道。

## 客户端注册

各客户端的 `mcpServers` 声明结构一致，以仓库根目录为工作目录、stdio 方式
启动即可：

```json
{
  "mcpServers": {
    "duck-lab": {
      "command": "node",
      "args": ["--import", "tsx/esm", "<仓库绝对路径>/services/duck-lab-mcp/server.ts"],
      "env": {
        "RDK_SIM2REAL_MCP_BASE_URL": "http://127.0.0.1:18102"
      }
    }
  }
}
```

生产构建后可改用编译产物：`node <仓库>/dist-server/services/duck-lab-mcp/server.js`。

协议兼容：`initialize` 版本协商支持 `2025-06-18` / `2025-03-26` / `2024-11-05`；
`tools/list`、`tools/call`、`ping`；传输为按行分隔的 JSON-RPC 2.0（MCP stdio
约定），stdout 仅承载协议流量，运行日志走 stderr。

## 工具目录（55 + 1）

`tools/list` 返回 55 个 `rdk_*` 业务工具加 1 个连接诊断工具，全部带
`readOnlyHint` 标注（与内嵌 Agent 目录一致），危险生命周期操作额外带
`destructiveHint`：

| 分组 | 工具 | 只读 |
| --- | --- | --- |
| 工作区与台账 | `rdk_workspace_overview` `rdk_workspace_summary` `rdk_projects_list` `rdk_project_create` `rdk_datasets_list` `rdk_dataset_register` `rdk_models_list` `rdk_model_validate` `rdk_model_register` `rdk_runs_list` `rdk_artifacts_list` `rdk_evaluations_list` `rdk_lineage_get` `rdk_compute_resources_list` `rdk_compute_resource_test` | 除 create/register 外 |
| 训练与评测 | `rdk_training_submit` `rdk_training_status` `rdk_run_logs` `rdk_runs_replay` `rdk_telemetry_list` `rdk_board_sessions` `rdk_retraining_advice` `rdk_replay_video` `rdk_simulator_open` `rdk_evaluation_summarize` `rdk_feedback_summary` | 除 submit / replay_video 外 |
| 制品与部署 | `rdk_artifact_promote` `rdk_deployment_preflight` `rdk_deployment_status` `rdk_deployment_history` `rdk_deployment_version_switch` `rdk_deployment_cancel` | preflight/status/history 只读 |
| 设备连接 | `rdk_device_discover` `rdk_device_connect` `rdk_device_disconnect` | discover 只读 |
| 板端状态 | `rdk_board_health` `rdk_board_onboarding_preflight` `rdk_board_station_status` `rdk_board_station_command` `rdk_board_policy_status` `rdk_board_policy_files` | 全部只读 |
| 板端策略执行 | `rdk_board_policy_stage` `rdk_board_policy_load` `rdk_board_policy_start` `rdk_board_policy_reset` `rdk_board_stop` | 全部门控 |
| D6A 机械臂 | `rdk_board_arm_status` `rdk_board_arm_move` `rdk_board_arm_gripper` `rdk_board_arm_stop` | status 只读，其余门控 |
| 官方知识 | `rdk_docs_search` `rdk_docs_manuals` `rdk_docs_toc` `rdk_docs_page` `rdk_web_search` | 全部只读 |
| 连接诊断 | `rdk_platform_status`（健康、就绪、会话身份） | 只读 |

机械臂/策略启动类工具受平台多重安全开关约束
（`RDK_SIM2REAL_STATION_{DRIVE,POLICY,ARM}_ENABLED` + 板端开关），未开启时
平台直接拒绝，MCP 层不会也不应绕过。

## 幂等重试语义

写操作（提交训练、创建项目、登记数据集等）由平台按 `Idempotency-Key` 去重。
MCP 工具参数中的 `idempotencyKey`（字符串，仅限字母、数字与 `. _ : -`，
最长 200）会映射为该次调用的稳定 turn id：对同一逻辑操作重试时复用同一值，
平台返回已创建的实体而不是新建第二条；缺省时每次调用生成新的随机键。
异步任务（训练）提交后用 `rdk_training_status` / `rdk_run_logs` 轮询，
不要重复提交。

## 协议与投影边界

- stdio 传输按行分隔 UTF-8 JSON；单行上限 1 MiB，超限回 PARSE_ERROR 后
  继续服务。请求并发 dispatch（慢工具不阻塞 `ping`），`id: null` 的请求
  仍会应答，batch 数组按 2025-03-26 语义展开应答，`notifications/cancelled`
  会中止对应 in-flight 工具调用。
- `tools/list` 的 inputSchema 携带参数名与类型提示（必填字段、string/
  number/boolean/array），由 `mcp-server.test.ts` 对 handlers 源码做防漂移
  校验；schema 保持 `additionalProperties: true`，平台 API 的其余字段原样
  透传。
- 大响应投影：超过 240 KiB 的对象型响应会把嵌套数组截断到最新条目并标注
  `projection.truncated`；顶层数组会截断；无法无损投影的响应直接报
  "无法无损投影"错误并提示改用 `*_list` 查询工具，不会把超限体传给下游
  256 KiB 有界读取器。

## 验证

```bash
npm run verify:mcp     # 协议层 + HTTP 适配 + 真实平台路由 + 子进程 stdio 端到端
```

套件起真实 standalone 应用于临时端口，走版本化 API 断言：目录完整性
（56 工具与只读/破坏性标注）、前缀改写、训练提交与幂等重放、平台拒绝与
未知工具错误映射、`rdk_platform_status`、以及 spawn 真实 server.ts 的 stdio
协议往返。已纳入 `npm run verify` 与 `verify:ci:agents` 链。
