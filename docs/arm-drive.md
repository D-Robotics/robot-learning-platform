# D6A 机械臂受限驱动（arm_sdk · 2026-09-20）

D6A 桌面 6 轴臂通过板端常驻的 `arm_sdk` 服务（loopback `127.0.0.1:9339`）
接入平台，模式与差速底盘的受限驱动（`actuator-drive.md`）一致：
**双开关 + 双重钳制 + 恒可用急停**，只是执行器从 `/cmd_vel` 换成
笛卡尔位姿与夹爪。

## 当前状态（诚实边界）

- **软件链路已就绪**：机型 profile（`profiles/rdk-x5-d6a-arm.json`）、板端
  agent 的 arm 能力（预检/受限运动/夹爪/停止）、平台代理路由、agent 工具、
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

`POST /api/sim2real/board-station/arm/stop` **恒可用**：拒绝一切新命令并
尽力回 `home`。但 `arm_sdk.move_to` 是**阻塞调用**——正在进行的移动无法被
软件打断，这一点在响应里如实回报（`wasMoving`）。最终安全底线是机械臂
自身的物理急停。

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
| `/api/v1/duck/board-station/arm/stop` | POST | 拒新 + 尽力回 home（恒可用） |

Agent 工具：`rdk_board_arm_status`（只读）/ `rdk_board_arm_move` /
`rdk_board_arm_gripper` / `rdk_board_arm_stop`；`rdk_board_stop` 现已同时
覆盖策略、底盘与机械臂。

## 真机验收清单（待 D6A 接线后执行）

1. `deploy-x5-board-agent.sh` 部署后，healthz 出现 `arm-preflight`；
2. `GET /board-station/arm` 返回真实位姿（`mock:false`）；
3. 双开关全关 → `arm/move` 409 且板端零调用；
4. 双开关开启 + 操作者在场 → 一次低速（≤60 mm/s）盒内移动 + 一次
   夹爪开合 + `arm/stop` 回 home；
5. 上述证据（含遥测/日志）归档到 `docs/` 或 `evidence/` 后，才更新本文件
   状态与 README 能力表。
