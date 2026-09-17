# 迭代血缘（按 task id）

这份文档回答的是**纵向**问题："这条任务线是怎么走到今天的，哪些路走不通？"
横切的发布记录（`docs/real-loop-validation-*.md`、`docs/task-pack-validation-*.json`）回答不了它。

## 为什么要有这张表

只有成功记录的实验史是**没有信息量**的：它无法告诉后来者哪条路已经试过、为什么放弃。
本仓库最有价值的两条证据恰恰都是**失败**的：

- `engines/microduck-eval/evidence/eval-walking-trained-harness-unqualified-2026-09-16.json`
  记录了一次**训练后的策略在 nominal 与 hard 两个 envelope 下 50/50 集全部跌倒，而未训练基线却站得住**。
  结论不是"策略差"，而是**评测装置当时没有资格评判学习到的策略**（执行器/动力学保真度不足），
  所以它产出的任何成功率都无意义。这条记录直接催生了质量门里的 `ablation` 判据：
  **能对照基线、并且对照不出来时要拒绝**，而不是拿一个好看的数字交差。
- `eval-ballkick-untrained-smoke-2026-09-16.json` 记录了"装置本身撑不住零动作基线"，
  同样被判为 harness unqualified。

## 如何阅读

- **阶段**是同一任务线上的一次连续尝试，不是发布版本号。
- **产物**列给出可复核的引用（证据文件 / 提交 / 摘要）。没有引用的行不应被当作证据。
- **结论**必须写明"入选 / 放弃"及原因；放弃的行**保留**，这正是这份表的意义。
- 指标口径不同不可直接比较（例如早期短 battery 与最终 60 秒 battery）。每行注明口径。

## goal-navigation（OriginBot / generic 差分驱动）

| 阶段 | 改动 | 观测与结果 | 产物 | 结论 |
| --- | --- | --- | --- | --- |
| 400 iter / 64 env / CPU（originbot 适配器） | 基线配方：DR + curriculum + `ciLowerBound` 门 | nominal 成功率 **83.3%**、碰撞 0；hard **50%**；未训练基线 nominal **0%**（meanFinalDistance 0.95 m，200 步用尽） | `docs/task-pack-validation-2026-09-10.json` 第 1 条 | **入选**：跨过 0.7 门，且明显优于基线 |
| 400 iter / 64 env / CPU（generic 适配器） | 同一配方换通用机型 | nominal **83.3%**、hard **100%**；基线 nominal 0% | 同上，第 2 条 | **入选**：通用机型上 hard envelope 反而更好 |
| 单环境 CPU 评测装置（`cpu-mujoco`） | 引入 MuJoCo 接触动力学评测 | 装置能撑住零动作基线，但**没有训练过的策略可评** | `engines/microduck-eval/docs/eval-report-contract.md` §6.2 | **保留待闭环**：需要真训练产物才能证明它有资格评判学习策略 |
| `goal-navigation-clear-arena` | 清场真机 Canary 场景 | `recommendedEngine: "isaac-sim"` 被解析器**拒绝** | `scripts/verify-task-pack.mjs` 的显式断言 | **保持拒绝**：该 pack 是"未知引擎必须响亮失败"的活样本，不是可用配方 |

> 早于 `2026-09-10` 的短 battery 数字（10/20 秒存活率）使用另一套协议，**不可**与上表的 60 秒/50 集口径比较。

## ball-kick（MicroDuck）

| 阶段 | 改动 | 观测与结果 | 产物 | 结论 |
| --- | --- | --- | --- | --- |
| 未训练冒烟 | 5 轮权重，验证装置 | nominal 成功率 **0%**、跌倒率 **100%**；**harness unqualified**（零动作基线 50/50 集跌倒，最低躯干高度 0.0314 m） | `engines/microduck-eval/evidence/eval-ballkick-untrained-smoke-2026-09-16.json` | **放弃作为证据**：装置撑不住基线，成功率无意义 |
| 标定执行器后 | BAM 电压端口 + 标定 | 仍然 0% / 跌倒 100%，门未过；`ballTravelM`、`ballPeakSpeedMps`、`minBaseHeightM`、`maxTiltRad` 等物理量被保留供诊断 | `eval-ballkick-calibrated-2026-09-16.json` | **保留待真训练产物**：结论适用范围仅限"同实现内比较" |

## walking-velocity（MicroDuck）

| 阶段 | 改动 | 观测与结果 | 产物 | 结论 |
| --- | --- | --- | --- | --- |
| 训练后策略 × 本机评测装置 | 用已有策略跑评测 | **两个 envelope 各 50/50 集全跌倒，而未训练基线站住了** → 判定为装置保真度问题，不是策略问题 | `eval-walking-trained-harness-unqualified-2026-09-16.json` | **放弃该装置的成功率**；此记录是 `ablation` 判据的经验依据 |

## 有状态（循环）策略

| 阶段 | 改动 | 观测与结果 | 产物 | 结论 |
| --- | --- | --- | --- | --- |
| 契约与门禁就绪 | `contract.inputs` / `contract.state` 命名绑定 | 板端运行时**拒绝**携带状态的导出，而不是每步重放零状态 | `shared/policy-input-binding.test.ts`（26 场景）、`npm run verify:policy-input-binding` | **入选**：fail-closed 是当前的正确行为 |
| 板上携带状态 | 绑定 `h_in`/`c_in` → `h_out`/`c_out` | **尚未实现** | `docs/host-station.md` 的显式说明 | **待办**：实现后删掉那条拒绝 |

## 质量门阈值从哪里来（originbot-goal-navigation）

`tasks/originbot-goal-navigation.json` 的 `qualityGate` 额外声明了两条判据，阈值**锚定在实测**而不是手感：

| 判据 | 值 | 依据 |
| --- | --- | --- |
| `maxActionChangeRms` | `0.5` | 冒烟档（尚未学会的策略）实测 0.0024（nominal）/ 0.0129（hard）。所以 0.5 是**饱和抖动的兜底上限**，不是精细的平滑度指标——写清楚它的实际约束力，避免被读成"已达到平滑度要求" |
| `ablation.requireBaseline` + `minSuccessRateDelta` | `true` / `0.3` | 本任务的未训练基线成功率约 0，因此 0.3 意味着策略必须真的学到 ~30% 才算过；`requireBaseline` 则保证"对照做不出来"时拒绝而不是放行 |

两条都由**引擎**与**平台发布门禁**各自判定一遍（`engines/starter-ppo/runner.py` 的 `evaluate_quality_gate`
与 `shared/artifact-quality-gate.ts` 的 `validateTaskPackEvalForRelease`），后者从原始指标重算，
不信任引擎的布尔值。

## 平台不变量（照搬自上游训练仓库的踩坑清单）

上游 `AGENTS.md` 的价值不在功能，而在一串"破坏了它就会产出仿真能用、真机就废的策略"的约定。
逐条对照后，**已遵守但此前没有测试守住**的，现在钉成测试（`npm run verify:invariants`）：

| 约定 | 我们的状态 | 现在的守卫 |
| --- | --- | --- |
| 惩罚项权重必须 ≤ 0（正权重 = 为违规发钱） | 遵守：pack 的 `collision` / `actionPenalty` 全为负；奖励词汇表的 `penalty`/`smoothness` op 按 `-weight × 非负量级` 结算（`engines/reward_vocabulary.py`） | 逐 pack 断言符号 + 断言求值器保持非负量级形状 |
| 奖励项权重必须 ≥ 0 | 遵守 | 同上（镜像断言） |
| "每步发钱的区域必须有终止" 否则成为 jackpot | 遵守：`dwell` 只在球门半径内发钱，而 `success` 同时终止当集 | 断言 `done = success \| ...` 向量化耦合（迁移到奖励词汇表后终止是单一析取式） |
| 固定 61D 槽位、只增不删（策略热插拔前提） | 遵守：`observationLayout` 常量即契约 | 从 `shared/sim2real.ts` **解析真实声明**并比对顺序/尺寸/求和（调换槽位会被抓，实测验证） |
| 布局必须运行期冻结，不能只有 `as const` | **原为可被运行期改写的数组字面量** | 改为 `Object.freeze`，并断言冻结存在 |

### 这一轮发现并修掉的真实缺陷

`board-policy-runtime.py` 的**观测槽位报告**是硬编码字符串（"slots 0-5 real; slots 6-N adapter"），
它按算术描述边界，**无法发现自己描述错了**：实测 61D 契约下真实边界是 `last_action` 6-19、
`command` 20，而报告把 6-60 整段称为 adapter 槽。现在报告由装配时**实际写入的段落**推导，
未装配时如实说"本次会话还没有装配观测"，并新增回归测试钉住两者一致。

同一轮我把一个**自己写出来的循环论证**也修了：最初的门禁写成 `wheeled_observation_size(...) > obs_dim`
—— 而该函数**按构造必然 ≤ obs_dim**，这个守卫永远不会触发（读起来像保护，实际是空断言）。
根因是我把一个"证明自己正确"的算术当成了检查。现在改为：装配超出契约是**断言**（不可达即 bug），
不足则明确补零，并把这一性质写进 helper 的 docstring 而不是假装在检查它。

## 自定义奖励（第一阶段）

| 阶段 | 改动 | 观测与结果 | 产物 | 结论 |
| --- | --- | --- | --- | --- |
| 词表 + 展开 | 固定 5 键 → 声明式词汇表；老 pack 由 `reward` 展开为等价公式 | 可精确比对的项**逐步等价**；`goal` 由一次性改为限速释放：总额相等、单集有上界 | `scripts/reward-vocabulary.mjs`、`engines/reward_vocabulary.py`、`npm run verify:reward-parity` | **入选** |
| 引擎接线（starter） | 奖励路径改为对公式向量化求值 | 真环境逐步等价（`npm run verify:reward-env-parity`）；改权重确实改变奖励（否则"公式被忽略"也会通过） | `engines/starter-ppo/runner.py` | **入选** |
| 姿态/接触类 term | `upright` / `accel_z` / `body_rate` | **未实现**：mjx 引擎仍读旧 `reward` 映射，且这批量在 `_read_truth` 里已算出但未接到奖励点 | 见 `docs/proposals/custom-reward-vocabulary.md` 的能力矩阵 | **待第二阶段** |

### 过程中修掉的自己的错误（值得记录）

1. **改善方向**：我最初把 `progress` 当成"越大越好"的势能，而它是**距离** —— 结果奖励"走得离目标更远"。
   现在 term 自带 `improves`，且求值器**拒绝猜测**（缺字段直接报错，不再默认方向）。
2. **只在一条路径上修**：`improves` 起初只加在声明式路径，展开路径没有；改为在**唯一出口**统一附加。
3. **循环论证的测试**：`--check` 用整文件字节比较，于是上游每次发版都误报；布局测试把期望值硬编码后断言等于自己。
   两者都改成了真正的检查。
4. **错误的测试断言**：`rate_limit` 的上界是**每集**的，我最初的测试把进球半径设为 0，导致每步开新集，
   量出 229 次奖金并判为失败 —— 是测试错了，不是代码。

## 新增一条记录的要求

1. **必须写失败行**，并给出放弃原因；只加成功行会被视为记录不完整。
2. 每行给出**可复核引用**（证据文件路径 / 提交 / 摘要），否则不算证据。
3. 指标必须注明口径（episodes、envelope、协议版本）；跨口径数字不得并列比较。
4. 阶段名描述**改动**而不是版本号，让人知道下一步该试什么。
