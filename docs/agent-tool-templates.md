# Agent 工具扩展模板（以 rdk_docs_* 为范例）

> 新增平台 Agent 工具的最短安全路径。每一步都有对应的活例子：外部知识源四工具 +
> `rdk_web_search`（提交 `951ce77` / `48cbc35` / `78a2f0d`）。改完本文件提到的每个面，
> 对应测试必须同步——模板本身在 `docs/decisions/D-003` 有架构依据。

## 需求 → 机制对照

| 需求 | 机制 | 落点 | 最窄验证 |
| --- | --- | --- | --- |
| 查平台台账/状态 | `rdk_*` handler（loopback fetch） | `dsh-capability-handlers.ts` | `dsh-capability-handlers.test.ts` |
| 查外部官方资料 | 包纯函数直调（D-003） | 同上 + package.json 依赖 | 同上 + 域名负例 |
| 全网检索 | 注入式搜索函数 | 同上 | 同上 + 失败映射负例 |
| 执行有副作用的平台动作 | RW handler（自动走平台审批门控） | 同上 | 审批/拒绝负例 |

**一个能力只选一个机制**；不要让同一行为同时经 handler、外部脚本和私有回调执行。

## 新工具最小集合（五件套，缺一不算完成）

以 `rdk_docs_page` 为例：

1. **names 清单登记**（`dsh-capability-tools.ts`）：`[id, 中文描述, readOnly]`。
   目录卡片、capabilityBriefing 工具数、模型侧 tool schema 全部由此自动联动；
   「binds every catalog entry」测试强制每个条目必须有 handler。
2. **handler 实现**（`createDshCapabilityHandlers`）：
   - 参数经 `argsRecord`/`requiredArg`/`argText` 规整；缺参报
     `DSH_CAPABILITY_REJECTED`；
   - **上游失败映射为稳定错误码**（`callDocs`/`fail` 模式），绝不泄漏传输细节；
   - 外呼必须固定域名或白名单（`assertDocsUrl` 模式）+ 超时 + 有界返回——
     模型传进来的 URL/参数永远不能变成任意抓取原语。
3. **可注入测试缝**：外部依赖走 `options.docsService` / `options.webSearch` /
   `options.fetchImpl` 注入，测试用 stub，不真连网。
4. **纪律进 briefing**：涉及信息可靠性的工具在 `capabilityBriefing` 加对应条目
   （未核对声明 / 非官方标注），由「工具是否绑定」条件触发。
5. **测试四件**：正例映射、缺参拒绝、上游失败映射、攻击负例（越权域名/参数改写）。

## 纪律红线（来自 D-003/D-004）

- 固定域名 + 白名单 + 有界返回：模型传入的 URL/参数永远不能变成任意网络原语。
- 检索失败/未命中 → 告知「未核对」，不伪装；web 结果 → 标注「非官方」。
- 上游错误不泄漏传输细节（status/reason 收敛为稳定码 + 操作员可读中文）。
- 只读工具禁止带副作用；副作用动作必须让平台审批门控拦截在真实执行前。

## 最小 PR 集合

- 一个 handler 实现（含注入缝）+ names 登记；
- 一个测试文件追加（正例/拒绝/失败映射/攻击负例）；
- 若引入新依赖：package.json 精确锁版本 + 本条模板的对照说明；
- 若涉及决策约束：同步更新 `docs/decisions/` 对应 ADR。
