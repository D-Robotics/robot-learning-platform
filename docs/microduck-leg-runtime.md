# MicroDuck 腿式运行链路

平台现在把 MicroDuck 腿式机器人和轮式 OriginBot 分成两条硬件契约。选择
`microduck-stand`、`microduck-walk`、`microduck-kick` 或
`microduck-recover` 时，任务包会固定使用 `microduck-rl`，并把
`61D observation → 14D joint-position-offset` 传给训练引擎。任务解析器不会
把这类任务降级到 starter-ppo 或 `/cmd_vel`。

工作台现有的短任务名 `walk`、`kick`、`recover`、`sit` 会自动解析到对应的
完整任务包，因此历史运行记录和 UI 文案不需要迁移。

板端使用 `profiles/rdk-x5-microduck-leg.json` 与
`adapters/microduck-leg.json`。当 `actuator.kind` 为 `joint` 且没有显式设置
`RDK_BOARD_POLICY_RUNTIME` 时，`board-agent-x5.py` 会自动启动
`board-joint-policy-runtime.py`。运行时只接受 61D 输入、14D 输出，读取带源
时间戳的 IMU 和 `/joint_states` 快照，按 profile 中的 14 个关节名重排，然后
把归一化动作转换为相对 home 位姿的目标角度。每周期同时受 `actionScaleRad`、
`maxJointStepRad` 和 `maxJointVelocityRadSec` 限制；传感器缺失或过期时保持最后
一个已限幅目标，不再做推理，同时清除当前行走命令。传感器恢复后可以继续零速度
命令的平衡推理，但不会自动恢复失联前的行走速度；操作员需要确认状态，再发出
新的有限时命令。

## Studio 三轴行走命令

Studio 经认证的平台接口访问板端，浏览器不直接驱动关节。启动和更新行走命令都
要求设备属于当前账号可见范围、账号具备 `operate` 权限，并同时开启平台的
`RDK_SIM2REAL_STATION_POLICY_ENABLED` 与
`RDK_SIM2REAL_STATION_DRIVE_ENABLED`。板端仍独立检查运动授权、运行状态、传感器
源时间和 profile 限制；接口可达或模型已加载不等于允许运动。

平台版本化接口为 `/api/v1/duck/board-station/policy/start` 和
`/api/v1/duck/board-station/policy/command`，兼容别名为
`/api/sim2real/board-station/policy/*`。通过 Studio 子目录访问时，客户端沿用当前
工作台的 API 前缀；用 `deviceId` 查询参数选择已绑定的设备。关节策略启动请求：

```json
{
  "direction": 0,
  "command": { "linearX": 0.05, "linearY": 0, "angularZ": 0 },
  "durationSec": 1
}
```

已运行的策略通过 `policy/command` 更新速度，正文只包含 `command` 和可选的
`durationSec`。三个速度字段必须全部提供有限数值，`linearX`、`linearY` 单位为
m/s，平台允许绝对值最多 0.3；`angularZ` 单位为 rad/s，绝对值最多 1。板端按实际
profile 施加更窄的限值，越界拒绝执行。字符串、布尔值、数组、缺少速度字段和
未知字段均拒绝。关节策略的 `direction` 只能省略或为数值 0，不能混用轮式的
`goalX`、`goalY`；原轮式请求保持原契约。

`durationSec` 默认 1 秒，只接受 0.2..2 秒。非零命令到期后，板端将三轴速度归零，
即使网页断连或不再发送命令，也不会继续沿用旧速度。归零命令用于停止步态请求，
运行时仍可做零速度的平衡推理。新的非零命令要求实时传感器有效；失联清除命令后，
不会因传感器恢复而复活旧命令。旧板端或不支持三轴命令的运行时可以明确拒绝，
Studio 应展示其原始拒绝原因，不把拒绝显示为执行成功。

板端状态提供 `command`、`commandRemainingSec`、`commandStopReason`、
`sensorFresh`、`sensorState` 和 `stopBehavior`，用于显示实际剩余时间与停止原因。
`policy/stop` 不依赖平台运动开关：它清除速度并结束策略循环，关节运行时保持最后
一个已限幅目标（`hold-last-bounded-target`），不代表关闭舵机力矩或硬件断电。
真实控制器如何保持目标、看门狗如何响应和跌倒如何保护，必须单独在硬件上验收。

在板子上启用前，先完成只读预检：

```bash
node scripts/verify-hardware-profile.mjs
node scripts/verify-hardware-adapters.mjs
python3 scripts/verify-joint-policy-runtime.py
```

然后在 X5 的 TROS 环境中确认以下事实与 profile 一致：

1. `/imu`、`/joint_states` 和 `/microduck_controller/joint_trajectory` 的消息类型、QoS、关节名称顺序。
2. home 位姿、关节限位、舵机方向和控制器 watchdog；这些值必须回填 profile 后再训练或加载制品。
3. 先只读运行 60 秒，确认快照的 `sampleMonotonicNs` 连续且无缺关节，再做站立小幅动作。
4. 验证非零命令到期归零、传感器失联清除命令，以及恢复后不自动行走；通过板端
   `/v1/station/policy/stop` 确认策略停止且保持最后限幅目标，并记录
   `policy-runtime-state.json` 的 `lastOp`。另行确认真实控制器的停止、力矩和看门狗行为，
   不用软件应答替代硬件急停验收。
5. 只有在站立、恢复和行走的现场证据完成后，才把 profile 的 `provenance.kind` 从 `template` 提升为 `real`；当前仓库仍明确标记为模板，不伪造硬件成功率。

平台侧可直接运行：

```bash
npm run verify:hardware-profiles
npm run verify:joint-policy-runtime
python3 services/sim2real-web/board-joint-policy-runtime.test.py
npm run verify:task-pack
npm run verify:microduck-rl-adapter
```

部署脚本支持两种 profile。部署 MicroDuck 时使用
`RDK_X5_PROFILE_NAME=rdk-x5-microduck-leg.json`，并在板端
`/etc/rdk-board-agent/agent.env` 中把
`RDK_SIM2REAL_ADAPTER_CONFIG` 指向同名 profile；脚本会把关节运行时一起放入
`/opt/rdk-board-agent`。

本次上线仅交付 Studio 界面、平台代理和配套板端运行时的软件代码，不包含向实体
板卡安装运行时、下发运动命令或真机行走验收。上述检查覆盖软件契约和文件协议；它们不能替代真实
舵机、控制器、跌倒保护和人体跟随闭环测试。真实 X5 的动作效果仍需在接好
MicroDuck 硬件后按上述顺序验收；模板 profile 不因软件发布自动成为真机证据。
