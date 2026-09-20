# offline-bc 引擎（示教数据 → MLP 行为克隆 → ONNX）

`engines/offline-bc` 把平台缺失的**模仿学习路径**补上：不是自己试错学奖励
（PPO/SAC），而是直接从示教/采集的 observation→action 数据集克隆策略。这是
LeRobot 一类社区项目的核心飞轮的一半——「有数据就能出策略」，此前本平台
只能靠 RL 从零探索。

v1 是一个 40 行的线性回归占位实现（闭式最小二乘，`format=rdk-offline-bc-v1`），
只能拟合「动作是观测的仿射函数」的数据——真实机器人策略没有一个是这种形状。
v2（当前版本）换成真 MLP + minibatch Adam，保持同一 CLI 和数据校验规则。

## 能力定位

- **真 MLP**：`--hidden 64,64`（默认）经 Xavier 初始化、tanh/ReLU 隐藏层、
  输出层线性；非线性回归是硬测试——在 sin/cos 构造的非线性数据集上必须
  显著优于闭式线性基线，否则整套测试失败（防止引擎悄悄退化回 v1）。
- **train/validation 分离**：训练前按种子划分（默认 20%）；标准化统计只从
  train split 估计——验证分数是对未见数据的诚实估计，不是被验证集统计污染
  的自画像。数据集撑不起 split 时拒绝训练而不是报告噪声指标；显式
  `--val-fraction 0` 才能关掉，且报告里 `validation.enabled=false` 明说。
- **确定性**：同数据 + 同种子 → 权重逐位相同（测试断言）；换种子 → 权重
  真的会变（种子确实在起作用）。split 与 shuffle 用独立随机流，改 batch
  size 不会改变验证集成员。
- **ONNX 导出带等价证明**：导出后立刻用 onnxruntime 在真实数据行上对比
  NumPy 前向（float32，逐元素 atol 1e-4），不一致即删除文件并让整次运行
  失败——**未经验证的导出永远不落盘**。没有 onnxruntime 时文件照写但
  `onnx.equivalence="skipped-no-onnxruntime"` 如实标注。
- **fail-closed 数据规则**（v1 全部保留，NaN/Inf 为新增拒绝项）：非数值、
  缺 action、维度不一致、空数据集一律 `ValueError`，且失败不写任何产物。
- **provenance 契约**：产物记录 `source`（commit + dirty 标记）、
  `dependencies`（实际导入的库版本）和 `dependencyLockSha256`（本引擎
  requirements.txt 的 SHA-256），与 starter-ppo/mjx 等运行引擎同一规范，
  `npm run verify:training-provenance` 断言。
- 引擎模式（文件协议）下用**确定性合成数据**跑 smoke 轮，结果里
  `dataset.synthetic=true` 明确标注——训练是真的，数据是合成的，两者都写明。

## 与其他引擎的关系

| 引擎 | 学习信号 | 需要 |
| --- | --- | --- |
| starter-ppo / mjx-adapter / visual-ppo | 奖励（试错 RL） | 任务/奖励设计 + 仿真环境 |
| **offline-bc** | **示教动作（模仿学习）** | **一份 JSONL 转移数据集** |

数据来源天然衔接平台已有链路：浏览器录制（mujoco-web 轨迹 JSONL）、
BoardAgent 遥测回流、板端 spool 的真实策略数据（2026-09-14 的
real-loop 验证即用 3281 条 42D→2D 板端数据训练过 v1）。

`deployable` 语义与所有本地引擎一致：产物是源策略工件，上板仍需走
编译制品 + 板型预检 + rehearsal 收据的完整发布链。

## 使用

```bash
# 数据格式：每行 {"observation": [...], "action": [...]}
python3 engines/offline-bc/train_bc.py dataset.jsonl \
  --out model.json --onnx policy.onnx --hidden 64,64 --epochs 300

# 跑契约测试（25 个：非线性拟合、split 诚实性、确定性、fail-closed、
# ONNX 等价与删除语义、引擎模式 provenance、图像分支（卷积参照、有限差分
# 梯度校验、像素任务学习、NHWC 导出签名）；无 numpy 时 SKIP 退出 0）
npm run verify:offline-bc
```

产物格式 `rdk-offline-bc-v2`（JSON）：`layers`（权重/偏置）、`activation`、
`normalization`（mean/std）、`metrics`（train/val loss、样本数、种子）、
`onnx`（导出与等价状态）、provenance 三块。`observation_size` / `action_size`
键沿用 v1 命名。依赖：核心只需 numpy；`--onnx` 需要 onnx（等价检查另需
onnxruntime），缺库时如实 SKIP 不伪造导出。

## 图像观测分支（v3，2026-09-20）

`--image-input WIDTHxHEIGHT` 启用卷积编码器，吃**相机像素**而不只是表观测：

- 数据集行格式：`{"image": "<base64 mono8 原始字节，恰 width*height 字节>",
  "action": [...], "observation": [...]（可选 proprio 向量，卷积特征后拼接）}`。
  mono8 原始字节免图像解码依赖；全部行必须一致地带或不带向量。
- 编码器固定为三层 stride-2 k=4 卷积（8/16/32 通道）+ 激活 + 密集头，
  纯 NumPy im2col 实现 + 手写反传；有限差分测试证明梯度正确。
- 诚实边界：训练/验证与 ONNX 等价的纪律与 v2 完全相同；`rdk-offline-bc-v3`
  产物导出 **NHWC rank-4 图像输入**（`[N,H,W,1]`），对齐平台视觉门禁
  `validateVisionObservationAgainstModelInputs`。合成像素冒烟 ≠ 真机相机
  验收；board 端视觉 runtime 装配是独立链路（见 `engines/visual-ppo`）。
