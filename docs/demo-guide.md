# Sim2Real Lab 演示手册（投屏版）

> 面向观众的完整演示文档：功能介绍 + 演示剧本 + 安全话术 + 故障退路。
> 技术细节与逐步命令见 [`docs/demo-runbook.md`](demo-runbook.md)，本手册负责“讲什么、怎么讲”。

---

## 一、平台是什么（30 秒开场）

**RDK 机器人学习平台（Sim2Real Lab）** —— 从浏览器仿真到 RDK-X5 真机部署的机器人强化学习工作台。

一句话讲清定位：**它是一个通用平台，不是只会“遛鸭”的玩具**。浏览器仿真是低门槛入口，
录制、训练、评测、部署围绕同一份可追溯的模型契约组织；OriginBot 是第一台参考机型，
话题清单和契约参数都可换机型。所有数据如实标注：真实数据 `mock: false`，合成数据
永远带标签，绝不伪造。

```
浏览器仿真/录制 ──→ 训练（本地/GPU/云端）──→ ONNX 制品 ──→ 评测（仿真vs真机）
                                                    │
真机遥测（IMU/电池/里程计）◄── 认证代理 ◄── SSH 隧道 ◄── X5 板端 agent
                                                    │
                          板端策略运行时：ONNX 推理 → 受限 /cmd_vel（多闸门）
```

## 二、功能介绍（六大模块 + 真机站）

打开 `http://127.0.0.1:18104`，左侧六步工作流 + 真机站：

页面下方的 **RDK Studio Agent** 是对话入口。它沿用 Studio 的“计划 → 工具事件 → 证据”呈现：输入“完成仿真、GPU 训练、检查 X5 并做真机预检”，Agent 会自动读取契约、打开仿真、调度 GPU smoke 训练、查询 BoardAgent，再执行只读部署预检；策略 live 和电机动作始终停在安全门控，必须由受控上位机单独批准。

| 模块 | 功能 | 演示看点 |
| --- | --- | --- |
| **总览** | 工作区上下文、四步交付流程、安全边界状态 | 一屏讲完平台定位 |
| **套件与契约** | 登记模型、契约检查清单（61D obs / 14D act / 50Hz） | “契约先行”的设计理念 |
| **仿真与录制** | MicroDuck 浏览器仿真 + 中文控制层 + 轨迹录制 JSON/JSONL | 亲手遛鸭、录动作 |
| **训练与模型** | 三条路径：Mock 协议演练 / starter-ppo 真训练 / RoboGo 云端 | 真训练 `mock=false`、真 ONNX 制品 |
| **评测与效果** | 遥测导入、回放、仿真vs真机偏差、**真机实时对照** | 关键指标诚实显示“合成证据·非真实遥测” |
| **部署到 X5** | 契约/板型/制品预检、上线闸门 | 只读预检 fail-closed，不越权 |
| **记录与版本** | Run、发布计划、已保存回放三类证据 | 刷新页面数据仍在，可追溯 |
| **板端上位机**（#station） | 真机遥测、运动金丝雀、策略运行时、命令面板 | **本次演示核心**，详见下节 |

| **对话式 Agent** | 中文任务解析、异步任务状态、工具调用日志、运行证据 | 一句话串起仿真 / GPU / X5 预检 |

### 板端上位机（#station）四大面板

1. **真实遥测卡**：IMU 罗盘指针随真机姿态转动、电池电压（~5V）、里程计与底盘速度卡、
   CPU/内存/磁盘进度条按阈值变色、网络速率 sparkline。全部来自板端 1Hz 状态流（`mock: false`）。
   话题分色一眼看出板端在跑什么：`/cmd_vel`（红，驱动）、`/imu` `/odom`（蓝，传感器）、
   `/tf`（青）。
2. **运动 Canary**：受限 `/cmd_vel` 通道。默认全关，面板如实显示“未启用”及缺哪些开关——
   **默认只读、fail-closed 本身就是演示点**。速度滑条、时间盒、急停钮（空格键也触发）。
3. **策略运行时**：训练 → 导出 → 板端推理全链可视化。加载模型（板端 `policies/` 目录）、
   状态机（idle→ready→running→fault）、1Hz 推理耗时/发布计数、**观测槽位如实标注表**
   （哪些槽是真传感器、哪些是适配零填充——sim→real 的诚实边界展示点）。
4. **命令面板**：白名单只读命令（TROS 节点/话题列表、磁盘用量）。

## 三、演示剧本（10 分钟版）

**前置 30 秒预检**（当天开机后跑一遍，见第六节命令）。

### 第一幕：软件闭环（3 分钟）—— 板卡掉线也能讲

打开 `http://127.0.0.1:18102/?demo=1`（需先 `npm run demo:sim2real`）或直接用 18104。

1. **总览** → 点开上下文，讲四步流程与安全边界。
2. **训练与模型** → “运行 Mock 协议演示”：`queued → running → completed`，运行卡片
   明确写“协议演示”，详情 `mock=true`、`deployable=false` 是刻意保留的证据。
3. **评测与效果** → “载入合成演示证据”（8 帧 61D/14D 50Hz）→ “上传演示样例并评测”：
   页面标注“合成证据 · 非真实遥测”，性能数字留空——诚实设计。
4. **部署到 X5** → “生成预检计划” → “执行只读预检”：预期 `SIM2REAL_PREFLIGHT_MOCK_ONLY`、
   `NO MOTOR`——**这是演示成功的安全结果**，不要讲成部署成功。

### 第二幕：真训练（2 分钟）

另开终端（或演示前预先跑好）：

```bash
npm run demo:starter   # ~2 分钟笔记本 CPU，240 轮 PPO
```

控制台打印 `step reward 0.917 -> 0.997`、`real ONNX artifact: policy.onnx (95370 bytes)`。
讲解词：**这是真 PPO 训练**——`mock=false`，`policy.onnx` 是 `torch.onnx.export` 的真实制品，
评测页的 MAE/RMSE 是训练后策略对未训练基线的动作偏差。物理仍是 numpy 近似（非
MicroDuck 全身动力学），`deployable=false` 保持诚实。

### 第三幕：真机站（5 分钟）—— 核心戏份

打开 `http://127.0.0.1:18104/#station`。

1. **真机遥测**（1 分钟）：罗盘在转（真 IMU）、电池 ~5V、CPU/内存条、“这些数字全部来自
   板端 1Hz 真实状态流，代理链路：浏览器 → 认证代理 → SSH 隧道 → 板端 agent”。
   把板子拿起来慢慢转，罗盘指针跟着动——**最有说服力的一刻**。
2. **运动 Canary**（1 分钟）：默认关闭。讲设计：运动需要平台+板端双开关，速度钳制
   0.3 m/s / 1.0 rad/s，时间盒到期自动零速，500ms 底盘固件看门狗兜底，急停永远可点。
   “默认什么都动不了，这是安全设计，不是缺功能。”
3. **策略运行时**（2 分钟）：开启开关（见第六节）→ 输入模型名 → 加载 → 展示
   **观测槽位如实标注表**（哪些槽是真传感器、哪些是适配零填充——sim→real 的诚实边界）
   → 启动（确认弹窗，人已在场）→ 1Hz 推理耗时 → 停止。两个模型二选一：

   - **推荐：`microduck-ppo-gpu.onnx`**（61→14，约 9.7KB）——RTX 5090 GPU 真训练
     （`cuda=true`、`mock=false`）、**原生 MicroDuck 底盘契约，无需任何维度适配配置**，
     板上加载即 `ready`、推理 ~0.13ms。诚实边界：5 轮迭代冒烟 Run，策略质量
     成功率 0%——演示的是“GPU 训练 → 契约导出 → 板端推理”管线，不是行走质量。
   - 备选：`policy.onnx`（42→12，95KB）——CPU 真训练（240 轮，reward 0.917→0.997），
     但任务是摆链平衡，动作投影是适配层。需要板端配置 `OBS_DIM=42/ACTION_DIM=12`。
4. **收尾话术**（诚实边界）：“这个模型训练的是摆链平衡任务，12 维动作通过对抗对统计
   投影到底盘 (v,w)——投影是适配层，不是训练目标。今天演示的是**推理管线 + 安全通道**，
   完整真机 RL 闭环（真任务语义 + BPU 推理 + OTA）在 roadmap 上。”

### 快速版（3 分钟，时间紧时）

只讲第三幕：真机遥测罗盘 → Canary 安全设计 → 策略加载与槽位标注表 → 停止收尾。

## 四、安全话术（被问到时怎么答）

- **“这机器人会自己动吗？”** 不会，除非四个开关全开且有人在场确认。四闸门：平台策略开关 +
  平台驱动开关 + 板端驱动开关 + 板端策略开关，全部默认关闭。输出双重钳制 + 500ms 固件看门狗。
- **“数据是真的吗？”** 真的。每个接口都带 `mock` 字段，遥测卡数字来自板端真实采样；
  合成数据永远带“演示样例”标签。**浏览器永不直连板端**，一切经平台认证代理。
- **“模型能直接上真机跑吗？”** 推理管线可以（今天演示的就是）；完整部署还需要板型匹配的
  编译制品、只读预检通过、上线闸门审批——预检 fail-closed，不通过就不放行。
- **“换个机器人能用吗？”** 平台是通用的：话题清单、契约维度（观测/动作维数）都是参数，
  换机型改配置不改代码。OriginBot 只是第一台参考机型。

## 五、常见故障与退路

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| station 页全 `--` | 18104 服务挂 / 隧道断 / 板端 agent 挂 | 按第六节顺序重启：平台 → 隧道 → agent |
| health 返回 `SIM2REAL_BOARD_AGENT_UNREACHABLE` | SSH 隧道断或 agent token 变了 | 重建隧道；token 用 `cat /etc/rdk-board-agent/agent.env` 里的 |
| 罗盘不动但 CPU 卡有数 | 遥测 node 崩（已修复：ROS_LOG_DIR 问题） | `systemctl restart rdk-board-agent`（修复已部署） |
| 板卡彻底连不上 | 网络变了 | 退第一幕软件闭环 + 90 秒 `npm run demo:sim2real` |
| 页面空白 | 浏览器缓存了旧版本 | Cmd+Shift+R 强刷 |

## 六、当天操作手册（开演前 5 分钟）

### 0. 启动平台（Mac 终端）

```bash
cd /Users/d-robotics/Desktop/超级智能体/rdk-robot-learning-platform-public
set -a && source /tmp/gpu-stack-restart.env && set +a
nohup node dist-server/services/sim2real-web/server.js > /tmp/sim2real-server-18104.log 2>&1 &
```

> `/tmp/gpu-stack-restart.env` 丢失时重建（token 以板上 `/etc/rdk-board-agent/agent.env` 为准）：
> ```bash
> cat > /tmp/gpu-stack-restart.env <<'EOF'
> RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19091/train
> RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=23e262dd694c1932f77326ad8b2411906fd443cb9e29210d
> RDK_SIM2REAL_LOCAL_RUNNER_MODE=external
> RDK_SIM2REAL_STORAGE_DIR=/Users/d-robotics/.rdk-sim2real-gpu-verify/ledger
> RDK_SIM2REAL_BOARD_AGENT_URL=http://[::1]:19100
> RDK_SIM2REAL_BOARD_AGENT_TOKEN=<板 /etc/rdk-board-agent/agent.env 里的 TOKEN>
> RDK_SIM2REAL_PORT=18104
> EOF
> ```

### 1. 30 秒预检

```bash
# 板端健康（必须 ok:true + connected）
curl -s http://127.0.0.1:18104/api/sim2real/board-station/health

# 真遥测活着（必须看到 batteryVoltage ≈ 5 和 imu 四元数）
curl -s http://127.0.0.1:18104/api/sim2real/board-station/status | head -c 600

# 隧道断了就重建：
sshpass -p root ssh -f -N -L '[::1]:19100:127.0.0.1:19100' root@10.185.136.180
```

### 2. 要演示策略运行时（可选，提前 2 分钟）

```bash
# 板侧开开关（/etc/rdk-board-agent/agent.env 追加三行后重启）
sshpass -p root ssh root@10.185.136.180 \
  'sed -i "s/ENABLE_POLICY=0/ENABLE_POLICY=0/" /etc/rdk-board-agent/agent.env; \
   grep -q OBS_DIM /etc/rdk-board-agent/agent.env || \
   echo -e "RDK_SIM2REAL_POLICY_OBS_DIM=42\nRDK_SIM2REAL_POLICY_ACTION_DIM=12\nRDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY=1" >> /etc/rdk-board-agent/agent.env; \
   systemctl restart rdk-board-agent'

# Mac 侧平台也要带策略开关重启：
kill $(ps aux | grep 'node dist-server' | grep -v grep | awk '{print $2}')
set -a && source /tmp/gpu-stack-restart.env && set +a && \
  RDK_SIM2REAL_STATION_POLICY_ENABLED=1 RDK_SIM2REAL_STATION_DRIVE_ENABLED=1 \
  nohup node dist-server/services/sim2real-web/server.js > /tmp/sim2real-server-18104.log 2>&1 &
```

### 3. 演示结束恢复默认安全态

```bash
# 板侧关开关
sshpass -p root ssh root@10.185.136.180 \
  'sed -i "s/ENABLE_POLICY=1/ENABLE_POLICY=0/" /etc/rdk-board-agent/agent.env; \
   systemctl restart rdk-board-agent'

# Mac 侧不带开关重启
kill $(ps aux | grep 'node dist-server' | grep -v grep | awk '{print $2}')
set -a && source /tmp/gpu-stack-restart.env && set +a && \
  nohup node dist-server/services/sim2real-web/server.js > /tmp/sim2real-server-18104.log 2>&1 &
```

### 连接参数（备忘）

- 板：`root@10.185.136.180`（密码 root），agent 19100 端口
- 平台：`http://127.0.0.1:18104`（station：`#station`）
- 板上模型：`policy.onnx`（真训练 95KB 42→12）、`demo-policy.onnx`（结构真实 61→14 未训练）
- 仓库内同款环境文件：`/tmp/gpu-stack-restart.env`；投屏用 18104，演示软件闭环用 18102
