# microduck-rl 适配器（上游训练栈接入）

把 `pollen-robotics/microduck_rl`（mjlab + MuJoCo Warp + rsl-rl PPO，教程里的那套 GPU 训练栈）
接进平台的本地 worker 协议：工作台提交 → 上游 `uv run train` → 实时曲线 → `artifact://` 制品。

**这不是重写物理，也不是 mock。** 适配器逐字驱动上游命令：

```bash
uv run train <TASK_ID> --env.scene.num-envs <N> --agent.max_iterations <M>
uv run scripts/export.py <TASK_ID> --checkpoint-file <model_*.pt> --onnx-file <job>/policy.onnx
```

所以工作台里发起的一次训练，就是教程第 5/6 步在 GPU 机器上跑的那次训练；平台只负责契约校验、
台账、实时曲线、制品与溯源。

## 与教程步骤的对应

| 教程步骤 | 平台入口 | 说明 |
| --- | --- | --- |
| 1–2 装 uv / `uv sync` | 一次性部署（本文第 1 节） | Python 3.12 + CUDA torch + mjlab 1.3.0 + MuJoCo Warp |
| 3 wandb 曲线（可选） | 平台「实时训练曲线」 | 不需要 wandb：适配器解析上游 stdout 的 iteration 块，逐轮回传均值奖励 |
| 4 体验官方步态 | 浏览器 MicroDuck 仿真 | 上游 bundle + 官方 ONNX 已登记在平台模型注册表 |
| 5 跑通测试（64 env / 5 轮） | 训练档位「冒烟」 | `training.profile=smoke` → `--env.scene.num-envs 64 --agent.max_iterations 5` |
| 6 正式训练 | 档位「低显存 / 标准 / 高显存」 | 64 / 1024 / 4096 并行环境，与教程表格一致 |
| 7 查看 checkpoint | 运行详情 + `training-summary.json` | checkpoint 落在任务目录 `logs/rsl_rl/<experiment>/` |
| 8 导出 onnx | 同一任务自动导出 | 成功后任务目录出现 `policy.onnx`，worker 计算 sha256/size 并挂到制品上 |
| 9 onnx 推理 / 上板 | 浏览器回放 → 部署页预检 | 上 X5 仍需 BPU 编译（`scripts/compile-policy.mjs`），适配器不解锁这一步 |

## 1. 在 GPU 机器上部署

要求：CUDA GPU、`git`、`uv`。上游要求 Python 3.12/3.13（由 `uv` 自动提供）。

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source "$HOME/.local/bin/env"

git clone https://github.com/pollen-robotics/microduck_rl ~/microduck_rl
cd ~/microduck_rl
export UV_HTTP_TIMEOUT=600
uv sync          # 首次很慢：会拉 CUDA 轮子 + 编译 BAM 执行器模型
uv run list-envs # 确认任务注册表可用
```

## 2. 注册引擎

把适配器放到 GPU 机器（例如 `~/rdk-sim2real/engines/microduck-rl-adapter/adapter.py`），
然后在 worker 环境文件里注册 `microduck-rl` 引擎：

```bash
# ~/rdk-sim2real/worker.env
RDK_SIM2REAL_LOCAL_WORKER_HOST=127.0.0.1
RDK_SIM2REAL_LOCAL_WORKER_PORT=19091
RDK_SIM2REAL_LOCAL_WORKER_DATA_DIR=/root/rdk-sim2real/worker-data
RDK_SIM2REAL_TRAIN_EXECUTABLE=/root/microduck_rl/.venv/bin/python
RDK_SIM2REAL_TRAIN_ARGS_JSON='["/root/rdk-sim2real/engines/starter-ppo/runner.py"]'
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"microduck-rl":{"executable":"/root/microduck_rl/.venv/bin/python","args":["/root/rdk-sim2real/engines/microduck-rl-adapter/adapter.py"]}}'
RDK_SIM2REAL_LOCAL_RUNNER_TOKEN=<随机长字符串>
RDK_MICRODUCK_RL_DIR=/root/microduck_rl
```

要点：

* 两个 `executable` 必须是**绝对路径**（worker 强制，且不走 shell）；
* `microduck-rl` 引擎用的是 microduck_rl 自己的 venv python，适配器再由它调 `uv run`；
* `RDK_MICRODUCK_RL_DIR` 不设时适配器会依次尝试 `~/microduck_rl`、`/opt/microduck_rl`；
* 其他可选变量：`RDK_MICRODUCK_RL_UV`（uv 绝对路径）、`RDK_MICRODUCK_RL_FORCE_CPU`（调试用，把并行环境钳到 64）。

`GET /healthz` 会回报 `"engines":["default","microduck-rl"]`，工作台的引擎选择器据此点亮
「microduck-rl · mjlab 并行物理（CUDA）」，未注册的 worker 上该选项是禁用并标注原因的。

## 3. 接到平台

GPU 机器不必暴露公网：用 SSH 隧道把 worker 端口引到跑 Web 服务的那台机器。

```bash
ssh -p <ssh-port> -N -L 19092:127.0.0.1:19092 <user>@<gpu-host> \
  -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes
```

然后在工作台「训练」→「我的 GPU 训练资源」添加：

* `/train` 地址：`http://127.0.0.1:19092/train`（端口号与隧道本地端口一致）
* Runner token：`worker.env` 里的 `RDK_SIM2REAL_LOCAL_RUNNER_TOKEN`
* 点「测试连接」，健康租约通过后在下拉框选中这台 GPU。

提交时选择训练引擎 **microduck-rl**，档位按显存选（4096 环境 ≈ 24 GB 卡）。

> 运维提示：worker 是普通进程（`nohup node services/sim2real-web/local-training-worker.mjs &`），
> 机器重启后要重新拉起；隧道断开时平台会显示资源离线，worker 侧未完成的任务记录仍留在磁盘上。
> 本次部署的 GPU 侧端口是 **19092**（19091 曾被一个旧 worker 占用）。

## 4. 如实上报的字段

| 字段 | 含义 |
| --- | --- |
| `result.physicsBackend` | 恒为 `mjlab-mujoco-warp`：只有真的跑起上游 trainer 才会写结果 |
| `result.cuda` | 只有本进程真的看到 CUDA 设备才为 `true` |
| `result.deployable` | 恒为 `false`：上 X5 还要过 BPU 编译，适配器不做这一步 |
| `result.metrics.onnxGate` | 导出一致性门的裁决：`passed` / `failed` / `skipped`（见下） |
| `training-summary.json` | 上游命令、日志目录、设备名、耗时、奖励曲线、ONNX 字节数 + sha256、导出门详情、episode 指标、契约维度 |
| `progress[]` | 每轮的 `meanReward`（来自上游 stdout）；`recentSuccess` 恒为 0，因为上游不打印任务成功率——不编造 |

### 导出一致性门（`onnx_export_gate.py`）

"export 退出码 0"不等于"平台拿到的是策略"。导出成功后，适配器用几个探针观测
跑一遍导出图，检查四件事：**IO 契约**（恰好一个 61 维观测输入、一个 14 维动作输出，
循环状态成对出现在两侧——配不上就拒绝，绝不猜喂法）、**有限性**（探针动作与状态
全有限）、**确定性**（同观测两次动作一致）、**敏感性**（不同观测给出不同动作——
对一切输入输出常数的图没有资格当策略）。任一检查失败：制品被扣留
（改名 `policy.onnx.rejected` 留检），训练本身仍如实报 completed，失败原因落
`training-summary.json.onnxExportGate`。上游 venv 没装 onnxruntime 时是
**记为 skipped** 的诚实跳过（装上即自动启用），不是静默放行。

它**不**做 checkpoint 级 parity（重建网络对拍属于 `engines/microduck-eval`
那条线，那边把 `policySha256` 钉在报告里）；它在 GPU 机器上自包含运行，不依赖
平台仓库的其他部分。

## 5. 实测行为（2026-09-16，RTX 5090 / 64 env 冒烟档）

从工作台「训练」提交、引擎选 microduck-rl 的实测结果：

* 64 env × 5 轮 ≈ **20 秒**（含 MuJoCo Warp kernel 加载），曲线 4 个点，
  均值奖励 0.11 → 0.12 → 0.13 → 0.10（未训练奖励水平，冒烟档不追求收敛）；
* 任务目录产出 `policy.onnx`（793 818 B）+ `training-summary.json`，worker 记录 sha256；
* 平台台账：`status=completed`、`physicsBackend=mjlab-mujoco-warp`、`cuda=true`、
  `artifact.kind=compiled`、`checkpoint.checkpointId=…-iter4`、`iteration=4`；
* `GET /api/sim2real/runs/:id/policy.onnx` 返回的字节 sha256 与台账一致。

### 四个必须知道的坑（都已固化在代码里）

1. **上游默认 `logger="wandb"`**，没有 API key 时 `wandb.init()` 直接抛异常终止训练。
   适配器在缺 key 时自动加 `--agent.logger tensorboard` 并设 `WANDB_MODE=disabled`；
   想用 wandb（教程第 3 步）就导出 `WANDB_API_KEY`。
2. **输出是 CRLF**：rsl-rl 通过 rich 打印，表头以 `\r\n` 结尾、指标行带尾随 `\r`。
   按 `\r` 当换行会把 `Learning iteration` 表头切碎，曲线静默为空。
3. **奖励字段名随版本变化**：mjlab 1.3.0 打印 `Mean reward`，rsl-rl 2.2.3 打印
   `Mean total reward`。两个都要认。
4. **mjlab 会在第 0 轮写 `model_0.pt`**（早于第一次梯度更新），所以冒烟档也有
   checkpoint 文件——适配器按 `iteration > 0` 判断，只有真实训练进展才导出 ONNX，
   避免把"没训练过的权重"当成策略制品。

### 续训（教程第 7 步）

上游续训命令是 `--agent.load-checkpoint <model_*.pt> --agent.resume True`，需要
**本机可读的 .pt 文件**。平台台账保存了 `checkpoint.checkpointId` 与
`artifactRef`（`artifact://microduck-rl/<run>/model_4.pt`），但 `.pt` 字节不会回传到
平台，也不在 worker 的制品接口里（worker 只服务 `policy.onnx`）。所以在 GPU 机器上续训：

```bash
cd ~/microduck_rl && uv run train Mjlab-Velocity-Flat-MicroDuck --env.scene.num-envs 4096 \
  --agent.run-name resume --agent.load-checkpoint \
  logs/rsl_rl/velocity/<experiment>/model_1500.pt --agent.resume True
```

（与教程第 7 步一致；实验目录见任务目录的 `training-summary.json.upstream.logDirectory`。）

### 制品登记与试跑

冒烟档现在就会产出 `policy.onnx`（见上面第 4 点），所以工作台里可以直接：

* 「本地试跑」→ `GET /runs/:id/policy.onnx` 取字节（sha256 校验）；
* 登记进制品库 → 部署页对 X5 做只读预检。

`deployable` 仍是 `false`：X5 需要 BPU 量化编译（`scripts/compile-policy.mjs` + hbdk），
这一步不在本适配器范围内。

## 6. 终端里的两条（教程第 7 步的观察器、第 9 步的键盘遥控）

教程里 `uv run play …` 和 `uv run scripts/infer_policy.py …` 都要求**有人坐在一台带显示器的机器前敲键盘**：
前者开 MuJoCo 原生窗口看实时策略，后者在 CPU MuJoCo 里用键盘遥控鸭子。平台不提供交互式终端
（板端 station 的只读白名单命令是安全边界，不会为了看画面放宽），所以这两条要么在 GPU 机器上开
X11 转发 / 远程桌面自己跑，要么用平台侧的等价物：

| 教程命令 | 平台侧等价物 | 前提 |
| --- | --- | --- |
| `uv run scripts/infer_policy.py --walking alpha_walking.onnx --new-cmd-obs` | 浏览器仿真（官方策略已登记，方向键/WASD/R/K 与教程一致） | 浏览器仿真入口可用 |
| 同上，但换成**你自己训练的** `policy.onnx` | 仿真页左侧「策略装载」面板：列出你已完成、带 sha256 的训练，一键装进鸭子；拒绝原因由仿真引擎给出 | 部署方挂载了本地仿真 bundle 并装了 overlay（见 `services/mujoco-web/README.md`） |
| `uv run play <TASK> --checkpoint-file …`（训练中途观察） | 平台「实时训练曲线」+ 运行详情 + `training-summary.json`；想看 3D 画面仍要在 GPU 机器上开显示 | GPU 机器有显示或 X11 转发 |

已核对过制品与仿真器的契约，因此"装进鸭子"不是猜测：本次训练导出的 `policy.onnx` 输入
`obs [1,61]`、输出 `actions [1,14]`、opset 18、算子只有 `Sub/Div/Gemm/Elu`，观测归一化已烘进图里
（`export.py` 的 `actor(normalizer(obs))`），正是上游 wasm 加载器校验并要求的那一组维度。

## 7. X5 编译与上板准备（已产出可部署制品）

`x5/` 里是从 checkpoint 到 X5 制品的完整流水线，实测已产出 **460 879 B 的 bayes-e 量化模型**
（4 个 Gemm 全部 int8 上 BPU，cosine similarity 0.996+），并且通过平台编译门禁：
`deployable: true` + `artifact://compiled/x5/policy-x5.bin` + sha256。细节与新踩的坑见
`engines/microduck-rl-adapter/x5/README.md`；**这一段不需要 X5 在网**，板子只用于最后的只读预检。

## 8. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 任务 `failed`，退出码 3 | 找不到上游仓库或 `uv`：检查 `RDK_MICRODUCK_RL_DIR` 与 `which uv` |
| `training engine "microduck-rl" is not registered` | worker 没读到 `RDK_SIM2REAL_TRAIN_ENGINES_JSON`，重启 worker 后看 `/healthz` |
| 上游报无 CUDA 设备 | worker 进程没拿到 GPU（`CUDA_VISIBLE_DEVICES` 被限制）；日志里会打印实际可见设备 |
| 曲线为空但训练成功 | 上游换了 stdout 格式；对比 `training-summary.json.rewardCurve` 与任务目录里的原始输出 |
| 台账里没有 artifact | ONNX 不在任务目录根下，或 `kind` 不是 source/compiled（服务器会整条丢弃） |
| 台账里没有 checkpoint | `checkpointId` 含 `:` 或路径（服务器校验 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`） |
| 30 分钟只跑了 5 轮 | 首轮要加载/编译 MuJoCo Warp kernel，属正常；真实速度看 `steps/s` |
