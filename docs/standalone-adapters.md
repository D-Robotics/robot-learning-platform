# Standalone adapter boundary

公开仓库只保留产品核心与最小参考适配器。`server/sim2real/standalone-adapters.ts` 提供本地数据目录、匿名单用户 auth、设备注册表边界、只读 BoardAgent HTTP 桥接和安全 header；它不会伪造登录身份，也不会在 Web 进程内执行远程命令。

## 请求追踪

每个独立 Web 请求都会返回 `X-Request-Id`。如果网关传入了不超过 128 个可打印字符的
`X-Request-Id`，服务会沿用它；否则会生成 UUID。错误响应体同时包含 `requestId`，便于把
浏览器提示、网关访问日志和服务端日志串起来。该字段只用于排障关联，不承担账号认证。

生产部署替换这些端口即可：

- `Sim2RealAuthPort` → 验证过的 SSO/OIDC session
- `BoardAgentPort` / `runOnDevice` → 受控的 RDK-X5 agent（预检、Canary、Live 分层）。
  本仓库还提供一个可运行的 loopback HTTP reference：`npm run dev:board-agent`，配合
  `RDK_SIM2REAL_BOARD_AGENT_URL=http://127.0.0.1:19100` 可完成只读 board passport
  预检和板型探测。它只返回模拟的 aarch64/TROS/磁盘信息，拒绝未知命令，绝不执行 shell、SSH、模型下发
  或电机控制；因此它是联调工具，不是真机 agent。`?persist=true` 只会通过本地设备适配器更新
已登记设备的板卡元数据，不会写入凭据或执行设备动作。
- ledger → PostgreSQL + 对象存储
- RoboGo API client → 组织内部的服务端 token broker

这样仓库与 RDK Studio、RoboGo 的账号和发布节奏保持低耦合，但仍能通过明确的协议完成集成。

本地训练 worker 的提交接口也支持可选的 `RDK_SIM2REAL_LOCAL_RUNNER_TOKEN`。启用后，Web 服务和
worker 必须使用同一个 root-only secret；它只出现在服务端请求头，不会进入浏览器或任务制品。worker
会在提交前同步预留幂等键，并从 `job.json` 恢复已结束任务；重启时遗留的运行中任务会明确标记为
`worker_restarted`，不会自动重跑。

## BoardAgent HTTP contract

`RDK_SIM2REAL_BOARD_AGENT_URL` 指向 agent 根地址时，平台只调用：

```http
POST /v1/devices/{deviceId}/commands
Content-Type: application/json
Authorization: Bearer <short-lived-agent-token>

{"commands":["<read-only preflight command>"]}
```

成功响应至少包含 `output` 字符串和可选的 `exitCode`、`device` 字段；`output` 必须包含
`__STUDIO_SIM2REAL_PREFLIGHT_BEGIN__` / `__STUDIO_SIM2REAL_PREFLIGHT_END__` 之间的
`arch`、`kernel`、`python3`、`tros`、`disk_bytes`、`bpu_toolchain` 键（后者报
`present`/`missing`：hbdk-sim 量化工具 + hbrtmlin/hbrt-tv 运行时工具的存在性探测，
不解析版本——预检回显该事实但不作为部署硬阻断；当前下发的是 CPU ONNX 制品）。
客户端限制响应体、超时和设备 ID，并且只允许 loopback HTTP 或 HTTPS。真实 agent 应
在自己的边界执行权限校验和命令白名单，将 canary/live 与只读预检分开授权。

设备页的 `POST /api/devices/:id/board/detect?persist=true` 复用同一只读 probe，并只通过
`persistDeviceBoardDetection` 更新已登记设备的板型、型号和系统版本字段；它不会把 agent 返回的
原始对象整体写回，也不会执行上传、启动或执行器动作。共享部署会把写入限定到当前已验证 owner
的设备行；缺少 owner scope 时直接拒绝，避免不同账号使用相同设备 ID 时互相改写元数据。
reference agent 的响应带 `mock: true`，
所以部署闸门会保持 `blocked`，只能用来验证协议和界面。

## Station 扩展端点（受控 staging，只落盘）

上位机/板端策略链路在只读 commands 之外增加 station 系列端点（`/v1/station/*`，
Bearer 同一 agent token；协议全表见 [docs/host-station.md](host-station.md)）。其中唯一
的写盘端点是策略制品 staging：

```http
POST /v1/station/policy/upload
{ "filename": "run-xxx.onnx", "bytesBase64": "...", "sha256": "<64 hex>" }
```

agent 侧的边界：文件名白名单（裸 `<word>.onnx`，禁路径分隔）、base64 规范校验、
≤50MB、写盘前 SHA-256 验证、原子 tmp+rename、同名冲突要求哈希一致（幂等）。
它**只写文件**——不改运行时状态、不加载模型、不发 /cmd_vel；平台侧
`POST /board-station/policy/stage` 在转发前还会校验 run 的发布证据
（completed / 非 mock / onnx / sha256 台账）并交叉比对 worker 重哈希的结果。
真机 agent（`board-agent-x5.py`）与 reference agent（`local-board-agent.mjs`）
语义逐条对齐。

adapter JSON 的 `runtime` 段新增两个声明字段：`observationLayout`
（`originbot-imu-odom-v1` / `imu-gravity-v1` / `auto`）与 `inferenceProvider`
（`cpu` | `bpu`）。板端策略运行时按声明装配观测、选择 provider；BPU 请求在
没有 BPU provider 的构建上拒绝加载（fail-closed），显式布局与模型维度矛盾
同样拒绝——语义细节见 host-station 文档「推理 provider 与观测布局」。
