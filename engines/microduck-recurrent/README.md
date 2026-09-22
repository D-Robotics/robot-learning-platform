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

## 环境：篮球平衡代理（自包含）

`balance_env.py` 是一个程序化 MuJoCo 场景，遵循 `microduck-football` 确立的
自包含代理范式：鸭子代理体通过球关节铰接在一只可滚动的篮球顶部，鸭子倾斜会
把球滚走（扫帚滚球式不稳定）。**观测里没有球的状态**——策略必须从陀螺仪/
姿态的*历史*推断球运动，这正是该任务需要循环策略的原因。

- 观测 61 槽位与 `microduck_eval.sim.MicroDuckSim.observation` 同构：
  陀螺仪(3) + 投影重力(3) + 姿态偏移(14) + 姿态速度(14) + 上一动作(14) + 命令(13)。
- 14 维姿态通道是真实环境状态（对历史动作的低通滤波），经固定的随机投影
  （3×14，行归一化，种子内置于环境定义）转化为球关节上的力矩——一阶近似
  「14 舵机改变质心」。
- 50 Hz 控制（4 ms 物理步 × 5 子步），12 s 回合，初始倾斜与球体初速做域随机化。
- **高跷变体**（`--env stilts --stilts-height-cm 25`）：把滚动球换成固定枢轴的
  双杆高跷（杆质量按上游口径 0.012 + 0.001·h kg/杆 随高度联动），观测/动作
  契约与训练器完全复用——同一循环策略接口覆盖篮球平衡与高跷平衡两个直播任务。

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
  后续适配器可在不改动接口的情况下替换物理与执行器模型。
- **CPU 冒烟证据，不是训练质量结论**：门禁里的小规模训练证明的是链路正确性
  （训练→导出→评测装载闭环），不是策略 competence。质量级训练（长回合 × 大
  并行数）属 GPU-runner 工作量级，届时以 `microduck-eval` 信封评测回填证据。
- 依赖锁：`requirements.in`/`requirements.txt`，由 `npm run lock:engines` 生成。
