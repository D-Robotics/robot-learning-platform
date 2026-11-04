---
name: devices-board
description: 通过 RDK 学习平台连接设备、检查 BoardAgent 和传感器、暂存加载策略并执行受控策略或 D6A 机械臂动作及停止。
---

# 设备、策略与机械臂

交付真实设备状态或受控动作证据。参数见 [工具目录](../../references/tool-catalog.md)，运动和重试边界见 [连接契约](../../references/connection-contract.md) 与 [设备契约](../../references/device-contracts.md)。

新用户从仿真到板端的逐项验收见 [用户工作流](../../references/user-journeys.md)。明确本次目标设备及“不运动纯推理”或“实体动作”的用户结果，不从连接成功推断本体、传感器和模型都可用。connectionId 用于连接记录，deviceId 用于平台设备选择；按读取结果核对实际目标关系，不用未经核对的首条历史记录。

- `rdk_device_discover` 列出当前账号已登记连接，不扫描整个网络。没有连接时用工作台设备管理添加；MCP 没有添加 SSH 坐标的工具。`rdk_device_connect(connectionId)` / `rdk_device_disconnect(connectionId)` 操作已有连接。
- 只读验收用 `rdk_board_health`、`rdk_board_onboarding_preflight`、`rdk_board_station_status`、`rdk_board_policy_status`、`rdk_board_policy_files`。`rdk_board_station_command(id)` 仅执行现有白名单命令 ID，不是任意 shell。多个设备时所有 station 类参数显式带实际 `deviceId`。
- 策略依次按实际请求暂存 `rdk_board_policy_stage(runId)`、核对文件摘要、加载 `rdk_board_policy_load(path, artifactSha256, rehearsalReceipt)`。暂存、加载和启动是三个独立动作；前两步不授权运动。加载参数 `path` 是策略目录内文件名，不能任意路径。
- `rdk_board_policy_start` 实际必需数值 `direction`，可带 `goalX` / `goalY`。平台/板端开关、契约、来源与现场条件都满足且已有用户动作授权时才调用；`rdk_board_policy_reset` 是显式故障复位。
- 机械臂先 `rdk_board_arm_status` 核对能力/位姿/工作空间。`rdk_board_arm_move` 必需 `x/y/z`（mm），速度为 `speedMmPerS`；`rdk_board_arm_gripper` 必需 `action=open|close` 和正数 `value`（open=宽度 mm，close=力）。不把照片推测坐标当标定，不超出平台钳制。
- 取消运动/异常时调用相应 `rdk_board_stop` 或 `rdk_board_arm_stop` 并回读状态；arm stop 会尽力回 home，本身可能移动，需如实说明 `homed` 与 `wasMoving`。急停投递失败意味着设备状态未知，不能宣称已经停止。

机械臂 SDK 已进行的阻塞 move 无法由软件 stop 保证打断；`wasMoving=true` 不等于动作被中止。只报告实际回读状态，现场物理急停能力由设备提供。

失败、超时或不明结果的物理动作不自动重试；先读状态并按 MCP 现有纪律取得用户重新确认。不得经 SSH/私有端点绕过安全开关，不为完成任务自动开启运动开关。只有只读状态请求可按有界策略重试。

设备坐标登记/删除、受控开关配置、Local Bridge 和不运动的 batch `policy-infer` 见 [版本化 API 工作流](../../references/api-workflows.md)。上板安装、硬件适配、相机/TROS、校准与纯推理延迟测试的真实 CLI/工作台入口见 [仓库能力](../../references/cli-capabilities.md)，没有连接或本体未装好时可完成软件/只读检查并明确未完成实体运动验收。

本体未接好时，可用仓库的 `scripts/verify-platform-plugin-board-inference.py` 在显式选择的板卡隔离目录加载原始 ONNX，核对 SHA、61D→14D 的 CPU 数值与主机结果。它会复制文件、写收据，但不连接 ROS 或启动策略；测试向量是 synthetic 数值输入，不能称为真实板端遥测、运动成功或部署质量门通过。调用与缺依赖处理见 [仓库能力](../../references/cli-capabilities.md)。

结果用用户可理解的阶段说明：已连接、已暂存、已加载、纯推理已核对或实体动作已验证，再附 ID/摘要和下一步；仅有“online=true”不足以说设备可部署。

## 关节速度命令

板端策略启动使用 `rdk_board_policy_start`，只传当前工具 schema 声明且目标平台支持的字段。当前 main 的 MCP 未提供运行中速度命令更新工具，不宣称具备该入口；需要此能力时先核对部署方实际工具目录与控制契约，不用其他调用模拟实时控制。模板档案不能启动；必须完成实际本体关节、HOME、限位与急停校准。Agent 低频工具调用不能代替实时控制循环。无可运行本体时只做零致动推理验收，不声称站立或行走通过。
