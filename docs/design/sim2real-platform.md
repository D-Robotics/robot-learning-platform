# 独立 Sim2Real Web 平台

> 方案审查与最终修订建议见 [`rdk-rl-platform-final-review.md`](./rdk-rl-platform-final-review.md)。本文描述当前控制面架构；审查稿明确区分已验证 MVP 与真实 X5/RoboGo 闭环的后续阶段。

## 目标

提供一个独立于 RDK Studio 主壳的浏览器平台，用同一套工作流兼容 MicroDuck 与 RDK Duck 两个产品：
分别校验各自 policy contract，再串起 RoboGo/本地训练导出、仿真、RDK 板端兼容性检查和受控发布。
独立的含义是：页面、监听端口、systemd 服务和 Nginx 入口均不注册到 Studio
React tab；服务只复用已验证的 SSO、设备和模型兼容性适配器。

RDK Studio 是可选的 AI 入口，不是该平台的运行时依赖：部署方可以通过账号隔离的 DSH Skill
编排流程，经 `duck-lab-mcp` 调用版本化 Sim2Real API；API 是业务真源，MCP 只做适配和
证据投影，Skill 不承载模型校验或权限逻辑。这样网页、CLI、RDK Studio 和未来客户端可以
共享同一套接口，同时保持 Studio 与 Sim2Real 的独立发布节奏。注意：本公开仓库目前只提供
API 与适配契约，不包含 `duck-lab-mcp`、`microduck-mcp` 或 DSH Skill 实现；这些名称代表
可选的外部集成，未装配时网页和 CLI 仍可独立运行。

```text
RDK Studio → 外部 Skill / MCP（可选） → Sim2Real API → 台账 / 事件 / 权限
                                                    ├─ Local Agent
                                                    └─ RoboGo Connector
```

执行动作遵循 Studio 的 Plan/Spec/Execute 语义：Plan/Spec 只能读取和生成计划，训练、上传、
Canary、Live 等变更在 Execute 阶段显式审批；local 与 RoboGo 不自动 fallback，凭据只在服务端
受控环境或经过验证的 SSO 网关转发中短时使用。

## 页面模块化信息架构

Sim2Real Web 采用两层导航：

1. **交付工作流**：仿真与录制 → 训练与导出 → 评测与效果 → 预检与上板。它是新用户的顺序引导，也允许从任一步回退重跑。
2. **平台模块**：套件与契约、仿真与数据、训练中心、评测中心、设备与发布、记录与审计。它是熟悉用户的直接入口，每个模块只维护自己的空态、阻断和重试。

产品线、模型、目标设备和账号健康度放在全局上下文条；首页只负责状态判断和跳转，业务表单留在对应模块内。这个结构借鉴了 [LeRobot 的端到端文档主线](https://huggingface.co/docs/lerobot/main/index)、[LeLab 的图形化工作区](https://huggingface.co/docs/lerobot/lelab) 和 [Isaac Lab 的模块化仿真/学习分层](https://docs.nvidia.com/learning/physical-ai/getting-started-with-isaac-lab/latest/train-your-first-robot-with-isaac-lab/02-how-isaac-lab-accelerates-reinforcement-learning.html)，但平台契约、设备和安全边界仍由本项目自己定义。

## 多用户身份边界

生产环境采用“Studio SSO 作为身份提供方，Sim2Real 作为独立业务方”的关系：

```text
用户 → SSO 登录 → Sim2Real Auth Adapter → Sim2RealAuthPort
                                      ├─ accountId（租户隔离）
                                      └─ server-side token（仅显式 RoboGo 请求）
```

Sim2Real 业务路由只依赖 `Sim2RealAuthPort`，不读取 Studio React 状态、不访问 Studio 对话记录，也不把 Studio 数据库当作业务台账。生产同域部署由经过验证的 Studio SSO 网关/adapter 提供身份；当前公开仓库的 `studio-sso-auth.ts` 仅提供 standalone 与签名 `trusted-proxy` 参考组合根，不直接解密 Studio Cookie。将来拆成独立域名/仓库时，可以替换为单独注册的 OIDC client 和 Sim2Real 自有会话，仿真、训练、评测和部署模块无需修改。

共享部署中缺少有效身份直接返回 401，绝不回退到公共 owner；模型、运行、部署、设备和审计记录均以稳定的 SSO `accountId` 做隔离。RoboGo 的 token 不进入浏览器、URL、manifest 或日志。

## 边界

### 已实现

- 独立 Web 服务 services/sim2real-web，默认本地端口 18102。
- /sim2real/ 仪表盘：契约指标、模型 manifest、制品摘要、RoboGo 聚合状态、
  RDK 目标、运行/部署台账。
- 产品选择器同时支持 MicroDuck 与 RDK Duck；两者共享台账和训练后端，但不共享机器人契约。
- MicroDuck 官方浏览器仿真固定入口 /mujoco/microduck/。
- manifest 的 schema、产品标识、输入输出形状、观测布局、制品角色和危险引用校验；
  MicroDuck 严格匹配固定布局，RDK Duck 按真实 manifest 做自洽校验。
- manifest 可声明由 ONNX 制品驱动的策略包，以及独立的 `simulator.controls` 运行时控制清单
  （行走、坐下/站起、翻滚、轮滑、踢球、叫声、重置等）；仿真与训练使用同一份可追溯动作契约，
  不会把 UI 动作误当成模型制品。
- RoboGo 训练预设（冒烟、低显存、标准、高显存）和明确的 checkpoint 续训引用；训练参数在服务端
  做范围校验，不执行用户粘贴的 shell 命令。
- 本地训练 runner 与 RoboGo runner 使用同一份受控 JSON 契约，但本地适配器不会转发 Studio/RoboGo
  bearer token；未配置本地 worker 时不会回退到 RoboGo 地址。
- 运控策略的 CPU ONNX 单线程声明（runtime=cpu-onnx、workload=locomotion、threads=1），
  与感知 BPU 制品分流；未声明运行时的普通 ONNX 仍保持转换阻断。
- 按账号隔离的元数据台账。
- Web Cloud 配置 `RDK_SIM2REAL_STORAGE_DIR` 后可支持单实例多账号；横向扩容或高并发前应把当前 JSON ledger 替换为带行级 owner/project 约束的 PostgreSQL / 对象存储 adapter。
- RDK 板型探测、兼容性判断和只读 preflight；preflight 不上传模型、不启动节点、
  不驱动电机。
- 平台侧遥测 ingest（JSON/JSONL）、幂等补传、回放摘要和 action/observation MAE/RMSE 评测；
  轨迹按 run 与账号隔离保存。
- 遥测 ingest 受单 chunk、单 run 和单账号的样本/字节配额保护；当前 JSON ledger 是单实例
  MVP，超过配额或需要横向扩容时应迁移到对象存储/数据库 adapter。
- systemd unit、Nginx 安装脚本和独立服务健康检查。
- 本地真实训练 worker 自带有界并发队列（默认 1 个子进程），健康接口会返回并发上限、运行中和排队数量；这避免多个用户在 CPU/单卡服务器上互相挤占。

### 明确未宣称已完成

- 任意用户 policy 动态替换官方浏览器策略。
- RoboGo 训练作业的开发机申请、计费控制和训练结果回写（页面现在只调用显式配置的
  runner 协议并记录返回的任务状态；runner 未配置时只能登记，不能启动计费算力）。
- 模型转换、编译制品上传、checksum 下发。
- canary/live 真实控制、执行器安全联锁，以及由 X5 Board Agent/Protobuf/对象存储驱动的真实遥测闭环。

这些部分必须先有受控 runner、制品存储/编译器、board agent 和审批协议；没有这些
资源时，网页保持 blocked，而不是把一个成功提示当成真实上板。

## 数据流

```
浏览器
  ├─ GET /sim2real/                         独立静态页面
  └─ /api/v1/duck/*                        版本化独立控制面（/api/sim2real/* 兼容）
       ├─ manifest validator                纯函数契约门
       ├─ owner-scoped ledger               仅存元数据/状态
       ├─ local runner adapter              内网 worker（训练动作显式）
       ├─ RoboGo adapter                   只读聚合查询（训练动作显式）
       ├─ board adapter                    探测与兼容性
       ├─ telemetry ingest                 JSON/JSONL、幂等、回放与评测（有配额）
       └─ fixed preflight                  只读板端探针

产品选择器 ──MicroDuck──> /mujoco/microduck/     官方 WASM/ONNX 仿真
           └─RDK Duck───> 独立仿真 adapter（未配置前保持 blocked）
```

## 配置

- RDK_SIM2REAL_PORT：监听端口，默认 18102。
- RDK_SIM2REAL_BIND_HOST：监听地址，默认 127.0.0.1。
- RDK_SIM2REAL_STORAGE_DIR：Sim2Real 元数据台账目录；Web Cloud 必须显式设置。
- RDK_SIM2REAL_LOCAL_RUNNER_URL：本地训练 worker 的内网 POST 入口；设置后即可使用本地训练，
  不需要 RoboGo 账号。
- RDK_SIM2REAL_ROBOGO_RUNNER_URL：受控 RoboGo runner 的 POST 入口；未设置或返回错误
  时不会启动训练机器，也不会伪造成功。

完整的机器调用契约见 [`docs/api/openapi.yaml`](../api/openapi.yaml)；外部 MCP、CLI 和 RDK Studio
入口都应调用版本化 `/api/v1/duck`，不要直接依赖 runner 私有接口。

SSO、trusted-proxy/Cookie 适配和 RoboGo 账号 token 由部署方的受控 adapter 注入，不在页面、manifest、
日志或 unit 文件中写入凭据；公开 standalone unit 当前只提供 trusted-proxy 参考。

当前 JSON ledger 只支持单进程/单实例写入；不要在没有数据库 adapter 和跨实例锁的情况下启动
多个 Web 副本。遥测默认每个 run 最多 100,000 个样本/128 MiB、每个账号最多 500,000 个样本/
512 MiB，整个 ledger 另有 100,000 个 chunk 的硬上限；run/账号/chunk 遥测配额超限返回
`413 SIM2REAL_TELEMETRY_QUOTA_EXCEEDED`，整个 ledger 字节上限返回
`507 SIM2REAL_STORAGE_QUOTA_EXCEEDED`。任一情况都会拒绝本次写入，不会静默淘汰已接受历史。
评测与回放读取该 run 的全部已接受 chunk；这是保护单实例磁盘和评测内存的 MVP 闸门，不是对象存储配额替代品。

单实例台账还对元数据设置硬上限：最多 100 个自定义模型、10,000 个 run、200 个部署计划，
超限返回 `507 SIM2REAL_LEDGER_QUOTA_EXCEEDED`，历史记录不会被静默淘汰。local/RoboGo 的
queued/running 任务按账号共享默认 4 个并发（`RDK_SIM2REAL_MAX_ACTIVE_RUNS` 可调，最大 100），
幂等键预留和并发检查在同一台账事务链中完成。它们只是单实例保护阀；正式多人产品仍需
PostgreSQL 行级配额、对象存储和跨副本锁。

runner 可能已经接受请求但提交响应超时或连接断开；这类 outcome unknown 与进程在写回
`externalRunId` 前崩溃的情况一样，预留的 queued run 会保留，不能直接重试提交。确认外部任务
归属后，运维可调用版本化 `POST /api/v1/duck/runs/:id/reconcile` 并提交（旧客户端可继续使用
`/api/sim2real/runs/:id/reconcile` 兼容别名）
`{"externalRunId":"…","confirm":true}`；服务只读查询 runner 状态并原子补回台账，不会再次发起
训练。查询失败返回可重试的 `503 SIM2REAL_RUN_RECONCILE_UNAVAILABLE`。没有
`externalRunId` 的崩溃窗口预留默认在 24 小时后、下一次提交训练时自动终止并释放并发名额，
可用 `RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS` 调整（5 分钟至 7 天）；已关联真实 runner 的任务不受影响。

## 契约来源与边界

MicroDuck 的 contract 数值来自已核对的上游浏览器策略和仓内测试；RDK Duck 的关节数、
观测/动作布局、控制频率和配件输入必须由产品团队提供并登记到 manifest。RDK 板型、模型编译格式
和 runtime 以 [RDK 官方开发文档](https://developer.d-robotics.cc/rdk_studio_doc/) 及仓内
`server/sim2real/standalone-compatibility.ts`、`shared/board-types.ts` 的适配边界为准。
平台不会用 MicroDuck 数字猜测 RDK Duck 契约。
