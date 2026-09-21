# 决策日志（Decision Log）

本目录登记学习平台仓库里**未来 agent 与开发者必须继承的设计决策**——那些「看起来可以重构、
但当年踩过坑才这么定」的选择。格式沿用 RDK Studio 的 ADR 实践（rdstudio-web-master
`docs/decisions/`）。

## 规则

- 改动命中某条决策约束的面时，先读对应决策；要推翻决策，先改这里的记录并说明新证据，
  不要在代码里悄悄反转历史决策。
- 每条决策独立成文件 `D-XXX-<slug>.md`，至少记录：状态、日期、背景与约束、决策、
  被否决方案、后果与边界、失效/重审条件、守卫。暂时未知的字段写 `待补证据`，不能省略。
- 决策被代码侧守卫机械化时（门禁/测试项），在条目里登记守卫名——**决策 + 守卫一体才算闭环**。
- 已失效的决策不删除，改标 `Status: 已废止` 并写明替代决策，保留推理链。

## 索引

| ID | 决策 | 守卫 |
| --- | --- | --- |
| [D-001](./D-001-css-ratchet-token-single-source.md) | tokens.css 唯一调色板 + app.css 棘轮只紧不松 | ui-layout-invariants.mjs / verify:ui |
| [D-002](./D-002-flow-child-subinterface-states.md) | 侧边栏流程子项是真实子界面状态，不是同页滚动 | ui-ia.spec.mjs / ui-behavior.test.ts |
| [D-003](./D-003-agent-knowledge-sources.md) | Agent 外部知识 = rdk-docs-mcp 纯函数直调 + 免费 Bing 全网搜索 + D-008 式未核对纪律 | dsh-capability-handlers.test.ts |
| [D-004](./D-004-device-connection-server-mediated.md) | 设备连接 = 服务端中介 SSH + 板端 BoardAgent HTTP 契约，浏览器零直连 | server-wiring.spec.mjs / sim2real-routes.test.ts |
| [D-005](./D-005-service-ops-selfhealing.md) | 常驻服务以 nohup 脱离会话运行 + cron 看门狗自愈 | （仓外守卫：Qoder cron 看门狗任务） |
