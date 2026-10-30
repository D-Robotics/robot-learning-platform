# 训练 → 评测 → 制品 → 部署契约

## 工作流与真源

`rdk_golden_path` 返回任务、数据、训练、评测、部署、反馈的唯一主线读模型；以 `nextAction`、阶段状态、`refs` 决定下一步。模型/数据集登记是元数据操作，不意味着内容可取或硬件已接入。平台返回的未知任务、未知引擎和不匹配契约必须保留拒绝。

Task-pack 来源为目标仓库 `tasks/*.json`、`adapters/*.json`、`scripts/resolve-task-pack.mjs`。任务、域随机化、奖励、终止、观测和质量门由声明合并；不根据文档旧数字猜当前任务能否提交。显式指定 engine 优先于任务推荐，但当前 API allowlist 与当前 worker 注册两关均须满足。

## 引擎可用性

| 能力 | 入口与限制 |
| --- | --- |
| starter-ppo / SAC | CPU 可真训练；profile smoke 是训练预算档，不自动代表 Mock；以 worker/result 来源判断。 |
| mjx-ppo / visual-ppo / dm-control-ppo / mjlab-rsl-rl / microduck-rl / microduck-football / isaac-lab | 需部署方注册真实执行器/依赖/模型资产。Python adapter 存在不代表该部署可跑。 |
| offline-bc | 支持真实浏览器示教 Run 的 `demonstrationRunId`。平台冻结 observation/action 快照，worker 消费摘要必须与输入哈希相符；没有示教的内置包装仅为 synthetic-smoke。低训练损失不等于闭环质量通过。 |
| ACT / diffusion-policy | 当前内置包装路径为 synthetic-smoke；用户真实采集训练走仓库 CLI 并验证产物。 |
| SmolVLA | 真训练需 LeRobot、GPU、基座权重和真实数据。`--dry-run` 会写 `<out>/result.json`，只是计划检查，无模型 artifact，不是只读或真微调。 |
| microduck-recurrent | CLI 训练/导出/评测能力；虽然 UI 存在选项，当前 `training_submit` allowlist 未包含该 engine，不宣称能由 MCP 提交。 |
| LeRobot converter | 数据转换 CLI，不是 worker 训练引擎。 |

实际引擎契约取 `shared/sim2real.ts`、`services/sim2real-web/local-training-worker.mjs` 及 `engines/*`。每个新部署先读资源健康中 engines，并以真正的小预算运行证明，不能用历史证据替代。

## 训练结果与评测

提交 `rdk_training_submit` 后持有 `runId`，查 `rdk_training_status` / 增量 `rdk_run_logs`。Run completed 仍需有效 artifact 和评测；进程退出 0、dry-run completed、Mock 或“没有 artifact:// 的结果”均不是发布证据。

`rdk_evaluation_summarize` 调用平台 evaluate；已有结果读取使用 `rdk_evaluations_list`、`rdk_runs_replay`。通过 telemetry/board sessions 核对 origin、样本、新鲜度、run/model/device/contract 绑定与 attestation。导入内容中的 `source:"board-agent"` 不自证真实。

任务质量门可能按 nominal envelope 的置信区间裁判，hard envelope 单独提供鲁棒性；episode 数、基线 ablation、物理引擎、测量阶段不可省略。`harness unqualified` 不应归因为策略优劣。发布裁判在平台根据原始指标重算，不接受手填 passed 或重算后不自洽的报告。

## 制品与延迟

登记制品后按生命周期 draft → validated → published；revoked 保留历史。不通过外部对象 URI 的存在推断摘要已经验证。ONNX 输入维度/布局/命名、图像和状态输入必须与契约绑定；当前板端的循环状态支持以真实 runtime 为准，不静默填零当作携带状态。

board 延迟证据要求 `board-onnx` 阶段、当前 artifact SHA-256、一致控制频率与预算、新鲜度和足够样本，平台重新裁决。host-torch/host-onnx/sim-step 不能替代 board-onnx；board rehearsal 是进程内推理耗时下界，未覆盖相机/ROS/其他负载的竞争。

## 部署

`rdk_deployment_preflight` 会建 preflight 台账计划但只读板端；Mock 不能作为真机证据。`rdk_deployment_version_switch` 建新模型版本的预检计划，不即时切正在运行策略。取消只对状态允许的计划有效。

Canary/Live 工作流经真实版本化 API 创建（携带 Run、制品、评测、设备证据与稳定 Idempotency-Key）→ owner/admin 记录审批 → 计划 ready → 受控 BoardAgent 按执行、现场确认、时间盒和回滚契约消费。没有可用真实执行适配器时明确尚未完成；审批 ready 不等于运动。具体入口见 [API 工作流](api-workflows.md)。

板端 staging → load → start 必须逐项检查，任何一项都不隐含后一项授权。平台和板端开关由当前部署执行，插件不放宽。用户授权继续存在时不重复确认普通只读/登记操作；物理动作失败后遵守现有 MCP 的重新确认纪律。

OriginMan 受扰恢复使用 `originmanWorkshop.device` 选择策略训练设备，默认 `cuda`，显式 `cpu` 保留。必须选择支持 OriginMan 的执行资源，GPU 不可用报错而不静默降级。MuJoCo 采样仍使用 CPU。通过 `rdk_training_status` 核对 `metrics.originmanWorkshop.trainingDevice.parameterDevices` 和 `gradientUpdates`；仅检测到显卡不足以证明训练发生在 GPU。
