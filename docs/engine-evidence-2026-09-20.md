# 引擎级证据归档（2026-09-20 · 本机 Mac mini / arm64）

目的：把「GPU 线仓内零运行证据」的缺口收敛为**本机可真跑的 CPU 级证据**，
并如实标注哪些仍需 GPU / 仓外栈。所有命令可原样复跑；SKIP 与 PASS 的判定
全部来自各 verify 脚本自身的 fail-closed 逻辑，本文不做任何加工。

## 真跑 PASS（真实训练迭代 + 真实 ONNX 导出）

| 门禁 | 结果 | 后端（引擎自报） | 解释器 |
| --- | --- | --- | --- |
| `verify:mjx-adapter` | PASS | `physicsBackend=mjx`（真 MuJoCo MJX 接触动力学 + 纯 JAX PPO，2 迭代，ONNX 72308B，质量门 FAIL(honest)） | `engines/mjx-adapter/.venv`（jax 0.11.1 + mujoco 3.13.0 + dm_control + onnx） |
| `verify:dm-control-adapter` | PASS | `physicsBackend=dm-control-mujoco`（dm_control 1.x env API + JAX PPO，2 迭代，ONNX 72315B） | 同上（`RDK_DMC_ENGINE_PYTHON` 指向） |
| `verify:mjlab-adapter` | PASS | `physicsBackend=starter-kinematic`（真 rsl-rl-lib 2.2.3 `OnPolicyRunner` 2 迭代，ONNX 72891B） | 系统 `python3`（3.9.6，本机补装 `rsl-rl-lib==2.2.3`） |
| `verify:offline-bc` | OK（25 测试，含 2026-09-20 新增图像分支 10 例） | NumPy MLP + 新 CNN 图像编码器 | 系统 `python3` |
| `verify:act` | OK | PyTorch ACT（Transformer + CVAE） | 系统 `python3`（torch 2.8.0） |
| `verify:diffusion-policy` | OK（skipped=1：断言"装了全栈才可能做的事"的用例按设计 SKIP） | PyTorch Diffusion Policy | 系统 `python3` |
| `verify:vision-observation` | PASS | 真 ONNX 模型输入签名 × 视觉契约（含 undersized export 拒绝用例） | 系统 `python3` |
| `verify:microduck-rl-adapter` | OK | 任务映射/曲线解析/制品契约 pin（无 GPU 也真实可验的部分） | 系统 `python3` |
| `verify:smolvla` | OK（29 测试，skipped=3：GPU 栈在场的正路径按设计 SKIP） | dry-run plan + fail-closed 拒绝路径 | 系统 `python3` |

诚实备注（勿删）：

- mjlab 门禁的 2 迭代训练跑在 **starter-kinematic 后端**——这是门禁设计的一部分：
  机器上没有 mjlab GPU 物理栈时，结果必须如实标注 kinematic，绝不能标 mjlab
  （`scripts/verify-mjlab-adapter.mjs:91-93` 断言了这一点）。mjlab 物理侧
  仍需自备 GPU 栈，与 README 能力表一致。
- 微型 smoke 预算（2 迭代）下质量门 FAIL(honest) 是**预期行为**：门禁断言
  2 迭代不许通过 0.7 门（`verify-mjlab-adapter.mjs:109-111`），fail-closed
  而非报幸运 PASS。
- `verify:microduck-eval` 契约部分 verified；live rollout 部分 SKIP——
  本机无 `~/microduck_rl` checkout，如实跳过不伪造。

## 复跑方式

```bash
npm run verify:mjx-adapter
npm run verify:microduck-rl-adapter && npm run verify:microduck-eval
RDK_DMC_ENGINE_PYTHON="$PWD/engines/mjx-adapter/.venv/bin/python" npm run verify:dm-control-adapter
npm run verify:mjlab-adapter   # 需 python3 带 numpy+torch+rsl_rl+onnx
npm run verify:smolvla && npm run verify:vision-observation
npm run verify:offline-bc && npm run verify:act && npm run verify:diffusion-policy
```

## 仍硬件/仓外绑定的部分（不变，如实保留）

- mjlab GPU 物理、microduck-rl 上游 CUDA 栈：需 GPU 机器。
- smolvla 全量微调：需 CUDA + transformers/accelerate/peft 全栈。
- robogo 云端 runner：按约定不在本机范围。
