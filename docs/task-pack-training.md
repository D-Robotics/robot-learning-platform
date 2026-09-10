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
| OriginBot（rdk-originbot） | `originbot-imu-odom-v1`：x, y, sin, cos, dx, dy, v, w | 8→2 | CPU 400 迭代 ≈166 s，nominal 成功率 83%，gate PASS |
| 通用差速（S100 契约） | `imu-gravity-v1`：gyro, gravity, 指令, 机体系目标差, twist, 零填充 | 42→2 | 同一引擎同一任务族训练（诚实标注 synthetic，未接真机） |

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
| `angularBiasRadSec` | −0.05–0.05 | 角速度常值偏差 |
| `actionLatencySteps` | 0–2 | 动作延迟步数 |

评测用**钉死的信封**（`evalEnvelopes`，固定值非区间）：

- `nominal`：标称动力学 —— 质量门只看这组；
- `hard`：弱电机 + 大噪声 + 2 步延迟 —— 只向人报告鲁棒性，不参与发布裁决。

实测（OriginBot，400 迭代）：nominal 83% / hard 50% 成功率——随机化的代价可见、
鲁棒性被量化，而不是被假设。

## 课程学习

成功率（近 50 episode 滑窗）≥ 70% 时目标距离 ×1.15 扩张，封顶 `finalGoalDistance`。
实测从 0.8–1.2 m 推进到 2.45–2.5 m。

## 质量门（fail-closed）

`qualityGate: {minSuccessRate: 0.7, maxCollisionRate: 0.15}`，裁决规则：

- 只用 **nominal 信封**的实测指标；
- 指标缺失 = FAIL（从不因"没测"而通过）；
- 引擎写 `eval-report.json`，TS 侧 `validateTaskPackEvalForRelease`
  **重算**裁决（不信引擎的布尔值），接进发布链。

## 复现

```bash
# 解析查看 task-pack
node scripts/resolve-task-pack.mjs originbot-goal-navigation

# 本机真训练（standard 预算 ≈3 分钟 CPU）
node -e "
const {resolveTaskPack, trainingRequestFor} = await import('./scripts/resolve-task-pack.mjs');
const pack = resolveTaskPack('originbot-goal-navigation');
const request = trainingRequestFor(pack, {profile: 'standard'});
require('fs').writeFileSync('/tmp/request.json', JSON.stringify(request));
" --input-type=module
cd /tmp && RDK_SIM2REAL_REQUEST_FILE=request.json RDK_SIM2REAL_RESULT_FILE=result.json \
  python3 ../<repo>/engines/starter-ppo/runner.py
# 结果：result.json / policy.onnx / eval-report.json / telemetry.jsonl
```

## 诚实边界

- S100 机型的验证是**纯仿真**的（profile 标注 `mock: true`）；它证明的是"平台换
  机型不改代码"，不是"S100 已上板"。
- 板端低速 canary 运动仍需平台双开关 + 现场安全区 + 急停演练（见 roadmap P1）。
- 微型冒烟预算（smoke, 40 迭代）学不出策略，gate 会如实 FAIL——这是特性不是缺陷。
