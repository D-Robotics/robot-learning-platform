# 上位机（Host Station）

工作台的「上位机」视图（工作流第 07 步）把板端状态、相机画面和白名单只读命令集中到一个页面。浏览器**从不直连板端 agent**：所有请求都经过平台服务端的认证代理 `/api/sim2real/board-station/*`，代理沿用部署预检的 SSRF 规则（明文 HTTP 仅限 loopback，远程 agent 必须走 TLS）。

## 能力边界（先读这一段）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 板卡实时状态（CPU/内存/磁盘/网络/电源/uptime/TROS 话题） | ✅ | NDJSON 心跳流，1Hz |
| 板载相机画面 | ✅ | MJPEG 流（multipart/x-mixed-replace），`<img>` 直接渲染 |
| 白名单只读命令 | ✅ | TROS 节点/话题列表、磁盘用量、服务状态 |
| 遥控/电机控制 | ⚠️ 默认关闭的受限驱动 | 双开关（平台 `RDK_SIM2REAL_STATION_DRIVE_ENABLED` + 板端 `RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE`）全开后提供 0.05–0.3 m/s / ≤2 s 的运动金丝雀；`actuatorControl` 全链路如实上报开关状态 |
| 网页添加真机（设备管理） | ✅ | 上位机页「设备管理」面板：填 SSH 坐标 → 服务端建 loopback SSH 隧道 + 探测 agent；不存密码，认证走本机 ssh 密钥/代理（见下） |
| 运动开关网页切换 | ✅ | 「运动开关」面板：平台侧持久化运行时覆盖（开启需确认）；板端侧经代理改 `agent.env` 两行并重启 agent |
| 策略运行时（ONNX 推理 → /cmd_vel） | ✅ 三重开关 | 平台策略 + 平台驱动 + 板端策略/驱动四开关全开后可用；推理 provider 与观测布局如实上报（见下） |
| 训练产物下发（staging） | ✅ | runId → 平台校验发布证据 + SHA-256 → 板端 `policies/` 目录；**只落盘，不加载不运动**，加载与启动仍是操作员的显式动作 |
| 急停 | ✅ 恒可用 | `POST /api/sim2real/board-station/drive/stop` 绕过所有开关，空格键全局急停 |

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

BoardAgent 在部署预检协议之外新增 12 个端点（7 个只读 + 3 个受限驱动 + 2 个受控 staging/config）：

```
GET  /healthz                       能力声明 + stationCommands 白名单
GET  /v1/station/status             一次状态快照（JSON）
GET  /v1/station/status/stream      NDJSON 心跳流（1 行 = 1 个快照）
GET  /v1/station/camera.mjpeg       MJPEG 相机流
POST /v1/station/commands           { "id": "<白名单命令>" } → { ok, output, ... }
GET  /v1/station/drive              受限驱动状态（金丝雀）
POST /v1/station/drive              钳制+时间盒的 cmd_vel（双开关全开才接受）
POST /v1/station/drive/stop         零速急停（恒 200，绕过开关）
GET  /v1/station/policy             策略运行时状态（provider/observationLayout 如实上报）
GET  /v1/station/policy/files       板端 policies/ 目录列表（文件名 + 字节数）
POST /v1/station/policy/upload      受控 staging：{ filename, bytesBase64, sha256 }（见下）
GET  /v1/config                     两个运动开关的当前状态 + env 文件/systemd 状态
POST /v1/config                     { "switches": { ...两个开关... } } 原子改写 env 行并重启服务（运动窗口中 409 拒绝）
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
GET  /board-station/switches        平台侧两个运动开关的当前状态（agent 不可达也可读）
PUT  /board-station/switches        切换平台侧开关（开启需 body.confirm=true；关闭恒允许；reset=true 清除运行时覆盖回退 env）
GET  /board-station/policy/files    板端 policies/ 目录列表（代理 agent 只读端点）
POST /board-station/policy/stage    训练产物下发（见下：三跳证据链，staging ≠ 加载 ≠ 运动）
```

设备管理（`server/routes/sim2real-device-connection-routes.ts`，同一前缀 + 别名）：

```
GET    /device-connections                    已存连接 + 隧道活跃标记
POST   /device-connections                    保存 SSH 坐标（host/端口/用户/备注）
DELETE /device-connections/:connectionId      删除记录并拆隧道
POST   /device-connections/:connectionId/connect      建 SSH 隧道 + 探测 /healthz
POST   /device-connections/:connectionId/disconnect   拆隧道，恢复默认 agent 目标
GET    /device-connections/:connectionId/config        代理读板端开关状态
POST   /device-connections/:connectionId/config        代理改板端两个开关（写 env + 重启 agent）
```

代理行为：

- 优先使用 `RDK_SIM2REAL_BOARD_AGENT_URL` 直连 BoardAgent；在与 RDK Studio 共用服务器的部署中，可改用 `RDK_SIM2REAL_STUDIO_EXEC_ORIGIN` + `RDK_SIM2REAL_STUDIO_DEVICE_ID`，平台会复用 Studio Local Bridge 执行同一组白名单请求，不再建立第二条板端隧道。浏览器当前请求的 Studio cookie 只转发到 Studio 同源 exec 路由。
- 两种连接都未配置时 → 503 fail-closed，页面显示引导横幅。
- 命令在**服务端再校验一次白名单**（浏览器拿到的按钮列表只是展示层）。
- 每个流式转发严格 1:1 上游连接，下游断开/超时/生命周期到期时双向一起拆，不留孤儿 interval。
- 请求体上限 64KB、JSON 响应上限 256KB、超时 4–15s 有界。
- 直连模式不转发 Studio 凭据；Local Bridge 模式只转发当前浏览器已有的 Studio cookie，且 `redirect: 'error'` 防重定向 SSRF。
- Local Bridge 无法承载长连接 MJPEG 时，平台轮询板端 `/v1/station/camera.snapshot`，在服务端重建同一 multipart 流；无相机仍返回 `CAMERA_UNAVAILABLE`，不生成合成画面。

## 网页添加真机（设备管理 · RDK Studio 网页版风格）

「连真机」与「开运动」的一次性配置现在都能在浏览器里完成，不需要命令行。上位机页新增两个面板：

**「设备管理」面板**：

1. 填板卡 IP / SSH 用户（默认 root）/ 端口（默认 22）/ 备注 → **添加**。只保存 SSH 坐标（`<dataDir>/device-connections.json`，0600），**不存任何密码**——认证走服务器本机 ssh 的既有密钥/跳板配置，与 `scripts/deploy-x5-board-agent.sh` 同一凭据路径。
2. 点 **连接**：服务端进程 spawn `ssh -N -L <随机本地端口>:127.0.0.1:19100 root@<IP>`（BatchMode 非交互、ExitOnForwardFailure、失败即拆），然后探测转发端口的 `/healthz`。成功后板端遥测/相机/命令全部自动切到该隧道目标；失败时错误如实回显（SSH 原因），隧道不留残余。
3. 因为隧道本地端是 loopback，代理看到的 agent URL 仍是 `http://127.0.0.1:<port>`——现有 SSRF 边界（明文 HTTP 仅限 loopback）、Bearer token、有界 fetch 全部原样保留。浏览器永远不直连板端。

设备记录按账号最多 50 条，单实例注册表最多 500 条；注册表损坏、不可读、超出大小或被符号链接替代时，服务返回 503 并保留原文件，不会把它当作空列表覆盖已有坐标。

多用户部署下设备记录按 owner 隔离（同 devices.json 规则）；隧道覆盖 agent 目标的行为只在单用户 standalone 模式生效。

**「运动开关」面板**：

- **平台侧**两个开关：PUT 持久化到 `<dataDir>/station-switches.json`（0600）。运行时覆盖优先于 env 默认值——env 仍是部署时的默认答案；`reset` 可清除覆盖回退 env。**开启**必须过确认对话框 + API 层 `confirm=true` 双重确认（关方向恒允许——fail-safe 方向）。
- 开关文件损坏、不可读、过大或被符号链接替代时，平台拒绝推断状态并返回 503；不会在未知状态下沿用一个可能为 `1` 的 env 值。
- **板端侧**两个开关（连接真机后才显示）：经平台代理调用板端 `/v1/config`，原子改写 `agent.env` 中对应的开关行（保留其他行）并 `systemctl restart rdk-board-agent`，约 2 秒生效。**运动窗口进行中会 409 拒绝**——绝不在机器人运动时换掉安全层。非 systemd 环境（手跑 agent）会如实报告「需手动重启」而不是假装已重启。

两个面板共同遵守同一原则：开关只翻两个文档化的标志位，**永远不能**变成发速度命令的通道；急停不依赖任何开关。

## 训练产物下发（环 D：制品 → 板端的三跳证据链）

训练完的 `policy.onnx` 以前从未真正到达过板端（隐含 scp 手工假设）。现在整条链路显式、可校验：

```text
local-training-worker          平台 /board-station/policy/stage         board-agent
GET /runs/:id/artifact   ◄──   ① 校验 run 发布证据（completed、   ③ 校验 SHA-256 后原子落盘
（服务前再哈希一次，             非 mock、local 后端、onnx、sha256）    /root/rdk-board-agent/policies/
 携 x-artifact-sha256 头）  ② 拉取字节并交叉比对 run.artifact.sha256  <runId>.onnx
```

安全语义：

- **三处哈希交叉验证**：worker 服务前重哈希、平台比对 run 台账记录、agent 写盘前验证 `sha256` 声明——任何一处不一致 409 拒绝（`artifact_digest_mismatch` / `SIM2REAL_STATION_POLICY_ARTIFACT_DIGEST_MISMATCH` / `policy-digest-mismatch`）。
- **文件名白名单**：裸 `<word>.onnx`（`^[\w.-]+\.onnx$`，禁 `..`），默认 `${runId}.onnx`；同名冲突要求哈希完全一致（幂等重下发），否则 `policy-name-conflict`。
- **staging ≠ 加载 ≠ 运动**：上传只落盘（原子 tmp+rename+fsync），不改运行时状态、不发 /cmd_vel；「加载」仍是显式 POST `/policy/load`，「启动」仍需四开关 + 确认对话框。三跳全部 token 门控（worker Bearer / 平台会话 / agent Bearer）。
- **开关门**：平台 `RDK_SIM2REAL_STATION_POLICY_ENABLED` 关闭时 409 `SIM2REAL_STATION_POLICY_DISABLED`；agent 端 `RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY` 关闭时 409。
- 上传代理超时单独放宽到最多 180s（50MB base64），其余端点仍是 4–15s 有界。
- 参考实现（`local-board-agent.mjs`）与真机实现（`board-agent-x5.py`）行为逐条对齐，`services/sim2real-web/local-board-agent.test.mjs` 同时覆盖两边语义。

## 推理 provider 与观测布局（环 B/C：声明式 + fail-closed）

策略运行时的两个新维度都从 adapter 声明派生，env 可覆盖：

| 来源 | 环境变量 | 默认 | 语义 |
| --- | --- | --- | --- |
| `runtime.observationLayout` | `RDK_SIM2REAL_OBSERVATION_LAYOUT` | `auto` | `originbot-imu-odom-v1`（8D：x,y,sinθ,cosθ,dx,dy,v,w）/ `imu-gravity-v1`（契约头 61/42D）/ `auto`（保留按维度自动选择） |
| `runtime.inferenceProvider` | `RDK_BOARD_POLICY_PROVIDER` | `cpu` | `cpu` / `bpu`；请求 bpu 但当前 onnxruntime 没有注册任何 bpu 命名的 provider 时**拒绝加载**（`bpu-provider-unavailable`，detail 列出实际可用列表），绝不静默降级到 CPU |

显式声明的布局是契约：模型输入必须同时匹配布局要求和 adapter 声明的 `observationSize`，矛盾即 `layout-model-mismatch` 拒绝加载——不做跨布局凑合。未知布局名在 `start` 时 fail-closed（`observation-layout-unknown`），不猜测装配。

### 输入绑定：从"猜"改成"声明并可核"

历史上运行时按 **rank** 认输入（"第一个 rank-2 输入就是观测"）。那是个推断，对三种导出会静默出错：输入顺序变了、多了第二个 rank-2 输入、以及**循环导出**——`h_in`/`c_in` 没人喂，ONNX Runtime 会用零填充，于是跑的是一个"永远没有记忆"的策略，动作看着合理但全错。

现在两端都按"有歧义就报错、绝不猜"处理（与 `engines/microduck-eval` 的 `classify_graph` 同一纪律）：

| 位置 | 行为 |
| --- | --- |
| 契约（`contract.inputs` / `contract.state`） | 可选字段，缺省即历史语义。声明后 `observation` / `image` / `stateInputs` / `stateOutputs` 按**名字**绑定，并与 `contract.state`（`kind` / `layers` / `hiddenSize`）交叉校验：LSTM 每层 2 个张量、GRU 每层 1 个，数量不符即契约错误 |
| 制品门禁（`validatePolicyInputBindingsAgainstModelGraph`） | 按名字在真实图里查：名字不存在、rank 不符、观测宽度不符、图像通道不符、状态输入输出形状不配对、动作输出有歧义——逐条报错 |
| 板端运行时（`board-policy-runtime.py`） | 加载时若发现**没人喂的输入**就拒绝：rank-3 报 `policy-state-input-unsupported`（detail 列出张量名），其余报 `policy-input-unbound`。**当前板端尚不携带状态**，所以循环导出会被拒——这是有意的诚实行为，而不是每步重放零状态 |

`contract.inputs.stateInputs` / `stateOutputs` 的命名与评测 harness 的 `Policy.state_input_names` / `state_output_names` 保持一致，一套命名覆盖训练、评测与板端。

契约规则由 `shared/policy-input-binding.test.ts`（26 个场景）覆盖；跨语言一致性由 `npm run verify:policy-input-binding` 演练：它**真造三张 ONNX 图**（前馈 / 循环 / 视觉），用真门禁裁决，并调用真板端 runtime 确认循环导出确实被拒。

> 循环策略的**板上携带状态**尚未实现：契约与门禁已就绪，板端一旦支持（按名字绑定 `h_in`/`c_in` 与 `h_out`/`c_out`、激活与重置边界清零），删掉那条拒绝即可。在那之前，把状态交给板端运行时会 fail-closed，而不是静默降级。

`GET /v1/station/policy` 如实上报 `provider`（实际使用的 provider）、`providerRequested`（请求值）、`providersAvailable`（本板 onnxruntime 注册的全部 provider）与 `observationLayout`；上位机页「策略运行时」面板逐项显示，BPU 不可用时操作者能直接看到该装什么。

该端点的响应同时带一个 `rehearsal` 判决块（`GET /api/sim2real/board-station/policy` 原样透传）：
板端上报收据时，平台用**板端自报的 `policy.sha256`** 去绑定收据里的 `artifactSha256` 再裁决，
因此"收据是别的导出"会被判为 `releasable: false`；板端没有自报摘要时也不放行，而是明确返回
"无法绑定字节"。板端完全没上报收据时返回 `evidence: false` 的显式拒绝，而不是静默通过：

```json
{
  "evidence": true,
  "releasable": true,
  "stage": "board-onnx",
  "artifactSha256": "…",
  "summary": "板端 ONNX 前向：control-step p50 2.100 ms / p95 2.800 ms，预算 20.000 ms",
  "errors": []
}
```

判决逻辑是纯函数 `boardRehearsalVerdict()`，5 个场景（无收据 / 一致 / 字节不符 / host 阶段冒充 /
板端无摘要）由 `server/routes/sim2real-board-station-policy.test.ts` 覆盖。

### 加载前的硬门禁（opt-in）

上面的 `rehearsal` 判决默认是**可见的拒绝**，不阻断加载 —— 现场流程不变。要把"没有时序证据就不能
上板"变成硬约束，在该板卡的部署环境里显式开启：

```bash
RDK_SIM2REAL_STATION_POLICY_REQUIRE_REHEARSAL=1   # 只认 '1'，与 station 开关同一套真值规则
```

开启后 `POST /board-station/policy/load` 需要三跳同时成立，**任何一跳缺失都不会转发加载动作**
（不存在"先加载再停"的窗口）：

| 跳 | 来源 | 缺失时的错误码 |
| --- | --- | --- |
| 1. 调用方声明要加载的字节 | 请求体 `artifactSha256` | `…_REHEARSAL_DIGEST_REQUIRED` |
| 2. 板端该文件名的真实摘要 | `GET /v1/station/policy/files` 的 `policies[].sha256` | `…_DIGEST_UNAVAILABLE` / `…_DIGEST_MISMATCH` / `…_NOT_STAGED` |
| 3. 收据测的就是这份字节 | 请求体 `rehearsalReceipt` | `…_REHEARSAL_REQUIRED` / `…_NOT_RELEASABLE` |

```bash
curl -X POST "$BASE/api/sim2real/board-station/policy/load" \
  -H 'content-type: application/json' -d @- <<'JSON'
{ "path": "policy.onnx",
  "artifactSha256": "<64 位小写 sha256>",
  "rehearsalReceipt": { ... } }
JSON
```

第 2 跳要求板端 agent 在策略列表里上报每个文件的 `sha256`：本机参考 agent 一直都有；X5 agent
本次补齐（按 `(size, mtime_ns)` 缓存，50 MB 制品不会被每次轮询重复哈希）。错误码与三跳语义由
8 个测试覆盖（含"旗标未设时行为完全不变、且不多一次列表往返"）。

契约测试：`npm run verify:policy-provider-layout`（真 onnxruntime 会话 + 真导出的 tiny ONNX，5 个断言场景，依赖缺失时 SKIP）。

## 上板前的延迟 rehearsal（环 D：制品 → 电机的时序证据）

**为什么需要它**：训练侧报告的 `controlLatencyMs` 是在**训练主机**上测的单线程 PyTorch 前向
中位数（`engines/starter-ppo/runner.py` 的 `measure_control_latency_ms`）。它回答不了上板前唯一
重要的问题——**导出的 ONNX 在真板子上能不能守住控制周期**。制品不同、runtime 不同、CPU 不同，
主机上的 0.05 ms 与板端 20 ms 预算没有可比性。

**测什么**：在板子上跑 `services/sim2real-web/board-latency-rehearsal.py`。它复用
`board-policy-runtime.py` 的真实加载路径（同样的 provider 选择、输入绑定、维度与布局校验）
和**控制循环里同一个 `session.run` 调用**，重复采样并写出收据：

```bash
# 于板端（不要与正在跑的 agent 抢同一策略文件）
python3 services/sim2real-web/board-latency-rehearsal.py \
  --model /root/rdk-board-agent/policies/policy.onnx \
  --decision-hz 50 --iterations 300
# → /var/lib/rdk-board-agent/runtime/board-latency-receipt.json
# 退出码携带判定：0 = 达标，1 = 超预算或无法测量（绝不写"看起来合格"的收据）
```

`--decision-hz` 必须与 task-pack / adapter 声明的控制率一致；默认取 runtime 的 `DECISION_HZ`。

**收据契约与判定**：由 `shared/board-rehearsal.ts` 校验（单测见
`shared/board-rehearsal.test.ts`，探针与门禁的一致性演练见 `npm run verify:board-latency`）。
`validateArtifactForDeployment` 现在要求**声称可部署的制品**附带一份满足下列全部条件的收据，
否则拒绝确认：

| 规则 | 拒绝理由（示例） |
| --- | --- |
| 测量阶段必须是 `board-onnx` | `host-torch` / `host-onnx` / `sim-step` / 未声明一律不能作为上板证据 |
| 收据必须新鲜（≤ 14 天） | 过期收据不能给新部署背书 |
| `artifactSha256` 必须等于将部署的字节 | 上一版导出的收据不能认证新导出 |
| 判据指标中位数必须在预算内 | 只看中位数；偶发尖峰由 `overBudgetRatio` 暴露 |
| `budgetMet` 必须与自身指标自洽 | 手改成 `true` 会被重算后拒绝 |
| 样本数 ≥ 100、百分位有序 | `median ≤ p95 ≤ max` |

**保真度边界（别过度解读）**：这是**进程内**测量，含 Python 与 onnxruntime 调度，但**不含**
相机/遥测线程的 GIL 竞争、DDS 发布、以及负载 CPU 上的内核调度；观测喂的是契约形状的零向量
（稠密策略的延迟与数据无关），视觉导出喂合成帧。收据里的 `notes` 会原样记录这些限制。
未绑定 ROS 的 rehearsal 是实际每步开销的**下界**。

测量阶段字段（`measurementStage`）：`host-torch`（starter 引擎）、`host-onnx`、`board-onnx`、
`sim-step`（`cpu-mujoco` 评测的步进耗时）。评估页与运行详情页的延迟标签会**逐字显示阶段**，
未声明时显示"测量阶段未声明"，不会伪装成控制预算。

## 接真机（X5）

参考 agent 的每个端点对应真机上的只读数据源，替换 `services/sim2real-web/local-board-agent.mjs` 为受控 X5 agent：

真实策略闭环现在按下面的进程关系运行：

```text
TROS /imu + /odom
      │
      ▼
board-telemetry-node.py ──► /var/lib/rdk-board-agent/runtime/telemetry-snapshot.json
      │                                  │
      │                                  ▼
      │                    board-policy-runtime.py（provider 按 adapter/env 选择，BPU fail-closed）
      │                                  │
      │                                  ├─► /cmd_vel（10 Hz，限速 + 500 ms 看门狗）
      │                                  └─► policy.jsonl（本地断网 spool）
      │                                                    │
      ▼                                                    ▼
board-agent-x5.py ◄──────── HTTP ◄──── board-telemetry-uploader.py
      │
      ▼
Sim2Real `/runs/:id/telemetry` → 回放 / MAE-RMSE / 发布闸门 → `/runs/:id/retraining-advice`（飞轮分析）
```

板端进程间的 command、ready、policy state 和 telemetry snapshot 默认写入
`/var/lib/rdk-board-agent/runtime`（目录 `0700`、文件 `0600`）。可用
`RDK_BOARD_RUNTIME_DIR` 或既有的 `RDK_BOARD_*_FILE`、`RDK_BOARD_*_READY`、
`RDK_BOARD_*_LOG` 环境变量做现场迁移；覆盖路径必须是绝对路径并位于当前用户/root
拥有的 `0700` 父目录中，公共 `/tmp`、符号链接、非普通文件会被拒绝。

板端启动时至少配置：

```bash
export RDK_SIM2REAL_BOARD_AGENT_TOKEN='<随机 32 字节以上 token>'
export RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1
export RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY=1
export RDK_BOARD_TELEMETRY_SPOOL=/var/lib/rdk-board-agent/telemetry/policy.jsonl
# Board IPC defaults to the root-only 0700 runtime directory.  Legacy direct
# file overrides (RDK_BOARD_*_FILE / RDK_BOARD_*_READY / RDK_BOARD_*_LOG) are
# accepted only when their parent is an owner-only 0700 directory; public
# /tmp paths and symlinks fail closed.
export RDK_BOARD_RUNTIME_DIR=/var/lib/rdk-board-agent/runtime
python3 board-agent-x5.py
```

策略运行时只接受 `/root/rdk-board-agent/policies/` 下的 ONNX，并校验输入维度（默认 61）和输出维度（14 或 2）。将本次运行的 `RDK_SIM2REAL_RUN_ID`、`RDK_SIM2REAL_MODEL_ID`、`RDK_SIM2REAL_DEVICE_ID`、`RDK_SIM2REAL_CONTRACT_ID` 注入 agent 环境后，`board-policy-runtime.py` 会把每次推理使用的 observation/action 原样写入 spool；`board-telemetry-uploader.py` 在网络恢复后按 chunk 重试，服务端用 `Idempotency-Key` 去重。

这条链路仍保留三道闸门：平台策略开关、平台驱动开关、板端策略/驱动开关。任何遥测陈旧、模型维度不符、运行时故障或 stop 请求都会发布零速并停止策略；页面显示的 `source=board-agent` 才能作为真实 X5 评测证据。

| 端点 | 真机数据源（示例） |
| --- | --- |
| `/v1/station/status` | `/proc/stat`、`/proc/meminfo`、`/sys/class/thermal`、`/sys/class/power_supply`、`ros2 topic list -v` |
| `/v1/station/status/stream` | 上述采样定时推送（1Hz 即可） |
| `/v1/station/camera.mjpeg` | OpenCV `VideoCapture` → JPEG 编码 → multipart 输出；或 TROS `/camera/image_raw` 压缩话题 |
| `/v1/station/commands` | 固定映射到 `ros2 node list`、`ros2 topic list`、`df -h`、`systemctl is-active <服务>` 等只读命令，不要泛化为 shell |

官方参考：RDK 文档「web 显示摄像头」示例（`/app/pydev_demo/09_web_display_camera_sample`）演示了板端 WebSocket 推流模式，MJPEG 端点是它的无依赖替代——浏览器 `<img>` 原生支持，不需要额外前端库。

## 复用与魔改说明

上位机的形态参考了开源社区常见模式（MJPEG-over-`<img>`、NDJSON 心跳、Foxglove 式状态面板），但本仓库的实现是零依赖自研：HTTP 层用 Node 内置 `http`/`fetch`，前端用原生 `fetch` 流式读取 + DOM 更新，没有引入 websocket/rosbridge/视频编解码依赖。相机 fixtures 由 `scripts/generate-board-camera-frames.py`（Pillow）生成，换 fixtures 重跑该脚本即可。
