# act 引擎（示教轨迹 → 动作分块 Transformer → ONNX）

`engines/act` 把平台的模仿学习路径从「单步 MLP」升级到 **ACT（Action
Chunking Transformer，Zhao et al., RSS 2023）**——LeRobot 一类社区项目的
旗舰模仿算法。offline-bc 回答的是「一个观测 → 一个动作」；ACT 回答的是
「一个观测 → 未来 k 步动作的整块计划」，并用时序集成把重叠预测在执行时
平滑成控制流。

## 为什么 ACT，而不是更多的 MLP 层

对照 LeRobot 的能力面，本平台此前的缺口不在「有没有模仿学习」而在
「模仿学习停留在 1990 年代的单步回归」：

- **动作分块（chunking）**：每步输出未来 `--chunk` 步动作，策略承诺的是
  一段短计划而不是每个控制节拍都重新抖动地决策——这是真机平滑动作的
  结构性来源；
- **时序集成（temporal ensembling）**：重叠的块预测按指数权重
  `exp(-m·age)` 融合（`ensemble_predictions`，纯 NumPy 无 torch 依赖，
  板端 runtime 可逐字复制），测试断言其在执行噪声下必须优于朴素首动作
  读取；
- **CVAE 隐变量**：训练时从 (观测, 目标块) 编码后验 z 并向先验收紧
  （KL 权重默认 10，对齐论文量级；权重过小时后验会把整块动作走私进 z，
  确定性解码 z=0 时信息丢失——测试数据集设计专门暴露过这个问题）；
  多模态示教（两位示教者两种风格）不会被平均成谁都没做过的动作。

诚实的偏差声明（全部由平台契约决定，写进代码 docstring）：表格观测而非
相机图像（观测向量按 1D ViT 方式切成定宽 token）、ReLU 而非 GELU、无
dropout（确定性是平台保证）、解码 query 是可学习嵌入（与原论文一致）。

## 与其他引擎的关系

| 引擎 | 学习信号 | 输出结构 | 需要 |
| --- | --- | --- | --- |
| starter-ppo / mjx-adapter / visual-ppo | 奖励（试错 RL） | 单步动作 | 任务/奖励设计 + 仿真环境 |
| offline-bc | 示教动作（模仿学习） | 单步动作 | 一份转移 JSONL |
| **act** | **示教动作（模仿学习）** | **k 步动作块 + 集成** | **一份带 episode 边界的轨迹 JSONL** |

数据格式直接对接浏览器录制器：`{"type":"step","observation":[...],
"action":[...],"done":true}`（或裸行 + `done` 标记）。**没有 episode
结构的转移数据会被拒绝**（fail-closed 而非静默拼接——chunk 目标一旦跨
录制拼接，验证分数就是谎言）。

## 平台工程保证（与 offline-bc 同一标准）

- **episode 级 train/val 划分**：chunk 在时间上重叠，按行划分会把近似
  窗口泄漏到两侧、让验证分数自夸；按 episode 划分并用独立随机流，改
  batch size 不会改变验证集成员。标准化统计只从 train 侧估计。
- **确定性**：同数据 + 同种子 → 权重逐位相同；z 采样噪声用专用流，
  与 shuffle 流解耦。测试断言。
- **ONNX 导出带等价证明**：导出 `DeterministicActor`（观测归一化折入、
  动作反归一化折出、z 固定为先验均值），onnxruntime 在真实数据行上与
  torch 前向逐元素对比（float32，atol 1e-4），失配即删文件并失败——
  未经验证的导出永不落盘。注意力用原生算子（matmul + softmax）手写而
  非 `nn.MultiheadAttention`，ONNX 图是 torch 前向的逐节点镜像，等价
  检查量的是导出器正确性而不是代数重排。
- **模型 JSON 即模型**：`state` 块携带全部权重，`rebuild_model` 从 JSON
  重建前向完全一致的 torch 模块（测试断言 atol=0）——产物是可审计的，
  不是摘要。
- **fail-closed 数据规则**：无 episode 结构、非数值、NaN/Inf、维度不
  一致、非布尔 done、未知行类型一律 ValueError，失败不写任何产物。
- **provenance 契约**：`source` + `dependencies` +
  `dependencyLockSha256`（本引擎 requirements.txt 的 SHA-256），由
  `npm run verify:training-provenance` 断言，act 已注册进该门和
  `lock:engines` 锁列表。
- 指标在**原始动作单位**（机器人真正执行的空间）上报：整块 MSE、逐
  horizon MSE、集成 MSE 对比首动作 MSE——集成与首动作两个数都报，
  不挑好的那个。

## RDK 差异化：把执行侧的论文数学变成可验证交付物

对照 LeRobot：它的 ACT 活在 Python 训练循环里，执行侧集成是研究代码，
上板要自己重新实现一遍再祈祷没写错。本平台把同一份数学下沉为四个
可验证的交付物：

1. **`policy-ensembled.onnx` —— 时序集成在验证图里**。`EnsembledWindowActor`
   把最近 k 个观测映射为已按 `exp(-m·age)` 加权融合的单个动作，导出后
   经**两重证明**：onnxruntime 与 torch 前向逐元素等价，加上与纯 NumPy
   `ensemble_predictions` 参考在相同解码块上的漂移校验（阈值
   10×atol——即使导出器忠实，窗口数学漂移也会被第二重抓住）。板端
   runtime 喂观测环形缓冲区即得融合动作，无需在机器人上重新实现任何
   集成数学。
2. **板端 `IncrementalEnsembler`**：`push(chunk)` / `step()` 环形缓冲，
   纯 NumPy 无 torch，板端可逐字复制。全速率模式与 `ensemble_predictions`
   数值恒等（parity 测试）；摊销模式（每 k 步一次推理）**诚实地**退化为
   最新块开环执行——这是让 50 Hz 控制在边缘 CPU 上可行的模式，文档与
   测试都明说它放弃了什么。
3. **实测边缘可行性证据**（`--edge-evidence`）：用 onnxruntime 实测单次
   解码延迟，导出 chunk 摊销（`decodeMsAmortizedPerControlStep`）、
   可负担控制频率（k / t_infer）与 `decisionHz` 预算判定，连同
   `hostContext` 一起写进产物 `onnx.edgeFeasibility` 块——明确标注这是
   **训练主机**的测量、是上下文不是证明；上板硬门禁仍然是
   board-latency rehearsal 收据（见 [host-station.md](../host-station.md)）。
4. **[-1, 1] 钳制进图**：导出图自身饱和于归一化动作空间（与 starter-ppo
   的导出约定一致）——板端 runtime 用 MAX_LINEAR/MAX_ANGULAR 轨道缩放
   策略输出，即使权重漂移也无法命令超出运行时预算的速度；集成图是
   钳制动作的凸组合，同样不越轨。测试用极端观测断言饱和。

本机实测（Darwin/arm64，录制器格式数据，chunk 8）：解码 0.19 ms/推理、
摊销 0.024 ms/控制步、50 Hz 预算 met；验证集上时序集成把执行误差从
0.00080 降到 0.00024（-70%），两个数都在产物里。

## 使用

```bash
# 数据：录制器轨迹 JSONL（type:header/step 行，done 闭合 episode）
python3 engines/act/train_act.py recordings.jsonl \
  --out model.json --onnx policy.onnx \
  --ensembled-onnx policy-ensembled.onnx \
  --edge-evidence --decision-hz 50 \
  --chunk 8 --d-model 64 --heads 4 --enc-layers 2 --dec-layers 2 \
  --kl-weight 10 --epochs 200
```

接到平台 worker（训练页「训练引擎」选 `act`）时，目前仅运行文件协议的
**合成数据冒烟训练**，结果标记 `dataset.source=synthetic-smoke`、`synthetic=true`。
这条路径尚未读取用户上传的示教数据；真实轨迹训练请使用上面的 CLI。
注册方式如下（解释器须安装本引擎依赖）：

```bash
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"act":{"executable":"/usr/bin/python3","args":["/abs/path/to/engines/act/train_act.py"]}}'
```

# 板端执行侧的时序集成（纯 NumPy，可直接复制）
#   from train_act import ensemble_predictions, IncrementalEnsembler
#   actions = ensemble_predictions(chunks, m=0.1)   # 批式参考
#   ens = IncrementalEnsembler(chunk, act, m=0.1)   # 增量 runtime
#   ens.push(chunk); a = ens.step()

```

# 跑契约测试（28 个：逐 horizon 收敛、episode 划分诚实性、确定性、
# fail-closed、ONNX 等价与删除语义、窗口集成导出双重证明、板端集成器
# parity 与摊销模式、[-1,1] 钳制、边缘证据块、模型 JSON 往返、引擎模式
# provenance；无 torch 时 SKIP 退出 0）
npm run verify:act
```

产物格式 `rdk-act-bc-v1`（JSON）：`architecture`（dModel/heads/层数/
zDim/tokenWidth）、`chunk`、`normalization`（观测与动作各自的 mean/std）、
`state`（全部权重）、`metrics`（见上）、`onnx`（基础导出等价状态 +
`ensembled`（窗口集成导出：等价、参考漂移、ensembleM）+
`edgeFeasibility`（实测延迟与预算判定））、provenance 三块。依赖：
torch + numpy（训练）；`--onnx` / `--ensembled-onnx` 另需 onnx（等价
检查需 onnxruntime），缺库时如实 SKIP。所有本地引擎一致：`deployable`
恒为 false，上板仍走完整发布链。

`deployable` 语义与所有本地引擎一致：产物是源策略工件，上板仍需走
编译制品 + 板型预检 + rehearsal 收据的完整发布链。
