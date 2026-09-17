# 真实训练引擎

本仓库自带两个引擎目录，都通过 `services/sim2real-web/local-training-worker.mjs` 的文件协议接入（读 `RDK_SIM2REAL_REQUEST_FILE`，写 `RDK_SIM2REAL_RESULT_FILE`）：

| 引擎 | 依赖 | 定位 |
| --- | --- | --- |
| `engines/starter-ppo` | numpy + torch（+ onnx 可选导出） | **开箱即用的真 PPO/SAC**：numpy 向量化 12 关节倒立摆物理 + torch PPO 或 SAC（**自动检测 CUDA**）+ ONNX 导出 + 遥测/baseline 导出 |
| `engines/mjlab-rsl-rl-adapter` | rsl-rl-lib==2.2.3（mjlab 可选） | 生产训练栈适配：kinematic 后端已可用真实 rsl_rl `OnPolicyRunner` 训练；mjlab 物理引擎为显式接入点 |
| `engines/mjx-adapter` | jax + mujoco(含 `mujoco.mjx`) + optax + onnx | 真 MuJoCo 接触动力学（MJX 批量物理 + 纯 JAX PPO，无 flax/brax/torch 依赖）；本机 CPU 跑真路径，见 [`mjx-adapter.md`](mjx-adapter.md) |

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
python3 -m pip install --user -r engines/starter-ppo/requirements.txt   # 锁定版本 + 哈希校验
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
- `SHA256SUMS` — 本次运行**全部产物**的摘要清单（见下）
- `checkpoints/iter-XXXXX.pt` — 周期 checkpoint（每 iterations//8 轮 + 最后一轮）

### 血缘与完整性：`source` + `SHA256SUMS`

每个引擎在结果里报告两样东西，解决的是两个不同的"说不清"：

**0. 归因的两个半边。** 可复现需要同时回答"哪份代码"和"哪套库"：`sourceCommit` 只答前者，
而 `torch.onnx.export` 的产物会随版本变化，数值也会随 torch 版本漂移。所以每个结果同时带：

```json
"source": {"known": true, "commit": "eec53b5…", "dirty": true, "ref": "main"},
"dependencies": {"numpy": "2.0.2", "torch": "2.8.0", "onnx": "1.19.1", "onnxruntime": "1.19.2"}
```

`dependencies` 记录的是**实际安装**的版本（`importlib.metadata` 查询，不是请求值），缺哪个就不写哪个。
`npm run verify:training-provenance` 会真跑引擎并断言两者都在、且版本是具体值（不断言具体版本号，
那属于锁文件的职责）。运行详情页显示短哈希与依赖版本。

**1. 这段代码是哪个版本？** 包里只有 `starter-ppo-0.1.0` 这类版本号，树一旦往前走就答不出
"这个 onnx 是哪份 reward/observation 代码训出来的"。所以 result 顶层带一个 `source`：

```json
"source": {"known": true, "commit": "eec53b5…", "dirty": true,
           "repository": "https://github.com/…", "ref": "main"}
```

- `dirty: true` 表示工作树有未提交改动 —— 记录的 commit **不能**完整描述实际运行的代码。
  如实说出来，比暗示可精确复现更重要；`dirty` 为 `null` 表示无法判定。
- 没有 `.git`（打包上板的安装、容器）时是 `{"known": false, "reason": …}`：**不编造**身份，也不让训练失败。
- 同一个 commit 也进 `metrics.sourceCommit`，与 `measurementStage` 同层，运行详情页显示短哈希。

三个引擎统一。`mjx-adapter` 的推理延迟另标 `measurementStage: "host-jax"` —— 它是 JAX 前向，
不是 torch 也不是 onnx，不套用别的阶段名。

**2. 这个目录里的东西是一起产出的吗？** 单个文件的摘要证明不了同目录其它文件没被动过。
引擎在写 `result.json` **之前**按目录实际内容生成 `SHA256SUMS`（自动收录，未来新增产物不会漏掉；
只排除 `SHA256SUMS` 自身与作为输入的 `request.json`）。worker 在发布 run 之前逐条核验：

| 情况 | 行为 |
| --- | --- |
| 全部匹配 | run 完成，`artifactVerification.verified = true`，列出已核验文件 |
| 有 `SHA256SUMS` 但内容不符 / 文件缺失 / 格式损坏 | **run 失败**（`artifact_manifest_mismatch` 等），不发布任何制品 —— 这是损坏或被改写，必须 fail-closed |
| 没有 `SHA256SUMS` | 视为**早于该契约的引擎**：run 仍完成，但 `verified: false` 随记录同行，下游不能把它读成"已核验完整性" |

`result.json` 自身不在清单内（它写在清单之后），其完整性由平台归一化后的 `reportSha256` 单独覆盖。

### 为什么传递依赖也必须显式钉住（实测教训）

初版只钉直接依赖，`uv pip compile` 负责传递闭包。结果 `verify:engine-locks` **在干净缓存下误报过期**：
`requirements.in` 一个字没改，`filelock` 却解析出两个不同版本（3.32.7 与 4.0.0）——因为
`torch 2.8.0` 对 `filelock` **没有上界约束**。

这暴露了一个容易忽略的事实：**锁文件无法回溯性地固定未来的解析**。它不是"从今往后的保证"，
而是"这一次解析的快照"；只要传递依赖里有一个无人约束，下次新解析就可能不同。

所以当前做法是：**发现漂移就把那个传递依赖钉进 `requirements.in`**（现已钉 `filelock`），
让 `requirements.in → requirements.txt` 成为一个**稳定的函数**，而不是某次解析的偶然结果。
`npm run verify:engine-locks` 因此连续运行结果一致，而不是随上游发版翻转。

顺带记录一个仍然存在的边界：`dependencies` 只采集引擎直接导入的少数几个库
（numpy / torch / onnx / onnxruntime / jax / mujoco），所以**传递依赖的版本无法与之逐一比对**。
补上这个洞的是 `dependencyLockSha256`：每个产物记录**锁定文件自身的摘要**，门禁校验它与当前锁一致。
这样两个 run 是否使用同一套声明的依赖集合，是可以事后审计的——即使无法逐包核对。

## 周期 checkpoint 与 best 策略选择

训练循环按 `max(1, iterations // 8)` 的间隔保存 `checkpoints/iter-XXXXX.pt`（含 `model_state`、曲线尾部、观测/动作维度）。训练结束后，引擎会**探测**最后 4 个 checkpoint（每个 4 回合轻量评测，按 successRate → collisionRate → 迭代数排序），把探测最优的权重用于正式评测和 `policy.onnx` 导出——最后一轮不一定是最好的策略。排序键末位是迭代数降序：平分时最新者胜，探测只会"提升"不会静默倒退。探测失败（文件损坏等）静默回退最终权重，不会让任务失败。选择结果记录在 `training-summary.json` 的 `checkpoints` 块和 `result.json` 的 `checkpoint.selectedIteration / selectedByProbe`。

## Run 页自动回放与浏览器策略试跑

运行完成后的两条闭环（无需手动导入）：

- **自动挂载评测回放**：状态轮询首次观察到 `completed` 时，平台从 worker 拉取该任务的 `telemetry.jsonl`（`GET /runs/:id/telemetry`，与制品同一套所有权/完成态校验），以确定性幂等键 `eval-replay-<runId>` 分块（≤5000 样本/块）写入遥测管线，`source: 'browser'`。前端随后自动加载 `GET /runs/:id/replay` 并把帧推给嵌入仿真器画轨迹（不驱动物理）。对账（reconcile）路径保持单请求契约，不额外拉取。
- **浏览器 ONNX 策略试跑**：`GET /runs/:id/policy.onnx` 下发经 SHA-256 校验的策略字节（与板端下发同一套证据门槛：completed、非 mock、本地后端、有摘要）。Run 页「策略试跑」按钮通过 postMessage 让嵌入仿真器用本地 vendored 的 ONNX Runtime Web（`public/vendor/onnxruntime-web/`，无 CDN、wasm 同源）推理 8D 观测 → 2D normalized-twist，经仿真器自己的 `/cmd_vel` 投影驱动小车。推理全程在 iframe 内完成（postMessage 不能传函数），状态通过 `rdk-policy-status` 消息回报。试跑是操作员辅助视角，不构成发布证据。

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

然后在工作台「强化学习训练」选 local backend 提交任务。worker 保证：`shell:false`、绝对路径引擎、凭据不出现在子进程环境、未写回合法 `artifact://` 结果的任务**不会**被标记为完成。

starter 是请求未指定 `training.engine` 时的**平台默认引擎**。同机注册其他引擎（如
MJX）时保持本引擎为基础配置即可，见
[`engines/mjx-adapter` 的双引擎注册](mjx-adapter.md)；Kinematic 任务包
（`goal-navigation` 系列）不声明 `recommendedEngine`，始终默认走这里。

## 换成你自己的机器人

1. 改 `PendulumChain` 的物理或整体替换为你的 MuJoCo/MJCF 环境；
2. 保持观测构造与 manifest `observationLayout` 一致（维度、顺序、物理意义）；
3. 更新 `examples/starter-ppo-manifest.json` 的契约与布局；
4. 跑 `npm run verify:examples && npm run verify:starter-engine` 校验一致性。

## 边界（诚实声明）

- `starter-ppo` 的物理是 numpy 二阶近似倒立摆链，不是 MicroDuck 全身动力学；它证明的是**训练管线、契约流转、制品导出和评测闭环都是真的**。
- 需要真 MuJoCo 接触动力学时用 [`engines/mjx-adapter`](mjx-adapter.md)（纯 JAX，CPU 可跑真路径，台账标注 `physicsBackend=mjx`）。
- `deployable` 永远为 `false`：上板需要 X5 编译制品（`.bin`/`.hbm`）+ 板端只读预检，平台会在预检处强制拦截。
- 大规模训练（万级并行、域随机化、电机模型）请使用 `mjlab-rsl-rl-adapter` + GPU。
