# 云边观测 Schema

`rdk-observability.v1.json` 是机器人端 Edge Observability Agent 与云侧 Observability Center 之间的语言无关契约。

- TypeScript 服务使用 [`../observability-contracts.ts`](../observability-contracts.ts) 的类型和运行时校验。
- Python/C++ 端 Agent、网关和工位程序以此 JSON Schema 为线协议依据。
- 大体积 Raw、视频和日志正文不直接塞进事件；使用 `uri + sha256 + bytes` 的 Evidence File Ref。
- Schema 升级必须新增版本并保留旧版本解析能力；不能原地改变字段语义。

核心消息：

`context`、`event`、`metric`、`telemetryChunk`、`evidenceManifest`、`commandRequest`、`observationPolicy`。
