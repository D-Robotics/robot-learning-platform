# smolvla 引擎（LeRobot 数据集 → SmolVLA 450M VLA 微调入口——参考适配器）

`engines/smolvla` 是平台 P2 战略项「SmolVLA 微调入口」：把 [SmolVLA](
https://huggingface.co/lerobot/smolvla_base)（HuggingFace / LeRobot，约 450M
参数的视觉-语言-动作模型，单卡可微调，LIBERO 87.3%）接入平台的训练链路。
它与 `engines/mjlab-rsl-rl-adapter` 同属**参考适配器（reference adapter）**
定位：接入能力是真的，生产算力是部署方自备的——本仓库的开发机（Mac、无
GPU、无 accelerate/peft/pyarrow）不可能真微调一个 450M 模型，平台不假装它能。

## 这是什么 / 什么不是

**是**：

- 一条**真实写全并在 GPU 上执行过**的微调代码路径（2026-09-23，RTX 5090）：
  依赖门禁（缺哪个包、哪条安装命令）、CUDA 探测、LeRobot parquet 逐 episode
  加载（`observation.state`/`action` 列映射）、真实训练**委托 lerobot 0.4.4
  原生训练器**（`python -m lerobot.scripts.lerobot_train`，本引擎提供门禁、
  数据集接线、`--policy.path` 基座、训练器 stdout 逐行透传与 result 契约）、
  权重产物 + `SHA256SUMS` + result 契约；
- 一个**零依赖可跑**的 `--dry-run` 计划校验器：不联网、不加载权重、不需要
  GPU，完整验证训练计划（数据集结构、episode/frame 数、维度契约、超参合法
  性、输出目录可写），stdout 输出一行 JSON 计划摘要并退出 0；
- **fail-closed** 的环境门禁：环境不满足真实训练时，精确报出「缺哪个包 /
  缺 GPU runner」后退出 2，绝不静默降级。

**不是**：

- 本机可完成的训练引擎——真微调在**自备 GPU runner** 上跑（加载
  `lerobot/smolvla_base` 或本地权重目录）；
- 玩具 demo 或空壳——真实路径已于 2026-09-23 在 GPU 5090 上端到端执行（见
  下文实证节），早期版本遗留的「未执行接缝」标注已按实证结论修正；
- 板端引擎——见下文 X5 定位。

## 依赖链（先行条件）

```
engines/lerobot-converter（import/export）────► LeRobot 数据集目录 ────► 本引擎
                                                      │
                                        GPU runner（torch 2.10/lerobot 0.4.4/
                                        pyarrow + 基座权重 + num2words）
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
# 1. 安装（GPU 机器上；torch 2.10 是 lerobot 0.4.4/torchcodec 的钦配线，
#    5090/Blackwell 须 +cu128 构建；SmolVLM processor 另需 num2words）
python3 -m pip install torch==2.10.0 lerobot==0.4.4 num2words==0.5.14 pyarrow numpy

# 2. 基座权重：HF id（lerobot/smolvla_base）或本地快照路径
python3 engines/smolvla/train_smolvla.py /path/to/lerobot-dataset \
  --out ./run --epochs 1 --batch 8 --lora-r 0 --seed 0 \
  [--model-id lerobot/smolvla_base] \
  [--rename-map '{"observation.images.cam_high": "observation.images.camera1"}'] \
  [--push-to-hub]
```

门禁顺序即诚实契约：依赖导入（缺 `torch/lerobot` 任一 → `[smolvla] FAIL —
missing dependency: lerobot. Install with: python3 -m pip install lerobot`，
退出 2）→ CUDA 探测（`torch.cuda.is_available()` 为 false → FAIL 并说明需要
GPU runner，退出 2）→ LoRA 拒绝（委托路径只跑全参，`--lora-r > 0` 显式拒绝
而非静默降级）→ 输出目录 → 数据集 → 委托训练。

委托语义：本引擎以子进程运行 `python -m lerobot.scripts.lerobot_train`，
传入 `--dataset.repo_id/--dataset.root`（本地数据集目录）、`--policy.path`
（基座）、`--steps`（epochs×frames/batch）、`--batch_size/--seed/
--save_freq`，并显式关闭 `--policy.push_to_hub`（其默认值会要求 Hub 认证）。
训练器 stdout 逐行以 `[smolvla][trainer]` 前缀透传——训练器的进度就是诚实
进度；最后一个 `loss:` 数值进入 result 的 `finalLoss`。数据集相机名与策略
期望键不一致时经 `--rename_map`（顶层旗标）显式映射，绝不静默改名。

### 真实执行实证（2026-09-23，RTX 5090 32GB）

- 数据：Hub 真实数据集 `macrodata/aloha_static_battery_ep005_009`（lerobot
  当前 main 工具链写出，5 episodes / 3000 帧 / 4 相机 / 50Hz）；
- 运行：`--epochs 1 --batch 8 --lora-r 0` → 375 优化步，4m21s，
  **finalLoss 0.053**；产物 `weights/` 7 文件 906,726,076 字节 +
  `SHA256SUMS`；`result.json`：`status:"completed"`、`mock:false`、
  `cuda:true`、依赖实测（torch 2.10.0+cu128 / lerobot 0.4.4 / numpy /
  pyarrow）；
- 实证驱动的 seam 修正（此前版本基于错误假设，已被真实运行推翻并改写）：
  1. `lerobot/smolvla_base` 是 **lerobot policy 制品**（config.json +
     safetensors + lerobot 预/后处理器）——transformers 无原生 smolvla、
     仓库无 remote code，`AutoModel/AutoProcessor` 路线不成立 → 委托原生
     训练器；
  2. 训练器要求 `--policy.repo_id`（即使不推 Hub）且 `policy.push_to_hub`
     默认开启需显式关闭；
  3. 相机键不匹配（aloha 命名 vs 策略的 camera1/2/3）经顶层 `--rename_map`
     显式映射；
  4. `num2words` 是 SmolVLM processor 的硬依赖（策略装载时即需要）；
  5. 非零起 episode_index 的 Hub 分片数据会被「本地缓存校验」误判不全而
     回退 Hub——本地数据集应保证 episode_index 为 0..N-1 连续编号。

产物（`--out`）：

- `weights/`：微调后权重目录（委托路径为 trainer checkpoint 的
  `pretrained_model` 全量策略制品：config + safetensors + 预/后处理器 +
  train_config），附 `weights/SHA256SUMS` 完整性清单；
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

- **训练栈缺失**（torch/lerobot 任一不可导入）→ stderr
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
