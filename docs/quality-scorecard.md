# 9+ 质量门槛

这份评分卡把“9 分”定义成可复核的工程证据，而不是演示页面上的主观印象。

## 已落地的自动门禁

- **安全与诚实设计（9+）**：驱动双开关、看门狗、mock 标识、遥测新鲜度、回滚路径和服务端 release-evidence gate 均 fail-closed。`preflight` 只读；`canary/live` 必须绑定同一模型的已完成真实 runner、可部署 artifact、SHA-256，以及 Task-Pack 的置信区间门禁。
- **工程护栏（9+）**：`npm test` 覆盖服务端、策略运行时、适配器、训练 worker 和真实 DOM 行为；`npm run verify` 贯穿任务包解析、API 合约、硬件 profile、板端 agent、策略安全和本地 Sim2Real smoke。
- **RL 训练（9+ 的软件门槛）**：训练请求由声明式 task-pack + adapter 合并生成；评估固定 nominal/hard envelope、seed、最小样本量和 CI lower-bound；发布前还必须证明训练策略优于 seeded baseline。评估报告中的 PASS 字段不会被直接信任，服务端会重新计算门槛。
- **硬件抽象（9+ 的软件门槛）**：adapter/profile 使用统一 schema，校验 topic、消息类型、控制频率、动作/观测维度、限幅、watchdog 和 provenance；脚手架默认生成 mock，并拒绝覆盖已有 manifest。
- **产品与文档（9+ 的可用性门槛）**：首屏信息架构、命令面板、训练/评估/发布路径和 agent chat 均有行为回归；文档把 preflight、canary、live 和证据要求写成可执行 runbook。
- **证据链可见性（软件门槛）**：板端策略会话的生命周期（起止/推理统计/停止原因/模型指纹）以结构化事件随遥测上板，聚合进 run 详情"上板会话"卡（`GET /runs/:id/board-sessions`）；事件样本与控制数据严格分流（混载即 400 拒绝），不进回放统计与重训建议；演示前一键预检 `demo:preflight` 只读、逐项 ✓/✗、`verify:demo-preflight` 自测守护"永不发 POST"。
- **工程护栏（9+）**：ESLint（error 级为真实缺陷规则，零违规）与 Prettier/EditorConfig 进 CI；Node 22/24 矩阵（Node 20 已退役：DSH 会话持久化依赖 `node:zlib` 的 zstd API）；Node 22 CI 使用 Vitest 5 运行 `test:coverage`，执行 lines 71、statements 68、functions 74、branches 61 的下限（阈值按当前工具链下的实测基线校正：lines 76.55、statements 72.89、functions 78.19、branches 66.47）；同一门禁执行全依赖 moderate 审计、生产依赖 high 审计和高置信公开面秘密扫描；Dependabot 覆盖 npm / GitHub Actions / pip。
- **前端注入门禁（9+）**：`verify:escape-audit` 扫描 `public/*.js` 里 `innerHTML`/`outerHTML` 的模板插值，未转义即失败；豁免必须写带理由的 `// escape-audit:allow`，且写在模板字面量文本里的"注释"不被承认。
- **运行加固（9+ 的软件门槛）**：自家页面严格 CSP（`script-src 'self'`，仅第三方 WASM 所在 `/mujoco` 放宽）、可选 HSTS、进程内限流 429、字段白名单结构化日志、Prometheus `/metrics`（标签归一化且有基数上限）；配置与取舍见 [`operations.md`](operations.md)。
- **制品生命周期（软件门槛）**：`npm run verify:artifact-registry` 会在临时隔离目录中验证 HMAC 签名、内容 SHA-256、不可变版本和原子回滚指针；它是 CI 可重复的 registry rehearsal，不替代生产对象存储或现场回滚演练。

## 仍需现场证据才能宣称“整体 9+”

代码可以把不合格发布挡在门外，但不能伪造硬件事实。最终总分还需要在真实设备上补齐：

1. X5 上由策略实际驱动的安全运动记录（含急停、watchdog、回滚和原始遥测）；
2. 第二种实体机器人完成同一任务模板的独立验证；
3. artifact registry 的签名、不可变存储和跨版本回滚演练。

在这些证据归档前，平台应标记为“软件门槛 9+、整体评分待现场验收”，而不是把仿真或 mock 结果当成真机成功。

2026-09-11 已归档一台真实 RDK X5 + OriginBot 的只读预检和低速 canary（含 watchdog 到期、急停归零），见 [`evidence/x5-originbot-canary-2026-09-11.json`](evidence/x5-originbot-canary-2026-09-11.json)；并用真实 X5 上的 BPU 字节完成摘要校验与本地签名/回滚 rehearsal，见 [`evidence/artifact-registry-rehearsal-2026-09-11.json`](evidence/artifact-registry-rehearsal-2026-09-11.json)。第二种实体机型与生产 registry 回滚仍待补证。

## 验收命令

```bash
npm test
npm run verify
npm run verify:api-contract
```
