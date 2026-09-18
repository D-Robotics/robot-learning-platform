# 开源同类项目对比与差距分析（2026-09）

本页把 2026-09-17/18 的一轮外部调研落到纸面：同类开源项目在生态、UI/UX 和功能上的现状，
我们差在哪、强在哪、接下来按什么顺序补。它是对
[`product-maturity-plan.md`](product-maturity-plan.md)「同类能力对标」一节的外部证据补充：
那份文档说的是能力类别，这份说的是具体项目和数字。

数据来源：GitHub API / 官方 docs / HF Hub 当日快照（由多路并行网络调研汇总）。
star 数是快照不是承诺，本文引用时尽量带上规模量级而非精确个位。未能核实项在文末列出。

## 一句话结论

差距要分三层看，性质完全不同：

1. **生态差距是数量级问题**——LeRobot 27.6k stars / 267 贡献者 / Discord 1.9 万人 / Hub 上
   4,168 个 LeRobot 格式数据集；我们是 2 周龄单贡献者仓库、0 star、无 release。这不是补功能能追的，
   需要下面 P0 的「生态入场券」。
2. **功能差距集中在「算法代际」和「数据格式」**——生态重心已从自训 PPO/BC 迁移到微调 VLA
   （pi0.5 / GR00T N1.7 / SmolVLA 450M），且数据格式收敛到 LeRobot dataset v3 事实标准。
   这两样我们都没有，但 SmolVLA 档位（单卡可训、消费级可部署）与 X5 算力形态是匹配的。
3. **UI/UX 是我们相对占优的一面**——所有纯训练平台（Playground / ManiSkill3 / Isaac Lab /
   Genesis）都没有浏览器工作流，LeRobot 的 LeLab 也只覆盖采集端。我们差的不是形态，
   是专业可视化工具（Rerun / MLflow / LeRobot visualizer）已经成熟的模式深度。

## 对标格局

| 项目 | Stars（快照） | 贡献者 | 浏览器 UI | 与我们的关系 |
| --- | --- | --- | --- | --- |
| **本平台** | 0（2 周龄） | 1 | ✅ 全流程闭环 | — |
| LeRobot | 27.6k | 267 | LeLab（采集→训练 GUI） | 最直接对标：训练库 + 数据格式 + 硬件生态 |
| Genesis | 30.0k | 110 | ❌ 仅桌面 ImGui | 物理广度热点，无训练工作流、无落地案例 |
| OpenPI（Physical Intelligence） | 13.9k | — | ❌ | VLA 微调栈；「服务器推理 + 板端轻客户端」事实标准 |
| Isaac Lab（NVIDIA） | 8.2k | 258 | ⚠️ WebRTC 视频流 + Rerun viewer | 工程深度天花板；绑 CUDA/Isaac Sim 生态 |
| Isaac GR00T（NVIDIA） | 8.1k | — | ❌ | VLA + Jetson TensorRT 部署参考 |
| ManiSkill3 | 3.3k | 69 | ❌ | 任务/机器人覆盖最全的操纵基准 |
| MuJoCo Playground | 2.2k | 28 | ❌ notebook+CLI | 与我们 MJX 引擎同上游；研究向 |
| robomimic | 1.6k | 9 | ❌ | IL 参考实现，非平台威胁 |
| SimplerEnv | 1.2k | 9 | ❌ | real2sim VLA 评测标准（MMRV/Pearson 方法论） |
| Rerun | 11.5k | — | ✅ viewer | 可视化专业度标尺（非竞品，是参照系） |
| Foxglove | —（开源核已闭源） | — | ✅ 商业 | 部署观测/回放 UX 标尺 |

定性：我们的产品形态是「训练工作台 + 部署控制面」。LeRobot 是库 + 数据格式 + 硬件生态；
Playground / ManiSkill / Isaac Lab 是仿真 + 训练库。**同形态直接可比的只有 LeLab 和 Foxglove
免费版**——这个赛道其实比 star 榜暗示的空旷。

## UI/UX：差距细节

### 我们已占优的（诚实列出）

全流程浏览器闭环（仿真→录制→训练→评测→部署）、SSE 实时事件、12 步聚光 onboarding、
205 处 aria 的无障碍投入、⌘K 命令面板、LLM agent-chat（10 个受控工具）。LeRobot 没有自研
实验 UI（依赖 wandb/trackio），ManiSkill/Playground 连 notebook 之外的东西都没有。

### 真正差的（对标 Rerun / Foxglove / MLflow / LeRobot visualizer）

| # | 差距 | 生态参照 | 具体模式 |
| --- | --- | --- | --- |
| 1 | 回放没有统一 scrub 时间轴 | Rerun、LeRobot `visualize_dataset`（657 likes） | 一条时间轴拖动，相机流 / 状态 / 动作 / 曲线多面板同步 |
| 2 | run 对比只有曲线叠加 | MLflow、Aim（10k+ run 对比） | parallel coordinates + 参数 diff 表 + 跨 run 指标搜索 |
| 3 | 数据视角是「数字中心」 | 生态数据 = MP4 + Parquet | 回放 = 视频与图表同步播放；我们 JSONL 逐帧解码相机 |
| 4 | 无数据体检 | LeRobot visualizer | episode 长度直方图、Action Insights（state-action 对齐/速度分布）、坏 episode 过滤导出、3D URDF viewer |
| 5 | 无逐行训练日志流 | LeLab 有实时日志 | stdout 逐行流式渲染（我们已解析曲线行，渲染可复用同一通道） |
| 6 | 纯中文界面 | — | 英文 README + i18n 是进国际社区的第一道门 |
| 7 | 无手机/触屏遥操 | LeRobot 支持手机遥操 | 移动端页面已有响应式，缺虚拟摇杆控制层 |
| 8 | 浏览器仿真无多线程 wasm | 官方 `@mujoco/mujoco` 多线程版 | SharedArrayBuffer + COOP/COEP 头提速物理（mjswan 式策略交互施力也在此列） |

## 功能：差距细节

1. **无 VLA / 基础模型入口（最大单项差距）**。生态三档：pi0.5（全参 >70GB）、GR00T N1.7
   （微调建议 ≥40GB）、**SmolVLA 450M（单卡可训、消费级 GPU 可部署，LIBERO 87.3% 超 π0
   3.3B 的 86.0%）**。SmolVLA 用 Hub 上 481 个社区数据集训出来——「社区数据 + 小模型」路线
   已被验证，且档位与 X5 + 服务器形态匹配。
2. **算法广度**：我们有 PPO/BC/ACT（ACT 已入库：`engines/act`，28 契约测试）。LeRobot 侧：
   ACT / Diffusion Policy / VQ-BeT / pi0 系 / GR00T 微调 / 世界模型（LaWAM 等）/ 奖励模型 /
   HIL-SERL / DAgger 采集 / LoRA / multi-GPU。我们下一个该补的是 **Diffusion Policy** 和
   **DAgger/HIL 后训练**。
3. **数据格式孤岛**：LeRobot v3（Parquet+MP4、Hub 原生流式）是事实标准——AgiBot World、
   GR00T 微调管线、转换器 any4lerobot（1.2k stars）都围着它转。我们私有 JSONL 无导入导出，
   等于拒收生态数据。**最小解法是双向 converter，不是迁格式**。
4. **仿真/机器人覆盖**：1–3 个机型 vs Playground 15+、ManiSkill ~40 机型 9 类任务、
   Isaac Lab 16+ 机型 30+ 环境。这不是要追平的差距（见下「我们不追的」）。
5. **GPU 训练规模**：mjlab-rsl-rl 是参考适配器（需自备 GPU 栈）；Isaac Lab multi-node、
   Playground MJX/Warp 为集群设计。GPU 大规模训练我们走 RoboGo 云端 + 适配器路线，不自建。
6. **对外评测口径**：无 LIBERO / SimplerEnv 式可对外引用的 benchmark 数字。SimplerEnv 的
   「仿真评测与真机性能相关性（MMRV/Pearson）」方法论本身，应吸收进我们 sim2real 证据链。

### 反向差距（我们独有，竞品没有）

- **边缘部署证据链**：LeRobot 的 Jetson 边缘部署 issue 关闭未解决、无 OTA、无部署审计；
  开源界没有任何一家把「上板前证据门禁（板型预检 + 延迟收据 + canary + 急停 + 审批链）」
  做成产品。这是我们的差异化主阵地，README 与 `product-maturity-plan.md` 的定位（证据链
  与安全交付控制面）与调研结论互相印证。
- openpi 的「GPU 服务器推理 + 板端轻客户端」是生态事实标准——恰好验证 X5 定位为轻客户端
  是对的（GR00T N1.7 在 Jetson Orin 上 3B 模型仅 6.6Hz，大 VLA 上板不现实）。
- LeRobot 的工程痛点是我们的反面教材：v0.6 连续 breaking change、旧 checkpoint 迁移崩溃、
  `from_pretrained` 失败静默返回未训练模型。我们的「契约 + fail-closed + 审计」文化应作为
  对外叙事的一部分。

## 生态：差距细节

| 维度 | LeRobot | 本平台 |
| --- | --- | --- |
| GitHub | 27.6k stars / 1,756 commits / 267 贡献者 | 0 star / 133 commits / 1 贡献者（2 周） |
| 发布 | v0.6.1（1–2 月一版，CHANGELOG 完整） | 无 release tag |
| 社区 | Discord 19,339 人（在线 ~1,834）、hackathon、Colab、adopters dashboard | 无公开社区渠道 |
| 学术 | ICLR 2026 论文（arXiv:2602.22818） | 无 |
| 硬件 | 10+ 原生机型（SO-101/LeKiwi/G1…）+ `lerobot_robot_*` 插件自动发现聚合三方（xArm/UR5e/Franka/Piper/Quest/ROS2 bridge） | 自有 3 条产品线（MicroDuck/OriginBot/RDK Duck） |
| 数据/模型 | lerobot org 189 数据集 66 模型；全 Hub 4,168 个 LeRobot 数据集 | 0 个公开数据集 |

我们的独有筹码：RDK-X5 / MicroDuck / OriginBot 的官方渠道与存量用户群——LeRobot 生态
覆盖不到这块硬件（它的原生硬件是 SO 系列臂 + LeKiwi）。生态策略应该是「入驻 LeRobot 生态 +
收编 RDK 硬件用户」，不是另起炉灶。

## 路线图（按优先级）

### P0 生态入场券（不做就永远在生态外）

| 项 | 内容 | 状态 |
| --- | --- | --- |
| ACT 引擎入库 | `engines/act`（本仓库旗舰模仿算法对齐 LeRobot） | ✅ 本轮：28 测试 + 引擎白名单 + 训练页接线 |
| LeRobot v3 格式双向 converter | 导入 Hub 数据集做 BC/ACT 训练源；导出录制轨迹为 LeRobot 数据集 | 📋 设计见下节 |
| 英文 README + 界面 i18n | README-en + UI 语言切换（先英文） | 📋 本轮：README 英文速览段落；全量 i18n 待做 |
| 首个 release tag | v0.1.0 + CHANGELOG + 发布清单走查 | 📋 本轮打 tag |

### P1 UI/UX 拉齐（成熟模式，可直接抄）

| 项 | 内容 | 状态 |
| --- | --- | --- |
| 统一 scrub 时间轴 | 相机/热力图/曲线随时间轴拖动同步 | 🔨 本轮做 |
| run 对比升级 | parallel coordinates + 参数 diff 表 | 🔨 本轮做 |
| episode 数据体检 | 长度分布直方图 + 离群标记 | 🔨 本轮做 |
| 训练日志流 | stdout 逐行流式视图 | 📋 |
| MP4 视频管线 | 录制→MP4、回放视频与图表同步 | 📋 需媒体管线引入 |
| 手机遥操 | 虚拟摇杆 + 触屏控制层 | 📋 |

### P2 战略项（单项都是大活）

| 项 | 内容 |
| --- | --- |
| SmolVLA 微调入口 | 450M 档位，与 X5 + 服务器形态匹配；需 GPU runner + LeRobot 数据格式先行 |
| LeRobot Hub 发布 | 平台模型/数据集一键发 HF Hub（org 账号 + token 服务端持有） |
| Diffusion Policy 引擎 | 补齐 LeRobot 旗舰算法第二件 |
| DAgger/HIL 后训练 | 真机纠错数据回流训练 |
| 仿真-真机相关性 | SimplerEnv MMRV/Pearson 方法论吸收进 sim2real 证据链 |
| 多线程 wasm 仿真 | COOP/COEP + SharedArrayBuffer 提速浏览器物理 |

### 我们不追的（明确说不）

- **GPU 集群训练编排**：Isaac Lab 的领地，我们走 RoboGo 云端 + adapter。
- **仿真器物理广度**：Genesis 30k stars 是物理引擎热度，不是工作台需求；我们用 MuJoCo 系
  （浏览器 wasm + MJX + dm_control 同源）够了。
- **通用 MLOps 平台化**（PostgreSQL 多租户、对象存储、跨团队权限）：等有真实多租户需求再上，
  见 `product-maturity-plan.md` 的既有结论。
- **机队运维 / 云 OTA**：Greengrass 的领地；我们做的是单板受控发布链，不做车队管理。

## 附：数据可信度与未核实项

- 已核实（多源一致）：LeRobot star/贡献者/发版节奏/算法清单/Hardware 清单/Hub 数据集规模
  （HF API 实测）、Isaac Lab 与 GR00T 版本线、openpi 架构与显存门槛、SmolVLA 论文数字、
  ManiSkill3 规模、MuJoCo Playground 规模、robomimic/SimplerEnv 状态、MLflow/Aim/Rerun
  能力清单、LeRobot visualizer 功能清单（README 直读）、Foxglove 定价与闭源历史。
- 未核实（写作时网络不可达或站点拦截）：playground.mujoco.org 站内是否有交互 web viewer
  （403）；Genesis 1.0 博文正文（403）；Foxglove「20+ panels」的确切清单；RViz Web 当前
  维护状态；「lucysim」项目（查无此 repo/org，已从分析中剔除）。
- 快照日期：2026-09-17/18。star 与社区数字会漂，引用请带日期。
