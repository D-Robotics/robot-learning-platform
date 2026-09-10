# 9+ 质量门槛

这份评分卡把“9 分”定义成可复核的工程证据，而不是演示页面上的主观印象。

## 已落地的自动门禁

- **安全与诚实设计（9+）**：驱动双开关、看门狗、mock 标识、遥测新鲜度、回滚路径和服务端 release-evidence gate 均 fail-closed。`preflight` 只读；`canary/live` 必须绑定同一模型的已完成真实 runner、可部署 artifact、SHA-256，以及 Task-Pack 的置信区间门禁。
- **工程护栏（9+）**：`npm test` 覆盖服务端、策略运行时、适配器、训练 worker 和真实 DOM 行为；`npm run verify` 贯穿任务包解析、API 合约、硬件 profile、板端 agent、策略安全和本地 Sim2Real smoke。
- **RL 训练（9+ 的软件门槛）**：训练请求由声明式 task-pack + adapter 合并生成；评估固定 nominal/hard envelope、seed、最小样本量和 CI lower-bound；发布前还必须证明训练策略优于 seeded baseline。评估报告中的 PASS 字段不会被直接信任，服务端会重新计算门槛。
- **硬件抽象（9+ 的软件门槛）**：adapter/profile 使用统一 schema，校验 topic、消息类型、控制频率、动作/观测维度、限幅、watchdog 和 provenance；脚手架默认生成 mock，并拒绝覆盖已有 manifest。
- **产品与文档（9+ 的可用性门槛）**：首屏信息架构、命令面板、训练/评估/发布路径和 agent chat 均有行为回归；文档把 preflight、canary、live 和证据要求写成可执行 runbook。
- **工程护栏（9+）**：ESLint（error 级为真实缺陷规则，零违规）与 Prettier/EditorConfig 进 CI；Node 20/22/24 矩阵；`test:coverage` 带 lines/statements 66、functions 79、branches 61 的下限；Dependabot 覆盖 npm / GitHub Actions / pip。
- **前端注入门禁（9+）**：`verify:escape-audit` 扫描 `public/*.js` 里 `innerHTML`/`outerHTML` 的模板插值，未转义即失败；豁免必须写带理由的 `// escape-audit:allow`，且写在模板字面量文本里的"注释"不被承认。
- **运行加固（9+ 的软件门槛）**：自家页面严格 CSP（`script-src 'self'`，仅第三方 WASM 所在 `/mujoco` 放宽）、可选 HSTS、进程内限流 429、字段白名单结构化日志、Prometheus `/metrics`（标签归一化且有基数上限）；配置与取舍见 [`operations.md`](operations.md)。

## 仍需现场证据才能宣称“整体 9+”

代码可以把不合格发布挡在门外，但不能伪造硬件事实。最终总分还需要在真实设备上补齐：

1. X5 上由策略实际驱动的安全运动记录（含急停、watchdog、回滚和原始遥测）；
2. 第二种实体机器人完成同一任务模板的独立验证；
3. artifact registry 的签名、不可变存储和跨版本回滚演练。

在这些证据归档前，平台应标记为“软件门槛 9+、整体评分待现场验收”，而不是把仿真或 mock 结果当成真机成功。

## 验收命令

```bash
npm test
npm run verify
npm run verify:api-contract
```

