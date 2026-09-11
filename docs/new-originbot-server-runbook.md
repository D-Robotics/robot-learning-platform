# 新服务器 + 新 OriginBot 全链路手册

这份手册描述拿到一台新的 GPU 服务器和一台新的 RDK X5 OriginBot 后，如何用平台完成：仿真 → 数据采集 → 训练 → ONNX → HBDK/BPU → X5 加载 → 真实遥测 → 低速策略闭环。

## 先看结论

平台已经支持完整的工程通路，但“可运行”与“可发布”是两件事：

| 环节 | 自动化程度 | 发布要求 |
| --- | --- | --- |
| 浏览器仿真、任务契约、轨迹回放 | 自动 | 仿真证据只能证明软件流程 |
| GPU 训练、ONNX 导出 | 自动 | 必须记录 `mock=false`、GPU 型号和指标 |
| HBDK 编译 `.bin` | 半自动 | 新 X5 必须提供匹配的 HBDK/OpenExplorer 工具链 |
| X5 stage/load/BPU 推理 | 自动 | artifact SHA-256、输入输出契约必须匹配 |
| 真实相机/IMU/里程计采集 | 自动 | 相机设备、TROS topic 和时间戳必须稳定 |
| 真实图像-动作训练 | 需要数据 | 必须有人工示教或经过审查的动作标签 |
| 低速运动 | 受控自动 | 现场安全确认、急停和双开关必须通过 |

平台不会把 mock、synthetic 或静止零动作数据标成真实发布证据。

## 1. 新 GPU 服务器准备

平台提供只读服务器 onboarding 探针，不执行任意远程 shell：

```bash
RDK_GPU_HOST=<server-ip> RDK_GPU_PORT=22 RDK_GPU_USER=<user> \
RDK_GPU_DIR=/opt/rdk-sim2real \
node scripts/onboard-gpu-server.mjs --json
```

它会检查 SSH、公钥认证、`nvidia-smi`、Python、worker、虚拟环境和 HBDK。

推荐 Ubuntu 22.04、Python 3.10/3.11、CUDA 与 GPU 驱动匹配。服务器上安装仓库和依赖：

```bash
git clone <platform-repository>
cd rdk-robot-learning-platform-public
npm ci
npm run doctor
```

确认 `doctor` 能看到 Node、Python、PyTorch/ONNX 和 GPU。GPU worker 使用独立端口，例如：

```bash
RDK_SIM2REAL_TRAIN_EXECUTABLE=/absolute/path/to/python \
RDK_SIM2REAL_TRAIN_ARGS_JSON='["/absolute/path/to/engines/rdk-rl-env/train_originbot.py"]' \
npm run dev:local-worker
```

生产部署不要使用 mock worker；设置 `RDK_SIM2REAL_LOCAL_RUNNER_MODE=real`，并使用持久化 `RDK_SIM2REAL_STORAGE_DIR`。

服务器验收：

```bash
npm run verify:starter-engine
npm run verify:local-worker
npm run demo:originbot
```

GPU 训练结果必须包含 `mock=false`、`cuda=true`（或明确的 CPU 结果）、设备名称、训练指标和 ONNX artifact。

## 2. X5/OriginBot 准备

板端需要：

- Ubuntu/RDK X5 与可用 TROS；
- `/imu`、`/odom`、底盘状态和 `/cmd_vel`；
- 可访问的 `/dev/video*` 相机；
- `hobot_dnn`/BPU runtime；
- board-agent systemd 服务。

在板端安装 board-agent，生成独立 token，并设置环境文件：

```ini
RDK_SIM2REAL_BOARD_AGENT_TOKEN=<随机长 token>
RDK_SIM2REAL_BOARD_AGENT_PORT=19100
RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=0
RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY=0
RDK_SIM2REAL_MAX_LINEAR=0.05
RDK_SIM2REAL_MAX_ANGULAR=0.2
```

新设备第一次必须保持两个运动开关关闭。启动后从平台执行：

```bash
npm run verify:device-connections
npm run verify:board-agent
npm run verify:board-drive
```

并检查：

```text
mock=false
camera.devices 非空
imu/odom 数据持续更新
drive.active=false
policy.state=stopped 或 idle
```

## 3. 配置平台与设备连接

新服务器和新 OriginBot 的只读接入验收：

```bash
RDK_ACCEPTANCE_SERVER_HOST=<server-ip> \
RDK_ACCEPTANCE_BOARD_URL=http://<originbot-ip>:19100 \
RDK_SIM2REAL_BOARD_AGENT_TOKEN=<token> \
npm run accept:new-device -- --json
```

该命令不会启动训练、上传模型、打开驱动或发送运动指令；任何前置条件不满足都会明确返回 `blocked`。

服务器 `.env` 至少设置：

```ini
RDK_SIM2REAL_PORT=18102
RDK_SIM2REAL_STORAGE_DIR=/opt/rdk-robot-learning-platform/data
RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19091/train
RDK_SIM2REAL_LOCAL_RUNNER_MODE=real
RDK_SIM2REAL_BOARD_AGENT_URL=http://<originbot-ip>:19100
RDK_SIM2REAL_BOARD_AGENT_TOKEN=<same token>
```

共享部署必须走 trusted proxy 或 Studio cookie 鉴权，不要把 board-agent 或 Web 端口直接暴露到公网。

## 4. 仿真与任务契约

先在浏览器打开 OriginBot 仿真，确认：

1. 任务 profile 能加载；
2. 轨迹可以录制、回放；
3. observation/action schema 与设备 profile 一致；
4. 仿真 run 被标记为 synthetic/mock，不进入真实发布证据。

OriginBot 原生运动策略契约是：

```text
observation: [x, y, sin(yaw), cos(yaw), goal_dx, goal_dy, v, w]
action:      [linear, angular]
```

## 5. 真实数据采集

平台可以自动同步采集：

- 相机帧；
- IMU；
- 里程计；
- 当前动作和时间戳；
- board-agent 状态与 mock 标记。

自动 scripted excitation 只能验证链路。要训练有意义的视觉控制策略，必须进行人工示教或提供审查过的动作标签。采集结果必须包含：

```json
{
  "realSensor": true,
  "actionLabeled": true,
  "mock": false,
  "timestamp": 0,
  "image": "images/000001.jpg",
  "action": {"linear": 0.03, "angular": 0.1}
}
```

采集前确认机器人处于安全区域；采集结束必须调用 stop 并核对 `drive.active=false`。

## 6. GPU 训练与导出

训练阶段由平台提交 run 到 GPU worker。每个 run 应保存：

- dataset id 和 provenance；
- GPU 型号、CUDA 状态；
- 训练超参数和指标；
- ONNX opset、输入输出 shape；
- `synthetic`/`realSensor`/`actionLabeled` 标签。

只有真实图像和真实动作标签的数据，才可以进入 real-policy 候选；synthetic policy 只能用于仿真和 BPU 链路验证。

## 7. HBDK/BPU 编译

HBDK 必须安装在 x86 Linux GPU/编译服务器或官方 OpenExplorer 容器中，不要假设 X5 上存在编译器。典型流程：

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install rdkx5-yolo-mapper
hb_mapper --version

hb_mapper makertbin \
  --model-type onnx \
  --model policy.onnx \
  --config config.yaml \
  --march bayes-e
```

平台必须保存编译器版本、`march`、校准集、artifact 大小和 SHA-256。缺少 HBDK 时，平台应返回 blocked，不能把 ONNX 改名成 `.bin`。

## 8. 上传、加载和 BPU 推理

平台顺序固定为：

1. `/policy/upload`：大小和 SHA-256 校验；
2. `/policy/load`：检查输入输出 shape 和 provider；
3. `hobot_dnn` 原生加载 `.bin`；
4. 只读运行一次 forward；
5. 检查 `provider=hobot_dnn`、`inputShape`、`outputShape` 和 `lastError`。

任何模型加载失败都不得回退到 CPU 假装 BPU 成功。

## 9. 低速策略闭环

现场确认后才打开 drive/policy 开关。建议新设备第一轮：

- `maxLinear=0.05 m/s`；
- `maxAngular=0.2 rad/s`；
- 目标点距离不超过 0.1 m；
- 运行 1–2 秒；
- 自动 stop；
- 核对发布帧数、平均推理时间、遥测和最终零速。

闭环验收条件：

```text
policy.state: ready -> running -> idle
provider: hobot_dnn
published > 0
lastError: null
drive.active: false after stop
linear=0, angular=0 after stop
```

急停始终可用，即使策略或 drive 开关关闭也必须发送零速。

## 10. 发布门禁

只有同时满足以下条件才可标为 real-policy release：

- 真实相机数据和真实动作标签；
- 训练结果 `mock=false`；
- ONNX artifact 可复现；
- HBDK `.bin` SHA-256 已登记；
- X5 `hobot_dnn` load/forward 证据；
- 真实遥测回放和评测；
- 现场低速闭环证据；
- 急停、watchdog、故障停止测试通过。

否则应标记为 `synthetic`、`evidence-only` 或 `blocked`，不能解锁真机发布。

## 11. 故障恢复

- **GPU 不可见**：先运行 `npm run doctor`，确认 CUDA/PyTorch，再降级为明确标记的 CPU 训练。
- **HBDK 缺失**：安装匹配版本或使用官方容器；不生成伪 artifact。
- **相机连续采集掉线**：先停止运动，检查 `/dev/video*`、TROS camera node、USB/MIPI 电源和网络；分段采集，不要无限重试。
- **board-agent 不可达**：确认 IP、端口、token、systemd 状态；恢复后先只读检查。
- **策略 fault/遥测 stale**：运行 policy stop 和 drive stop，修复传感器后 reset；禁止绕过 stale gate。
- **存储冲突**：保持 writer lease；只读副本使用 `RDK_SIM2REAL_STORAGE_READ_ONLY=1`。

## 当前诚实边界

本手册的通路已经在 OriginBot/X5 上验证到真实 BPU 推理和低速策略输出。新设备/新服务器可以按此流程完成配置，但真正泛化的视觉策略质量仍取决于新设备的相机标定、真实动作数据和任务定义；平台不会替用户凭空制造这些信息。
