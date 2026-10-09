# microduck-recurrent — 循环网络（LSTM）策略训练器

填补的训练侧缺口：`microduck-eval` 的策略装载器（`microduck_eval/policy.py`）早已
接受循环 ONNX 图（61 维观测输入 + 14 维动作输出 + 成对 h/c 状态张量），但仓库里
没有任何引擎能**产出**这种图。本引擎导出的正是该契约：

```text
obs[batch,61] + h_in/c_in[1,batch,H] -> actions[batch,14] + h_out/c_out[1,batch,H]
```

默认 H=256（与官方直播演示的篮球平衡 LSTM 口径一致），导出后经 onnxruntime
带状态传递的逐步对齐校验（阈值 1e-4），失败即改名为 `.rejected`，绝不作为
有效制品流出——与 `microduck-rl-adapter` 的导出门禁同一纪律。

## 环境：五类代理任务（自包含）

观测/动作契约、14 通道姿态还原与回合骨架在 `proxy_common.py` 一处定义；每个
任务是"一个程序化 MuJoCo 场景 + 少量动力学钩子"，遵循 `microduck-football`
确立的自包含代理范式（`--env` 选择，全部 50 Hz 控制、61 观测、14 动作、12 s
回合、域随机化）：

| `--env` | 场景 | 记忆依赖（为何需要循环策略） | 任务卡 |
| --- | --- | --- | --- |
| `basketball` | 鸭子立于可滚动篮球，倾斜即滚走 | 球运动不可观测，靠陀螺仪/姿态历史推断 | 篮球平衡 |
| `stilts` | 固定枢轴双杆高跷（杆质量 0.012 + 0.001·h kg 随高度联动） | 枢轴反力的历史效应 | 高跷平衡 |
| `swing` | 悬挂秋千，泵动力矩经梯档投影作用于铰链 | 摆角/角速度不可观测，泵动相位靠历史推断；幅度势能 + 指向功率复合奖励 | 摆动旋转 |
| `ball` | 大号稳定球（30 cm、1.2 kg），惯性大一个量级、漂移慢 | 隐藏球态时间窗更长，同篮球奖励族 | 球面平衡 |
| `ladder` | 立杆爬升率跟踪代理：爬升力经梯档相位增益（0.5 + 0.5·cos）传递 | 高度与相位均不可观测（陀螺仪对平移盲），节奏靠动作历史推断 | 梯面攀爬（攀爬段） |

任务卡与工作台选择器的接线：`balance-*` / `swing-*` 前缀自动预选本引擎
（操作员可改）；场景注记见 `app.js` 的任务场景映射。

观测 61 槽位与 `microduck_eval.sim.MicroDuckSim.observation` 同构：
陀螺仪(3) + 投影重力(3) + 姿态偏移(14) + 姿态速度(14) + 上一动作(14) + 命令(13)。
14 维姿态通道是真实环境状态（对历史动作的低通滤波），经固定的随机投影
（3×14，行归一化，种子内置于环境定义）转化为关节力矩——一阶近似
「14 舵机改变质心」。

## 训练：存储状态 BPTT 的循环 PPO

`train_recurrent.py`：rollout 逐步存储 LSTM 输入状态（h/c），PPO 更新从这些
存储状态出发重算定长片段（chunked BPTT，默认 chunk=16）。tanh 压缩高斯策略、
GAE、裁剪更新、熵正则，与 `microduck-football` 的训练器同族。

```bash
python3 engines/microduck-recurrent/train_recurrent.py \
  --num-envs 8 --iterations 3 --steps-per-env 64 \
  --export /tmp/policy.onnx --out /tmp/training-summary.json
```

## 验收

```bash
node scripts/verify-microduck-recurrent.mjs
python3 -m pytest engines/microduck-recurrent/tests -q
```

门禁断言（依赖缺失时 SKIP，不阻塞 `npm run verify`）：

1. 行为套件全部通过（观测/动作契约、跌落终止、批量一致性）；
2. 一次真实的小规模训练（3 env × 2 iter）产出 summary + checkpoint + ONNX；
3. 导出图通过 `microduck_eval.policy.load_policy` 装载，判级为循环策略，
   状态逐帧传递与 reset 语义与手工 onnxruntime 循环一致；
4. 动态 batch 推理（[4,61] + [1,4,H]）形状正确；
5. 校验失败路径确实把产物改名为 `.rejected`。

## 诚实边界

- **代理环境，不是真实 MJCF**：真实篮球平衡任务（鸭子站在滚球上、14 舵机全身）
  需要上游 `microduck_rl` checkout 的 MJCF 资产；本引擎的 61→14 接口契约与之一致，
  后续适配器可在不改动接口的情况下替换物理与执行器模型。秋千/球面/梯杆与官方
  课程任务（Datawhale every-embodied 05 专题 D4/D5/D6）是**同任务族的抽象代理**：
  秋千省略了坐姿自由度、梯杆把横档几何抽象为相位增益——抽象级别与"鸭子=球体"一致，
  各环境 docstring 明示。梯面的"多策略接力（攀爬→登桌→起身）"属任务状态机范畴，
  见 `engines/microduck-football/task_machine.py`，不在本引擎。
- **CPU 冒烟证据，不是训练质量结论**：门禁里的小规模训练证明的是链路正确性
  （训练→导出→评测装载闭环），不是策略 competence。质量级训练（长回合 × 大
  并行数）属 GPU-runner 工作量级，届时以 `microduck-eval` 信封评测回填证据。
- 依赖锁：`requirements.in`/`requirements.txt`，由 `npm run lock:engines` 生成。
