# Sim2Real 90 分阶段验收

> 适用范围：没有 CUDA、真实 X5 和 RoboGo Runner 时，对控制面与可复现软件闭环的验收。
> 这不是对真实机器人硬件闭环的替代，也不把 Mock 结果包装成 RL 成功。

> 最新软件验收（2026-09-06）：`npm run smoke:sim2real-local` 会启动临时 Web、local
> worker、外部引擎 fixture 和 reference BoardAgent，验证本地桥接、幂等重放与模拟预检
> 阻断；fixture 只证明协议，不代表真实 PPO。

## 评分口径

| 能力     | 目标                                                      | 当前结果                                   |
| -------- | --------------------------------------------------------- | ------------------------------------------ |
| 工作流   | 仿真/录制 → 训练 → 评测 → 制品 → 预检 → 记录可回退        | 控制面与本地桥接已完成；真实训练/硬件待验收 |
| 双产品   | MicroDuck 固定契约，RDK Duck manifest 契约                | 契约校验已完成；RDK 仿真适配待接入           |
| 双后端   | 本地/Mock 与 RoboGo 使用同一训练协议                      | 已完成，RoboGo 需显式 Runner               |
| 运行状态 | queued → running → completed，支持详情轮询                | 已完成                                     |
| 制品追踪 | checkpoint、opaque artifact、sha256、metrics 和 mock 标记 | 已完成元数据链路，Mock 制品不可部署        |
| 遥测     | JSON/JSONL、幂等补传、owner 隔离、回放摘要、MAE/RMSE      | 已完成平台侧链路                           |
| 设备安全 | 板型兼容性、只读 preflight、Canary/Live 阻断              | 已完成安全闸门                             |
| 多用户   | SSO account 隔离，服务与 Studio 解耦                      | 已完成 MVP；规模化仍需 PostgreSQL/对象存储 |
| 幂等与恢复 | runner 预留、账号并发上限、崩溃后 reconcile                | 已完成单实例保护；生产需外部队列/配额服务   |
| 台账保护 | 遥测/元数据大小上限、readyz 发现损坏或超限                  | 已完成保护阀；不是长期对象存储方案           |
| 可复现性 | focused tests、固定 Mock 延时、错误输入拒绝               | 已完成                                     |

## 端到端验收顺序

1. 选择 MicroDuck 或登记 RDK Duck manifest。
2. 在浏览器仿真中手动演示、录制或回放动作。
3. 选择本地 Mock，观察 `queued → running → completed`。
4. 打开运行详情，确认 checkpoint、artifact、sha256、metrics 和 `mock=true`。
5. 导入 JSONL 遥测，查看样本数、采样率、奖励、跌倒事件和时间轴；确认前端不会自动上传。
6. 点击“上传到当前 Run 并评测”，将本地证据分块、幂等写入 Run，再生成 action/observation MAE/RMSE 评测。
7. 选择目标 X5，生成只读 preflight；无匹配编译制品时必须保持 blocked。
8. 模拟重复提交和 runner 预留：同一 `Idempotency-Key` 不得产生第二个任务；达到并发上限返回
   `429 SIM2REAL_ACTIVE_RUN_QUOTA_EXCEEDED`；模拟进程在 runner 回执后崩溃时，用
   模拟 runner 已受理但提交响应超时/连接断开（outcome unknown）或进程在写回 id 前崩溃：任务必须保留
   queued 预留；确认归属后用版本化 `POST /api/v1/duck/runs/:id/reconcile`（旧客户端可继续使用
   `/api/sim2real/runs/:id/reconcile` 兼容别名；`externalRunId` +
   `confirm=true`）只读补回状态，不能重新启动任务。
9. 在记录中心按 Runs、发布、制品和遥测筛选，确认所有结果可追溯；损坏/超限台账应让 `/readyz`
   变为未就绪，而不是当成空库继续写入。

## 真实闭环剩余门槛

- 用真实 MicroDuck/RDK Duck PPO worker 替换 Mock；
- 用 X5 Board Agent 发送 Protobuf、RingBuffer 分片和断网补传数据；
- 引入对象存储、制品签名/校验、PostgreSQL 项目成员和生产租户配额（当前只有单实例保护上限）；
- 由受控 Agent 执行 no-motor Canary，再经过人工批准进入 Live；
- 用一台真实 X5 完成 `run → artifact → deployment → telemetry → evaluation` 验收。

完成这些硬件与生产门槛后，平台才可以从“控制面 90 分”升级为“真实机器人平台 90 分”。
