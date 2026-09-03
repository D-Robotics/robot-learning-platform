# Sim2Real 90 分阶段验收

> 适用范围：没有 CUDA、真实 X5 和 RoboGo Runner 时，对控制面与可复现软件闭环的验收。
> 这不是对真实机器人硬件闭环的替代，也不把 Mock 结果包装成 RL 成功。

## 评分口径

| 能力     | 目标                                                      | 当前结果                                   |
| -------- | --------------------------------------------------------- | ------------------------------------------ |
| 工作流   | 仿真/录制 → 训练 → 评测 → 制品 → 预检 → 记录可回退        | 已完成                                     |
| 双产品   | MicroDuck 固定契约，RDK Duck manifest 契约                | 已完成                                     |
| 双后端   | 本地/Mock 与 RoboGo 使用同一训练协议                      | 已完成，RoboGo 需显式 Runner               |
| 运行状态 | queued → running → completed，支持详情轮询                | 已完成                                     |
| 制品追踪 | checkpoint、opaque artifact、sha256、metrics 和 mock 标记 | 已完成元数据链路，Mock 制品不可部署        |
| 遥测     | JSON/JSONL、幂等补传、owner 隔离、回放摘要、MAE/RMSE      | 已完成平台侧链路                           |
| 设备安全 | 板型兼容性、只读 preflight、Canary/Live 阻断              | 已完成安全闸门                             |
| 多用户   | SSO account 隔离，服务与 Studio 解耦                      | 已完成 MVP；规模化仍需 PostgreSQL/对象存储 |
| 可复现性 | focused tests、固定 Mock 延时、错误输入拒绝               | 已完成                                     |

## 端到端验收顺序

1. 选择 MicroDuck 或登记 RDK Duck manifest。
2. 在浏览器仿真中手动演示、录制或回放动作。
3. 选择本地 Mock，观察 `queued → running → completed`。
4. 打开运行详情，确认 checkpoint、artifact、sha256、metrics 和 `mock=true`。
5. 导入 JSONL 遥测，查看样本数、采样率、奖励、跌倒事件和时间轴；确认前端不会自动上传。
6. 点击“上传到当前 Run 并评测”，将本地证据分块、幂等写入 Run，再生成 action/observation MAE/RMSE 评测。
7. 选择目标 X5，生成只读 preflight；无匹配编译制品时必须保持 blocked。
8. 在记录中心按 Runs、发布、制品和遥测筛选，确认所有结果可追溯。

## 真实闭环剩余门槛

- 用真实 MicroDuck/RDK Duck PPO worker 替换 Mock；
- 用 X5 Board Agent 发送 Protobuf、RingBuffer 分片和断网补传数据；
- 引入对象存储、制品签名/校验、PostgreSQL 项目成员和配额；
- 由受控 Agent 执行 no-motor Canary，再经过人工批准进入 Live；
- 用一台真实 X5 完成 `run → artifact → deployment → telemetry → evaluation` 验收。

完成这些硬件与生产门槛后，平台才可以从“控制面 90 分”升级为“真实机器人平台 90 分”。
