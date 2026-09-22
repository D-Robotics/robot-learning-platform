# D-006 · 登录支持直连 User Center SSO（user-center 模式）

- **Status**: Accepted
- **Date**: 2026-09-22
- **背景与约束**: 生产环境登录此前只有 `studio-cookie` 模式——完全嫁接 Studio 的
  会话 cookie（共享 `RDK_STUDIO_COOKIE_SECRET`）。用户提出独立化诉求。 Studio 自己
  也没有本地账号体系（嫁接公司 User Center SSO），且其 `server/sso/token-verify.ts`
  安全注释明确：本 IdP **没有可用的服务端 introspection**（对伪 token 也返 200），
  因此 access token 必须走云端 JWKS 的 RS256 本地验签，绝不允许 parse-only 采信。
- **Owner**: 学习平台 Agent platform maintainers

## 决策

新增认证模式 `RDK_SIM2REAL_AUTH_MODE=user-center`：

1. **登录流程**：OAuth2 授权码流程，IdP 为 `https://sso.d-robotics.cc`
   （`RDK_SIM2REAL_UC_SSO_BASE` 可覆盖）。登录 → `/oauth2/authorize` → 回调
   `/api/sim2real/auth/uc/callback` → `/oauth2/token` 换 access_token →
   JWKS 验签 → 签发平台自有 HMAC 会话 cookie（`rdk_sim2real_uc_session`，
   HttpOnly + SameSite=Lax + Secure(https)，14 天）。
2. **验签**：`server/sim2real/user-center-jwt.ts`（自 Studio sso-jwt-verifier
   移植，纯 node:crypto 零依赖）：RS256 + kid 匹配 + issuer=`user-center` +
   exp/nbf（120s 时钟偏移）+ JWKS 缓存（15 分钟新鲜 / 60 分钟 stale 兜底），
   验签失败在**非回环部署 fail closed**。
3. **API 客户端**：`Authorization: Bearer <access_token>` 由预中间件异步验签，
   通过后向本请求注入等价会话 cookie——`Sim2RealAuthPort.resolvePrincipal`
   保持同步契约（若返回 Promise 会被调用方当 truthy 放行，属认证绕过）。
4. **身份映射**：accountId = User Center `sub`，与 studio-cookie 模式的账号
   id 同源，切换模式**不迁移数据**。
5. **登录地址下发**：healthz 与 401 响应体带 `ssoLoginUrl`；前端登录入口
   优先读它，回退 `/rdkstudio/`（studio-cookie 模式行为不变）。

## 被否决方案

- 自建账号密码体系：成本高，且存量台账按 Studio 账号 id 隔离需迁移映射，
  同服务器出现双账号体系。
- 信任 IdP introspection：该端点对伪 token 返 200，不能作为信任锚。
- parse-only JWT 采信：非回环部署下可冒充任意用户（Studio 已有 FAIL CLOSED
  先例）。
- `resolvePrincipal` 返回 Promise：违反同步端口契约，truthy Promise 即认证绕过。

## 后果与边界

- 需要在 User Center 侧注册 OAuth 客户端（client_id/secret/回调路径
  `/api/sim2real/auth/uc/callback`）并配置 env 后模式才生效；未配置时
  该模式自动降级 standalone（fail closed），不改变既有部署行为。
- 依赖 sso.d-robotics.cc / cloud.d-robotics.cc 可达；IdP 故障时登录不可用，
  已登录会话在 cookie 有效期内继续可用。
- Agent 模型凭证仍走 Studio 网关（或显式配置 `RDK_SIM2REAL_DSH_API_KEY`
  直连），登录独立化不改变该面。

## 失效/重审条件

公司 User Center 协议变更（JWKS/签发方）或出现官方客户端 SDK 时重审；
若要彻底摆脱公司 SSO，需另立决策（自建账号体系成本见被否决方案）。

## 守卫

`server/sim2real/user-center-jwt.test.ts`（验签正/反例）+
`server/sim2real/user-center-auth.test.ts`（会话往返/篡改/过期/回调流程/
未核对 fail closed）；`server/sim2real/standalone-adapters.ts` 模式解析。
