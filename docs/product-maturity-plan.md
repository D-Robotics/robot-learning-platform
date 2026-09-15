# RDK Robot Learning Platform 产品成熟化计划

## 产品目标

RDK Robot Learning Platform 是面向 RDK 机器人产品的策略研发与安全交付平台。用户从项目、机器人和任务开始，在同一条工作流中完成仿真或采集、训练、制品管理、虚实评测、设备预检、Canary 发布和回滚。

平台必须把每个结果标成真实、模拟、受限或待接入，并为每一次训练、评测和部署保留可复核证据。

## 定位与同类对标

平台的核心定位是 **“机器人策略的证据链与安全交付控制面”**：它把机器人契约、数据/遥测、训练 Run、不可变 Artifact、评测证据、板型预检和人工审批串成一条可审计的发布链。它不是通用实验追踪器、通用物理仿真器或云端车队 OTA 平台；这些能力通过 runner、仿真器和 BoardAgent 适配器接入。

以下是按能力类别的对标，结论用于确定取舍，不代表对任何厂商做全面排名：

| 能力类别 | 成熟同类的强项 | 本平台当前取舍 | 需要补齐的差距 |
| --- | --- | --- | --- |
| 实验、数据和制品管理 | W&B Models、MLflow 在实验追踪、数据/制品版本、血缘、协作和 Registry 生态上成熟 | 已有 Project → Dataset → Run → Artifact → Evaluation → Deployment 一等血缘、不可变发布和审计 | PostgreSQL、对象存储、搜索/协作、跨团队权限和大规模查询 |
| 机器人仿真与训练 | NVIDIA Isaac Lab 侧重高保真 GPU 仿真、多 GPU 训练和丰富任务/机型生态 | 侧重契约驱动、可复核 Task-Pack、CPU starter 和可替换训练适配器；已含 MJX 引擎（真 MuJoCo 接触动力学 + 纯 JAX PPO，CPU 可验证、GPU 放大吞吐）与 mujoco-web 部署方模型注册表 | 物理级域随机化等高保真动力学、GPU 集群编排、更多任务和真实 sim-to-real 复现 |
| 真实机器人数据与策略部署 | Hugging Face LeRobot 侧重硬件无关控制、遥操作、标准化数据集和 rollout 工具 | 侧重 RDK 板型契约、attested telemetry、release gate、只读预检和人工审批 | 更广的传感器/机器人生态、视频数据管线、策略社区和一键 rollout |
| 车队与 OTA | AWS 当前推荐的 Greengrass v2 体系侧重设备注册、应用包、OTA job、状态回报和监控 | 只负责单次发布计划的证据与安全边界，物理执行留给 BoardAgent | 设备编组、OTA、灰度比例、自动回滚、跨地域运维 |
| 机器人安全交付 | 通用 MLOps 产品通常把硬件急停、板型兼容和执行前证据留给外部系统 | 这是本平台的差异化重点：契约校验、attestation、遥测新鲜度、证据门、只读 preflight、审批和 fail-closed | 真实多机型现场证据、硬件签名/安全启动、时间盒与回滚执行器 |

官方能力入口： [W&B Registry（版本、血缘与治理）](https://docs.wandb.ai/guides/core/registry/model_registry/link-model-version/)、[MLflow Tracking](https://mlflow.org/docs/latest/ml/tracking)、[NVIDIA Isaac Lab](https://developer.nvidia.com/isaac/lab)、[Hugging Face LeRobot](https://huggingface.co/docs/lerobot/main/index)、[AWS IoT Greengrass 部署](https://docs.aws.amazon.com/greengrass/v2/developerguide/manage-deployments.html)。

### 2026-09-13 内部成熟度判断

分数是团队用于排优先级的 5 分制工程判断，不是市场评分：

| 维度 | 当前 | 判断依据 |
| --- | ---: | --- |
| 产品主线与信息架构 | 4.0 | 一条主线覆盖仿真、训练、评测、预检和发布；Mock/真实边界在 UI/API/文档一致 |
| 契约、血缘与可追溯 | 4.0 | 一等 Dataset/Run/Artifact/Evaluation/Deployment、SHA-256、审计和新鲜度失效 |
| 发布安全与权限 | 4.0 | RBAC、attested telemetry、证据门、人工审批、急停/看门狗边界和 fail-closed |
| 训练与评测能力 | 3.5 | 真实 starter PPO/SAC、Task-Pack 和 CI 门禁已具备；高保真仿真和算法生态仍有限 |
| 真机闭环真实性 | 3.0 | RDK/X5 适配、板端遥测和只读预检已成链；通用 BoardAgent 执行与多机型现场证据仍需部署方补齐 |
| 规模化与多租户 | 2.5 | 单写者 ledger、限额、备份和只读副本适合试点；生产规模需要数据库、对象存储和队列 |
| 生态与可扩展性 | 2.5 | runner/BoardAgent/事件接口可替换；第三方集成、社区数据和插件市场尚少 |
| 运营与可观测性 | 3.5 | 健康检查、结构化日志、指标、审计、备份演练已具备；跨地域告警和 SLO 仍需接入组织平台 |

因此当前最准确的产品级结论是：**软件控制面已达到可做内部生产试点和受控硬件集成 Beta 的成熟度；整体产品还不能宣称“通用机器人云平台”或“自动 OTA 生产系统”。** 当前 X5 证据覆盖真实板端接入、BPU 模型加载/前向和受限安全运动，但还没有证明真实策略输出驱动任务成功；后一句边界由策略驱动的真机证据、硬件签名、车队/OTA、生产数据库和现场回滚证据决定。

## 统一产品主线

```text
项目 → 机器人/任务 → 契约 → 数据或仿真 → 训练 Run → Artifact → 评测 → Preflight → Canary/Live → 回滚
```

高级能力（Mock、GPU、RoboGo、BoardAgent、MCP）属于执行方式或适配器，不应成为用户理解产品的前置知识。

## 统一资源模型

- `Project`：权限、成员、配额和默认设备的边界。
- `RobotProfile`：设备能力、传感器、执行器、板型和控制频率。
- `Task`：任务目标、奖励/成功标准、数据要求和评测基线。
- `Dataset`：版本、来源、样本统计、校验和、契约和保留策略。
- `Run`：训练执行、状态、日志、指标、检查点和资源消耗。
- `Artifact`：不可变、可签名、绑定契约/数据/Run/评测的模型制品。
- `Evaluation`：固定基线、指标、环境、设备和结论。
- `Deployment`：目标设备、预检、Canary、Live、回滚和审计事件。

## 统一状态语言

所有页面使用同一组状态：

`available`（可用）、`ready`（可执行）、`running`（执行中）、`blocked`（被阻断）、`mock`（模拟）、`degraded`（受限）、`failed`（失败）、`succeeded`（成功）、`reversible`（可回滚）。

阻断状态必须说明：原因、影响、所需动作和责任方；不能只显示灰色按钮或泛化错误。

## 分阶段交付

### P0：产品收敛

- 首页只展示一条默认主线。
- 所有能力显示真实/模拟/受限/待接入标签。
- 统一空态、加载态、错误态、重试和阻断文案。
- 项目、机器人、任务和 Run 在全局上下文中可见。
- 首次使用提供一条 10 分钟内可完成的本地验证路径。

### P1：可信研发闭环

- Dataset、Run、Artifact、Evaluation、Deployment 建立显式血缘。
- Artifact 发布后不可原地修改，部署引用固定版本，支持撤销。
- Run 支持取消、恢复、重试、幂等提交和失败分类。
- 评测绑定固定基线、随机种子、设备、固件和运行会话。

### P2：单机硬件 Beta

- 一个真实任务、一个 X5、一个策略完成真实数据回流。
- Board Agent 支持有界缓存、序号、断网补传和服务端 ACK。
- Preflight → Canary → Live → Rollback 状态机可复核。
- 签名制品、目标板兼容性和急停联锁完成验收。

### P3：多人生产化

- PostgreSQL 行级隔离、对象存储和分布式任务队列。
- Project/Membership/RBAC、租户配额和费用边界。
- 多设备注册、心跳、能力 Passport、审计和备份恢复。
- 训练、制品、遥测和发布的指标、告警、追踪和数据保留策略。

## 发布门禁

只有同时满足以下条件，版本才可对外标为生产可用：

1. 默认路径在干净环境完成一次真实可复核 Run；
2. 所有模拟结果显式带 `mock=true`，且不会进入真实部署状态；
3. 制品有契约、来源 Run、数据集、评测和 SHA-256；
4. 部署具备 preflight、Canary、急停和回滚证据；
5. 多用户数据隔离、限流、审计、备份恢复测试通过；
6. 用户能从错误页面得到明确修复动作；
7. 关键路径有自动化冒烟和人工演示脚本。

## 成熟度目标

| 领域 | 目标 |
|---|---|
| 首次使用 | 10 分钟完成首个可验证 Run |
| 可靠性 | 关键 API 幂等，失败可重试，状态不丢失 |
| 可追溯性 | Run → Artifact → Evaluation → Deployment 全链可回放 |
| 安全 | 默认只读，多重运动闸门，急停恒可用 |
| 生产性 | 多租户、对象存储、队列、监控、备份恢复 |
| 真实性 | 真实、模拟、受限能力在 UI/API/文档中一致标注 |
