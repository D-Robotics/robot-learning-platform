# D-003 · Agent 外部知识源 = rdk-docs-mcp 直调 + 免费全网搜索 + 未核对纪律

- **Status**: Accepted
- **Date**: 2026-09-21
- **背景与约束**: 平台 Agent（DSH runtime）原有 50 个工具全部是平台状态类（台账/评测/部署/板端），
  外部知识为零——回答 RDK 领域问题全靠模型内部记忆，无法核证。架构参照 Studio ADR D-008
  （官方知识只走 bundled rdk-docs-mcp、检索失败必须声明未核对）。

## 决策

Agent 外部知识由 5 个只读工具构成（`server/agent-runtime/dsh-capability-handlers.ts`）：

- `rdk_docs_search` / `rdk_docs_manuals` / `rdk_docs_toc` / `rdk_docs_page`：
  **lockfile 锁定的 `rdk-docs-mcp` 包纯函数直调**（`searchDocs`/`listManuals`/`listToc`/
  `getPage` + 其自带磁盘缓存的 `fetchText`），不引入 MCP 协议/客户端 SDK。
  `rdk_docs_page` 仅允许 developer.d-robotics.cc / forum.d-robotics.cc 两个域名（防 SSRF）。
- `rdk_web_search`：免费全网搜索（cn.bing.com HTML 通道，无 key），返回有界
  title/url/snippet 三元组，进程内节流 + 10 分钟 LRU 查询缓存。

**纪律（进 capabilityBriefing，模型必读）**：检索失败/超时/未命中必须告知用户
「官方资料未核对」，不得用内部记忆伪装已查证结论；web 结果必须标注「非官方结论」；
引用附来源链接；官方文档优先于社区经验帖。

## 被否决方案

- 手写 Discourse 原始 API 检索（首版实现）：只能覆盖论坛、排序质量差——被
  rdk-docs-mcp 的 `searchDocs` 排序（official-start/related/forum-supplement）取代。
- MCP 协议适配器（Studio 的 StreamableHTTP + MCP Client 模式）：多一层传输与依赖，
  纯函数直调同质量且零新协议面。
- DuckDuckGo 免费搜索：大陆网络 DNS 污染不可用（实测解析至 Facebook 段 IP）。
- 付费搜索 API：免费方案已满足当前需求，作为质量升级的预留路径（`options.webSearch`
  注入点已就位，替换一个函数即可）。

## 后果与边界

- 上游传输错误必须映射为稳定能力错误码（`DSH_CAPABILITY_FAILED` 等），不泄漏传输细节。
- 免费搜索通道会被高频查询限流降级（返回无关内容）——纪律使降级表现为诚实「未核对」
  而非幻觉，这是可接受行为；要更稳就换付费 API，不改架构。
- 包检索函数不带 abort signal，工具超时由 DSH `ToolCallTimeoutPolicy` 统一兜底。

## 失效/重审条件

接入付费搜索 API、或 rdk-docs-mcp 出现协议级新能力（如离线数据包）时重审；新增知识源
必须沿用「固定域名/白名单 + 有界返回 + 未核对纪律」三件套。

## 守卫

`server/agent-runtime/dsh-capability-handlers.test.ts`（含域名攻击与失败映射负例）。
