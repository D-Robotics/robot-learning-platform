---
name: rdk-platform-docs
description: 为 RDK 学习平台任务核对 D-Robotics 官方板卡、TROS、工具链、烧录、量化和硬件资料，并查询平台自身工作流和 API 文档。
---

# 平台与 RDK 知识

交付有来源的答复，并区分当前实现与外部硬件事实。参数查 [工具目录](../../references/tool-catalog.md)。

- 平台流程、安装、UI/API、引擎和门禁先读 `RDK_ROBOT_LEARNING_PLATFORM_ROOT` 下的源码/测试/文档。包内 [仓库能力](../../references/cli-capabilities.md) 给出入口；当前平台状态用 MCP 实测，不能用文档推断。
- RDK X3/X5/S100/S600、TROS、Model Zoo、OE 工具链、XBurn、烧录、量化等官方事实使用 `rdk_docs_search(query, manual?)`。需要手册定位时先 `rdk_docs_manuals`，用返回的实际 manual ID 读 `rdk_docs_toc(manual, query?)`。
- 深读命中资料用 `rdk_docs_page(url)`，URL 来自搜索/目录/上一轮结果，只允许官方站点范围；论坛是补充经验。引用正文支持的结论，并附真实来源链接。
- 官方覆盖不足时用 `rdk_web_search(query)`，注明“来自网络检索、非官方结论”。第三方信息与官方资料冲突时以官方资料为准；上游软件/版本需按当前原始资料核对。

检索失败、超时或未命中必须说明“官方资料未核对”，不把模型记忆写成已验证事实。缺手册/页面时给出已查范围和下一步，不编造 manual ID。用户取消后停止新增搜索，报告已核对内容的边界。

平台插件不是外部官方资料的离线副本；不要把板卡算力、系统版本或上游 commit 等易漂移结果硬编码进共享文档，记录查询方式和证据日期即可。凭据、用户设备地址及本机路径不进入分享结果。
