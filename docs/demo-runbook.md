# Sim2Real Lab 演示脚本

这份脚本用于现场投屏。它验证的是**软件控制面和协议闭环**：仿真入口（或内置演示证据）→
训练请求 → 运行台账 → 评测回放 → X5 只读预检 → 安全闸门。Mock worker、合成遥测和
reference BoardAgent 都会在界面上明确标识，不能被介绍成真实 PPO 或真机结果。

## 启动

在仓库根目录执行：

```bash
npm ci
npm run demo:sim2real
```

打开启动器打印的地址，通常是
`http://127.0.0.1:18102/?demo=1`。`?demo=1` 会固定 MicroDuck、行走任务和投屏视图，
并使用临时台账预置一台 `x5-demo` 模拟板卡。退出终端会停止三个子服务并清理临时数据。

## 90 秒讲解顺序

1. **总览**：说明顶部上下文、四步交付流程和“安全边界已开启”。投屏时可以点击右上角
   “退出演示”暂时恢复普通导航。
2. **训练与模型**：点击“运行 Mock 协议演示”，展示 `queued → running → completed`。
   运行卡片会写明“协议演示”，详情里的 `mock=true` 和 `deployable=false` 是刻意保留的
   证据。
3. **评测与效果**：点击“载入合成演示证据”，确认 8 帧、61D/14D、50Hz；再点击
   “上传演示样例并评测（不解锁发布）”。关键指标只显示契约状态，性能数字保持为空，
   页面会标出“合成证据 · 非真实遥测”。
4. **部署到 X5**：点击“生成预检计划”，再点“执行只读预检”。预期返回
   `SIM2REAL_PREFLIGHT_MOCK_ONLY`，页面显示“协议已验证，但不是真机预检证据”和
   `NO MOTOR`。这是演示成功的安全结果，不要把它改讲成部署成功。
5. **记录与版本**：打开记录页，展示 Run、发布计划和“已保存回放”三类证据；刷新页面后，
   回放摘要仍在，且继续标记为演示样例。

## 有上游 MicroDuck 资源时

先按 [`MICRODUCK-UPSTREAM.md`](../services/mujoco-web/MICRODUCK-UPSTREAM.md) 固定版本并
校验 release，再显式挂载：

```bash
RDK_SIM2REAL_MICRODUCK_ROOT=/opt/microduck-web/current npm run demo:sim2real
```

也可以使用经过审核的 HTTPS 入口设置 `RDK_SIM2REAL_MICRODUCK_URL`。启动器不会自动下载
或替换上游资源；没有 bundle 时，仿真页会显示安装指引，评测页仍可用内置合成证据完成
软件流程演示。

## 真实训练演示（starter-ppo）

需要真实 PPO 闭环（不再只是协议演练）时，另开一个终端：

```bash
python3 -m pip install --user numpy torch onnx   # 一次性
npm run demo:starter
```

约 1–2 分钟（笔记本 CPU，默认 240 轮）后控制台会打印：

```
[demo:starter] training completed: step reward 0.917 -> 0.997, successRate=1, fallRate=0
[demo:starter] real ONNX artifact: policy.onnx (95370 bytes)
[demo:starter] evaluation: samples=200 actionMAE=... actionRMSE=...
```

讲解要点：运行详情里 `mock=false`、metrics 来自真实评测回放；`policy.onnx` 是
`torch.onnx.export` 的真实制品；评测页的 MAE/RMSE 是训练后策略对未训练基线的
动作偏差。训练仍是 numpy 近似物理（不是 MicroDuck 全身动力学），`deployable=false`
保持诚实——上板依旧需要 X5 编译制品和只读预检。详见
[`docs/engines/starter-ppo.md`](engines/starter-ppo.md)。

## 上位机站 + 真机遥测（station 页）

`http://127.0.0.1:18104/#station` 是另一段可投屏的演示：工作台 → 板卡 → 真实数据。

1. **真实遥测卡**：IMU 罗盘指针随真机姿态转动、电池电压实时显示、里程计与底盘速度卡、
   CPU/内存/磁盘进度条按阈值变色、网络速率 sparkline 流动。所有数字来自板端 1Hz 状态流
   （`mock: false`），本地参考 agent 演示时页脚会标注模拟数据。
2. **运动 Canary**（开关默认全关）：面板会如实显示"未启用"与需要的开关名——这本身就是
   演示点：默认只读、fail-closed、急停永远可点（空格键也触发急停）。
3. **策略运行时面板**：训练 → 导出 → 板端推理这条链的可视化。开关全关时同样显示诚实
   说明；开启后可以：输入模型名（板端 `policies/` 目录内的 `.onnx` 文件）→ 加载（板端
   onnxruntime 会话就绪，显示 61→14、文件大小）→ 看到"观测槽位如实标注"列表（哪些槽是
   真传感器、哪些是适配零填充——这是 sim→real 的诚实边界展示点）→ 启动（前置确认弹窗
   确保人已在场）→ 1Hz 显示推理耗时/发布计数 → 停止。
4. **话题分色**：`/cmd_vel`（红）驱动、`/imu`/`/odom`（蓝）传感器、`/tf`（青）——一眼
   看出板端在跑什么。

### 策略上板前置（板端一次性）

```bash
# 1. 板上装依赖（已装过则跳过）
sshpass -p root ssh root@10.185.136.180 'python3 -m pip install --no-cache-dir onnxruntime numpy'

# 2. 传模型（只用 policies/ 目录内的 .onnx 文件名，代理会拒绝路径穿越）
sshpass -p root scp local-path/policy.onnx \
  root@10.185.136.180:/root/rdk-board-agent/policies/policy.onnx

# 3. 契约维度必须与模型一致（starter-ppo pendulum-chain-12j 是 42→12；
#    MicroDuck 底盘契约是 61→14。runtime 会拒绝维度不符的模型——这是
#    安全检查，不是 bug）。板端 agent.env：
#    RDK_SIM2REAL_POLICY_OBS_DIM=42
#    RDK_SIM2REAL_POLICY_ACTION_DIM=12

# 4. 开三重开关（演示完建议全部关回）
#    Mac 侧: RDK_SIM2REAL_STATION_POLICY_ENABLED=1 RDK_SIM2REAL_STATION_DRIVE_ENABLED=1
#    板 侧: agent.env 里 RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=1 + ENABLE_POLICY=1
#    然后: sshpass -p root ssh root@10.185.136.180 'systemctl restart rdk-board-agent'

# 5. 更新 X5 板端 agent（有 SSH/SCP 路径时执行；Studio Bridge 不需要额外隧道）
RDK_X5_SSH_TARGET=root@10.185.136.180 ./scripts/deploy-x5-board-agent.sh

# 6. 线上平台复用 RDK Studio Local Bridge：保持本机 bridge 客户端运行，
#    在 Studio 中确认 RDK X5 已连接，然后打开 Sim2Real Station 页面。
#    不再创建第二条 19100 SSH 隧道。
```

### 真训练模型演示（推荐路径）

`npm run demo:starter` 产出的是**真训练的 torch.onnx.export 制品**
（95KB，starter-ppo 引擎 240 轮 PPO）。把它 scp 到板端 policies/ 并按上面
的维度配置 agent.env，面板"加载"后 model 卡显示 `policy.onnx · 93KB · 42→12`，
obsSlots 显示 `42D obs / 12D act`、`slots_real: 6`——讲解词：前 6 槽是真 IMU
陀螺仪+投影重力，其余是适配槽（上一步动作+操作指令，不够的零填充），这是
sim→real 的诚实边界。任务本体是 pendulum-chain（摆链保持平衡），动作为 12
维，runtime 用对抗对统计投影到底盘 (v, w)——投影是适配层，不是训练目标，
这一点如实讲。

### 演示前 30 秒预检清单

- [ ] `curl -s http://127.0.0.1:18104/api/sim2real/board-station/health` 返回 `ok: true` 且
      `mock: false`（如果板不可达，先重建隧道，再 `systemctl restart rdk-board-agent`）。
- [ ] station 页罗盘在转（= 真 IMU 流活着），电池显示 ~5V。
- [ ] 板端策略运行时状态：`GET /api/sim2real/board-station/policy` → 开关状态与你的演示
      计划一致（只演示加载/推理时保持 start 不可达即可，被拒绝时页面会给出准确原因）。
- [ ] 板卡掉线时的退路：切换到本地参考 agent（`RDK_SIM2REAL_BOARD_AGENT_URL` 指向
      `local-board-agent`），遥测卡继续渲染（页脚标注模拟），讲解词强调"诚实降级，不伪造"。

### 策略演示的安全话术

- 输出钳制 0.3 m/s / 1.0 rad/s，500ms 无命令底盘固件看门狗自动零速——与手动 Canary
  完全同一条受限通道。
- 观测适配是**部分真实**：IMU 槽位是真数据，腿关节槽位是零填充（底盘没有腿）；面板上的
  槽位标注就是这份边界的如实展示，不要讲成"完整 sim2real 对齐"。
- 动作投影：14 维腿式输出 → 对抗肌对均值/不对称度 → (v, w)，或 (v, w) 策略直通；面板
  的 obsSlots 与 note 都如实说明。

## 现场边界

- Mock 只验证请求协议、状态流转和台账，不运行 PPO，也不生成可部署权重。
- 合成遥测只验证导入、分片、回放和评测渲染，不代表真实 X5 采样。
- reference BoardAgent 只返回固定的只读板卡护照，不连接 SSH、不执行任意命令、不驱动电机。
- 策略运行时面板的推理指标（inferMs、published）来自板端真实 onnxruntime 进程。
  `policies/policy.onnx` 是 starter-ppo 真训练制品（95KB，42→12）；若用
  `policies/demo-policy.onnx`（61→14 结构真实但未经 RL 训练）要如实说明"演示推理
  管线，非训练成果"。两者都不要讲成"真机 RL 闭环完成"——观测适配与动作投影是
  适配层，任务语义（摆链平衡）与底盘运动不对应。
- 真实闭环还需要真实 RL worker、X5 BoardAgent/Protobuf、制品编译与签名、OTA/回滚以及
  一台实体 X5 的验收。
