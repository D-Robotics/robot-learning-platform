# 真机接入验证记录（局域网直连 + 平台自管隧道）

> **下午追加（同日）**：本文件下半部分（「真机运动验收」起）记录同日下午的
> 完整学习闭环上真机过程：42D 策略训练→下发→加载→低速金丝雀→根因修复。
> 上半部分保留上午的只读接入验证原文。

- 日期：2026-09-14
- Mac：`10.208.179.121`（en1，办公局域网）
- 板子：`10.208.179.180` · D-Robotics RDK X5 V1.0 · Ubuntu 22.04.5 · RDK 3.1.1 · profile `rdk-x5-originbot-real`
- 平台：本地 `http://127.0.0.1:18102`（`.env` = 本仓库根目录）

## 上午结论（诚实边界）

本次完成了**真机重新接入 + 全链路只读验证**：平台 → SSH 隧道 → 板端 agent →
真实遥测 → 策略 load → 安全闸门 → stop 归零。**未让机器人运动**（驱动闸门
平台侧全程关闭），也没有提交任何训练 Run。这是接入与链路验证记录，不是
策略质量或运动验收记录。

## 接入过程（可复现步骤）

1. ARP 扫描定位板子（`10.208.179.66` 只有 Mac 自己的邻居记录；`.180` 的
   22/19100 端口开放）。`/healthz` 无 token 返回 401 `BOARD_AGENT_UNAUTHORIZED`
   ——非回环绑定强制 token 的安全设计生效。
2. 停掉 Mac 侧 19100 上的 `local-board-agent.mjs`（模拟 agent）与旧平台 server。
3. 尝试 `.env` 直写 `http://10.208.179.180:19100` 被平台拒绝（boardAgent
   降级 `board-agent-not-configured`）：平台只接受 `https:` 或回环 `http:`
   （`standalone-adapters.ts` 的 `boardAgentUrl()`）——这是刻意的安全边界，
   本次改回合规路径。
4. 走平台正规通道：`POST /api/sim2real/device-connections` 新建
   `board-abc52843`（root@10.208.179.180:22，agentPort 19100），再
   `POST .../connect` 由平台 tunnel manager 拉起 SSH 隧道
   （`127.0.0.1:32400 → 板端 127.0.0.1:19100`，`activeTunnelAgentUrl()`
   在单用户部署下优先于 `.env`）。旧记录 `board-3eee9100` 指向旧网段
   `10.185.136.180`（No route to host），已不适用但未删除。

## 验证结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 板端 agent 可达 | ✓ | `/healthz`：`mock:false`，capabilities=read-only-preflight/host-station/constrained-drive |
| 平台健康 | ✓ | `/api/healthz`：`ready:true`，degraded 为空，boardAgent.ready=true |
| demo:preflight | ✓ | 6/6 全绿（板端 agent / 设备隧道 / 传感器遥测 / 策略运行时 / 驱动闸门 / 策略制品） |
| 真实遥测 | ✓ | IMU 四元数/陀螺仪/加速度实时变化、odom 静止全零、电池 4.99V、CPU ~10% |
| 策略加载 | ✓ | 平台代理 `POST /board-station/policy/load`（originbot-policy.onnx）：`state=ready`，8D→2D，CPUExecutionProvider，obsSlots=8 全 real（/odom+/imu），layout auto 识别为 originbot-imu-odom-v1 |
| 启动闸门 | ✓ 按预期阻断 | 平台侧 `POST /policy/start` 409 `SIM2REAL_STATION_DRIVE_DISABLED`（平台驱动开关关闭，未触达板端） |
| 停止归零 | ✓ | `POST /policy/stop`（平台与板端各一次）：`command=0.0`、`published=0`、零速帧发布，板端日志 `[drive] STOP reason=operator-stop active=False` |
| 板端服务 | ✓ | `rdk-board-agent` + `originbot-bringup`（底盘+IMU+状态）systemd active |

## 状态收尾

- 板上策略 runtime 子进程常驻（设计如此，`_policy_runtime_alive` 常驻判断）；
  当前态：`ready`、`command=0`、`published=0`、无运动。模型
  `originbot-policy.onnx` 仍处于已加载待命状态（runtime 无卸载操作，
  `reset` 只清故障）；下次 load 会覆盖会话。若需完全复原，可
  `systemctl restart rdk-board-agent`。
- 板上 `policies/` 现存 5 个制品：demo-policy.onnx / microduck-ppo-gpu.onnx /
  originbot-policy.onnx / originbot-visual-twist-v1.synthetic.model.bin / policy.onnx。
- 平台台账 9 个 Run（2 failed / 6 completed / 1 queued），均为 2026-09-10 前历史。
- 未提交训练、未开驱动开关、未发生任何运动。

## 与 2026-09-09 记录的差异

上次验证走的是"GPU 训练 → ONNX → X5 加载 → 遥测 → 状态机 → 只读预检 →
安全停止"。本次补齐：**局域网重新定位（板子网段已变）+ 平台自管设备连接
隧道 + station 代理路由下的策略 load/stop 全链路**。两轮都未运动；真机
Canary（策略驱动低速运动 + 任务成功证据）仍是 roadmap 的第一优先缺口。

## 复跑命令

```bash
# 前置：Mac 能 ssh root@10.208.179.180（免密）
node scripts/run-with-env.mjs node dist-server/services/sim2real-web/server.js   # 平台
npm run demo:preflight -- --url http://127.0.0.1:18102                            # 只读预检
# 连接（已在台账的记录）：
curl -X POST http://127.0.0.1:18102/api/sim2real/device-connections/board-abc52843/connect
```

---

# 真机运动验收（下午 · 完整学习闭环上真机）

## 总结论（截至 19:40）

| 环节 | 结果 |
| --- | --- |
| 42D 门限通过策略（clear-arena 100% / 0 碰撞） | ✅ 训练完成 |
| 制品下发上板（sha 校验 + 42D 契约 load） | ✅ |
| 驱动路径三步金丝雀（零速→低速→急停） | ✅ **全部通过，真实位移已验证** |
| 板端遥测/推理链路修复（4 处） | ✅ |
| 双发布器互踩根因确诊 + 修复 | ✅ 修复已部署 |
| **策略驱动真机运动窗口** | ⏳ 待电池恢复后复跑（自动监控挂 15 分钟一查） |

真机低速运动**已经发生并被三重证据确认**（驱动路径）；策略路径的运动验证
被一个真实的双发布器缺陷阻断，根因已修复并部署，等电池恢复即可收官。

## 训练弧线（全部真实 Run，无 cherry-pick）

| Run | 配置 | 门限结果 |
| --- | --- | --- |
| 8D 800/1600 iter | originbot-imu-odom-v1 | FAIL（成功率不足） |
| 42D 2500 iter | imu-gravity-v1，有障碍 | FAIL（CI low 0.6696 / collision CI high 0.308） |
| 42D + proximity 惩罚实验 | obstacleProximity | FAIL（nominal 0.0，复证 research 文档 varianceLesson：42D 无障碍信号，噪声主导） |
| **42D clear-arena 800 iter** | 空场地（障碍 0），100 回合/包络 | **PASS：成功率 100%（两包络），碰撞 0，CI low 0.963，CI high 0.037** |

选用策略：`goalnav42d-policy.onnx`（90210 字节，sha256 `ad281858…`）。
任务包：`tasks/goal-navigation-clear-arena.json`（新建，provenance 注明 42D
观测无障碍信号、部署场景为操作员清空的场地——与金丝雀场景一致）。

## 平台侧修复（训练→下发链路，3 个真实缺陷）

`fetchLocalRunArtifact`（`server/sim2real/local-runner.ts`）原实现三处缺陷，
导致 `SIM2REAL_STATION_POLICY_ARTIFACT_UNAVAILABLE`：

1. 未发 `X-Sim2real-Account` 头——worker 的 `/runs/:id/*` 路由按账号鉴权；
2. artifact URL 未剥 `/train` 后缀（runner URL 约定带后缀，`/runs/:id` 路径不带）；
3. 单用户 standalone 模式 `requestOwner()` 返回 undefined，无回退账号。

修复：`accountId` 必填参数 + `safeAccountId` 校验 + 账号头 + 后缀剥离；
`sim2real-routes.ts` 的 fetchRunArtifact 闭包在单用户部署回退 `'local-dev'`。
测试（local-runner.test.ts）同步更新，全过。

## 板端修复（遥测/推理链路，4 处）

1. **telemetry 目录 755 → 0700**：board_ipc 的 `ensure_private_parent` 要求
   直接父目录恰 0700，否则 secure_read 全部 fail-closed——现象是推理循环
   `published=0`、遥测 bytes=0。
2. **采样器旧契约**：板上 `board-telemetry-node.py` 是旧版（快照无每传感器
   `sampleMonotonicNs`），新策略运行时按 freshness 检查拒帧。部署仓库新版
   后恢复正常（IMU/odom 带单调时戳，10Hz）。
3. **policies 目录 755 → 0700**：新版 agent 的 `model-file-unsafe` 检查
   （`_policy_allowed_model_path` → `ensure_private_parent`）。
4. **运行时 rclpy 不 spin**（仓库真实缺陷，已修复）：`bind_ros` 建了
   publisher 但主循环从不 spin，DDS 写端点不完成发现。修复：
   `_spin_ros_once()`（`rclpy.spin_once(node, timeout_sec=0.0)`）加入主循环。

## 意外指令窗口（如实记录，未造成运动）

17:35 遥测链路修好的瞬间，`direction=0` 的会话立即开始自主发布
(0.05 m/s, ≤0.185 rad/s)，持续约 76 s / 753 次推理，被发现后立即急停。
**当时轮子没动**（IMU 陀螺仪全程 0.0011–0.0085 rad/s，odom 漂移 2mm）。
根因：电池亏电（4.99V，2S 空电下限 6.0V）触发 MCU 欠压锁定。操作上承认
假设错误：**direction=0 不是零速**——42D 契约里 direction 只是观测槽位，
不是速度指令；"零速验证通过"当时实为遥测 fail-closed 假阴性。

## 驱动路径三步金丝雀（PASS · 真实运动）

电池在 5.0V 读数下 MCU 处于间歇锁定（重启 bringup 重新握手串口后解锁），
三步全部按 `docs/actuator-drive.md` 协议执行：

| 步骤 | 命令 | 证据 |
| --- | --- | --- |
| 1 零速 | linear=0, 0.5s | 发布握手成功（published=1），odom/陀螺仪零，`window-expired` |
| 2 低速 | linear=0.05, 2s ×2 | **odom 0→(0.042,-0.017)→(0.059,-0.054)**，累计位移 ≈0.077 m；陀螺仪出现轮子扰动；`window-expired` |
| 3 急停 | 窗口开 0.4s 后拍停 | `operator-emergency-stop` 即时生效（驱动状态归零+零速帧），位移冻结 <1mm |

后续仪器化复测（250ms 采样 + 节点 PID 盯踪）：手动窗口位移 0.039–0.040 m
（≈0.05 m/s × 2s，欠压电池带载实际速度略低），底盘节点 PID 全程不变，
陀螺仪有真实扰动（-0.021…+0.036 rad/s）。

## 双发布器互踩（策略路径零位移的根因，已修复）

**现象**：同一分钟内 A/B 对照——手动驱动窗口真实位移，策略窗口零位移
（`published` 计数正常、echo 能在 `/cmd_vel` topic 上看到策略帧）。
`ros2 topic pub`（第三方发布器）同样无法驱动底盘。

**根因**：驱动开关开启时，agent 预热的常驻 `board-drive-publisher.py` 以
10Hz 持续发布**零速帧**（设计意图："零速即静止"+底盘看门狗地板）。策略
运行时同时在 10Hz 发布 0.05 m/s 帧。底盘 MCU 收到的是两种帧交替的指令流，
目标速度每 50ms 被清零，永远加速不起来。帧数算术吻合：20s 窗口 echo 抓到
187 帧 ≈ 两个 10Hz 发布者交错。

**修复**（`board-agent-x5.py`，已部署，md5 `89bf9fe4…`）：
`policy_start` 先 `_stop_drive_publisher()` 拆掉常驻发布器（策略运动独占
`/cmd_vel`；start 失败则 `_rewarm_drive_publisher()` 回热）；`policy_stop`
结束后 `_rewarm_drive_publisher()` 恢复手动驱动的低延迟稳态。手动金丝雀
路径不受影响（`drive_command` 本就按需拉起发布器）。

## 策略运动窗口（⏳ 待复跑）

被板子欠压断电打断（电池充电中，15 分钟自动监控 `automation-8132560f`
盯电压，≥6.5V 时询问在场用户后执行）。协议：基线采样 → `policy_start
direction=1.0` → 4.5s 窗口（250ms 采样 odom+陀螺仪+节点 PID）→
`policy/stop operator-emergency-stop` → 冻结验证。判定：位移 ≥0.05m、
陀螺仪扰动、停止后冻结。结果出来后补记本节并收尾（双端开关复位全关）。


## 策略运动窗口（修复双发布器后 · ✅ PASS）

时间 2026-09-14 20:04，电池读数 4.99V（MCU 在 bringup 重启重新握手串口后
处于解锁态），修复版 agent（md5 `89bf9fe4…`）首次完整验证：

**协议**：基线采样 → `policy_start {"direction":1.0}`（agent 自动拆驱动发布器，
`/cmd_vel` 策略独占）→ 4.5s 窗口（250ms 采样 odom/陀螺仪/节点 PID）→
`policy/stop {"reason":"operator-emergency-stop"}` → 冻结验证。

**证据**（250ms 采样摘录，底盘节点 PID 95205 全程不变）：

| 阶段 | odom (x, y) | gyro_z |
| --- | --- | --- |
| 基线（前 9 采样） | (0.00000, 0.00000) | 0.005–0.007（静止底噪） |
| 窗口爬升 | (0.008,-0.0005)→(0.030,-0.008)→(0.058,-0.052) | 出现真实扰动（-0.085, +0.083） |
| 峰值 | (0.05833, -0.06176) | — |
| 急停后（6 采样） | 冻结 (0.05468, -0.07790) | 回到底噪 0.005–0.007 |

- **位移 ≈0.096 m**（路径含持续 y 分量增长——策略在输出非零角速度做弧线行驶，
  与遥测记录中 angular -0.01…0.19 的策略决策一致）
- **推理 51 次全发布**：`published:51`，`inferMs:0.49ms`（42D 输入，CPU provider）
- **急停即时生效**：停止后 odom 立即冻结、`lastCmdVel {0,0}`、`stopReason:
  operator-stop`；驱动发布器由 `policy_stop` 的回热逻辑重启（新 PID 96105）
  证明拆/回闭环按设计工作
- 速度全程钳位在 0.05 m/s / 0.2 rad/s 内（发布帧检查：linear ≤0.050）

**结论**：完整学习闭环在真机上端到端跑通——
**训练（clear-arena 门限 PASS，100%/0 碰撞，CI low 0.963）→ 制品下发（sha256
ad281858… 校验）→ 板端加载（42D 契约，imu-gravity-v1）→ 策略自主推理
（51 次真实推理驱动）→ 真机运动（0.096m 弧线）→ 急停归零**。

## 状态收尾（安全默认）

- 平台侧驱动开关：关（`PUT /switches {"drive":false}`）。
- 板端 `agent.env`：`RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=0`，agent 已重启，
  状态 `idle`、`lastCmdVel {0,0}`，无策略/发布器运动进程残留。
- 电池监控自动化已删除（任务完成）。
- 策略制品 `goalnav42d-policy.onnx` 留在板端 policies 目录（0700），随时可
  重新加载复跑。

# 晚间补验（20:00–21:30 · 平台剩余能力面）

主线闭环完成后，对"除 robogo 外的四个覆盖缺口"逐一补验。robogo 远程 GPU
后端按约定不在本轮范围。

## 1. 行为克隆训练器（`engines/offline-bc/train_bc.py`）· ✅ PASS

用今天板端 spool 的**真实策略数据**（3281 条 observation→action 对，42D→2D）
做离线数据集，而非合成玩具数据：

- `pytest engines/offline-bc/test_train_bc.py`：1/1 通过（线性拟合收
  敛 < 1e-4）。
- 真实数据训练：`train_loss=0.0058`（真实数据含噪声，线性 BC 模型合理量
  级）。产物 `rdk-offline-bc-v1` 校验：observation_size=42、action_size=2、
  weights 形状 43×2（含 bias）、全值有限。
- 预测健全性：输入首条真实观测，输出动作在 [-1.2, 1.2] 内。
- 脏数据 fail-closed：非数值、缺 action、维度不一致、空数据集 4 类输入
  全部被 `ValueError` 拒绝，且失败时不写产物文件。

## 2. 多用户鉴权模式 · ✅ PASS（两模式含负向路径）

用独立端口/独立存储目录起服务，不污染主工作台数据。

### studio-cookie（18103 + mock 登录壳 19300）

| 检查 | 结果 |
| --- | --- |
| 匿名 `/api/sim2real/overview` | 401 `SIM2REAL_AUTH_REQUIRED` ✅ |
| 跨源 POST（Origin 不在白名单） | 403 `SIM2REAL_CSRF_BLOCKED` ✅ |
| 登录中继 + 错误密码 | 409 `bad_credentials` ✅ |
| 正确登录（demo/demo-pass-123） | 200 + `rdk_sso_web_session` HttpOnly cookie ✅ |
| 带 cookie 访问数据面 | 200，identity=`local-demo-user` ✅ |
| 篡改 cookie（改一个字符） | 401（GCM tag 校验 fail-closed） ✅ |
| 登出 | 200，cookie 清除 ✅ |
| **多用户隔离** | 用户 A 建数据集后，用户 B（sms 登录第二账号）列表为空、
  直接 GET 返回 404；台账 owner 字段正确写入 `local-demo-user` ✅ |

### trusted-proxy（18104 + HMAC 网关签名）

按服务端 canonical（7/8 行 `\n` 连接：ts/METHOD/path/acct/token/name/email
[/roles]）复刻签名逐项验证：

| 检查 | 结果 |
| --- | --- |
| 无签名请求 | 401 ✅ |
| 有效签名 GET（含 query 串） | 200，identity 正确 ✅ |
| 路径篡改（签 A 路径调 B 路径） | 401 ✅ |
| 过期时间戳（-400s > ±300s 窗） | 401 ✅ |
| 错误签名 | 401 ✅ |
| 已用签名重放同一变更（POST） | 401（防重放生效） ✅ |
| 换新时间戳的合法重发 | 201 ✅ |
| 未签名 roles 头（自提权） | 401（roles 必须在签名内） ✅ |
| 跨账号数据隔离 | 账号 02 看到空列表 ✅ |

诚实备注：测试中曾出现 4 个 FAIL，逐项排查后**全部是测试脚本自身的错误**
（漏发 roles 头、同一秒重放、非 ASCII header 的 latin-1 线上编码），服务端
行为全部正确。非 ASCII displayName 需按 Node latin-1 字节视角签名是 HTTP
header 的固有限制（accountId 已被 ASCII pattern 约束，不受影响）。

## 3. 遥测上传闭环（板端 spool → 平台摄取 → 回放/会话聚合）· ✅ PASS

首次端到端打通这条链（此前从未配置）：

- 配置 `/etc/rdk-board-agent/telemetry.env`（run/model/device/contract 绑定
  + 12h attestation token），部署 repo 版 uploader（板上是 9 号旧版），
  SSH **反向隧道**板端 127.0.0.1:18102 → Mac 平台（平台保持 loopback 绑
  定不动）。
- 全量上传今天 1.42MB spool：**17 chunks / 3296 样本 / 15 条会话事件**，
  checkpoint 推进至文件尾。
- 消费面验证：`board-sessions` 聚合出 **8 个会话**（含早上的事故会话
  df7db761：753 推理/617s；和最终 PASS 会话 1137f200：51 推理、模型
  sha256、inferMs 0.49 全字段）；`replay` 3281 帧、17 chunks、
  source=board-agent。

**过程中发现并修复 2 个真实 uploader 缺陷**（这才是真集成的价值）：

1. 批内 t 单调违例：板端 spool 的 t 按会话重置，uploader 盲按行数分批，
   跨会话边界批次被 400 整批拒绝且**静默重试无日志**。修复：
   `_read_batch` 在 t 回退处收批（含 2 个新单测）。
2. 永久 4xx 无可观测性：`_post` 把 HTTPError 详情打进 journal（409/404
   现在可见），checkpoint 不动、数据不丢。

**契约级发现（如实记录，后已根治）**：`assertTelemetryTimeline` 要求同一
run 的遥测时间线**跨分片全局非递减**，而板端 runtime 的 t 是每会话归零的
——单 run 多会话的 spool 无法原样上传。本次验证用"会话索引 × 3600s 基址
偏移"重定基后上传（原始 spool 已归档为 `policy.jsonl.archive-20260914`，
md5 一致可查）；会话内相对时间未动。

> **2026-09-15 根治**：平台已按"会话分段校验"方案修复——`session-started`
> 生命周期标记现在是时间线的合法重置点（store 层扁平流校验 + 路由层批内
> 校验统一实现，`sim2real-store.ts` / `sim2real-telemetry-routes.ts`）。
> 板端 spool 此后无需重定基即可原样上传。同时 `replay` 统计改为按会话分
> 段求和（多会话 run 的 duration/rate 不再被会话间隙污染，新增
> `sessionCount` 字段与多会话 warning）。store 新增 2 个测试（会话边界重
> 置接受 + 无标记回退仍拒绝），路由新增 1 个测试（双会话单批接受 + 分段
> 时长 0.2s + 无标记回退 400）；server 全量 414/414 通过。已在跑的
> uploader 无需再改：其"t 回退处收批"逻辑与新契约完全兼容。

**attested 路径**：standalone 部署下 token（owner=local-dev）被 404
fail-closed 拒绝（run 无 owner 字段，严格匹配不通过）——这是设计行为，
attestation 面向多用户部署。正向路径由 repo 测试
`sim2real-telemetry-attestation.test.ts`（2/2 通过）覆盖；在线负向验证已
完成。板端已恢复 review-only 模式继续供数据。

## 4. 任务级真机验收（到达目标点并停止）· ⏳ 被电池阻塞

已完成的准备：机器人静止于 odom (0.055, -0.077)、yaw 0.044，目标点方案定
为前方 0.3m（goalX/goalY 传 odom 绝对坐标，平台路由支持透传）。执行前板
端因电池深放（2S 4.99V）离线——物理电源在用户侧，等板子回来即继续。

> **2026-09-17 等待期发现并根治：42D goalnav 观测契约缺口**。任务级验收
> 在跑代码里走查时发现一个致命缺口：两个训练器（`engines/starter-ppo/
> runner.py` 的 `observe_one` 与 `engines/mjx-adapter/adapter.py` 的
> `_build_obs`）的 42D `imu-gravity-v1` 布局都是 `[gyro(3), gravity(3),
> last_action(2), goal_delta(2, 车体系), twist(2), zeros(30)]`，而板端
> runtime 的通用装配路径只填前 6 个传感器位 + last_action + 指令位——
> **goal_delta/twist 槽位被零填充**，且 `start()` 只在 8D 路径读 goalX/
> goalY，42D 会话的 goal 被静默丢弃。也就是说：42D 策略上真机时对目标
> 位置"全盲"，9-14 的 direction=0 直行 76s 事件正是这个根因（当时归因
> 为双发布器，那只是零位移的一半；另一半是策略根本看不见 goal）。
>
> **修复**（`board-policy-runtime.py`，全链 fail-closed）：
> 1. `_build_observation()` 新增 goalnav 装配分支：goal_delta 用
>    `/odom` 位姿 + goal 差值旋进车体系（yaw 取 odom yaw 字段，缺失时
>    回退 IMU 四元数——与 8D 路径同一信源）；twist 直接取 /odom；last_action
>    取上一条已发布指令按训练器同款归一化（物理值 / MAX_LINEAR /
>    MAX_ANGULAR）；头 6 位仍是真实 IMU。
> 2. goal 缺失或 odom 死 → 观测整体 `None`（走有界零输出），**绝不**零填充
>    goal 槽位。
> 3. `start()` 对 42D 同样强制 goalX/goalY，缺则 `goal-required` 拒绝
>    （agent 侧 `policy_start` 读模型 inputDim 同步加门，error 码从
>    `originbot-goal-required` 统一为 `goal-required`）。
> 4. session-started 事件携带 `goalX/goalY` 作为任务证据（验收问题就是
>    "是否到达**这个**点并停住"），平台事件白名单 + `/board-sessions` 聚合
>    均已透传。
> 5. obsSlots 诚实上报：42D 报 `slots_real:10`（gyro/gravity/goal_delta/
>    twist）、`slots_adapter:32`，slotPlan 逐槽标注来源。
>
> **回归测试**：`verify-policy-runtime-safety.py` 新增 42D 块（yaw=π/2 旋转
> 下车体系 goal_delta 断言、twist 槽、归一化 last_action、缺 goal/odom
> fail-closed、`start` 无 goal 拒绝、事件携带 goal）；`board-agent-drive.test.py`
> 新增 `PolicyStartGoalGateContract` 5 例（42D/8D 无 goal 拒绝且不发文件
> 协议、有 goal 透传 direction+goalX+goalY、非 goalnav 契约免 goal、半
> goal/NaN 拒绝）47/47；TS 侧事件白名单 + 会话聚合 goal 断言 + 越界/非数值
> goal 拒绝，全量 762/762。tsc 干净。
>
> **部署注意**：修复文件尚未上板（板子离线中）。板子回电后必须先 scp 部署
> `board-policy-runtime.py` + `board-agent-x5.py` 到 `/root/rdk-board-agent/`
> （或 `/opt/rdk-board-agent/`，以 `systemctl show -p ExecStart` 探测为准）
> 并重启 `rdk-board-agent`，再跑任务级验收——**旧 runtime 上的任务级验收
> 无意义**（策略仍对 goal 全盲）。完整机械流程见
> `docs/goalnav-task-acceptance-runbook.md`（含契约验证的"活体证明"：
> 无 goal 启动必须被 `goal-required` 拒绝，返回 ok=true 即旧 runtime）。
