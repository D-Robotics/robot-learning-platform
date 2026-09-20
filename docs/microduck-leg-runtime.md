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
一个已限幅目标，不再做推理。

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
4. 通过板端 `/v1/station/policy/stop` 做急停，确认控制器停止接受目标并记录 `policy-runtime-state.json` 的 `lastOp`。
5. 只有在站立、恢复和行走的现场证据完成后，才把 profile 的 `provenance.kind` 从 `template` 提升为 `real`；当前仓库仍明确标记为模板，不伪造硬件成功率。

平台侧可直接运行：

```bash
npm run verify:hardware-profiles
npm run verify:joint-policy-runtime
npm run verify:task-pack
npm run verify:microduck-rl-adapter
```

部署脚本支持两种 profile。部署 MicroDuck 时使用
`RDK_X5_PROFILE_NAME=rdk-x5-microduck-leg.json`，并在板端
`/etc/rdk-board-agent/agent.env` 中把
`RDK_SIM2REAL_ADAPTER_CONFIG` 指向同名 profile；脚本会把关节运行时一起放入
`/opt/rdk-board-agent`。

这些检查覆盖软件契约和文件协议；它们不能替代真实舵机、控制器和跌倒保护测试。真实 X5 的动作效果仍需在接好 MicroDuck 硬件后按上述顺序验收。
