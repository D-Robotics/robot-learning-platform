# 接入自建训练 Worker

在学习平台注册 Worker 的 `/train` 地址，然后调用 `rdk_compute_resource_test`。测试连接时，平台只向同一地址的同级路径 **GET `/healthz`**。例如登记 `https://worker.example.com/rl/train`，反向代理就需要同时提供 `/rl/train`、`/rl/healthz` 和 `/rl/runs/:runId`。健康检查无请求体。

公网 Worker 使用 HTTPS 和受信任的证书链。已配置的本地联调可使用受支持的本地 HTTP。使用 Studio 本地 Agent 时，由浏览器访问回环的 `/proxy/train`。公网登记使用至少 32 字节的随机 bearer token，平台通过 `Authorization: Bearer <token>` 发送。地址中的凭据、查询参数、片段和重定向均会被拒绝。

## GET /healthz

健康时返回 HTTP 200 和 JSON 对象，最小响应是 `{"ok":true}`。不可用时返回 HTTP 503 和 `{"ok":false}`。响应上限 32 KiB，超时 5 秒。可附能力字段。

| 字段 | 类型与范围 |
| --- | --- |
| `engines` | 字符串数组。ID 以小写字母开头，可含小写字母、数字和连字符，长度 2–32，最多取 64 项。 |
| `mock` | 布尔值，协议模拟 Worker 填 `true`。 |
| `cuda` | 布尔值，CUDA 可用时填 `true`。 |
| `gpuName` | GPU 名称，至多 160 字符。 |
| `vramMb` | 显存 MiB，整数 0–2,000,000。 |
| `maxConcurrentJobs` | Worker 支持的并发数，整数 1–32。 |

```json
{"ok":true,"engines":["starter-ppo"],"mock":false,"cuda":true,"gpuName":"Training GPU","vramMb":24576,"maxConcurrentJobs":1}
```

连接测试回执的 `diagnostic` 给出错误码、处理建议、健康路径、端口以及能解析到的 IP。解析结果是独立 DNS 查询结果，实际连接可能选择其中任一地址。诊断区分 DNS、TCP 拒绝、TLS、HTTP、超时、重定向和响应结构。

## POST /train

请求类型为 `application/json`。平台发送 `X-Sim2Real-Account`、已配置的 bearer token 和可用的 `Idempotency-Key`。Worker 按账号隔离任务，在同一账号重复收到相同幂等键时返回原任务。

| 字段 | 类型与用途 |
| --- | --- |
| `accountId` | 非空字符串，当前账号标识，与请求头一致。 |
| `schemaVersion` | 整数，模型清单版本。 |
| `contractId` | 非空字符串，模型契约 ID。 |
| `model` | 对象，包含 `modelId`、`displayName`、`version`。 |
| `robot`、`contract`、`simulator`、`artifacts` | 已校验的机型、策略契约、仿真配置和制品引用。 |
| `taskId`、`task` | 可选，任务 ID 及定义或 OriginMan 舞蹈编排。 |
| `training` | 可选，包含 `profile`、`numEnvs`、`maxIterations`、`video`、`engine` 等训练参数。 |
| `demonstrations`、`resumeFrom`、`idempotencyKey` | 可选，示教、续训或幂等信息。 |

接受异步任务时返回 HTTP 202 和 `{"status":"queued","runId":"worker-job-1"}`。平台随后向同级的 `GET /runs/:runId` 查询。状态响应使用相同 ID，`status` 可为 `queued`、`running`、`completed`、`blocked` 或 `failed`，可附 `summary`、`progress` 和 `metrics`。生成 ONNX 的 Worker 还应通过 `GET /runs/:runId/artifact` 返回文件，并在状态回执提供制品格式、引用与 SHA-256。拒绝任务时返回适当 HTTP 错误码和可读的 `message`。

仓库中的 `services/sim2real-web/local-training-worker.mjs` 提供上述路由、账号隔离及引擎执行。先验收健康响应，再用训练结果和实际文件验收引擎。
