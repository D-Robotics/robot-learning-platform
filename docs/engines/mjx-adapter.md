# MJX 引擎（纯 JAX PPO + 真 MuJoCo 物理）

`engines/mjx-adapter` 把 MuJoCo 的 MJX 后端（`mujoco.mjx`，JAX 编译的批量刚体动力学）
接入平台的本地 worker 文件协议（读 `RDK_SIM2REAL_REQUEST_FILE`，写
`RDK_SIM2REAL_RESULT_FILE`），训练与评测全程 `jax.vmap`/`jax.jit` 批量化。

| 引擎 | 依赖 | 定位 |
| --- | --- | --- |
| `engines/mjx-adapter` | jax + mujoco(含 `mujoco.mjx`) + optax + onnx | **真 MuJoCo 接触动力学的 CPU/GPU 训练**：MJX 批量物理 + 纯 JAX PPO（optax Adam、裸 pytree 参数、无 flax/brax 依赖），本机 CPU 即可跑真路径 |

与其他引擎的关系：`starter-ppo` 是 CPU 开箱即用管线；`mjlab-rsl-rl-adapter` 是生产
GPU 栈的显式接入点（mjlab 侧 HOOK 未填时诚实回退）。`mjx-adapter` 是**新增兄弟引擎**
——starter/mjlab 适配器行为零改动，跨引擎质量门可比（同任务包、同指标、只有物理不同）。

## 快速上手

```bash
# 依赖（用户目录安装，可逆；--index-url 用 CPU 版 jax 即可）
python3 -m pip install --user jax mujoco optax onnx
# 端到端验证（真实跑 2 迭代 + 强制回退路径；无 Python 栈的机器 SKIP 退出 0）
npm run verify:mjx-adapter
```

注册到常驻 worker（root-only 环境文件，与 starter 引擎同构）：

```bash
RDK_SIM2REAL_TRAIN_EXECUTABLE=/usr/bin/python3
RDK_SIM2REAL_TRAIN_ARGS_JSON=["/abs/path/to/engines/mjx-adapter/adapter.py"]
RDK_SIM2REAL_LOCAL_RUNNER_URL=http://127.0.0.1:19091/train
```

**双引擎同机注册（推荐，GPU 机标准形态）**：基础 `RDK_SIM2REAL_TRAIN_EXECUTABLE`
保持 starter 引擎不动，另用 `RDK_SIM2REAL_TRAIN_ENGINES_JSON` 注册 MJX；请求带
`training.engine="mjx-ppo"` 时路由到 MJX，不带时仍走默认 starter：

```bash
RDK_SIM2REAL_TRAIN_EXECUTABLE=/usr/bin/python3
RDK_SIM2REAL_TRAIN_ARGS_JSON=["/abs/path/to/engines/starter-ppo/runner.py"]
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"mjx-ppo":{"executable":"/usr/bin/python3","args":["/abs/path/to/engines/mjx-adapter/adapter.py"]}}'
```

worker `healthz` 会回报 `engines: ["default","mjx-ppo"]`，训练页的引擎选择器据此
诚实显示 MJX 是否可用；未注册引擎 id 的请求得到 400 `engine_not_registered`，
绝不静默换引擎训练。

任务包可以声明 `recommendedEngine`：`originbot-physics-navigation`（物理密集）推荐
`mjx-ppo`，提交未显式选引擎时自动采用；`goal-navigation` 系列保持沉默（运动学
够用且便宜）。用户/Agent 显式选择永远优先。

工作台「强化学习训练」提交任务后，台账会标注 `训练引擎 mjx-ppo`，运行卡片出现
「物理 · MuJoCo MJX（接触动力学）」——这是 `metrics.physicsBackend` 一路透传的结果，
不是前端写死的标签。

## 双后端诚实结构

`result.physicsBackend` / `metrics.physicsBackend` 如实标注实际跑了哪种物理，绝不混淆：

- **mjx**（真路径）：jax + mujoco.mjx 可导入且请求带 task-pack 时走此路径。MuJoCo 负责机器人本体的真实动力学（freejoint 刚体 + 轮速执行器 + 轮-地摩擦接触 + 真积分），目标/障碍/奖励/终止/域随机化全部沿用 task-pack 语义。
- **starter-kinematic**（诚实回退）：`RDK_MJX_ADAPTER_FORCE_MJX=0` 或无 task-pack 时，同一个纯 JAX 学习器跑在 starter 的 `GoalNavEnv`（运动学）上。回退依赖 torch（starter 环境需要）；torch 缺失时按依赖缺失处理，绝不假装训练成功。
- jax 完全缺失时进程以退出码 3 拒绝（与 mjlab 适配器缺 rsl_rl 时一致），平台把任务标 `failed`。

## 任务包契约与 DR 映射

支持 `originbot-goal-navigation` 任务包。观测布局两种都支持：
`originbot-imu-odom-v1`（8D：goal_dx/dy、yaw 误差、gyro_z、odom 速度、上一动作）与
`imu-gravity-v1`（42D）。动作 2D（linear/angular 指令，`adapter.safety` 钳制）。

starter `GoalNavEnv` 的域随机化本来就是**指令级与观测级**语义（在动作进入物理前、
观测离开物理后做扰动），与物理引擎无关。MJX 环境把它 1:1 沿用：

| task-pack DR 字段 | MJX 环境中的实现 |
| --- | --- |
| `motorGain` | 轮速指令 × 增益（进入物理前） |
| `lagTauSeconds` | 一阶低通跟踪延迟（指令滤波） |
| `actionLatencySteps` | 动作 FIFO 延迟（容量同时覆盖训练采样与评测包络的钉死值） |
| `slipScale` | 里程计读数 × 打滑比例（离开物理后） |
| `gyroNoiseStdRadSec` / `odomNoiseStdM` | 观测高斯噪声 |
| `angularBiasRadSec` / `odomDropoutProb` | 陀螺零偏 / 里程计丢帧 |
| `evalEnvelopes`（nominal/hard 等） | 逐包络钉死 DR 参数的批量冻结评测 |

这样质量门跨引擎可比：starter（运动学）、mjx（接触动力学）、mjlab（未来 GPU 物理）
跑的是**同一个任务、同一套指标、只有物理保真度不同**。

## 三处物理修正（probe 实证，都编码为回归断言）

训练 MJCF 从标定单一源（`assets/originbot/calibration.json`）生成，但有**三处偏离**
视觉模型，每处都是 probe（`engines/mjx-adapter/probe_mjx.py`，直接 import 生产
`build_mjcf`）实证过不改就会产生垃圾训练：

1. **静止高度取几何真实值**：`REST_HEIGHT = 轮半径 − 轮 z 偏移 = 0.17`，而非标定
   名义 `BASE_HEIGHT=0.16`——后者让轮缘初始穿地 1 cm，接触求解器把机器人弹射上天，
   每个 episode 开局都在空中。断言：复位位形 ncon≥3 且最大穿透 < 1e-4。
2. **轮伺服力矩封顶**：执行器带 `forcerange = ±wheels.maxTorque`（2.0 N·m）。无上限的
   kv=8 伺服在满指令时输出 26.6 N·m/轮，而 CG 几乎正好在轮轴上方（万向轮只承
   ~0.2 N）——任何急加速都会翘头起飞。真实减速电机有堵转力矩，模型也一样。
3. **物理步长封顶 0.01 s**（`_MJX_MAX_PHYSICS_DT`）：dt=0.02 时 MJX 接触求解器向这个
   三点贴地姿态注入能量（车身 0.48 m/s 超过轮子纯滚 0.36 m/s，CPU/MJX 2 秒分歧
   0.4 m）；dt=0.01 时两后端 2 秒一致到 ~2 cm。环境用更多子步补偿，控制时序不变。

另一处**时间账本修正**：契约里的 `decimation` 字段是
`round(controlHz × timestep)`——子步数的**倒数**而非子步数本身。适配器不照单全收，
而是推导 `decimation = round(control_dt / physics_dt)`，保证物理时间与任务时间同步
前进（照收会 5 倍慢动作）。实际跑的 `controlHz`/`physicsTimestepSeconds`/`decimation`
如实写进 `training-summary.json`，`verify:mjx-adapter` 断言
`decimation × physics_dt == 1/controlHz`。

MJCF 中**没有墙和方形障碍**：MJX 不支持 cylinder-box 碰撞，而障碍本来就是任务级
解析圆判定（保质量门可比）。积分器用 `implicitfast`——Euler/RK4 在刚性轮伺服上
发散（probe 断言 mean 轮速误差：Euler 2.46 / RK4 1.41 / implicitfast 0.06 rad/s）。

## 训练预算与产物

预算与 starter 引擎同构（引擎侧钳制 + result 如实记录实际值），环境变量
`RDK_MJX_ENGINE_ITERATIONS/_ENVS/_STEPS` 可覆盖：

| profile | 迭代 | 并行环境 | rollout 步 |
| --- | --- | --- | --- |
| smoke | 40 | 16 | 128 |
| low-vram | 400 | 32 | 128 |
| standard | 400 | 64 | 128 |
| high-vram | 600 | 128 | 128 |

PPO 超参就是 starter 的校准值（entropy 0.002、lr 3e-4、clip 0.2、gamma 0.99、
lam 0.95、4 epoch × 256 minibatch、[128,128] tanh MLP + 可学习 log_std），Adam 用
optax，参数是裸 pytree——flax/brax/任何 neural-lib 都不是依赖。产物写在 worker 任务
目录：`result.json`（`physicsBackend`/`engine` 标注、`deployable: false`）、
`policy.onnx`（opset 13，Gemm/Tanh/Clip，与 starter 导出字节级同构）、
`eval-report.json`（包络 × Wilson CI × 质量门）、`training-summary.json`（超参 +
实际跑的物理参数）、`telemetry.jsonl`。`taskEvaluation` 嵌入 result，TS 侧
`validateTaskPackEvalForRelease` 可重算裁决。

评测协议与 starter 完全同形：pin 住的包络、episode seed = seed×7919+i、Wilson 95% CI、
质量门 fail-closed（2 迭代冒烟预算必须诚实 FAIL 而不是碰运气 PASS）、含未训练基线对比。

## 测试与验证

- `engines/mjx-adapter/test_mjx_adapter.py`（unittest，13 用例：协议冒烟、契约维度
  不匹配 ValueError、ONNX 数值等价 <1e-5、DR 包络钉死复现性、复位位形、前向指令
  物理一致性等；无 jax 时 SKIP）
- `engines/mjx-adapter/probe_mjx.py`（兼容性探针：生产 MJCF 的积分器矩阵、
  cylinder-box 支持缺失、四元数帧约定、CPU/MJX 轨迹 parity、驾驶能力、多 yaw 复位
  不发射——上面的三处修正全部有回归断言）
- `npm run verify:mjx-adapter`（真路径 + 强制回退路径断言；无 Python 栈 SKIP）
- `npm run verify:mujoco-models`（mujoco-web 全部可服务模型编译/步进/元数据一致性 +
  注册表 fail-closed 契约）

## 边界（诚实声明）

- MJX 是**接入能力**，不是复刻 Isaac Lab/Playground 的万级 GPU 集群与模型生态。
  本机 CPU 可端到端验证真路径；GPU 只是吞吐放大（`jax.devices()` 如实上报，无 CUDA
  时 `result.cuda=false`）。
- 物理保真度：真接触动力学（轮-地摩擦、三点姿态、力矩饱和），但训练 MJCF 没有
  墙/方障碍（MJX 碰撞类型限制），场景是任务级解析几何。这**低于** MuJoCo CPU 全场景
  仿真、**高于** starter 运动学——台账的 `physicsBackend` 就是让这个差异可见。
- `deployable` 恒为 `false`：上板需要 X5 编译制品 + 板端只读预检，平台在预检处强制拦截。
- MJX 不是平台硬依赖：无 jax 时 verify SKIP、CI 与「无 GPU 可跑通」承诺不变。
- 域随机化仍是指令级/观测级（与 starter 同语义），**不是**物理级 DR（质量/摩擦
  随机化留给 mjlab 真路径）。
