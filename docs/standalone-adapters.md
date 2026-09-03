# Standalone adapter boundary

公开仓库只保留产品核心与最小参考适配器。`server/sim2real/standalone-adapters.ts` 提供本地数据目录、匿名单用户 auth、空设备注册表、只读板端占位和安全 header；它不会伪造登录身份，也不会执行远程命令。

生产部署替换这些端口即可：

- `Sim2RealAuthPort` → 验证过的 SSO/OIDC session
- `BoardAgentPort` / `runOnDevice` → 受控的 RDK-X5 agent（预检、Canary、Live 分层）
- ledger → PostgreSQL + 对象存储
- RoboGo API client → 组织内部的服务端 token broker

这样仓库与 RDK Studio、RoboGo 的账号和发布节奏保持低耦合，但仍能通过明确的协议完成集成。
