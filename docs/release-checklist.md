# 公开发布清单（阻塞项）

这份清单只列**会阻塞公开发布**的事项，逐项给出判定证据。任何一项未打勾，就不应把仓库标记为"可公开发布"或"整体 9+"。

## 许可证与版权

- [x] **根目录 `LICENSE`**：已放置 Apache-2.0 完整原文（含 APPENDIX）。`LICENSE` 与 canonical 文本逐字节一致（sha256 `7df059597099bb7dcf25d2a9aedfaf4465f72d8d`）。
- [ ] **版权主体与年份**：`LICENSE` 的 APPENDIX 保留上游占位符 `[yyyy] [name of copyright owner]`。发布方须确认版权主体写法；如需随包声明，补 `NOTICE`。
- [x] **第三方边界**：[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) 记录可选集成方向及其许可证边界。
- [ ] **MicroDuck 上游 bundle**：仓库不重新分发上游静态资源，部署方须自行确认上游 commit/许可证，见 [`services/mujoco-web/MICRODUCK-UPSTREAM.md`](../services/mujoco-web/MICRODUCK-UPSTREAM.md)。

## 秘密与本地状态

- [ ] **`git status` 无意外文件**：`.env`、`.data/`、`coverage/`、`dist-server/`、`gui-test-screenshots/` 必须保持未跟踪（已在 `.gitignore`）。
- [ ] **秘密扫描**：对将发布的 commit 跑一次 `gitleaks detect`（或等价工具），确认没有 token、Cookie 密钥、设备地址、内网域名。
- [ ] **`.env.example` 不含真实值**：只保留占位与注释。

## 诚信性（不完成就不能宣称"真机可用"）

- [ ] **真机运动证据**：X5 上由策略实际驱动的安全运动记录，含急停、watchdog、回滚与原始遥测。
- [ ] **第二台实体机型**：完成同一任务模板的独立验证（当前只有 `generic-differential-drive` 的仿真声明实证）。
- [ ] **制品签名与回滚演练**：artifact registry 的签名、不可变存储、跨版本回滚各演练一次。

> 这三项必须在**真实设备**上完成，代码门禁无法替代。归档前平台应标记为"软件门槛 9+、整体评分待现场验收"（见 [`quality-scorecard.md`](quality-scorecard.md)）。

## 工程门禁

- [ ] `npm ci && npm run verify` 在干净 checkout 上全绿。
- [ ] `npx tsc --noEmit` 全绿。
- [ ] `npm run lint` 与 `npm run format:check` 全绿。
- [ ] CI 在 Node 20 / 22 / 24 三个版本上全绿。

## 运营配置

- [ ] 生产 `EnvironmentFile` 为 root-only，且**不**沿用 `.env.example` 的开发默认值。
- [ ] 认证模式显式设置（`trusted-proxy` / `studio-cookie`），未配置时不暴露公网。
- [ ] 限流、CSP、日志级别按 [`operations.md`](operations.md) 显式确认，而不是依赖默认值。
- [ ] 遥测保留策略（`RDK_SIM2REAL_TELEMETRY_RETENTION_DAYS`）按容量预算设置，见 [`scalability.md`](scalability.md)。
