# API 契约

`openapi.yaml` 是独立 Sim2Real 控制面的机器可读入口。它描述稳定的
`/api/v1/duck/*` 路径；旧版 `/api/sim2real/*` 由同一个路由工厂提供兼容别名，
不会形成第二套业务逻辑。

## 先跑通一个请求

本地启动 Web 服务后，可以先读总览：

```bash
curl -fsS http://127.0.0.1:18102/api/v1/duck/overview | jq .
```

注册模型、训练和部署属于有副作用的操作。local/RoboGo 训练以及 canary/live
计划必须携带唯一 `Idempotency-Key`；重试同一个请求时复用该 key，服务会返回原记录，
不会重复启动可能计费的任务。

## 认证边界

公开仓库的 local adapter 是单用户开发模式，不从请求头推断身份。共享部署需要由
部署方注入经过验证的 SSO/OIDC 或 signed trusted-proxy adapter；API 只消费
`Sim2RealAuthPort` 提供的 `accountId` 和短期 token。RoboGo token 不应出现在浏览器、
URL、manifest、日志或 OpenAPI 示例里。

## 典型调用顺序

```text
GET overview
  → POST models/validate
  → POST models
  → POST runs (backend=local / robogo, with Idempotency-Key)
  → GET runs/{id} until terminal
  → POST runs/{id}/telemetry + POST runs/{id}/evaluate
  → POST deployments (mode=preflight)
  → POST deployments/{id}/preflight
```

`preflight` 是固定的只读板端探针。reference BoardAgent 返回 `mock=true` 时，服务会
明确保持 `409 SIM2REAL_PREFLIGHT_MOCK_ONLY`，不会把协议演练当成真机就绪，也不会执行
电机或任意 shell 命令。

## 与 Studio / MCP 的关系

RDK Studio、CLI 或外部 MCP 适配器都应调用这份版本化 API；它们只负责入口、授权上下文
和结果投影，不复制 manifest 校验、幂等、配额或部署闸门。这样 Sim2Real 可以独立发布，
而 Studio 仍能提供一站式入口。
