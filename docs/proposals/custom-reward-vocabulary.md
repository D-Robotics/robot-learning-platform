# 提案：声明式奖励词汇表（已实现，本文保留为设计依据）

> **状态（2026-09 更新）：核心范围已实现并进 verify 链。** 词汇表真源是
> `scripts/reward-vocabulary.mjs`（closed op/term/params 集 + 逐引擎能力门禁），
> 解析器把 legacy `reward` 展开为 `rewardFormula`（`scripts/resolve-task-pack.mjs`），
> 求值器是 `engines/reward_vocabulary.py`（标量 + 向量化两实现，逐位一致由测试锁定）。
> 验收标准 1–5 全部落地为测试：展开逐步同值
> （`tests/test_reward_expansion_parity.py`，16 用例）、姿态 term 在运动学引擎
> 装载时拒绝/接触引擎接受（同文件 `VocabularyRefusals`）、符号约定
> （`tests/test_reward_and_layout_invariants.py`）、环境级接线
> （`tests/test_environment_reward_parity.py`）、smoothness 课程延迟（同 parity 文件）。
> **仍属提案的部分**：命名冻结（开放问题 1）与 UI 公式编辑（开放问题 4）未做；
> 词汇表尚未作为公开契约发布，改 `op`/`term` 名仍不算破坏性变更。
>
> 下文是当时的评估稿原文，设计依据与迁移路径照旧可读；「现状」一节描述的
> 固定 5 键时代已过时，以代码为准。

## 为什么写这份文档

上游训练仓库（`Vottivott/microduck-playground` 的 `AGENTS.md`）用一整节记录**奖励设计**的踩坑，
每一条都是实测代价换来的：势能塑形而非给坏状态发奖、限速以免"到达即 jackpot"、用硬状态门而不是
小惩罚推、平滑正则必须在技能发现之后再引入、`dwell` 式每步发钱必须与终止耦合。

这些经验目前在本平台**无法表达**：奖励公式写死在引擎里。

因此要区分两件被我此前混为一谈的事：

- *"这些技巧适用于当前任务吗"* —— 部分是（我们已遵守符号约定与 jackpot 耦合，见
  [`lineage.md`](../lineage.md) 的「平台不变量」）。
- *"平台能不能让用户自定义并部署这类奖励"* —— **目前不能**。这才是本文要解决的问题。

## 现状（已核实）

奖励在引擎里是固定 5 键的字面表达式，`starter-ppo` 与 `mjx-adapter` 各有一份：

```python
reward = (reward_cfg["progress"]      * (prev_dist - distance)
        + reward_cfg["actionPenalty"] * mean(|clip(action)|)
        + (reward_cfg["goal"]        if success  else 0.0)
        + (reward_cfg["collision"]   if collided else 0.0))
if "dwell" in reward_cfg and distance < goal_eps * 1.5:
    reward += reward_cfg["dwell"]
```

| 维度 | 现状 |
| --- | --- |
| 可自定义的部分 | 5 个键的**数值**（含正负） |
| 不可自定义的部分 | 参与计算的**项本身**：无法新增梯度、无法改条件、无法插入状态门 |
| 平台层校验 | `resolve-task-pack.mjs` **原样拷贝** `reward`，不校验键；`qualityGate` 只校验成功/碰撞 |
| 自定义环境/奖励 | **无机制**。`docs/sim2real-plugins.md` 的插件是**事件总线**（实验追踪／通知／存储／硬件适配），不参与训练 |

### 顺带发现的一处引擎分歧（本提案的直接动因之一）

两个引擎对**缺失键**的处理不同：

| 引擎 | 写法 | 缺失键的行为 |
| --- | --- | --- |
| `starter-ppo` | `reward_cfg["progress"]` | **KeyError**，训练直接失败 |
| `mjx-adapter` | `self.reward_cfg.get("progress", 0.0)` | **静默算作 0**，该项不存在 |

同一个 pack 因此在两个引擎上表现不同：starter 上响亮失败，mjx 上悄悄少了一项奖励。
`dwell` 是唯一两边一致的（都表示"不加"）。平台层没有任何校验能发现这一点——
这正说明"奖励是一份需要被校验的声明"，而不是一组随引擎解释的松散键。

## 目标与非目标

**目标**

1. 让 pack 能声明**参与计算的项**，而不只是数值。
2. 把上游那类踩坑**编码成结构**，使错误写法难以表达、正确写法自然。
3. 声明了却**测不出来**的项必须**拒绝装载**，绝不静默变成无操作。
4. 现有 5 个 pack 与已发布契约**逐字节不变**。

**非目标**

- 不引入任意代码执行（不允许 pack 携带 Python/JS 片段）。这是控制面，不是脚本宿主。
- 不改物理模型。运动学环境缺的量就是缺，靠声明补不出来（见能力矩阵）。
- 不做"自动奖励搜索/调参"。本提案只解决**表达**与**校验**。

## 设计：词汇表 + 能力门禁

### 提议形状（pack 内新增可选键 `rewardFormula`）

```json
{
  "reward": { "progress": 1.0, "goal": 10, "collision": -5,
              "actionPenalty": -0.01, "dwell": 0.2 },
  "rewardFormula": [
    { "op": "potential",  "term": "progress" },
    { "op": "potential",  "term": "upright", "weight": 0.5, "params": { "axis": "z" } },
    { "op": "impact",     "term": "accel_z", "weight": -0.02 },
    { "op": "gate",       "term": "support_contact", "requires": "any_wheel_contact" },
    { "op": "rate_limit", "term": "goal_reach", "max_rate": 0.1 },
    { "op": "smoothness", "term": "action_rate", "weight": -0.2,
      "curriculum": { "introduce_after_iteration": 500 } }
  ]
}
```

**迁移路径：`reward` 变成 `rewardFormula` 的语法糖。** 现有 5 个 pack 不动；省略 `rewardFormula`
时，平台按固定映射把它展开为等价的词汇表（`progress`→`potential`、`collision`→`terminal_penalty`、
`dwell`→`gated_bonus` 等）。这让老 pack 逐字节不变，同时只维护**一套**语义。

### 关键设计决定（每条对应一条上游踩坑）

| `op` | 编码了哪条经验 | 为什么是结构而不是约定 |
| --- | --- | --- |
| `potential` | "用势能塑形，不要给坏状态发正奖" | 势能项按 Δφ 结算：上升得正、保持为零，**在数学上不可 farm**，不依赖作者自律 |
| `rate_limit` | "任何 'reach X' 奖励必须限速/缓变" | 限速是运行时机制；提前到达不额外付钱，于是"慢"就是 argmax |
| `gate` | "用硬状态门编码什么算这个动作，别用小惩罚推" | 门是布尔条件，不是可被 trade-off 掉的软权重 |
| `impact` | "把反暴力压力放在冲击与抖动上，而不是限速旋转" | 单独一类，避免与运动阻断项混为一谈 |
| `smoothness` | "平滑正则只能在技能发现之后引入，否则'什么都不做'赢" | `curriculum.introduce_after_iteration` 是项自带的字段，不能忘 |
| `terminal_penalty` | "符号约定：惩罚项加权后必须 ≤ 0" | `op` 决定符号方向，**作者不再需要判断正负号** |

符号方向由 `op` 决定是本提案最有价值的一点：当前权重符号是极易搞错、且搞错后会**静默变成
"为违规发钱"**的地方。我们已加断言守住（`npm run verify:invariants`），但把符号编码进 `op` 更彻底。

### 逐引擎能力门禁（本提案的硬约束）

每个 term 声明它需要哪些**状态量**；pack 校验时与目标引擎的能力做交集，缺一项即**拒绝装载**，
并给出可执行的错误信息（"该引擎测不到 `upright`：运动学模型无姿态量"）。

已核实的可用量（源码位置）：

| term 类别 | 需要 | `starter-ppo` | `mjx-adapter` |
| --- | --- | --- | --- |
| 距离/朝向/目标 | `x, y, θ, goal` | ✅ | ✅ |
| 动作类（`action_rate`、限速） | `action`、内部计时 | ✅ | ✅ |
| 姿态类（`upright`、倾角势能） | 姿态 | ❌ **无姿态量** | ✅ `gravity_body` 已算出 |
| 接触类（`support_contact`、冲击） | 接触/加速度 | ❌ **无接触** | ✅ `data` 内有接触 |
| 体角速度/角动量 | `body_omega` | ❌ | ✅ 已算出 |

**重要发现（决定实现成本的差异）**：`mjx-adapter` 的 `_read_truth` **已经算出** `yaw`、
`body_omega`、`gravity_body`，只是没有传给奖励点——
`_task_outcomes(state, x, y, action)` 只接收任务标量。所以对 mjx 而言，姿态/接触类 term 是
**接线工作**，不是新增测量能力。而 `starter-ppo` 的 `GoalNavEnv` 是 2D 运动学模型，
**要加就得改物理模型**——所以能力矩阵里的 ❌ 是真实的、不可用配置绕过的。

## 兼容性与风险

| 风险 | 处理 |
| --- | --- |
| 老 pack 行为漂移 | `rewardFormula` 缺省；`reward` 展开为**等价**公式，并用「展开结果与原实现逐步同值」的测试锁定 |
| 同一 pack 两引擎行为不同（已在现状中发现） | 能力门禁把分歧从"运行时静默"提前到"装载时拒绝"；缺失键不再有默认值 |
| 词汇表成为公开契约、改名昂贵 | 先以**提案**评审；`op`/`term` 命名冻结前不进任何 pack |
| 恶意/错误公式导致奖励爆炸 | 权重与 `params` 全部有界；`potential` 按 Δφ 结算天然有界；装载时拒绝未知 `op`/`term`/`params` 键 |
| 训练中改公式（课程） | 只允许 `curriculum.introduce_after_iteration` 这一种**声明式**阶段切换，不做运行时热改 |

## 验收标准（实现时）

1. 5 个现有 pack 的展开公式与原硬编码实现**逐步同值**（数值级测试，不是"看起来一样"）。
2. `starter-ppo` 上声明姿态类 term → **装载时拒绝**，错误信息指名缺哪个量、为什么。
3. `mjx-adapter` 上同一声明 → 通过，且奖励确实包含了姿态项（用一个能区分"接线对了"与"接线错了"的断言）。
4. 符号约定：任何 `terminal_penalty`/`impact` 加权后 ≤ 0，由 `verify:invariants` 扩展覆盖。
5. 课程阶段：`introduce_after_iteration` 之前该权重为 0，之后生效（可单测，无需真训练）。

## 开放问题（需要产品决策，故本稿止于此）

1. **命名**：`op`/`term` 一经发布即为公开契约，是否要先在内部统一命名再公开？
2. **范围**：是否一次做完，还是先做**两个引擎都能测**的子集（`potential` / `rate_limit` /
   `smoothness` / `terminal_penalty`），把姿态/接触类留给 mjx 接线之后？
   —— 倾向后者：它先打通"自定义奖励"这条路并验证词汇表设计，且不改物理模型。
3. **是否允许用户自带项**：本提案明确**不允许**任意代码；若将来需要，应作为独立提案
   （沙箱、审计、资源上限），不并入本词汇表。
4. **UI**：pack 编辑页是否暴露公式编辑？词汇表校验是服务端真源，UI 只是投影。
