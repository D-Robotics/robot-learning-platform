# 真实训练引擎

本仓库自带两个引擎目录，都通过 `services/sim2real-web/local-training-worker.mjs` 的文件协议接入（读 `RDK_SIM2REAL_REQUEST_FILE`，写 `RDK_SIM2REAL_RESULT_FILE`）：

| 引擎 | 依赖 | 定位 |
| --- | --- | --- |
| `engines/starter-ppo` | numpy + torch（+ onnx 可选导出） | **开箱即用的真 PPO/SAC**：numpy 向量化 12 关节倒立摆物理 + torch PPO 或 SAC（**自动检测 CUDA**）+ ONNX 导出 + 遥测/baseline 导出 |
| `engines/mjlab-rsl-rl-adapter` | rsl-rl-lib==2.2.3（mjlab 可选） | 生产训练栈适配：kinematic 后端已可用真实 rsl_rl `OnPolicyRunner` 训练；mjlab 物理引擎为显式接入点 |

## 算法选择：`training.algorithm`

请求里 `training.algorithm` 为 `"ppo"`（默认）或 `"sac"`。两条算法路径：

- **共享**：`ActorCritic` 骨干、ONNX 导出契约、评测器、质量门、遥测导出——算法 A/B
  比较是诚实的（同环境、同预算、同评测协议），制品在板端运行时不可区分
  （部署消费确定性 actor，SAC 的均值动作）。
- **PPO**：在策略，GAE 优势 + clip ratio（log-ratio 护栏防 NaN）。
- **SAC**：离策略，twin-Q 目标网络（Polyak）+ 自动温度 alpha（目标熵 −dim(A)）、
  uniform replay（容量 8192，warmup 512）；超参全量落盘
  `training-summary.json`（`SAC_HYPERPARAMS`，含 update-to-data 比率），`alphaCurve`
  记录温度轨迹。`metrics.algorithm` / `training-summary.algorithm` 如实标注。

TS 侧 `normalizeTrainingSpec` 与引擎侧 `requested_algorithm` 对未知算法名都
直接拒绝（API 400 / 进程异常）——不会静默退回 PPO。验证：
`npm run verify:starter-engine` 同时跑两个算法并断言 SAC 的 `alphaCurve` 非空
（梯度真的执行过，而不是只走了采样路径）。

设备选择：`RDK_STARTER_ENGINE_DEVICE=auto`（默认，CUDA 可用即用 GPU，否则 CPU）/ `cuda`（强制，不可用回退 CPU 并告警）/ `cpu`。`result.cuda` 如实反映实际设备；`training-summary.json` 记录 `device`/`deviceName`/`cudaRequested`。控制延迟始终按 CPU 单线程预算测量，ONNX 始终导出为 CPU runtime 制品。GPU 机器部署见 [`docs/gpu-runner.md`](../gpu-runner.md)。

## 快速上手（一条命令的真实闭环）

```bash
npm run demo:starter
```

它会：起临时台账和 local worker → 挂载 starter-ppo 引擎 → 注册 `examples/starter-ppo-manifest.json` → **真实 PPO 训练**（约 240 轮 / 1–2 分钟笔记本 CPU，`mock=false`）→ 导出 `policy.onnx` → 把引擎评测轨迹分块上传遥测 → 用未训练基线做 reference 评测（MAE/RMSE）。板端保持只读：不碰任何设备。

依赖缺失时该命令会明确退出并给出安装指引，不伪造训练结果：

```bash
python3 -m pip install --user numpy torch onnx
```

## starter-ppo 契约

`rdk-duck-policy-starter-v1`：42D 观测（`joint_cos×12 + joint_sin×12 + joint_velocity×12 + command×6`）/ 12D 动作 / 50Hz / 物理步 0.002s / decimation 10。观测布局与 manifest 中的 `observationLayout` 一一对应——平台、训练引擎和评测不共享代码，只共享这份契约。

训练 profile 预算（引擎侧上限，超出会截断并在 result 中如实记录）：

| profile | 迭代 | 并行环境 | 参考耗时 |
| --- | --- | --- | --- |
| smoke | 40 | 16 | ~10s |
| low-vram | 400 | 32 | ~2min |
| standard | 400 | 64 | ~2min |
| high-vram | 600 | 128 | ~4min |

标定数据（M 系列 CPU，64 env）：约 200 轮出现学习拐点，240 轮收敛（episode 存活 40 → 390+/400 步，successRate 0 → 1.0）。`smoke` 只验证管线，不预期学会。

引擎产物（写在 worker 任务目录，不进台账）：

- `result.json` — 受控结果契约（checkpoint / artifact / metrics，`deployable: false`）
- `policy.onnx` — 真实导出的 ONNX 策略（动态 batch，输入 `observation`，输出 `action`，已 clamp ±1）
- `telemetry.jsonl` — 训练后评测轨迹（前 200 步，可上传平台评测）
- `baseline-telemetry.jsonl` — 未训练基线轨迹（评测页的 reference）
- `training-summary.json` — 超参、物理常数、reward 曲线、控制延迟

## 把引擎接入常驻服务

```bash
# .env 或 root-only 环境文件
RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19091/train
RDK_SIM2REAL_TRAIN_EXECUTABLE=/usr/bin/python3
RDK_SIM2REAL_TRAIN_ARGS_JSON='["/abs/path/to/engines/starter-ppo/runner.py"]'
RDK_SIM2REAL_MAX_CONCURRENT_JOBS=1
npm run dev:local-worker &
npm run dev:sim2real
```

然后在工作台「训练与模型」选 local backend 提交任务。worker 保证：`shell:false`、绝对路径引擎、凭据不出现在子进程环境、未写回合法 `artifact://` 结果的任务**不会**被标记为完成。

## 换成你自己的机器人

1. 改 `PendulumChain` 的物理或整体替换为你的 MuJoCo/MJCF 环境；
2. 保持观测构造与 manifest `observationLayout` 一致（维度、顺序、物理意义）；
3. 更新 `examples/starter-ppo-manifest.json` 的契约与布局；
4. 跑 `npm run verify:examples && npm run verify:starter-engine` 校验一致性。

## 边界（诚实声明）

- `starter-ppo` 的物理是 numpy 二阶近似倒立摆链，不是 MicroDuck 全身动力学；它证明的是**训练管线、契约流转、制品导出和评测闭环都是真的**。
- `deployable` 永远为 `false`：上板需要 X5 编译制品（`.bin`/`.hbm`）+ 板端只读预检，平台会在预检处强制拦截。
- 大规模训练（万级并行、域随机化、电机模型）请使用 `mjlab-rsl-rl-adapter` + GPU。
