# dm_control 适配器（DeepMind 生态接入）

把 dm_control 1.x 的环境协议（`dm_env.TimeStep` / `rl.control.Environment` /
`Task` 钩子）接入平台的本地 worker 协议——之前审计里缺的「dm_control/Playground
生态」缺口，这一侧（dm_control）现在是真的了。

**结构**（全部如实标注，`result.physicsBackend = "dm-control-mujoco"`）：

- **物理**：`mjcf.Physics.from_xml_string` 编译**与 MJX/视觉引擎同一份**
  `build_mjcf`（墙、mocap 球障碍、标定 OriginBot 底盘、限力轮伺服、
  implicitfast 积分器；标定单一来源 `assets/originbot/calibration.json`）。
  dm_control **不是第二个物理引擎**——结果标签永远是这个复合名，绝不写成
  "dm_control 物理"。
- **环境**：`rl.control.Environment(physics, task, control_timestep=任务控制周期)`，
  decimation 由 dm_control 自己从模型 timestep 推导（control 0.1 s、物理
  0.005 s → 20 substeps）——DeepMind 生态训练所依赖的那套 episode 记账、
  `TimeStep` 语义、reset 上下文全部原生。
- **任务**：`GoalNavTask` 携带平台 goal-navigation 语义（8D 板载观测布局、
  progress/goal/collision/dwell 奖励按**真值位姿**计、goal/collision/出界/
  超时终止、一阶电机增益+滞后、FIFO 动作延迟、逐 episode 域随机化）——
  钩子签名按 dm_control 1.x 实测（`before_step(action, physics)`、
  `after_step(physics)`、`get_termination` 返回 discount：None=继续，0.0=终止）。
- **学习器**：与 mjx/visual 引擎同一套纯 JAX clipped PPO，在 N 个独立
  dm_control Environment 的 host 侧循环上训练（无 MJX；CPU MuJoCo）。
- **评测**：固定 envelope（位置数组 `[motorGain, lagTau, gyro, odom, bias,
  latency, dropout, slip]`，含 legacy 6 值补齐）+ Wilson CI，报告形状与
  starter/mjx 逐字段一致，TS 侧发布门可以复算裁决。

诚实边界（与所有兄弟引擎一致）：

- 依赖缺失（dm_control / mujoco / jax 任一）→ 退出码 3 REFUSED，绝不伪造
  完成训练；numpy 缺失 → 退出码 2（协议守卫）。
- `deployable` 恒为 `false`（板端部署需要 BPU 管线）。
- 冒烟预算不保证成功率——2 迭代 × 16 步的 gate 诚实 FAIL。
- **mujoco-playground 不在 PyPI 上**（仓库在 GitHub
  `google-deepmind/mujoco_playground`，经 `mujoco-warp`/`mujoco-mjx` 提供
  GPU 并行）——生态探针结论见 `docs/engines/dm-control-adapter.md`。

注册到本地 worker：

```bash
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"dm-control-ppo":{"executable":"/path/to/python","args":["/abs/path/to/engines/dm-control-adapter/adapter.py"]}}'
```

依赖（共享 mjx venv 已装好）：

```bash
pip install "dm-control>=1.0.46,<2" "mujoco>=3.13,<3.14" jax[cpu] optax onnx onnxruntime
```

验证：`npm run verify:dm-control-adapter`（真实跑 2 迭代：断言
physicsBackend 标注、ONNX 字节数、taskEvaluation 嵌入、Wilson CI 存在、
冒烟预算下 gate 诚实 FAIL；无 Python 栈的机器 SKIP）。
单元测试：`engines/dm-control-adapter/.venv` 或共享 venv下
`python -m unittest test_dm_control_adapter`（15 个测试：场景同源、Task
契约、观测语义、ONNX 数值等价、worker 协议端到端）。
