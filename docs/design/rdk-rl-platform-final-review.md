# RDK 机器人强化学习开发平台：最终方案审查与修订稿

> 审查日期：2026-09-03
> 适用对象：RDK Duck / MicroDuck 双产品、独立 Sim2Real 平台、可选 RDK Studio 与 RoboGo 接入

## 1. 先给结论

原方案的产品方向是正确的：用一个独立控制面把仿真、动作数据、训练、模型制品、评测、设备和
Sim2Real 证据串起来，同时保留本地服务器和 RoboGo 两种训练后端。

但现在不适合直接以“完整端云闭环已完成”对外发布。原文需要做一次**状态分层和边界收敛**：

1. 当前仓库已经具备的是平台控制面 MVP：双产品 manifest 校验、训练后端协议、异步 Mock runner、账号隔离、只读板端预检、JSON/JSONL 遥测接收/回放/评测和模块化 Web 工作台。
2. 当前还没有真实实现的是：PPO/RL worker、RoboGo 生产 runner、X5 板端采集 Agent、Protobuf 遥测、eMMC 滚动缓存、断网补传、对象存储、真实制品上传/签名/编译、OTA 和真机硬件验收。
3. 因此建议把项目拆成“控制面 MVP → 单机硬件 Beta → 多用户产品化”三阶段，不要把二期硬件能力写成一期已交付能力。

推荐对外定位改为：

> **面向 MicroDuck 与 RDK Duck 的独立机器人策略研发平台。平台提供统一的项目、契约、仿真、训练、制品、评测和发布控制面；本地服务器是默认训练路径，RoboGo 是可插拔云训练后端。真实 X5 数据回流、签名制品和 OTA 通过独立 Board Agent 逐步接入。**

## 2. 必须修改的内容（P0）

| 原文表述/设计                            | 问题                                                                             | 建议改法                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| “底层依托 RoboGO 算力底座”               | 当前没有配置真实 RoboGo runner，无法证明云端任务、状态回写和计费链路             | 改为“支持 RoboGo 作为可插拔训练后端；本地 worker/Mock 可独立运行，未配置 runner 不产生计费任务”          |
| “完全复用 RoboGO 全部算力调度、用户权限” | 不能依赖 RoboGo 内部数据库、权限实现或未公开接口                                 | 改为“仅通过受控、公开或已确认的 API 复用能力；平台自己的项目、权限和台账不依赖 RoboGo 内部实现”          |
| “模型 OTA 一键下发”                      | 目前只有部署计划和只读 preflight，没有 Board Agent、签名校验、回滚和急停闭锁     | 改为“生成发布计划；接入 Board Agent、签名和回滚后才开放下发”                                             |
| “完整端云 Sim2Real 闭环”                 | 仓库没有 X5 采集 Agent、日志 ingest、对象存储和虚实轨迹叠加                      | 一期写成“控制面闭环”；硬件 Beta 完成一台 X5 的真实回流后再称“端云闭环”                                   |
| “全局统一 protobuf 契约”                 | MicroDuck 与 RDK Duck 的 policy 维度和帧定义不同；物理仿真步长不是机器人策略契约 | 拆成 `PolicyContract`（按产品独立）+ `TelemetryEnvelope`（端云共用）+ `Trajectory/Dataset`（数据集契约） |
| “2.5–3.2 人月完成 MVP”                   | 同时包含前端、RL 调度、板端采集、对象存储、OTA、评测和安全，估算明显偏乐观       | 将该估算限定为控制面 MVP；硬件 Beta 和多租户产品化另列工期与依赖                                         |

### 2.1 两个产品不能共用一套“固定维度”

应保留一个统一的资源模型，但不能把两个机器人的策略输入输出强行统一：

```text
ProductProfile
 ├─ MicroDuck：官方浏览器策略，固定 61D observation / 14D action / 50Hz
 └─ RDK Duck：由真实 manifest 登记 observation、action、关节、频率和配件

PolicyContract（每个产品独立、版本化）
TelemetryEnvelope（端云公共外壳）
Trajectory/Dataset（录制、回放、训练数据）
```

`physics_timestep`、`decimation` 属于 simulator profile；真机契约必须额外明确单位、坐标系、
关节顺序、动作限幅、控制周期、动作延迟和时间戳语义，不能因为 MicroDuck 是 50Hz 就推断 RDK Duck 也是同样数值。

### 2.2 独立项目边界需要再收紧

当前同一仓库内可以让 `services/sim2real-web/server.ts` 作为组合根，注入 Studio SSO、设备探测和
现有执行适配器；这能支持同域部署，但还不等于两个项目完全解耦。

独立仓库的核心包应该只依赖接口：

```text
Sim2Real Core API
 ├─ AuthPort            （Studio SSO / 独立 OIDC adapter）
 ├─ TrainingPort        （local / mock / RoboGo connector）
 ├─ ArtifactStorePort   （本地对象存储 / S3 兼容存储）
 ├─ TelemetryStorePort  （设备上报 / 数据集 / 回放）
 ├─ DeviceAgentPort     （X5 Board Agent）
 └─ SimulatorPort       （MicroDuck / RDK Duck adapter）
```

Studio、RoboGo、X5 Agent 都只能在 composition root 实现这些 Port。Sim2Real 业务层不得导入
Studio 的 SSO、设备数据库、聊天运行时或 RoboGo 内部客户端。当前仓库的 `studio-sso-auth.ts`
可以保留为同域适配器，但应把这种依赖标成“部署装配层”，不能让它成为业务层依赖。

### 2.3 “很多人都能用”不能继续使用 JSON ledger

当前 JSON ledger 适合本地开发和单实例演示，不适合多人、并发写入或多副本部署。正式 MVP 至少需要：

- PostgreSQL（`account_id/project_id` 行级隔离、唯一约束、事务和幂等键）；
- 对象存储（模型、轨迹、日志分片与评测报告），数据库只存元数据；
- `Account → Project → Membership(owner/editor/viewer)` 关系；
- 项目/账号级并发、存储和 RoboGo 费用配额；
- 审计事件、删除/导出策略、限流和失败重试。

SSO 只负责“你是谁”，Sim2Real 自己负责“你能访问哪个项目、设备和制品”。同域时可以复用 Studio
SSO 会话；独立域名时应注册独立 OIDC client，不应共享 Studio 数据库。

## 3. 数据契约修订建议

### 3.1 `PolicyContract`（产品策略契约）

每个模型制品必须携带：

```json
{
  "productId": "microduck",
  "contractId": "microduck-policy-v1",
  "schemaVersion": "1.0",
  "observation": { "size": 61, "fields": [], "units": "declared" },
  "action": { "size": 14, "fields": [], "limits": [], "units": "declared" },
  "control": { "frequencyHz": 50, "actionDelayMs": 0 },
  "frames": { "base": "declared", "gravity": "declared" }
}
```

RDK Duck 的 `size`、字段顺序、单位和控制周期必须从真实模型 manifest 填入；平台只做自洽校验，
不使用 MicroDuck 数值猜测。

另外，MicroDuck 的 14D action 也不能直接当作 RDK 执行器语义。两条产品线都需要随制品固化
`ActuatorMap/CalibrationProfile`（方向、零位、限位、单位、减速比和动作延迟）；没有这份映射，
只能说“契约兼容”，不能说“无缝切换到真机”。

### 3.2 `TelemetryEnvelope`（端云公共外壳）

Protobuf 建议只用于设备遥测和可回放数据，不要把所有控制面 JSON/API 都改成 protobuf。公共外壳至少包含：

```text
schema_version
product_id / contract_id
project_id / task_id / model_artifact_id / deployment_id
device_id / boot_id / run_id
seq
source_monotonic_ns / source_wall_time_ms
frame_id / units_version
payload(oneof: control, imu, joint, camera_meta, event)
dropped_count / trigger / compression / checksum
```

兼容规则要写清楚：新增字段可向后兼容；删除或改单位必须升 schema；缺失字段不能静默填默认值。
控制线程只写预分配的定长样本，禁止在 50Hz 线程里做 protobuf 序列化、网络请求、磁盘 IO、堆分配或不可控锁。

### 3.3 RingBuffer 和触发采集的可验收定义

- SPSC 或每数据流独立的有界 RingBuffer，预分配固定容量；
- 控制线程只复制样本并递增序号，发生覆盖时递增 `overrun_count`；
- 后台线程按 cursor 读取、序列化和写分片；
- 触发器采用“前置窗口 + 后置窗口”的状态机，明确 `pre_seconds/post_seconds`；
- IMU 高频流与 50Hz 控制流分开限频；
- 典型实现应区分 50Hz policy/control 与 200–1kHz IMU 等高频流，分别设置容量和丢弃策略；
- 全量采集必须显示 CPU、内存、磁盘和上传 backlog 上限；
- eMMC 分片要有临时文件、fsync 策略、原子 rename、配额、寿命/健康指标和保留策略，不能简单按时间无条件删除证据。

断网补传使用 `(device_id, boot_id, seq)` 幂等键、可续传分片和服务端 ACK；设备重启、时钟漂移、
丢包和上传 backlog 必须可观测。

## 4. 模型制品和部署必须补的状态机

### 4.1 Artifact

原文的 `model_artifact_id` 方向正确，但“打包”不能只是保存文件路径或 opaque ref。建议：

```text
draft
  → validated（契约/shape/runtime/sha256 通过）
  → published（签名 manifest，不可变）
  → revoked（禁止新部署，历史记录保留）
```

制品 manifest 至少绑定：仿真快照、DR 参数、奖励版本、轨迹/数据集、源 ONNX、CPU ONNX runtime、
目标板编译制品、校准参数、训练镜像 digest、Git SHA、评测报告和每个文件的 SHA-256。发布后禁止原地修改，
部署永远引用具体 `artifact_id`，不能引用“latest”。

运控模型按用户补充的约束走 `CPU ONNX + threads=1`，不强制转 bin；视觉等 BPU workload 才需要目标板匹配的编译制品。

### 4.2 Deployment

```text
planned
  → preflight_passed
  → canary（限幅、无电机或安全场）
  → live（人工批准、急停和遥测在线）
  → rolled_back
```

真实 OTA 开放前还要有：设备注册与密钥轮换、mTLS、签名 manifest 校验、板型/固件/配件兼容性检查、
A/B 或双槽回滚、限幅与急停、分批/Canary 发布、断点续传和审计。网页不能直接 SSH、下发任意 shell 或开启舵机。

## 5. 训练和评测部分的准确说法

当前训练接口是受控 connector 协议，不等于平台已经实现 PPO。建议把训练后端统一成：

```text
submit(spec, idempotencyKey)
getStatus(runId)
cancel(runId)
streamMetrics(runId)
listCheckpoints(runId)
```

必须定义 `queued → running → succeeded/failed/cancelled`，检查点恢复、Webhook/轮询、租户配额、
失败分类和重试边界。RoboGo 失败不能静默切本地；计费任务只能在用户明确选择并通过费用确认后提交。

浏览器 MicroDuck 当前是**官方固定策略的手动演示、录制和回放**：

- 键盘动作轨迹可以作为 imitation/reward 设计素材；
- 不能把手动轨迹描述成 PPO 训练结果；
- 当前不能在浏览器里动态替换任意用户 policy；
- 当前平台已形成“本地导入 → 显式上传到 Run → 回放/评测”的 JSON/JSONL API；但“数据集版本 → 训练绑定”、真实 Board Agent 自动上报和对象存储仍待阶段 B；
- RDK Duck 的离线/浏览器仿真 adapter 仍需按真实契约接入。

评测需要固定基线、随机种子、成功率/跌倒率/动作延迟/CPU/BPU/内存/丢包等指标，并把评测报告和
`artifact_id + deployment_id + device_id + boot_id + contract_id` 一起绑定。仅凭 `model_artifact_id`
无法解释某一次真机运行，因为还缺设备标定、固件、容器和启动会话信息。

## 6. 建议的分阶段计划

### 阶段 A：控制面 MVP（当前仓库可证明）

目标是没有 CUDA、没有 X5 实机时也能验证协议和产品交互：

- MicroDuck 固定契约与 RDK Duck manifest 校验；
- 本地/Mock/RoboGo connector 接口和明确的 blocked 状态；
- 项目/模型/run/checkpoint/preflight 元数据台账；
- 模块化 Web 工作流、SSO 适配器和审计事件；
- 平台侧 JSON/JSONL 遥测 ingest、幂等补传、回放摘要和 MAE/RMSE 评测；
- Mock 结果明确标注 `mock=true`、`cuda=false`、`deployable=false`。

验收证据：请求、契约拒绝、run 状态、checkpoint 引用、账号隔离、只读 preflight 的自动化测试。

### 阶段 B：单机硬件 Beta（真实闭环的最小切片）

只选一个产品、一个动作、一个 X5、一个配件 profile：

1. 真实 RL worker（本地 GPU 或一次 RoboGo smoke）；
2. 不可变制品 manifest 和对象存储；
3. X5 Board Agent：RingBuffer、触发采集、分片、断网补传；
4. 服务端 telemetry ingest、ACK、轨迹回放和仿真/真机对照；
5. 只读 preflight → 无电机 Canary → 限幅 Live；
6. 形成一次可复核的 `run → artifact → deployment → telemetry → evaluation` 证据链。

### 阶段 C：多人产品化

- PostgreSQL + 对象存储替换 JSON ledger；
- Project/Membership/RBAC、配额、限流和审计；
- 多设备注册、心跳、能力 passport 和配件 profile；
- 签名制品、A/B OTA、分批发布和回滚；
- RoboGo webhook/状态同步、取消和成本控制；
- 真机日志回灌仿真、数据集导出、系统日志和长期保留策略。

排期建议改写为：阶段 A 约 2–3 人月；阶段 B 约 3–5 人月（受 X5 样机、驱动和训练算力影响）；阶段 C 约 3–6 人月。
这是工程粗估，不应在没有硬件和 RoboGo API 权限时承诺固定日期。

## 7. 当前仓库与目标方案的差距表

| 能力           | 当前可证明状态                                                                                        | 对外文档应写成                           |
| -------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| MicroDuck 仿真 | 官方浏览器入口、固定策略录制/回放                                                                     | 已有演示与数据入口，不是任意策略训练器   |
| RDK Duck 仿真  | manifest 定义与校验，真实 adapter 未接入                                                              | 适配中/未配置时 blocked                  |
| 本地训练       | Mock runner 已支持 queued/running/completed、checkpoint、artifact 和 metrics；无 CUDA 时不执行真实 RL | 协议 MVP，真实 worker 待接入             |
| RoboGo         | adapter、状态解析和失败保护已预留；生产 runner 未配置                                                 | 可插拔接口，未完成真实云训练验收         |
| 模型制品       | 元数据和 opaque artifact 引用                                                                         | 尚无真实文件上传、签名、编译和不可变存储 |
| X5 预检        | 只读探针和发布计划                                                                                    | 已有安全前置检查，不等于 OTA/Live        |
| X5 遥测        | 平台已有 JSON/JSONL ingest、幂等和评测；尚无 Board Agent、protobuf、对象存储                          | 平台链路已具备，硬件采集属于阶段 B       |
| 虚实对照       | 已能计算回放摘要与 MAE/RMSE；仿真参考轨迹和真机轨迹尚未由 X5 自动产生                                 | 评测接口已具备，真实轨迹叠加属于阶段 B   |
| 多用户         | SSO 适配和单实例 owner 隔离                                                                           | 多用户 MVP；规模化需 PostgreSQL/RBAC     |

## 8. API 和产品文案的最后调整

对外发布前建议：

- 将公共接口固定为版本化 `/api/v1/duck/...`，现有 `/api/sim2real/*` 仅作为兼容代理；
- 每个 contract、run、artifact、deployment 请求/响应都带 `productId` 和 `contractId`；
- `POST runs/deployments` 增加 `Idempotency-Key`，RoboGo 任务必须按幂等键去重，避免浏览器重试造成重复计费；
- Cookie/SSO 写请求增加 CSRF token 或严格 `Origin` 校验；共享 worker 不以 `127.0.0.1` 作为信任边界，需签名的 project/account 上下文；
- overview 不应永远返回 MicroDuck 的默认 contract，产品选择后应返回 `contracts[]` 或
  `GET /api/v1/products/:productId/contract`；
- `Sim2RealModelManifest` 增加 `projectId/taskId/datasetId/evaluationIds` 或明确的 lineage 引用，
  否则无法实现原文承诺的“快照绑定”和多人协作；
- artifact 的 `sha256` 不能只做字符串格式校验；注册表需要真实上传、大小/类型限制、病毒扫描、内容摘要校验和签名下载；
- 将“已上线/已完成”改成“已验证协议/已接入 adapter/真实硬件待验收”三种状态；
- 所有 Mock、dry-run、no-motor 结果必须在 UI、API、审计和导出物中显式标记，不能用绿色 completed 造成误解。

## 9. 最终建议

这份方案不需要推翻重做，应该做三件事：

1. 把当前交付物准确命名为“独立 Sim2Real 控制面 MVP”；
2. 把 X5 采集、真实训练、制品仓库、OTA 和虚实对照拆为可验收的阶段 B；
3. 以 Port/Adapter、版本化契约、不可变制品和证据链作为长期架构主线。

这样既保留 RoboGo、本地训练、RDK Studio Skill/MCP/API 的组合空间，也不会把一个没有 CUDA 的 Mock
验证误包装成真实机器人闭环；后续接入硬件或 RoboGo 时，只替换 adapter 和 worker，不重写平台核心。

## 10. 80 分版本借鉴的成熟模式

这里借鉴的是交互和资源组织方式，不复制第三方运行时：

| 参考平台                                                                                                                     | 借鉴点                                                | 在本平台的落点                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| [LeLab](https://huggingface.co/docs/lerobot/lelab)                                                                           | 一个 GUI 串起机器人配置、录制、训练、可视化和回跑     | 顶部四步工作流 + 套件/仿真/训练/评测模块                      |
| [Weights & Biases Project](https://docs.wandb.ai/models/track/project-page)                                                  | Project 下分 Runs、Artifacts、Reports，支持筛选和详情 | 记录页 Runs/发布筛选、运行详情弹窗和后续制品详情              |
| [MLflow Tracking](https://mlflow.org/docs/latest/ml/tracking)                                                                | Tracking 与 Model Registry 分层，参数/指标和制品分开  | Run、Evaluation、Artifact 三类资源分离，制品不可变            |
| [Kubeflow Pipelines](https://www.kubeflow.org/docs/components/pipelines/concepts/)                                           | typed input/output、可恢复步骤和元数据追溯            | 用四步可恢复工作流表达仿真→训练→评测→发布，不首期引入复杂 DAG |
| [Isaac Lab RL](https://isaac-sim.github.io/IsaacLab/develop/source/overview/reinforcement-learning/rl_existing_scripts.html) | train/play/eval 分工、checkpoint 和评测基线           | 明确浏览器 play、worker train、平台 eval 的职责边界           |
