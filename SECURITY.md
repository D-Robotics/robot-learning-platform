# Security

请不要在 issue、日志或 pull request 中公开 RoboGo token、SSO cookie、SSH 密码、设备公网地址或遥测中的个人信息。

报告安全问题请通过 D-Robotics 内部安全渠道，不要先公开利用细节。部署时将 RoboGo token、OIDC client secret 和存储凭据放在 secret manager 或 root-only 环境文件中，禁止写入前端、URL、manifest 或 ledger。

## 服务端已内置的防线

- 全局安全响应头：`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、`Permissions-Policy`，以及自家页面的严格 `Content-Security-Policy`（`script-src 'self'`）。只有 MicroDuck 上游 WASM bundle 所在的 `/mujoco` 命名空间被刻意放宽。
- 应用层限流（`RDK_SIM2REAL_RATE_LIMIT_PER_MINUTE`），超限返回 429 与 `Retry-After`；健康检查与 `/metrics` 豁免。
- `/metrics` 只输出计数与直方图，路由 label 经归一化，不含 runId、账号或环境变量。
- 结构化日志按字段白名单输出，**绝不**记录 `Authorization`、`Cookie`、token、secret 与请求体。
- 遥测保留策略可在写入路径按天淘汰过期数据；未设置时不删除任何记录。

配置项与生产建议见 [`docs/operations.md`](docs/operations.md)，发布阻塞项见 [`docs/release-checklist.md`](docs/release-checklist.md)。
