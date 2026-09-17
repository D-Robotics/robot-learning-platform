# dm_control 适配器（DeepMind 生态接入）

`engines/dm-control-adapter` 把 dm_control 1.x 的环境协议（`dm_env.TimeStep` /
`rl.control.Environment` / `Task` 钩子）接入平台的本地 worker 文件协议（读
`RDK_SIM2REAL_REQUEST_FILE`，写 `RDK_SIM2REAL_RESULT_FILE`）。这是审计里
「dm_control/Playground 生态」缺口中 dm_control 这一侧的落地：环境语义是真的
DeepMind 生态代码路径，物理与兄弟引擎同源。

| 引擎 | 依赖 | 定位 |
| --- | --- | --- |
| `engines/dm-control-adapter` | dm-control ≥1.0.46 <2、mujoco、jax[cpu]、optax、onnx | **DeepMind env API 上的真 PPO 训练**：`rl.control.Environment` 驱动 episode 记账，与 MJX/视觉引擎同一份 MJCF 物理 |

## 快速上手

```bash
# 依赖（可与 mjx-adapter 共享一个 venv）
python3 -m pip install --user "dm-control>=1.0.46,<2" "mujoco>=3.13,<3.14" jax[cpu] optax onnx onnxruntime
# 端到端验证（真实跑 2 迭代；无 Python 栈的机器 SKIP 退出 0）
npm run verify:dm-control-adapter
# 单元测试（15 个：场景同源、Task 契约、观测语义、ONNX 数值等价、worker 协议端到端）
python3 -m unittest discover -s engines/dm-control-adapter -p 'test_*.py'
# 生态事实探针（dm_control / mjlab / mujoco-playground 的可用性结论）
node scripts/probe-dm-control-ecosystem.mjs
```

注册到本地 worker（多引擎注册，见 [docs/engines/mjx-adapter.md](mjx-adapter.md) 的
双引擎示例）：

```bash
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"dm-control-ppo":{"executable":"/path/to/python","args":["/abs/path/to/engines/dm-control-adapter/adapter.py"]}}'
```

## 结构（如实标注）

`result.physicsBackend = "dm-control-mujoco"`——这个复合名的含义是：物理是
`mjcf.Physics.from_xml_string` 编译的**与 MJX/视觉引擎同一份** `build_mjcf`
（墙、mocap 球障碍、标定 OriginBot 底盘、限力轮伺服、implicitfast 积分器；
标定单一来源 `assets/originbot/calibration.json`）。dm_control **不是第二个物理
引擎**，结果标签绝不写成「dm_control 物理」。

- **环境**：`rl.control.Environment(physics, task, control_timestep=任务控制周期)`，
  decimation 由 dm_control 自己从模型 timestep 推导（control 0.1 s、物理 0.005 s
  → 20 substeps）。episode 记账、`TimeStep` 语义（`FIRST`/`MID`/`LAST`、discount
  作为终止信号）全部原生。
- **任务**：`GoalNavTask` 携带平台 goal-navigation 语义（8D 板载观测布局、
  progress/goal/collision/dwell 奖励按真值位姿计、goal/collision/出界/超时终止、
  一阶电机增益+滞后、FIFO 动作延迟、逐 episode 域随机化）。钩子签名按 dm_control
  1.x 实测：`before_step(action, physics)`、`after_step(physics)`、
  `get_termination` 返回 discount（None=继续，0.0=终止）。
- **学习器**：与 mjx/visual 引擎同一套纯 JAX clipped PPO，在 N 个独立
  dm_control Environment 的 host 侧循环上训练（无 MJX；CPU MuJoCo）。
- **评测**：固定 envelope（位置数组 `[motorGain, lagTau, gyro, odom, bias,
  latency, dropout, slip]`，含 legacy 6 值补齐）+ Wilson CI，报告形状与
  starter/mjx 逐字段一致，TS 侧发布门可以复算裁决。

## 生态事实（探针结论，2026-09）

`scripts/probe-dm-control-ecosystem.mjs` 的如实结论：

| 包 | PyPI 状态 | 本机 import | 平台侧接入 |
| --- | --- | --- | --- |
| dm-control | 1.0.46 | 可导入 | 本引擎：worker 协议、真实训练 |
| mjlab | 1.6.0 | 缺失 | `engines/mjlab-rsl-rl-adapter`：GPU 路径 + 诚实运动学回退 |
| mujoco-playground | **不在 PyPI 上** | 缺失 | 仓库在 GitHub `google-deepmind/mujoco_playground`，经 `mujoco-warp`/`mujoco-mjx` 提供 GPU 并行 |

Playground 侧如实结论：**它不发布 PyPI 包**，所以「pip 依赖它」不是可行接入路径。
平台选择如实报告而不是 vendor 源码或假装支持；未来接入形态是在自备 GPU 的训练
主机上从源码安装（其本体是 MJX/Mujoco Warp 的任务集合，与本仓库的
mjlab/mjx 两个引擎同一物理内核）。这与 README 能力表里 mjlab 的 🔌 状态一致：
**接入能力是真的、生产算力是部署方的**。

## 边界（诚实声明）

- 依赖缺失（dm_control / mujoco / jax 任一）→ 退出码 3 REFUSED，绝不伪造完成
  训练；numpy 缺失 → 退出码 2（协议守卫）。强制后端请求无法满足时同样拒绝，
  绝不静默换成别的引擎。
- `deployable` 恒为 `false`（板端部署需要 BPU 管线 + X5 编译制品）。
- 冒烟预算不保证成功率——2 迭代 × 16 步的 gate 诚实 FAIL。
- dm_control 的 walker/humanoid 任务集**不在**本引擎范围内：这里接入的是它的
  环境协议 + 平台自己的 goal-navigation 任务，不是它的模型生态。
