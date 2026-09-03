# MicroDuck 与 RDK Duck：双产品仿真到部署方案

> 对外发布前请先阅读 [`RDK 机器人强化学习开发平台：最终方案审查与修订稿`](./rdk-rl-platform-final-review.md)，其中列出了当前实现边界、契约拆分、数据闭环和分阶段验收要求。

> 版本：2026-09-03 · 状态：控制面 MVP（Mock 状态流 + 遥测回放评测）已实测；真实 RL/X5 闭环待硬件验收
> 入口：[RDK Sim2Real Lab](https://rdkstudio.d-robotics.cc/sim2real/)

## 先说结论

这套平台不是把两个机器人和两种训练后端做成多套系统，而是共用一套平台协议，再分别装配产品契约和训练后端：

```text
选择产品线
   ├─ MicroDuck：固定官方契约（61D → 14D，50Hz）
   └─ RDK Duck：manifest 定义契约（不猜测维度）
        ↓
   ┌───────────────┐
   │               │
本地 worker       RoboGo worker
（当前是 Mock）   （可选，待配置）
   │               │
   └───────┬───────┘
           ↓
运行台账 / checkpoint / 板端兼容性预检
           ↓
无电机 Canary → 受控 Live
```

当前服务器已经跑通的是“不使用 RoboGo”的 Mock MVP：请求、契约校验、queued → running → completed 状态、checkpoint/artifact/metrics 引用、遥测回放评测和台账都真实走了一遍；Mock 的 `completed` 只表示协议流程完成，不代表执行了真实强化学习。

## 页面怎么用：任务流与平台模块分层

进入平台后先在全局上下文条选择产品线、模型和目标设备。顶部的交付流程始终可见：

```text
仿真与录制 → 训练与导出 → 评测与效果 → 预检与上板
```

这条流程适合第一次做一个动作时按顺序推进；总览页下方的六个模块卡则适合日常直接进入：

| 模块       | 主要任务                                 | 典型输出               |
| ---------- | ---------------------------------------- | ---------------------- |
| 套件与契约 | 选择 MicroDuck / RDK Duck，导入 manifest | contract、配件 profile |
| 仿真与数据 | 场景运行、动作录制、回放                 | trajectory JSONL       |
| 训练中心   | 选择 local / Mock / RoboGo               | run、checkpoint        |
| 评测中心   | 查看仿真/真机指标与发布建议              | evaluation             |
| 设备与发布 | X5 预检、Canary、Live 闸门               | deployment             |
| 记录与审计 | 版本、制品、运行和操作事件               | 可追溯台账             |

首页只负责“当前状态、下一步、阻断原因和模块跳转”，不再把所有表单堆在同一张长页面；每个模块都能独立刷新、失败重试和回到上一步。

### 多用户账号：共享身份，不共享业务实现

生产部署让 Studio SSO 作为身份提供方，Sim2Real 通过 `Sim2RealAuthPort` 获取稳定的
`accountId` 和当前请求的服务端令牌。Sim2Real 自己维护模型、run、artifact、设备和部署台账，
所有记录按 `accountId` 隔离；未登录的共享部署请求返回 401。

当前仓内 `studio-sso-auth.ts` 只是组合根适配器，负责把现有 Studio SSO 会话转换成这个端口；
同域模式因此不需要二次登录。Sim2Real 的业务路由不直接引用 Studio SSO 实现，未来拆成独立域名/仓库
或接入标准 OIDC 时，只替换身份适配器，不改业务模块。RoboGo token 只在服务端为当前账号的显式训练请求使用。

### 两个产品如何兼容

| 项目       | MicroDuck                                         | RDK Duck                                                    |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------- |
| `robot.id` | `microduck`                                       | `rdk-duck`                                                  |
| 契约策略   | 固定 `microduck-policy-v1`，严格校验观测/动作布局 | `rdk-duck-policy-*`，由产品 manifest 声明真实维度和字段顺序 |
| 浏览器场景 | 官方 MicroDuck 场景                               | 独立适配器；未配置前不会展示 MicroDuck 场景                 |
| 训练后端   | local / Mock / RoboGo                             | local / Mock / RoboGo，共用同一训练协议                     |
| 上板目标   | RDK X5                                            | RDK X5 + 产品自己的配件 profile                             |

两者共用 `modelId / run / artifact / evaluation / deployment` 台账和安全闸门，只有
`robot.id`、`contract`、仿真适配器和配件 profile 不同。RDK Duck 的关节数、观测量、动作顺序、控制频率和 decimation 必须由你们的真实模型契约填入 manifest；平台只校验自洽性，不会用 MicroDuck 的数字猜测。

## 独立平台总架构：一站式体验，不是一进程

最合理的边界是“平台独立、入口互通”。Sim2Real Lab 自己拥有项目、模型、运行和部署台账；RDK Studio 通过 Skill / MCP / API 调用它，但不复制一套业务逻辑。RoboGo 是可插拔的云端训练后端，本地 Agent 负责 GPU、文件、USB/SSH 和 RDK 板卡等需要在用户环境执行的动作。

```text
RDK Studio（可选入口）
  → 账号隔离的 DSH Skill（流程剧本）
  → microduck-mcp（AI 适配器，只包装 API）
  → Sim2Real API（唯一业务契约）
  → 台账 / 事件 / 权限（owner、幂等、审计）
       ├─ Local Agent：本地 GPU、文件、真实 RL；无 GPU 时 Mock
       └─ RoboGo Connector：云端训练、runId、状态和 checkpoint
  → run → artifact → RDK preflight → no-motor Canary → 人工批准的 Live
```

### 四个边界

| 组件                | 负责                                                           | 不负责                                 |
| ------------------- | -------------------------------------------------------------- | -------------------------------------- |
| Sim2Real Lab        | 项目、manifest、run、artifact 引用、设备与部署台账、owner 隔离 | 不复制聊天历史；不保存 RoboGo 原始密钥 |
| RoboGo              | 云端训练算力、原始日志和真实 checkpoint                        | 不能绕过平台契约、权限和计费确认       |
| RDK Studio          | 对话、Skill 编排、MCP 调用、审批和证据展示                     | 不持有业务真源；不直接控制舵机         |
| Local / Board Agent | 本地 GPU、文件、USB/SSH、RDK 探测和硬件执行                    | 不定义模型契约；不跳过 Live 安全闸门   |

### API、MCP、Skill 分工

- **API 是机器契约**：当前由 `/api/sim2real/...` 提供统一接口，后续可平滑映射到版本化 `/api/v1/duck/...`；网页、CLI、RDK Studio 和未来客户端都不直接调用 runner。
- **MCP 是 AI 适配器**：`microduck-mcp` 只转发 API 并投影状态/证据；Plan/Spec 只读，Execute 的训练、上传、Canary、Live 等变更动作必须审批。
- **Skill 是流程剧本**：用账号隔离的 DSH Skill 描述“先仿真、再训练、再预检”的步骤，不把模型校验、权限和业务状态塞进 Skill 文本。

### 在 RDK Studio 里的一次完整操作

1. 规划阶段通过 MCP 只读读取项目、manifest、板卡和历史 run，生成可审阅的 Spec/Plan。
2. 执行前明确选择 `local` 或 `robogo`，训练、上传、Canary、Live 等变更动作等待用户批准。
3. Skill 调 MCP，MCP 调版本化 API；服务端返回 `runId`，事件或轮询持续更新状态。
4. 状态、artifact、参数、日志摘要和失败原因同时写入平台台账并投影到 Studio。
5. 通过 preflight 和 no-motor Canary 后，才允许受控硬件 Agent 在人工批准下进入 Live；网页永远不直接开电机。

### 五大共建方向如何落到平台

| 方向            | 平台落点                                                                             |
| --------------- | ------------------------------------------------------------------------------------ |
| 仿真与强化学习  | 行走、转向、自恢复、踢球和新动作共用 contract、评测基线与 checkpoint 规范            |
| 仿真 × 实体连接 | Local / board agent 接传感器、控制接口和数字孪生，先做 no-motor Sim2Real 验证        |
| RDK 端侧推理    | 运控 ONNX CPU 单线程；视觉、语音、导航等感知 workload 走 BPU，分别评测实时性和稳定性 |
| 具身智能交互    | 追球、认人、语音、Agent、多模态作为上层任务，通过同一设备与模型接口组合              |
| 硬件与整机      | 结构件、舵机、控制板、传感器和完整机器鸭共享设备 passport、兼容性和发布闸门          |

安全底线：RoboGo token 只在服务器受控环境或现有 SSO 会话中短时使用，不进入前端、聊天、manifest 或日志；local 与 RoboGo 不自动互相 fallback，跨账号读取、取消和导出一律拒绝。

## 公共底座

| 层            | 平台做什么                                                                           | 当前状态  |
| ------------- | ------------------------------------------------------------------------------------ | --------- |
| 浏览器仿真    | 打开官方 MicroDuck WASM/ONNX 仿真                                                    | 已上线    |
| 模型契约      | MicroDuck 严格校验固定契约；RDK Duck 校验 manifest 自洽契约                          | 已上线    |
| manifest      | 登记模型版本、policy bundle 和不透明 artifact 引用                                   | 已上线    |
| 训练协议      | 统一 `queued/running/completed`，运行详情轮询和 checkpoint/artifact/metrics 返回格式 | 已上线    |
| 台账          | 按账号记录 run、训练参数、checkpoint 和状态                                          | 已上线    |
| 遥测与评测    | JSON/JSONL ingest、幂等补传、回放摘要、MAE/RMSE 和跌倒/奖励统计                      | 已上线    |
| 板端预检      | 读取板型、系统、TROS、磁盘等信息，不开电机                                           | 已上线    |
| Canary / Live | Canary 只做无电机验证；网页不直接开启 Live                                           | 受控/阻断 |

运控策略可使用 `cpu-onnx + locomotion + threads=1`，由 CPU 单线程推理；视觉、语音和感知模型继续走 RDK BPU。普通 ONNX 不会被冒充成目标板的 BPU 编译制品。

当前 JSON ledger 适合单实例多人 MVP；正式横向扩容前，应替换为带 `accountId/projectId` 行级约束的共享数据库或对象存储 adapter。

## 路径 A：不用 RoboGo

路径 A 对两个产品都适用。切换产品线后，local worker 收到同一份经过校验的 manifest；唯一变化是
`manifest.robot.id` 和 `manifest.contract`，不会把 MicroDuck 的观测或动作维度套到 RDK Duck。

### 当前链路

```text
Sim2Real 页面
  → POST /api/sim2real/runs（backend=local）
  → local-runner
  → http://127.0.0.1:19090/train
  → Mock worker（queued）
  → GET /api/sim2real/runs/:id（running → completed）
  → run 记录 + mock checkpoint/artifact/metrics
```

当前 Mock worker 监听 `127.0.0.1:19090`，systemd 单元为 `sim2real-mock-worker.service`。它只做契约校验、写入任务回执和返回明确标记：

```json
{
  "status": "queued",
  "mock": true,
  "cuda": false,
  "deployable": false,
  "message": "Mock 任务已排队；随后通过 GET /runs/:runId 观察 running → completed。"
}
```

训练完成后，平台可以将浏览器导出的 JSONL 或 Board Agent 上报的同格式数据提交到
`POST /api/sim2real/runs/:id/telemetry`，再调用 `POST /api/sim2real/runs/:id/evaluate` 生成回放摘要和
action/observation 的 MAE/RMSE。当前数据仍保存在本地 owner-scoped ledger，尚未接入 X5 的 Protobuf Agent。

将来接入本地 GPU 时，只需要让真实 worker 实现同一个 `/train` 协议，并把 `RDK_SIM2REAL_LOCAL_RUNNER_URL` 指向它；页面和 API 不需要改。

## 路径 B：使用 RoboGo

路径 B 对两个产品都适用，RoboGo 只负责训练算力，不负责解释机器人契约。RDK Duck 的真实观测布局、动作顺序、频率和降采样参数必须先写入 manifest，再提交训练。

### 计划链路

```text
Sim2Real 页面
  → POST /api/sim2real/runs（backend=robogo）
  → robogo-runner
  → RoboGo 训练 API
  → queued / running / completed
  → 真实 artifact / checkpoint
  → 回写同一份 Studio 台账
```

RoboGo 是显式可选后端。只有配置 `RDK_SIM2REAL_ROBOGO_RUNNER_URL` 后，平台才会发起请求，不会自动申请计费机器。请求只携带已校验的模型契约、机器人变体、artifact 引用和归一化训练参数，不携带 Python/XML/shell。

当前 RoboGo 分支已经有独立 adapter、状态解析、checkpoint 解析和失败保护，但生产环境没有配置真实 runner，所以尚未做真实云端训练验证。RoboGo 不可用时，本地分支也不会偷偷 fallback。

## 两条路径的差异

| 维度              | 不用 RoboGo              | 使用 RoboGo              |
| ----------------- | ------------------------ | ------------------------ |
| 算力位置          | 本地服务器 / 本地 GPU    | RoboGo 云端              |
| 当前状态          | Mock 已上线并实测        | 接口已预留，待配置       |
| 账号与费用        | 不需要 RoboGo 账号       | 需要显式登录/计费确认    |
| 请求入口          | local runner `/train`    | RoboGo runner            |
| 模型契约          | 按产品选择；两者均先校验 | 按产品选择；两者均先校验 |
| 台账与 checkpoint | 相同                     | 相同                     |
| 上板流程          | 相同                     | 相同                     |
| 自动 fallback     | 不允许                   | 不允许                   |

## 实际跑通的例子

在服务器的隔离 `18103` 候选实例上，用最终 release 和永久 Mock worker 走了下面这次请求：

```json
{
  "modelId": "builtin-microduck-official",
  "backend": "local",
  "training": {
    "profile": "smoke",
    "numEnvs": 64,
    "maxIterations": 5,
    "video": false
  }
}
```

返回结果的关键字段：

```text
status: completed
mock: true
cuda: false
externalRunId: mock-microduck-90fc2a90-e465-4216-814d-758398699705
checkpoint.iteration: 0
artifactRef: artifact://mock/microduck/.../checkpoint-0
```

同一条链路还验证了 `low-vram / 128 env / 12 iterations` 的自定义参数，台账文件成功写入。错误的 `contractId` 会被 Mock worker 拒绝并返回 HTTP 400，说明它不是无条件伪造成功。

历史候选实例验证记录（发布前请用当前 release SHA 重新复核，不能替代真实 RL/X5 验收）：

```text
release: 20260903-sim2real-mock-mvp-05
sim2real-web.service: active
sim2real-mock-worker.service: active
公网页面: https://rdkstudio.d-robotics.cc/sim2real/
```

## 现在能做什么、还不能做什么

### 现在能做

1. 打开 MicroDuck 浏览器仿真。
2. 在产品选择器切换 MicroDuck / RDK Duck。
3. 校验和登记对应产品的模型 manifest；RDK Duck 不会复用 MicroDuck 维度。
4. 选择 smoke / low-vram / standard / high-vram 训练档位。
5. 走本地 Mock 训练流程，查看 run 和 checkpoint 引用。
6. 接入真实本地 GPU worker（协议不变）。
7. 配置 RoboGo runner 后走第二条训练分支。
8. 登记 RDK 板卡并生成只读 preflight / 无电机 Canary 计划。
9. 导入遥测 JSONL，在评测页查看时间轴、采样率、奖励、跌倒事件；点击“上传到当前 Run 并评测”后，平台会分块幂等写入并生成评测摘要。

### 还不能做

- 当前服务器没有 CUDA、MuJoCo、PyTorch 等真实 RL 训练环境。
- Mock checkpoint 不是 ONNX/HBM 模型，不能上板或用于真实续训。
- 自定义模型暂时不会动态替换浏览器中的官方策略。
- RDK Duck 的真实浏览器/离线仿真适配器、观测动作定义和配件驱动仍需按实物契约接入。
- 网页不会直接开启舵机和电机的 Live 控制。
- 真实传感器 → 运控 → 舵机的 Sim2Real 闭环还需要板端 agent 和硬件验证。

## GPU 或 RoboGo 到位后的切换

### 接入本地 GPU

1. 安装 MicroDuck RL、MuJoCo、PyTorch 等依赖。
2. 写一个只接受固定 JSON 契约的真实 `/train` worker。
3. 返回真实的 `queued/running/completed` 和受控 artifact 引用。
4. 去掉 Mock mode，替换 `RDK_SIM2REAL_LOCAL_RUNNER_URL`。
5. 用同一个 manifest 重新跑仿真、评测和板端 preflight。

### 接入 RoboGo

1. 配置 `RDK_SIM2REAL_ROBOGO_RUNNER_URL`。
2. 确认 RoboGo 登录态、项目权限和计费策略。
3. 先用 smoke profile 做一次真实任务。
4. 核对 RoboGo 返回的 runId、状态和 artifact 引用。
5. 再进入板端兼容性、Canary 和人工批准流程。

最终目标不是维护两套产品，而是让 RoboGo、本地 GPU 和未来其他训练集群都接入同一个模型契约和同一个 RDK 部署控制面。
