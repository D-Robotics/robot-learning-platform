# 生产运维手册

这份文档只讲**部署方需要显式确认的开关**。默认值是给本地开发用的，生产环境请逐项核对，不要照抄 `.env.example`。

## 暴露面与认证

| 变量 | 作用 | 生产建议 |
| --- | --- | --- |
| `RDK_SIM2REAL_BIND_HOST` | 监听地址 | 非本机访问一律放在反向代理之后；不要直接绑 `0.0.0.0` 暴露公网 |
| `RDK_SIM2REAL_AUTH_MODE` | `studio-cookie` / `trusted-proxy` / `standalone` | 共享部署必须显式设为 `trusted-proxy` 或 `studio-cookie`；未配置鉴权的 `web-cloud` 进程会 fail closed |
| `EXPRESS_TRUST_PROXY` | 是否信任一层反向代理 | 在 nginx/网关后设为 `1`，否则客户端 IP 与 `X-Forwarded-Proto` 不可信 |
| `RDK_SIM2REAL_PUBLIC_BASE_PATH` | 子路径挂载 | 与反向代理前缀保持一致，否则静态资源与 API 路径会错位 |

限流按客户端 IP 或已认证账号计；**不要**在没有 `EXPRESS_TRUST_PROXY` 的情况下依赖 IP 限流，否则所有请求会共享代理 IP 这一个桶。

## 限流

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE` | `1200` | 每窗口允许的请求数；`0` 关闭限流 |

超限返回 `429`，响应体为 `{ ok:false, error:'SIM2REAL_RATE_LIMITED', message }`，并带 `Retry-After` 与 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`。健康检查（`/healthz`、`/readyz`）与 `/metrics` 不计数。

这是**进程内**限流：多副本部署时每个副本各算一份，真正的边缘防护仍应由网关承担。

## 安全响应头

平台默认对所有自家页面下发：

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `X-Frame-Options: SAMEORIGIN`
- `Permissions-Policy`（关闭不需要的浏览器能力）
- `Content-Security-Policy`，其中 `script-src 'self'`、`object-src 'none'`、`frame-ancestors 'self'`

| 变量 | 作用 |
| --- | --- |
| `RDK_SIM2REAL_CSP_EXTRA_FRAME_SRC` | 逗号分隔，追加允许被嵌入/嵌入的来源（例：MicroDuck 外部部署地址） |
| `RDK_SIM2REAL_CSP_EXTRA_CONNECT_SRC` | 逗号分隔，追加允许 `fetch`/`XHR` 的来源 |
| `RDK_SIM2REAL_CSP_DISABLE` | `1` 时完全关闭 CSP。**仅用于排障**，不要长期开启 |
| `RDK_SIM2REAL_ENABLE_HSTS` | `1` 时下发 `Strict-Transport-Security`。纯 HTTP 本地开发不要开，否则浏览器会锁死 |
| `RDK_SIM2REAL_HSTS_INCLUDE_SUBDOMAINS` | `1` 时在 HSTS 上加 `includeSubDomains`。只有在**所有**子域都确定走 HTTPS 时才开 |

**MicroDuck 例外**：上游是第三方 WASM bundle，严格 CSP 会打断它，因此 `/mujoco` 命名空间下的响应刻意不下发严格 CSP（其余安全头仍保留）。这是有意的取舍，不是遗漏。

新增自家 HTML 页面时不要写内联 `<script>`（会被 `script-src 'self'` 拦掉）；逻辑放到独立 `.js` 文件。`services/sim2real-web/public/originbot-dashboard.html` 就是按这个规则抽取的。

## 日志

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RDK_SIM2REAL_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent`；非法值回退 `info` |

输出为 JSON Lines（stdout），每个 API 请求一条完成事件，字段为固定白名单：`ts`、`level`、`msg`、`event`、`requestId`、`method`、`path`、`route`、`status`、`durationMs`（控制字符会被剥离）。`Authorization`、`Cookie`、token、secret、密码与请求体**永不**被读取或写入日志。`X-Request-Id` 会透传网关传入的值，便于跨层排查；5xx 以 `error` 级别记录。

## 指标

`GET /metrics` 输出 Prometheus 文本格式：

- `sim2real_http_requests_total{method,route,status}`
- `sim2real_http_request_duration_seconds`（histogram）
- `sim2real_process_uptime_seconds`
- `sim2real_memory_rss_bytes`

`route` label 已归一化（UUID/数字段替换为 `:id`，Express 路由模板参数名如 `:runId` 保留），不会随 runId 增长基数；标签种类上限 300，超出归入 `__other__`。指标里不含账号、环境变量或个人路径。

`/metrics` **不带鉴权**（与 `/healthz` 一致），否则标准 Prometheus 抓取无法工作。它只暴露计数、直方图与归一化路由标签——如果这在你环境里仍属敏感信息，请在入口网关按来源 IP 或内网策略限制，而不是修改应用鉴权。

## 健康检查

| 端点 | 语义 |
| --- | --- |
| `/healthz`、`/api/healthz` | 进程存活；总是 200 |
| `/readyz`、`/api/readyz` | 就绪；`ready=false` 时返回 503 |

`degraded` 数组会列出降级原因（`microduck-not-mounted`、`storage-not-configured`、`sso-adapter-required`），可直接用于告警。

## 存储与容量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RDK_SIM2REAL_STORAGE_DIR` | `.data` | 台账与遥测分片目录；**必须**在持久卷上，且权限仅服务账号可读 |
| `RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS` | `0`（不淘汰） | 正整数时按天淘汰过期遥测（分片与台账索引一起），上限 3650；非法值按 0 处理 |
| `RDK_SIM2REAL_STORAGE_LEASE` | 开启 | 仅字面量 `0` 关闭写者租约。关闭后两个进程写同一 `RDK_SIM2REAL_STORAGE_DIR` 会互相覆盖台账，**仅限排障** |
| `RDK_SIM2REAL_STORAGE_LEASE_STALE_SECONDS` | `300` | 跨主机判定租约过期的秒数（10..86400，非法值回退 300）；同主机优先用 pid 存活判定 |
| `RDK_SIM2REAL_MAX_ACTIVE_RUNS` | `4` | 每账号并发的 queued/running 上限，上限 100 |
| `RDK_SIM2REAL_ACTIVE_RUN_TTL_SECONDS` | `86400` | 崩溃窗口预留的回收时间（5 分钟–7 天） |

容量规划与扩容路径见 [`scalability.md`](scalability.md)。生产环境请显式设置保留天数，避免遥测无界增长后在写入侧被 fail-closed 挡住。
