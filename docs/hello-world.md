# MicroDuck 策略 Hello World：从模型到仿真器、再到本体

> 给第一次接触本平台的人：沿四级阶梯往上爬，每一级都完整跑通一次
> 「模型 → 下发 → 闭环」；任何一级卡住都可以停在那一级，前面的成果依然成立。

| 阶梯 | 你需要 | 大约耗时 | 跑通后你看到什么 |
| --- | --- | --- | --- |
| ① 浏览器仿真 | 一台笔记本 | 5 分钟 | 内置参考策略在浏览器 MuJoCo 里实时行走、可录制轨迹 |
| ② 真训练 | 同上（CPU 即可） | 10 分钟 | 一个真实 PPO 训练出的 ONNX 制品和真实评测指标 |
| ③ 下发到本体 | 一块 RDK X5 / S100 开发板 | 30 分钟 | 板端加载模型、推理并驱动底盘（受限通道） |
| ④ 研发全链 | GPU 主机 + 板 + microduck_rl 检出 | 半天 | MicroDuck 真腿式策略：训练 → 评测 → PC 仿真 + 板端推理闭环 |

诚实边界先立住：①里的"参考策略"是内置官方模型，不是你训练的；②的训练物理是
numpy 近似（`deployable=false`）；③把 14 维腿式输出**投影**成底盘 `(v, w)`，是适配层
不是训练目标；④才是 MicroDuck 全身动力学的真实链路。每一级的页面都会如实标注这些。

## ① 浏览器仿真：先看见闭环（无安装成本）

```bash
nvm install && nvm use
npm ci
npm run setup        # 一次性：检查 Node、创建 .env、给出缺失依赖的安装命令
npm start
```

打开 `http://127.0.0.1:18102`：

1. 左侧进「仿真与录制」，等状态行出现「参考策略可用 MuJoCo WASM · 50Hz」。
2. 用 W/A/S/D 驱动鸭子，点「开始录制」，走几步后停止——轨迹 JSONL 已入台账。
3. 找到「策略试跑（浏览器推理）」按钮点一下：**平台把内置模型下发进仿真器**，
   ONNX Runtime Web 在浏览器里 50Hz 推理驱动 MuJoCo——这就是最小的
   「模型 → 下发 → 仿真闭环」。

界面上的「当前动作任务」会同时切换仿真场景与训练参数。行走、坐站、踢球等动作使用
完整 MicroDuck 浏览器模型；平衡、梯子、秋千和足球比赛使用对应训练引擎的 MuJoCo
代理模型，页面会明确标注。后者需要启动本地 MuJoCo 服务，步骤见
[`仿真与录制`](./simulation.md)。停止录制后可在评测页直接回放本次轨迹，也可导出 JSONL。
没有上游 MicroDuck 资源时，基础动作页会给出安装指引，按
[`MICRODUCK-UPSTREAM.md`](../services/mujoco-web/MICRODUCK-UPSTREAM.md) 挂载；训练任务场景
无需这份上游静态包。

## ② 真训练：拿到一个真的 ONNX

```bash
npm run setup -- --install-python   # 创建 .venv 并安装 starter-ppo CPU 依赖
npm run demo:starter
```

约 1–2 分钟后控制台输出真训练结论（reward 收敛、`policy.onnx` 字节数、
评测 MAE/RMSE）。这个制品 `mock=false`，评测指标来自真实回放；训练物理是
numpy 近似而非 MicroDuck 全身动力学，所以 `deployable=false` ——细节见
[`docs/demo-runbook.md`](demo-runbook.md) 的「真实训练演示」一节。

## ③ 下发到本体：板端加载模型并驱动底盘

前提：一块刷好 OE 的 RDK X5 / S100，与主机网络可达。三条命令完成板端 agent 安装、
模型下发、维度声明：

```bash
RDK_X5_SSH_TARGET=root@<板端地址> ./scripts/install-x5-board-agent.sh --enable
scp policy.onnx root@<板端地址>:/root/rdk-board-agent/policies/policy.onnx
# 板端 agent.env 声明契约维度（starter-ppo 是 42→12；MicroDuck 腿式是 61→14）
```

然后打开 `http://127.0.0.1:18104/#station` 的「策略运行时」面板：
输入模型名 → **加载**（板端 onnxruntime 会话就绪，显示 61→14 或 42→12）→
核对「观测槽位」标注（哪些槽是真传感器、哪些是适配零填充）→ **启动**
（确认弹窗保证人在现场）→ 看到 1Hz 推理耗时与发布计数 → **停止**。

输出走的是与手动 Canary 完全相同的受限通道：速度钳制 0.3 m/s / 1.0 rad/s，
500ms 无命令固件看门狗自动零速，急停永远可点。完整前置步骤、开关矩阵与
演示话术见 [`docs/demo-runbook.md`](demo-runbook.md) 的「上位机站」一节；
只读预检命令见 [`docs/first-run.md`](first-run.md) 第 3 节。

## ④ 研发全链：MicroDuck 真腿式策略

这一级跑的是 61D→14D 的全身动力学策略（站立/行走/踢球/恢复四个任务包）：

1. **训练**：GPU 主机按 [`docs/gpu-runner.md`](gpu-runner.md) 接入 runner，
   工作台选 `microduck-rl` 引擎提交训练；或在 GPU 机直接驱动
   `engines/microduck-rl-adapter`（mjlab + rsl-rl）。
2. **评测**：训练产物用评测底座出任务级指标（成功率带 Wilson 置信下界）：

   ```bash
   cd engines/microduck-eval && ../../.eval-venv/bin/python -m microduck_eval.report \
     --task walking-velocity --policy /path/policy.onnx \
     --model-root /path/to/microduck_rl \
     --actuator-model bam-ctrl --scene-variant walk \
     --envelopes nominal,hard --episodes 50 --out eval-walking.json
   ```

3. **下发到仿真器（PC）+ 板端推理，一条命令闭环**：

   ```bash
   ../../.eval-venv/bin/python -m microduck_eval.live_loop \
     --demo --backend board --board-url http://<板端地址>:19100 \
     --model-root /path/to/microduck_rl
   ```

   `--demo` 是预设编排：前进 2s → 原地左转 2s → 站立 1s，跑完自动退出并打印
   每阶段的指令、位置、倾角与节奏统计。去掉 `--demo` 后进入交互模式：
   `w/s` 前后，`a/d` 转向，`0` 站立，`v vx,vy,wz` 直接设速度，`q` 退出；
   `--backend local` 则在本机 ONNX Runtime 推理（同一观测契约）。
   语义与工作台「策略试跑」一致：PC 跑物理，板子跑模型。
4. **上板部署**：按工作台「部署与反馈」走契约 → 评测 → 签发 → 只读预检 →
   受控下发；腿式运行时的关节安全边界见
   [`docs/microduck-leg-runtime.md`](microduck-leg-runtime.md)。

## 常见第一次的坑

- 浏览器仿真区显示「资源尚未挂载」：上游 bundle 不随仓库分发，按第①级指引挂载。
- 「策略试跑」灰着：先在回放里加载一个已完成 Run（板端推理模式无需回放）。
- 板端「加载」被拒：契约维度与模型不符（42→12 与 61→14 不能混用），这是安全检查。
- `live_loop` 报动作宽度 61：你连的是 loopback 参考 agent（只验证线序，不含模型），
  换真实板端 agent。
- `--model-root` 找不到：microduck_rl 上游检出不随仓库分发，路径由调用方提供。
