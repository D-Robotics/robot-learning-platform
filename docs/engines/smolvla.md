# smolvla 引擎（LeRobot 数据集 → SmolVLA 450M VLA 微调入口——参考适配器）

`engines/smolvla` 是平台 P2 战略项「SmolVLA 微调入口」：把 [SmolVLA](
https://huggingface.co/lerobot/smolvla_base)（HuggingFace / LeRobot，约 450M
参数的视觉-语言-动作模型，单卡可微调，LIBERO 87.3%）接入平台的训练链路。
它与 `engines/mjlab-rsl-rl-adapter` 同属**参考适配器（reference adapter）**
定位：接入能力是真的，生产算力是部署方自备的——本仓库的开发机（Mac、无
GPU、无 accelerate/peft/pyarrow）不可能真微调一个 450M 模型，平台不假装它能。

## 这是什么 / 什么不是

**是**：

- 一条**真实写全**的微调代码路径：依赖门禁（缺哪个包、哪条安装命令）、
  `AutoModel`/`AutoProcessor` 加载、LeRobot parquet 逐 episode 加载（
  `observation.state`/`action` 列映射）、LoRA（peft `LoraConfig`，`--lora-r 0`
  切全参）、带诚实逐迭代进度行（`iter N/M loss=...`）的训练循环、权重产物 +
  result 契约；
- 一个**零依赖可跑**的 `--dry-run` 计划校验器：不联网、不加载权重、不需要
  GPU，完整验证训练计划（数据集结构、episode/frame 数、维度契约、超参合法
  性、输出目录可写），stdout 输出一行 JSON 计划摘要并退出 0；
- **fail-closed** 的环境门禁：环境不满足真实训练时，精确报出「缺哪个包 /
  缺 GPU runner」后退出 2，绝不静默降级。

**不是**：

- 本机可完成的训练引擎——真微调在**自备 GPU runner** 上跑（加载
  `lerobot/smolvla_base` 或本地权重目录）；
- 玩具 demo 或空壳——代码路径全量落地，本机测不到的部分（模型前向的调用
  形状）在 docstring 与代码内明确标注「对照公开 SmolVLA 接口编写、未在本仓
  库环境执行过」，失败消息指明调整点；
- 板端引擎——见下文 X5 定位。

## 依赖链（先行条件）

```
engines/lerobot-converter（import/export）────► LeRobot 数据集目录 ────► 本引擎
                                                      │
                                        GPU runner（torch/transformers/
                                        accelerate/peft/pyarrow + 基座权重）
```

训练输入 = **LeRobot 数据集目录**（`meta/info.json` + episodes 元数据 +
`data/**/*.parquet`；由 LeRobot converter 的导入/导出产物或 Hub 下载得到）。
`codebase_version` 仅接受 `v2.1` / `v3.0`（v1.0 布局先于「每 episode 一个
parquet」的结构，直接拒绝而非误读）。

## dry-run：在任何机器上验证训练计划

```bash
python3 engines/smolvla/train_smolvla.py /path/to/lerobot-dataset \
  --out ./plan --dry-run \
  [--lora-r 32 | 0] [--epochs 50 --lr 1e-4 --batch 16 --seed 0] \
  [--model-id lerobot/smolvla_base]
  [--expect-state-dim 34 --expect-action-dim 7]
```

校验内容（全部 fail-closed，除标注降级外）：

- 数据集目录存在、`meta/info.json` 存在且 `codebase_version ∈ {v2.1, v3.0}`；
- parquet 文件存在且 pyarrow 可读时读取深层元数据（精确 frame 数、从 parquet
  首行读 `observation.state`/`action` 维度、跨 episode 维度一致性、必需列存
  在、文件可读）；**pyarrow 缺失时只做结构校验并降级说明**（维度回退到
  `info.json` features 声明，frame 数回退到 episodes 元数据 length），目录
  只有 meta 没有 parquet 时同样降级通过并在摘要注明——降级永远写进 notes，
  不静默；
- `--expect-state-dim` / `--expect-action-dim`：期望维度作为**参数**而不是硬
  编码事实（SmolVLA 不同任务的 state/action 宽度不同）；默认 `None`=不校验，
  一旦给出且维度已知，失配即拒；维度未知时摘要如实标注
  `unverified-unknown-dim`；
- 超参与 LoRA 合法性（epochs/batch > 0、lr > 0 有限、lora-r ≥ 0）、输出目录
  可写（真实写入探测文件再删除，不信任 `os.access`）。

产物：**stdout 恰好一行 JSON 计划摘要**（episode 数、frame 数、维度、
finetune 策略、超参、plannedSteps、本机环境探针——装了什么、缺什么、
CUDA 有没有）+ `<out>/result.json`（`status:"completed"`、
`metrics.dryRun:true`、provenance 三块）。**不写任何 artifact**——
`artifact://` 权重契约只属于真实训练。

## 真实训练（GPU runner 上）

```bash
# 1. 安装（GPU 机器上；torch 建议 CUDA index 构建）
python3 -m pip install torch transformers accelerate peft pyarrow numpy

# 2. 基座权重：HF id（lerobot/smolvla_base）或本地路径
python3 engines/smolvla/train_smolvla.py /path/to/lerobot-dataset \
  --out ./run --lora-r 32 --epochs 50 --lr 1e-4 --batch 16 --seed 0 \
  [--model-id lerobot/smolvla_base] [--push-to-hub]
```

门禁顺序即诚实契约：依赖导入（缺 `torch/transformers/accelerate/peft` 任一
→ `[smolvla] FAIL — missing dependency: transformers. Install with:
python3 -m pip install transformers accelerate peft`，退出 2）→ CUDA 探测
（`torch.cuda.is_available()` 为 false → FAIL 并说明需要 GPU runner，退出
2）→ 输出目录 → 数据集 → 训练。

训练循环（accelerate `Accelerator` + 手写循环）：语言条件来自 episodes 元
数据的 `tasks` 字段，`(state, lang)` 经 SmolVLA processor 进模型，MSE 对齐
预测动作块与数据集未来窗口（块长取模型 config 的 `chunk_size`，未暴露时用
SmolVLA 公开的默认 50；episode 末端窗口用末动作补齐——与官方 recipe 的
mask 处理差异已在代码注明）。模型/processor 的调用形状对照公开 SmolVLA
接口编写（`trust_remote_code=True` 加载 lerobot 检查点，与 lerobot 官方
finetune 脚本同一信任决策），**未在本仓库环境执行过**——这是参考适配器唯
一留给 GPU runner 校准的接缝，失败消息会点名接缝位置。

产物（`--out`）：

- `weights/`：微调后权重目录（LoRA 时为 adapter + 基座引用，全参时为完整
  模型）+ processor 配置，附 `weights/SHA256SUMS` 完整性清单；
- `result.json`：`checkpoint.artifactRef` / `artifact.artifactRef` 指向
  `artifact://smolvla/<model>/<version>/...`（不透明引用，真实权重由你的
  制品库管理，平台只追踪元数据）、`metrics`（finalLoss、steps、episodes/
  frames/dims、trainingSeconds）、`dependencies`（实测导入版本）、
  `dependencyLockSha256`、`cuda=true`（实测）、`deployable=false`。

## 接入本地 worker（文件协议）

```bash
RDK_SIM2REAL_TRAIN_ENGINES_JSON='{"smolvla":{"executable":"/usr/bin/python3","args":["/abs/path/to/engines/smolvla/train_smolvla.py"]}}'
```

引擎模式（`RDK_SIM2REAL_REQUEST_FILE` + `RDK_SIM2REAL_RESULT_FILE`）照抄
`engines/mjlab-rsl-rl-adapter` 对依赖缺失的处理先例：

- **训练栈缺失**（torch/transformers/accelerate/peft 任一不可导入）→ stderr
  输出 `[smolvla] REFUSED — missing dependency: ...（安装命令）. This engine
  never fabricates a completed training run.`，**退出码 3，不写 result.json**
  ——worker 把任务标为 failed，任何下游都不可能把一个计划读成一次完成的
  训练；
- **栈完整**时写完整 result.json（满足 worker 的 `artifact://` 完成契约），
  但**诚实标注**：`mode:"engine-plan"`、`metrics.dryRun:true`、数据集
  `synthetic:true`（按请求契约合成的计划数据集；请求带 `dataset.path` 时
  则检查真实数据集并标 `request-dataset`）、`cuda` 为实际探测值；同时在
  任务目录落一份真实的 `training-plan.json` 产物并写 `SHA256SUMS` 清单，
  worker 的产物完整性核验有真文件可验。

CLI 模式与引擎模式的分工：worker 走计划/协议路径，真实微调走 CLI（GPU
runner 上人工或 CI 触发）。

## X5 定位：轻客户端，不是训练机

X5 的既定架构是**轻客户端**（openpi 验证过的「GPU 服务器推理 + 板端轻客户
端」事实标准）：策略推理在 GPU 服务器上做，板子只跑轻客户端。对照数据点
——GR00T 3B 在 Jetson 上仅 6.6Hz——450M 级 VLA 的**训练**更不可能上板。
SmolVLA 训练永远发生在 GPU runner，X5 只消费推理产物。

## deployable=false 与发布链约定

与所有本地引擎一致：本引擎产物是**源策略工件**（`deployable` 恒为
false）。上板需要走完整发布链：编译制品（X5/BPU 管线）→ 板型预检 →
board-latency rehearsal 收据（见 [host-station.md](../host-station.md)）。
`--push-to-hub` 只发布权重到 Hub，不改变 deployable 语义。

## 测试

```bash
python3 engines/smolvla/test_train_smolvla.py
```

29 个用例（本机零额外依赖全绿；本机无 pyarrow/accelerate/peft 时相应
SKIP）：dry-run 契约（单行 JSON 摘要 schema、result.json 无 artifact、
降级路径注明）、fail-closed 家族（目录缺失/info.json 缺失/v1.0 拒绝/
epochs≤0/lora-r<0/batch≤0/期望维度失配/输出不可写）、真实路径环境门禁
（缺栈 → exit 2 + `[smolvla] FAIL` + 精确安装指引；全栈+无 GPU → CUDA/
GPU runner 指引）、引擎模式（REFUSED exit 3 无 result.json；栈完整时
artifact:// 满足 worker 正则、dryRun 标注、SHA256SUMS 覆盖 training-plan.json）、
纯函数契约（超参规则、缺依赖消息逐字断言、探针语义）。断言 requirements.txt
的用例在锁文件存在时才生效（锁由主会话 `npm run lock:engines` 生成）。
