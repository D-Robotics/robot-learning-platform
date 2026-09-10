# mjlab + rsl-rl 适配器（参考实现）

把生产级 GPU 训练栈（mjlab 并行仿真 + rsl-rl PPO）接入平台的本地 worker 协议。

**双后端结构**（`result.physicsBackend` / `metrics.physicsBackend` 如实标注，绝不混淆）：

- **mjlab**（真路径）：mjlab 可导入且请求带 task-pack 时走此路径。环境构建钩子
  （HOOK 1）是显式的 `NotImplementedError` 接入点——接入方在这里构造 mjlab VecEnv。
- **starter-kinematic**（诚实回退）：无 mjlab 时，适配器把平台的 GoalNavEnv 包成
  rsl_rl 的 `VecEnv` 契约，用**真实的 `OnPolicyRunner` PPO** 训练——这不是 mock：
  真梯度、真 ONNX 导出（同一 `cpu-onnx` 契约）、复用 starter 引擎的评测器与质量门
  （`taskEvaluation` 嵌入 result，TS 侧 `validateTaskPackEvalForRelease` 重算裁决）。

依赖缺失（rsl_rl 未安装）时进程以退出码 3 拒绝执行——平台把任务标记为 `failed`，
不会当作训练完成。安装：`python3 -m pip install --user rsl-rl-lib==2.2.3`（2.3.x
需要 Python ≥ 3.10）。

验证：`npm run verify:mjlab-adapter`（真实跑 2 迭代：断言 physicsBackend 标注、
ONNX 字节数、taskEvaluation 嵌入、Wilson CI 存在、冒烟预算下 gate 诚实 FAIL；
无 Python 栈的机器 SKIP）。

## 接入步骤（mjlab 真路径）

1. 安装训练栈（GPU 机器）：

   ```bash
   pip install mujoco mjlab rsl-rl torch --index-url https://download.pytorch.org/whl/cu124
   ```

2. 打开 `adapter.py`，填三个 HOOK：

   - **HOOK 1（环境）**：用 request 里的契约（`observationSize` / `actionSize` / `controlHz` / `physicsTimestepSeconds` / `decimation`）构建 mjlab VecEnv。**维度必须与 manifest 一致**——不一致就是契约违约，平台在遥测评测处会拦下。
   - **HOOK 2（训练+导出）**：rsl-rl PPO 跑 `training.maxIterations`；导出 actor 到任务目录 `policy.onnx`（`cpu-onnx` / `locomotion` / `threads=1`，与 manifest 声明一致）。
   - **HOOK 3（评测+结果）**：评测存活率/回报/单线程控制延迟，写 `result.json`（`deployable=false`，除非产出 X5 编译制品）。

3. 注册到 worker（root-only 环境文件）：

   ```bash
   RDK_SIM2REAL_TRAIN_EXECUTABLE=/usr/bin/python3
   RDK_SIM2REAL_TRAIN_ARGS_JSON=["/abs/path/to/engines/mjlab-rsl-rl-adapter/adapter.py"]
   RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19091/train
   ```

4. 工作台「训练与模型」选 local backend 提交任务；台账、幂等、对账、遥测评测全链路复用。

## 设计边界

- worker 保证 `shell:false`、绝对路径、凭据擦洗——适配器只做训练，不做部署。
- `artifact://mjlab/...` 是不透明引用：真实权重由你的制品库管理，平台只追踪元数据（sha256/size/runtime）。
- 万级并行、域随机化、电机模型都发生在 HOOK 1/2 里，与平台解耦。
