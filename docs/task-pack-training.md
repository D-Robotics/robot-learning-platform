# Task-Pack 声明式训练（目标点导航）

> 本文档描述平台的真实训练路径：任务与机型都是声明文件，换机器人不改引擎代码。
> 设计背景见 [`docs/design/sim2real-platform.md`](./design/sim2real-platform.md)；
> 差距分析见 [`docs/roadmap.md`](./roadmap.md)。

## 一个 Task-Pack 是什么

```text
tasks/<taskId>.json          任务：奖励权重 / 终止条件 / 障碍空间 / 课程 / 域随机化 / 质量门
adapters/<adapterId>.json    机型：安全钳制 / 决策频率 / 观测布局 / 契约维度
        ↓ scripts/resolve-task-pack.mjs（校验 + 合并）
训练请求（task 嵌入 body，经 worker 文件协议原样传给引擎）
        ↓ engines/starter-ppo/runner.py（GoalNavEnv + PPO）
policy.onnx + eval-report.json（含质量门裁决）+ telemetry.jsonl
```

新机型 = 新增一个 adapter JSON + 一个 task JSON，引擎零改动。

## 已验证的两个机型

| 机型 | 观测布局 | 维度 | 状态 |
| --- | --- | --- | --- |
| OriginBot（rdk-originbot） | `originbot-imu-odom-v1`：x, y, sin, cos, dx, dy, v, w | 8→2 | CPU 训练 nominal 成功率 74–83%（见复现一节的预算说明），gate 以 CI 下界如实判定 |
| 通用差速（S100 契约） | `imu-gravity-v1`：gyro, gravity, 指令, 机体系目标差, twist, 零填充 | 42→2 | 800 迭代 nominal 90% [CI 0.79, 0.96]、hard 86%（诚实标注 synthetic，未接真机） |

42D 布局的**机体坐标系目标差**（slots 8–10）是可学习的必要条件：世界系差量不含
朝向信息，策略无从转向。真实硬件上该量由 odom 位姿 + 目标点旋转得到。

## 观测布局与板端运行时对齐

`board-policy-runtime.py` 按契约维度选择映射：

- 8→2：原生 OriginBot 布局，slots 0–7 全部真实传感器（odom 位姿 + 目标点）。
- 42→N：`[gyro(3), gravity(3)]` 恒为真实传感器，其余槽位按"指令优先、余量零填"
  的诚实部分适配器填充（`obsSlots` 如实上报 real/adapter/zero 数量）。

引擎侧布局与上述完全一致——训练时看到的每个槽位语义，就是上板后同一槽位的语义。

## 域随机化（sim2real 转移的核心）

每 episode 按 `domainRandomization` 的范围采样一次（机器人不会中途换电机）：

| 参数 | 训练范围 | 作用 |
| --- | --- | --- |
| `motorGain` | 0.8–1.2 | 弱/强电机 |
| `lagTauSeconds` | 0.05–0.25 | 一阶执行器滞后 |
| `gyroNoiseStdRadSec` | 0–0.05 | 陀螺噪声 |
| `odomNoiseStdM` | 0–0.02 | 里程计噪声 |
| `angularBiasRadSec` | −0.05–0.05 | 角速度常值偏差（轮子刮蹭、地面不平） |
| `actionLatencySteps` | 0–2 | 动作延迟步数 |
| `odomDropoutProb` | 0–0.05 | 每 step 观测整帧丢帧概率（板端补发上一帧） |
| `slipScale` | 0.8–1.0 | 轮子滑移系数：真实位移 = 轮速积分 × slip |

后两个维度模拟的是真实板子上最常见的扰动：
- **丢帧**：传感器 publish 丢失一拍，策略看到的是重复帧；
- **滑移**：里程计盲积分轮速，**相信的位姿**与**真实位姿**随滑移分叉——
  引擎用两套位姿分别驱动观测（相信位姿）和成功判定（真实位姿），
  只"认为"自己到了终点的策略不会 PASS。42D 布局里陀螺槽位感知的是
  真实角速度（偏差只在此处可见），与板载 IMU 语义一致。

评测用**钉死的信封**（`evalEnvelopes`，8 个固定值：
`[motorGain, lagTau, gyroNoise, odomNoise, angularBias, latencySteps, dropout, slip]`；
6 值旧格式向后兼容，末两位按无丢帧/无滑移解释）：

- `nominal`：标称动力学 —— 质量门只看这组；
- `hard`：弱电机 + 大噪声 + 2 步延迟 + 5% 丢帧 + 0.8 滑移 —— 只向人报告
  鲁棒性，不参与发布裁决。

## 课程学习

成功率（近 50 episode 滑窗）≥ 70% 时目标距离 ×1.15 扩张，封顶 `finalGoalDistance`
（实测封顶 [1.5, 1.9] m——低于 `workspace.bound` 2.0，越界终止让"封顶目标"
仍然可达）。

## 奖励与终止（含防极限环的 dwell 项）

奖励 `reward`：

| 项 | 值 | 说明 |
| --- | --- | --- |
| `progress` | 1.0 | 每步距离缩短量 |
| `goal` | 10 | 到达目标一次性奖励 |
| `dwell` | 0.2 | **每步**位于 1.5×目标半径内的驻留奖励 |
| `collision` | −5 | 撞障碍一次性惩罚 |
| `actionPenalty` | −0.01 | 动作幅值惩罚 |

`dwell` 是实测出来的：纯 progress 奖励在目标附近是平的（绕目标一圈的逐步
距离增减相抵），训练会收敛到**绕轨极限环**——实测 nominal 0% 成功率但最小
距离只差 0.04 m（0.16 vs 0.12 的目标半径），42 维布局靠执行器滞后碰巧能
"荡"进去，8 维布局就永远进不去。dwell 给了恰好在稳定半径内的稠密梯度，
8D 布局 nominal 从 0% → 74%，42D 布局 0% → 90%（两次独立确认跑）。
板端实现就是同一次距离比较，无额外传感器。

> **未采用的项**：试过 `obstacleProximity` 近失惩罚（-0.3/-0.1 两档）。单跑
> 结果非单调（S100：90% → 68% → 10%），无法与训练噪声区分——已在
> `docs/research/goalnav-eval-2026-09-10-round2.json` 落档教训并回退。
> 结论：reward 项的加减要用轨迹级诊断（像极限环那样）或多种子评测佐证，
> 单跑 A/B 的 ±30 点差异是噪声。

终止 `termination` + `workspace`：

- `goalDistance: 0.15`：目标半径（操作员声明的停泊精度，0.15 m 对 0.3 m/s
  差速底盘是紧的）；
- `timeoutSteps: 200`；
- 撞障碍 / **真实位姿越 `workspace.bound`**（场景边缘 = 操作员会喊停的地方；
  同时封顶了漂移里程计的输入尺度，价值目标有界）；
- 成功/碰撞判定都在**真实位姿**上；episode 终态（末端距离、碰撞）在
  auto-reset **之前**采集——reset 后再读，读到的永远是新 episode 的干净数字
  （曾经的 collisionRate≡0 假象就是从这来的）。

## 质量门（fail-closed + 统计功效）

`qualityGate: {minSuccessRate: 0.7, maxCollisionRate: 0.15, gateOn: "ciLowerBound"}`，
`evaluationConfig: {episodesPerEnvelope: 50, confidenceLevel: 0.95}`。

**为什么不是点估计**：6 个 episode 的 100% 成功率，Wilson 95% 置信下界只有
~0.61——证据不足以支撑任何结论。每信封 50 episodes 后：

- 每个指标都带 `successRateCiLow/High`（Wilson 置信区间）与 `episodes` 数；
- `gateOn: "ciLowerBound"` 时，成功率按 **CI 下界**判定、碰撞率按 **CI 上界**
  判定——50 episodes 下 84% 点估计意味着下界 ~0.71，达标要靠下界不是运气；
- 裁判规则不变：只用 nominal 信封；指标**或置信界**缺失 = FAIL；
- 引擎写 `eval-report.json`，TS 侧 `validateTaskPackEvalForRelease` **重算**
  裁决——包括从 episode 计数重新推导 Wilson 区间并交叉核对引擎上报的
  置信界（手改过的报告过不了），接进发布链。

## 可复现性（已实测）

训练开始时引擎用 pack `seed` 播种 numpy 环境流**和 torch 学习器流**
（模型初始化 / 动作采样 / DataLoader shuffle）。跨进程确定性有契约测试
守护（`test_cross_process_determinism`）：同一请求在两个独立进程里
训练，eval 指标逐项相等。修复前 torch 流从不播种——同请求每个进程
训出不同策略，"可复现"是空话。

## PPO 数值稳定性（NaN 根因，已修）

8D 路径曾在 ~350 迭代处网络 NaN 崩溃。根因不是 loss 函数，是**训练语义**：
rollout 存储的是 clamp 到 [-1,1] 的动作，却用它自己的 log-prob——当高斯
均值漂到界外，`log_prob(±1)` 是悬崖（μ≈5 时单维 ≈ −30），importance
ratio 爆到 1e28，clip 后的分支产生 inf 梯度，权重 NaN。修法（两条路径
统一）：

1. **训练未截断的采样动作**（log-prob 配套），env 执行时饱和钳制——这才是
   PPO 的正确姿势，且对硬件语义无影响（板端本来就钳制指令）；
2. log-space ratio 护栏（`clamp(±20)`）——健康 ratio 是 O(1)，护栏只挡病态
   尾部，永不改变正常梯度。

曾有"huber 稳了但学不动"的死胡同：huber 治的是 value loss 的症状，不是
ratio 路径的病根（huber 运行同样会 NaN 到第 350 迭代），且降低 value
梯度直接杀学习。留此记录防止下次再走。

## 超参敏感性

`scripts/sensitivity-study.py`（开发机 CPU，每次 ~40 s）对 reward 权重与
终止条件做单因子 ±20% 扫描（固定 seed），记录每个因子水平下 CI 下界
与 gate 裁决，产出 `sensitivity-report.json`（落档
`docs/research/task-pack-sensitivity-2026-09-10.json`）。

短预算（150 迭代 × 32 envs）下所有 10 个因子水平 gate 一致 FAIL、
CI 下界散布仅 0.04：**裁决对权重不敏感**——失败来自预算不足（课程还没
展开），不是权重挑选。换预算不变结论 = gate 判的是证据不是运气。
但注意：短预算全部 FAIL 意味着"权重在成功区间附近的敏感性"未测到；
400 迭代成功预算下的扫描留给有 GPU 的复跑。

## 复现

```bash
# 解析查看 task-pack
node scripts/resolve-task-pack.mjs originbot-goal-navigation

# 本机真训练（标准预算；迭代数用环境变量突破 60 的 request 上限，
# 引擎如实记录实际值）。8D 布局建议 1600 迭代（学习曲线在 800 处仍在
# 上升），42D 布局 800 迭代已收敛到 nominal 90%。
node -e "
const {resolveTaskPack, trainingRequestFor} = await import('./scripts/resolve-task-pack.mjs');
const pack = resolveTaskPack('originbot-goal-navigation');
const request = trainingRequestFor(pack, {profile: 'standard'});
require('fs').writeFileSync('/tmp/request.json', JSON.stringify(request));
" --input-type=module
cd /tmp && RDK_SIM2REAL_REQUEST_FILE=request.json RDK_SIM2REAL_RESULT_FILE=result.json \
  RDK_STARTER_ENGINE_ITERATIONS=1600 RDK_STARTER_ENGINE_ENVS=64 \
  python3 ../<repo>/engines/starter-ppo/runner.py
# 结果：result.json / policy.onnx / eval-report.json / telemetry.jsonl
# （引擎把产物写进进程 CWD——worker 协议以 job 目录为 CWD 启动它，
# 产物永远落在 job 目录内，绝不信 runner 提供的路径）

# 敏感性研究（10 个短预算变体，~8 分钟）
python3 scripts/sensitivity-study.py /tmp/sensitivity-out
```

## 诚实边界

- S100 机型的验证是**纯仿真**的（profile 标注 `mock: true`）；它证明的是"平台换
  机型不改代码"，不是"S100 已上板"。
- 最终确认跑（800 迭代 × 64 envs，CPU，seed 7）：S100 42D nominal 90%
  [CI 0.79, 0.96]——**成功率侧过 CI 门**（下界 0.786 ≥ 0.70），但碰撞率的
  Wilson CI 上界 0.238 > 0.15，**碰撞侧诚实 FAIL**（点估计 0.12 达标、
  50 episodes 不足以证明它低于 0.15）。OriginBot 8D nominal 74% [CI 0.60, 0.84]
  未过成功率门——8D 布局要网络自己学会坐标旋转（世界系目标差），比 42D
  的机体系目标差更难学。完整实验记录（含被回退的项与方差教训）：
  `docs/research/goalnav-eval-2026-09-10-round2.json`。
- 板端低速 canary 运动仍需平台双开关 + 现场安全区 + 急停演练（见 roadmap P1）。
- 微型冒烟预算（smoke, 40 迭代）学不出策略，gate 会如实 FAIL——这是特性不是缺陷。
