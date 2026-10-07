# 产品成熟度评分卡（2026-10）

这份评分卡回答一个问题：平台现在离“能稳定交付给真实机器人团队”还有多远。分数只基于仓库里的实现、门禁和已归档现场证据；仿真、mock、dry-run 和“已接入接口”不会被当成真机成功。

## 当前结论

**综合评分：87.5/100，四舍五入为 8.7/10。**

| 维度 | 得分 | 判断 |
| --- | ---: | --- |
| 核心闭环与产品价值 | 18/20 | Run → Artifact → Eval → Deploy → Board feedback 已形成可追溯主链路；任务级真机到达仍需补齐。 |
| 安全与可信交付 | 14.5/15 | 双开关、watchdog、急停、租约、fail-closed 和 mock/real 标识齐全。 |
| 工程质量与可验证性 | 14/15 | 服务端、DOM、MCP、Golden Path 和 UI 门禁完整；发布前仍需固定 build → API contract 顺序。 |
| 训练算法与引擎广度 | 13.5/15 | PPO/SAC、BC、ACT、Diffusion Policy、SmolVLA、MJX、dm-control、视觉观测等路径已接入；不是每条路径都具备现场上板证据。 |
| 数据、证据与可追溯 | 12.5/15 | lineage、board session、replay、correlation、审计和失败路径较完整；长期不可变对象存储和第二实体机型仍缺。 |
| 现场交付成熟度 | 7.5/10 | 已有 X5 策略驱动运动、51 次推理、0.096 m 弧线和急停证据；goalnav 到达、BPU 实测、视觉上板、坏模型回退和生产 rollback 未闭环。 |
| 运营与规模化 | 7.5/10 | 预检、metrics、RBAC、审计和限流可用；多副本存储、配额、SIEM 和长期保留策略仍需部署方落地。 |

软件控制面可评 **9.1–9.3/10**；把真实设备、生产制品、回滚和运营规模一起算入，当前应按 **8.2–8.6/10** 管理。仓库自身的质量门槛也明确要求在宣称“整体 9+”前补齐 X5 运动记录、第二种实体机器人和生产 registry 回滚证据，见 quality-scorecard.md。

## 已经验证的能力

本轮复核通过：

- npm run verify:ui：8 个视图、8 个侧栏入口、15 个 tab/panel、7 个 guard。
- npm run verify:golden-path：3/3。
- npm run verify:mcp：26/26。
- npm run build 后 npm run verify:api-contract：126 个 OpenAPI operation 与 124 个已挂载路由匹配，legacy alias 校验通过。
- 图文产品手册的 Markdown/HTML、截图资产和链接均已校验；HTML 可在浏览器直接打开。

完整行为套件的基线记录为 81 个文件、933 个测试通过；发布前仍应在目标 Node 版本和干净依赖环境重新执行 npm test 与 npm run verify。API contract 必须先 build；直接运行会因为 dist-server 旧于源码而失败。

2026-10-07 已在当前工作树完成一次完整发布门禁：

- npm run verify 全链路通过，包含 UI、任务包、奖励/布局契约、OriginBot、离线 BC、ACT、Diffusion Policy、SmolVLA、录制、部署、安全、生产配置、备份、MCP、板端安全、制品 registry、视觉输入、MJX/dm-control/mjlab、MicroDuck 评测、API contract、standalone smoke 和 npm test。
- engine lock 已由 npm run lock:engines 刷新，npm run verify:engine-locks 和 npm run verify:preflight 均通过。
- MicroDuck live rollout、部分训练 provenance 和 GPU/板端项目仍按脚本输出标为 SKIP；这些状态是环境事实，不计入软件 PASS。

## 最值得做的优化

这些动作按“对综合评分的提升 / 对现有代码的扰动”排序。验收证据要进入 docs/evidence/，并在发布清单勾选，不能只写“已测试”。

### P0：把 8.7 推到 9.0 的现场与制品闭环

| 动作 | 负责入口 | 完成判据 |
| --- | --- | --- |
| 第二种实体机器人独立验证 | field-evidence-runbook.md、硬件 adapter | 与 X5/OriginBot 使用同一任务模板；保存 preflight、canary、急停、watchdog、原始遥测和 release-evidence。 |
| 生产 artifact registry + rollback | production-operations.md、部署方对象存储 | v1/v2 均有签名与摘要；对象不可变；设备按具体版本拉取；v2 启动后回滚到 v1；审计事件和设备启动版本可复核。 |
| 42D goalnav 任务到达验收 | goalnav-task-acceptance-runbook.md | 真机到达阈值、超时、急停、失败原因和原始轨迹归档；“策略在动”与“任务完成”分开计分。 |

### P1：补齐性能和失败路径证据

| 动作 | 负责入口 | 完成判据 |
| --- | --- | --- |
| BPU provider 实测 | docs/roadmap.md、板端 agent | 同一模型完成量化编译；记录 CPU/BPU 延迟、吞吐、内存和版本；无 provider 时保持拒载，不能静默降级。 |
| 坏模型拒载与自动回退演练 | release-checklist.md、artifact/deploy API | 摘要、签名、schema 或运行时健康任一失败均拒载；回退到上一版本；设备和审计日志可证明最终运行版本。 |
| 视觉观测上板 | engines/visual-ppo.md、相机 adapter | 保存相机帧时间戳、推理输入摘要、丢帧行为和端到端动作证据；训练侧 ONNX 等价不能代替板端输入证据。 |

### P2：让团队规模化使用

| 动作 | 负责入口 | 完成判据 |
| --- | --- | --- |
| 首次运行向导 | services/sim2real-web/public/ | 新用户从健康检查到 Golden Path 首次 run 不需要读源码；每个失败状态提供下一步命令或链接。 |
| 研究反馈闭环看板 | GET /api/v1/duck/research-loop/summary 与 workspace UI | 展示训练/评测 p50/p90、agent 占比、approval-free chain、边际收益和队列阻塞；只作为运营观测，不作为发布门。 |
| 多副本与长周期运维 | scalability.md、operations.md | 外部数据库/对象存储、租约一致性、备份恢复、保留策略、配额和 SIEM 接入均有演练记录。 |

## 产品使用的最佳实践

1. **先读 Golden Path，再读引擎。** 先用只读状态确认 task、dataset、training、evaluation、artifact 和 board feedback 哪一段阻塞，再进入具体引擎。
2. **所有真机动作都经过 preflight → canary → live。** 预检失败时停止；canary 绑定同一模型、同一 artifact 摘要和时间盒；急停与 watchdog 必须在 live 前验证。
3. **把“接入”与“证据”分开。** 有路由、provider 或 adapter 只代表软件路径存在；只有原始遥测、模型指纹、设备状态和回放能证明现场行为。
4. **所有发布使用具体 artifact 版本。** 禁止 latest；记录 schema、摘要、签名、制品来源、部署目标和回滚指针。
5. **失败也要入账。** blocked、rejected、timeout、mock、degraded 和 rollback 都是 lineage 的一部分，不能用成功率覆盖失败原因。
6. **MCP 先读后写。** 先调用 overview、Golden Path、lineage、preflight 和 status；写操作携带幂等键；涉及真实运动时保留人工门和独立急停。
7. **研究指标只做反馈，不做放行。** 研究闭环摘要帮助发现排队、延迟和边际收益问题；release gate 仍以 task-pack、artifact、设备和现场证据为准。

## 一步到位后的验收顺序

    npm ci
    npm run build
    npm run verify:ui
    npm run verify:golden-path
    npm run verify:mcp
    npm run verify:api-contract
    npm test
    npm run verify

现场发布还要追加：

    npm run demo:preflight
    npm run verify:artifact-registry
    # 按 field-evidence-runbook.md 执行第二机型与生产 registry rollback

分数只有在 P0 的三类证据全部归档后才上调到整体 9+。在此之前，最准确的对外说法是：**软件控制面已具备内部生产试点和受控硬件 Beta 的成熟度；整体产品正在完成多机型、生产制品和长期运营验收。**
