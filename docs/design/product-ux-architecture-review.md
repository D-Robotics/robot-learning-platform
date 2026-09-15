# 产品体验与架构审查基线

## 最短路径

每个任务都必须有一个默认主路径：选择目标 → 系统准备 → 执行 → 结果 → 下一步。高级配置折叠，阻断原因就地显示，重试保留已填内容。GPU 连接优先自动发现本机 Agent；远端连接由 Agent 建立 SSH 隧道。

## 模块边界

前端按 `overview / simulator / training / evaluation / artifacts / devices / deployments` 拆分视图模块；模块只能通过状态选择器和领域命令通信，不直接读写另一个模块的 DOM。服务端继续以 `Port/Adapter` 为边界：训练、制品、存储、设备、身份和通知分别替换。

## 插件协议

资源插件统一提供 `discover → connect → health → execute → observe → disconnect`。GPU、本机 Agent、远端 SSH、RoboGo、BoardAgent 都实现同一协议；平台只依赖能力清单，不依赖具体厂商字段。

## GPU 连接边界（硬规则）

`source=local-agent` 的资源由浏览器直接调用用户电脑上的 Agent。核心服务器只保存资源名称、能力摘要、运行引用和用户主动同步的结果，不能对该资源发起 health、train、status 或 artifact 请求。`source=server-runner` 才允许服务端调用 runner。两种资源在 UI 中必须明确标记，不能用同一个“在线”状态造成误解。

本地 Agent 负责把用户目标转换为 Worker 请求，并以幂等键保存本地 job；网页刷新后先向 Agent 查询 job，再与平台台账对齐。Agent 不在线时显示“需要启动本机 Agent”，不得显示为“训练失败”。

## 体验验收

- 首次用户在 3 步内完成一次 smoke run；
- 每个阻断状态都有原因、修复动作和重新检查按钮；
- 运行中可见进度、预计剩余时间、日志入口和取消入口；
- 结果页直接提供评测、下载、复用和发布下一步；
- 断线恢复后不重复提交，页面恢复到最后已知状态；
- 所有危险动作都有清晰的影响说明和可追溯结果。

## 整体优化执行顺序

### P0：先保证目标能最短完成

1. 首次进入：自动识别登录、MicroDuck、Local Agent 和已有运行；首页只给一个推荐动作。
2. GPU：页面自动发现本机 Agent；本机资源浏览器直连；远端资源由 Agent 建立 SSH；资源卡片显示来源、延迟、显存、队列和最近错误。
3. 训练：选择任务后自动带出契约、推荐引擎、profile 和评测门槛；提交前只确认会产生费用或会占用设备的事项。
4. 运行：统一时间线显示排队、启动、迭代、制品、评测和失败；刷新/断线自动恢复，不重复提交。
5. 结果：成功后直接提供“评测 → 下载 → 复用参数 → 生成部署计划”四个动作。

### P1：再建立可扩展结构

- 前端每个领域只暴露 `state / selectors / commands / view`，禁止跨模块操作 DOM；
- 服务端以 `TrainingPort`、`ArtifactPort`、`ComputePort`、`TelemetryPort`、`DeploymentPort` 隔离外部系统；
- 插件只通过版本化 capability manifest 注册，不允许插件直接访问 ledger、认证或 Express app；
- 所有状态事件使用统一 envelope：`eventId / aggregate / version / occurredAt / actor / payload`；
- 本地 Agent、云 Runner 和 BoardAgent 共用同一份任务、状态和制品协议。

### P2：最后做专业能力和视觉打磨

- 运行对比、指标曲线、轨迹回放、失败案例和资源利用率统一进入详情页；
- 表单改为分步确认和智能默认值；
- 空状态、错误状态、权限状态和离线状态全部提供可执行下一步；
- 颜色只表达状态，重要操作使用一致的主按钮、次按钮和危险按钮层级；
- 所有页面以键盘、窄屏和高对比度模式验收。

## 当前必须避免的反模式

- 服务器代替用户连接用户 GPU；
- Mock completed 使用与真实训练相同的视觉语义；
- 一个资源同时显示多个来源和多个健康结论；
- 用技术字段代替用户能理解的下一步；
- 为了“看起来高级”增加默认必填项、弹窗和重复确认；
- 新插件直接 import 具体 runner、数据库或前端全局状态。
