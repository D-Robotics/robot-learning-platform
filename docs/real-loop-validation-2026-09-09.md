# 真实端云真机闭环验证记录

- 日期：2026-09-09
- GPU：120.48.90.140 · NVIDIA RTX 5090 32GB · CUDA 可用
- X5：10.185.136.180 · D-Robotics RDK X5 V1.0 · RDK 3.1.1
- 最新 GPU Run：`local-microduck-ppo-gpu-8c10760f-9872-458a-880c-860704538923`（completed）
- 完整录屏：[real-loop-demo-2026-09-09-full.mp4](./real-loop-demo-2026-09-09-full.mp4)（约 4 分 34 秒，含仿真 + GPU + X5 上位机；文件已移出 git，本地目录或 Release 附件获取）
- 仿真段：[simulation-demo-2026-09-09.mp4](./simulation-demo-2026-09-09.mp4)（约 42 秒，MuJoCo WASM / 50Hz / 前进动作；同上）
- 记录明细：[real-loop-validation-2026-09-09.json](./real-loop-validation-2026-09-09.json)

## 已通过

| 环节 | 结果 | 证据 |
| --- | --- | --- |
| 浏览器仿真 | 通过 | 官方 MicroDuck Space 已安全接入，MuJoCo WASM / 50Hz，3D 场景和前进动作已录制 |
| GPU worker | 通过 | RTX 5090，`cuda=true` |
| GPU PPO | 通过 | Run `local-microduck-ppo-gpu-8c10760f-9872-458a-880c-860704538923`，5 iterations，`mock=false` |
| ONNX 导出 | 通过 | `artifact://starter/microduck-ppo-gpu/0.1.2/policy.onnx`，9,697 bytes |
| ONNX 维度 | 通过 | `[batch, 61] → [batch, 14]` |
| X5 BoardAgent | 通过 | systemd active/enabled，`mock=false` |
| X5 TROS | 通过 | `/imu`、`/odom`、`/originbot_status`、`/cmd_vel` |
| X5 相机 | 通过 | `/dev/video0`、`/dev/video1`，录屏已显示 MJPEG |
| 真实遥测 | 通过 | CPU、温度、内存、网络、IMU、odom、电池实时回读 |
| 策略加载 | 通过 | X5 ONNX Runtime：`state=ready`，61→14 |
| 只读部署预检 | 通过 | BoardAgent 读取板型、系统和磁盘信息 |
| 策略启动闸门 | 按预期阻断 | HTTP 409：`SIM2REAL_STATION_DRIVE_DISABLED`，电机未开启 |
| 策略停止/急停 | 通过 | HTTP 200，输出归零，底盘看门狗兜底 |

## 当前结论

软件和真实设备链路已经跑通到“GPU 训练 → ONNX 制品 → X5 加载 → 真实遥测 → 策略状态机 → 只读预检 → 安全停止”。本次没有开启驱动开关，因此未让机器人运动；策略启动请求被安全门控按预期拒绝。

当前策略质量指标仍需继续训练：本次 smoke Run 成功率 0%、跌倒率 100%，这属于训练效果问题，不是端云链路故障。进入低速 Canary 前，应先取得更好的评测指标，再确认安全区域、急停可用，并同时开启平台驱动、平台策略和板端驱动/策略开关。

## 软件回归验证

- `npm test -- --run`：16 个测试文件、130 个测试通过。
- `npm run verify:real-loop`：通过（遥测形状、策略 watchdog、维度闸门、耐久上传和 BoardAgent wiring）。
- Python 语法检查：`board-telemetry-node.py`、`board-policy-runtime.py`、`board-telemetry-uploader.py` 通过。
