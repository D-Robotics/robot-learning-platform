# OriginBot 平台全能力演示脚本

本脚本演示 OriginBot 从适配、训练、评测到 X5 策略加载的完整平台能力。默认不让机器人运动；最后的 Canary 只有在操作者确认安全区域后执行。

## 0. 演示前检查

```bash
npm ci
npm run demo:originbot-live   # 一键只读体检：连接、遥测、闸门状态（见下）
npm run verify:live-board
curl http://127.0.0.1:19092/healthz   # GPU SSH 隧道
curl http://127.0.0.1:18104/api/sim2real/board-station/status
```

应看到真实 X5（`mock=false`）、OriginBot 传感器和 GPU Worker `configured=true`。

`npm run demo:originbot-live`（[scripts/demo-originbot-live.mjs](../scripts/demo-originbot-live.mjs)）是演示的一键入口，等价于 runbook 第 6/9 节的只读部分：

```bash
npm run demo:originbot-live                    # 连接体检 + 遥测快照 + 闸门状态 + 演示入口
npm run demo:originbot-live -- --watch 30      # 1 Hz 遥测流（电压/航向/里程计/CPU）
npm run demo:originbot-live -- --stop          # 急停（绕过所有开关，恒可用）
npm run demo:originbot-live -- --require-real # 彩排后切真机：连的还是 mock 时以码 2 失败
```

连接 mock 参考 agent 时它会明确标出 `mock=true` 并给出接真机三步；连真机后显示 `mock=false`。

接真机有两条等价路径：

- **网页内（推荐，免命令行）**：上位机页「设备管理」面板填板卡 IP → 添加 → 连接（服务端自动建 SSH 隧道并探测 agent）；「运动开关」面板里开平台/板端两侧开关。详见 [docs/host-station.md](host-station.md) 的「网页添加真机」一节。
- **命令行（脚本化）**：新板先运行 `RDK_X5_SSH_TARGET=root@<IP> ./scripts/install-x5-board-agent.sh` 完成显式 unit/目录初始化；确认环境后再运行 `RDK_X5_SSH_TARGET=root@<IP> ./scripts/deploy-x5-board-agent.sh` 更新代码。板卡 IP 写入 `.env` 的 `RDK_SIM2REAL_BOARD_AGENT_URL=http://<IP>:19100` 后重启工作台（或用 `ssh -N -L 19100:127.0.0.1:19100 root@<IP>` 隧道）。初始化脚本默认不启动服务，按 runbook 审阅 token 后再单独启用 agent。

## 1. 启动平台与打开 OriginBot 产品线

```bash
npm run dev:sim2real
# 打开 http://127.0.0.1:18104/
```

在侧栏项目卡的产品线下拉中选择 **OriginBot**，展示产品 Profile、硬件适配器、任务模板和设备上下文。

## 2. 展示多设备适配能力

```bash
npm run verify:hardware-profiles
npm run verify:task-templates
node scripts/create-robot-adapter.mjs demo-device diff-drive "Demo RDK Device"
```

脚手架演示后删除 `adapters/demo-device.json` 和 `profiles/demo-device.json`，不要把未完成模板用于部署。

## 3. 生成 OriginBot 仿真证据

```bash
npm run demo:originbot -- 200 --out /tmp/originbot-sim.jsonl
```

打开评测页导入 `/tmp/originbot-sim.jsonl`，展示轨迹、IMU、odom、电池、动作、reward 和来源标签。该数据是本地运动学仿真，页面应显示 `originbot-sim`，不能当作真实硬件证据。

## 4. 发起 OriginBot GPU PPO

平台选择 OriginBot 模型和 Local Runner，训练档位先选 `smoke`，点击“发起本地训练”。Run 卡片应显示 `queued → running → completed`，详情中展示：

- `algorithm=ppo`
- 8D observation / 2D action
- reward 曲线
- checkpoint
- ONNX 导出状态
- GPU Worker 来源

GPU Worker 也可只读检查：

```bash
curl http://127.0.0.1:19092/healthz
```

## 5. 评测与 Sim2Real 对比

在评测页：

1. 选择 OriginBot Run。
2. 先导入并本地预览 `/tmp/originbot-sim.jsonl`。
3. 再点击“上传到当前 Run 并评测”。
4. 查看成功率、目标距离、动作范围、控制延迟和遥测来源。
5. 刷新页面确认评测记录仍绑定到同一个 Run。

## 6. 真实 OriginBot 上位机

```bash
curl http://127.0.0.1:18104/api/sim2real/board-station/health
curl http://127.0.0.1:18104/api/sim2real/board-station/status
curl http://127.0.0.1:18104/api/sim2real/board-station/drive
curl http://127.0.0.1:18104/api/sim2real/board-station/policy
```

也可以一条命令看全（含 IMU 航向解算、里程计、电源、CPU/网络、TROS 话题计数）：

```bash
npm run demo:originbot-live              # 快照
npm run demo:originbot-live -- --watch 30  # 演示中挂一个 1 Hz 遥测流
```

页面中展示：X5 型号、BoardAgent、CPU/内存/网络、IMU、里程计、电池、相机 MJPEG、TROS 话题和策略状态。真实数据必须显示 `mock=false`。

也可以从左侧“快速入口”打开 **OriginBot 实时看板**（`/originbot-dashboard.html`）。看板每秒刷新真实状态，绘制仿真/真实轨迹对比，并显示策略运行状态；当设备或 agent 不可达时明确显示“状态不可达”，不伪造数据。

## 7. 加载 OriginBot 8→2 ONNX

把训练产物放到受控 `policies` 目录后，在上位机策略面板选择 `originbot-policy.onnx`，或调用：

```bash
curl -X POST http://127.0.0.1:18104/api/sim2real/board-station/policy/load \
  -H 'content-type: application/json' \
  -d '{"path":"originbot-policy.onnx"}'
```

再查询策略状态，应看到：

```text
state=ready
inputDim=8
outputDim=2
commandTopic=/cmd_vel
motionAuthorized=true/false（按当前开关）
```

这一步只加载模型，不启动运动。

8→2 目标导航策略的观测布局固定为 `[x, y, sin(yaw), cos(yaw), goal_dx, goal_dy, v, w]`。启动策略前，在上位机策略面板填写目标点 X/Y（米）；没有显式目标点时，板端运行时会拒绝启动并保持零输出。目标点通过启动请求传到板端，不需要修改策略文件。

## 8. 只读设备预检

在“部署与反馈”页面选择真实 OriginBot，执行：

```text
探测板型 → 生成预检计划 → 执行只读预检
```

展示契约、板型、runtime、磁盘、设备能力和安全闸门。预检不会下发模型、启动节点或驱动电机。

## 9. 可选：低速运动 Canary

仅在操作者人在场、场地清空、急停可用时执行。双开关可以全程在网页「运动开关」面板开启（平台侧点开关、板端侧点开关，确认后自动重启板端 agent 约 2 秒），也可以命令行（见 [docs/actuator-drive.md](actuator-drive.md)）。脚本方式（自带零速 → 低速 → 急停三步和全部安全分支）：

```bash
npm run demo:originbot-live -- --canary --present
# 自定义: --linear 0.05 --angular 0 --duration 2（数值会被双重钳制）
```

脚本在无 `--present`（人在场确认）、双开关未全开或驱动状态不可达时都会拒绝执行且不向板端发送任何运动命令；Ctrl+C 中断也会先发急停。也可以手工执行——先确认:

```bash
curl http://127.0.0.1:18104/api/sim2real/board-station/drive
```

必须看到：

```json
{"platformEnabled":true,"drive":{"enabled":true},"gates":{"ready":true}}
```

然后执行 0.05 m/s、2 秒：

```bash
curl -X POST http://127.0.0.1:18104/api/sim2real/board-station/drive \
  -H 'content-type: application/json' \
  -d '{"linear":0.05,"angular":0,"durationSec":2}'
```

立即检查并停止：

```bash
curl http://127.0.0.1:18104/api/sim2real/board-station/drive
curl -X POST http://127.0.0.1:18104/api/sim2real/board-station/drive/stop -H 'content-type: application/json' -d '{}'
```

最后再次查询状态，确认 `active=false`、速度归零、里程计有合理变化、急停可用。

8→2 目标导航之外，42D goalnav 契约（`imu-gravity-v1`）的任务级验收（到达
目标点并停止）有专门流程：[docs/goalnav-task-acceptance-runbook.md](goalnav-task-acceptance-runbook.md)。
它同样以目标点 X/Y 为必填输入——两个契约都会在无目标时被板端拒绝并保持零输出。

## 10. 演示收尾

```bash
npm run verify
```

收尾时强调：OriginBot 是首个真实参考设备；RDK Duck 和其他 RDK 产品通过同一 Adapter Contract、任务模板、训练 Run、评测和部署闸门接入，不需要复制平台主体。
