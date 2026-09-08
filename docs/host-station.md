# 上位机（Host Station）

工作台的「上位机」视图（工作流第 07 步）把板端状态、相机画面和白名单只读命令集中到一个页面。浏览器**从不直连板端 agent**：所有请求都经过平台服务端的认证代理 `/api/sim2real/board-station/*`，代理沿用部署预检的 SSRF 规则（明文 HTTP 仅限 loopback，远程 agent 必须走 TLS）。

## 能力边界（先读这一段）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 板卡实时状态（CPU/内存/磁盘/网络/电源/uptime/TROS 话题） | ✅ | NDJSON 心跳流，1Hz |
| 板载相机画面 | ✅ | MJPEG 流（multipart/x-mixed-replace），`<img>` 直接渲染 |
| 白名单只读命令 | ✅ | TROS 节点/话题列表、磁盘用量、服务状态 |
| 遥控/电机控制 | ⚠️ 默认关闭的受限驱动 | 双开关（平台 `RDK_SIM2REAL_STATION_DRIVE_ENABLED` + 板端 `RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE`）全开后提供 0.05–0.3 m/s / ≤2 s 的运动金丝雀；`actuatorControl` 全链路如实上报开关状态 |
| 急停 | ✅ 恒可用 | `POST /api/sim2real/board-station/drive/stop` 绕过所有开关，空格键全局急停 |
| 写板操作（下发制品、改参数、启停服务） | ❌ | 上板部署仍走部署页的 preflight → canary → live 流程 |

本平台的安全立场：上位机默认是**观察面**。受限驱动是唯一例外且默认关闭——双开关、双重钳制、时间盒、底盘固件看门狗兜底，完整启用流程与操作案例见 [docs/actuator-drive.md](actuator-drive.md)。

## 一分钟跑起来（本地参考实现）

```bash
# 终端 1：只读 reference BoardAgent（含模拟相机 fixtures）
npm run dev:board-agent

# 终端 2：Web 工作台
RDK_SIM2REAL_BOARD_AGENT_URL=http://127.0.0.1:19100 npm run dev:sim2real
```

打开工作台 → 左侧「上位机」→ 首次进入时懒初始化：状态卡开始跳动、点击「开启相机流」看到画面（合成 fixtures：一只在网格地面上移动的鸭子）、命令面板执行只读命令并写入串流日志。

需要一台可选择的板卡设备：本地开发在 `.data/devices.json`（或 `RDK_SIM2REAL_STORAGE_DIR` 下）登记一条设备记录；`npm run demo:sim2real` 会自动种子一台 `x5-demo`。

参考 agent 会如实报告 `mock: true`，页面上也会显示「本地参考 BoardAgent（模拟数据）」的诚实标注。

## 线协议（agent 侧）

BoardAgent 在部署预检协议之外新增 8 个端点（5 个只读 + 3 个受限驱动）：

```
GET  /healthz                       能力声明 + stationCommands 白名单
GET  /v1/station/status             一次状态快照（JSON）
GET  /v1/station/status/stream      NDJSON 心跳流（1 行 = 1 个快照）
GET  /v1/station/camera.mjpeg       MJPEG 相机流
POST /v1/station/commands           { "id": "<白名单命令>" } → { ok, output, ... }
GET  /v1/station/drive              受限驱动状态（金丝雀）
POST /v1/station/drive              钳制+时间盒的 cmd_vel（双开关全开才接受）
POST /v1/station/drive/stop         零速急停（恒 200，绕过开关）
```

- 鉴权：与预检协议同一 `RDK_SIM2REAL_BOARD_AGENT_TOKEN`（Bearer）。
- 并发上限：agent 对流式端点做共享客户端预算（默认 4），超出返回 503。
- 命令白名单：`list-tros-nodes` / `list-tros-topics` / `disk-usage` / `service-status`。未知 id 一律 403 `BOARD_AGENT_READ_ONLY`，**没有 shell，没有透传**。

## 服务端代理（平台侧）

`server/routes/sim2real-board-station-routes.ts` 挂在 `/api/sim2real/board-station/*`（`/api/v1/duck` 别名同样生效）：

```
GET  /board-station/health          agent 能力 + 当前板卡信息（不含敏感字段）
GET  /board-station/status          快照
GET  /board-station/status/stream   逐字节转发 NDJSON（1 上游连接/客户端，15 分钟上限）
GET  /board-station/camera.mjpeg    逐字节转发 MJPEG（同上）
POST /board-station/commands        白名单再校验（服务端第二道闸）后转发
GET  /board-station/devices         可作为上位机目标的可见板卡列表
```

代理行为：

- 未配置 `RDK_SIM2REAL_BOARD_AGENT_URL` → 503 fail-closed，页面显示引导横幅。
- 命令在**服务端再校验一次白名单**（浏览器拿到的按钮列表只是展示层）。
- 每个流式转发严格 1:1 上游连接，下游断开/超时/生命周期到期时双向一起拆，不留孤儿 interval。
- 请求体上限 64KB、JSON 响应上限 256KB、超时 4–15s 有界。
- 不转发任何 Studio 凭据；`redirect: 'error'` 防重定向 SSRF。

## 接真机（X5）

参考 agent 的每个端点对应真机上的只读数据源，替换 `services/sim2real-web/local-board-agent.mjs` 为受控 X5 agent：

| 端点 | 真机数据源（示例） |
| --- | --- |
| `/v1/station/status` | `/proc/stat`、`/proc/meminfo`、`/sys/class/thermal`、`/sys/class/power_supply`、`ros2 topic list -v` |
| `/v1/station/status/stream` | 上述采样定时推送（1Hz 即可） |
| `/v1/station/camera.mjpeg` | OpenCV `VideoCapture` → JPEG 编码 → multipart 输出；或 TROS `/camera/image_raw` 压缩话题 |
| `/v1/station/commands` | 固定映射到 `ros2 node list`、`ros2 topic list`、`df -h`、`systemctl is-active <服务>` 等只读命令，不要泛化为 shell |

官方参考：RDK 文档「web 显示摄像头」示例（`/app/pydev_demo/09_web_display_camera_sample`）演示了板端 WebSocket 推流模式，MJPEG 端点是它的无依赖替代——浏览器 `<img>` 原生支持，不需要额外前端库。

## 复用与魔改说明

上位机的形态参考了开源社区常见模式（MJPEG-over-`<img>`、NDJSON 心跳、Foxglove 式状态面板），但本仓库的实现是零依赖自研：HTTP 层用 Node 内置 `http`/`fetch`，前端用原生 `fetch` 流式读取 + DOM 更新，没有引入 websocket/rosbridge/视频编解码依赖。相机 fixtures 由 `scripts/generate-board-camera-frames.py`（Pillow）生成，换 fixtures 重跑该脚本即可。
