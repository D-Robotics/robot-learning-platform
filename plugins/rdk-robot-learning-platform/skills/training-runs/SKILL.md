---
name: training-runs
description: 在 RDK 学习平台选择任务、训练引擎与执行资源，提交训练并跟踪 Run、日志和重训建议；也支持仓库已有的模仿学习和强化学习 CLI。
---

# 训练与 Run

用户要求完整 OriginMan Workshop 时，使用 [体验流程](../experience-preparation/SKILL.md)：先实际运行参考仿真，再训练、同源评测、查看结果与回放。专用短训工具内部完成模型、manifest与资源校验，不需要下面的通用提交步骤。用户明确只要求训练时按其范围执行。

收到 stopWorkflow=true 后停止新提交；已有 Run 继续按原引用只读恢复，未取得提交回执则保持未知。不能把引用保存失败说成尚未提交，不能换 contextId、资源或参数重交。普通结果使用 studentReply，技术明细按需展开。

平台或硬件交付类验收才读取 [分层验收流程](../../references/workshop-acceptance.md)。OriginMan 仿真课程不要求板端纯计算或实体运动验收。

交付单次可追踪的训练请求和 Run 状态，完成时绑定真实产物。读 [训练/评测/部署契约](../../references/workflow-contracts.md)；参数查 [工具目录](../../references/tool-catalog.md)。

用户说“用我的轨迹训练并部署”时按 [用户工作流](../../references/user-journeys.md) 先核对真实数据与训练路径。登记 dataset/传入 datasetIds 只保留来源关联，不保证当前执行器读过这些字节；ACT/BC/DP 的 synthetic-smoke 不能替代用户数据。远程 Agent 没有输入文件时先准备明确的上传/挂载，不凭路径字符串猜数据已到 worker。

1. 确认用户任务、模型、数据、预算和目标设备。用 `rdk_models_list`、`rdk_datasets_list`、`rdk_golden_path` 找可用资源。
2. `rdk_compute_resources_list` 后对选中的 `computeResourceId` 调 `rdk_compute_resource_test`。训练后端和引擎是两项；支持范围取当前资源、worker 配置及任务包，不把已存在的 Python 训练器当作已注册到所有 worker。
3. `rdk_training_submit` 显式传实际 `modelId`、`taskId`、`projectId`、`datasetIds`、`computeResourceId`（适用时）、`backend`、`engine`、`profile` 及预算。默认 backend 是 local、profile 是 smoke；用户要求真训练时先确认 worker 不是 Mock。未知 backend 和本工具不支持的轨迹路径/续训/嵌套 training 字段会在任何请求前拒绝；不改成另一路径重试。读取返回的 `resolvedTraining` 与 `defaultsApplied`，说明所选模型与预算，避免缺参默认首模型被误认成用户选择。用稳定 `idempotencyKey`，提交一次保存返回 `runId`。
4. 用 `rdk_training_status(runId)` 查状态、`rdk_run_logs(runId, after)` 增量读日志。等待间隔随耗时调整，不为查进度再次 submit。结束后查 `rdk_artifacts_list`、`rdk_lineage_get`；再用 `rdk_retraining_advice` 辅助诊断。

## 实验接续（有扩展工具时）

提交成功后，为本次训练选择一个新的明确 `contextId`（ASCII字母数字、点、下划线或短横线），调用 `rdk_experiment_remember({contextId, runId})`。它只保存当前平台和正式账号下的任务引用，不提交训练。新训练必须使用新标识，不能覆盖旧训练。

用户说“继续这个实验”时，用已明确的标识调用 `rdk_experiment_resume({contextId})`；标识不明确时询问，不猜全局最新Run。它会实时核对权限和状态；404、失效登录、blocked都保留失败，不自动重交。书签保存在当前系统用户的私有目录，不保存账号原文或凭据；换电脑不会自动同步。

评测仍使用平台现有提交工具与原训练参数。提交后用同一标识调用 `rdk_experiment_remember({contextId, runId, evaluationRunId})`，核对父Run、模型及策略摘要后才建立关联。未知引擎的评测来源没有明确字段时，保留独立Run，不能猜测已关联。

恢复工具提供的工作台链接不保证自动选中Run；视频入口也不保证文件已生成。用户要求打开时复用宿主打开接口，实际核对登录、Run和播放；不能仅凭链接说已播放。不能把MCP请求取消等同于后台训练停止。此扩展不提供后台自动轮询、训练取消或真机部署。

训练运行完成不等于质量门通过或可上板。平台、worker 或引擎拒绝时报告原因和残留 Run；不换成 Mock 伪装成功。改变任务/参数才创建新的逻辑操作键。没有资源、模型或可用数据时先完成准备，不擅自启动计费资源。

提交响应中的 `dataUsage.consumptionVerified=false` 表示它没有证明用户数据被消费；`syntheticData.confirmed=null` 表示尚无来源证据，`builtinSmokePath` 只提示当前仓库内置包装的风险，不推断自定义 worker 的实际输入。`status=blocked|failed` 与 `summary`/`note` 原因优先于“请求已登记”，不要把登记成功说成训练已启动。

训练提交只接受 schema 声明的平铺字段及 `idempotencyKey`。额外的 `learningRate`、`seed` 等未公开参数会明确拒绝，不能报告调优生效；字符串/布尔/数值类型必须匹配，例如 `numEnvs` 使用 JSON 数字，不能传 `"16"`。显式无效模型/profile 不会回退默认任务。更细超参用当前引擎 CLI 的真实参数，在同数据、seed、split 和协议下对比；查看留出结果用于调参后，该留出集属于开发评估，最终质量需新独立数据。

仓库 CLI 完成真训练后，报告输入摘要、输出模型/ONNX/验证结果及它们与平台实体的实际关联。离线产物不会自动生成符合发布证据的 completed non-Mock local Run；缺少这条证据时明确停在离线学习结果阶段，不能登记 contract 演练或手改状态冒充可发布 Run。

MCP 无训练取消/续训专用工具。用户取消时停止继续提交和轮询；通过真实工作台/API 查询已提交任务能否取消，不把 MCP `notifications/cancelled` 当成 Run 已停止。续训和更细的 CLI 超参先读实际引擎接口。执行资源 CRUD、运行关联/中继等没有专用 MCP 工具的操作走 [版本化 API 工作流](../../references/api-workflows.md)。

引擎、任务包、自定义奖励、GPU 接入、LeRobot、足球和循环策略的可用仓库入口见 [仓库能力](../../references/cli-capabilities.md)。凭据与执行器路径从部署环境读取，不进入请求 manifest 或共享产物。

真实浏览器示教 BC：提交时指定 `engine=offline-bc`、`demonstrationRunId` 和真实 local worker。平台冻结 observation/action 字节与摘要，校验同账号、同模型和维度；完成后核对数据消费回执与 ONNX。录制必须配对同一次推理前输入和输出，避免当前动作泄漏到 last_action 槽。闭环评测需新 reset，覆盖站立、前进、转向及 zero/参考对照；拒载或跌倒保留失败，不绕过验证器。

模型列表若只返回 ID，不按第一个条目猜模型。用明确 taskId 的运行记录与同一 modelId 的血缘/契约交叉核对；需要校验 manifest 时使用真实登记原文，不能自造不完整字段。宿主未提供文件读取能力时，不能声称已读插件引用。

可选准备工具的能力以当前 tools/list 为准。核心没有任务预检时返回未验证；不要反复调用不存在的接口。queued 评测可能尚无执行摘要：按平台明确 sourceRunId 暂存引用，并在终态重新核对摘要，不把排队关联当作执行验证。

视频回放只用宿主打开链接能力，不对 MP4 调用“网页正文抓取”。抓取超时或没有正文不能推断 401、登录墙或播放器未加载；仅有明确 HTTP/页面证据才报告认证问题。宿主没有播放器观测能力时说明“入口已打开，工具未自动核验播放”，不要为补截图申请新的系统权限或循环重试。OriginMan 的 evaluate Run 不是独立 evaluation 实体，不能把 evaluations_list 为空当作没有评测。

恢复结果的`playback.state=recorded`只说明有历史视频回执，`endpointVerified=false、verifiedInPlayer=false`仍要求宿主实际播放确认。`missing`时不生成视频入口，不自动重交评测；`blocked`时先看原评测summary和日志。评测failed/blocked/cancelled而没有执行摘要，不应误称策略摘要冲突；父Run或已提供摘要确实不一致时仍拒绝关联。查询期间账号或目标平台变化，整个恢复停止，不保存引用。

视频回执存在也不证明当前媒体端点可达。recorded表示历史上记录了摘要和字节数；原Worker掉线时仍可能返回503/VIDEO_UNVERIFIED。此时保留原结果，恢复原Worker连接后重新打开同一视频，不重提评测。

## OriginMan 学员短训

首次流程读 [学员安装、登录与恢复](../../references/workshop-first-run.md)，完整课程契约见
[OriginMan manifest](../../references/originman-manifest.json)。首次短训核对当前账号的模型和资源，
不依赖历史成功 Run；资源通过准备后才按需要登记课程模型。多个资源按名称让学员选择，
不给学员技术 UUID 填写题。保留提交记录与原 Run，提交结果未知不重交。

回放优先打开 `experiment_resume.links.experiment`；旧平台没有此链接时才用 `links.workbench`，按 `selection` 核对训练与评测 Run 并展开播放器；不要把原始 WebM/MP4 当新网页导航。页面不保证自动选择本次Run，不能用全局最新结果代替。用户要求先看参考时，先在课程仿真页启动并观察基础PD，再训练；页面打不开先排查。截图与诊断日志写入独立验收目录，不写入学员项目，也不清理无关文件。

普通课堂结果优先使用工具 `studentReply`，详细数据在实验页查看；用户要求技术明细时再展开，不默认输出参数、摘要和英文套件表。
