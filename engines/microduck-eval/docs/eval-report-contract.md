# 评测报告契约（eval-report.json）

本文件定义 MicroDuck 任务级评测的**判据**。任何"成功率"只有落在下面这套信封与前提里
才成立；脱离信封的数字不进入判定。

## 1. 为什么要写这份契约

平台现有的发布判定（Wilson 95% 置信下界、fail-closed 质量门）挂在 task-pack 线上，
指标是导航语义（`successRate` / `collisionRate`）。MicroDuck 侧只有 `meanReward`：
上游 trainer 不打印任务成功率，适配器**刻意**把 `recentSuccess` 恒置 0 而不是编造。
于是"4096×6000 跑完算不算成功"无法判定，只能看奖励曲线猜。

这份契约把"算不算成功"写成物理可核对的判据，并**强制记录结论成立的前提**。

## 2. 信封（envelope）

信封 = 一组钉死的评测条件。同一策略、同一信封、同一实现 ⇒ 同一组数字。

| 字段 | 含义 |
| --- | --- |
| `seed` | 唯一随机源；每个 episode 用 `seed + 7919*i` 派生初态，整封信封可由一个整数复现 |
| `episodes` | 证据量。**0 个 episode 不产生任何比率**，报告标 `insufficientEvidence`，门禁 fail-closed |
| `episodeSeconds` | 单回合时长（默认 4.0 s，200 控制步 @50 Hz） |
| `initialState` | 初始位姿/朝向及其均匀抖动；球位（距离 + 横向）及其抖动 |
| `command` | 全程恒定的 13 维命令（twist 3 + head_pose 4 + body_pose 6） |
| `commandDropout` | 指令丢帧概率（丢帧时保持上一动作） |
| `gyroNoiseStd` | 陀螺通道噪声（rad/s） |
| `payloadFraction` | 躯干附加负载（占名义质量比例） |

三条信封：

* **nominal** — 工厂标定、无障碍、无外部扰动；球位前向 ±2 cm（与上游
  `BALL_POS_NOISE_XY` 同量级）。**发布门禁读它的置信下界**。
* **hard** — 初始位姿偏移、球位 ±5 cm、2% 丢帧、陀螺噪声、+5% 负载。与 nominal
  并列报告，让鲁棒性代价显式可见，而不是靠一句"也有域随机化"暗示。
* **endurance** — 60 s 存活信封，无球，扰动与 nominal 同级。**时长本身是考验**：
  4 s 的回合分不出"平衡"和"还没来得及摔"，社区平衡类实验（如篮球平衡）报
  60 s 存活率正是因为 4 s 说明不了任何事。搭配 `balance` 任务使用；
  endurance + hard 扰动是另一封信封，必须显式命名，不许暗示。

上游 BallKick 的球位是**任务前提**而非策略可修正量：actor 对球完全盲
（ball-blind，球状态只进 critic）。所以信封里的球位抖动是"操作员把鸭子对准球"的
误差预算，不是策略要解决的东西。

## 3. 指标定义

比率一律配 Wilson 95% 区间；测量量一律为物理单位并附样本标准差。

| 指标 | 定义 |
| --- | --- |
| `successRate` (+CI) | 满足该任务成功判据的 episode 比例 |
| `fallRate` (+CI) | 摔倒的 episode 比例。**与 `1 - successRate` 分开**：站着不动不动也能失败，摔了也可能把球踢出去 |
| `collisionRate` (+CI) | 躯干与地面接触的 episode 比例 |
| `episodes` | 证据量 |
| `meanEpisodeLength` | 平均回合时长（秒），用于识别提前终止 |
| 任务测量量 | 见下，逐项平均并给 std，绝不合并成单一分数 |

### 3.1 摔倒判据（两任务共用）

`minBaseHeightM < 0.06 m` **或** `maxTiltRad > 1.05 rad`（约 60°）。
两个阈值都写在 `tasks.py` 的判据定义里，随报告一起输出。

### 3.2 `ball-kick` 成功判据

球心相对回合初的位移 `≥ 0.35 m`，且峰值球速 `≥ 0.50 m/s`，且**未摔倒**。

对照上游 `microduck_ball_kick_env_cfg.py` 的物理量：球 70 mm / 15 g，
出生点 `BALL_OFFSET_X = 0.09`（脚尖前方）、`|BALL_OFFSET_ABS_Y| = 0.042`，
目标球速 `BALL_TARGET_SPEED = 1.0 m/s`。本判据的 0.35 m / 0.5 m/s 是**判据阈值**，
不是上游奖励目标——报告把两者都写进 `taskDefinition`，方便对照而非混淆。

测量量：`ballTravelM`、`ballForwardM`、`ballPeakSpeedMps`、`ballMeanSpeedMps`、
`minBaseHeightM`、`maxTiltRad`。

### 3.3 `walking-velocity` 成功判据

稳态窗口（`t ≥ 1.0 s`）内 `|平均速度 − 命令速度| ≤ 0.15 m/s`，累计前进 `≥ 0.20 m`，
且未摔倒。单位是 m/s，可以用秒表复核。

测量量：`meanSpeedMps`、`commandedSpeedMps`、`speedTrackingErrorMps`、`forwardM`、
`minBaseHeightM`、`maxTiltRad`。

### 3.4 `balance` 成功判据

整回合存活（摔倒判据同 3.1，任意步触发即失败）。**站着不动就是成功**——
对平衡任务而言"什么都不多做"正是任务本身；这与 walking/ball-kick 的
"必须做到什么"是两类判据，报告里 `fallRate` 与 `1-successRate` 因此重合是
预期行为而非统计问题。配套测量量 `survivedSeconds`：摔了的回合记录摔倒时刻
（存活多久），没摔的记录整回合时长。

### 3.5 循环策略（LSTM 等）

导出图除 `obs[*,61] → actions[*,14]` 外，可携带成对的状态输入/输出
（如 LSTM 的 `h/c`，形状按声明保留，符号维按 batch=1 处理）。约束：

* 状态配对按名字优先（`h_in`/`h_out`、`initial_h`/`h`），尺寸回退只认
  **未配对**输入中尺寸唯一者；配不上的图**拒绝加载**（fail-closed），
  绝不猜一个喂法——猜错的循环策略输出的是"看起来合理"的动作，不是报错。
* **每个 episode 开始时状态清零**（`rollout` 调 `policy.reset()`）。
  没有这条，第二回合起测的是"带着上一回合记忆的策略"，数字看着正常，
  测的东西是错的。
* 报告的 `dynamicsFacts.policyFacts` 记录 `recurrent` 与状态端口名；
  基线列的同等事实记录在 `dynamicsFacts.baselinePolicy`。

## 4. 硬前提：`dynamicsFacts`（不可省略）

**没有这些字段的成功率是无效证据。** 报告强制携带：

| 字段 | 为什么必须有 |
| --- | --- |
| `dynamics` | `cpu-mujoco` 或 `mjlab-mujoco-warp`。两套动力学的成功率**不可互换比较** |
| `actuator` | `mjcf-position`（本机）或 BAM 电机模型（上游训练）。执行器保真度是小鸭子 sim2real gap 的主要来源 |
| `bamAvailable` | 本机是否能加载 BAM。当前恒 `false` |
| `scene` / `sceneSha256` | 用的是哪个 MJCF，字节级钉死 |
| `policy` / `policySha256` | 被评的是哪个 ONNX |
| `policyFacts` | 策略是否循环（`recurrent`）及状态端口名；喂错状态的数字无效 |
| `baselinePolicy` | 基线列用的什么：默认零动作地板，`--baseline-policy` 指定参照策略（同一信封同前提并排，"比谁好多少"从 README 里的说法变成报告里的数字） |
| `actionScale` | 动作→关节目标的缩放（上游用 1.0，导出图不含 scale） |
| `controlHz` | 50 Hz |
| `jointOrderVerified` | 14 个执行关节在编译后模型里的 qpos 顺序是否等于训练顺序 |
| `taskDefinition` | 判据阈值本体 |
| `envelopeNames` | 本次读了哪几封信封 |
| `parallelEnvs` | 本机 1（单环境） |

## 5. 判定规则

沿用平台既有语义，不另造统计量：

* 门禁默认读 **nominal 信封的 `successRateCiLow`**（Wilson 95% 下界），
  与 `shared/artifact-quality-gate.ts` 的 `gateOn=ciLowerBound` 一致；
* `minSuccessRate` 默认 0.70，`maxCollisionRate` 默认 0.10；
* 证据不足（0 episode、缺置信界、缺 nominal）= **FAIL**，绝不静默通过；
* 基线对照：`baseline` 是**零动作策略**（保持 HOME 位姿）在同一信封下的成绩。
  它同时是两个东西：学到的策略必须超过的地板，以及"评测装置能不能报出失败"的自检。

### 5.1 装置资格（`harnessQualification`）

在给出任何关于策略的结论之前，先证明这套装置能区分好坏。判据是**零动作基线的成绩**：
零动作保持 HOME 位姿，一个动力学/执行器忠实的仿真里它至少不该立刻摔。

若零动作基线在某封信封里 **全部 episode 都摔倒**，`harnessQualification.passed = false`，
`qualityGate` 被强制 FAIL（无论被评策略的数字多好看），原因是装置本身不足以支撑
"策略能不能做这件事"的结论。这条规则的意义是：把"装置不成立"和"策略不行"从一开始
就分开，而不是让人对着一个假的 0% 成功率去调策略。

当前实现下这条为 **false**（见第 6 节实测），这是如实上报，不是缺陷掩盖。

## 6. 已知的诚实边界（当前实现）

### 6.1 执行器标定（已修，附实测）

MJCF 里那组位置执行器是 **mjlab 加载前的占位参数**：`kp = 0.55` N·m/rad，力上限 ±0.96 N·m。
训练时 mjlab 会用 BAM 的电压控制模型（`kp_fw = 200`）替换它，所以直接跑原始 MJCF 等于
让鸭子用弱约 3.5 倍的关节去站——**什么都活不下来**，这正是第一次评测（`evidence/eval-ballkick-untrained-smoke-*.json`）
里零动作基线 50/50 全倒的原因，与策略无关。

零动作基线（保持 HOME、平地、4 s）实测扫描：

| 位置刚度 kp (N·m/rad) | 结果 | 最大俯仰 | 4 s 后躯干高度 |
| --- | --- | --- | --- |
| 0.55（场景原值） | 0.90 s 向后倒 | 81.6° | 0.032 m |
| 1.00 | 1.50 s 倒 | 81.2° | 0.038 m |
| **1.50** | **未倒** | 5.3° | 0.116 m |
| **2.00（当前标定值）** | **未倒** | 2.9° | 0.116 m |
| 3.00 | 未倒 | 1.7° | 0.116 m |

另有两点必须记下来，否则会重犯：

1. **力上限必须一起放开。** 早期一次扫描"提高 kp 反而倒得更快"，是因为 `forcelimited`
   没打开、torque 被 XML 的 ±0.96 夹住，看起来像刚度越高越糟——那是伪结论，已作废。
2. **BAM 端口的抗饱和输出比标定值软。** `engines/microduck-eval/microduck_eval/actuator.py`
   按 `bam.actuator.VoltageControlledActuator` 移植了电压控制律：`duty = kp_fw * error_gain * Δq`
   = `200 × 0.002877` = **0.575**，即 0.13 rad 误差只给 7.5% 占空比 → 0.076 N·m，
   小于保持站立所需的力矩，因此 `--actuator-model bam` 目前仍站不住。要么上游的
   `error_gain` 语义与我们的读法不同，要么它需要额外的缩放；在拿到一个**训练过**的策略之前
   无法判定，所以**默认走标定后的位置执行器**（它是唯一被测出能撑住基线的模型），
   BAM 路径保留作对照，并在 `dynamicsFacts.actuatorFacts` 里如实标注两者参数。

因此当前 `cpu-mujoco` 结论的适用范围是：**同实现内比较**（策略 A vs B、nominal vs hard、
这一版 vs 上一版）。跨实现、跨真机的推断仍然需要板子或 BAM 的进一步对齐。

### 6.2 其它

* **单环境、CPU**：本机不做并行物理；吞吐与上游 4096 环境无可比性。
* **策略前提**：本机目前**没有任何训练过的 MicroDuck 策略**（`.data` 里的
  `policy.onnx` 全部来自 5 轮冒烟档，README 已注明是"没训练过的权重"）。所以
  "标定后的装置能撑住零动作基线"是已证的，"它能公平评价一个学会走路的策略"**尚未证**——
  需要一个真训练产物（GPU 正式档或上游官方策略）来闭环。
* **无相机、无多机**：观测里没有视觉槽位；多鸭子场景尚未建立。

## 7. 产物接入平台

顶层键（`taskId` / `adapterId` / `observationAdapterId` / `trained` / `baseline` /
`qualityGate` / `seed` / `controlLatencyMs` / `measurementStage`）与 `shared/task-evaluation.ts`
的归一化边界一致，因此报告可直接进现有质量门，无需新增管道。`dynamicsFacts` 与任务测量量
是**新增的诚实字段**：归一化层目前会丢弃未知键，需要扩展为保留白名单内的任务测量量，
否则"踢了多远"这类证据到不了决策页。

### 7.1 `controlLatencyMs` 必须带 `measurementStage`

本引擎的 `controlLatencyMs` 是 **CPU MuJoCo 步进的平均耗时**，不是推理延迟，也不是任何
控制回路预算；因此报告写 `"measurementStage": "sim-step"`。归一化层允许的取值：

| 取值 | 含义 |
| --- | --- |
| `host-torch` | 训练主机上的 PyTorch 前向（starter-ppo 的 32 次中位数） |
| `host-onnx` | 训练主机上的 ONNX 前向 |
| `board-onnx` | **板端** ONNX 前向，唯一可作为上板证据的阶段 |
| `sim-step` | 仿真步进耗时（本引擎） |
| `unknown` | 未声明；归一化层对缺失或非法值都落到这里，绝不默认成板端 |

只有 `board-onnx` 收据能支撑"可部署"判定（见 `shared/board-rehearsal.ts` 与
[`docs/host-station.md`](../../../docs/host-station.md) 的 rehearsal 一节）。
把本引擎的 `sim-step` 数字当作控制预算，会在板端引入数量级的误判。
