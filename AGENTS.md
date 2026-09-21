# RDK Robot Learning Platform — 研发 Agent 入口

> 目标：第一次进入仓库的开发者或 coding agent，90 秒内回答四个问题：这是
> 什么产品、改动归谁、从哪里开始读、怎样证明完成。

## 项目身份

RDK Robot Learning Platform（`@d-robotics/robot-learning-platform`）是面向
D-Robotics RDK 设备（X5 / S600 等）× MicroDuck 机器人的学习工作台：浏览器仿真
与轨迹录制、强化学习训练（多引擎）、Sim2Real 评测、制品签发与受控部署反馈。
同一套服务同时服务本地 standalone 部署与 Studio 集成；工作台 UI 是
`services/sim2real-web/public/`（无框架原生 JS，8 视图 + 11 流程子项）。

真实主链路：

```text
浏览器工作台 (sim2real-web/public)
  → sim2real-web/server.ts (standalone, 默认 127.0.0.1:18102)
     → server/routes/sim2real-routes.ts → server/sim2real/* (ledger/评测/部署)
     → engines/* (microduck-rl / offline-bc / act / diffusion-policy / smolvla …)
     → local-training-worker.mjs / mock-local-worker.mjs (训练执行)
     → local-board-agent.mjs (X5 板端; 代码 /opt/rdk-board-agent, 策略 /root/rdk-board-agent/policies)
```

## 文档所有权与阅读顺序

本文件只做稳定导航，不复制易漂移的测试数量、行数或瞬时状态。

| 你要回答的问题 | 先读什么 |
| --- | --- |
| 怎么安装、启动、体验 | [`README.md`](./README.md)、[`docs/first-run.md`](./docs/first-run.md)、[`docs/demo-runbook.md`](./docs/demo-runbook.md) |
| 生产部署、探针、备份、恢复 | [`docs/production-operations.md`](./docs/production-operations.md)、[`docs/operations.md`](./docs/operations.md) |
| 公开发布还差什么 | [`docs/release-checklist.md`](./docs/release-checklist.md)、[`docs/quality-scorecard.md`](./docs/quality-scorecard.md) |
| 工作台 UI 规则与门禁 | `services/sim2real-web/ui-layout-invariants.mjs`（唯一真源）、`ui-ia.spec.mjs`、[`docs/ui-screen-reader-checklist.md`](./docs/ui-screen-reader-checklist.md) |
| 引擎与训练 | [`docs/task-pack-training.md`](./docs/task-pack-training.md)、[`docs/engine-evidence-2026-09-20.md`](./docs/engine-evidence-2026-09-20.md)、[`docs/gpu-runner.md`](./docs/gpu-runner.md) |
| 板端与硬件 | [`docs/host-station.md`](./docs/host-station.md)、[`docs/arm-drive.md`](./docs/arm-drive.md)、[`docs/hardware-adapters.md`](./docs/hardware-adapters.md)、[`docs/actuator-drive.md`](./docs/actuator-drive.md) |
| 数据与可追溯 | [`docs/lineage.md`](./docs/lineage.md)、[`docs/dataset-lineage.md`](./docs/dataset-lineage.md) |
| 路线与研究 | [`docs/roadmap.md`](./docs/roadmap.md)、[`docs/research/`](./docs/research) |

冲突处理：源码/测试/门禁脚本决定当前事实，`docs/` 提供背景与运维路径；本文件
只负责导航，不承载会过期的细节。

## 第一次进入仓库

```bash
npm ci                      # lockfile 安装
npm run verify:ui           # 毫秒级静态 UI 门禁（改 UI 前后必跑）
npm run dev:sim2real        # 起本地 standalone 服务（127.0.0.1:18102）
npm test                    # vitest 行为套件
npm run verify              # 完整门禁链（很重，发布前跑）
```

不要把"命令启动过"当成通过；以 exit code、门禁输出和真实行为为准。

## 先判断变更归属

| 变化属于什么 | Owner / 首个入口 | 不应放在哪里 |
| --- | --- | --- |
| 工作台 UI / 视图 / 导航 | `services/sim2real-web/public/{index.html,app.js,app.css,tokens.css}` | 服务端路由内联样式 |
| 颜色 / 字号 / 断点 | `public/tokens.css`（唯一真源） | app.css 里的字面量（棘轮归零，新增即红） |
| UI 门禁 / 棘轮预算 | `services/sim2real-web/ui-layout-invariants.mjs` 及各 `ui-*.spec.mjs` | 绕过门禁直接改样式 |
| HTTP 接口 / 台账 | `server/routes/sim2real-routes.ts`、`server/sim2real/` | 前端直连存储 |
| 训练引擎 | `engines/<engine>/` + `scripts/verify-<engine>.mjs` | 工作台前端硬编码引擎逻辑 |
| 板端 agent | `services/sim2real-web/local-board-agent.mjs` | 工作台直接驱动电机 |
| 文档 | `docs/`（本文件只导航） | 把易变状态写进导航文件 |

## 不可破坏边界

- **UI 门禁是棘轮制**：hex 字面量、font-size 字面量、断点值白名单、跨层选择器、
  11 个样式层、z-index 阶梯——预算只许收紧。当前基线以
  `ui-layout-invariants.mjs` 内注释为准，动 IA（视图/导航结构）必须同一提交更新
  `ui-ia.spec.mjs` 断言。
- **tokens.css 是唯一调色板**：新颜色进 token，不写字面量；主题相关值走
  `:root` / `html.theme-dark` 双区。引用前先全仓 grep 该名字是否为
  "已引用但未定义"的历史 token（静默回退会骗过所有人）。
- **存储目录隔离**：起第二个服务实例必须给独立的 `RDK_SIM2REAL_STORAGE_DIR`；
  train-journey 等浏览器 sweep 每次运行都会写账本，账本必须逐次重建。
- **并发会话**：本仓库常有多个 coding session 同时工作。别人的 WIP 不清理、
  不覆盖、不混入自己的提交；同文件交错时用 `git apply --cached` 分块。
- 凭据、个人路径、设备地址和本机权限状态不进入共享文档或提交。

## 外部知识策略（RDK / 地瓜官方事实）

- **官方文档优先**：RDK X3/X5/S100/S600、TROS、Model Zoo、OE 工具链、XBurn、
  烧录、量化等问题，用 `rdk-docs` 技能查询 developer.d-robotics.cc 官方文档；
  论坛帖子只作补充佐证。
- **联网搜索兜底**：官方文档覆盖不到的（新品公告、生态动态、第三方库版本），
  用 WebSearch 并在结论里附来源链接。
- **不硬编码易漂移的外部事实**（板卡算力、系统版本、上游 commit）进本仓库文档；
  写清"查询方式"而不是"查询结果"。
- 本机网络故障（403 / Unexpected server response / CONNECT denied）先怀疑
  Squid 代理白名单，按 `squid-proxy-403-fix` 技能排障。

## 从需求到交付

1. 写清用户结果、非目标、失败/空/取消状态；确认 owner 与相邻实现。
2. 先跑最窄门禁（改 UI → `verify:ui`；改引擎 → 对应 `verify:<engine>`）。
3. bug/安全修复先构造修复前会失败的反例；UI 改动在真实浏览器里走一遍主路径。
4. 报告已运行、未运行和残余风险；结论必须绑定证据，不注水。
5. 检查 `git status`：保留无关 WIP，不顺手清理别人的工作区。

## 当前事实从哪里读

- 命令与依赖：`package.json` / lockfile。
- UI 门禁基线：`ui-layout-invariants.mjs` 运行输出（每次跑都打印实测值/预算）。
- 服务健康：`/healthz`、`/readyz`（standalone 默认 127.0.0.1:18102）。
- 当前工作：issue / spec / PR / 会话记忆；本文件不保存"下一步"清单。
- 验证结论：本次命令输出与 CI run；不引用旧 session 日志。
