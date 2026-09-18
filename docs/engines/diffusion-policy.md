# diffusion-policy 引擎（示教轨迹 → 动作分块 DDPM → 整链采样 ONNX）

`engines/diffusion-policy` 把平台的模仿学习路径补齐到 **Diffusion Policy
（Chi et al., RSS 2023 — "Diffusion Policy: Visuomotor Policy Learning via
Action Diffusion"）的 CNN 版式**——LeRobot 生态的旗舰生成式模仿算法。
ACT 用显式的 CVAE latent 表达多模态；Diffusion Policy 用**去噪扩散**表达：
动作块不是回归头的输出，而是从纯噪声经 T 步反向去噪采出来的**分布样本**。
两位示教者走不同路线时，回归模型把两个模态平均成谁都没做过的动作；
扩散模型让两个模态都留在分布里。

## 为什么 Diffusion Policy，而不是第二个 Transformer

对照 act（同为「一个观测 → 未来 k 步动作块」）：

| | act | diffusion-policy |
| --- | --- | --- |
| 建模范式 | CVAE + 确定性解码（z=0） | DDPM 生成采样（ε 预测） |
| 多模态表达能力 | latent 近似 | 分布级（扩散的本职） |
| 骨干 | Transformer（token 化表格观测） | 条件 1D UNet（时间维卷积） |
| 观测条件注入 | cross-attention | MLP 编码 + FiLM 调制注入每层 |
| 推理成本 | 单次前向 | T 次去噪前向 |
| 导出物 | 解码器图 | **整个反向采样循环固化成一张图** |

本引擎实现的是论文的 CNN 变体：时间维卷积（核 5）、编码器两级下采样 +
瓶颈 + 解码器两级上采样、GroupNorm + SiLU 残差块、通道 32/64/128（默认）；
观测由两层 MLP 编码成 `--d-model`（默认 64）维条件向量，扩散步 k 经正弦
表 + MLP 嵌入，两者相加后 FiLM 调制（per-channel scale/shift）注入每个
残差块。DDPM 训练目标 = 加噪 ε 的预测 MSE；EMA 权重（`--ema-decay`
默认 0.995）用于评估、导出与保存——与论文的评测约定一致。

`--schedule` 二选一（默认 cosine）：**cosine**（Nichol & Dhariwal 2021，
任意 T 都能充分扩散，小步数 CPU 预算下的正确选择，beta 按 [1e-5, 0.999]
截断）；**linear**（Ho et al. 2020，为 T~1000 调参，小 T 下欠扩散——
文档明说，供大 T 消融对照）。

## 与其他引擎的关系

| 引擎 | 学习信号 | 输出结构 | 需要 |
| --- | --- | --- | --- |
| starter-ppo / mjx-adapter / visual-ppo | 奖励（试错 RL） | 单步动作 | 任务/奖励设计 + 仿真环境 |
| offline-bc | 示教动作（模仿学习） | 单步动作 | 一份转移 JSONL |
| act | 示教动作（模仿学习） | k 步动作块 + 集成 | 一份带 episode 边界的轨迹 JSONL |
| **diffusion-policy** | **示教动作（模仿学习）** | **k 步动作块（扩散采样）** | **一份带 episode 边界的轨迹 JSONL** |

数据格式与 act 完全同构（加载器语义逐字段一致，`state` 亦是
`observation` 的别名）：`{"type":"step","observation":[...],
"action":[...],"done":true}`（或裸行 + `done` 标记）。**没有 episode
结构的转移数据会被拒绝**（fail-closed 而非静默拼接）。

## 平台工程保证（与 act 同一标准）

- **episode 级 train/val 划分**：chunk 在时间上重叠，按行划分会泄漏；
  按 episode 划分用独立随机流，标准化统计只从 train 侧估计。
- **确定性**：同数据 + 同种子 → EMA 权重逐位相同；shuffle / 扩散步 /
  训练噪声 / 验证探针 / 评分采样 / 导出噪声各自独立随机流（seed 偏移
  2..7），互不蚕食。测试断言。
- **模型 JSON 即模型**：`state` 块携带全部 EMA 权重（含正弦步嵌入表
  buffer），`rebuild_model` 从 JSON 重建前向完全一致的 torch 模块（测试
  断言 atol=0）。
- **fail-closed 数据规则**：无 episode 结构、非数值、NaN/Inf、维度不
  一致、非布尔 done、未知行类型一律 ValueError；非法超参（chunk≤0、
  T<2、非法 schedule、d_model 奇数、ema-decay 不在 (0,1)）训练前拒绝；
  失败不写任何产物。
- **provenance 契约**：`source`（known/commit/dirty）+ `dependencies`
  （实测导入版本）+ `dependencyLockSha256`（requirements.txt 的
  SHA-256），与 act 同一 pin 集（numpy 2.0.2 / torch 2.8.0 / onnx
  1.19.1）。
- **诚实进度行**：`iter N/M denoiseLoss=... valLoss=...`。这是模仿
  引擎，没有 reward/success 概念——不伪造 meanReward/successRate，
  worker 的 RL 进度正则解析不了这些行也没关系（进日志尾）。valLoss 用
  固定 (k, ε) 探针：曲线移动只因模型在学，不是因为探针被重采样。

## 差异化交付物：整链采样 ONNX

act 的差异点是「时序集成进图」；本引擎的差异点是**反向扩散链本身进图**：
`DiffusionActor` 的 forward 里写着完整的 T 步去噪循环（循环体调用同一个
UNet），导出后这张图的唯一输入是原始观测向量、唯一输出是钳制后的动作块
——观测归一化折入、动作反归一化折出、[-1, 1] 钳制折入（与 act/
starter-ppo 同一约定：板端 runtime 用 MAX_LINEAR/MAX_ANGULAR 轨道缩放
策略输出，图自身饱和则权重漂移也越不出预算）。

反向过程的噪声是一份**冻结的实测抽样**（专用导出种子流生成、注册成
buffer、一行一步）——确定性导出的标准做法（对照 act 的 z=0 先验均值
解码）：导出策略必须「一个观测 → 一个动作块」。同一种子下，这份冻结
实现在单行批次上**就是**随机采样器自己的实现（parity 测试断言）。

导出后的证明是逐元素 allclose（rtol 1e-4 / atol 1e-5），失配即删文件并
失败——未经验证的导出永不落盘。一个诚实的工程细节：onnxruntime 没有
double Conv 内核，所以图是 float32 的，等价参考是**同一个 float32 torch
actor**（算术逐算子一致）——用 float64 参考去比会把链上 ~3e-5 的 f32
舍入积累误读成导出器漂移。反向更新里的 x0 预测每步钳制到 [-1, 1]
（diffusers 的 `clip_denoised=True` 约定）——这不是装饰：cosine 链尾
sqrt(alpha_bar) 缩到 ~6e-3，(x - s·ε)/sqrt(ab) 会把去噪器残余 ε 误差
放大两个数量级，实测不钳制的原始单位 chunk MSE 高达 30，钳制后 0.02。
torch 采样器与导出图做同样的钳制——这是「图即前向」的另一半。

边缘可行性是双份证据：`edgeEstimate`（解析侧：精确参数量 + 前向钩子
仪表化的单步去噪 FLOPs，×T 得单次决策 FLOPs）与 `--edge-evidence`
（实测侧：onnxruntime 跑整链采样图测延迟、chunk 摊销、可负担控制频率、
decisionHz 预算判定，附 hostContext 标注「这是训练主机的测量，上板硬
门禁仍是 board-latency rehearsal 收据」）。

## 使用

```bash
# 数据：录制器轨迹 JSONL（type:header/step 行，done 闭合 episode）
python3 engines/diffusion-policy/train_dp.py recordings.jsonl \
  --out model.json --onnx policy.onnx --edge-evidence --decision-hz 50 \
  --chunk 8 --diffusion-steps 16 --schedule cosine \
  --channels 32 --d-model 64 --ema-decay 0.995 --epochs 200
```

接到平台 worker（训练页「训练引擎」选 `diffusion-policy`）时，目前仅
运行文件协议的**合成数据冒烟训练**（T=16、channels 16/d_model 32 的小
参数档），结果标记 `dataset.source=synthetic-smoke`、`synthetic=true`。
这条路径尚未读取用户上传的示教数据；真实轨迹训练请使用上面的 CLI。
注册方式如下（解释器须安装本引擎依赖）：

```bash
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"act":{"executable":"/usr/bin/python3","args":["/abs/path/to/engines/act/train_act.py"]},"diffusion-policy":{"executable":"/usr/bin/python3","args":["/abs/path/to/engines/diffusion-policy/train_dp.py"]}}'
```

引擎模式契约（对齐 worker 的 bundle 核验）：job 目录写出 `model.json`、
`policy.onnx`、`SHA256SUMS`（worker 逐文件哈希核验，失配即任务失败），
`result.json` 带 `artifactRef: "artifact://policy.onnx"`、artifact 块
（format/path/sha256/sizeBytes）、metrics、provenance 三块、
`cuda: false`（CPU 训练器如实上报）、`deployable: false`。引擎模式要求
onnx 工具链在场：本引擎的交付物就是被验证过的采样图，产不出验证图就
fail-closed 退出（exit 2、不写 result.json），绝不发布未验证产物。

# 跑契约测试（30 个：逐 horizon 采样收敛、去噪损失下降、schedule 数学、
# episode 划分诚实性、确定性、fail-closed 全家族、ONNX 整链等价与删除
# 语义、[-1,1] 钳制、冻结噪声 parity、链进图结构断言、边缘证据块、
# 模型 JSON 往返、引擎模式 provenance 与 SHA256SUMS 核验；无 torch 时
# SKIP 退出 0）
python3 engines/diffusion-policy/test_train_dp.py
```

产物格式 `rdk-dp-bc-v1`（JSON）：`architecture`（channels/condDim/
kernel/diffusionSteps/schedule/paddedHorizon）、`chunk`、
`normalization`（观测与动作各自的 mean/std）、`ema`（decay）、`state`
（全部 EMA 权重）、`metrics`（整块 MSE、逐 horizon MSE、固定探针
denoiseLoss、初始对照、边缘估算）、`onnx`（等价状态 + maxAbsDiff +
`edgeFeasibility`）、provenance 三块。

## 已知限制

- **CPU 档位只适合小数据冒烟**：默认参数（75 万参数、T=16）在笔记本
  CPU 上 ~26 s/60 epochs（12 episodes × 40 steps）；千级 episodes 的
  真实训练请用 GPU 或减 T。冒烟档（channels 16/d_model 32、8 episodes
  × 48 steps）约 12 s 全链路。
- **T 步推理成本是扩散税**：一次决策 = T 次去噪前向。T=16 时单次决策
  ~15 ms（本机 onnxruntime），chunk 8 摊销后 ~2 ms/控制步、可负担
  ~500 Hz——但 50 Hz 预算下每步只花得起预算的一小部分，T 越大越紧。
  edgeFeasibility 块给的是本机实测，上板前必须以板端 rehearsal 收据
  为准。
- **linear schedule 只在大 T 有意义**：T=16 下它欠扩散（terminal
  alpha_bar > 0.8，从纯噪声采样对网络是分布外输入），默认永远用
  cosine。
- **deployable 恒 false**：与所有本地引擎一致的发布链约定——产物是源
  策略工件，上板仍需编译制品 + 板型预检 + rehearsal 收据的完整发布链。
