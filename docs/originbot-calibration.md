# OriginBot 标定与 Sim2Real 参数闭环

`engines/rdk-rl-env/calibrate_originbot.py` 从 JSONL 运动记录估计采样周期、线速度增益、角速度增益和速度分位数。它接受浏览器/导入记录用于诊断，但只有 `source=board-agent` 的真实样本才能进入“ready-for-review”状态。

```bash
npm run calibrate:originbot -- /path/to/originbot-board.jsonl --out calibration.json
```

记录至少包含 `t`、odom 的 `x/y/yaw` 和 `action: [linear, angular]`；板端运行时同时写入 `source=board-agent`、实际发布的 `cmd_vel.linear/angular`、`controlHz` / `controlPeriodSeconds` 和一份最小 odom 快照。也可以直接把平台导出的 `source + samples[]` 遥测分片交给标定器，它会继承记录级来源。标定结果不会自动解锁部署，必须经过真实评测、预检和 Canary 闸门。

建议采集三段各 30 秒的动作：直行、原地旋转、低速 S 曲线。先检查 `sampling.estimatedHz` 和 `provenance`，再把 `drive` 参数映射到仿真配置。合成记录会明确返回 `blocked`，避免把演示轨迹当成真机标定。
