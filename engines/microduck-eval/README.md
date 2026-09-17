# microduck-eval — 任务级评测底座

**它回答的问题**：一个策略（ONNX）在**写死的信封**里，到底成没成？成的话，好到什么程度、置信下界是多少？

它不训练，也不编造指标。所有数字来自一次真实跑的 MuJoCo episode 集合，判定规则写在
[`docs/eval-report-contract.md`](docs/eval-report-contract.md)。

## 为什么需要它

平台现有的评测判定（Wilson 95% CI 下界、fail-closed 质量门）挂在 task-pack 那条线上
（GoalNav / OriginBot），指标是导航语义的 `successRate` / `collisionRate`。
MicroDuck 这条线只有 `meanReward`——上游 trainer 不打印任务成功率，适配器**刻意**把
`recentSuccess` 恒置 0 而不是编一个。于是"跑完 4096×6000 算不算成功"目前无法判定。

本目录把这件事补上：**在同一套既有判定语义里**，给具身任务提供可复现的任务级指标。

## 加一个新任务＝写一个 JSON

`--task-spec` 让阈值、信封、命令全部由声明文件驱动，报告里记 `taskSpec` 路径与
`taskDefinition` 阈值（见 [`docs/task-specs.md`](docs/task-specs.md)）。已发布三份规格：
`ball-kick`、`walking-velocity`（与内置类**逐阈值相同**，由回归测试守护）与
`duck-stand`（`hold` 口径，**只作为 JSON 存在**，用来证明"加任务不改代码"）。
未通过校验的 spec 一律报错，绝不静默取默认值。

```bash
../../.eval-venv/bin/python -m microduck_eval.report \
  --task-spec task-specs/duck-stand.json --policy /path/policy.onnx \
  --model-root /path/to/microduck_rl --episodes 50 --out eval-report.json
```

## 结构

```
engines/microduck-eval/
├── README.md
├── docs/eval-report-contract.md      # 契约：信封语义、指标定义、判定规则
├── microduck_eval/
│   ├── wilson.py                     # Wilson score 区间（与 platform 同语义）
│   ├── metrics.py                    # episode → 信封聚合
│   ├── envelope.py                   # 信封定义与固定初态/种子（nominal / hard / endurance）
│   ├── sim.py                        # 无头 CPU MuJoCo 回放（上游 MJCF）
│   ├── policy.py                     # ONNX 策略装载（obs 61 → act 14；前馈与 LSTM 循环图）
│   ├── tasks.py                      # 任务级成功判据（走路 / 踢球 / 平衡）
│   └── report.py                     # 产出 eval-report.json
└── tests/
    ├── test_eval_contract.py         # 纯逻辑：Wilson 语义、任务判据、信封钉死
    ├── test_policy_contract.py       # 纯逻辑：图分类/状态配对/回合内状态语义（fake session）
    └── test_policy_onnx_e2e.py       # 真 ONNX 图：手工构造 LSTM，对照手喂 ORT 参考序列
```

## 支持的策略图

* **前馈**：一个 `obs[*,61]` 输入、一个 `actions[*,14]` 输出。
* **循环**（LSTM 等）：另带成对状态输入/输出（如 `h_in/h_out`、`c_in/c_out`，
  含 ONNX LSTM 的 rank-3 `[directions, batch, hidden]` 初始状态形状）。
  状态在 episode 内携带、每回合由 `rollout` 清零；配对歧义（两个同尺寸候选、
  单侧状态）**拒绝加载**而不是猜。社区实验（如篮球平衡的盲 LSTM 策略）
  就是这种形态——装载细节见 `policy.py` 模块注释。

## 诚实边界（必须先读）

* 本评测器在 **CPU MuJoCo** 上单环境步进，**不是** mjlab + MuJoCo Warp 的并行物理。
  同一条策略在两套动力学下的成功率**可以不同**——契约要求报告里如实标注
  `dynamics` 字段（`cpu-mujoco` / `mjlab-mujoco-warp`），跨动力学的结果不允许直接比较。
* 默认使用上游 MJCF 的**位置执行器**（标定 kp）；`--actuator-model bam-ctrl` 可切换到
  厂商 `bam.mujoco.MujocoController`——上游训练执行器的 CPU 官方实现（固件 P 环、
  电机方程、负载相关摩擦、电压跌落，200 Hz）。评测学习出的行走策略时**必须**用
  `bam-ctrl` + `--scene-variant walk`。报告必须标注 `actuator` / `scene` 字段。
* 循环策略的状态清零发生在**每个 episode 开始**；同一策略在前馈图评测里
  "看起来一样"不代表行为一样——`policyFacts.recurrent` 就是为此必须出现在报告里。
* 因此本目录的第一价值不是"给出结论"，而是**把结论的前提写死在报告里**：没有
  `dynamics` + `actuator` + `seed` + `episodes`（+ 循环策略的 `policyFacts`）的成功率，
  一律视为无效证据。

## 跑起来

```bash
python3.12 -m venv .eval-venv && .eval-venv/bin/pip install mujoco onnxruntime numpy pytest
cd engines/microduck-eval
../../.eval-venv/bin/python -m pytest tests -q                       # 纯逻辑，秒级
../../.eval-venv/bin/python -m microduck_eval.report \
  --task ball-kick --policy /path/policy.onnx \
  --model-root /path/to/microduck_rl \
  --envelopes nominal,hard --episodes 50 \
  --out eval-report.json
```

平衡类任务配 endurance 信封（60 s 存活），并把上一版策略挂成参照列：

```bash
../../.eval-venv/bin/python -m microduck_eval.report \
  --task balance --policy /path/policy.onnx \
  --baseline-policy /path/to/previous-release.onnx \
  --model-root /path/to/microduck_rl \
  --envelopes endurance --episodes 50 \
  --out eval-balance.json
```

评学习出的行走策略（训练执行器 + 训练场景模型）：

```bash
../../.eval-venv/bin/python -m microduck_eval.report \
  --task walking-velocity --policy /path/policy.onnx \
  --model-root /path/to/microduck_rl \
  --actuator-model bam-ctrl --scene-variant walk \
  --trusted-policy \
  --envelopes nominal,hard --episodes 50 \
  --out eval-walking.json
```

`--baseline-policy` 缺省仍是零动作地板（装置资格读它）；给了参照策略后，
"新策略比上一版好多少"是同一信封里并排的两列数字，不是 README 里的一句话。

上游 MJCF/资产来自 `pollen-robotics/microduck_rl`（Apache-2.0）。本仓库**不分发**上游资产，
只读取调用方提供的 `--model-root`。

## 第一次跑出来的结论（2026-09-16）

两份完整证据都在 `evidence/`，都是 50 episode × 2 信封：

| 文件 | 装置资格 | 读数 |
| --- | --- | --- |
| `eval-ballkick-untrained-smoke-*.json` | **false**（零动作基线 50/50 全倒） | 装置不成立，任何成功率都不可读 |
| `eval-ballkick-calibrated-*.json` | **true**（零动作基线 0/50 摔倒，躯干 0.115 m） | 被评策略 100% 摔倒、球位移 0.000 m → 门禁因**策略**失败 |

第一份暴露的是执行器问题，不是策略问题：MJCF 里的位置执行器是 mjlab 加载前的占位参数
（`kp = 0.55`），刚度约为训练时的 1/3.5，鸭子站着都会倒。标定到 `kp = 2.0`（力上限一并
放开到 BAM 的失速力矩 0.976 N·m）后基线稳定站住，装置合格，失败信息才第一次指向策略本身。
完整扫描表与两个必须记住的坑见
[`docs/eval-report-contract.md`](docs/eval-report-contract.md) 第 6 节。

**装置能不能判学习策略？第 2 轮答案是"不能"且已机制化取证；第 3 轮（09-17）修复结案：
能。** 第 2 轮把被评对象换成**足量训练**的产物（`Mjlab-Velocity-Flat-MicroDuck`，
4096 环境 × 6000 轮，末轮奖励 113.45，**回合长度 938.56/1000 步 ≈ 训练环境里能站
18.8 秒**），本机结果是：

| | 训练策略 | 零动作基线 |
| --- | --- | --- |
| 成功 / 摔倒 | 0.00 / **1.00** | 0.00 / 0.00 |
| 前进 / 速度误差 | +0.497 m / 0.133 | +0.003 m / 0.400 |

它在本机**学到的东西是可见的**（前进是基线的 166 倍、速度误差改善 3 倍），但仍然每次都摔。
因此 `harnessQualification` 会判装置不合格、`qualityGate` 强制 FAIL，理由写明
"不能判定学习策略，成功率无意义"——这条规则是双刃的：装置不合格时，它既不许认证一个好策略，
也不许判死一个坏策略。

已经排除的：**观测层**（在 GPU 机器上用训练侧技术栈导出 HOME 帧的 61 维观测，与本机
**最大绝对差 0.000e+00**，关节序、投影重力、角速度、重力矩、damping/frictionloss/armature/timestep 全部一致）、
位置伺服 kp 0.55→128、BAM 电压端口 kp_fw 100→3200、厂商 `bam.mujoco.MujocoController`、
以及上游同款摩擦模型——**训练策略在任何配置下都没站住过一次**。

完整对照表与下一步判据见
[`docs/actuator-fidelity-investigation.md`](docs/actuator-fidelity-investigation.md)。

**第 3 轮结案（2026-09-17）**：上游 CPU 复现证明该策略能站能走——Warp/CPU 物理差异
不是根因；真正的根因是本机两处自身缺陷：

1. `base_ang_vel` 观测通道算错（手拼空间速度 ≠ IMU 陀螺，运动中差达 2.65 rad/s；
   HOME 静止逐位对照恰好掩盖了它）→ 改读 `imu_ang_vel` 传感器；
2. 行走信封命令恒为零（`CommandProfile()` 默认值从未接上 0.4 m/s）→ 策略被命令
   站着不动且照做。修复后 + `bam-ctrl` + `scene_walk.xml`：
   **nominal 与 hard 各 50/50 成功、0 跌倒，qualityGate 与 harnessQualification 全过**
   （`evidence/eval-walking-4096-trained-qualified-2026-09-17.json`）。
   逐帧证据链与方法论教训（静止逐位对照验证不了动态通道）见调查文档 §7。


