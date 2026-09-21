# D-004 · 设备连接 = 服务端中介 SSH + 板端 BoardAgent 契约，浏览器零直连

- **Status**: Accepted
- **Date**: 2026-09-21
- **背景与约束**: 平台是纯网页形态。浏览器进程不能（也不应该）直接触达板端；RDK 板卡是
  带网络的 Linux 计算机，正确通道是网络而非 USB。架构对齐 Studio 网页版
  （`AddDeviceMethodStep.tsx` 明示网页只支持 SSH 直连，Type-C/串口是桌面客户端专属）。

## 决策

- **浏览器零直连**：所有板端访问经平台服务端认证代理 `/api/sim2real/board-station/*`，
  代理沿用部署预检的 SSRF 规则（明文 HTTP 仅限 loopback，远程 agent 必须走 TLS）。
- **添加真机**：网页填 SSH 坐标 → 服务端建 SSH 隧道 + 探测 agent；不存密码，
  认证走本机 ssh 密钥/代理。
- **板端契约**：BoardAgent 常驻板端（代码 `/opt/rdk-board-agent`，策略
  `/root/rdk-board-agent/policies`，两者刻意分离），12 个 HTTP 端点（NDJSON 心跳、
  MJPEG 相机、白名单只读命令、受控 staging、受限驱动），Bearer token 鉴权，
  流式端点共享客户端预算。
- **安全立场**：上位机默认是观察面。受限驱动是唯一例外且默认关闭——双开关、双重钳制、
  时间盒、底盘固件看门狗兜底；急停绕过一切开关恒可用。

## 被否决方案

- 浏览器直连板端（WebUSB/WebSocket 直达）：凭据进浏览器、无服务端审计、CORS/私网暴露。
- Studio 式「对裸 Linux 直接发 SSH 命令执行一切」：我们保留 SSH 仅用于建隧道与探测，
  运行期能力固化为板端 HTTP 契约（可鉴权、可限流、可白名单）。
- 允许网页切换运动开关不经确认：违反观察面默认立场。

## 后果与边界

- 平台服务必须能与板卡网络互通（本机/局域网部署天然满足）。
- **上云前提**：服务在云端、板子在内网时，需要补内网桥接件（参考 Studio
  `local-bridge-hub` 的 helper 模式）——这是 D-004 唯一预留的架构缺口。
- 命令白名单之外的任何板端执行一律 403 `BOARD_AGENT_READ_ONLY`，没有 shell、没有透传。

## 失效/重审条件

出现真机烧录/串口日志需求（Studio 用桌面客户端承载）或云部署需求时，以新 ADR 扩展；
不得在网页端偷开直连通道。

## 守卫

`server-wiring.spec.mjs` / `server/routes/sim2real-routes.test.ts` / `docs/host-station.md`
（协议清单）。
