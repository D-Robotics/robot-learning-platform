# D6A 机械臂受限驱动（arm_sdk · 2026-09-20）

D6A 桌面 6 轴臂通过板端常驻的 `arm_sdk` 服务（loopback `127.0.0.1:9339`）
接入平台，模式与差速底盘的受限驱动（`actuator-drive.md`）一致：
**双开关 + 双重钳制 + 恒可用急停**，只是执行器从 `/cmd_vel` 换成
笛卡尔位姿与夹爪。

## 当前状态（诚实边界）

- **软件链路已就绪**：机型 profile（`profiles/rdk-x5-d6a-arm.json`）、板端
  agent 的 arm 能力（预检/受限运动/夹爪/停止/恢复）、平台代理路由、agent 工具、
  契约测试与 API 文档均已落地并有测试覆盖。
- **真机验收未做**：D6A 尚未在平台上接线跑过预检与受限运动。在完成一次
  真机预检与一次低速受控运动验收前，不应声称 D6A 闭环可用。

## 双开关

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| 平台侧 `RDK_SIM2REAL_STATION_ARM_ENABLED`（可经 station switches 运行时覆盖） | 关 | 关闭时代理直接 409，命令不下发 |
| 板端 `RDK_SIM2REAL_BOARD_AGENT_ENABLE_ARM`（agent.env） | 关 | 关闭时板端拒绝一切致动 |

只读位姿预检单独由 `RDK_SIM2REAL_BOARD_AGENT_ENABLE_ARM_PREFLIGHT`
（默认开）控制——它只调用 `get_pose()`，绝不致动。

## 钳制（两层独立执行，声明见 profile）

- 工作空间盒：x∈[120,450]、y∈[-250,250]、z∈[20,320]（mm，基座系）；
- 速度：`speedMmPerS` ≤ 120（代理与板端各钳一次）；
- 夹爪：close 力 ≤ 20、open 宽度 ≤ 65 mm；
- 频控：两次致动命令间隔 ≥ 400 ms，进行中的移动拒绝第二条。

## 急停语义（如实声明）

`POST /api/sim2real/board-station/arm/stop` **恒可用**：设置停止锁定，拒绝
后续移动和夹爪命令，**不会发出回 home 或其他 SDK 致动**。但
`arm_sdk.move_to` 和夹爪操作是阻塞调用，正在进行的调用无法被软件打断。
响应如实回报 `wasMoving`、`moving`、`stopRequested:true`、
`interrupted:false`、`homed:false`；状态中的 `moving` 会保持为 true，直到
正在执行的 SDK 调用返回。SDK 执行中及停止响应只返回缓存位姿，避免停止
响应等待另一个 SDK 调用；空闲时的只读位姿预检仍可调用 `get_pose()`。
最终安全底线是机械臂自身的物理急停。

板端 agent 每次启动或重启即进入 `stopRequested:true`，不会静默解除上次
的停止锁定。停止锁定在 SDK 调用结束后仍保留。操作者确认现场安全后，显式调用
`POST /api/sim2real/board-station/arm/reset` 解除锁定；请求体为空或 `{}`。
恢复要求平台和板端两个 arm 开关均开启，多用户部署另要求
`sim2real:operate` 权限。仍有 SDK 操作执行中时返回 409
`move-in-progress`；板端开关关闭时返回 409 `arm-disabled`。成功响应为
`{ok:true, stopRequested:false, moving:false}`，恢复只修改状态，不调用 SDK，
也不会自动开始运动。启动默认锁存不改变双开关配置，不写持久文件或发出
SDK 致动；运动开关仍按 `agent.env` 配置门控。

## 能力探测与诚实降级

- 板上无 `arm_sdk`（或预检关闭）→ healthz 不通告 `arm-preflight`；
- 预检开 + 运动开关关 → 通告 `arm-preflight`，无 `constrained-arm-drive`；
- 任何情况下 arm 状态里 `mock` 恒为 `false`——SDK 缺失时"不可用"就是
  "不可用"，绝不模拟。

## API 一览

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/v1/duck/board-station/arm` | GET | 位姿预检 + 能力 + 平台开关态 |
| `/api/v1/duck/board-station/arm/move` | POST | 钳制后的单点移动（受双开关门控） |
| `/api/v1/duck/board-station/arm/gripper` | POST | 夹爪 close(force)/open(width) |
| `/api/v1/duck/board-station/arm/stop` | POST | 停止锁定；不致动，不打断正在执行的 SDK 调用（恒可用） |
| `/api/v1/duck/board-station/arm/reset` | POST | 空闲时解除锁定；不致动，受双开关与操作者权限门控 |

Agent 工具：`rdk_board_arm_status`（只读）/ `rdk_board_arm_move` /
`rdk_board_arm_gripper` / `rdk_board_arm_stop` / `rdk_board_arm_reset`；`rdk_board_stop` 现已同时
覆盖策略、底盘与机械臂。

`npm run verify:arm-acceptance` 只发送 GET，读取服务健康与机械臂真实状态，
然后打印人工验收清单；即使双开关已开启，也不会发送移动、夹爪、停止或
恢复请求。退出码 0 也可能表示 SKIP/PENDING，必须看输出，不能当作完成
真机运动验收。无硬件安全回归用
`node --test scripts/verify-arm-acceptance.test.mjs`，以本地 HTTP 假服务记录
真实子进程请求，断言全部为 GET，并拒绝 mock 或缺失硬件身份的假通过。

## 真机验收清单（待 D6A 接线后执行）

1. `deploy-x5-board-agent.sh` 部署后，healthz 出现 `arm-preflight`；
2. `GET /board-station/arm` 返回真实位姿（`mock:false`）；
3. 双开关全关 → `arm/move` 409 且板端零调用；
4. 确认启动即锁存，双开关开启 + 操作者在场后显式 `arm/reset` → 一次
   低速（≤60 mm/s）盒内移动 + 一次
  夹爪开合；`arm/stop` 后不应出现回 home，继续移动/夹爪应被 `arm-stopped`
   拒绝，SDK 仍在执行时不得报告 `moving:false`；
5. 空闲且现场确认安全后执行 `arm/reset`，确认无新运动；双开关任一关闭、
   无操作者权限或 SDK 仍在执行时恢复均应被拒绝；
6. 上述证据（含遥测/日志）归档到 `docs/` 或 `evidence/` 后，才更新本文件
   状态与 README 能力表。
