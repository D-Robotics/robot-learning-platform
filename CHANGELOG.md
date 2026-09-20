# Changelog

本仓库的显著变更按版本倒序记录。每个版本的条目都对应已通过全量门禁
（`npm run verify`）的提交；门禁含 API 契约、UI IA、escape 审计、训练溯源与
本地 E2E 冒烟。

## 未发布（2026-09-20）

### 功能缺口收敛

- **GPU 线 CPU 级证据归档**（`docs/engine-evidence-2026-09-20.md`）：mjx
  （真 MuJoCo MJX 接触动力学 + 纯 JAX PPO）、dm-control（同源物理 + JAX PPO）、
  mjlab（真 rsl-rl OnPolicyRunner 迭代，kinematic 后端如实标注）等引擎门禁在
  开发机真跑 PASS；SKIP 项逐条注明原因。
- **offline-bc 图像观测分支**（`rdk-offline-bc-v3`）：`--image-input WIDTHxHEIGHT`
  吃 mono8 像素（base64），固定三层 stride-2 CNN 编码器（纯 NumPy im2col +
  手写反传，有限差分梯度校验）+ 可选 proprio 向量拼接；导出 NHWC rank-4 ONNX
  对齐平台视觉门禁；`verify:offline-bc` 增至 25 测试。ACT 图像观测仍是后续项。
- **D6A 机械臂平台接入（软件侧）**：新机型 profile（`arm` actuator kind +
  工作空间盒/速度/夹爪安全界）+ 校验器 `arm` 分支；板端 agent 新增只读位姿
  预检、受限笛卡尔移动、夹爪与恒可用停止（双开关、双钳制、频控；arm_sdk
  阻塞语义如实回报）；平台代理路由 + station switches `arm` 键 + 4 条 API
  契约 + agent 工具 `rdk_board_arm_*`（`rdk_board_stop` 延伸覆盖机械臂）。
  真机验收清单见 `docs/arm-drive.md`，完成前不宣称闭环可用。
- **文档真话修正**：`real-loop-validation-2026-09-14.md` 汇总表与 `roadmap.md`
  P1-1/P1-3 的陈旧"待复跑"状态改为已归档的 9-14 晚真机 PASS 证据（0.096m
  弧线、51 次真实推理、spool→上传→run 详情全链验证）；剩余硬件项收敛为
  任务级到达点验收（runbook 已备）。
- **Quick start 真实化**：README 主路径改为 `demo:starter`（真 PPO + ONNX +
  评测，~2 分钟 CPU），Mock worker 流程降为显式回退并保持诚实标注；状态徽章
  由"Mock 闭环"改为"CPU 真训练闭环"。

## v0.1.0 — 首个公开评审版

本版本交付平台的核心闭环：契约模型 → 本地训练引擎族 → 板端部署链 →
遥测评测，以及贯穿全部产物的诚实标注与可审计溯源。

### 模仿学习引擎族（本轮补齐）

- **ACT 动作分块模仿**（`engines/act`）：Transformer 编解码 + CVAE 隐变量 +
  k 步动作分块 + 时序集成；episode 级 train/val 划分，ONNX 导出与 torch
  前向数值等价验证后才落盘。
- **Diffusion Policy 动作分块模仿**（`engines/diffusion-policy`，Chi et al.
  2023 CNN 版式）：条件 1D UNet 去噪器 + DDPM（cosine/线性调度）+ EMA 权重；
  多模态示教不被平均成谁都没做过的动作；**整个反向去噪循环固化为一张
  ONNX**，逐元素等价验证（实测 maxAbsDiff ≈ 2.4e-7）。
- **SmolVLA 参考适配**（`engines/smolvla`）：LeRobot 社区 VLA 的参考入口。
  CPU 栈产出诚实标注的训练计划（`metrics.dryRun=true`）；完整微调需
  HuggingFace + CUDA 栈的 worker；本机缺栈时**明确拒绝**（exit 3，
  REFUSED），绝不伪造完成训练。
- **LeRobot v3 双向转换器**（`engines/lerobot-converter`）：平台轨迹 ↔
  HF LeRobot v3.0 数据集布局（meta/parquet/视频）。导入支持 v2.1 与
  current-main 两种分片布局；mono8 视频逐字节无损往返（单色 H.264
  `-qp 0`）；v1.0 数据集拒绝并给出 `convert_dataset_v1_to_v2` 迁移指引。
  **这是生态入场券**：社区数据集可直接进平台训练，平台数据可回社区。

### 训练日志流（v0.1.0 做圆）

- 本地 worker 采集 stdout/stderr 行环（600 行 / 64 KiB / 单行 2000 字符），
  **采集时即脱敏**（Bearer/token 清零，中途 kill 不泄漏）；
- `GET /runs/:id/logs?after=N` 游标增量拉取，状态负载只带行数计数，
  行走独立端点；截断时如实标注 `truncated`；
- 前端训练进度卡内嵌等宽日志面板，按游标增量渲染（最多渲染 300 行，
  自动滚底）。

### MP4 回放视频管线

- `POST /runs/:id/replay-video`：服务端 ffmpeg 把已验收的相机帧
  （rgb8/bgr8/mono8 RAW）渲染为 MP4；**只接受单来源且全部 attested 的
  板端运行**（混合来源/导入运行 409 拒绝并给原因）；
- 视频是「已验收证据的渲染」而非新证据：digest 记入 run metrics，
  每次服务时重新校验（被篡改即 404，绝不服务漂移字节）；
- bgr8 在 Node 内通道翻转；奇数尺寸 pad 到偶数（yuv420p 约束）；
  前端评测页可渲染并与时间轴同步对帧。

### 训练引擎共享接线

- `shared/sim2real.ts` 引擎白名单新增 `diffusion-policy`、`smolvla`
  （converter 是 CLI 工具，刻意不入白名单）；
- `npm run verify` 链插入 `verify:diffusion-policy`、`verify:smolvla`、
  `verify:lerobot-converter`；`train:diffusion-policy`、`train:smolvla`、
  `convert:lerobot` 入口；
- `scripts/lock-engines.mjs` 覆盖 9 个引擎目录（含 converter），并修复
  write/check 不对称 bug：直接编译到既有锁文件会冻结传递 pin
  （protobuf 7.36.1→7.36.2 上游漂移被锁死），改为先 scratch 编译再原子
  rename，`--check` 与重新生成语义一致；
- 训练页引擎选择器、能力徽章说明、worker 未注册置灰逻辑全部覆盖新引擎；
  `.env.example` 给出多引擎注册 JSON 示例。

### 早于本 CHANGELOG 的既有能力（摘录）

- starter-ppo / MJX / visual-ppo / dm-control / mjlab-rsl-rl / microduck-rl
  训练引擎与对应 verify 门禁；
- offline-bc 真 MLP 行为克隆（替换 v1 占位实现）；
- 板端相机帧对齐采样 → 遥测稀疏携带 → 回放逐帧联动；
- 板控延迟实证（receipt）、策略上板预演证据门（opt-in）；
- 事件 SSE、审计日志、RBAC、部署配置与生产配置门禁。

### 已知边界（如实声明）

- 所有本地引擎 `deployable` 恒为 `false`；上板必须经 compile + preflight
  + rehearsal 发布链；
- ACT/diffusion-policy 的 worker 冒烟用合成示教数据（CLI 才吃真实轨迹），
  结果里 `synthetic:true` 明确标注；
- SmolVLA 在 CPU-only 机器上只产出计划（dry-run），完整训练需要 CUDA
  worker 注册；
- LeRobot 转换器 v1.0 数据集只拒绝不迁移（官方迁移脚本另行运行）。
